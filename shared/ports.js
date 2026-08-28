/**
 * Portas de desenvolvimento, num lugar só.
 *
 * Em dev são dois processos: o Vite serve a página e o Express serve `/api` e o
 * websocket. O Vite faz proxy de um pro outro, então os dois precisam concordar
 * sobre a porta da sinalização. Se esse número estivesse escrito nos dois
 * arquivos, mudar um deles quebraria só o websocket: a página abriria normal e
 * a call não conectaria, que é o sintoma mais difícil de diagnosticar aqui.
 *
 * Em produção não se usa nada disto: é um processo só, na porta que a
 * plataforma de deploy definir em `PORT`.
 */

/** Porta do Express + Socket.IO em desenvolvimento. */
export const DEV_API_PORT = 3100;

/** Porta do servidor de desenvolvimento do Vite, o endereço que se abre no navegador. */
export const DEV_WEB_PORT = 5173;
