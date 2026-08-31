import "dotenv/config";
import express from "express";
import helmet from "helmet";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { Server as SocketServer } from "socket.io";
import { DEV_API_PORT, DEV_WEB_PORT } from "../shared/ports.js";
import { createAccountService } from "./accounts.js";
import { createSessionAuthority } from "./auth.js";
import { logger, reason } from "./log.js";
import { createMailer } from "./mail.js";
import { resolveIceConfig } from "./ice.js";
import { PersistentRateLimiter } from "./security.js";
import { attachSignaling } from "./signaling.js";
import { closeState, colorForName, listMembers, readSetting, writeSetting } from "./state.js";
import { Telemetry } from "./telemetry.js";
import { ObjectStorage } from "./object-storage.js";
import { AttachmentRepository } from "./data/attachment-repository.js";
import { CommunicationRepository } from "./data/communication-repository.js";
import {
  clearSessionCookie,
  ensureDeviceCookie,
  sessionCookie,
  setSessionCookie,
} from "./cookies.js";
import { hashActionToken, normalizeEmail } from "./passwords.js";
import { BotProtection } from "./bot-protection.js";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const certsDir = join(here, "certs");

const log = logger("APP");
const useHttps = process.argv.includes("--https");

/**
 * `--dev` significa "estou atrás do proxy do Vite": use a porta combinada em
 * `shared/ports.js` e ignore qualquer `PORT` do ambiente. Ignorar é o ponto:
 * quem roda o dev pode ter um `PORT` herdado destinado ao servidor da página, e
 * a sinalização subiria na mesma porta que o Vite, deixando o proxy apontando
 * pro vazio. Sem `--dev` (produção) manda o `PORT` da plataforma de deploy.
 */
const isDev = process.argv.includes("--dev");
const isProduction = process.env.NODE_ENV === "production";
const port = isDev ? DEV_API_PORT : Number(process.env.PORT ?? DEV_API_PORT);
const host = isDev ? "0.0.0.0" : (process.env.HOST ?? "0.0.0.0");

/**
 * Origens aceitas pelo Socket.IO. Uma lista, não um valor: publicar costuma
 * envolver dois endereços ao mesmo tempo (o domínio e o túnel) e trocar de um pro
 * outro derrubaria quem estivesse no antigo.
 */
const allowedOrigins = (process.env.ORIGIN ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

for (const origin of allowedOrigins) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`ORIGIN inválida: ${origin}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error(`ORIGIN deve conter somente protocolo e host: ${origin}`);
  }
}
if (isProduction && allowedOrigins.length === 0) {
  throw new Error("ORIGIN é obrigatória em produção");
}
if (isProduction && allowedOrigins.some((origin) => !origin.startsWith("https://"))) {
  throw new Error("todas as origens de produção precisam usar HTTPS");
}
const appUrl = process.env.APP_URL?.replace(/\/+$/, "") ?? allowedOrigins[0] ?? null;
if (isProduction && (!appUrl || !allowedOrigins.includes(appUrl))) {
  throw new Error("APP_URL deve ser uma das origens HTTPS permitidas em produção");
}

/**
 * Em desenvolvimento a origem é livre: quem abre é o Vite, um túnel ou o celular
 * na rede local, e cada um chega com um endereço diferente. Em produção o boot
 * acima recusa uma lista vazia ou sem HTTPS.
 */
const originIsOpen = allowedOrigins.length === 0;
const externallySecure = useHttps || (!isDev && allowedOrigins.some((origin) => origin.startsWith("https://")));
const objectStorage = new ObjectStorage(process.env);
const objectStorageOrigin = objectStorage.ready ? new URL(objectStorage.endpoint).origin : null;
const botProtection = new BotProtection(process.env);
const turnstileOrigin = botProtection.ready ? "https://challenges.cloudflare.com" : null;

/**
 * Um pedido sem `Origin` não é um navegador de outro site: é o próprio app de
 * desktop, um cliente nativo ou uma verificação de saúde da plataforma. Recusar
 * derrubaria o Electron, que é justamente quem não manda origem.
 */
const originAllowed = (origin) => originIsOpen || !origin || allowedOrigins.includes(origin);

/** Endereços IPv4 da máquina na rede local, pra imprimir link que o celular abre. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface.address);
}

/**
 * Certificado autoassinado pra rede local. Navegador só libera câmera e
 * microfone em origem segura, e `localhost` é a única exceção, então testar no
 * celular ou em outro PC da casa exige HTTPS, mesmo que o certificado seja
 * "inválido" (aparece um aviso que se aceita uma vez por aparelho).
 */
async function loadOrCreateCert() {
  const keyPath = join(certsDir, "key.pem");
  const certPath = join(certsDir, "cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }

  // Import dinâmico porque `selfsigned` é dependência de desenvolvimento: em
  // produção sem `--https` o servidor sobe mesmo que ela não esteja instalada.
  const { default: selfsigned } = await import("selfsigned");
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...lanAddresses().map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    days: 365,
    keySize: 2048,
    extensions: [{ name: "subjectAltName", altNames }],
  });

  mkdirSync(certsDir, { recursive: true });
  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);
  log.info(`certificado autoassinado gerado em ${certsDir}`);
  return { key: pems.private, cert: pems.cert };
}

const app = express();
app.disable("x-powered-by");
if (process.env.TRUSTED_PROXY === "1") app.set("trust proxy", 1);

app.use((req, res, next) => {
  if (!isProduction || req.secure) return next();
  if (["GET", "HEAD"].includes(req.method) && appUrl) {
    return res.redirect(308, `${appUrl}${req.originalUrl}`);
  }
  return res.status(426).set("Cache-Control", "no-store").json({ error: "https-required" });
});

/**
 * Cabeçalhos de segurança. A CSP é escrita à mão porque a de fábrica do Helmet
 * quebraria três coisas deste app: o `connect-src` precisa aceitar `ws:`/`wss:`
 * pro Socket.IO, o `worker-src` precisa de `blob:` pro worklet de redução de
 * ruído, e as miniaturas do seletor de telas chegam como `data:`.
 *
 * `unsafe-inline` fica só no estilo: o React aplica `style` inline em alguns
 * tiles, e proibir isso exigiria um nonce por render sem ganho real. Em script
 * não há inline nenhum, e é ali que a proteção conta.
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "object-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        "frame-src": ["'self'", ...(turnstileOrigin ? [turnstileOrigin] : [])],
        "form-action": ["'self'"],
        "script-src": ["'self'", ...(turnstileOrigin ? [turnstileOrigin] : [])],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:", ...(objectStorageOrigin ? [objectStorageOrigin] : [])],
        "media-src": ["'self'", "blob:", "mediastream:"],
        "font-src": ["'self'", "data:"],
        "worker-src": ["'self'", "blob:"],
        "connect-src": isDev
          ? ["'self'", "ws:", "wss:", ...(objectStorageOrigin ? [objectStorageOrigin] : []), ...(turnstileOrigin ? [turnstileOrigin] : [])]
          : ["'self'", ...(objectStorageOrigin ? [objectStorageOrigin] : []), ...(turnstileOrigin ? [turnstileOrigin] : [])],
        // Sem HTTPS o navegador tentaria promover o websocket e a call não subiria
        // em `http://localhost` nem na rede local.
        ...(useHttps ? { "upgrade-insecure-requests": [] } : {}),
      },
    },
    // A página abre câmera, microfone e captura de tela; a padrão do Helmet
    // (`same-origin`) barra o `postMessage` que o Electron usa no seletor.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    // `require-corp` obrigaria cada recurso a declarar CORP, e as miniaturas em
    // `data:` do app de desktop não declaram nada.
    crossOriginEmbedderPolicy: false,
    // HSTS só faz sentido em domínio com certificado de verdade: no
    // autoassinado da rede local ele prenderia o aparelho num HTTPS quebrado.
    hsts: externallySecure,
  }),
);

app.use((_req, res, next) => {
  res.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)");
  next();
});

// Rotas JSON recusam corpo com tipo ambíguo. Sem isso um proxy ou cliente pode
// fazer o parser e a validação discordarem sobre o mesmo conteúdo.
app.use("/api", (req, res, next) => {
  if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json")) {
    return res.status(415).json({ error: "unsupported-media-type" });
  }
  next();
});

app.use(express.json({ limit: "16kb" }));

app.use((error, req, res, next) => {
  if (!error || !req.path.startsWith("/api")) return next(error);
  if (error.type === "entity.too.large") return res.status(413).json({ error: "payload-too-large" });
  if (error instanceof SyntaxError) return res.status(400).json({ error: "invalid-json" });
  return next(error);
});

app.use("/api/auth", (req, res, next) => {
  if (req.method !== "POST") return next();
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ ok: false, error: "bad-request" });
  }
  next();
});

/**
 * As rotas `/api` são do próprio app, servido da mesma origem. Aceitar chamada de
 * outro site aqui só serviria pra alguém montar uma página que fala com este
 * servidor no lugar da nossa.
 */
app.use("/api", (req, res, next) => {
  if (originAllowed(req.headers.origin)) return next();
  res.status(403).json({ error: "origin-not-allowed" });
});

/** Autoridades de conta e rotas de autenticação da mesma origem do aplicativo. */
const { auth, source: secretSource } = createSessionAuthority({ readSetting, writeSetting });
const mailer = createMailer(process.env);
const accountService = createAccountService({ auth, mailer, colorForName, env: process.env });
const accountLimiter = new PersistentRateLimiter(accountService.repository.database);
const telemetry = new Telemetry();
const attachments = new AttachmentRepository(accountService.repository.database, objectStorage, process.env);
const communication = new CommunicationRepository(accountService.repository.database, attachments);
let uploadCleanupRunning = false;

async function removeExpiredUploads() {
  if (uploadCleanupRunning) return;
  uploadCleanupRunning = true;
  try {
    for (const attachment of [...attachments.expiredPending(), ...attachments.orphaned()]) {
      attachments.remove(attachment.id);
    }
    if (!objectStorage.ready) return;
    for (const queued of attachments.queuedDeletions()) {
      try {
        if (await objectStorage.remove(queued.storage_key)) {
          attachments.completeDeletion(queued.storage_key);
        } else {
          attachments.failDeletion(queued.storage_key);
        }
      } catch (error) {
        attachments.failDeletion(queued.storage_key);
        log.warn("falha ao remover upload pendente", { motivo: reason(error) });
      }
    }
  } finally {
    uploadCleanupRunning = false;
  }
}

void removeExpiredUploads();
const uploadCleanup = setInterval(() => void removeExpiredUploads(), 5 * 60_000);
uploadCleanup.unref();

function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
}

function sessionToken(req) {
  return sessionCookie(req.headers.cookie) ?? bearer(req);
}

function deviceCredential(req, res, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const browserSecret = ensureDeviceCookie(req, res, externallySecure);
  return auth.fingerprintIdentity(`${browserSecret}\0${normalized}`, "device-cookie");
}

function accountRoute(handler, {
  burst = 8, perSec = 0.2, clearSession = false, identity = null, botAction = null,
} = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    const addressKey = auth.fingerprintAddress(req.ip)
      ?? auth.fingerprintIdentity(req.ip, "rate-address");
    const path = req.route?.path ?? req.path;
    const addressAllowed = accountLimiter.allow(`ip:${path}:${addressKey}`, burst, perSec);
    const rawIdentity = identity?.(req);
    const identityKey = rawIdentity
      ? auth.fingerprintIdentity(String(rawIdentity).trim().toLowerCase(), "rate-identity")
      : null;
    const identityAllowed = !identityKey
      || accountLimiter.allow(`identity:${path}:${identityKey}`, burst, perSec);
    if (!addressAllowed || !identityAllowed) {
      return res.status(429).json({ ok: false, error: "rate-limited" });
    }
    try {
      if (botAction && !await botProtection.verify(req.body?.botToken, req.ip, botAction)) {
        return res.status(400).json({ ok: false, error: "bot-verification-failed" });
      }
      const result = await handler(req, res);
      if (result.ok && result.token) setSessionCookie(res, result.token, externallySecure);
      if (clearSession) clearSessionCookie(res, externallySecure);
      const { detail: _detail, token: _token, deviceToken: _deviceToken, ...safe } = result;
      const status = result.ok
        ? 200
        : result.error === "not-authenticated"
          ? 401
          : result.error === "email-taken" || result.error === "username-taken"
            ? 409
            : 400;
      return res.status(status).json(safe);
    } catch (error) {
      log.error("falha em conta", { rota: req.path, motivo: reason(error) });
      return res.status(500).json({ ok: false, error: "account-failed" });
    }
  };
}

app.get("/api/config", (_req, res) => {
  res.json({
    auth: "accounts",
    emailReady: accountService.emailReady,
    guestInvites: true,
    turnstileSiteKey: botProtection.siteKey,
  });
});

const emailIdentity = (req) => normalizeEmail(req.body?.email);

app.post("/api/auth/register", accountRoute(
  (req) => accountService.register(req.body, req.ip),
  { identity: emailIdentity, botAction: "register" },
));
app.post("/api/auth/login", accountRoute((req, res) => accountService.login({
  email: req.body?.email,
  password: req.body?.password,
  legacyDeviceToken: req.body?.legacyDeviceToken ?? req.body?.deviceToken ?? null,
  deviceToken: deviceCredential(req, res, req.body?.email),
}, req.ip, req.headers), { identity: emailIdentity, botAction: "login" }));
app.post("/api/auth/verify", accountRoute((req) => accountService.verifyEmail(req.body?.token, req.ip)));
app.post(
  "/api/auth/login-address/confirm",
  accountRoute((req) => accountService.confirmLoginAddress(req.body?.token), {
    burst: 6,
    perSec: 0.1,
  }),
);
app.get("/api/admin/health", (req, res) => {
  res.set("Cache-Control", "no-store");
  const authenticated = accountService.session(sessionToken(req), req.ip);
  if (!authenticated?.account?.isSystemAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
  return res.json({ ok: true, metrics: telemetry.snapshot(io, accountService.repository.database, listMembers().filter((member) => !member.guest).length) });
});
app.post("/api/attachments/presign", accountRoute((req) => {
  const authenticated = accountService.session(sessionToken(req), req.ip);
  if (!authenticated) return { ok: false, error: "not-authenticated" };
  if (!objectStorage.ready) return { ok: false, error: "storage-unavailable" };
  const scope = req.body?.scope;
  const messageId = req.body?.messageId;
  if (!["channel", "direct"].includes(scope) || typeof messageId !== "string" || messageId.length > 64) return { ok: false, error: "bad-request" };
  const valid = objectStorage.validate(req.body?.filename, req.body?.mime, req.body?.size);
  if (!valid.ok) return valid;
  const storageKey = objectStorage.createKey(authenticated.userId, valid.filename);
  const attachment = attachments.create({
    scope, messageId, ownerId: authenticated.userId,
    filename: valid.filename, mime: valid.mime, size: valid.size,
    storageKey,
  });
  if (!attachment) return { ok: false, error: "not-author" };
  if (attachment.quotaExceeded) return { ok: false, error: "attachment-quota" };
  return {
    ok: true,
    attachmentId: attachment.id,
    uploadUrl: objectStorage.presign("PUT", storageKey),
    headers: { "Content-Type": valid.mime },
  };
}, { burst: 8, perSec: 0.3 }));

app.post("/api/attachments/complete", accountRoute(async (req) => {
  const authenticated = accountService.session(sessionToken(req), req.ip);
  if (!authenticated) return { ok: false, error: "not-authenticated" };
  const pending = attachments.pending(req.body?.attachmentId, authenticated.userId);
  if (!pending || pending.uploaded_at) return { ok: false, error: "no-attachment" };
  const verified = await objectStorage.verify(pending.storage_key, pending.mime_type, pending.byte_size);
  if (!verified) {
    attachments.removePending(pending.id, authenticated.userId);
    void removeExpiredUploads();
    return { ok: false, error: "attachment-invalid" };
  }
  attachments.complete(pending.id, authenticated.userId);
  if (pending.message_id) {
    const message = communication.channelMessage(pending.message_id);
    if (message) io.to(`channel:${message.channelId}`).emit("chat:updated", message);
  } else if (pending.direct_message_id) {
    const message = communication.directMessage(pending.direct_message_id);
    if (message) io.to(`direct:${message.threadId}`).emit("direct:updated", message);
  }
  return { ok: true };
}, { burst: 12, perSec: 0.5 }));
app.post(
  "/api/auth/password/request",
  accountRoute((req) => accountService.requestPassword(req.body?.email), {
    burst: 4, perSec: 0.03, identity: emailIdentity, botAction: "password-request",
  }),
);
app.post(
  "/api/auth/password/change-request",
  accountRoute((req) => accountService.requestOwnPassword(sessionToken(req), req.ip), { burst: 4, perSec: 0.03 }),
);
app.post(
  "/api/auth/password/complete",
  accountRoute((req, res) => {
    const action = accountService.repository.token(hashActionToken(req.body?.token));
    const account = action ? accountService.repository.accountById(action.user_id) : null;
    const credential = account ? deviceCredential(req, res, account.email) : null;
    return accountService.completePassword(
      req.body?.token, req.body?.password, req.ip, req.headers, credential,
    );
  }),
);
app.post("/api/auth/session/migrate", accountRoute((req) => {
  const legacy = bearer(req);
  return accountService.session(legacy, req.ip)
    ? { ok: true, token: legacy }
    : { ok: false, error: "not-authenticated" };
}, { burst: 6, perSec: 0.2 }));
app.post("/api/auth/session", accountRoute((req) => {
  const current = sessionToken(req);
  const authenticated = accountService.session(current, req.ip);
  if (!authenticated) return { ok: false, error: "not-authenticated" };
  const renewed = auth.renewIfNeeded(authenticated);
  return {
    ok: true,
    token: renewed?.token ?? current,
    account: accountService.publicAccount(authenticated.account),
  };
}, { burst: 10, perSec: 0.5 }));
app.post("/api/auth/device/migrate", accountRoute((req, res) => {
  const authenticated = accountService.session(sessionToken(req), req.ip);
  if (!authenticated?.sessionId) return { ok: false, error: "not-authenticated" };
  const credential = deviceCredential(req, res, authenticated.account.email);
  const changed = credential && accountService.repository.replaceSessionDeviceCredential(
    authenticated.userId,
    authenticated.sessionId,
    hashActionToken(credential),
  );
  return changed
    ? { ok: true }
    : { ok: false, error: "device-migration-unavailable" };
}, { burst: 4, perSec: 0.1 }));
app.get(
  "/api/auth/sessions",
  accountRoute((req) => accountService.listSessions(sessionToken(req), req.ip), { burst: 20, perSec: 1 }),
);
app.delete(
  "/api/auth/sessions/:sessionId",
  accountRoute((req) => accountService.revokeSession(sessionToken(req), req.ip, req.params.sessionId), { burst: 10, perSec: 0.5 }),
);
app.post(
  "/api/auth/sessions/revoke-all",
  accountRoute((req) => accountService.revokeAllSessions(sessionToken(req), req.ip), {
    burst: 3, perSec: 0.05, clearSession: true,
  }),
);
app.post(
  "/api/auth/logout",
  accountRoute((req) => accountService.logout(sessionToken(req), req.ip), {
    burst: 10, perSec: 0.5, clearSession: true,
  }),
);

/**
 * Saída do autoteste do WebRTC. Só existe com `--dev`, e o motivo de gravar em
 * disco é prático: o teste sobe duas conexões e vários contextos de áudio na
 * mesma aba, e quando essa aba engasga o console vai embora junto. O arquivo fica.
 */
if (isDev) {
  app.post("/api/dev/selftest", (req, res) => {
    writeFileSync(join(here, "..", "selftest-report.json"), JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  });
}

/**
 * Configuração de ICE. `expiresAt` vai na resposta pra que o cliente saiba até
 * quando a credencial de TURN vale, em vez de guardá-la pra sempre e descobrir
 * que venceu só quando uma call não conecta.
 *
 * `?refresh=1` é o cliente dizendo que o ICE falhou com TURN no ar: a credencial
 * pode ter sido revogada, e insistir na mesma repetiria a falha. O intervalo
 * mínimo existe porque a chamada custa uma requisição ao provedor, e uma call com
 * seis pessoas em rede ruim pediria seis renovações no mesmo segundo.
 */
app.get("/api/ice", (_req, res) => {
  res.status(401).set("Cache-Control", "no-store").json({ error: "authentication-required" });
});

// Em produção o mesmo processo serve o front. Uma origem só: sem CORS, e o
// endereço do túnel funciona pra página e pro websocket ao mesmo tempo.
if (existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/socket.io")) {
      return next();
    }
    res.set("Cache-Control", "no-store").sendFile(join(distDir, "index.html"));
  });
}

const credentials = useHttps ? await loadOrCreateCert() : null;
const server = credentials ? createHttpsServer(credentials, app) : createHttpServer(app);

const io = new SocketServer(server, {
  // SDP de uma call com tela passa longe disso; o teto só existe pra cortar abuso.
  maxHttpBufferSize: 2e5,
  cors: {
    // A função, e não `true`: com `ORIGIN` configurado o websocket recusa quem
    // não está na lista, em vez de refletir qualquer origem que apareça.
    origin: (origin, callback) => callback(null, originAllowed(origin)),
    methods: ["GET", "POST"],
  },
  allowRequest: (req, callback) => {
    if (!originAllowed(req.headers.origin)) return callback("origin-not-allowed", false);
    if (!isProduction) return callback(null, true);
    const forwarded = process.env.TRUSTED_PROXY === "1"
      ? String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim()
      : null;
    const secure = forwarded ? forwarded === "https" : req.socket.encrypted === true;
    return callback(secure ? null : "https-required", secure);
  },
});

const adminBootstrap = await accountService.bootstrapSystemAdmin();
attachSignaling(io, process.env, { auth, accountService, telemetry, attachments });

server.listen(port, host, async () => {
  const scheme = credentials ? "https" : "http";
  const ice = await resolveIceConfig();

  console.log("");
  if (isDev) {
    console.log(`  abra no navegador  ·  http://localhost:${DEV_WEB_PORT}`);
    console.log(`  sinalização        ·  ${scheme}://localhost:${port}`);
    console.log(`  autoteste          ·  http://localhost:${DEV_WEB_PORT}/?selftest=1`);
  } else {
    console.log(`  Draco  ·  ${scheme}://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  na rede local  ·  ${scheme}://${ip}:${port}`);
    if (!existsSync(distDir)) {
      console.log(`  atenção        ·  sem 'dist/': rode 'npm run build' ou use 'npm run dev'`);
    }
  }
  console.log("");
  console.log(`  contas         ·  e-mail ${accountService.emailReady ? "ativo" : "não configurado"}`);
  console.log(`  administrador  ·  ${adminBootstrap.active ? "ativo" : adminBootstrap.emailSent ? "ativação enviada" : "pendente"}`);
  console.log(`  origem         ·  ${originIsOpen ? "qualquer" : allowedOrigins.join(", ")}`);
  console.log(`  sessões        ·  segredo ${secretSource === "env" ? "do ambiente" : "guardado no banco"}`);
  console.log(`  TURN           ·  ${ice.hasTurn ? `ativo (${ice.source})` : "ausente, só STUN"}`);
  if (ice.warning) console.log(`  atenção        ·  ${ice.warning}`);
  console.log("");
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("encerramento iniciado", { sinal: signal });

  const forceExit = setTimeout(() => {
    log.error("encerramento excedeu o limite", { sinal: signal });
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  try {
    await new Promise((resolve) => io.close(resolve));
    clearInterval(uploadCleanup);
    accountService.close();
    telemetry.close();
    closeState();
    clearTimeout(forceExit);
    log.info("encerramento concluído", { sinal: signal });
    process.exitCode = 0;
  } catch (error) {
    clearTimeout(forceExit);
    log.error("falha ao encerrar", { sinal: signal, motivo: reason(error) });
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
