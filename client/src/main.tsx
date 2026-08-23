import { createRoot } from "react-dom/client";
import "@/styles/discord.css";
import { App } from "@/App";
import { SelfTestPage } from "@/dev/SelfTestPage";

/**
 * `?selftest=1` abre o autoteste do WebRTC em vez da interface. Fica numa rota
 * separada, e não dentro do app, porque o teste sobe duas conexões e vários
 * contextos de áudio na mesma aba — atrapalharia uma call de verdade.
 */
const selfTest = new URLSearchParams(window.location.search).has("selftest");

createRoot(document.getElementById("root")!).render(selfTest ? <SelfTestPage /> : <App />);
