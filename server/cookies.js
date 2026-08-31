import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "draco_session";
export const DEVICE_COOKIE = "draco_device";
const SECURE_SESSION_COOKIE = "__Host-draco_session";
const SECURE_DEVICE_COOKIE = "__Host-draco_device";
const SESSION_AGE = 30 * 24 * 60 * 60 * 1000;
const DEVICE_AGE = 365 * 24 * 60 * 60 * 1000;

export function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== "string") return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    try {
      cookies.set(name, decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // Cookie malformado é ignorado como uma credencial inválida.
    }
  }
  return cookies;
}

const options = (secure, maxAge) => ({
  httpOnly: true,
  secure,
  sameSite: "strict",
  path: "/",
  maxAge,
});

export function sessionCookie(header) {
  const cookies = parseCookies(header);
  return cookies.get(SECURE_SESSION_COOKIE) ?? cookies.get(SESSION_COOKIE) ?? null;
}

export function setSessionCookie(res, token, secure) {
  res.cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, token, options(secure, SESSION_AGE));
}

export function clearSessionCookie(res, secure) {
  res.clearCookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, options(secure, 0));
  if (secure) res.clearCookie(SESSION_COOKIE, options(true, 0));
}

export function ensureDeviceCookie(req, res, secure) {
  const cookies = parseCookies(req.headers.cookie);
  const current = cookies.get(SECURE_DEVICE_COOKIE) ?? cookies.get(DEVICE_COOKIE);
  if (typeof current === "string" && /^[A-Za-z0-9_-]{43}$/u.test(current)) return current;
  const created = randomBytes(32).toString("base64url");
  res.cookie(secure ? SECURE_DEVICE_COOKIE : DEVICE_COOKIE, created, options(secure, DEVICE_AGE));
  return created;
}
