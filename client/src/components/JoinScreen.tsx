import { useEffect, useState, type FormEvent } from "react";
import { Constellation } from "@/components/Constellation";
import { BrandMark } from "@/components/Icons";
import { mediaSupported } from "@/rtc/MediaManager";
import { useStore } from "@/state/store";

type Mode = "login" | "register" | "forgot" | "guest" | "password" | "verified" | "login-address";

const validNewPassword = (value: string) =>
  value.length >= 8 && value.length <= 128 && /\p{Ll}/u.test(value) && /\p{Lu}/u.test(value);

export function JoinScreen() {
  const query = new URLSearchParams(window.location.search);
  const action = query.get("conta");
  const actionToken = query.get("token") ?? "";
  const inviteCode = query.get("convite") ?? "";

  const status = useStore((state) => state.status);
  const joinError = useStore((state) => state.joinError);
  const emailReady = useStore((state) => state.emailReady);
  const bootstrap = useStore((state) => state.bootstrap);
  const connect = useStore((state) => state.connect);
  const connectGuest = useStore((state) => state.connectGuest);
  const register = useStore((state) => state.register);
  const verifyEmail = useStore((state) => state.verifyEmail);
  const confirmLoginAddress = useStore((state) => state.confirmLoginAddress);
  const requestPassword = useStore((state) => state.requestPassword);
  const completePassword = useStore((state) => state.completePassword);

  const [mode, setMode] = useState<Mode>(() =>
    action === "senha" || action === "ativar"
      ? "password"
      : action === "novo-ip"
        ? "login-address"
        : action === "verificar"
          ? "verified"
          : "login",
  );
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [age, setAge] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (action !== "verificar" || !actionToken) return;
    setBusy(true);
    void verifyEmail(actionToken).then((error) => {
      setBusy(false);
      setMessage(error ?? "E-mail confirmado. Agora você já pode entrar.");
      if (!error) window.history.replaceState(null, "", window.location.pathname);
    });
  }, [action, actionToken, verifyEmail]);

  useEffect(() => {
    if (action !== "novo-ip" || !actionToken) return;
    setBusy(true);
    void confirmLoginAddress(actionToken).then((error) => {
      setBusy(false);
      setMessage(error ?? "Novo IP confirmado. Volte ao aparelho que tentou entrar e faça o login novamente.");
      if (!error) window.history.replaceState(null, "", window.location.pathname);
    });
  }, [action, actionToken, confirmLoginAddress]);

  const connecting = status === "connecting" || busy;
  const ageRequired = mode === "register" || mode === "guest";
  const numericAge = Number(age);
  const adultAge = Number.isInteger(numericAge) && numericAge >= 18 && numericAge <= 120;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (connecting) return;
    setBusy(true);
    setMessage(null);
    if (mode === "login") {
      await connect(email, password);
    } else if (mode === "register") {
      if (!validNewPassword(password)) {
        setMessage("A senha precisa ter no mínimo 8 caracteres, uma letra maiúscula e uma minúscula.");
      } else if (password !== confirmation) {
        setMessage("As duas senhas precisam ser iguais.");
      } else if (!adultAge) {
        setMessage("O Draco é exclusivo para pessoas com 18 anos ou mais.");
      } else {
        const error = await register(email, username, numericAge, password, confirmation);
        setMessage(error ?? "Conta criada. Abra o e-mail de confirmação para liberar o acesso.");
        if (!error) setMode("login");
      }
    } else if (mode === "forgot") {
      const error = await requestPassword(email);
      setMessage(error ?? "Se o e-mail estiver cadastrado, o link de troca foi enviado.");
    } else if (mode === "guest") {
      if (!adultAge) setMessage("O Draco é exclusivo para pessoas com 18 anos ou mais.");
      else await connectGuest(username, inviteCode, numericAge);
    } else if (mode === "password") {
      if (!validNewPassword(password)) setMessage("A senha precisa ter no mínimo 8 caracteres, uma letra maiúscula e uma minúscula.");
      else if (password !== confirmation) setMessage("As duas senhas precisam ser iguais.");
      else if (!actionToken) setMessage("Esse link não tem um token válido.");
      else setMessage(await completePassword(actionToken, password));
    }
    setBusy(false);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setPassword("");
    setConfirmation("");
    setAge("");
    setMessage(null);
    useStore.setState({ joinError: null });
  }

  const success = Boolean(message && /enviado|confirmado|criada/i.test(message));

  return (
    <div className="join" data-launching={connecting}>
      <Constellation exploding={false} />
      <div className="join-glow" aria-hidden="true" />

      <form className="join-card account-card" onSubmit={submit}>
        <div className="join-logo"><BrandMark size={72} /></div>
        <h1>Draco</h1>
        <p className="join-subtitle">
          {mode === "register" ? "Crie sua conta pessoal." : mode === "guest" ? "Entre como visitante temporário." : mode === "forgot" ? "Receba um link seguro por e-mail." : mode === "password" ? "Escolha sua nova senha." : mode === "verified" ? "Confirmação de e-mail" : mode === "login-address" ? "Confirmação de novo IP" : "Entre na sua conta."}
        </p>

        {(mode === "login" || mode === "register" || mode === "forgot") && (
          <label className="field">
            <span>E-mail <em>*</em></span>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" autoFocus placeholder="voce@email.com" />
          </label>
        )}

        {(mode === "register" || mode === "guest") && (
          <label className="field">
            <span>{mode === "guest" ? "Apelido temporário" : "Nome de usuário"} <em>*</em></span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} autoComplete="nickname" autoFocus={mode === "guest"} />
          </label>
        )}

        {ageRequired && (
          <label className="field">
            <span>Idade <em>*</em></span>
            <input type="number" inputMode="numeric" value={age} onChange={(event) => setAge(event.target.value)} min={18} max={120} step={1} autoComplete="off" placeholder="18 ou mais" />
            <em>É necessário ter 18 anos ou mais.</em>
          </label>
        )}

        {(mode === "login" || mode === "register" || mode === "password") && (
          <label className="field">
            <span>Senha <em>*</em></span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} />
            {mode !== "login" && <em>Mínimo de 8 caracteres, com letra maiúscula e minúscula.</em>}
          </label>
        )}

        {(mode === "register" || mode === "password") && (
          <label className="field">
            <span>Confirmar senha <em>*</em></span>
            <input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" />
          </label>
        )}

        {mode === "guest" && <p className="join-warning">Ao continuar, você declara ter 18 anos ou mais. Visitantes podem entrar na voz e ler o canal, mas não podem escrever. A identidade desaparece ao sair.</p>}
        {!emailReady && mode !== "guest" && <p className="join-warning">O administrador ainda precisa configurar o envio de e-mail no servidor.</p>}
        {(message || joinError) && <p className={success ? "join-success" : "join-error"}>{message ?? joinError}</p>}

        {mode !== "verified" && mode !== "login-address" && (
          <button type="submit" className="join-submit" disabled={connecting || (mode !== "guest" && mode !== "password" && !email.trim()) || (mode === "login" && password.length < 8) || ((mode === "register" || mode === "password") && (!validNewPassword(password) || confirmation.length < 8)) || ((mode === "register" || mode === "guest") && username.trim().length < 2) || (ageRequired && !adultAge)}>
            {connecting ? "Aguarde…" : mode === "register" ? "Criar conta" : mode === "forgot" ? "Enviar link" : mode === "guest" ? "Entrar como visitante" : mode === "password" ? "Salvar senha" : "Entrar"}
          </button>
        )}

        <nav className="join-links" aria-label="Opções da conta">
          {mode !== "login" && <button type="button" onClick={() => switchMode("login")}>Entrar na conta</button>}
          {mode === "login" && <button type="button" onClick={() => switchMode("register")}>Criar conta</button>}
          {mode === "login" && <button type="button" onClick={() => switchMode("forgot")}>Esqueci a senha</button>}
          {inviteCode && mode !== "guest" && <button type="button" onClick={() => switchMode("guest")}>Continuar sem login</button>}
        </nav>

        {!mediaSupported() && <p className="join-warning">Sem HTTPS, o navegador bloqueia microfone e câmera. O chat continua funcionando.</p>}
      </form>
    </div>
  );
}
