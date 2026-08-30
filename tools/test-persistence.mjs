/**
 * Persistência: grava num processo, encerra, e confere que outro processo levanta
 * o mesmo estado. Em dois processos de verdade porque o defeito que importa aqui
 * (algo que só existia na memória) passa despercebido num teste que nunca reinicia.
 *
 *   node tools/test-persistence.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const scriptPath = fileURLToPath(import.meta.url);
const root = join(dirname(scriptPath), "..");
const stage = process.argv[2];
const userId = "11111111-1111-4111-8111-111111111111";
/** Mais que uma página, pra provar que o resto ficou no banco e volta por pedido. */
const TOTAL_MESSAGES = 130;

async function writeState() {
  const state = await import("../server/state.js");
  const { createSessionAuthority } = await import("../server/auth.js");
  const { member } = state.addMember("socket-before-restart", userId, "Perfil Persistente");

  // Não há servidor de demonstração: quem chega não é membro de nada, e o
  // primeiro servidor nasce de alguém criando. Os ids ficam guardados no banco
  // pra que a etapa de leitura os encontre sem inventar nome de canal.
  const guild = state.createGuild(userId, "Casa Persistida");
  const channels = state.snapshot(userId).channels.filter((item) => item.guildId === guild.id);
  const chat = channels.find((item) => item.type === "text");
  const call = channels.find((item) => item.type === "voice");
  const extra = state.createChannel(guild.id, "text", "avisos");
  state.writeSetting("teste:ids", { guildId: guild.id, chatId: chat.id, callId: call.id, extraId: extra.id });

  for (let index = 0; index < TOTAL_MESSAGES; index += 1) {
    state.addMessage(chat.id, member, `mensagem-${index}`);
  }
  state.removeMember("socket-before-restart");

  // Um token emitido antes do reinício. Ele é a prova de que o segredo de
  // assinatura ficou guardado: se cada boot sorteasse outro, todo deploy
  // deslogaria todo mundo.
  const { auth, source } = createSessionAuthority(state, { SESSION_SECRET: "" });
  assert.equal(source, "generated", "o primeiro boot sorteia o segredo");
  state.writeSetting("teste:token", auth.issue(userId).token);

  // Renomear direto no banco: uma edição de canal não pode ser silenciosamente
  // desfeita pelo boot seguinte.
  const database = new Database(process.env.DATABASE_PATH);
  database.prepare("UPDATE guilds SET name = ? WHERE id = ?").run("Servidor Persistido", guild.id);
  database.prepare("UPDATE channels SET name = ? WHERE id = ?").run("geral-persistido", chat.id);
  database.prepare("DELETE FROM channels WHERE id = ?").run(extra.id);
  database.close();
}

async function readState() {
  const state = await import("../server/state.js");
  const { createSessionAuthority } = await import("../server/auth.js");
  const { MESSAGE_PAGE } = state;
  const { guildId, chatId, callId, extraId } = state.readSetting("teste:ids");
  // O snapshot é por pessoa: cada uma recebe só os servidores de que é membro.
  const current = state.snapshot(userId);
  const recent = current.messages[chatId];

  assert.equal(current.members.length, 0, "presença não sobrevive a um reinício");
  assert.equal(current.guilds.find((guild) => guild.id === guildId)?.name, "Servidor Persistido");
  assert.equal(current.guilds.length, 1, "e ela é membro só do servidor que criou");
  assert.equal(current.channels.find((channel) => channel.id === chatId)?.name, "geral-persistido");
  assert.ok(
    !current.channels.some((channel) => channel.id === extraId),
    "canal apagado não volta no boot seguinte",
  );

  // Ninguém mais: outro perfil que chegasse depois começaria sem servidor nenhum.
  const stranger = "22222222-2222-4222-8222-222222222222";
  state.addMember("socket-stranger", stranger, "Quem Acabou de Chegar");
  assert.deepEqual(
    [state.snapshot(stranger).guilds, state.snapshot(stranger).channels],
    [[], []],
    "quem entra pela primeira vez não herda o servidor de ninguém",
  );
  state.removeMember("socket-stranger");

  const { auth, source } = createSessionAuthority(state, { SESSION_SECRET: "" });
  assert.equal(source, "stored", "o segundo boot reaproveita o segredo guardado");
  const token = state.readSetting("teste:token");
  assert.equal(auth.verify(token)?.userId, userId, "token de antes do reinício continua válido");
  assert.equal(auth.verify(`${token}x`), null, "assinatura alterada é recusada");

  assert.equal(recent.length, MESSAGE_PAGE);
  assert.equal(recent[0].content, `mensagem-${TOTAL_MESSAGES - MESSAGE_PAGE}`);
  assert.equal(recent.at(-1).content, `mensagem-${TOTAL_MESSAGES - 1}`);
  assert.ok(recent.every((message) => message.authorId === userId));
  assert.equal(current.history[chatId], true, "o snapshot avisa que há conversa anterior");
  assert.ok(!(extraId in current.history), "canal sem passado não entra no aviso");

  // Paginando até o começo: cada página emenda na anterior, sem repetir nem pular.
  let cursor = recent[0].id;
  const older = [];
  for (let request = 0; request < 10; request += 1) {
    const page = state.loadHistory(chatId, cursor);
    assert.ok(page, "a página anterior existe enquanto o servidor avisa que há mais");
    older.unshift(...page.messages);
    cursor = page.messages[0].id;
    if (!page.more) break;
  }

  const rebuilt = [...older, ...recent].map((message) => message.content);
  assert.equal(rebuilt.length, TOTAL_MESSAGES, "a conversa inteira volta pelas páginas");
  assert.deepEqual(
    rebuilt,
    Array.from({ length: TOTAL_MESSAGES }, (_, index) => `mensagem-${index}`),
    "as páginas remontam a conversa na ordem original",
  );
  assert.equal(state.loadHistory(chatId, "nao-existe"), null);
  assert.equal(state.loadHistory(callId, recent[0].id), null, "id de outro canal é recusado");

  const database = new Database(process.env.DATABASE_PATH, { readonly: true });
  const profile = database.prepare("SELECT username FROM profiles WHERE user_id = ?").get(userId);
  const memberships = database
    .prepare("SELECT COUNT(*) AS total FROM guild_members WHERE user_id = ?")
    .get(userId).total;
  const defaultRoles = database.prepare("SELECT COUNT(*) AS total FROM roles WHERE is_default = 1").get().total;
  const migrations = database.prepare("SELECT COUNT(*) AS total FROM schema_migrations").get().total;
  const stored = database
    .prepare("SELECT COUNT(*) AS total FROM messages WHERE channel_id = ?")
    .get(chatId).total;
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  database.close();

  assert.equal(profile.username, "Perfil Persistente");
  assert.equal(memberships, current.guilds.length, "o perfil é membro só do que criou");
  assert.equal(defaultRoles, current.guilds.length, "cada servidor tem um cargo padrão");
  // Contado a partir dos arquivos, pra uma migration nova não quebrar o teste.
  assert.equal(migrations, readdirSync(join(root, "server", "data", "migrations")).length);
  assert.equal(stored, TOTAL_MESSAGES, "o banco guarda além da página recente");
  assert.deepEqual(tables, [
    "account_login_challenges",
    "account_tokens",
    "account_trusted_addresses",
    "accounts",
    "app_settings",
    "bans",
    "channel_permission_overwrites",
    "channels",
    "direct_messages",
    "direct_participants",
    "direct_threads",
    "guild_member_roles",
    "guild_members",
    "guild_settings",
    "guilds",
    "invites",
    "messages",
    "profiles",
    "roles",
    "schema_migrations",
    "user_settings",
    "users",
  ]);
}

/**
 * O banco de quem já rodou as versões antigas tem os servidores do catálogo
 * padrão: sem dono, e por isso sem ninguém que os administre. A migration os
 * adota em vez de apagá-los — o dono passa a ser quem entrou primeiro, que é quem
 * já estava usando aquele servidor.
 *
 * Reaplicar a migration é o jeito de exercitá-la sem carregar um arquivo de banco
 * antigo no repositório: monta-se o estado de antes e apaga-se a linha que diz que
 * ela já rodou.
 */
async function migrateLegacy(databasePath) {
  const { openDatabase } = await import("../server/data/database.js");
  const now = Date.now();
  const first = "33333333-3333-4333-8333-333333333333";
  const second = "44444444-4444-4444-8444-444444444444";

  const before = openDatabase(databasePath);
  const insertPerson = before.prepare(`
    INSERT INTO users (id, created_at, updated_at) VALUES (?, ?, ?)
  `);
  const insertProfile = before.prepare(`
    INSERT INTO profiles (user_id, username, color, updated_at) VALUES (?, ?, '#5b6cff', ?)
  `);
  const insertMember = before.prepare(`
    INSERT INTO guild_members (guild_id, user_id, joined_at, updated_at) VALUES ('g-main', ?, ?, ?)
  `);
  before
    .prepare(
      `INSERT INTO guilds (id, name, initials, color, position, created_at, updated_at)
       VALUES ('g-main', 'Meu Servidor', 'MS', '#5b6cff', 0, ?, ?)`,
    )
    .run(now, now);
  // Quem entrou depois, gravado antes: a adoção tem que olhar `joined_at`, e não a
  // ordem em que as linhas foram inseridas.
  insertPerson.run(second, now, now);
  insertProfile.run(second, "Depois", now);
  insertMember.run(second, now + 1000, now);
  insertPerson.run(first, now, now);
  insertProfile.run(first, "Primeiro", now);
  insertMember.run(first, now, now);
  before
    .prepare("INSERT INTO app_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)")
    .run("catalog:seeded_at", String(now), now);
  before.prepare("DELETE FROM schema_migrations WHERE name = ?").run("003_no_default_guilds.sql");
  before.close();

  const after = openDatabase(databasePath);
  const guild = after.prepare("SELECT owner_id FROM guilds WHERE id = 'g-main'").get();
  const seeded = after
    .prepare("SELECT value_json FROM app_settings WHERE setting_key = 'catalog:seeded_at'")
    .get();
  const members = after
    .prepare("SELECT COUNT(*) AS total FROM guild_members WHERE guild_id = 'g-main'")
    .get().total;
  after.close();

  assert.equal(guild.owner_id, first, "o servidor sem dono é adotado por quem entrou primeiro");
  assert.equal(members, 2, "e ninguém é removido do servidor no caminho");
  assert.equal(seeded, undefined, "a marca do seed sai: não há mais catálogo a semear");
}

if (stage === "write") {
  await writeState();
} else if (stage === "read") {
  await readState();
} else if (stage === "legacy") {
  await migrateLegacy(process.env.DATABASE_PATH);
} else {
  const testDirectory = mkdtempSync(join(tmpdir(), "draco-persistence-"));
  const databasePath = join(testDirectory, "draco.sqlite");

  try {
    for (const childStage of ["write", "read", "legacy"]) {
      const result = spawnSync(process.execPath, [scriptPath, childStage], {
        cwd: root,
        env: { ...process.env, DATABASE_PATH: databasePath },
        encoding: "utf8",
      });
      if (result.status !== 0) {
        const detail = result.error?.stack ?? `${result.stdout ?? ""}${result.stderr ?? ""}`;
        throw new Error(`etapa ${childStage} falhou com código ${result.status}\n${detail}`);
      }
    }
    console.log("persistência SQLite: ok");
  } finally {
    // Confere o caminho antes de apagar recursivamente: um `DATABASE_PATH` herdado
    // do ambiente apontaria pro banco de verdade.
    const temporaryRoot = resolve(tmpdir());
    const resolvedDirectory = resolve(testDirectory);
    if (
      resolve(dirname(resolvedDirectory)) === temporaryRoot &&
      basename(resolvedDirectory).startsWith("draco-persistence-")
    ) {
      rmSync(resolvedDirectory, { recursive: true, force: true });
    }
  }
}
