import assert from "node:assert/strict";
import { createMailer, renderActionEmail } from "../server/mail.js";

const action = "https://dracocall.duckdns.org/?conta=novo-dispositivo&token=seguro";
const rendered = renderActionEmail({
  title: "Novo acesso <confirmar>",
  text: "Recebemos uma tentativa de login.",
  action,
  actionLabel: "Sim, fui eu",
  recipientName: "Ana <script>alert(1)</script>",
  preheader: "Confirme o novo acesso.",
  details: [
    { label: "Dispositivo", value: "Windows · Chrome" },
    { label: "Endereço IP", value: "203.0.113.10<img src=x>" },
  ],
  expiresIn: "Este link expira em 15 minutos.",
  includeLogo: true,
});

assert.match(rendered.html, /DracoCall/u);
assert.match(rendered.html, /cid:dracocall-logo@dracocall/u);
assert.match(rendered.html, /Novo acesso &lt;confirmar&gt;/u);
assert.match(rendered.html, /Ana &lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
assert.match(rendered.html, /203\.0\.113\.10&lt;img src=x&gt;/u);
assert.equal(rendered.html.includes("<script>alert(1)</script>"), false);
assert.match(rendered.html, /https:\/\/dracocall\.duckdns\.org\//u);
assert.match(rendered.text, /Endereço IP: 203\.0\.113\.10<img src=x>/u);
assert.match(rendered.text, /Sim, fui eu: https:\/\/dracocall\.duckdns\.org\//u);
assert.throws(() => renderActionEmail({
  title: "Inválido",
  text: "Teste",
  action: "javascript:alert(1)",
  actionLabel: "Abrir",
}), /ação de e-mail inválida/u);

const deliveries = [];
const mailer = createMailer({
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "conta@example.test",
  SMTP_PASS: "segredo",
}, {
  logoAvailable: false,
  createTransport: () => ({
    verify: async () => true,
    sendMail: async (mail) => {
      deliveries.push(mail);
      return { accepted: [mail.to], rejected: [], messageId: "mail-test" };
    },
  }),
});
assert.equal(mailer.ready, true, "a própria conta SMTP serve como remetente padrão");
assert.equal(await mailer.verify(), true);
assert.deepEqual(await mailer.send({
  to: "destino@example.test",
  subject: "[DracoCall] Teste",
  title: "Teste de entrega",
  text: "Mensagem transacional.",
  action,
  actionLabel: "Abrir",
}), { messageId: "mail-test", accepted: 1 });
assert.equal(deliveries[0].from, "DracoCall <conta@example.test>");
assert.deepEqual(deliveries[0].envelope, {
  from: "conta@example.test",
  to: "destino@example.test",
});

const unavailable = createMailer({
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "conta@example.test",
  SMTP_PASS: "segredo",
}, {
  logoAvailable: false,
  createTransport: () => ({
    verify: async () => { throw new Error("credencial recusada"); },
    sendMail: async () => { throw new Error("não deveria enviar"); },
  }),
});
await assert.rejects(() => unavailable.verify(), /credencial recusada/u);
assert.equal(unavailable.ready, false, "SMTP recusado não é anunciado como disponível");

const rejected = createMailer({
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "conta@example.test",
  SMTP_PASS: "segredo",
}, {
  logoAvailable: false,
  createTransport: () => ({
    verify: async () => true,
    sendMail: async () => ({ accepted: [], rejected: ["destino@example.test"] }),
  }),
});
await assert.rejects(() => rejected.send({
  to: "destino@example.test",
  subject: "[DracoCall] Teste",
  title: "Teste de entrega",
  text: "Mensagem transacional.",
  action,
  actionLabel: "Abrir",
}), /não aceitou o destinatário/u);

console.log("template, remetente, aceite SMTP e rejeição de destinatário: ok");
