import { useEffect, useState, type FormEvent } from "react";
import { DiscordIcon } from "@/components/Icons";
import { mediaSupported } from "@/rtc/MediaManager";
import { useStore } from "@/state/store";

/** O apelido volta na próxima visita; é a única coisa que a gente guarda. */
const NAME_KEY = "discord-clone:username";

export function JoinScreen() {
  const status = useStore((state) => state.status);
  const joinError = useStore((state) => state.joinError);
  const requiresPassword = useStore((state) => state.requiresPassword);
  const connect = useStore((state) => state.connect);
  const bootstrap = useStore((state) => state.bootstrap);

  const [username, setUsername] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [password, setPassword] = useState("");

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const connecting = status === "connecting";
  const valid = username.trim().length >= 2;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || connecting) return;
    const name = username.trim();
    localStorage.setItem(NAME_KEY, name);
    void connect(name, password);
  }

  return (
    <div className="join">
      <form className="join-card" onSubmit={submit}>
        <div className="join-logo">
          <DiscordIcon size={44} />
        </div>
        <h1>Bem-vindo de volta!</h1>
        <p className="join-subtitle">Escolha um apelido para entrar na sala.</p>

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

        <button type="submit" className="join-submit" disabled={!valid || connecting}>
          {connecting ? "Entrando…" : "Entrar"}
        </button>

        {/* Sem contexto seguro não existe `getUserMedia`: o navegador some com a
            função inteira. Melhor avisar aqui do que a pessoa descobrir quando
            clicar em entrar na call e nada acontecer. */}
        {!mediaSupported() && (
          <p className="join-warning">
            Esta página não está em HTTPS nem em <code>localhost</code>, então o navegador bloqueia
            microfone e câmera. O chat funciona; a call, não. Veja o README para abrir com HTTPS.
          </p>
        )}
      </form>
    </div>
  );
}
