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
const NEW_DEVICE_TTL = 15 * 60 * 1000;

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

function clientMetadata(headers = {}) {
  const userAgent = typeof headers["user-agent"] === "string" ? headers["user-agent"].slice(0, 180) : "Dispositivo desconhecido";
  const desktop = /DracoDesktop/i.test(userAgent);
  const mobile = /Android|iPhone|iPad/i.test(userAgent);
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Firefox\//.test(userAgent) ? "Firefox" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Navegador";
  const platform = /Windows/i.test(userAgent) ? "Windows" : /Android/i.test(userAgent) ? "Android" : /iPhone|iPad/i.test(userAgent) ? "iPhone/iPad" : /Mac OS/i.test(userAgent) ? "macOS" : /Linux/i.test(userAgent) ? "Linux" : "Dispositivo";
  return {
    clientType: desktop ? "desktop" : mobile ? "mobile" : "web",
    deviceName: desktop ? `${platform} · Draco Desktop` : `${platform} · ${browser}`,
  };
}

export function createAccountService({ repository, auth, mailer, colorForName, env = process.env } = {}) {
  const accounts = repository ?? createAccountRepository();
  const origin = appOrigin(env);

  async function actionMail(account, purpose, context = {}) {
    if (!mailer?.ready) return { ok: false, error: "email-unavailable" };
    const raw = createActionToken();
    const setup = purpose === "admin_setup";
    const verify = purpose === "verify_email";
    const newDevice = purpose === "new_device";
    const expiresAt = Date.now() + (newDevice ? NEW_DEVICE_TTL : setup ? SETUP_TTL : verify ? VERIFY_TTL : RESET_TTL);
    if (newDevice) {
      if (!context.addressHash) throw new Error("endereço ausente no desafio de login");
      accounts.createLoginChallenge({
        tokenHash: hashActionToken(raw),
        userId: account.userId,
        addressHash: context.addressHash,
        expiresAt,
        deviceId: context.deviceId,
        deviceCredentialHash: context.deviceCredentialHash,
        clientType: context.clientType,
        deviceName: context.deviceName,
      });
    } else {
      accounts.createToken({
        tokenHash: hashActionToken(raw),
        userId: account.userId,
        purpose,
        expiresAt,
      });
    }

    const actionType = newDevice ? "novo-dispositivo" : setup ? "ativar" : verify ? "verificar" : "senha";
    const action = `${origin}/?conta=${actionType}&token=${encodeURIComponent(raw)}`;
    const passwordChange = purpose === "password_change";
    const copy = verify
      ? {
          subject: "[DracoCall] Confirme seu e-mail",
          title: "Confirme seu e-mail",
          text: "Só falta confirmar que este endereço pertence a você para liberar sua conta no DracoCall.",
          actionLabel: "Confirmar e-mail",
          preheader: "Confirme seu endereço de e-mail para começar a usar o DracoCall.",
          expiresIn: "Este link expira em 24 horas e só pode ser usado uma vez.",
        }
      : newDevice
        ? {
            subject: "[DracoCall] Confirme este novo acesso",
            title: "Novo acesso ao DracoCall",
            text: "Recebemos uma tentativa de login correta em um dispositivo que ainda não foi confirmado.",
            actionLabel: "Sim, fui eu",
            preheader: `Novo acesso em ${context.deviceName}. Confirme somente se foi você.`,
            details: [
              { label: "Dispositivo", value: context.deviceName },
              { label: "Endereço IP", value: context.addressLabel },
            ],
            expiresIn: "Este link expira em 15 minutos e só pode ser usado uma vez.",
            securityNote: "Não reconhece este acesso? Não clique no botão e troque sua senha. Nenhum dispositivo novo será autorizado sem esta confirmação.",
          }
      : setup
        ? {
            subject: "[DracoCall] Ative sua conta de administrador",
            title: "Sua conta de administrador está pronta",
            text: "Defina uma senha forte para ativar a conta principal e começar a administrar o DracoCall.",
            actionLabel: "Definir minha senha",
            preheader: "Ative com segurança a conta principal do DracoCall.",
            expiresIn: "Este link expira em 48 horas e só pode ser usado uma vez.",
          }
        : passwordChange
          ? {
              subject: "[DracoCall] Confirme a alteração da sua senha",
              title: "Altere sua senha com segurança",
              text: "Você solicitou uma nova senha enquanto estava conectado ao DracoCall.",
              actionLabel: "Escolher nova senha",
              preheader: "Use este link seguro para alterar sua senha do DracoCall.",
              expiresIn: "Este link expira em 1 hora e só pode ser usado uma vez.",
            }
          : {
              subject: "[DracoCall] Redefina sua senha",
              title: "Redefinição de senha",
              text: "Recebemos uma solicitação para redefinir a senha da sua conta no DracoCall.",
              actionLabel: "Redefinir minha senha",
              preheader: "Use este link seguro para recuperar sua conta do DracoCall.",
              expiresIn: "Este link expira em 1 hora e só pode ser usado uma vez.",
              securityNote: "Não solicitou a redefinição? Ignore este e-mail. Sua senha atual não será alterada.",
            };
    await mailer.send({ to: account.email, action, recipientName: account.username, ...copy });
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

  function issueDevice(account, addressHash, metadata, preferredToken = null) {
    const deviceToken = preferredToken ?? createActionToken();
    const device = accounts.createDevice({
      userId: account.userId,
      credentialHash: hashActionToken(deviceToken),
      addressHash,
      ...metadata,
    });
    return { device, deviceToken };
  }

  async function login({
    email: rawEmail,
    password,
    deviceToken: presentedDeviceToken,
    legacyDeviceToken = null,
  }, rawAddress, headers = {}) {
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
    const metadata = clientMetadata(headers);
    const presentedHash = typeof presentedDeviceToken === "string" && presentedDeviceToken.length <= 512
      ? hashActionToken(presentedDeviceToken)
      : null;
    let device = presentedHash ? accounts.activeDevice(account.userId, presentedHash) : null;
    const legacyHash = typeof legacyDeviceToken === "string" && legacyDeviceToken.length <= 512
      ? hashActionToken(legacyDeviceToken)
      : null;
    if (!device && presentedHash && legacyHash) {
      const legacyDevice = accounts.activeDevice(account.userId, legacyHash);
      if (legacyDevice && accounts.replaceDeviceCredential(account.userId, legacyDevice.id, presentedHash)) {
        device = accounts.activeDevice(account.userId, presentedHash);
      }
    }
    let deviceToken = null;
    if (device) {
      accounts.touchDevice(account.userId, device.id, addressHash);
    } else {
      const bootstrapToken = createActionToken();
      if (!account.isSystemAdmin) {
        device = accounts.bootstrapDevice({
          userId: account.userId,
          credentialHash: hashActionToken(presentedDeviceToken ?? bootstrapToken),
          addressHash,
          ...metadata,
        });
      }
      if (device && !presentedDeviceToken) deviceToken = bootstrapToken;
    }
    if (!device) {
      const pendingDeviceToken = presentedDeviceToken ?? createActionToken();
      try {
        const sent = await actionMail(account, "new_device", {
          addressHash,
          addressLabel: addressLabel(rawAddress),
          deviceId: randomUUID(),
          deviceCredentialHash: hashActionToken(pendingDeviceToken),
          ...metadata,
        });
        return {
          ok: false,
          error: sent.ok ? "new-device-verification-sent" : "email-unavailable",
          ...(sent.ok && !presentedDeviceToken ? { deviceToken: pendingDeviceToken } : {}),
        };
      } catch (error) {
        return { ok: false, error: "email-failed", detail: error };
      }
    }
    const issued = auth.issue(account.userId, account.sessionVersion);
    accounts.createSession({
      id: issued.sessionId,
      userId: account.userId,
      tokenHash: hashActionToken(issued.token),
      ...metadata,
      deviceId: device.id,
      expiresAt: auth.verify(issued.token).expiresAt,
    });
    return {
      ok: true,
      token: issued.token,
      account: publicAccount(account),
      ...(deviceToken ? { deviceToken } : {}),
    };
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
    const activeSession = signed.sessionId ? accounts.activeSession(signed.sessionId, signed.userId) : null;
    if (signed.sessionId && !activeSession) return null;
    const addressHash = auth.fingerprintAddress(rawAddress);
    if (activeSession?.device_id) accounts.touchDevice(account.userId, activeSession.device_id, addressHash);
    return { ...signed, account };
  }

  function confirmLoginAddress(rawToken) {
    const tokenHash = hashActionToken(rawToken);
    const challenge = accounts.consumeLoginChallenge(tokenHash);
    return challenge ? { ok: true } : { ok: false, error: "token-invalid" };
  }

  async function verifyEmail(rawToken) {
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

  async function completePassword(rawToken, password, rawAddress, headers = {}, deviceToken = null) {
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
    const metadata = clientMetadata(headers);
    const { device, deviceToken: issuedDeviceToken } = issueDevice(
      account, addressHash, metadata, deviceToken,
    );
    const issued = auth.issue(account.userId, account.sessionVersion);
    accounts.createSession({
      id: issued.sessionId,
      userId: account.userId,
      tokenHash: hashActionToken(issued.token),
      ...metadata,
      deviceId: device.id,
      expiresAt: auth.verify(issued.token).expiresAt,
    });
    return {
      ok: true,
      token: issued.token,
      account: publicAccount(account),
      ...(!deviceToken ? { deviceToken: issuedDeviceToken } : {}),
    };
  }

  function listSessions(token, rawAddress) {
    const authenticated = session(token, rawAddress);
    if (!authenticated) return { ok: false, error: "not-authenticated" };
    return {
      ok: true,
      currentSessionId: authenticated.sessionId,
      sessions: accounts.listSessions(authenticated.userId),
    };
  }

  function revokeSession(token, rawAddress, sessionId) {
    const authenticated = session(token, rawAddress);
    if (!authenticated) return { ok: false, error: "not-authenticated" };
    if (typeof sessionId !== "string" || sessionId.length > 64) return { ok: false, error: "bad-request" };
    return { ok: accounts.revokeSession(authenticated.userId, sessionId) };
  }

  function revokeAllSessions(token, rawAddress) {
    const authenticated = session(token, rawAddress);
    if (!authenticated) return { ok: false, error: "not-authenticated" };
    accounts.revokeAllSessions(authenticated.userId);
    return { ok: true };
  }

  function logout(token, rawAddress) {
    const authenticated = session(token, rawAddress);
    if (!authenticated?.sessionId) return { ok: false, error: "not-authenticated" };
    return { ok: accounts.revokeCurrentSession(authenticated.userId, authenticated.sessionId) };
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
    listSessions,
    revokeSession,
    revokeAllSessions,
    logout,
    bootstrapSystemAdmin,
    publicAccount,
    emailReady: Boolean(mailer?.ready),
    close: () => {
      if (accounts.database?.open) accounts.database.close();
    },
  };
}
