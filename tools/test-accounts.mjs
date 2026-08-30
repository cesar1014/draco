import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createAccountService } from "../server/accounts.js";
import { SessionAuthority } from "../server/auth.js";
import { createAccountRepository } from "../server/data/account-repository.js";
import { hashActionToken, validPassword } from "../server/passwords.js";

const directory = mkdtempSync(join(tmpdir(), "draco-accounts-"));
const databasePath = join(directory, "draco.sqlite");
const sent = [];
const IP_A = "203.0.113.10";
const IP_B = "198.51.100.25";
const IP_C = "2001:db8::77";

try {
  assert.equal(validPassword("SenhaAb"), false, "sete caracteres não bastam");
  assert.equal(validPassword("senhafraca"), false, "uma maiúscula é obrigatória");
  assert.equal(validPassword("SENHAFRACA"), false, "uma minúscula é obrigatória");
  assert.equal(validPassword("Senha123"), true, "oito caracteres com maiúscula e minúscula bastam");

  const repository = createAccountRepository({ databasePath });
  const service = createAccountService({
    repository,
    auth: new SessionAuthority("segredo-de-teste-com-pelo-menos-trinta-e-dois-caracteres"),
    mailer: { ready: true, send: async (mail) => sent.push(mail) },
    colorForName: () => "#5b6cff",
    env: { APP_URL: "https://draco.teste" },
  });

  assert.deepEqual(
    await service.register(
      {
        email: "fraca@example.com",
        username: "Fraca",
        age: 18,
        password: "senhafraca",
        passwordConfirmation: "senhafraca",
      },
      IP_A,
    ),
    { ok: false, error: "bad-password-format" },
  );

  assert.deepEqual(
    await service.register(
      {
        email: "menor@example.com",
        username: "Menor",
        age: 17,
        password: "Senha-super-segura",
        passwordConfirmation: "Senha-super-segura",
      },
      IP_A,
    ),
    { ok: false, error: "adult-required" },
  );
  assert.deepEqual(
    await service.register(
      {
        email: "ana@example.com",
        username: "Ana",
        age: 18,
        password: "Senha-super-segura",
        passwordConfirmation: "Senha-diferente-aqui",
      },
      IP_A,
    ),
    { ok: false, error: "password-mismatch" },
  );
  assert.deepEqual(
    await service.register(
      {
        email: "ana@example.com",
        username: "Ana",
        age: 18,
        password: "Senha-super-segura",
        passwordConfirmation: "Senha-super-segura",
      },
      IP_A,
    ),
    { ok: true },
  );
  const storedPassword = repository.accountByEmail("ana@example.com").passwordHash;
  assert.match(storedPassword, /^scrypt\$32768\$8\$3\$/u, "o banco recebe o custo scrypt oficial");
  assert.equal(storedPassword.includes("Senha-super-segura"), false, "o banco não recebe a senha original");
  assert.equal(
    (await service.login({ email: "ana@example.com", password: "Senha-super-segura" }, IP_A)).error,
    "email-verification-sent",
  );
  assert.equal(sent.length, 2, "o login não confirmado reenvia um link novo");
  const verifyToken = new URL(sent.at(-1).action).searchParams.get("token");
  assert.deepEqual(await service.verifyEmail(verifyToken, IP_A), { ok: true });

  const login = await service.login(
    { email: "ANA@example.com", password: "Senha-super-segura" },
    IP_A,
  );
  assert.equal(login.ok, true);
  assert.equal(service.session(login.token, IP_A)?.account.username, "Ana");
  assert.equal(
    (await service.register(
      {
        email: "ana@example.com",
        username: "Outra",
        age: 30,
        password: "Senha-super-segura",
        passwordConfirmation: "Senha-super-segura",
      },
      IP_A,
    )).error,
    "email-taken",
  );

  const unknownAddress = await service.login(
    { email: "ana@example.com", password: "Senha-super-segura" },
    IP_B,
  );
  assert.equal(unknownAddress.error, "new-ip-verification-sent");
  assert.equal(service.session(login.token, IP_B), null, "sessão copiada não funciona em IP novo");
  const addressMail = sent.at(-1);
  assert.equal(new URL(addressMail.action).searchParams.get("conta"), "novo-ip");
  assert.match(addressMail.text, new RegExp(IP_B.replaceAll(".", "\\.")));
  const addressToken = new URL(addressMail.action).searchParams.get("token");
  assert.deepEqual(service.confirmLoginAddress(addressToken), { ok: true });
  assert.deepEqual(service.confirmLoginAddress(addressToken), { ok: false, error: "token-invalid" });
  const loginFromB = await service.login(
    { email: "ana@example.com", password: "Senha-super-segura" },
    IP_B,
  );
  assert.equal(loginFromB.ok, true);
  assert.equal(service.session(loginFromB.token, IP_B)?.account.username, "Ana");
  assert.equal(service.session(loginFromB.token, IP_C), null);
  const connected = service.listSessions(login.token, IP_A);
  assert.equal(connected.ok, true);
  assert.equal(connected.sessions.length >= 2, true, "lista dispositivos conectados sem fingerprint invasivo");
  const otherSession = connected.sessions.find((session) => session.id !== connected.currentSessionId);
  assert.equal(service.revokeSession(login.token, IP_A, otherSession.id).ok, true);
  assert.equal(service.session(loginFromB.token, IP_B), null, "encerrar um dispositivo revoga só aquela sessão");
  assert.equal(
    repository.database
      .prepare("SELECT address_hash FROM account_trusted_addresses WHERE user_id = ? LIMIT 1")
      .get(login.account.id).address_hash.includes(IP_A),
    false,
    "o banco não guarda o IP em texto puro",
  );
  repository.createLoginChallenge({
    tokenHash: hashActionToken("desafio-expirado"),
    userId: login.account.id,
    addressHash: new SessionAuthority(
      "segredo-de-teste-com-pelo-menos-trinta-e-dois-caracteres",
    ).fingerprintAddress(IP_C),
    expiresAt: Date.now() - 1,
  });
  assert.deepEqual(service.confirmLoginAddress("desafio-expirado"), {
    ok: false,
    error: "token-invalid",
  });

  assert.deepEqual(await service.requestOwnPassword(login.token, IP_A), { ok: true });
  const resetToken = new URL(sent.at(-1).action).searchParams.get("token");
  assert.deepEqual(await service.completePassword(resetToken, "outra-senha-segura", IP_C), {
    ok: false,
    error: "bad-password-format",
  });
  const changed = await service.completePassword(resetToken, "Outra-senha-segura", IP_C);
  assert.equal(changed.ok, true);
  assert.equal(service.session(login.token, IP_A), null, "trocar a senha revoga sessões antigas");
  assert.equal(service.session(changed.token, IP_C)?.account.username, "Ana");
  assert.equal(
    (await service.login({ email: "ana@example.com", password: "Outra-senha-segura" }, IP_A)).ok,
    true,
  );

  const id = changed.account.id;
  const thread = repository.createOrFindThread(id, id);
  repository.addDirectMessage(thread, id, "nota para mim");
  assert.equal(repository.listThreads(id)[0].peer.id, id);
  assert.equal(repository.listDirectMessages(thread)[0].content, "nota para mim");
  repository.close();
  console.log("contas, IP confiável, troca de senha e mensagem para si: ok");
} finally {
  const temporaryRoot = resolve(tmpdir());
  const target = resolve(directory);
  if (resolve(dirname(target)) === temporaryRoot && basename(target).startsWith("draco-accounts-")) {
    rmSync(target, { recursive: true, force: true });
  }
}
