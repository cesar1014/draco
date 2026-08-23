import { timingSafeEqual } from "node:crypto";

/**
 * Este servidor vai ficar exposto na internet, então nada que chega pelo socket
 * é confiável. Aqui ficam os limites: tamanho, formato e frequência.
 */

const MAX_USERNAME = 32;
const MAX_MESSAGE = 2000;

/**
 * Caracteres de controle e invisíveis. Além dos de controle clássicos, derruba
 * os de largura zero e o override de direção (U+202E) — o truque clássico de
 * fazer um nome parecer outro na lista de membros.
 */
const INVISIBLE = "\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\ufeff";
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${INVISIBLE}]`, "g");
/** Igual ao de cima, mas preserva quebras de linha pra mensagem com vários parágrafos. */
const CONTROL_KEEP_NEWLINES = new RegExp(
  `[\\u0000-\\u0009\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f${INVISIBLE}]`,
  "g",
);

function stripControlChars(value, { allowNewlines = false } = {}) {
  return value.replace(allowNewlines ? CONTROL_KEEP_NEWLINES : CONTROL, "");
}

export function sanitizeUsername(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = stripControlChars(raw).replace(/\s+/g, " ").trim().slice(0, MAX_USERNAME);
  // Um nome só de espaços ou de invisíveis viraria um membro fantasma na lista.
  return cleaned.length >= 2 ? cleaned : null;
}

export function sanitizeMessage(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = stripControlChars(raw, { allowNewlines: true }).trim().slice(0, MAX_MESSAGE);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Compara senha sem vazar tamanho nem a posição do primeiro byte diferente.
 * `timingSafeEqual` exige buffers do mesmo tamanho, daí o pré-teste de length.
 */
export function passwordMatches(expected, provided) {
  if (!expected) return true; // sem senha configurada, entrada liberada
  if (typeof provided !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Token bucket por socket e por ação. Um cliente com bug (ou alguém mal
 * intencionado) não derruba o servidor nem inunda o chat de todo mundo.
 */
export class RateLimiter {
  #buckets = new Map();

  /**
   * @param {string} key    identificador do balde, normalmente `socketId:acao`
   * @param {number} burst  quantos eventos seguidos são tolerados
   * @param {number} perSec quantos eventos por segundo repõem o balde
   */
  allow(key, burst, perSec) {
    const now = Date.now();
    const bucket = this.#buckets.get(key) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * perSec);
    bucket.at = now;
    const permitted = bucket.tokens >= 1;
    if (permitted) bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return permitted;
  }

  /** Ao desconectar, joga fora os baldes do socket pra não virar vazamento. */
  forget(prefix) {
    for (const key of this.#buckets.keys()) {
      if (key.startsWith(prefix)) this.#buckets.delete(key);
    }
  }
}
