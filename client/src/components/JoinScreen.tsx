import { useEffect, useRef, useState, type FormEvent } from "react";
import { Constellation } from "@/components/Constellation";
import { BrandMark } from "@/components/Icons";
import { mediaSupported } from "@/rtc/MediaManager";
import { useStore } from "@/state/store";

type Mode = "login" | "register" | "forgot" | "guest" | "password" | "verified" | "login-address";
type RegisterField = "email" | "displayName" | "publicId" | "age" | "password" | "confirmation";
type RegisterErrors = Partial<Record<RegisterField, string>>;

const validNewPassword = (value: string) =>
  value.length >= 8 && value.length <= 128 && /\p{Ll}/u.test(value) && /\p{Lu}/u.test(value);
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
const validPublicId = (value: string) =>
  /^[a-z0-9](?:[a-z0-9_.-]{1,30}[a-z0-9])$/u.test(value.trim().replace(/^@/u, "").toLowerCase());

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, unknown>) => string;
      reset: (id: string) => void;
      remove: (id: string) => void;
    };
  }
}

let turnstileLoader: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("turnstile-unavailable"));
    document.head.append(script);
  });
  return turnstileLoader;
}

export function JoinScreen() {
  const query = new URLSearchParams(window.location.search);
  const action = query.get("conta");
  const actionToken = query.get("token") ?? "";
  const inviteCode = query.get("convite") ?? "";

  const status = useStore((state) => state.status);
  const joinError = useStore((state) => state.joinError);
  const emailReady = useStore((state) => state.emailReady);
  const turnstileSiteKey = useStore((state) => state.turnstileSiteKey);
  const bootstrap = useStore((state) => state.bootstrap);
  const connect = useStore((state) => state.connect);
  const connectGuest = useStore((state) => state.connectGuest);
  const register = useStore((state) => state.register);
  const resendVerification = useStore((state) => state.resendVerification);
  const verifyEmail = useStore((state) => state.verifyEmail);
  const confirmLoginAddress = useStore((state) => state.confirmLoginAddress);
  const requestPassword = useStore((state) => state.requestPassword);
  const completePassword = useStore((state) => state.completePassword);

  const [mode, setMode] = useState<Mode>(() =>
    action === "senha" || action === "ativar"
      ? "password"
      : action === "novo-dispositivo" || action === "novo-ip"
        ? "login-address"
        : action === "verificar"
          ? "verified"
          : "login",
  );
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [publicId, setPublicId] = useState("");
  const [age, setAge] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [registerErrors, setRegisterErrors] = useState<RegisterErrors>({});
  const [botToken, setBotToken] = useState<string | null>(null);
  const turnstileHost = useRef<HTMLDivElement>(null);
  const turnstileWidget = useRef<string | null>(null);

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
    if (!["novo-dispositivo", "novo-ip"].includes(action ?? "") || !actionToken) return;
    setBusy(true);
    void confirmLoginAddress(actionToken).then((error) => {
      setBusy(false);
      setMessage(error ?? "Dispositivo confirmado. Entrando automaticamente…");
      if (!error) window.history.replaceState(null, "", window.location.pathname);
    });
  }, [action, actionToken, confirmLoginAddress]);

  const botProtected = mode === "login" || mode === "register" || mode === "forgot";
  useEffect(() => {
    setBotToken(null);
    if (!turnstileSiteKey || !botProtected || !turnstileHost.current) return;
    let active = true;
    void loadTurnstile().then(() => {
      if (!active || !window.turnstile || !turnstileHost.current) return;
      turnstileWidget.current = window.turnstile.render(turnstileHost.current, {
        sitekey: turnstileSiteKey,
        action: mode === "forgot" ? "password-request" : mode,
        theme: "dark",
        callback: (token: string) => setBotToken(token),
        "expired-callback": () => setBotToken(null),
        "error-callback": () => setBotToken(null),
      });
    }).catch(() => setMessage("A proteção antirobô não carregou. Recarregue a página."));
    return () => {
      active = false;
      if (turnstileWidget.current && window.turnstile) {
        window.turnstile.remove(turnstileWidget.current);
        turnstileWidget.current = null;
      }
    };
  }, [botProtected, mode, turnstileSiteKey]);

  const connecting = status === "connecting" || busy;
  const ageRequired = mode === "register" || mode === "guest";
  const numericAge = Number(age);
  const adultAge = Number.isInteger(numericAge) && numericAge >= 18 && numericAge <= 120;

  function clearRegisterError(field: RegisterField) {
    setRegisterErrors((current) => current[field] ? { ...current, [field]: undefined } : current);
  }

  function registrationErrors(): RegisterErrors {
    const errors: RegisterErrors = {};
    if (!validEmail(email)) errors.email = "Digite um e-mail válido.";
    if (username.trim().replace(/\s+/gu, " ").length < 2) {
      errors.displayName = "Digite um nome de pelo menos 2 caracteres.";
    }
    if (!validPublicId(publicId)) {
      errors.publicId = "Use de 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.";
    }
    if (!adultAge) errors.age = "Informe uma idade entre 18 e 120 anos.";
    if (!validNewPassword(password)) {
      errors.password = "Use de 8 a 128 caracteres, com letra maiúscula e minúscula.";
    }
    if (!confirmation || password !== confirmation) errors.confirmation = "As duas senhas precisam ser iguais.";
    return errors;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (connecting) return;
    if (mode === "register") {
      const errors = registrationErrors();
      if (Object.keys(errors).length > 0) {
        setRegisterErrors(errors);
        setMessage(null);
        return;
      }
    }
    if (turnstileSiteKey && botProtected && !botToken) {
      setMessage("Conclua a verificação antirobô.");
      return;
    }
    setBusy(true);
    setMessage(null);
    if (mode === "login") {
      await connect(email, password, botToken);
    } else if (mode === "register") {
      const error = await register(
        email,
        username,
        publicId,
        numericAge,
        password,
        confirmation,
        botToken,
      );
      if (!error) {
        setRegisterErrors({});
        setMessage("E-mail de confirmação enviado. Confirme em até 15 minutos para concluir o cadastro.");
        setMode("login");
      } else {
        const field = error.code === "email-taken" || error.code === "bad-email"
          ? "email"
          : error.code === "public-id-taken" || error.code === "bad-public-id"
            ? "publicId"
            : error.code === "bad-username"
              ? "displayName"
              : error.code === "adult-required"
                ? "age"
                : error.code === "bad-password-format"
                  ? "password"
                  : error.code === "password-mismatch"
                    ? "confirmation"
                    : null;
        if (field) {
          setRegisterErrors({ [field]: error.message });
          setMessage(null);
        } else {
          setMessage(error.message);
        }
      }
    } else if (mode === "forgot") {
      const error = await requestPassword(email, botToken);
      setMessage(error ?? "Se o e-mail estiver cadastrado, o link de troca foi enviado.");
    } else if (mode === "guest") {
      if (!adultAge) setMessage("O Draco é exclusivo para pessoas com 18 anos ou mais.");
      else await connectGuest(username, inviteCode, numericAge);
    } else if (mode === "password") {
      if (!validNewPassword(password)) setMessage("A senha precisa ter no mínimo 8 caracteres, uma letra maiúscula e uma minúscula.");
      else if (password !== confirmation) setMessage("As duas senhas precisam ser iguais.");
      else if (!actionToken) setMessage("Esse link não tem um token válido.");
      else {
        const error = await completePassword(actionToken, password);
        setMessage(error);
        if (!error) window.history.replaceState(null, "", window.location.pathname);
      }
    }
    if (turnstileWidget.current && window.turnstile) window.turnstile.reset(turnstileWidget.current);
    setBotToken(null);
    setBusy(false);
  }

  async function resend() {
    if (connecting || !email.trim() || password.length < 8) {
      setMessage("Digite o e-mail e a senha da conta para reenviar a confirmação.");
      return;
    }
    if (turnstileSiteKey && !botToken) {
      setMessage("Conclua a verificação antirobô.");
      return;
    }
    setBusy(true);
    setMessage(null);
    const error = await resendVerification(email, password, botToken);
    setMessage(error ?? "Novo e-mail de confirmação enviado.");
    if (turnstileWidget.current && window.turnstile) window.turnstile.reset(turnstileWidget.current);
    setBotToken(null);
    setBusy(false);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setPassword("");
    setConfirmation("");
    setAge("");
    setPublicId("");
    setRegisterErrors({});
    setMessage(null);
    useStore.setState({ joinError: null });
  }

  const success = Boolean(message && /enviado|confirmado|criada/i.test(message));

  return (
    <div className="join" data-launching={connecting}>
      <Constellation exploding={false} />
      <div className="join-glow" aria-hidden="true" />

      <form className="join-card account-card" onSubmit={submit} noValidate>
        <div className="join-logo"><BrandMark size={72} /></div>
        <h1>Draco</h1>
        <p className="join-subtitle">
          {mode === "register" ? "Crie sua conta pessoal." : mode === "guest" ? "Entre como visitante temporário." : mode === "forgot" ? "Receba um link seguro por e-mail." : mode === "password" ? "Escolha sua nova senha." : mode === "verified" ? "Confirmação de e-mail" : mode === "login-address" ? "Confirmação de novo IP" : "Entre na sua conta."}
        </p>

        {(mode === "login" || mode === "register" || mode === "forgot") && (
          <label className="field" data-invalid={mode === "register" && Boolean(registerErrors.email)}>
            <span>E-mail <em>*</em></span>
            <input
              type="email"
              value={email}
              onChange={(event) => { setEmail(event.target.value); clearRegisterError("email"); }}
              autoComplete="email"
              autoFocus
              placeholder="voce@email.com"
              aria-invalid={mode === "register" && Boolean(registerErrors.email)}
            />
            {mode === "register" && registerErrors.email && <small className="field-error">{registerErrors.email}</small>}
          </label>
        )}

        {(mode === "register" || mode === "guest") && (
          <label className="field" data-invalid={mode === "register" && Boolean(registerErrors.displayName)}>
            <span>{mode === "guest" ? "Apelido temporário" : "Nome exibido"} <em>*</em></span>
            <input
              value={username}
              onChange={(event) => { setUsername(event.target.value); clearRegisterError("displayName"); }}
              maxLength={32}
              autoComplete="nickname"
              autoFocus={mode === "guest"}
              aria-invalid={mode === "register" && Boolean(registerErrors.displayName)}
            />
            {mode === "register" && <small className="field-help">Não precisa ser único; outras pessoas podem usar o mesmo nome.</small>}
            {mode === "register" && registerErrors.displayName && <small className="field-error">{registerErrors.displayName}</small>}
          </label>
        )}

        {mode === "register" && (
          <label className="field" data-invalid={Boolean(registerErrors.publicId)}>
            <span>ID público <em>*</em></span>
            <input
              value={publicId}
              onChange={(event) => { setPublicId(event.target.value.toLowerCase()); clearRegisterError("publicId"); }}
              minLength={3}
              maxLength={32}
              autoComplete="off"
              placeholder="seu.id"
              spellCheck={false}
              aria-invalid={Boolean(registerErrors.publicId)}
            />
            <small className="field-help">Único e usado pelos amigos para encontrar você. Letras, números, ponto, hífen ou sublinhado.</small>
            {registerErrors.publicId && <small className="field-error">{registerErrors.publicId}</small>}
          </label>
        )}

        {ageRequired && (
          <label className="field" data-invalid={mode === "register" && Boolean(registerErrors.age)}>
            <span>Idade <em>*</em></span>
            <input type="number" inputMode="numeric" value={age} onChange={(event) => { setAge(event.target.value); clearRegisterError("age"); }} min={18} max={120} step={1} autoComplete="off" placeholder="18 ou mais" aria-invalid={mode === "register" && Boolean(registerErrors.age)} />
            <small className="field-help">É necessário ter 18 anos ou mais.</small>
            {mode === "register" && registerErrors.age && <small className="field-error">{registerErrors.age}</small>}
          </label>
        )}

        {(mode === "login" || mode === "register" || mode === "password") && (
          <label className="field" data-invalid={mode === "register" && Boolean(registerErrors.password)}>
            <span>Senha <em>*</em></span>
            <input type="password" value={password} onChange={(event) => { setPassword(event.target.value); clearRegisterError("password"); }} minLength={8} maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} aria-invalid={mode === "register" && Boolean(registerErrors.password)} />
            {mode !== "login" && <small className="field-help">Mínimo de 8 caracteres, com letra maiúscula e minúscula.</small>}
            {mode === "register" && registerErrors.password && <small className="field-error">{registerErrors.password}</small>}
          </label>
        )}

        {(mode === "register" || mode === "password") && (
          <label className="field" data-invalid={mode === "register" && Boolean(registerErrors.confirmation)}>
            <span>Confirmar senha <em>*</em></span>
            <input type="password" value={confirmation} onChange={(event) => { setConfirmation(event.target.value); clearRegisterError("confirmation"); }} minLength={8} maxLength={128} autoComplete="new-password" aria-invalid={mode === "register" && Boolean(registerErrors.confirmation)} />
            {mode === "register" && registerErrors.confirmation && <small className="field-error">{registerErrors.confirmation}</small>}
          </label>
        )}

        {mode === "guest" && <p className="join-warning">Ao continuar, você declara ter 18 anos ou mais. Visitantes podem entrar na voz e ler o canal, mas não podem escrever. A identidade desaparece ao sair.</p>}
        {turnstileSiteKey && botProtected && <div ref={turnstileHost} className="turnstile" />}
        {!emailReady && mode !== "guest" && <p className="join-warning">O administrador ainda precisa configurar o envio de e-mail no servidor.</p>}
        {(message || joinError) && <p className={success ? "join-success" : "join-error"}>{message ?? joinError}</p>}

        {mode !== "verified" && mode !== "login-address" && (
          <button type="submit" className="join-submit" disabled={connecting || Boolean(turnstileSiteKey && botProtected && !botToken) || (mode === "login" && (!email.trim() || password.length < 8)) || (mode === "forgot" && !email.trim()) || (mode === "guest" && (username.trim().length < 2 || !adultAge)) || (mode === "password" && (!validNewPassword(password) || confirmation.length < 8))}>
            {connecting ? "Aguarde…" : mode === "register" ? "Criar conta" : mode === "forgot" ? "Enviar link" : mode === "guest" ? "Entrar como visitante" : mode === "password" ? "Salvar senha" : "Entrar"}
          </button>
        )}

        <nav className="join-links" aria-label="Opções da conta">
          {mode !== "login" && <button type="button" onClick={() => switchMode("login")}>Entrar na conta</button>}
          {mode === "login" && <button type="button" onClick={() => switchMode("register")}>Criar conta</button>}
          {mode === "login" && <button type="button" onClick={() => void resend()}>Reenviar confirmação</button>}
          {mode === "login" && <button type="button" onClick={() => switchMode("forgot")}>Esqueci a senha</button>}
          {inviteCode && mode !== "guest" && <button type="button" onClick={() => switchMode("guest")}>Continuar sem login</button>}
        </nav>

        {!mediaSupported() && <p className="join-warning">Sem HTTPS, o navegador bloqueia microfone e câmera. O chat continua funcionando.</p>}
      </form>
    </div>
  );
}
