import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { DEV_API_PORT, DEV_WEB_PORT } from "./shared/ports.js";

/**
 * O cliente vive em `client/` e o servidor de sinalização num processo separado.
 * Em dev o Vite faz proxy de `/api` e `/socket.io` pra lá, então o navegador
 * sempre fala com uma única origem — o que evita dor de cabeça com CORS e faz o
 * caminho de produção (onde o próprio Express serve o `dist/`) ser idêntico.
 */
export default defineConfig({
  root: "client",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./client/src", import.meta.url)),
    },
  },
  server: {
    port: DEV_WEB_PORT,
    host: true,
    // Um túnel (Cloudflare/ngrok) chega com um Host que o Vite não conhece e
    // recusaria por padrão. Liberar é seguro aqui: é servidor de desenvolvimento.
    allowedHosts: true,
    proxy: {
      "/api": { target: `http://localhost:${DEV_API_PORT}`, changeOrigin: true },
      "/socket.io": { target: `http://localhost:${DEV_API_PORT}`, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
