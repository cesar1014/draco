import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, openSync, closeSync, readSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("DRACOBAK1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES;

export function backupKey(env = process.env) {
  const text = env.BACKUP_ENCRYPTION_KEY?.trim();
  if (!text) throw new Error("BACKUP_ENCRYPTION_KEY é obrigatória para backups");
  const key = /^[a-f0-9]{64}$/iu.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64url");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY precisa conter exatamente 32 bytes");
  return key;
}

export function isEncryptedBackup(path) {
  const descriptor = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(MAGIC.length);
    return readSync(descriptor, prefix, 0, prefix.length, 0) === prefix.length && prefix.equals(MAGIC);
  } finally {
    closeSync(descriptor);
  }
}

export async function encryptBackup(sourcePath, destinationPath, key) {
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const output = createWriteStream(destinationPath, { flags: "wx", mode: 0o600 });
  output.write(header);
  await pipeline(createReadStream(sourcePath), cipher, output, { end: false });
  await new Promise((resolve, reject) => {
    output.once("error", reject);
    output.end(cipher.getAuthTag(), resolve);
  });
}

export async function decryptBackup(sourcePath, destinationPath, key) {
  const size = statSync(sourcePath).size;
  if (size <= HEADER_BYTES + TAG_BYTES) throw new Error("backup criptografado truncado");
  const descriptor = openSync(sourcePath, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    readSync(descriptor, header, 0, header.length, 0);
    readSync(descriptor, tag, 0, tag.length, size - TAG_BYTES);
  } finally {
    closeSync(descriptor);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("formato de backup desconhecido");
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(sourcePath, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
    decipher,
    createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
  );
}
