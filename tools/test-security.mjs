/** Verificações HTTP de segurança contra um servidor isolado e descartável. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "draco-security-"));
const port = 4001;
const base = `http://127.0.0.1:${port}`;
const fetch = (input, init = {}) => globalThis.fetch(input, {
  ...init,
  headers: { ...init.headers, "x-forwarded-proto": "https" },
});
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "production",
    ORIGIN: "https://dracocall.duckdns.org",
    APP_URL: "https://dracocall.duckdns.org",
    TRUSTED_PROXY: "1",
    DATABASE_PATH: join(temporary, "security.sqlite"),
    SESSION_SECRET: "segredo-isolado-do-teste-de-seguranca-123456789",
    DATA_ENCRYPTION_KEY: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
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
  const rejectedBoot = spawnSync(process.execPath, ["server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      ORIGIN: "",
      APP_URL: "",
      DATABASE_PATH: join(temporary, "rejected.sqlite"),
      SESSION_SECRET: "segredo-isolado-do-teste-de-seguranca-123456789",
      DATA_ENCRYPTION_KEY: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    },
    encoding: "utf8",
  });
  assert.notEqual(rejectedBoot.status, 0, "produção sem ORIGIN recusa o boot");
  assert.match(`${rejectedBoot.stdout}${rejectedBoot.stderr}`, /ORIGIN.+obrigatória/iu);

  await waitUntilReady();

  const redirected = await globalThis.fetch(base, { redirect: "manual" });
  assert.equal(redirected.status, 308, "GET HTTP é redirecionado antes de servir conteúdo");
  assert.equal(redirected.headers.get("location"), "https://dracocall.duckdns.org/");
  const insecureWrite = await globalThis.fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(insecureWrite.status, 426, "corpo de autenticação nunca é redirecionado por HTTP");

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

  const cookieReply = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.test", password: "Senha-Incorreta" }),
  });
  const deviceCookie = cookieReply.headers.get("set-cookie") ?? "";
  assert.match(deviceCookie, /draco_device=/u);
  assert.match(deviceCookie, /HttpOnly/iu);
  assert.match(deviceCookie, /Secure/iu);
  assert.match(deviceCookie, /SameSite=Strict/iu);
  const cookieBody = await cookieReply.json();
  assert.equal("token" in cookieBody || "deviceToken" in cookieBody, false);

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
