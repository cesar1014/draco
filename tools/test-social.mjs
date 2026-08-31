import assert from "node:assert/strict";
import { AccountRepository } from "../server/data/account-repository.js";
import { openDatabase } from "../server/data/database.js";
import { SocialRepository } from "../server/data/social-repository.js";

const database = openDatabase(":memory:");
const accounts = new AccountRepository(database);
const social = new SocialRepository(database);

const make = (publicId, displayName = publicId) => accounts.createAccount({
  userId: crypto.randomUUID(),
  email: `${publicId}@example.test`,
  publicId,
  displayName,
  passwordHash: "test",
  verifiedAt: Date.now(),
  color: "#6674E8",
});

const ana = make("ana", "Nome Repetido");
const bia = make("bia", "Nome Repetido");
const caio = make("caio");

assert.equal(social.targetByPublicId("ANA").id, ana.userId);
assert.equal(social.targetByPublicId("ana").displayName, "Nome Repetido");

assert.deepEqual(social.sendRequest(ana.userId, bia.userId), { ok: true });
assert.equal(social.sendRequest(ana.userId, bia.userId).error, "request-exists");
assert.equal(social.sendRequest(bia.userId, ana.userId).error, "request-awaiting-you");
assert.equal(social.relationshipSnapshot(bia.userId).incomingRequests[0].username, "ana");
assert.equal(social.relationshipSnapshot(bia.userId).incomingRequests[0].publicId, "ana");
assert.equal(social.relationshipSnapshot(bia.userId).incomingRequests[0].displayName, "Nome Repetido");
assert.deepEqual(social.acceptRequest(bia.userId, ana.userId), { ok: true, peerId: ana.userId });
assert.equal(social.areFriends(ana.userId, bia.userId), true);
assert.equal(database.prepare("SELECT COUNT(*) AS total FROM friendships").get().total, 1);

assert.equal(social.block(ana.userId, bia.userId), true);
assert.equal(social.areFriends(ana.userId, bia.userId), false);
assert.equal(social.sendRequest(bia.userId, ana.userId).error, "relationship-blocked");
assert.equal(social.unblock(ana.userId, bia.userId), true);

assert.deepEqual(social.sendRequest(caio.userId, ana.userId), { ok: true });
assert.equal(social.rejectRequest(ana.userId, caio.userId), true);
assert.equal(social.cancelRequest(caio.userId, ana.userId), false);

const profile = social.updatePresence(ana.userId, "away", "Volto já", Date.now() + 60_000);
assert.equal(profile.presenceMode, "away");
assert.equal(profile.customStatus, "Volto já");

database.exec(`
  INSERT INTO guilds (id, owner_id, name, initials, color, created_at, updated_at)
  VALUES ('g-social', '${ana.userId}', 'Social', 'SO', '#6674E8', 1, 1);
  INSERT INTO guild_members (guild_id, user_id, joined_at, updated_at)
  VALUES ('g-social', '${ana.userId}', 1, 1), ('g-social', '${bia.userId}', 1, 1);
  INSERT INTO channels (id, guild_id, type, name, category, created_at, updated_at)
  VALUES ('c-social', 'g-social', 'text', 'geral', 'Texto', 1, 1);
  INSERT INTO messages (id, channel_id, author_id, username_snapshot, color_snapshot, content, created_at)
  VALUES ('m-social', 'c-social', '${ana.userId}', 'ana', '#6674E8', '@bia oi', 1);
`);
const mention = social.recordMentions("m-social", "g-social", "@bia oi", { authorId: ana.userId });
assert.deepEqual(mention.userIds, [bia.userId]);
social.incrementMention(bia.userId, "channel", "c-social");
const unread = social.unreadSnapshot(bia.userId, new Set(["c-social"]));
assert.equal(unread["channel:c-social"].unread, true);
assert.equal(unread["channel:c-social"].mentions, 1);
social.markRead(bia.userId, "channel", "c-social", 1);
assert.equal(social.unreadSnapshot(bia.userId, new Set(["c-social"]))["channel:c-social"].unread, false);

database.close();
console.log("amizades, bloqueios, presença, menções e unread: ok");
