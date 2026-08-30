import type { Account } from "@/types";

export interface AuthReply {
  ok: boolean;
  error?: string;
  token?: string;
  account?: Account;
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

const storedToken = () => {
  try {
    const value = JSON.parse(localStorage.getItem("draco:session") ?? "null");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

async function post(path: string, body: unknown, token?: string | null): Promise<AuthReply> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return (await response.json()) as AuthReply;
  } catch {
    return { ok: false, error: "network" };
  }
}

export const loginAccount = (email: string, password: string) =>
  post("/api/auth/login", { email, password });

export const registerAccount = (
  email: string,
  username: string,
  age: number,
  password: string,
  passwordConfirmation: string,
) => post("/api/auth/register", { email, username, age, password, passwordConfirmation });

export const verifyAccountEmail = (token: string) => post("/api/auth/verify", { token });

export const confirmLoginAddress = (token: string) =>
  post("/api/auth/login-address/confirm", { token });

export const requestPasswordReset = (email: string) =>
  post("/api/auth/password/request", { email });

export const requestOwnPasswordChange = (token: string | null) =>
  post("/api/auth/password/change-request", {}, token);

export const completePasswordReset = (token: string, password: string) =>
  post("/api/auth/password/complete", { token, password });

export async function listConnectedSessions(): Promise<SessionsReply> {
  try {
    const response = await fetch("/api/auth/sessions", {
      headers: { Authorization: `Bearer ${storedToken() ?? ""}` },
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
      headers: { Authorization: `Bearer ${storedToken() ?? ""}` },
    });
    return await response.json() as AuthReply;
  } catch {
    return { ok: false, error: "network" };
  }
}

export const revokeAllConnectedSessions = () => post("/api/auth/sessions/revoke-all", {}, storedToken());

export async function loadPlatformHealth(): Promise<{ ok: boolean; metrics?: Record<string, any> }> {
  try {
    const response = await fetch("/api/admin/health", { headers: { Authorization: `Bearer ${storedToken() ?? ""}` } });
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
    case "bad-password-format":
      return "A senha precisa ter de 8 a 128 caracteres, com pelo menos uma letra maiúscula e uma minúscula.";
    case "password-mismatch":
      return "As duas senhas precisam ser iguais.";
    case "adult-required":
      return "O Draco é exclusivo para pessoas com 18 anos ou mais.";
    case "email-taken":
      return "Esse e-mail já está cadastrado.";
    case "username-taken":
      return "Esse nome já está em uso.";
    case "login-failed":
      return "E-mail ou senha incorretos.";
    case "email-unverified":
      return "Confirme o e-mail antes de entrar.";
    case "email-verification-sent":
      return "Enviamos um novo link de confirmação para esse e-mail.";
    case "new-ip-verification-sent":
      return "Novo IP detectado. Enviamos um link de confirmação para seu e-mail; confirme e tente entrar novamente.";
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
    case "network":
      return "Não foi possível falar com o servidor.";
    default:
      return "Não foi possível concluir a operação.";
  }
}
