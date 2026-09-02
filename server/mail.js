import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { logger } from "./log.js";

const BRAND_NAME = "DracoCall";
const LOGO_CID = "dracocall-logo@dracocall";
const here = dirname(fileURLToPath(import.meta.url));
const logoPath = join(here, "..", "client", "public", "brand", "logo-256.png");
const mailLog = logger("MAIL");

function boolean(value) {
  return /^(1|true|yes)$/i.test(String(value ?? ""));
}

function mailbox(value) {
  const input = String(value ?? "").trim();
  const bracketed = input.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>$/u)?.[1];
  const plain = input.match(/^([^<>\s]+@[^<>\s]+)$/u)?.[1];
  return (bracketed ?? plain ?? "").toLowerCase();
}

function domain(value) {
  return mailbox(value).split("@")[1] ?? "desconhecido";
}

function safeSmtpText(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[endereco]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

/**
 * Respostas que dizem "esta credencial não serve": repetir com a mesma senha dá
 * no mesmo. Um 4xx é o contrário — o servidor está pedindo pra tentar mais tarde.
 */
const AUTH_RESPONSES = new Set([530, 534, 535]);

/**
 * Categoria do erro, que decide se o envio continua valendo. Só credencial
 * recusada é definitiva: tempo esgotado, DNS, conexão cortada ou servidor ainda
 * subindo não dizem nada sobre a requisição seguinte, e desligar o e-mail do
 * processo por causa de uma dessas deixaria os cadastros sem confirmação até
 * alguém reiniciar a máquina. O que não se reconhece conta como temporário.
 */
function smtpCategory(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const response = Number.isInteger(error?.responseCode) ? error.responseCode : null;
  if (code === "EAUTH" || (response !== null && AUTH_RESPONSES.has(response))) return "autenticacao";
  if (code === "ERECIPIENT" || code === "EENVELOPE") return "destinatario";
  // Recusa definitiva de um endereço: é sobre a mensagem, não sobre o servidor.
  if (response !== null && response >= 500 && response < 600) return "destinatario";
  return "temporaria";
}

function smtpFailure(error) {
  return {
    codigo: typeof error?.code === "string" ? error.code : "SMTP_ERROR",
    respostaCodigo: Number.isInteger(error?.responseCode) ? error.responseCode : null,
    comando: typeof error?.command === "string" ? error.command : null,
    categoria: smtpCategory(error),
    resposta: safeSmtpText(error?.response ?? error?.message),
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function actionUrl(value) {
  const parsed = new URL(String(value ?? ""));
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("ação de e-mail inválida");
  return parsed.toString();
}

/**
 * Renderização pura e testável. CSS inline e tabelas são intencionais: Outlook,
 * Gmail e clientes móveis removem boa parte de CSS moderno de uma mensagem.
 */
export function renderActionEmail({
  title,
  text,
  action,
  actionLabel,
  recipientName = null,
  preheader = text,
  details = [],
  expiresIn = null,
  securityNote = "Se você não solicitou esta ação, ignore este e-mail. Sua conta continuará protegida.",
  includeLogo = true,
}) {
  const url = actionUrl(action);
  const safeTitle = escapeHtml(title);
  const safeText = escapeHtml(text);
  const greeting = recipientName ? `Olá, ${recipientName}!` : "Olá!";
  const safeGreeting = escapeHtml(greeting);
  const safeActionLabel = escapeHtml(actionLabel);
  const safeUrl = escapeHtml(url);
  const safeExpires = expiresIn ? escapeHtml(expiresIn) : null;
  const safeSecurity = escapeHtml(securityNote);
  const normalizedDetails = Array.isArray(details)
    ? details
        .filter((detail) => detail?.label && detail?.value !== undefined && detail?.value !== null)
        .slice(0, 6)
        .map((detail) => ({ label: String(detail.label), value: String(detail.value) }))
    : [];

  const detailsHtml = normalizedDetails.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0;border:1px solid #e5e7eb;border-radius:12px;background:#f8f9ff;border-collapse:separate">
        ${normalizedDetails.map((detail, index) => `<tr>
          <td style="padding:${index === 0 ? "16px" : "8px"} 16px ${index === normalizedDetails.length - 1 ? "16px" : "8px"};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#667085;vertical-align:top">${escapeHtml(detail.label)}</td>
          <td style="padding:${index === 0 ? "16px" : "8px"} 16px ${index === normalizedDetails.length - 1 ? "16px" : "8px"};font-size:14px;font-weight:600;color:#1d2939;text-align:right;word-break:break-word">${escapeHtml(detail.value)}</td>
        </tr>`).join("")}
      </table>`
    : "";
  const logo = includeLogo
    ? `<img src="cid:${LOGO_CID}" width="54" height="54" alt="" style="display:block;width:54px;height:54px;border:0;border-radius:14px">`
    : `<div style="width:54px;height:54px;border-radius:14px;background:#ffffff;color:#5865f2;font-size:28px;font-weight:800;line-height:54px;text-align:center">D</div>`;

  const plainDetails = normalizedDetails.map((detail) => `${detail.label}: ${detail.value}`).join("\n");
  const plain = [
    BRAND_NAME,
    title,
    greeting,
    text,
    plainDetails,
    `${actionLabel}: ${url}`,
    expiresIn,
    securityNote,
  ].filter(Boolean).join("\n\n");

  return {
    text: plain,
    html: `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#f2f4f8;color:#101828;font-family:Segoe UI,Arial,sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#f2f4f8">
      <tr>
        <td align="center" style="padding:32px 14px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;border-collapse:separate;border-spacing:0;border-radius:20px;background:#ffffff;box-shadow:0 16px 40px rgba(16,24,40,.10);overflow:hidden">
            <tr>
              <td style="padding:26px 30px;background:#5865f2;background:linear-gradient(135deg,#5865f2,#7c4dff)">
                <table role="presentation" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding-right:14px">${logo}</td>
                    <td>
                      <div style="font-size:22px;font-weight:800;letter-spacing:-.02em;color:#ffffff">${BRAND_NAME}</div>
                      <div style="margin-top:3px;font-size:12px;color:#e8eaff">Voz, vídeo e comunidade em um só lugar</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:34px 30px 30px">
                <div style="font-size:14px;color:#475467">${safeGreeting}</div>
                <h1 style="margin:10px 0 14px;font-size:26px;line-height:1.25;letter-spacing:-.025em;color:#101828">${safeTitle}</h1>
                <p style="margin:0;font-size:15px;line-height:1.7;color:#475467">${safeText}</p>
                ${detailsHtml}
                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0 24px">
                  <tr>
                    <td style="border-radius:10px;background:#5865f2">
                      <a href="${safeUrl}" style="display:inline-block;padding:14px 22px;font-size:15px;font-weight:750;color:#ffffff;text-decoration:none;border-radius:10px">${safeActionLabel}</a>
                    </td>
                  </tr>
                </table>
                ${safeExpires ? `<p style="margin:0 0 18px;font-size:13px;line-height:1.55;color:#667085">${safeExpires}</p>` : ""}
                <div style="padding:14px 16px;border-radius:10px;background:#fff7ed;color:#9a3412;font-size:13px;line-height:1.55">${safeSecurity}</div>
                <p style="margin:24px 0 6px;font-size:12px;line-height:1.55;color:#98a2b3">Se o botão não funcionar, copie e cole este endereço no navegador:</p>
                <p style="margin:0;font-size:12px;line-height:1.55;word-break:break-all"><a href="${safeUrl}" style="color:#5865f2;text-decoration:none">${safeUrl}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 30px;border-top:1px solid #eaecf0;background:#f9fafb;text-align:center;font-size:12px;color:#98a2b3">Mensagem automática de segurança do ${BRAND_NAME}. Não responda a este e-mail.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
  };
}

/** Remetente SMTP. Credenciais ficam só no ambiente da VM. */
export function createMailer(env = process.env, {
  createTransport = (options) => nodemailer.createTransport(options),
  logoAvailable = existsSync(logoPath),
  log = mailLog,
} = {}) {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS?.trim();
  // Para Gmail/Outlook simples, omitir EMAIL_FROM usa a própria conta
  // autenticada e evita um remetente fictício que falha em SPF/DMARC.
  const requestedFrom = env.EMAIL_FROM?.trim();
  const authenticatedAddress = mailbox(user);
  const requestedAddress = mailbox(requestedFrom);
  const gmail = /(^|\.)gmail\.com$|(^|\.)googlemail\.com$/iu.test(host ?? "");
  // Não há como validar aliases do Gmail via SMTP. Se EMAIL_FROM divergir da
  // conta autenticada, usar a própria conta evita From falso e falha de DMARC.
  const adjustedGmailFrom = Boolean(
    gmail && authenticatedAddress && requestedFrom && requestedAddress !== authenticatedAddress,
  );
  const from = adjustedGmailFrom
    ? `${BRAND_NAME} <${authenticatedAddress}>`
    : requestedFrom || (authenticatedAddress ? `${BRAND_NAME} <${authenticatedAddress}>` : "");
  const fromAddress = mailbox(from);
  const port = Number(env.SMTP_PORT ?? 587);
  const validPort = Number.isInteger(port) && port > 0 && port <= 65_535;
  const configured = Boolean(host && user && pass && fromAddress && validPort);
  const implicitTls = boolean(env.SMTP_SECURE) || port === 465;
  const transport = configured
    ? createTransport({
        host,
        port,
        secure: implicitTls,
        ...(!implicitTls ? { requireTLS: true } : {}),
        auth: { user, pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      })
    : null;
  const includeLogo = logoAvailable;
  let available = configured;

  if (adjustedGmailFrom) {
    log.warn("EMAIL_FROM divergente ignorado para o Gmail", {
      remetente: domain(authenticatedAddress),
    });
  }

  return {
    get ready() {
      return available;
    },
    async verify() {
      if (!transport) {
        available = false;
        return false;
      }
      try {
        await transport.verify();
        // Verificação boa também solta um bloqueio anterior: credencial corrigida
        // volta a valer sem reiniciar o processo.
        available = true;
        log.info("SMTP autenticado", {
          servidor: host,
          porta: port,
          tls: implicitTls ? "direto" : "STARTTLS obrigatório",
          remetente: domain(fromAddress),
        });
        return true;
      } catch (error) {
        const detail = smtpFailure(error);
        // Uma falha aqui não prova que o SMTP não serve: o servidor pode estar
        // subindo, o DNS pode demorar, a rede pode ter caído por um minuto. Só
        // credencial recusada bloqueia o envio até a configuração ser corrigida;
        // o resto é tentado de novo quando alguém pedir um e-mail.
        if (detail.categoria === "autenticacao") available = false;
        log.warn("SMTP não verificado", { servidor: host, porta: port, ...detail });
        throw error;
      }
    },
    async send({ to, subject, ...content }) {
      if (!transport) throw new Error("SMTP não está configurado");
      if (!available) throw new Error("SMTP não está disponível: credencial recusada");
      const rendered = renderActionEmail({ ...content, includeLogo });
      let result;
      try {
        result = await transport.sendMail({
          from,
          to,
          subject,
          ...rendered,
          // A conta autenticada recebe eventuais bounces. No uso padrão do
          // Gmail, ela também é o From visível e mantém SPF/DMARC alinhados.
          ...(authenticatedAddress ? { envelope: { from: authenticatedAddress, to } } : {}),
          headers: {
            "Auto-Submitted": "auto-generated",
            "X-Auto-Response-Suppress": "All",
          },
          ...(includeLogo
            ? { attachments: [{ filename: "dracocall.png", path: logoPath, cid: LOGO_CID }] }
            : {}),
        });
        if (!Array.isArray(result.accepted) || result.accepted.length === 0) {
          const rejection = new Error("SMTP não aceitou o destinatário");
          rejection.code = "ERECIPIENT";
          rejection.responseCode = Number.isInteger(result.responseCode) ? result.responseCode : null;
          rejection.response = result.response;
          throw rejection;
        }
      } catch (error) {
        const detail = smtpFailure(error);
        // Credencial revogada não é temporária: o front deixa de anunciar que
        // consegue enviar até a configuração ser corrigida. Falha passageira não
        // bloqueia nada — o pedido seguinte tenta uma vez, como este tentou.
        if (detail.categoria === "autenticacao") available = false;
        log.error("envio SMTP falhou", {
          destinatario: domain(to),
          assunto: subject,
          aceitos: Array.isArray(result?.accepted) ? result.accepted.length : 0,
          rejeitados: Array.isArray(result?.rejected) ? result.rejected.length : 0,
          pendentes: Array.isArray(result?.pending) ? result.pending.length : 0,
          ...detail,
        });
        throw error;
      }
      const delivery = {
        messageId: result.messageId ?? null,
        accepted: result.accepted.length,
        rejected: Array.isArray(result.rejected) ? result.rejected.length : 0,
        pending: Array.isArray(result.pending) ? result.pending.length : 0,
        response: safeSmtpText(result.response),
      };
      log.info("e-mail aceito pelo SMTP; entrega final depende do provedor destinatário", {
        destinatario: domain(to),
        assunto: subject,
        messageId: delivery.messageId,
        aceitos: delivery.accepted,
        rejeitados: delivery.rejected,
        pendentes: delivery.pending,
        resposta: delivery.response,
      });
      return delivery;
    },
  };
}
