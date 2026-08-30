/** Verificações HTTP de segurança contra um servidor isolado e descartável. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "draco-security-"));
const port = 4001;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    ORIGIN: "https://dracocall.duckdns.org",
    DATABASE_PATH: join(temporary, "security.sqlite"),
    SESSION_SECRET: "segredo-isolado-do-teste-de-seguranca-123456789",
    SYSTEM_ADMIN_EMAIL: "desativado",
    SYSTEM_ADMIN_USERNAME: "desativado",
    SMTP_HOST: "",
    SMTP_USER: "",
    SMTP_PASS: "",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitUntilReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/config`);
      if (response.ok) return;
    } catch {
      // Ainda subindo.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("servidor de segurança não subiu");
}

try {
  await waitUntilReady();

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  assert.match(page.headers.get("strict-transport-security") ?? "", /max-age=/u);
  assert.match(page.headers.get("permissions-policy") ?? "", /camera=\(self\)/u);
  assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(page.headers.get("x-powered-by"), null);
  assert.equal(page.headers.get("cache-control"), "no-store");

  const ice = await fetch(`${base}/api/ice`);
  assert.equal(ice.status, 401, "TURN não pode ser colhido sem identificação");

  const noType = await fetch(`${base}/api/auth/login`, { method: "POST", body: "{}" });
  assert.equal(noType.status, 415);

  const malformed = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);

  const array = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "[]",
  });
  assert.equal(array.status, 400);

  const tooLarge = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(17_000) }),
  });
  assert.equal(tooLarge.status, 413);

  const foreign = await fetch(`${base}/api/config`, {
    headers: { origin: "https://example.invalid" },
  });
  assert.equal(foreign.status, 403);

  console.log("HTTP: CSP/HSTS/permissões, origem, JSON, tamanho e ICE autenticado: ok");
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await stopped;
  }
  rmSync(temporary, { recursive: true, force: true });
}
