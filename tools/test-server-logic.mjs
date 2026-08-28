/**
 * Lógica de servidor que não precisa de socket nem de banco.
 *
 * São as regras que erram calado: um backoff que não cresce prende a sala em STUN
 * até alguém recarregar a página, e um balde de limite que repõe do jeito errado
 * transforma a senha da sala em algo que se adivinha. Nenhuma das duas aparece
 * num teste de integração, porque as duas "funcionam" — só funcionam mal.
 *
 *   node tools/test-server-logic.mjs
 */
import assert from "node:assert/strict";
// O log da recuperação de TURN é informativo, e aqui ele só encheria a saída do
// teste. Definido antes do import: o módulo lê o nível uma vez, ao carregar.
process.env.LOG_LEVEL ??= "error";
const { RateLimiter, sanitizeChannelName, sanitizeGuildName, sanitizeReason } = await import(
  "../server/security.js"
);
const { invalidateIceCache, resolveIceConfig } = await import("../server/ice.js");

let passed = 0;
let failed = 0;

async function test(label, run) {
  try {
    await run();
    passed += 1;
    console.log(`PASS  ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${label}\n        ${error.message}`);
  }
}

/**
 * Provedor de TURN de mentira, no lugar do `fetch` global. Conta quantas vezes foi
 * chamado: é essa contagem que revela se o backoff está funcionando.
 */
function fakeTurnProvider({ failTimes = 0, ttl = null } = {}) {
  const state = { calls: 0, failures: failTimes };
  globalThis.fetch = async () => {
    state.calls += 1;
    if (state.failures > 0) {
      state.failures -= 1;
      throw new Error("provedor fora do ar");
    }
    return {
      ok: true,
      json: async () => ({
        iceServers: [{ urls: "turn:exemplo.test:3478", username: "u", credential: "c" }],
        ...(ttl ? { ttl } : {}),
      }),
    };
  };
  return state;
}

const originalFetch = globalThis.fetch;
const REST_ENV = { TURN_CREDENTIALS_URL: "https://exemplo.test/creds" };

await test("TURN indisponível cai pra STUN e volta quando o provedor responde", async () => {
  invalidateIceCache();
  const provider = fakeTurnProvider({ failTimes: 1 });

  const first = await resolveIceConfig(REST_ENV);
  assert.equal(first.hasTurn, false, "sem credencial, segue só com STUN");
  assert.match(first.warning, /STUN/);

  // O backoff impede a segunda tentativa imediata: sem isso, cada pessoa que
  // abrisse a página renderia uma requisição ao provedor que está fora do ar.
  await resolveIceConfig(REST_ENV);
  assert.equal(provider.calls, 1, "a tentativa seguinte espera o backoff");

  // Passado o prazo, tenta de novo — e é isso que tira a sala do STUN sem
  // ninguém precisar recarregar nada.
  invalidateIceCache();
  const recovered = await resolveIceConfig(REST_ENV);
  assert.equal(provider.calls, 2);
  assert.equal(recovered.hasTurn, true, "credencial nova é usada assim que chega");
  assert.equal(recovered.warning, null);
});

await test("credencial válida é reaproveitada em vez de pedida a cada chamada", async () => {
  invalidateIceCache();
  const provider = fakeTurnProvider();

  await resolveIceConfig(REST_ENV);
  await resolveIceConfig(REST_ENV);
  await resolveIceConfig(REST_ENV);
  assert.equal(provider.calls, 1, "uma busca serve enquanto a credencial vale");
});

await test("credencial vencida não é entregue", async () => {
  invalidateIceCache();
  fakeTurnProvider({ ttl: 1 });

  const config = await resolveIceConfig(REST_ENV);
  assert.equal(config.hasTurn, true);
  // `expiresAt` é o que o cliente usa pra saber quando renovar. Sem ele, uma
  // credencial de uma hora ficaria guardada na aba pra sempre.
  assert.ok(config.expiresAt !== null, "o prazo vai na resposta");
  assert.ok(config.expiresAt - Date.now() <= 1000);
});

await test("TURN_ONLY sem TURN configurado avisa que nada vai conectar", async () => {
  invalidateIceCache();
  const config = await resolveIceConfig({ TURN_ONLY: "1" });
  assert.equal(config.iceTransportPolicy, "relay");
  assert.match(config.warning, /TURN_ONLY/);
});

globalThis.fetch = originalFetch;

await test("errar a senha esgota as tentativas; acertar não custa nada", async () => {
  const limiter = new RateLimiter();
  const key = "ip:1.2.3.4:identifyFailed";
  const burst = 5;

  // Uma entrada legítima gasta um token e devolve, então o balde nunca baixa.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(limiter.allow(key, burst, 0.1), true, "entrada legítima nunca é barrada");
    limiter.refund(key, burst);
  }

  // Tentativas recusadas não devolvem nada, e o balde acaba.
  for (let attempt = 0; attempt < burst; attempt += 1) {
    assert.equal(limiter.allow(key, burst, 0.1), true);
  }
  assert.equal(limiter.allow(key, burst, 0.1), false, "força bruta esbarra no limite");
});

await test("o balde é por escopo: reconectar não zera o limite de ninguém", () => {
  const limiter = new RateLimiter();
  // Duas identidades diferentes não dividem balde.
  assert.equal(limiter.allow("user:a:chat", 1, 0), true);
  assert.equal(limiter.allow("user:a:chat", 1, 0), false);
  assert.equal(limiter.allow("user:b:chat", 1, 0), true);
  // E o mesmo escopo continua limitado, que é o ponto de não usar o id do socket.
  assert.equal(limiter.allow("user:a:chat", 1, 0), false);
});

await test("refund não estoura o teto do balde", () => {
  const limiter = new RateLimiter();
  limiter.allow("user:c:admin", 2, 0);
  for (let i = 0; i < 10; i += 1) limiter.refund("user:c:admin", 2);
  assert.equal(limiter.allow("user:c:admin", 2, 0), true);
  assert.equal(limiter.allow("user:c:admin", 2, 0), true);
  assert.equal(limiter.allow("user:c:admin", 2, 0), false, "o balde não passa do tamanho dele");
});

await test("nome de canal de texto vira apelidável; o de voz mantém a escrita", () => {
  assert.equal(sanitizeChannelName("  Bate  Papo!!  ", "text"), "bate-papo");
  assert.equal(sanitizeChannelName("Sala de Jogo", "voice"), "Sala de Jogo");
  assert.equal(sanitizeChannelName("!!!", "text"), null, "nome que vira vazio é recusado");
  assert.equal(sanitizeChannelName("--x--", "text"), "x", "hífen de sobra não fica na ponta");
  assert.equal(sanitizeGuildName(" a "), null, "servidor precisa de duas letras");
  assert.equal(sanitizeReason(""), null, "motivo vazio é ausência, não texto vazio");
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exitCode = failed === 0 ? 0 : 1;
