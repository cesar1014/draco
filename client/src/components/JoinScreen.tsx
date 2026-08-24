import { useEffect, useRef, useState, type FormEvent } from "react";
import { Constellation } from "@/components/Constellation";
import { BrandMark } from "@/components/Icons";
import { mediaSupported } from "@/rtc/MediaManager";
import { useStore } from "@/state/store";

const NAME_KEY = "draco:username";

export function JoinScreen() {
  const status = useStore((state) => state.status);
  const joinError = useStore((state) => state.joinError);
  const requiresPassword = useStore((state) => state.requiresPassword);
  const connect = useStore((state) => state.connect);
  const bootstrap = useStore((state) => state.bootstrap);

  const [username, setUsername] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [password, setPassword] = useState("");
  // Dispara a explosão da constelação assim que a conexão é aceita, antes de a
  // tela trocar; o `pending` guarda o gesto de submit até a animação terminar.
  const [launching, setLaunching] = useState(false);
  const pending = useRef<{ name: string; password: string } | null>(null);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const connecting = status === "connecting";
  const valid = username.trim().length >= 2;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || connecting || launching) return;
    const name = username.trim();
    localStorage.setItem(NAME_KEY, name);
    pending.current = { name, password };
    setLaunching(true);
  }

  // A constelação explode (~700 ms) e só então conectamos: a troca de tela cai
  // junto com o fim da animação, sem cortar no meio.
  useEffect(() => {
    if (!launching || !pending.current) return;
    const { name, password } = pending.current;
    const timer = setTimeout(() => void connect(name, password), 620);
    return () => clearTimeout(timer);
  }, [launching, connect]);

  // Senha errada ou servidor fora: solta o botão pra pessoa tentar de novo.
  useEffect(() => {
    if (joinError) setLaunching(false);
  }, [joinError]);

  return (
    <div className="join" data-launching={launching}>
      <Constellation exploding={launching} />
      <div className="join-glow" aria-hidden="true" />

      <form className="join-card" onSubmit={submit}>
        <div className="join-logo">
          <BrandMark size={72} />
        </div>
        <h1>Draco</h1>
        <p className="join-subtitle">Escolha um apelido e entre na sala.</p>

        <label className="field">
          <span>
            Apelido <em>*</em>
          </span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            maxLength={32}
            autoFocus
            autoComplete="nickname"
            spellCheck={false}
            placeholder="Como as pessoas vão te ver"
          />
        </label>

        {requiresPassword && (
          <label className="field">
            <span>
              Senha da sala <em>*</em>
            </span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="A senha combinada com o pessoal"
            />
          </label>
        )}

        {joinError && <p className="join-error">{joinError}</p>}

        <button type="submit" className="join-submit" disabled={!valid || connecting || launching}>
          {launching || connecting ? "Entrando…" : "Entrar"}
        </button>

        {!mediaSupported() && (
          <p className="join-warning">
            Esta página não está em HTTPS nem em <code>localhost</code>, então o navegador bloqueia
            microfone e câmera. O chat funciona; a call, não.
          </p>
        )}
      </form>
    </div>
  );
}
