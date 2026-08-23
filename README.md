# Cópia do Discord

Voz, webcam e compartilhamento de tela funcionando de verdade, dentro de uma casca visualmente
fiel ao Discord: barra de servidores, canais de texto e voz, chat, painel do usuário, grade de
vídeo e barra de controles da call.

WebRTC em malha (cada pessoa conecta direto com cada pessoa), pensado pra **6–8 pessoas por
call**. Servidor Node só faz sinalização e chat — a mídia nunca passa por ele.

---

## Rodar agora, na sua máquina

Dê dois cliques em **`Iniciar local.bat`**. Na primeira vez ele instala as dependências sozinho.

Ou pelo terminal:

```bash
npm install
```

```bash
npm run dev
```

Abra **http://localhost:5173**. Digite um apelido e clique em *Entrar*.

Para experimentar a call sozinho, abra o mesmo endereço numa **segunda janela** do navegador
(`Ctrl+Shift+N` pra janela anônima serve bem) e entre com outro apelido. Coloque as duas no
canal **Geral** da seção *Canais de voz*: uma vai ouvir a outra.

> Use fone nas duas janelas, ou o microfone de uma vai captar o som da outra e realimentar.

Enquanto `npm run dev` está de pé, o servidor de sinalização fica na porta 3100 e a página na
5173. As duas portas estão num único lugar — `shared/ports.js`.

Precisa de Node.js 20 ou mais novo:

```bash
winget install --id OpenJS.NodeJS.LTS
```

---

## Instalar como aplicativo no Windows

Não é um `.exe` — é um app web, e isso é a favor de você. Mas dá pra deixar com cara de programa
instalado: janela própria, sem barra de endereço, ícone no menu Iniciar e na barra de tarefas.

Com a página aberta, no **Edge**: menu `⋯` → *Aplicativos* → *Instalar este site como um
aplicativo*. No **Chrome**: menu `⋮` → *Transmitir, salvar e compartilhar* → *Instalar página como
aplicativo*. Costuma aparecer também um ícone de instalar do lado direito da barra de endereço.

No celular é o mesmo caminho: *Adicionar à tela inicial*.

Instalar não cria uma cópia offline — o app continua conversando com o seu servidor. Se o
servidor estiver desligado, o ícone abre numa tela de erro. É atalho, não instalação de verdade.

---

## O que dá pra fazer

| Ação | Onde |
|---|---|
| Entrar na call | clique num canal sob *Canais de voz* |
| Mutar / desmutar | ícone de microfone no painel de baixo, ou na barra da call |
| Ensurdecer | ícone de fone (também te muta, igual ao Discord) |
| Ligar a webcam | ícone de câmera na barra da call |
| Compartilhar a tela | ícone de monitor na barra da call, ou na tarja de voz |
| Ver alguém em tela cheia | duplo clique no vídeo da pessoa |
| Sair da call | ícone vermelho de telefone |
| Escolher microfone, saída de som e câmera | engrenagem no painel de baixo |
| Ajustar o volume de cada pessoa | engrenagem → *Volume das pessoas* |
| Testar se a conexão atravessa | engrenagem → *Testar conexão* |

Mutar desliga a faixa de áudio sem derrubar a conexão, então voltar a falar é instantâneo.
Ligar câmera ou tela também não renegocia nada: os quatro canais de mídia (microfone, câmera,
tela, áudio da tela) já nascem prontos em cada conexão e só trocam de conteúdo.

---

## Usar com amigos pela internet

**Seus amigos não baixam nada.** Eles abrem um link no navegador e usam. Nada de instalar, criar
conta ou configurar — é só o link, o apelido e o canal de voz.

Quem precisa deixar algo ligado é você: o servidor roda na *sua* máquina, e o link só funciona
enquanto ele estiver de pé.

Dê dois cliques em **`Abrir para amigos.bat`** e espere aparecer a linha com
`https://alguma-coisa.trycloudflare.com`. Esse é o link que você manda.

Pelo terminal, é o mesmo:

```bash
npm run build && npm run share
```

Um túnel dá HTTPS de graça, sem abrir porta no roteador e sem certificado. HTTPS não é frescura:
o navegador só libera câmera e microfone em origem segura.

**Instalar o cloudflared** (é ele que cria o link), se ainda não tiver:

```bash
winget install --id Cloudflare.cloudflared
```

**Ponha senha na sala.** Sem senha, qualquer um com o link entra na sua call. Copie
`.env.example` para `.env` e preencha:

```
ROOM_PASSWORD=escolha-uma-senha
```

Reinicie depois de editar o `.env`. O campo de senha aparece sozinho na tela de entrada quando
`ROOM_PASSWORD` está preenchido. Mande a senha pros amigos por outro caminho, não junto do link.

### O que muda pra quem entra

| | você | seus amigos |
|---|---|---|
| Baixar algo | sim, este projeto | **não** |
| Node.js instalado | sim | não |
| Deixar janela aberta | sim, senão o link morre | não |
| O que faz | roda o `.bat` e manda o link | abre o link, escolhe apelido, entra na call |

### Duas coisas que incomodam nesse esquema

O endereço do túnel gratuito **muda a cada vez** que você abre. Se fechar a janela e abrir de
novo, o link antigo morre e você precisa mandar o novo.

E o servidor depende do seu PC estar ligado. Se quiser um endereço fixo que funcione sem você
fazer nada, veja a seção seguinte.

---

## Publicar com endereço fixo

O túnel serve pra jogar hoje à noite. Se você quer um link que não muda e funciona com seu PC
desligado, o app precisa morar num servidor.

### Vercel não serve pra isso

Vercel, Netlify e afins são *serverless*: a função acorda, responde uma requisição e morre. Este
app precisa do contrário — um processo de pé o tempo todo, por dois motivos que não têm
contorno:

- **WebSocket.** A sinalização do WebRTC é uma conexão aberta e contínua, que é exatamente o que
  uma função serverless não sustenta.
- **Estado em memória.** Quem está em qual canal, e as mensagens, vivem dentro do processo. Com
  várias instâncias que nascem e morrem, cada requisição cairia numa memória diferente.

Você conseguiria publicar a *página* na Vercel, mas o servidor de voz teria que ficar em outro
lugar de qualquer jeito. Melhor manter os dois juntos.

### Render, plano grátis

Precisa de plataforma que rode processo contínuo: **Render**, Fly.io, Railway ou Koyeb. Render
é a mais direta e o plano grátis já dá HTTPS num endereço fixo `https://seu-app.onrender.com`.

O `render.yaml` na raiz já descreve o serviço inteiro, então não há formulário pra preencher.

**1. Ponha o projeto no GitHub.** É de lá que o Render lê o código. Uma vez só:

```bash
git init -b main && git add -A && git commit -m "Cópia do Discord: voz, vídeo e tela"
```

Crie um repositório vazio em https://github.com/new — pode ser **privado**, o Render lê
repositório privado depois de você autorizar a conta. Não marque nenhuma opção de adicionar
README ou `.gitignore`. Depois, com a URL que o GitHub mostrar:

```bash
git remote add origin https://github.com/SEU-USUARIO/SEU-REPO.git && git push -u origin main
```

**2. No Render:** entre com a conta do GitHub em https://dashboard.render.com → **New** →
**Blueprint** → escolha o repositório. Ele acha o `render.yaml` e pede uma coisa só:

| Variável | O que pôr |
|---|---|
| `ROOM_PASSWORD` | uma senha pra sala — **ponha uma**, o link vai ser público |

Clique em **Apply**. O primeiro build leva alguns minutos. Quando terminar, o endereço aparece no
topo da página do serviço — esse é o link definitivo dos seus amigos.

**3. Agora que o endereço existe**, abra *Environment* no painel do serviço e adicione duas
variáveis. As duas ficaram fora do `render.yaml` justamente porque dependem desse endereço:

| Variável | O que pôr |
|---|---|
| `ORIGIN` | `https://seu-app.onrender.com` — tranca o servidor pra aceitar só a sua página |
| `TURN_CREDENTIALS_URL` | a URL do Open Relay, logo abaixo |

Salvar reinicia o serviço sozinho. Sem `ORIGIN` o app funciona igual, só aceitando conexão de
qualquer origem.

### Configure TURN antes de chamar os amigos

Na sua rede local tudo conecta. Pela internet, **cerca de uma em cada cinco duplas não conecta
sem TURN** — e é a hora em que alguém fica em *Conectando…* pra sempre. Num projeto que vai pra
internet isso não é opcional.

O Open Relay dá 20 GB/mês grátis: crie conta em https://dashboard.metered.ca/, pegue a chave de
API e monte a URL:

```
https://SEU-APP.metered.live/api/v1/turn/credentials?apiKey=SUA-CHAVE
```

A chave fica no servidor e nunca chega ao navegador de ninguém. Depois de subir, confirme na
engrenagem → *Testar conexão*: tem que aparecer candidato **`relay`**.

### O preço do plano grátis

Duas coisas pra saber antes de escolher:

- **Dorme sozinho.** Sem ninguém acessando por ~15 minutos, o Render desliga o serviço. O
  próximo acesso religa, e essa primeira carga demora bem — meio minuto ou mais. Depois disso
  fica normal. Avise os amigos, ou pague o plano mais barato, que não dorme.
- **Reiniciar apaga o chat.** Não há banco de dados: as mensagens estão na memória do processo.
  Dormir, acordar ou publicar uma alteração zera o histórico. Voz e vídeo não se importam.

Nada disso afeta a qualidade da call: a mídia vai direto de uma pessoa pra outra e nunca passa
pelo Render.

---

## Testar no celular e em outro PC da casa

Na rede local não há como usar `localhost`, e sem HTTPS o celular não libera a câmera. Este
comando gera um certificado autoassinado (em `server/certs/`) e sobe HTTPS:

```bash
npm run lan
```

O terminal imprime o endereço da sua máquina na rede, algo como
`https://192.168.0.15:3100`. Abra no celular, aceite o aviso de "conexão não privada" — é o seu
próprio certificado — e entre. Precisa aceitar uma vez por aparelho.

---

## TURN: quando a call não conecta

Só STUN resolve rede local e a maioria das redes domésticas. Cerca de uma em cada cinco conexões
pela internet falha sem TURN — NAT simétrico, Wi-Fi corporativo, 4G. O sintoma é a pessoa
aparecer no canal e ficar em *Conectando…* pra sempre.

A engrenagem → *Conexão* mostra em que pé você está, e *Testar conexão* faz uma coleta real de
candidatos: `relay` significa TURN funcionando, `srflx` significa só STUN, nada significa rede
bloqueando UDP.

Três modos de configurar, no `.env` — escolha um:

1. **Credencial fixa** (`TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD`) — Cloudflare, Twilio,
   coturn com usuário estático.
2. **Credencial buscada em runtime** (`TURN_CREDENTIALS_URL`) — o caminho do Open Relay, que tem
   20 GB/mês grátis. Sua chave de API fica no servidor e nunca chega ao navegador.
3. **coturn com `use-auth-secret`** (`TURN_HOST`, `TURN_SECRET`) — o servidor assina credenciais
   temporárias por HMAC. Pra quem hospeda o próprio coturn.

`.env.example` tem o detalhe de cada campo. `TURN_ONLY=1` força todo o tráfego pelo relay — útil
só pra confirmar que o TURN funciona, porque gasta banda do provedor.

---

## Verificar que o núcleo funciona

Dois testes automáticos, nenhum deles precisa de uma segunda pessoa nem de câmera.

O servidor de sinalização (relay, presença de voz, senha, rate limit):

```bash
npm run test:server
```

O núcleo WebRTC, numa aba só — duas conexões independentes com mídia sintética, provando que a
mídia flui, que mutar derruba o nível de áudio do outro lado e que ligar a tela **não**
renegocia:

http://localhost:5173/?selftest=1

E os tipos:

```bash
npm run typecheck
```

### O teste que só você pode fazer

Automação não fala no microfone nem aponta a webcam. Em dois aparelhos de verdade, no mesmo canal
de voz, confirme:

- áudio nos dois sentidos;
- mutar em A → o ícone de mute aparece na hora em B, e B para de ouvir;
- desmutar → volta a ouvir sem cortar nada;
- ensurdecer em A → A para de ouvir e fica mudo pros outros;
- webcam de A aparece em B, e desligar remove o tile;
- tela de A aparece em B com o texto legível, e o botão *Parar de compartilhar* do navegador
  também encerra pelo app;
- trocar de canal de texto no meio da call **não** corta o áudio.

Faça primeiro na rede local (`npm run lan`), depois pela internet (túnel) — são caminhos de rede
diferentes e falham por motivos diferentes.

---

## Estrutura

```
Iniciar local.bat        atalho: sobe o app só nesta máquina
Abrir para amigos.bat    atalho: build + servidor + túnel, imprime o link
render.yaml              descreve o serviço pra publicar no Render
server/
  index.js       Express + Socket.IO + HTTPS opcional + serve a build
  signaling.js   relay de rtc:signal, presença de voz, chat
  ice.js         monta os iceServers (3 modos de TURN)
  state.js       guilds, canais, mensagens, presença — em memória
  security.js    sanitização, rate limit por socket, senha da sala
client/
  index.html
  public/        manifest e ícones do app instalável
  src/
    rtc/           VoiceEngine, MediaManager, SpeakingDetector, iceConfig
    state/store.ts estado da aplicação (zustand)
    components/    a interface
    dev/           autoteste do WebRTC
tools/
  test-signaling.mjs  testes do servidor
  make-icons.mjs      gera os PNG do ícone (npm run icons)
shared/ports.js  as portas de desenvolvimento, num lugar só
```

---

## Limites conhecidos

Malha P2P: cada pessoa envia o próprio vídeo pra todas as outras, então o upload cresce junto com
a call. Até 6–8 pessoas vai bem; acima disso o caminho é um SFU, que é outro projeto.

Não há banco de dados — canais e mensagens vivem na memória do servidor e se perdem ao
reiniciar. Identidade é só um apelido guardado no navegador: não há conta, senha por pessoa, DM,
cargo, reação, upload de arquivo nem notificação push.
