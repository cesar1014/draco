import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createAccountService } from "../server/accounts.js";
import { SessionAuthority } from "../server/auth.js";
import { createAccountRepository } from "../server/data/account-repository.js";
import { hashActionToken, hashPassword, validPassword } from "../server/passwords.js";

const directory = mkdtempSync(join(tmpdir(), "draco-accounts-"));
const databasePath = join(directory, "draco.sqlite");
const sent = [];
const IP_A = "203.0.113.10";
const IP_A_MAPPED = "::ffff:203.0.113.10";
const IP_B = "198.51.100.25";
const IP_V6 = "2001:db8::77";
const headers = { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0" };
let repository;

const mailToken = () => new URL(sent.at(-1).action).searchParams.get("token");

try {
  assert.equal(validPassword("SenhaAb"), false);
  assert.equal(validPassword("senhafraca"), false);
  assert.equal(validPassword("SENHAFRACA"), false);
  assert.equal(validPassword("Senha123"), true);

  repository = createAccountRepository({ databasePath });
  const authority = new SessionAuthority("segredo-de-teste-com-pelo-menos-trinta-e-dois-caracteres");
  const service = createAccountService({
    repository,
    auth: authority,
    mailer: { ready: true, send: async (mail) => sent.push(mail) },
    colorForName: () => "#5b6cff",
    env: { APP_URL: "https://draco.teste" },
  });

  assert.deepEqual(await service.register({
    email: "ana@example.com", username: "Ana", age: 17,
    password: "Senha-super-segura", passwordConfirmation: "Senha-super-segura",
  }, IP_A), { ok: false, error: "adult-required" });
  assert.deepEqual(await service.register({
    email: "ana@example.com", username: "Ana", age: 18,
    password: "Senha-super-segura", passwordConfirmation: "Senha-diferente-aqui",
  }, IP_A), { ok: false, error: "password-mismatch" });
  assert.deepEqual(await service.register({
    email: "ana@example.com", username: "Ana", age: 18,
    password: "Senha-super-segura", passwordConfirmation: "Senha-super-segura",
  }, IP_A), { ok: true });

  const storedPassword = repository.accountByEmail("ana@example.com").passwordHash;
  assert.match(storedPassword, /^scrypt\$32768\$8\$3\$/u);
  assert.equal(storedPassword.includes("Senha-super-segura"), false);
  assert.equal((await service.login({ email: "ana@example.com", password: "Senha-super-segura" }, IP_A)).error, "email-verification-sent");
  assert.deepEqual(await service.verifyEmail(mailToken(), IP_A), { ok: true });

  const first = await service.login({ email: "ANA@example.com", password: "Senha-super-segura" }, IP_A, headers);
  assert.equal(first.ok, true, "o primeiro login autoriza o primeiro dispositivo");
  assert.ok(first.deviceToken);
  assert.equal(service.session(first.token, IP_A)?.account.username, "Ana");
  assert.equal(service.session(first.token, IP_B)?.account.username, "Ana", "a sessão não depende do IP atual");
  assert.equal(service.session(first.token, IP_V6)?.account.username, "Ana", "IPv4 para IPv6 preserva a sessão");
  assert.equal(service.session(first.token, IP_A_MAPPED)?.account.username, "Ana", "IPv4 mapeado é aceito como metadata");
  assert.equal(service.session("token-inválido", IP_A), null);

  const mailCount = sent.length;
  const sameDevice = await service.login({
    email: "ana@example.com", password: "Senha-super-segura", deviceToken: first.deviceToken,
  }, IP_V6, headers);
  assert.equal(sameDevice.ok, true, "o mesmo dispositivo entra após mudança de IP");
  assert.equal(sent.length, mailCount, "mudança normal de IP não envia confirmação");
  assert.equal(service.session(sameDevice.token, IP_A)?.account.username, "Ana", "IPv6 para IPv4 também preserva a sessão");

  const unknown = await service.login({ email: "ana@example.com", password: "Senha-super-segura" }, IP_B, headers);
  assert.equal(unknown.error, "new-device-verification-sent");
  assert.ok(unknown.deviceToken, "a credencial pendente só volta ao aparelho que iniciou o login");
  const deviceMail = sent.at(-1);
  assert.equal(new URL(deviceMail.action).searchParams.get("conta"), "novo-dispositivo");
  assert.match(deviceMail.text, new RegExp(IP_B.replaceAll(".", "\\.")));
  const confirmation = mailToken();
  assert.deepEqual(service.confirmLoginAddress(confirmation), { ok: true });
  assert.deepEqual(service.confirmLoginAddress(confirmation), { ok: false, error: "token-invalid" });

  const second = await service.login({
    email: "ana@example.com", password: "Senha-super-segura", deviceToken: unknown.deviceToken,
  }, IP_B, headers);
  assert.equal(second.ok, true, "o dispositivo confirmado entra");
  assert.equal(service.session(second.token, IP_A)?.account.username, "Ana");
  let connected = service.listSessions(second.token, IP_V6);
  assert.equal(connected.sessions.length, 2);
  const currentDeviceId = connected.sessions.find((item) => item.id === connected.currentSessionId).deviceId;
  const firstSession = connected.sessions.find((entry) => entry.deviceId !== currentDeviceId);
  assert.equal(service.revokeSession(second.token, IP_B, firstSession.id).ok, true);
  assert.equal(service.session(sameDevice.token, IP_A), null, "revogar o dispositivo encerra suas sessões");
  const revoked = await service.login({
    email: "ana@example.com", password: "Senha-super-segura", deviceToken: first.deviceToken,
  }, IP_A, headers);
  assert.equal(revoked.error, "new-device-verification-sent", "a credencial revogada não recupera confiança");
  const challengeBeforePasswordChange = mailToken();

  assert.deepEqual(service.logout(second.token, IP_B), { ok: true });
  assert.equal(service.session(second.token, IP_B), null, "logout encerra a sessão atual");
  const afterLogout = await service.login({
    email: "ana@example.com", password: "Senha-super-segura", deviceToken: unknown.deviceToken,
  }, IP_A, headers);
  assert.equal(afterLogout.ok, true, "logout preserva a autorização do dispositivo");

  repository.database.prepare("UPDATE account_sessions SET expires_at = ? WHERE id = ?").run(Date.now() - 1, authority.verify(afterLogout.token).sessionId);
  assert.equal(service.session(afterLogout.token, IP_A), null, "sessão expirada é recusada");
  const afterExpiry = await service.login({
    email: "ana@example.com", password: "Senha-super-segura", deviceToken: unknown.deviceToken,
  }, IP_V6, headers);
  assert.equal(afterExpiry.ok, true, "o dispositivo ainda autorizado pode criar sessão nova");

  assert.deepEqual(await service.register({
    email: "bia@example.com", username: "Bia", age: 25,
    password: "Senha-da-Bia", passwordConfirmation: "Senha-da-Bia",
  }, IP_A), { ok: true });
  assert.deepEqual(await service.verifyEmail(mailToken(), IP_A), { ok: true });
  const bia = await service.login({ email: "bia@example.com", password: "Senha-da-Bia" }, IP_A, headers);
  assert.equal(bia.ok, true);
  const crossAccount = await service.login({
    email: "bia@example.com", password: "Senha-da-Bia", deviceToken: unknown.deviceToken,
  }, IP_A, headers);
  assert.equal(crossAccount.error, "new-device-verification-sent", "credencial de outra conta nunca é confiável");

  assert.deepEqual(await service.requestOwnPassword(afterExpiry.token, IP_A), { ok: true });
  const resetToken = mailToken();
  const changed = await service.completePassword(resetToken, "Outra-senha-segura", IP_V6, headers);
  assert.equal(changed.ok, true);
  assert.ok(changed.deviceToken);
  assert.equal(service.session(afterExpiry.token, IP_A), null, "trocar a senha revoga sessões antigas");
  assert.equal(service.session(changed.token, IP_A)?.account.username, "Ana");
  assert.deepEqual(service.confirmLoginAddress(challengeBeforePasswordChange), { ok: false, error: "token-invalid" }, "troca de senha invalida confirmações pendentes");
  assert.equal((await service.login({
    email: "ana@example.com", password: "Outra-senha-segura", deviceToken: unknown.deviceToken,
  }, IP_A, headers)).error, "new-device-verification-sent", "troca de senha revoga dispositivos anteriores");

  const pendingBeforeRevokeAll = mailToken();
  service.revokeAllSessions(changed.token, IP_A);
  assert.equal(service.session(changed.token, IP_A), null, "sair de todos invalida a sessão atual");
  assert.equal((await service.login({
    email: "ana@example.com", password: "Outra-senha-segura", deviceToken: changed.deviceToken,
  }, IP_A, headers)).error, "new-device-verification-sent", "sair de todos revoga a confiança dos dispositivos");
  assert.deepEqual(service.confirmLoginAddress(pendingBeforeRevokeAll), { ok: false, error: "token-invalid" }, "sair de todos invalida confirmações pendentes");

  assert.equal(
    repository.database.prepare("SELECT last_address_hash FROM account_devices WHERE user_id = ? LIMIT 1").get(first.account.id).last_address_hash.includes(IP_A),
    false,
    "o banco não guarda IP em texto puro",
  );
  repository.createLoginChallenge({
    tokenHash: hashActionToken("desafio-expirado"),
    userId: first.account.id,
    addressHash: authority.fingerprintAddress(IP_V6),
    expiresAt: Date.now() - 1,
  });
  assert.deepEqual(service.confirmLoginAddress("desafio-expirado"), { ok: false, error: "token-invalid" });

  repository.createAccount({
    userId: crypto.randomUUID(),
    email: "admin@example.com",
    username: "AdminSeguro",
    passwordHash: await hashPassword("Senha-do-Admin"),
    verifiedAt: Date.now(),
    isSystemAdmin: true,
    color: "#5b6cff",
  });
  const adminLogin = await service.login({
    email: "admin@example.com", password: "Senha-do-Admin",
  }, IP_A, headers);
  assert.equal(
    adminLogin.error,
    "new-device-verification-sent",
    "administrador sem dispositivo nunca faz bootstrap somente com senha",
  );

  const id = changed.account.id;
  const thread = repository.createOrFindThread(id, id);
  repository.addDirectMessage(thread, id, "nota para mim");
  assert.equal(repository.listThreads(id)[0].peer.id, id);
  assert.equal(repository.listDirectMessages(thread)[0].content, "nota para mim");
  console.log("contas, dispositivos confiáveis, revogação e troca de senha: ok");
} finally {
  repository?.close();
  const temporaryRoot = resolve(tmpdir());
  const target = resolve(directory);
  if (resolve(dirname(target)) === temporaryRoot && basename(target).startsWith("draco-accounts-")) {
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  }
}
