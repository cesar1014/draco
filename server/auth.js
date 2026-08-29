import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Identidade assinada pelo servidor.
 *
 * Antes disto o cliente mandava o próprio `userId` e ele era aceito de cara:
 * quem soubesse o identificador de outra pessoa entrava como ela. Agora o
 * servidor emite um token assinado, o navegador só o guarda, e reassumir uma
 * identidade exige apresentar a assinatura.
 *
 * O formato é deliberadamente pequeno — `v1.<payload>.<assinatura>`, tudo em
 * base64url — porque a coisa toda cabe no `localStorage` e viaja num campo do
 * `identify`. Não é JWT: não precisamos de algoritmo negociável, e um formato
 * fixo elimina a classe de falha em que o atacante escolhe o algoritmo.
 *
 * O segredo nunca sai daqui. Ele vem de `SESSION_SECRET` ou, na falta dele, é
 * sorteado no primeiro boot e guardado no banco, pra que reiniciar o processo não
 * invalide os tokens de todo mundo.
 */

const VERSION = "v1";
const SECRET_SETTING = "session_secret";
/** 30 dias. Longo de propósito: perder o token é perder a identidade na lista. */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Faltando menos que isso pra expirar, o token é reemitido na próxima entrada. */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

const encode = (value) => Buffer.from(value, "utf8").toString("base64url");

function sign(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class SessionAuthority {
  #secret;

  constructor(secret) {
    this.#secret = secret;
  }

  /** Token novo pra uma identidade. `userId` ausente cria uma. */
  issue(userId = randomUUID(), sessionVersion = 0) {
    const payload = encode(
      JSON.stringify({ sub: userId, ver: sessionVersion, exp: Date.now() + TOKEN_TTL_MS }),
    );
    return { userId, token: `${VERSION}.${payload}.${sign(this.#secret, payload)}` };
  }

  /**
   * `null` quando o token não presta: formato errado, assinatura inválida ou
   * prazo vencido. Quem chama trata os três do mesmo jeito — emite identidade
   * nova — porque a diferença entre eles não muda nada pra quem está entrando, e
   * contá-la ajudaria quem estiver testando assinaturas.
   */
  verify(token) {
    if (typeof token !== "string" || token.length > 512) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== VERSION) return null;

    const [, payload, signature] = parts;
    if (!safeEqual(signature, sign(this.#secret, payload))) return null;

    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (typeof claims?.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(claims.sub)) return null;
    if (typeof claims.exp !== "number" || claims.exp <= Date.now()) return null;

    const sessionVersion = Number.isInteger(claims.ver) && claims.ver >= 0 ? claims.ver : 0;
    return { userId: claims.sub, sessionVersion, expiresAt: claims.exp };
  }

  /**
   * Renova antes de o prazo acabar, pra que quem usa o app toda semana nunca
   * perca a identidade por expiração. Devolve `null` quando ainda não é hora,
   * e aí o cliente segue com o token que já tem.
   */
  renewIfNeeded(session) {
    if (session.expiresAt - Date.now() > RENEW_BEFORE_MS) return null;
    return this.issue(session.userId, session.sessionVersion);
  }
}

/**
 * Segredo de assinatura. `SESSION_SECRET` manda; sem ele, um valor sorteado no
 * primeiro boot fica no banco. Guardar em vez de sortear a cada boot é o que faz
 * um deploy não deslogar todo mundo.
 */
export function resolveSessionSecret(repository, env = process.env) {
  const configured = env.SESSION_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) {
      throw new Error("SESSION_SECRET precisa ter pelo menos 32 caracteres");
    }
    return { secret: configured, source: "env" };
  }

  const stored = repository.readSetting(SECRET_SETTING);
  if (typeof stored === "string" && stored.length >= 32) {
    return { secret: stored, source: "stored" };
  }

  const generated = randomBytes(48).toString("base64url");
  repository.writeSetting(SECRET_SETTING, generated);
  return { secret: generated, source: "generated" };
}

export function createSessionAuthority(repository, env = process.env) {
  const { secret, source } = resolveSessionSecret(repository, env);
  return { auth: new SessionAuthority(secret), source };
}
