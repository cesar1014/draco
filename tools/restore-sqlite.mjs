import "dotenv/config";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { backupKey, decryptBackup, isEncryptedBackup } from "./backup-crypto.mjs";

const sourceArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const confirmedOffline = process.argv.includes("--confirm-offline");

if (!sourceArgument || !confirmedOffline) {
  console.error("Uso: npm run db:restore -- backups/draco-....sqlite --confirm-offline");
  console.error("Pare o serviço Draco antes de restaurar. O banco atual será preservado ao lado dele.");
  process.exit(2);
}

const sourcePath = resolve(sourceArgument);
const targetPath = resolve(process.env.DATABASE_PATH?.trim() || "data/draco.sqlite");
if (sourcePath === targetPath) throw new Error("o backup e o banco de destino não podem ser o mesmo arquivo");
if (targetPath === parse(targetPath).root || dirname(targetPath) === parse(targetPath).root) {
  throw new Error("o banco de destino precisa estar dentro de uma pasta dedicada");
}

function verify(path) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("quick_check", { simple: true });
    const foreignKeyErrors = database.pragma("foreign_key_check").length;
    if (integrity !== "ok" || foreignKeyErrors !== 0) {
      throw new Error(`SQLite inválido: quick_check=${integrity}, foreign_keys=${foreignKeyErrors}`);
    }
  } finally {
    database.close();
  }
}

mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const decryptedPath = `${targetPath}.restore-source-${stamp}.partial`;
let readableSource = sourcePath;
if (isEncryptedBackup(sourcePath)) {
  try {
    await decryptBackup(sourcePath, decryptedPath, backupKey());
    readableSource = decryptedPath;
    verify(readableSource);
  } catch (error) {
    if (existsSync(decryptedPath)) unlinkSync(decryptedPath);
    throw error;
  }
} else {
  verify(readableSource);
}
const replacementPath = `${targetPath}.restore-${stamp}.partial`;
const preservedPath = `${targetPath}.before-restore-${stamp}`;
const source = new Database(readableSource, { readonly: true, fileMustExist: true });
try {
  await source.backup(replacementPath);
} finally {
  source.close();
  if (readableSource === decryptedPath && existsSync(decryptedPath)) unlinkSync(decryptedPath);
}
try {
  verify(replacementPath);
} catch (error) {
  if (existsSync(replacementPath)) unlinkSync(replacementPath);
  throw error;
}

let preserved = false;
try {
  if (existsSync(targetPath)) {
    const current = new Database(targetPath, { fileMustExist: true });
    try {
      current.pragma("busy_timeout = 2000");
      current.pragma("wal_checkpoint(TRUNCATE)");
      current.exec("BEGIN EXCLUSIVE; ROLLBACK;");
    } finally {
      current.close();
    }
    renameSync(targetPath, preservedPath);
    preserved = true;
  }

  for (const sidecar of [`${targetPath}-wal`, `${targetPath}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  renameSync(replacementPath, targetPath);
} catch (error) {
  if (preserved && !existsSync(targetPath)) renameSync(preservedPath, targetPath);
  if (existsSync(replacementPath)) unlinkSync(replacementPath);
  throw error;
}

console.log(`Banco restaurado e verificado: ${targetPath}`);
if (existsSync(preservedPath)) console.log(`Banco anterior preservado: ${preservedPath}`);
