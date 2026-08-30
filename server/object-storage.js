import { createHash, createHmac, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";

const MIME_EXTENSIONS = new Map([
  ["image/jpeg", new Set([".jpg", ".jpeg"])],
  ["image/png", new Set([".png"])],
  ["image/gif", new Set([".gif"])],
  ["image/webp", new Set([".webp"])],
  ["application/pdf", new Set([".pdf"])],
]);
const MAX_BYTES = 25 * 1024 * 1024;

const hex = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value, encoding) => createHmac("sha256", key).update(value).digest(encoding);
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

function safeFilename(value) {
  const name = basename(String(value ?? "arquivo")).normalize("NFKC").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 120);
  return name || "arquivo";
}

function validMagic(mime, bytes) {
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (mime === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  return false;
}

export class ObjectStorage {
  constructor(env = process.env) {
    this.endpoint = env.OBJECT_STORAGE_ENDPOINT?.replace(/\/+$/, "") ?? null;
    this.bucket = env.OBJECT_STORAGE_BUCKET?.trim() ?? null;
    this.accessKey = env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() ?? null;
    this.secretKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() ?? null;
    this.region = env.OBJECT_STORAGE_REGION?.trim() || "auto";
    this.publicBase = env.OBJECT_STORAGE_PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? null;
  }

  get ready() {
    return Boolean(this.endpoint && this.bucket && this.accessKey && this.secretKey && this.publicBase && this.endpoint.startsWith("https://") && this.publicBase.startsWith("https://"));
  }

  validate(filename, mime, size) {
    const safe = safeFilename(filename);
    const extensions = MIME_EXTENSIONS.get(mime);
    if (!extensions || !extensions.has(extname(safe).toLowerCase())) return { ok: false, error: "attachment-type" };
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) return { ok: false, error: "attachment-size" };
    return { ok: true, filename: safe, mime, size };
  }

  createKey(ownerId, filename) {
    const extension = extname(filename).toLowerCase();
    return `attachments/${ownerId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${extension}`;
  }

  presign(method, key, { expires = 300 } = {}) {
    if (!this.ready) return null;
    const now = new Date();
    const shortDate = now.toISOString().slice(0, 10).replaceAll("-", "");
    const amzDate = `${shortDate}T${now.toISOString().slice(11, 19).replaceAll(":", "")}Z`;
    const scope = `${shortDate}/${this.region}/s3/aws4_request`;
    const url = new URL(this.endpoint);
    const canonicalUri = `/${encode(this.bucket)}/${key.split("/").map(encode).join("/")}`;
    const query = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.accessKey}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expires),
      "X-Amz-SignedHeaders": "host",
    });
    query.sort();
    const canonicalRequest = [method, canonicalUri, query.toString(), `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonicalRequest)].join("\n");
    const dateKey = hmac(`AWS4${this.secretKey}`, shortDate);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    query.set("X-Amz-Signature", hmac(signingKey, stringToSign, "hex"));
    return `${url.origin}${canonicalUri}?${query.toString()}`;
  }

  publicUrl(key) {
    return `${this.publicBase}/${key.split("/").map(encode).join("/")}`;
  }

  async verify(key, mime, size) {
    const url = this.presign("GET", key, { expires: 60 });
    if (!url) return false;
    const response = await fetch(url, { headers: { Range: "bytes=0-31" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok && response.status !== 206) return false;
    const total = Number(response.headers.get("content-range")?.split("/").pop() ?? response.headers.get("content-length"));
    if (Number.isFinite(total) && total !== size) return false;
    return validMagic(mime, Buffer.from(await response.arrayBuffer()));
  }
}
