import type { Account } from "@/types";

export interface AuthReply {
  ok: boolean;
  error?: string;
  account?: Account;
  autoLogin?: boolean;
}

export interface ConnectedSession {
  id: string;
  clientType: "web" | "desktop" | "mobile" | "unknown";
  deviceName: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface SessionsReply extends AuthReply {
  currentSessionId?: string | null;
  sessions?: ConnectedSession[];
}

const legacySessionToken = () => {
  try {
    const value = JSON.parse(localStorage.getItem("draco:session") ?? "null");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

const DEVICE_KEY = "draco:device";

const storedDeviceToken = (email: string) => {
  try {
    const value = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? "null");
    if (typeof value === "string") return value.length <= 512 ? value : null;
    const token = value?.[email.trim().toLowerCase()];
    return typeof token === "string" && token.length <= 512 ? token : null;
  } catch {
    return null;
  }
};

function removeLegacySession(): void {
  try {
    localStorage.removeItem("draco:session");
  } catch {
    // O navegador pode bloquear storage; os cookies HttpOnly continuam válidos.
  }
}

function removeLegacyDevice(): void {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    // O navegador pode bloquear storage; a credencial nova já está em HttpOnly.
  }
}

const removeLegacyCredentials = () => {
  removeLegacySession();
  removeLegacyDevice();
};

async function post(path: string, body: unknown): Promise<AuthReply> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    return (await response.json()) as AuthReply;
  } catch {
    return { ok: false, error: "network" };
  }
}

export const loginAccount = async (email: string, password: string, botToken: string | null = null) => {
  const reply = await post("/api/auth/login", {
    email,
    password,
    botToken,
    legacyDeviceToken: storedDeviceToken(email),
  });
  if (reply.ok || reply.error === "new-device-verification-sent") removeLegacyCredentials();
  return reply;
};

export const registerAccount = (
  email: string,
  displayName: string,
  publicId: string,
  age: number,
  password: string,
  passwordConfirmation: string,
  botToken: string | null = null,
) => post("/api/auth/register", {
  email,
  displayName,
  publicId,
  age,
  password,
  passwordConfirmation,
  botToken,
});

export const resendAccountVerification = (
  email: string,
  password: string,
  botToken: string | null = null,
) => post("/api/auth/verification/resend", { email, password, botToken });

export const verifyAccountEmail = (token: string) => post("/api/auth/verify", { token });

export const confirmLoginAddress = (token: string) =>
  post("/api/auth/login-address/confirm", { token });

export const requestPasswordReset = (email: string, botToken: string | null = null) =>
  post("/api/auth/password/request", { email, botToken });

export const requestOwnPasswordChange = () =>
  post("/api/auth/password/change-request", {});

export const completePasswordReset = (token: string, password: string) =>
  post("/api/auth/password/complete", { token, password });

export const logoutAccount = () => post("/api/auth/logout", {});

export async function resumeAccountSession(): Promise<boolean> {
  try {
    const legacy = legacySessionToken();
    if (legacy) {
      const migrated = await fetch("/api/auth/session/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${legacy}` },
        credentials: "same-origin",
        body: "{}",
      });
      if (migrated.ok || migrated.status === 401) removeLegacySession();
    }
    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    if (!response.ok || ((await response.json()) as AuthReply).ok !== true) return false;
    const deviceMigration = await fetch("/api/auth/device/migrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    if (deviceMigration.ok) removeLegacyDevice();
    return true;
  } catch {
    return false;
  }
}

export async function listConnectedSessions(): Promise<SessionsReply> {
  try {
    const response = await fetch("/api/auth/sessions", {
      credentials: "same-origin",
    });
    return await response.json() as SessionsReply;
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function revokeConnectedSession(sessionId: string): Promise<AuthReply> {
  try {
    const response = await fetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    return await response.json() as AuthReply;
  } catch {
    return { ok: false, error: "network" };
  }
}

export const revokeAllConnectedSessions = () => post("/api/auth/sessions/revoke-all", {});

export async function loadPlatformHealth(): Promise<{ ok: boolean; metrics?: Record<string, any> }> {
  try {
    const response = await fetch("/api/admin/health", { credentials: "same-origin" });
    return await response.json() as { ok: boolean; metrics?: Record<string, any> };
  } catch {
    return { ok: false };
  }
}

export function describeAuthError(code?: string): string {
  switch (code) {
    case "bad-email":
      return "Digite um e-mail válido.";
    case "bad-username":
      return "Escolha um nome de 2 a 32 caracteres.";
    case "bad-public-id":
      return "Escolha um ID de 3 a 32 caracteres usando letras, números, ponto, hífen ou sublinhado.";
    case "bad-password-format":
      return "A senha precisa ter de 8 a 128 caracteres, com pelo menos uma letra maiúscula e uma minúscula.";
    case "password-mismatch":
      return "As duas senhas precisam ser iguais.";
    case "adult-required":
      return "O Draco é exclusivo para pessoas com 18 anos ou mais.";
    case "email-taken":
      return "Esse e-mail já está cadastrado.";
    case "username-taken":
    case "public-id-taken":
      return "Esse ID já está em uso.";
    case "login-failed":
      return "E-mail ou senha incorretos.";
    case "email-unverified":
      return "Confirme o e-mail antes de entrar.";
    case "email-verification-sent":
      return "Enviamos um novo link de confirmação para esse e-mail.";
    case "email-already-verified":
      return "Esse e-mail já foi confirmado. Você já pode entrar.";
    case "new-device-verification-sent":
    case "new-ip-verification-sent":
      return "Novo dispositivo detectado. Enviamos um link de confirmação; ao autorizar, você entrará automaticamente.";
    case "address-unavailable":
      return "Não foi possível identificar o endereço desta conexão.";
    case "email-unavailable":
      return "O envio de e-mail ainda não foi configurado no servidor.";
    case "email-failed":
      return "Não foi possível enviar o e-mail. Tente novamente.";
    case "token-invalid":
      return "Esse link é inválido, já foi usado ou expirou.";
    case "rate-limited":
      return "Muitas tentativas. Aguarde um pouco.";
    case "bot-verification-failed":
      return "Não foi possível validar a proteção antirobô. Tente novamente.";
    case "network":
      return "Não foi possível falar com o servidor.";
    default:
      return "Não foi possível concluir a operação.";
  }
}
