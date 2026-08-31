import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectStorage } from "../server/object-storage.js";
import { openDatabase } from "../server/data/database.js";
import { AccountRepository } from "../server/data/account-repository.js";
import { StateRepository } from "../server/data/state-repository.js";
import { AttachmentRepository } from "../server/data/attachment-repository.js";
import { PersistentRateLimiter } from "../server/security.js";

const storage = new ObjectStorage({
  OBJECT_STORAGE_ENDPOINT: "https://storage.example.test",
  OBJECT_STORAGE_BUCKET: "private-bucket",
  OBJECT_STORAGE_ACCESS_KEY_ID: "access-id",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret-value-that-must-not-leak",
  OBJECT_STORAGE_REGION: "auto",
});
assert.equal(storage.ready, true, "bucket privado não depende de URL pública");
assert.equal(storage.validate("imagem.png", "image/png", 1024).ok, true);
assert.equal(storage.validate("imagem.exe", "image/png", 1024).ok, false);
assert.equal(storage.validate("imagem.png", "image/png", 26 * 1024 * 1024).ok, false);
const signed = storage.downloadUrl("attachments/user/file.png", { expires: 60 });
assert.match(signed, /X-Amz-Signature=/u);
assert.equal(signed.includes("secret-value-that-must-not-leak"), false);

const database = openDatabase(":memory:");
try {
  const limiter = new PersistentRateLimiter(database);
  assert.equal(limiter.allow("opaque:login", 1, 0.01), true);
  assert.equal(limiter.allow("opaque:login", 1, 0.01), false);
  const afterRestart = new PersistentRateLimiter(database);
  assert.equal(afterRestart.allow("opaque:login", 1, 0.01), false, "reiniciar não zera o limite");

  const accounts = new AccountRepository(database);
  const state = new StateRepository(database);
  const userId = randomUUID();
  accounts.createAccount({
    userId,
    email: "storage@example.test",
    username: "Storage",
    passwordHash: "test",
    verifiedAt: Date.now(),
    color: "#5b6cff",
  });
  const guildId = "storage-guild";
  const channelId = "storage-channel";
  state.createGuild({
    id: guildId, ownerId: userId, name: "Storage", initials: "ST", color: "#5b6cff",
  }, [{ id: channelId, type: "text", name: "geral", category: "Canais de Texto" }]);
  const messageId = randomUUID();
  state.addMessage({
    id: messageId,
    channelId,
    authorId: userId,
    username: "Storage",
    color: "#5b6cff",
    content: "arquivo",
    replyToId: null,
    at: Date.now(),
  }, 5000);

  const temporaryStorage = { downloadUrl: (key) => `https://signed.example/${key}?expires=short` };
  const attachments = new AttachmentRepository(database, temporaryStorage, {
    OBJECT_STORAGE_USER_QUOTA_BYTES: "100",
  });
  const first = attachments.create({
    scope: "channel",
    messageId,
    ownerId: userId,
    filename: "one.png",
    mime: "image/png",
    size: 60,
    storageKey: "attachments/one.png",
  });
  assert.ok(first?.id);
  assert.equal(attachments.complete(first.id, userId), true);
  const blocked = attachments.create({
    scope: "channel",
    messageId,
    ownerId: userId,
    filename: "two.png",
    mime: "image/png",
    size: 50,
    storageKey: "attachments/two.png",
  });
  assert.deepEqual(blocked, { quotaExceeded: true });
  const listed = attachments.listFor("channel", [messageId]).get(messageId);
  assert.equal(listed.length, 1);
  assert.match(listed[0].url, /expires=short/u);
  assert.equal("storageKey" in listed[0] || "publicUrl" in listed[0], false);

  database.prepare("UPDATE attachments SET uploaded_at = NULL, created_at = 0 WHERE id = ?").run(first.id);
  assert.equal(attachments.expiredPending(Date.now(), 10)[0].storage_key, "attachments/one.png");
  assert.equal(attachments.removeExpired(first.id), true);
  assert.equal(
    attachments.queuedDeletions()[0].storage_key,
    "attachments/one.png",
    "a chave continua em fila durável até o bucket confirmar a exclusão",
  );
  console.log("storage privado, quota acumulada e limpeza de pendências: ok");
} finally {
  database.close();
}
