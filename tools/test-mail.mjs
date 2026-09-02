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
const smtpOptions = [];
const mailEvents = [];
const testLog = Object.fromEntries(
  ["info", "warn", "error"].map((level) => [level, (message, detail) => {
    mailEvents.push({ level, message, detail });
  }]),
);
const mailer = createMailer({
  SMTP_HOST: "smtp.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "conta@example.test",
  SMTP_PASS: "segredo",
}, {
  logoAvailable: false,
  log: testLog,
  createTransport: (options) => {
    smtpOptions.push(options);
    return {
    verify: async () => true,
    sendMail: async (mail) => {
      deliveries.push(mail);
      return {
        accepted: [mail.to], rejected: [], messageId: "mail-test",
        response: "250 2.0.0 enfileirado",
      };
    },
    };
  },
});
assert.equal(mailer.ready, true, "a própria conta SMTP serve como remetente padrão");
assert.equal(await mailer.verify(), true);
assert.equal(smtpOptions[0].requireTLS, true, "STARTTLS é obrigatório fora da porta 465");
assert.deepEqual(await mailer.send({
  to: "destino@example.test",
  subject: "[DracoCall] Teste",
  title: "Teste de entrega",
  text: "Mensagem transacional.",
  action,
  actionLabel: "Abrir",
}), {
  messageId: "mail-test",
  accepted: 1,
  rejected: 0,
  pending: 0,
  response: "250 2.0.0 enfileirado",
});
assert.equal(deliveries[0].from, "DracoCall <conta@example.test>");
assert.deepEqual(deliveries[0].envelope, {
  from: "conta@example.test",
  to: "destino@example.test",
});
assert.equal(deliveries[0].headers["Auto-Submitted"], "auto-generated");
const acceptedEvent = mailEvents.find((event) => event.message.includes("entrega final depende"));
assert.equal(acceptedEvent.detail.aceitos, 1);
assert.equal(acceptedEvent.detail.rejeitados, 0);
assert.equal(acceptedEvent.detail.resposta, "250 2.0.0 enfileirado");

const mail = {
  subject: "[DracoCall] Teste",
  title: "Teste de entrega",
  text: "Mensagem transacional.",
  action,
  actionLabel: "Abrir",
};

const unavailable = createMailer({
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "conta@example.test",
  SMTP_PASS: "segredo",
}, {
  logoAvailable: false,
  log: testLog,
  createTransport: () => ({
    verify: async () => {
      const error = new Error("535 5.7.8 credencial recusada");
      error.code = "EAUTH";
      error.responseCode = 535;
      throw error;
    },
    sendMail: async () => { throw new Error("não deveria enviar"); },
  }),
});
await assert.rejects(() => unavailable.verify(), /credencial recusada/u);
assert.equal(unavailable.ready, false, "credencial recusada não é anunciada como disponível");
await assert.rejects(
  () => unavailable.send({ to: "destino@example.test", ...mail }),
  /credencial recusada/u,
  "credencial recusada bloqueia o envio em vez de tentar",
);

// Uma falha passageira no boot não pode desligar o e-mail do processo inteiro.
const flaky = createMailer({
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "conta@example.test",
  SMTP_PASS: "segredo",
}, {
  logoAvailable: false,
  log: testLog,
  createTransport: () => ({
    verify: async () => {
      const error = new Error("connect ETIMEDOUT 203.0.113.9:587");
      error.code = "ETIMEDOUT";
      error.command = "CONN";
      throw error;
    },
    sendMail: async (message) => ({
      accepted: [message.to],
      rejected: [],
      messageId: "flaky-test",
      response: "250 2.0.0 enfileirado",
    }),
  }),
});
await assert.rejects(() => flaky.verify(), /ETIMEDOUT/u);
assert.equal(flaky.ready, true, "SMTP fora do ar no boot continua disponível para novas tentativas");
const bootEvent = mailEvents.findLast((event) => event.message === "SMTP não verificado");
assert.equal(bootEvent.detail.categoria, "temporaria");
assert.equal(bootEvent.detail.codigo, "ETIMEDOUT");
assert.equal(bootEvent.detail.comando, "CONN");
assert.equal(
  JSON.stringify(bootEvent.detail).includes("segredo"),
  false,
  "o diagnóstico do boot não carrega a senha",
);
assert.equal(
  (await flaky.send({ to: "destino@example.test", ...mail })).accepted,
  1,
  "a requisição seguinte tenta enviar uma vez, sem depender do boot",
);

const rejected = createMailer({
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "conta@example.test",
  SMTP_PASS: "segredo",
}, {
  logoAvailable: false,
  log: testLog,
  createTransport: () => ({
    verify: async () => true,
    sendMail: async () => ({
      accepted: [],
      rejected: ["destino@example.test"],
      response: "550 destino@example.test recusado",
    }),
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
const failedEvent = mailEvents.findLast((event) => event.message === "envio SMTP falhou");
assert.equal(failedEvent.detail.destinatario, "example.test");
assert.equal(failedEvent.detail.aceitos, 0);
assert.equal(failedEvent.detail.rejeitados, 1);
assert.equal(failedEvent.detail.resposta.includes("destino@example.test"), false, "logs não vazam o destinatário");

const revokedCredential = createMailer({
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "conta@example.test",
  SMTP_PASS: "senha-revogada",
}, {
  logoAvailable: false,
  log: testLog,
  createTransport: () => ({
    verify: async () => true,
    sendMail: async () => {
      const error = new Error("535 5.7.8 credenciais recusadas");
      error.code = "EAUTH";
      error.responseCode = 535;
      throw error;
    },
  }),
});
await assert.rejects(() => revokedCredential.send({
  to: "destino@example.test",
  subject: "[DracoCall] Teste",
  title: "Teste",
  text: "Mensagem transacional.",
  action,
  actionLabel: "Abrir",
}), /credenciais recusadas/u);
assert.equal(revokedCredential.ready, false, "credencial SMTP revogada deixa de ser anunciada como pronta");

const gmailDeliveries = [];
const gmailMailer = createMailer({
  SMTP_HOST: "smtp.gmail.com",
  SMTP_PORT: "587",
  SMTP_USER: "conta@gmail.com",
  SMTP_PASS: "senha-de-app",
  EMAIL_FROM: "DracoCall <nao-verificado@outro.example>",
}, {
  logoAvailable: false,
  log: testLog,
  createTransport: () => ({
    verify: async () => true,
    sendMail: async (mail) => {
      gmailDeliveries.push(mail);
      return { accepted: [mail.to], rejected: [], messageId: "gmail-test" };
    },
  }),
});
await gmailMailer.send({
  to: "destino@example.test",
  subject: "[DracoCall] Teste Gmail",
  title: "Teste",
  text: "Mensagem transacional.",
  action,
  actionLabel: "Abrir",
});
assert.equal(gmailDeliveries[0].from, "DracoCall <conta@gmail.com>", "Gmail não usa From divergente");
assert.equal(mailEvents.some((event) => event.message === "EMAIL_FROM divergente ignorado para o Gmail"), true);

console.log("template, TLS, remetente alinhado, diagnóstico e rejeição SMTP: ok");
