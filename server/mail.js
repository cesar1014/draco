import nodemailer from "nodemailer";

function boolean(value) {
  return /^(1|true|yes)$/i.test(String(value ?? ""));
}

/** Remetente SMTP. Credenciais ficam só no ambiente da VM. */
export function createMailer(env = process.env) {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  const from = env.EMAIL_FROM?.trim();
  const port = Number(env.SMTP_PORT ?? 587);
  const ready = Boolean(host && user && pass && from && Number.isInteger(port));
  const transport = ready
    ? nodemailer.createTransport({
        host,
        port,
        secure: boolean(env.SMTP_SECURE) || port === 465,
        auth: { user, pass },
      })
    : null;

  return {
    ready,
    async verify() {
      if (!transport) return false;
      await transport.verify();
      return true;
    },
    async send({ to, subject, title, text, action, actionLabel }) {
      if (!transport) throw new Error("SMTP não configurado");
      await transport.sendMail({
        from,
        to,
        subject,
        text: `${title}\n\n${text}\n\n${actionLabel}: ${action}\n\nSe você não pediu isto, ignore esta mensagem.`,
        html: `
          <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#111827">
            <h1 style="font-size:24px">${title}</h1>
            <p style="line-height:1.6">${text}</p>
            <p style="margin:28px 0">
              <a href="${action}" style="background:#5865f2;color:white;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">${actionLabel}</a>
            </p>
            <p style="font-size:12px;color:#667085">Se você não pediu isto, ignore esta mensagem.</p>
          </div>
        `,
      });
    },
  };
}
