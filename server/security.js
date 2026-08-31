import { timingSafeEqual } from "node:crypto";

/**
 * Este servidor vai ficar exposto na internet, então nada que chega pelo socket
 * é confiável. Aqui ficam os limites: tamanho, formato e frequência.
 */

const MAX_USERNAME = 32;
const MAX_MESSAGE = 2000;
const MAX_PASSWORD = 256;
const MAX_GUILD_NAME = 48;
const MAX_CHANNEL_NAME = 32;
const MAX_REASON = 200;
const MAX_ROLE_NAME = 32;
/**
 * SDP de uma call com tela e quatro trilhas passa longe disso. O teto existe
 * porque o corpo inteiro do evento é lido antes de qualquer validação, e um SDP
 * inventado de megabytes viraria memória parada no servidor.
 */
const MAX_SDP = 60_000;

/**
 * Caracteres de controle e invisíveis. Além dos de controle clássicos, derruba
 * os de largura zero e o override de direção (U+202E), o truque clássico de
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
  if (typeof raw !== "string" || raw.length > MAX_USERNAME * 4) return null;
  const cleaned = stripControlChars(raw).replace(/\s+/g, " ").trim().slice(0, MAX_USERNAME);
  // Um nome só de espaços ou de invisíveis viraria um membro fantasma na lista.
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * ID público digitável, usado para encontrar uma conta. É separado do nome
 * exibido: nomes podem se repetir, mas este valor é único sem diferenciar
 * maiúsculas/minúsculas. ASCII evita IDs visualmente idênticos com alfabetos
 * diferentes; o @ é aceito na entrada apenas por conveniência e não é salvo.
 */
export function sanitizePublicId(raw) {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const cleaned = raw.normalize("NFKC").trim().replace(/^@/u, "").toLowerCase();
  return /^[a-z0-9](?:[a-z0-9_.-]{1,30}[a-z0-9])$/u.test(cleaned) ? cleaned : null;
}

/**
 * O cadastro pede apenas a idade declarada, não a data de nascimento. Depois de
 * confirmar 18+, o número não é persistido: isso aplica a regra sem guardar um
 * dado pessoal que o aplicativo não precisa usar novamente.
 */
export const validAdultAge = (raw) =>
  Number.isInteger(raw) && raw >= 18 && raw <= 120;

export function sanitizeMessage(raw) {
  if (typeof raw !== "string" || raw.length > MAX_MESSAGE * 4) return null;
  const cleaned = stripControlChars(raw, { allowNewlines: true }).trim().slice(0, MAX_MESSAGE);
  return cleaned.length > 0 ? cleaned : null;
}

/** Nome de servidor: mesmas regras do apelido, só o teto é outro. */
export function sanitizeGuildName(raw) {
  if (typeof raw !== "string" || raw.length > MAX_GUILD_NAME * 4) return null;
  const cleaned = stripControlChars(raw).replace(/\s+/g, " ").trim().slice(0, MAX_GUILD_NAME);
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * Nome de canal. Canal de texto vira minúsculo com hífen no lugar do espaço,
 * como a interface já desenha (`#bate-papo`); canal de voz mantém a escrita
 * normal, porque é um rótulo que se lê ("Sala de Jogo").
 */
export function sanitizeChannelName(raw, type) {
  if (typeof raw !== "string" || raw.length > MAX_CHANNEL_NAME * 4) return null;
  const cleaned = stripControlChars(raw).replace(/\s+/g, " ").trim();
  if (type === "voice") {
    const voice = cleaned.slice(0, MAX_CHANNEL_NAME);
    return voice.length >= 1 ? voice : null;
  }
  const text = cleaned
    .toLowerCase()
    .replace(/\s/g, "-")
    // Só o que sobrevive num nome de canal: letra, número, hífen e sublinhado.
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CHANNEL_NAME);
  return text.length >= 1 ? text : null;
}

/** Motivo de banimento. Opcional: ausente é diferente de vazio. */
export function sanitizeReason(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return null;
  const cleaned = stripControlChars(raw).replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
  return cleaned.length > 0 ? cleaned : null;
}

export function sanitizeRoleName(raw) {
  if (typeof raw !== "string" || raw.length > MAX_ROLE_NAME * 4) return null;
  const cleaned = stripControlChars(raw).replace(/\s+/g, " ").trim().slice(0, MAX_ROLE_NAME);
  return cleaned.length >= 2 ? cleaned : null;
}

/** Identificador de mensagem, canal ou sessão: texto curto, sem surpresa. */
export const isId = (value, max = 64) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** Descrição de sessão com teto de tamanho. `null` quando não serve. */
export function sanitizeDescription(value) {
  if (!value || typeof value !== "object") return null;
  const { type, sdp } = value;
  if (type !== "offer" && type !== "answer") return null;
  if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > MAX_SDP) return null;
  return { type, sdp };
}

/**
 * Candidato ICE. Só os campos que o outro navegador usa são repassados: o objeto
 * chega do cliente e devolver o que veio permitiria enfiar carga arbitrária no
 * evento que o outro lado recebe.
 */
export function sanitizeCandidate(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = value;
  if (typeof candidate !== "string" || candidate.length > 512) return undefined;
  return {
    candidate,
    sdpMid: typeof sdpMid === "string" && sdpMid.length <= 16 ? sdpMid : null,
    sdpMLineIndex: Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 ? sdpMLineIndex : null,
    ...(typeof usernameFragment === "string" && usernameFragment.length <= 256
      ? { usernameFragment }
      : {}),
  };
}

/**
 * Compara senha sem vazar tamanho nem a posição do primeiro byte diferente.
 * `timingSafeEqual` exige buffers do mesmo tamanho, daí o pré-teste de length.
 */
export function passwordMatches(expected, provided) {
  if (!expected) return true; // sem senha configurada, entrada liberada
  if (typeof provided !== "string" || provided.length > MAX_PASSWORD) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Endereço de quem conectou. Atrás de proxy (Fly, Render, Cloudflare) o socket vê
 * o IP do proxy, e o real vem no `x-forwarded-for`. Ler o cabeçalho só quando
 * `TRUSTED_PROXY=1` é o ponto: num servidor exposto direto, qualquer cliente
 * pode inventar esse cabeçalho e escapar do limite por IP trocando o valor.
 */
export function clientAddress(socket, trustProxy) {
  if (trustProxy) {
    const forwarded = socket.handshake.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address ?? "desconhecido";
}

/** Quanto tempo um balde intocado continua ocupando memória. */
const BUCKET_TTL_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;

/**
 * Token bucket por chave e por ação.
 *
 * A chave importa: usar o id do socket faria reconectar zerar o limite, o que é
 * exatamente o que um cliente abusivo faria. Quem chama passa o IP antes da
 * identificação e o `userId` depois dela, porque nenhum dos dois muda quando o
 * socket cai e volta.
 */
export class RateLimiter {
  #buckets = new Map();
  #lastSweep = Date.now();

  /**
   * @param {string} key    identificador do balde, `<escopo>:<ação>`
   * @param {number} burst  quantos eventos seguidos são tolerados
   * @param {number} perSec quantos eventos por segundo repõem o balde
   */
  allow(key, burst, perSec) {
    const now = Date.now();
    this.#sweep(now);
    const bucket = this.#buckets.get(key) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * perSec);
    bucket.at = now;
    const permitted = bucket.tokens >= 1;
    if (permitted) bucket.tokens -= 1;
    this.#buckets.set(key, bucket);
    return permitted;
  }

  /**
   * Devolve um token ao balde. Serve pra cobrar só o que deu errado: a tentativa
   * de entrada consome do balde apertado e, quando ela é legítima, o token volta.
   * Assim quem acerta a senha nunca esbarra no limite, e quem erra vai ficando
   * sem tentativas.
   */
  refund(key, burst) {
    const bucket = this.#buckets.get(key);
    if (!bucket) return;
    bucket.tokens = Math.min(burst, bucket.tokens + 1);
  }

  /**
   * Baldes cheios e parados não guardam informação: recriá-los dá o mesmo
   * resultado. Sem esta limpeza, um servidor exposto acumularia uma entrada por
   * IP que já passou por aqui.
   */
  #sweep(now) {
    if (now - this.#lastSweep < SWEEP_EVERY_MS) return;
    this.#lastSweep = now;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.at > BUCKET_TTL_MS) this.#buckets.delete(key);
    }
  }
}

/**
 * Balde persistente para autenticação HTTP. O SQLite é o armazenamento
 * compartilhado pelas instâncias que usam o mesmo volume e impede que reiniciar
 * o processo zere tentativas de senha. As chaves recebidas já são HMACs opacos.
 */
export class PersistentRateLimiter {
  constructor(database) {
    this.database = database;
    this.read = database.prepare(
      "SELECT tokens, updated_at FROM security_rate_limits WHERE scope_key = ? AND expires_at > ?",
    );
    this.write = database.prepare(`
      INSERT INTO security_rate_limits(scope_key, tokens, updated_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        tokens = excluded.tokens,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `);
    this.prune = database.prepare("DELETE FROM security_rate_limits WHERE expires_at <= ?");
    this.lastPrune = 0;
    this.consume = database.transaction((key, burst, perSec, now) => {
      const row = this.read.get(key, now);
      const available = row
        ? Math.min(burst, row.tokens + ((now - row.updated_at) / 1000) * perSec)
        : burst;
      const permitted = available >= 1;
      this.write.run(key, permitted ? available - 1 : available, now, now + BUCKET_TTL_MS);
      return permitted;
    });
  }

  allow(key, burst, perSec) {
    const now = Date.now();
    if (now - this.lastPrune >= SWEEP_EVERY_MS) {
      this.prune.run(now);
      this.lastPrune = now;
    }
    return this.consume(key, burst, perSec, now);
  }
}
