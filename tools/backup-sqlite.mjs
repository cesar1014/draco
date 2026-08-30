import "dotenv/config";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, extname, join, parse, resolve } from "node:path";

const databasePath = resolve(process.env.DATABASE_PATH?.trim() || "data/draco.sqlite");
const backupDirectory = resolve(process.argv[2] || "backups");
const retention = Number.parseInt(process.env.BACKUP_RETENTION || "7", 10);

if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
  throw new Error("BACKUP_RETENTION deve ser um número entre 1 e 365");
}
if (backupDirectory === parse(backupDirectory).root) {
  throw new Error("a pasta de backup não pode ser a raiz do disco");
}

mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const finalPath = join(backupDirectory, `draco-${stamp}.sqlite`);
const temporaryPath = `${finalPath}.partial`;

const source = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  await source.backup(temporaryPath);
} finally {
  source.close();
}

const verification = new Database(temporaryPath, { readonly: true, fileMustExist: true });
try {
  const integrity = verification.pragma("quick_check", { simple: true });
  const foreignKeyErrors = verification.pragma("foreign_key_check").length;
  if (integrity !== "ok" || foreignKeyErrors !== 0) {
    throw new Error(`backup inválido: quick_check=${integrity}, foreign_keys=${foreignKeyErrors}`);
  }
} catch (error) {
  verification.close();
  unlinkSync(temporaryPath);
  throw error;
}
verification.close();

renameSync(temporaryPath, finalPath);
if (process.platform !== "win32") chmodSync(finalPath, 0o600);

const backups = readdirSync(backupDirectory)
  .filter((name) => /^draco-.*\.sqlite$/.test(name) && extname(name) === ".sqlite")
  .map((name) => ({ path: join(backupDirectory, name), modified: statSync(join(backupDirectory, name)).mtimeMs }))
  .sort((left, right) => right.modified - left.modified);

for (const expired of backups.slice(retention)) unlinkSync(expired.path);

console.log(`Backup verificado: ${finalPath}`);
console.log(`Retenção: ${Math.min(backups.length, retention)} de ${retention}`);
