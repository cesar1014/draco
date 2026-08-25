# Draco — guia de operação

Como rodar na sua máquina, gerar o `.exe`, chamar amigos por um link e publicar com endereço fixo.
Para a visão geral do projeto, volte ao [README](../README.md).

Voz, webcam e compartilhamento de tela numa call em grupo. A casca tem barra de servidores, canais
de texto e voz, chat, painel do usuário, grade de vídeo e barra de controles da call.

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

## Atalho pelo navegador

O caminho mais curto pra ter o app com cara de programa instalado: janela própria, sem barra de
endereço, ícone no menu Iniciar e na barra de tarefas. Não baixa nada.

Com a página aberta, no **Edge**: menu `⋯` → *Aplicativos* → *Instalar este site como um
aplicativo*. No **Chrome**: menu `⋮` → *Transmitir, salvar e compartilhar* → *Instalar página como
aplicativo*. Costuma aparecer também um ícone de instalar do lado direito da barra de endereço.

No celular é o mesmo caminho: *Adicionar à tela inicial*.

Instalar não cria uma cópia offline — o app continua conversando com o seu servidor. Se o
servidor estiver desligado, o ícone abre numa tela de erro. É atalho, não instalação de verdade.

---

## O app de desktop (o `.exe` de verdade)

O app é uma janela dedicada em volta do **mesmo site** — não uma segunda versão do projeto. O que
só ele tem é privilégio de sistema, e isso muda duas coisas na prática:

- **Seletor de tela com miniaturas dentro do app.** No navegador quem escolhe a janela é o
  diálogo do próprio Chrome, e não há como mudar isso — é barreira de segurança.
- **Áudio do sistema junto com a tela** (só no Windows). O som do jogo ou do vídeo vai com a
  imagem.

### Rodar sem instalar

Dois cliques em **`Abrir o app.bat`**. Na primeira vez ele baixa o Electron, uns 100 MB, e demora.
Depois abre na hora. Pelo terminal é o mesmo:

```bash
npm run app:install
```

```bash
npm run app
```

Pra apontar o app pra um servidor diferente do publicado — o seu localhost, por exemplo:

```bash
npm --prefix desktop start -- --url=http://localhost:5173
```

### Gerar o instalador

```bash
npm run app:build
```

Sai em **`desktop/out/draco-setup-1.0.0.exe`**. Esse arquivo é o que você manda pra quem vai
usar: dois cliques, escolhe a pasta, cria atalho na área de trabalho. Quem instala **não precisa
de Node** nem do projeto — só do endereço do servidor estar no ar.

Três coisas que travam esse comando na primeira vez:

- **`Cannot create symbolic link` no meio do build.** O electron-builder descompacta as
  ferramentas de assinatura e o Windows não deixa criar link simbólico sem permissão. Ligue o
  **Modo de Desenvolvedor** (Configurações → Privacidade e segurança → Para desenvolvedores) ou
  abra o terminal como administrador, e rode de novo.
- **O endereço vai gravado dentro do `.exe`.** Está em `desktop/main.js`, na constante
  `DEFAULT_URL`. Trocou de servidor? Corrija essa linha **antes** de gerar o instalador, senão o
  app instalado continua abrindo o endereço velho.
- **O Windows vai reclamar na instalação.** O instalador não é assinado — assinatura de código
  custa algumas centenas de reais por ano. Aparece a tela azul do SmartScreen: *Mais informações*
  → *Executar assim mesmo*. Avise quem for instalar, ou a pessoa vai achar que é vírus.

---

## O que dá pra fazer

| Ação | Onde |
|---|---|
| Entrar na call | clique num canal sob *Canais de voz* |
| Mutar / desmutar | ícone de microfone no painel de baixo, ou na barra da call |
| Ensurdecer | ícone de fone (também te muta) |
| Ligar a webcam | ícone de câmera na barra da call |
| Compartilhar a tela | ícone de monitor na barra da call, ou na tarja de voz |
| Ver alguém em tela cheia | duplo clique no vídeo da pessoa |
| Dar zoom no vídeo ou na tela | roda do mouse sobre o vídeo; arraste pra passear |
| Espelhar a própria imagem | ícone de espelho no canto do tile, ou engrenagem → *Vídeo* |
| Mudar resolução e FPS durante a transmissão | ícone de controles ao lado do monitor |
| Sair da call | ícone vermelho de telefone |
| Escolher microfone, saída de som e câmera | engrenagem no painel de baixo |
| Ajustar o volume de cada pessoa | engrenagem → *Pessoas* |
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
git init -b main && git add -A && git commit -m "Draco: voz, vídeo e tela"
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

### Servidor em São Paulo

O Render não tem região no Brasil — são cinco (Oregon, Ohio, Virgínia, Frankfurt, Singapura) e a
região não muda depois de criar o serviço. Pra ficar em SP é trocar de plataforma.

Antes de trocar, vale saber o que isso melhora e o que não melhora. A mídia é ponto a ponto e não
encosta no servidor: sair da Virgínia pra SP deixa a página carregar mais rápido, a entrada na
call responder na hora e o chat ficar instantâneo — **não melhora a voz**. Quem melhora a voz é o
**TURN em São Paulo**: quando a conexão direta falha, hoje o seu áudio sobe até os EUA e volta.

#### Opção 1 — Fly.io, região `gru`

A única plataforma barata com datacenter em São Paulo. O `Dockerfile` e o `fly.toml` da raiz já
estão prontos; o `fly.toml` traz `primary_region = "gru"`.

```bash
powershell -c "irm https://fly.io/install.ps1 | iex"
```

Feche e abra o terminal (o instalador põe o `fly` no PATH), crie a conta e suba:

```bash
fly auth signup
```

```bash
fly launch --copy-config --no-deploy
```

Ele pergunta o nome do app — o do arquivo é `draco-sp`, troque se já estiver tomado — e confirma a
região. **Não** deixe ele criar banco de dados nem Redis: não há nada pra guardar.

```bash
fly secrets set ROOM_PASSWORD=suasenha ORIGIN=https://SEU-APP.fly.dev
```

```bash
fly deploy
```

O endereço final é `https://SEU-APP.fly.dev`. Preço: `shared-cpu-1x` de 256 MB em `gru` custa
**US$ 3,14/mês** rodando o mês inteiro — acima dos R$ 10, então o `fly.toml` liga o
`auto_stop_machines`: sem ninguém acessando, a máquina desliga, e máquina parada não é cobrada. Em
uso de algumas horas por dia a conta fica em centavos. Religar leva uns segundos, muito menos que
o meio minuto do plano grátis do Render. Banda de saída é US$ 0,04/GB e a mídia não passa por lá,
então some na conta. Exige cartão cadastrado mesmo gastando pouco.

#### Opção 2 — Oracle Cloud Always Free, grátis pra sempre

Mais trabalho e mais poder: uma máquina Linux sua em São Paulo, de graça, sem prazo de validade —
2 VMs de 1 GB e 10 TB/mês de saída. E como é máquina de verdade, **o TURN pode morar nela**, que é
o ganho que a Opção 1 não dá.

**No painel da Oracle**, o que não tem volta ou quebra tudo se passar batido:

- **Escolha `Brazil East (São Paulo)` como *home region* no cadastro.** Não muda depois, e recurso
  Always Free só existe na home region. Pede cartão pra confirmar identidade; não cobra.
- Crie a instância em *Compute → Instances → Create*: imagem **Ubuntu 22.04**, shape
  **VM.Standard.E2.1.Micro** — o que tem o selo *Always Free*. Baixe a chave SSH que ele oferece
  na hora; depois não dá mais.
- **Abrir porta é em dois lugares.** No painel (*Networking → VCN → Security List → Add Ingress
  Rules*) e no `iptables` de dentro da máquina, que vem com tudo fechado. O script resolve o
  segundo; o primeiro é na mão, e esquecer dele é o motivo clássico de "subiu e não responde".

**HTTPS precisa de domínio** — câmera e microfone não funcionam em `http://` que não seja
localhost. Crie um subdomínio grátis no [DuckDNS](https://www.duckdns.org) apontando pro IP
público da instância. Leva um minuto e é o que faz o certificado sair sozinho.

Daí, dentro da máquina (`ssh -i sua-chave ubuntu@SEU-IP`), o resto é um comando:

```bash
sudo apt update && sudo apt install -y git && git clone https://github.com/SEU-USUARIO/draco.git && cd draco
```

```bash
bash tools/deploy-oracle.sh seu-nome.duckdns.org
```

Ele faz o que a receita manual faria, sem as pegadinhas: 2 GB de swap (1 GB de RAM não aguenta o
build do Vite), Node 22, `npm ci && npm run build`, serviço `draco` no systemd, Caddy pro HTTPS
automático, coturn com `use-auth-secret` e as portas liberadas no `iptables`. No fim imprime o
endereço e **a senha da sala**, que ele mesmo sorteia. Pode rodar de novo à vontade: o `.env` é
preservado, ele só preenche o que estiver em branco.

Duas coisas dele que valem saber:

- **O `external-ip` do coturn.** A Oracle entrega o IP público por NAT, então a VM não conhece o
  próprio endereço. Sem essa linha o TURN anuncia o IP privado e a conexão nunca fecha — o script
  detecta e escreve.
- **O relay usa uma faixa de UDP** (49160–49200). Ela também precisa entrar na Security List,
  junto de 443/tcp e 3478 nos dois protocolos.

No fim, confirme pela engrenagem → *Testar conexão*: tem que aparecer candidato **`relay`**.

#### Depois de mudar de endereço

Três lugares apontam pro servidor antigo e não se corrigem sozinhos:

| Onde | O que fazer |
|---|---|
| `ORIGIN` no servidor novo | a URL nova, exata — é ela que destranca o WebSocket |
| `desktop/main.js`, `DEFAULT_URL` | a URL nova, e gerar o instalador de novo |
| atalho instalado pelo navegador | desinstalar e instalar do endereço novo |

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
  make-brand.mjs      gera a arte do logo (node tools/make-brand.mjs)
  make-icons.mjs      gera os PNG do ícone (npm run icons)
  deploy-oracle.sh    sobe tudo numa VM Ubuntu: build, serviço, HTTPS e TURN
shared/ports.js  as portas de desenvolvimento, num lugar só
```

---

## Limites conhecidos

Malha P2P: cada pessoa envia o próprio vídeo pra todas as outras, então o upload cresce junto com
a call. Até 6–8 pessoas vai bem; acima disso o caminho é um SFU, que é outro projeto.

Não há banco de dados — canais e mensagens vivem na memória do servidor e se perdem ao
reiniciar. Identidade é só um apelido guardado no navegador: não há conta, senha por pessoa, DM,
cargo, reação, upload de arquivo nem notificação push.
