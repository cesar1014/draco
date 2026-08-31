import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDatabase } from "../server/data/database.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(join(tmpdir(), "draco-backup-"));
const databasePath = join(directory, "data", "draco.sqlite");
const backupDirectory = join(directory, "backups");

function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(root, "tools", script), ...args], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_PATH: databasePath,
      BACKUP_RETENTION: "2",
      BACKUP_ENCRYPTION_KEY: "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${script}: ${result.stderr || result.stdout}`);
}

try {
  const initial = openDatabase(databasePath);
  initial.prepare("INSERT INTO app_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?)")
    .run("backup:test", JSON.stringify("original"), Date.now());
  initial.close();

  run("backup-sqlite.mjs", [backupDirectory]);
  run("backup-sqlite.mjs", [backupDirectory]);
  run("backup-sqlite.mjs", [backupDirectory]);

  const backups = readdirSync(backupDirectory).filter((name) => name.endsWith(".sqlite.enc")).sort();
  assert.equal(backups.length, 2, "a retenção remove somente o backup excedente");
  assert.throws(
    () => {
      const encrypted = new Database(join(backupDirectory, backups[0]), { readonly: true });
      try {
        encrypted.prepare("SELECT name FROM sqlite_master").all();
      } finally {
        encrypted.close();
      }
    },
    /not a database|file is not a database/iu,
    "o backup não pode ser aberto como SQLite sem a chave",
  );

  const changed = new Database(databasePath);
  changed.prepare("UPDATE app_settings SET value_json = ? WHERE setting_key = ?")
    .run(JSON.stringify("alterado"), "backup:test");
  changed.close();

  run("restore-sqlite.mjs", [join(backupDirectory, backups[0]), "--confirm-offline"]);
  const restored = new Database(databasePath, { readonly: true });
  assert.equal(JSON.parse(restored.prepare("SELECT value_json FROM app_settings WHERE setting_key = ?").get("backup:test").value_json), "original");
  assert.equal(restored.pragma("quick_check", { simple: true }), "ok");
  restored.close();
  assert.ok(readdirSync(join(directory, "data")).some((name) => name.includes("before-restore")), "o banco anterior é preservado");
  console.log("backup, retenção e restauração SQLite: ok");
} finally {
  const resolved = resolve(directory);
  if (resolve(dirname(resolved)) === resolve(tmpdir()) && basename(resolved).startsWith("draco-backup-")) {
    rmSync(resolved, { recursive: true, force: true });
  }
}
