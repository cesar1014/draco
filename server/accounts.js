import { randomUUID } from "node:crypto";
import { createAccountRepository } from "./data/account-repository.js";
import {
  createActionToken,
  hashActionToken,
  hashPassword,
  normalizeEmail,
  validPassword,
  verifyPassword,
} from "./passwords.js";
import { sanitizeUsername, validAdultAge } from "./security.js";

const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
const SETUP_TTL = 48 * 60 * 60 * 1000;
const NEW_IP_TTL = 15 * 60 * 1000;

const publicAccount = (account) => ({
  id: account.userId,
  email: account.email,
  username: account.username,
  isSystemAdmin: account.isSystemAdmin,
});

function appOrigin(env) {
  const explicit = env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return (env.ORIGIN?.split(",")[0]?.trim() || "http://localhost:5173").replace(/\/+$/, "");
}

export function createAccountService({ repository, auth, mailer, colorForName, env = process.env } = {}) {
  const accounts = repository ?? createAccountRepository();
  const origin = appOrigin(env);

  async function actionMail(account, purpose, context = {}) {
    if (!mailer?.ready) return { ok: false, error: "email-unavailable" };
    const raw = createActionToken();
    const setup = purpose === "admin_setup";
    const verify = purpose === "verify_email";
    const newIp = purpose === "new_ip";
    const expiresAt = Date.now() + (newIp ? NEW_IP_TTL : setup ? SETUP_TTL : verify ? VERIFY_TTL : RESET_TTL);
    if (newIp) {
      if (!context.addressHash) throw new Error("endereço ausente no desafio de login");
      accounts.createLoginChallenge({
        tokenHash: hashActionToken(raw),
        userId: account.userId,
        addressHash: context.addressHash,
        expiresAt,
      });
    } else {
      accounts.createToken({
        tokenHash: hashActionToken(raw),
        userId: account.userId,
        purpose,
        expiresAt,
      });
    }

    const actionType = newIp ? "novo-ip" : setup ? "ativar" : verify ? "verificar" : "senha";
    const action = `${origin}/?conta=${actionType}&token=${encodeURIComponent(raw)}`;
    const copy = verify
      ? {
          subject: "Confirme seu e-mail no Draco",
          title: "Confirme seu e-mail",
          text: "Confirme que este endereço pertence a você para liberar sua conta.",
          actionLabel: "Confirmar e-mail",
        }
      : newIp
        ? {
            subject: "Confirme um novo endereço de acesso ao Draco",
            title: "Novo endereço de acesso",
            text: `Alguém informou sua senha a partir do IP ${context.addressLabel}. Confirme somente se foi você. O link expira em 15 minutos.`,
            actionLabel: "Confirmar novo IP",
          }
      : setup
        ? {
            subject: "Ative a conta de administrador do Draco",
            title: "Sua conta de administrador está pronta",
            text: "Defina sua senha para ativar a conta principal do Draco.",
            actionLabel: "Definir minha senha",
          }
        : {
            subject: "Confirme a troca de senha do Draco",
            title: "Troca de senha",
            text: "Use este link para escolher uma senha nova. Ele expira em uma hora.",
            actionLabel: "Trocar minha senha",
          };
    await mailer.send({ to: account.email, action, ...copy });
    return { ok: true };
  }

  async function register(
    { email: rawEmail, username: rawUsername, age, password, passwordConfirmation },
    rawAddress,
  ) {
    const email = normalizeEmail(rawEmail);
    const username = sanitizeUsername(rawUsername);
    if (!email) return { ok: false, error: "bad-email" };
    if (!username) return { ok: false, error: "bad-username" };
    if (!validAdultAge(age)) return { ok: false, error: "adult-required" };
    if (!validPassword(password)) return { ok: false, error: "bad-password-format" };
    if (password !== passwordConfirmation) return { ok: false, error: "password-mismatch" };
    if (!mailer?.ready) return { ok: false, error: "email-unavailable" };
    const addressHash = auth.fingerprintAddress(rawAddress);
    if (!addressHash) return { ok: false, error: "address-unavailable" };
    if (accounts.accountByEmail(email)) return { ok: false, error: "email-taken" };
    if (accounts.accountByUsername(username)) return { ok: false, error: "username-taken" };

    const account = accounts.createAccount({
      userId: randomUUID(),
      email,
      username,
      passwordHash: await hashPassword(password),
      color: colorForName(username),
    });
    try {
      await actionMail(account, "verify_email");
    } catch (error) {
      return { ok: false, error: "email-failed", detail: error };
    }
    return { ok: true };
  }

  function addressLabel(rawAddress) {
    const value = typeof rawAddress === "string" ? rawAddress.trim().toLowerCase() : "";
    return value.startsWith("::ffff:") ? value.slice(7) : value;
  }

  function useOrBootstrapAddress(account, addressHash) {
    // Compatibilidade da migração: a conta que já existia antes deste recurso
    // ganha seu primeiro endereço ao apresentar uma sessão ou senha válida.
    return accounts.useOrBootstrapAddress(account.userId, addressHash);
  }

  async function login({ email: rawEmail, password }, rawAddress) {
    const email = normalizeEmail(rawEmail);
    const account = email ? accounts.accountByEmail(email) : null;
    // Mesmo trabalho de hash quando o e-mail não existe reduz a diferença de
    // tempo que denunciaria quais endereços estão cadastrados.
    const fallback = "scrypt$32768$8$3$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const valid = await verifyPassword(password, account?.passwordHash ?? fallback);
    if (!account || !valid || account.disabledAt) return { ok: false, error: "login-failed" };
    if (!account.emailVerifiedAt) {
      // A senha correta prova que não é uma tentativa anônima de bombardear a
      // caixa de outra pessoa. Reemitir aqui resolve o caso comum em que o link
      // do cadastro expirou ou o primeiro envio se perdeu: basta tentar entrar
      // de novo, sem abrir Gmail/Outlook nem depender de um botão escondido.
      try {
        const sent = await actionMail(account, "verify_email");
        return {
          ok: false,
          error: sent.ok ? "email-verification-sent" : "email-unavailable",
        };
      } catch (error) {
        return { ok: false, error: "email-failed", detail: error };
      }
    }
    const addressHash = auth.fingerprintAddress(rawAddress);
    if (!addressHash) return { ok: false, error: "address-unavailable" };
    if (!useOrBootstrapAddress(account, addressHash)) {
      try {
        const sent = await actionMail(account, "new_ip", {
          addressHash,
          addressLabel: addressLabel(rawAddress),
        });
        return {
          ok: false,
          error: sent.ok ? "new-ip-verification-sent" : "email-unavailable",
        };
      } catch (error) {
        return { ok: false, error: "email-failed", detail: error };
      }
    }
    const issued = auth.issue(account.userId, account.sessionVersion);
    return { ok: true, token: issued.token, account: publicAccount(account) };
  }

  function session(token, rawAddress) {
    const signed = auth.verify(token);
    if (!signed) return null;
    const account = accounts.accountById(signed.userId);
    if (
      !account ||
      account.disabledAt ||
      !account.emailVerifiedAt ||
      !account.passwordHash ||
      account.sessionVersion !== signed.sessionVersion
    ) {
      return null;
    }
    const addressHash = auth.fingerprintAddress(rawAddress);
    if (!addressHash || !useOrBootstrapAddress(account, addressHash)) return null;
    return { ...signed, account };
  }

  function confirmLoginAddress(rawToken) {
    const tokenHash = hashActionToken(rawToken);
    const challenge = accounts.consumeLoginChallenge(tokenHash);
    return challenge ? { ok: true } : { ok: false, error: "token-invalid" };
  }

  async function verifyEmail(rawToken, rawAddress) {
    const tokenHash = hashActionToken(rawToken);
    const token = accounts.token(tokenHash);
    if (
      !token ||
      token.purpose !== "verify_email" ||
      token.used_at ||
      token.expires_at <= Date.now()
    ) {
      return { ok: false, error: "token-invalid" };
    }
    if (!accounts.consumeToken(tokenHash)) return { ok: false, error: "token-invalid" };
    accounts.verifyEmail(token.user_id);
    const addressHash = auth.fingerprintAddress(rawAddress);
    if (addressHash) accounts.trustAddress(token.user_id, addressHash);
    return { ok: true };
  }

  async function requestPassword(rawEmail, purpose = "password_reset") {
    const email = normalizeEmail(rawEmail);
    const account = email ? accounts.accountByEmail(email) : null;
    // Resposta deliberadamente igual para endereço existente ou não.
    if (!account || account.disabledAt || !mailer?.ready) return { ok: true };
    const actualPurpose = account.passwordHash ? purpose : "admin_setup";
    await actionMail(account, actualPurpose);
    return { ok: true };
  }

  async function requestOwnPassword(token, rawAddress) {
    const authenticated = session(token, rawAddress);
    if (!authenticated) return { ok: false, error: "not-authenticated" };
    if (!mailer?.ready) return { ok: false, error: "email-unavailable" };
    await actionMail(authenticated.account, "password_change");
    return { ok: true };
  }

  async function completePassword(rawToken, password, rawAddress) {
    if (!validPassword(password)) return { ok: false, error: "bad-password-format" };
    const addressHash = auth.fingerprintAddress(rawAddress);
    if (!addressHash) return { ok: false, error: "address-unavailable" };
    const tokenHash = hashActionToken(rawToken);
    const token = accounts.token(tokenHash);
    if (
      !token ||
      !["password_reset", "password_change", "admin_setup"].includes(token.purpose) ||
      token.used_at ||
      token.expires_at <= Date.now()
    ) {
      return { ok: false, error: "token-invalid" };
    }
    const passwordHash = await hashPassword(password);
    if (!accounts.consumeToken(tokenHash)) return { ok: false, error: "token-invalid" };
    const account = accounts.setPassword(token.user_id, passwordHash);
    accounts.trustAddress(account.userId, addressHash);
    const issued = auth.issue(account.userId, account.sessionVersion);
    return { ok: true, token: issued.token, account: publicAccount(account) };
  }

  async function bootstrapSystemAdmin() {
    const email = normalizeEmail(env.SYSTEM_ADMIN_EMAIL ?? "xcesaryt@gmail.com");
    const username = sanitizeUsername(env.SYSTEM_ADMIN_USERNAME ?? "cesar1014");
    if (!email || !username) return { ok: false, skipped: true };
    const account = accounts.ensureSystemAdmin({
      userId: randomUUID(),
      email,
      username,
      passwordHash: null,
      color: colorForName(username),
    });
    if (account.passwordHash && account.emailVerifiedAt) return { ok: true, active: true, account };
    try {
      const sent = await actionMail(account, "admin_setup");
      return { ok: sent.ok, active: false, emailSent: sent.ok, account };
    } catch (error) {
      return { ok: false, active: false, emailSent: false, account, error };
    }
  }

  return {
    repository: accounts,
    register,
    login,
    session,
    confirmLoginAddress,
    verifyEmail,
    requestPassword,
    requestOwnPassword,
    completePassword,
    bootstrapSystemAdmin,
    publicAccount,
    emailReady: Boolean(mailer?.ready),
  };
}
