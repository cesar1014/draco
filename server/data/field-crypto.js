import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function decodeKey(value, name) {
  const text = value?.trim();
  if (!text) return null;
  const key = /^[a-f0-9]{64}$/iu.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, "base64url");
  if (key.length !== 32) throw new Error(`${name} precisa conter exatamente 32 bytes`);
  return key;
}

const keyId = (key) => createHash("sha256").update(key).digest("base64url").slice(0, 12);

export class FieldCipher {
  constructor(current = null, previous = []) {
    this.current = current;
    this.currentId = current ? keyId(current) : null;
    this.keys = new Map(previous.filter(Boolean).map((key) => [keyId(key), key]));
    if (current) this.keys.set(keyId(current), current);
  }

  get enabled() {
    return Boolean(this.current);
  }

  isEncrypted(value) {
    return typeof value === "string" && value.startsWith(PREFIX);
  }

  isCurrent(value) {
    return this.isEncrypted(value) && value.split(":")[2] === this.currentId;
  }

  encrypt(value, context) {
    if (!this.current || value === "" || value === null || value === undefined) return value;
    const plaintext = this.isEncrypted(value) ? this.decrypt(value, context) : String(value);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.current, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [
      "enc", "v1", keyId(this.current), iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url"),
    ].join(":");
  }

  decrypt(value, context) {
    if (!this.isEncrypted(value)) return value;
    const parts = value.split(":");
    if (parts.length !== 6 || parts[0] !== "enc" || parts[1] !== "v1") {
      throw new Error("envelope de criptografia inválido");
    }
    const key = this.keys.get(parts[2]);
    if (!key) throw new Error(`chave de dados ${parts[2]} não está disponível`);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[3], "base64url"));
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(parts[4], "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(parts[5], "base64url")), decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("conteúdo criptografado não pôde ser autenticado");
    }
  }
}

export function fieldCipherFromEnv(env = process.env) {
  const current = decodeKey(env.DATA_ENCRYPTION_KEY, "DATA_ENCRYPTION_KEY");
  if (env.NODE_ENV === "production" && !current) {
    throw new Error("DATA_ENCRYPTION_KEY é obrigatória em produção");
  }
  const previous = (env.DATA_ENCRYPTION_PREVIOUS_KEYS ?? "")
    .split(",")
    .map((value, index) => decodeKey(value, `DATA_ENCRYPTION_PREVIOUS_KEYS[${index}]`))
    .filter(Boolean);
  return new FieldCipher(current, previous);
}

export function encryptExistingContent(database, cipher) {
  const tables = ["messages", "direct_messages"];
  if (!cipher.enabled) {
    const encrypted = tables.some((table) => database
      .prepare(`SELECT 1 FROM ${table} WHERE content LIKE 'enc:v1:%' LIMIT 1`)
      .get());
    if (encrypted) throw new Error("DATA_ENCRYPTION_KEY é necessária para abrir este banco");
    return;
  }
  database.transaction(() => {
    for (const table of tables) {
      const update = database.prepare(`UPDATE ${table} SET content = ? WHERE id = ?`);
      for (const row of database.prepare(`SELECT id, content FROM ${table} WHERE content != ''`).iterate()) {
        if (cipher.isCurrent(row.content)) continue;
        const context = `${table}:${row.id}`;
        const plaintext = cipher.decrypt(row.content, context);
        const current = cipher.encrypt(plaintext, context);
        if (current !== row.content) update.run(current, row.id);
      }
    }
  })();
}
