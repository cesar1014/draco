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

  for (let index = 0; index < TOTAL_MESSAGES; index += 1) {
    state.addMessage("t-geral", member, `mensagem-${index}`);
  }
  state.removeMember("socket-before-restart");

  // Um token emitido antes do reinício. Ele é a prova de que o segredo de
  // assinatura ficou guardado: se cada boot sorteasse outro, todo deploy
  // deslogaria todo mundo.
  const { auth, source } = createSessionAuthority(state, { SESSION_SECRET: "" });
  assert.equal(source, "generated", "o primeiro boot sorteia o segredo");
  state.writeSetting("teste:token", auth.issue(userId).token);

  // Renomear direto no banco: se o catálogo fosse recriado do código a cada boot,
  // qualquer edição futura de canal seria silenciosamente desfeita.
  const database = new Database(process.env.DATABASE_PATH);
  database.prepare("UPDATE guilds SET name = ? WHERE id = ?").run("Servidor Persistido", "g-main");
  database.prepare("UPDATE channels SET name = ? WHERE id = ?").run("geral-persistido", "t-geral");
  database.prepare("DELETE FROM channels WHERE id = ?").run("t-avisos");
  database.close();
}

async function readState() {
  const state = await import("../server/state.js");
  const { createSessionAuthority } = await import("../server/auth.js");
  const { MESSAGE_PAGE } = state;
  const current = state.snapshot();
  const recent = current.messages["t-geral"];

  assert.equal(current.members.length, 0, "presença não sobrevive a um reinício");
  assert.equal(current.guilds.find((guild) => guild.id === "g-main")?.name, "Servidor Persistido");
  assert.equal(current.channels.find((channel) => channel.id === "t-geral")?.name, "geral-persistido");
  assert.ok(
    !current.channels.some((channel) => channel.id === "t-avisos"),
    "canal apagado não volta no boot seguinte",
  );

  const { auth, source } = createSessionAuthority(state, { SESSION_SECRET: "" });
  assert.equal(source, "stored", "o segundo boot reaproveita o segredo guardado");
  const token = state.readSetting("teste:token");
  assert.equal(auth.verify(token)?.userId, userId, "token de antes do reinício continua válido");
  assert.equal(auth.verify(`${token}x`), null, "assinatura alterada é recusada");

  assert.equal(recent.length, MESSAGE_PAGE);
  assert.equal(recent[0].content, `mensagem-${TOTAL_MESSAGES - MESSAGE_PAGE}`);
  assert.equal(recent.at(-1).content, `mensagem-${TOTAL_MESSAGES - 1}`);
  assert.ok(recent.every((message) => message.authorId === userId));
  assert.equal(current.history["t-geral"], true, "o snapshot avisa que há conversa anterior");
  assert.ok(!("t-avisos" in current.history), "canal sem passado não entra no aviso");

  // Paginando até o começo: cada página emenda na anterior, sem repetir nem pular.
  let cursor = recent[0].id;
  const older = [];
  for (let request = 0; request < 10; request += 1) {
    const page = state.loadHistory("t-geral", cursor);
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
  assert.equal(state.loadHistory("t-geral", "nao-existe"), null);
  assert.equal(state.loadHistory("t-avisos", recent[0].id), null, "id de outro canal é recusado");

  const database = new Database(process.env.DATABASE_PATH, { readonly: true });
  const profile = database.prepare("SELECT username FROM profiles WHERE user_id = ?").get(userId);
  const memberships = database
    .prepare("SELECT COUNT(*) AS total FROM guild_members WHERE user_id = ?")
    .get(userId).total;
  const defaultRoles = database.prepare("SELECT COUNT(*) AS total FROM roles WHERE is_default = 1").get().total;
  const migrations = database.prepare("SELECT COUNT(*) AS total FROM schema_migrations").get().total;
  const stored = database
    .prepare("SELECT COUNT(*) AS total FROM messages WHERE channel_id = 't-geral'")
    .get().total;
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  database.close();

  assert.equal(profile.username, "Perfil Persistente");
  assert.equal(memberships, current.guilds.length, "o perfil entra em todos os servidores");
  assert.equal(defaultRoles, current.guilds.length, "cada servidor tem um cargo padrão");
  // Contado a partir dos arquivos, pra uma migration nova não quebrar o teste.
  assert.equal(migrations, readdirSync(join(root, "server", "data", "migrations")).length);
  assert.equal(stored, TOTAL_MESSAGES, "o banco guarda além da página recente");
  assert.deepEqual(tables, [
    "app_settings",
    "bans",
    "channel_permission_overwrites",
    "channels",
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

if (stage === "write") {
  await writeState();
} else if (stage === "read") {
  await readState();
} else {
  const testDirectory = mkdtempSync(join(tmpdir(), "draco-persistence-"));
  const databasePath = join(testDirectory, "draco.sqlite");

  try {
    for (const childStage of ["write", "read"]) {
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
