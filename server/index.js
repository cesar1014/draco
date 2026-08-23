import "dotenv/config";
import express from "express";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { Server as SocketServer } from "socket.io";
import { DEV_API_PORT, DEV_WEB_PORT } from "../shared/ports.js";
import { resolveIceConfig } from "./ice.js";
import { attachSignaling } from "./signaling.js";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const certsDir = join(here, "certs");

const useHttps = process.argv.includes("--https");

/**
 * `--dev` significa "estou atrás do proxy do Vite": use a porta combinada em
 * `shared/ports.js` e ignore qualquer `PORT` do ambiente. Ignorar é o ponto —
 * quem roda o dev pode ter um `PORT` herdado destinado ao servidor da página, e
 * a sinalização subiria na mesma porta que o Vite, deixando o proxy apontando
 * pro vazio. Sem `--dev` (produção) manda o `PORT` da plataforma de deploy.
 */
const isDev = process.argv.includes("--dev");
const port = isDev ? DEV_API_PORT : Number(process.env.PORT ?? DEV_API_PORT);
const origin = process.env.ORIGIN?.trim() || null;

/** Endereços IPv4 da máquina na rede local — pra imprimir link que o celular abre. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface.address);
}

/**
 * Certificado autoassinado pra rede local. Navegador só libera câmera e
 * microfone em origem segura, e `localhost` é a única exceção — então testar no
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
  console.log(`[certs] certificado autoassinado gerado em ${certsDir}`);
  return { key: pems.private, cert: pems.cert };
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

/** O cliente pergunta se precisa de senha antes de mostrar o campo na tela de entrada. */
app.get("/api/config", (_req, res) => {
  res.json({ requiresPassword: Boolean(process.env.ROOM_PASSWORD) });
});

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

app.get("/api/ice", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store").json(await resolveIceConfig());
  } catch (error) {
    console.error("[ice] falha ao montar configuração:", error);
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
  cors: { origin: origin ?? true, methods: ["GET", "POST"] },
});
attachSignaling(io, process.env);

server.listen(port, "0.0.0.0", async () => {
  const scheme = credentials ? "https" : "http";
  const ice = await resolveIceConfig();

  console.log("");
  if (isDev) {
    console.log(`  abra no navegador  ·  http://localhost:${DEV_WEB_PORT}`);
    console.log(`  sinalização        ·  ${scheme}://localhost:${port}`);
    console.log(`  autoteste          ·  http://localhost:${DEV_WEB_PORT}/?selftest=1`);
  } else {
    console.log(`  Discord clone  ·  ${scheme}://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  na rede local  ·  ${scheme}://${ip}:${port}`);
    if (!existsSync(distDir)) {
      console.log(`  atenção        ·  sem 'dist/': rode 'npm run build' ou use 'npm run dev'`);
    }
  }
  console.log("");
  console.log(`  senha da sala  ·  ${process.env.ROOM_PASSWORD ? "configurada" : "nenhuma (link aberto)"}`);
  console.log(`  TURN           ·  ${ice.hasTurn ? `ativo (${ice.source})` : "ausente — só STUN"}`);
  if (ice.warning) console.log(`  atenção        ·  ${ice.warning}`);
  console.log("");
});
