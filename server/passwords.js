import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_BYTES = 64;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;

export function normalizeEmail(raw) {
  if (typeof raw !== "string" || raw.length > 320) return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return null;
  return email;
}

export function validPassword(raw) {
  return typeof raw === "string" && raw.length >= 10 && raw.length <= 128;
}

export async function hashPassword(password) {
  if (!validPassword(password)) throw new Error("senha inválida");
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_BYTES, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString("base64url"),
    Buffer.from(key).toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [algorithm, n, r, p, saltText, keyText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !keyText) return false;
  const options = {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  };
  if (
    !Number.isInteger(options.N) ||
    !Number.isInteger(options.r) ||
    !Number.isInteger(options.p) ||
    options.N < 2 ||
    options.N > 131_072 ||
    options.r < 1 ||
    options.r > 32 ||
    options.p < 1 ||
    options.p > 8
  ) {
    return false;
  }

  try {
    const expected = Buffer.from(keyText, "base64url");
    if (expected.length !== KEY_BYTES) return false;
    const actual = Buffer.from(
      await scrypt(password, Buffer.from(saltText, "base64url"), expected.length, options),
    );
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** O link leva o segredo; o SQLite guarda apenas sua impressão. */
export const hashActionToken = (token) =>
  createHash("sha256").update(String(token)).digest("base64url");

export const createActionToken = () => randomBytes(32).toString("base64url");
