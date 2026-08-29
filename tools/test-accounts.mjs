import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createAccountService } from "../server/accounts.js";
import { SessionAuthority } from "../server/auth.js";
import { createAccountRepository } from "../server/data/account-repository.js";

const directory = mkdtempSync(join(tmpdir(), "draco-accounts-"));
const databasePath = join(directory, "draco.sqlite");
const sent = [];

try {
  const repository = createAccountRepository({ databasePath });
  const service = createAccountService({
    repository,
    auth: new SessionAuthority("segredo-de-teste-com-pelo-menos-trinta-e-dois-caracteres"),
    mailer: { ready: true, send: async (mail) => sent.push(mail) },
    colorForName: () => "#5b6cff",
    env: { APP_URL: "https://draco.teste" },
  });

  assert.deepEqual(
    await service.register({ email: "ana@example.com", username: "Ana", password: "senha-super-segura" }),
    { ok: true },
  );
  assert.equal((await service.login({ email: "ana@example.com", password: "senha-super-segura" })).error, "email-unverified");
  assert.equal(sent.length, 1);
  const verifyToken = new URL(sent[0].action).searchParams.get("token");
  assert.deepEqual(await service.verifyEmail(verifyToken), { ok: true });

  const login = await service.login({ email: "ANA@example.com", password: "senha-super-segura" });
  assert.equal(login.ok, true);
  assert.equal(service.session(login.token)?.account.username, "Ana");
  assert.equal((await service.register({ email: "ana@example.com", username: "Outra", password: "senha-super-segura" })).error, "email-taken");

  assert.deepEqual(await service.requestOwnPassword(login.token), { ok: true });
  const resetToken = new URL(sent.at(-1).action).searchParams.get("token");
  const changed = await service.completePassword(resetToken, "outra-senha-segura");
  assert.equal(changed.ok, true);
  assert.equal(service.session(login.token), null, "trocar a senha revoga sessões antigas");
  assert.equal((await service.login({ email: "ana@example.com", password: "outra-senha-segura" })).ok, true);

  const id = changed.account.id;
  const thread = repository.createOrFindThread(id, id);
  repository.addDirectMessage(thread, id, "nota para mim");
  assert.equal(repository.listThreads(id)[0].peer.id, id);
  assert.equal(repository.listDirectMessages(thread)[0].content, "nota para mim");
  repository.close();
  console.log("contas, troca de senha e mensagem para si: ok");
} finally {
  const temporaryRoot = resolve(tmpdir());
  const target = resolve(directory);
  if (resolve(dirname(target)) === temporaryRoot && basename(target).startsWith("draco-accounts-")) {
    rmSync(target, { recursive: true, force: true });
  }
}
