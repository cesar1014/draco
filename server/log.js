/**
 * Log do servidor, com categoria na frente da linha.
 *
 * Existe por dois motivos práticos: seguir uma tentativa de call no meio de
 * várias exige saber de qual assunto é cada linha, e produção não pode receber o
 * mesmo detalhe que o desenvolvimento. `LOG_LEVEL` controla o volume; o padrão é
 * `info`, que já mostra o que importa sem despejar cada pacote de sinalização.
 *
 * Nada de credencial, token ou conteúdo de mensagem passa por aqui. Quando o
 * valor é sensível, o que se registra é o formato, não o valor.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configured = process.env.LOG_LEVEL?.trim().toLowerCase();
const threshold = LEVELS[configured] ?? LEVELS.info;

/** Categorias do sistema. Uma linha sem categoria conhecida vira `APP`. */
export const CATEGORIES = [
  "APP",
  "AUTH",
  "DB",
  "ELECTRON",
  "SCREEN",
  "SFU",
  "SIGNAL",
  "SOCKET",
  "TURN",
  "VOICE",
];

function emit(level, category, message, detail) {
  if (LEVELS[level] > threshold) return;
  const prefix = `[${category}]`;
  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (detail === undefined) write(prefix, message);
  else write(prefix, message, detail);
}

/**
 * Logger de uma categoria. `detail` é opcional e deve ser um objeto pequeno com
 * o contexto que ajuda a diagnosticar: id de correlação, etapa, motivo.
 */
export function logger(category) {
  const name = CATEGORIES.includes(category) ? category : "APP";
  return {
    error: (message, detail) => emit("error", name, message, detail),
    warn: (message, detail) => emit("warn", name, message, detail),
    info: (message, detail) => emit("info", name, message, detail),
    debug: (message, detail) => emit("debug", name, message, detail),
  };
}

/**
 * Mensagem de um erro, sem stack. Stack de erro de rede em produção só polui: o
 * que interessa é o que falhou e por quê.
 */
export const reason = (error) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "erro desconhecido";
