import assert from "node:assert/strict";
import { renderActionEmail } from "../server/mail.js";

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

console.log("template visual, texto alternativo e escaping dos e-mails: ok");
