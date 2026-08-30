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
import { resolveIceConfig, invalidateIceCache } from "./ice.js";
import { RateLimiter } from "./security.js";
import { attachSignaling } from "./signaling.js";
import { colorForName, readSetting, writeSetting } from "./state.js";

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
const port = isDev ? DEV_API_PORT : Number(process.env.PORT ?? DEV_API_PORT);

/**
 * Origens aceitas pelo Socket.IO. Uma lista, não um valor: publicar costuma
 * envolver dois endereços ao mesmo tempo (o domínio e o túnel) e trocar de um pro
 * outro derrubaria quem estivesse no antigo.
 */
const allowedOrigins = (process.env.ORIGIN ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

/**
 * Em desenvolvimento a origem é livre: quem abre é o Vite, um túnel ou o celular
 * na rede local, e cada um chega com um endereço diferente. Em produção sem
 * `ORIGIN` a checagem por origem também fica aberta — não há como adivinhar o
 * endereço publicado — e é por isso que o boot avisa em voz alta. A autenticação
 * das contas continua obrigatória mesmo quando a origem não foi restringida.
 */
const originIsOpen = allowedOrigins.length === 0;

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
        "form-action": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "media-src": ["'self'", "blob:", "mediastream:"],
        "font-src": ["'self'", "data:"],
        "worker-src": ["'self'", "blob:"],
        "connect-src": ["'self'", "ws:", "wss:"],
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
    hsts: useHttps && !isDev,
  }),
);

app.use(express.json({ limit: "16kb" }));

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
const accountLimiter = new RateLimiter();

function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
}

function accountRoute(handler, { burst = 8, perSec = 0.2 } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    const key = `${req.ip}:${req.path}`;
    if (!accountLimiter.allow(key, burst, perSec)) {
      return res.status(429).json({ ok: false, error: "rate-limited" });
    }
    try {
      const result = await handler(req);
      const { detail: _detail, ...safe } = result;
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
  res.json({ auth: "accounts", emailReady: accountService.emailReady, guestInvites: true });
});

app.post("/api/auth/register", accountRoute((req) => accountService.register(req.body, req.ip)));
app.post("/api/auth/login", accountRoute((req) => accountService.login(req.body, req.ip)));
app.post("/api/auth/verify", accountRoute((req) => accountService.verifyEmail(req.body?.token)));
app.post(
  "/api/auth/login-address/confirm",
  accountRoute((req) => accountService.confirmLoginAddress(req.body?.token), {
    burst: 6,
    perSec: 0.1,
  }),
);
app.post(
  "/api/auth/password/request",
  accountRoute((req) => accountService.requestPassword(req.body?.email), { burst: 4, perSec: 0.03 }),
);
app.post(
  "/api/auth/password/change-request",
  accountRoute((req) => accountService.requestOwnPassword(bearer(req), req.ip), { burst: 4, perSec: 0.03 }),
);
app.post(
  "/api/auth/password/complete",
  accountRoute((req) => accountService.completePassword(req.body?.token, req.body?.password, req.ip)),
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
const FORCED_REFRESH_INTERVAL_MS = 60_000;
let lastForcedRefresh = 0;

app.get("/api/ice", async (req, res) => {
  try {
    if (req.query.refresh === "1" && Date.now() - lastForcedRefresh > FORCED_REFRESH_INTERVAL_MS) {
      lastForcedRefresh = Date.now();
      invalidateIceCache();
    }
    res.set("Cache-Control", "no-store").json(await resolveIceConfig());
  } catch (error) {
    logger("TURN").error("falha ao montar configuração", { motivo: reason(error) });
    res.status(500).json({ error: "ice-config-failed" });
  }
});

// Em produção o mesmo processo serve o front. Uma origem só: sem CORS, e o
// endereço do túnel funciona pra página e pro websocket ao mesmo tempo.
if (existsSync(distDir)) {
  app.use(express.static(distDir, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/socket.io")) {
      return next();
    }
    res.sendFile(join(distDir, "index.html"));
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
});

const adminBootstrap = await accountService.bootstrapSystemAdmin();
attachSignaling(io, process.env, { auth, accountService });

server.listen(port, "0.0.0.0", async () => {
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
  if (!isDev && originIsOpen) {
    console.log("  atenção        ·  ORIGIN vazio: qualquer site pode falar com este servidor");
  }
  console.log("");
});
