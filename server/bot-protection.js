export class BotProtection {
  constructor(env = process.env) {
    this.siteKey = env.TURNSTILE_SITE_KEY?.trim() || null;
    this.secretKey = env.TURNSTILE_SECRET_KEY?.trim() || null;
    if (Boolean(this.siteKey) !== Boolean(this.secretKey)) {
      throw new Error("TURNSTILE_SITE_KEY e TURNSTILE_SECRET_KEY devem ser configuradas juntas");
    }
  }

  get ready() {
    return Boolean(this.siteKey && this.secretKey);
  }

  async verify(token, address, expectedAction) {
    if (!this.ready) return true;
    if (typeof token !== "string" || token.length < 10 || token.length > 2048) return false;
    try {
      const body = new URLSearchParams({
        secret: this.secretKey,
        response: token,
        ...(address ? { remoteip: address } : {}),
      });
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return false;
      const result = await response.json();
      return result.success === true && (!result.action || result.action === expectedAction);
    } catch {
      return false;
    }
  }
}
