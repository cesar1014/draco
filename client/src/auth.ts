import type { Account } from "@/types";

export interface AuthReply {
  ok: boolean;
  error?: string;
  token?: string;
  account?: Account;
}

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

export const registerAccount = (email: string, username: string, password: string) =>
  post("/api/auth/register", { email, username, password });

export const verifyAccountEmail = (token: string) => post("/api/auth/verify", { token });

export const requestPasswordReset = (email: string) =>
  post("/api/auth/password/request", { email });

export const requestOwnPasswordChange = (token: string | null) =>
  post("/api/auth/password/change-request", {}, token);

export const completePasswordReset = (token: string, password: string) =>
  post("/api/auth/password/complete", { token, password });

export function describeAuthError(code?: string): string {
  switch (code) {
    case "bad-email":
      return "Digite um e-mail válido.";
    case "bad-username":
      return "Escolha um nome de 2 a 32 caracteres.";
    case "bad-password-format":
      return "A senha precisa ter de 10 a 128 caracteres.";
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
