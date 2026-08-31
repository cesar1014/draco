import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptExistingContent, fieldCipherFromEnv } from "./field-crypto.js";

/**
 * Conexão única com o SQLite e execução das migrations. É síncrono de propósito:
 * o `better-sqlite3` não tem callback, e o estado do servidor é lido e escrito no
 * meio do tratamento de eventos do socket, onde uma promessa a mais só criaria
 * janela pra dois pedidos se cruzarem.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");
const defaultDatabasePath = join(here, "..", "..", "data", "draco.sqlite");

/**
 * O arquivo guarda mensagens de todo mundo, então numa máquina compartilhada ele
 * não deveria ser legível por outro usuário. Volume de contêiner e disco de rede
 * às vezes não implementam permissão POSIX, e aí a falha é esperada e não impede
 * o servidor de subir.
 */
function restrictPermissions(path, mode) {
  if (process.platform === "win32" || !existsSync(path)) return;
  try {
    chmodSync(path, mode);
  } catch (error) {
    if (!["EINVAL", "ENOSYS", "EPERM"].includes(error?.code)) throw error;
  }
}

function resolveDatabasePath(configuredPath) {
  const candidate = configuredPath?.trim() || defaultDatabasePath;
  if (candidate === ":memory:" || isAbsolute(candidate)) return candidate;
  return resolve(process.cwd(), candidate);
}

function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Aplica o que ainda falta, em ordem de nome do arquivo. O checksum existe porque
 * editar uma migration já aplicada é o erro que mais dói: o banco de quem já rodou
 * a versão antiga fica diferente do de quem instalou depois, e nada avisa. Melhor
 * recusar a subir do que descobrir isso meses adiante.
 */
function applyMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Map(
    database.prepare("SELECT name, checksum FROM schema_migrations").all().map((row) => [row.name, row.checksum]),
  );
  const recordMigration = database.prepare(
    "INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
  );

  for (const name of migrationFiles()) {
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existingChecksum = applied.get(name);

    if (existingChecksum && existingChecksum !== checksum) {
      throw new Error(`a migration ${name} foi alterada depois de aplicada`);
    }
    if (existingChecksum) continue;

    // Numa transação só: uma migration que falha no meio deixaria o banco num
    // estado que nem é o antigo nem o novo, e a próxima tentativa iria pior.
    database.transaction(() => {
      database.exec(sql);
      recordMigration.run(name, checksum, Date.now());
    })();
  }
}

export function openDatabase(configuredPath = process.env.DATABASE_PATH) {
  const filename = resolveDatabasePath(configuredPath);
  if (filename !== ":memory:") {
    const databaseDirectory = dirname(filename);
    const directoryExists = existsSync(databaseDirectory);
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
    // Só aperta a permissão da pasta que este processo criou: se ela já existia,
    // quem a criou decidiu quem pode entrar, e um volume montado costuma ser dela.
    if (!directoryExists) restrictPermissions(databaseDirectory, 0o700);
  }

  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  // Dois processos podem encostar no mesmo arquivo (um deploy que ainda não morreu,
  // um teste rodando em paralelo). Sem espera, o segundo levaria SQLITE_BUSY na cara.
  database.pragma("busy_timeout = 5000");
  // WAL deixa ler enquanto se escreve, que é o caso normal aqui: o snapshot de quem
  // entra é lido no mesmo instante em que alguém manda mensagem. Em memória não há
  // arquivo de journal pra isso funcionar.
  if (filename !== ":memory:") database.pragma("journal_mode = WAL");
  // Com WAL, `NORMAL` só arrisca a última transação numa queda de energia da máquina.
  // `FULL` custaria um fsync por mensagem enviada, e mensagem de chat não vale isso.
  database.pragma("synchronous = NORMAL");
  applyMigrations(database);
  const fieldCipher = fieldCipherFromEnv(process.env);
  encryptExistingContent(database, fieldCipher);
  Object.defineProperty(database, "dracoFieldCipher", { value: fieldCipher });
  if (filename !== ":memory:") {
    restrictPermissions(filename, 0o600);
    restrictPermissions(`${filename}-wal`, 0o600);
    restrictPermissions(`${filename}-shm`, 0o600);
  }
  return database;
}
