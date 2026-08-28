import { useEffect, useMemo, useState } from "react";
import { CloseIcon, ScreenIcon } from "@/components/Icons";
import {
  desktopPlatform,
  isDesktopApp,
  listDesktopSources,
  type DesktopSource,
} from "@/desktop";
import {
  CAMERA_RESOLUTIONS,
  FRAME_RATES,
  SCREEN_CONTENTS,
  SCREEN_RESOLUTIONS,
  cameraBitrate,
  screenBitrate,
  type CameraResolution,
  type FrameRate,
  type ScreenContent,
  type ScreenResolution,
} from "@/rtc/MediaManager";
import { membersInVoice, useStore } from "@/state/store";

const RESOLUTION_LABEL: Record<ScreenResolution, string> = {
  "720": "720p",
  "1080": "1080p",
  source: "Nativa",
};

const CAMERA_LABEL: Record<CameraResolution, string> = {
  "360": "360p",
  "480": "480p",
  "720": "720p",
  "1080": "1080p",
};

const CONTENT_LABEL: Record<ScreenContent, string> = {
  auto: "Automático",
  game: "Jogo e vídeo",
  text: "Texto e código",
};

const CONTENT_HINT: Record<ScreenContent, string> = {
  auto: "Deixa o codec decidir pelo que está aparecendo na tela.",
  game: "Quando a banda aperta, perde nitidez pra continuar fluindo.",
  text: "Quando a banda aperta, perde quadros pra continuar legível.",
};

const mbps = (bits: number) => (bits / 1_000_000).toFixed(1).replace(".", ",");

export function ScreenShareModal() {
  const screenOptions = useStore((state) => state.screenOptions);
  const screenOn = useStore((state) => state.screenOn);
  const camOn = useStore((state) => state.camOn);
  const camera = useStore((state) => state.settings.camera);
  const mirrorSelf = useStore((state) => state.settings.mirrorSelf);
  const applySettings = useStore((state) => state.applySettings);
  const startScreen = useStore((state) => state.startScreen);
  const setScreenOptions = useStore((state) => state.setScreenOptions);
  const toggleScreen = useStore((state) => state.toggleScreen);
  const closeScreenPicker = useStore((state) => state.closeScreenPicker);
  const members = useStore((state) => state.members);
  const selfId = useStore((state) => state.selfId);
  const voiceChannelId = useStore((state) => state.voiceChannelId);

  const desktop = isDesktopApp();
  const platform = desktopPlatform();
  // O loopback do Electron é `audio: "loopback"`, que só o Windows tem. Prometer o
  // som do sistema no Mac ou no Linux renderia uma transmissão muda e um aviso de
  // falha, então a caixa aparece desligada dizendo o porquê.
  //
  // App até a 1.0.0 não informa a plataforma, e o único instalador que existe é o
  // de Windows: tratar o desconhecido como capaz é o que mantém o som do sistema
  // funcionando pra quem ainda não reinstalou.
  const systemAudioCapable = !desktop || platform === null || platform === "win32";
  const [options, setOptions] = useState(screenOptions);
  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [loading, setLoading] = useState(desktop && !screenOn);
  const [tab, setTab] = useState<"screen" | "window">("screen");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listeners = useMemo(
    () => membersInVoice(members, voiceChannelId).filter((member) => member.id !== selfId).length,
    [members, voiceChannelId, selfId],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeScreenPicker();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeScreenPicker]);

  async function refresh() {
    if (!desktop) return;
    setLoading(true);
    try {
      const found = await listDesktopSources();
      setSources(found);
      setSelectedId((current) =>
        current && found.some((source) => source.id === current)
          ? current
          : (found.find((source) => source.isScreen) ?? found[0])?.id ?? null,
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!screenOn) void refresh();
  }, [screenOn]);

  /** Com a tela no ar a mudança vale na hora; antes disso ela só é preparada. */
  function change(next: typeof options) {
    setOptions(next);
    if (screenOn) void setScreenOptions(next);
  }

  const visible = sources.filter((source) => source.isScreen === (tab === "screen"));
  const selected = sources.find((source) => source.id === selectedId) ?? null;
  // A preferência é guardada entre sessões, e pode ter sido marcada onde o som do
  // sistema funciona. Quem captura recebe o que dá pra capturar aqui.
  const effective = systemAudioCapable ? options : { ...options, systemAudio: false };
  const perPerson = screenBitrate(options) + (camOn ? cameraBitrate(camera) : 0);
  const total = perPerson * Math.max(listeners, 1);
  const ready = screenOn || !desktop || Boolean(selected);

  function selectTab(next: "screen" | "window") {
    setTab(next);
    const first = sources.find((source) => source.isScreen === (next === "screen"));
    setSelectedId(first?.id ?? null);
  }

  return (
    <div className="modal-backdrop" onClick={closeScreenPicker}>
      <div
        className="modal share-modal"
        role="dialog"
        aria-modal="true"
        aria-label={screenOn ? "Qualidade da transmissão" : "Compartilhar a tela"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{screenOn ? "Qualidade da transmissão" : "Compartilhar a tela"}</h2>
          <button type="button" className="modal-close" onClick={closeScreenPicker} title="Fechar">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="modal-body">
          {screenOn ? (
            <p className="hint">
              Você já está transmitindo. O que mudar aqui vale no próximo instante, sem cortar a
              imagem de quem está assistindo.
            </p>
          ) : desktop ? (
            <section className="settings-section">
              <div className="share-tabs">
                <button
                  type="button"
                  className="share-tab"
                  data-on={tab === "screen"}
                  onClick={() => selectTab("screen")}
                >
                  Telas
                </button>
                <button
                  type="button"
                  className="share-tab"
                  data-on={tab === "window"}
                  onClick={() => selectTab("window")}
                >
                  Janelas
                </button>
                <button
                  type="button"
                  className="share-refresh"
                  onClick={() => void refresh()}
                  disabled={loading}
                >
                  {loading ? "Buscando…" : "Atualizar"}
                </button>
              </div>

              {visible.length === 0 ? (
                <p className="hint">
                  {loading
                    ? "Procurando telas e janelas…"
                    : tab === "screen"
                      ? "Nenhuma tela encontrada."
                      : "Nenhuma janela aberta. Abra o programa que quer mostrar e clique em Atualizar."}
                </p>
              ) : (
                <div className="share-grid">
                  {visible.map((source) => (
                    <button
                      key={source.id}
                      type="button"
                      className="share-source"
                      data-on={source.id === selectedId}
                      onClick={() => setSelectedId(source.id)}
                      title={source.label}
                    >
                      <span className="share-thumb">
                        {source.thumbnail ? (
                          <img src={source.thumbnail} alt="" />
                        ) : (
                          <ScreenIcon size={28} />
                        )}
                      </span>
                      <span className="share-name">
                        {source.appIcon && <img src={source.appIcon} alt="" />}
                        {source.label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <p className="join-warning">
              Depois de clicar em <strong>Compartilhar</strong>, o navegador vai perguntar qual tela
              ou janela mostrar. Essa janela é dele, não do app, e nenhum site pode desenhar,
              substituir ou pular aquele passo. No app para Windows a escolha é aqui dentro, com as
              miniaturas.
            </p>
          )}

          <section className="settings-section">
            <h3>Vídeo da tela</h3>

            <div className="field">
              <span>Resolução</span>
              <div className="chips">
                {SCREEN_RESOLUTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="chip"
                    data-on={options.resolution === value}
                    onClick={() => change({ ...options, resolution: value })}
                  >
                    {RESOLUTION_LABEL[value]}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span>Taxa de quadros</span>
              <div className="chips">
                {FRAME_RATES.map((value: FrameRate) => (
                  <button
                    key={value}
                    type="button"
                    className="chip"
                    data-on={options.frameRate === value}
                    onClick={() => change({ ...options, frameRate: value })}
                  >
                    {value} fps
                  </button>
                ))}
              </div>
            </div>

            <p className="hint">
              Mais quadros deixa jogo e vídeo fluidos; menos quadros com resolução alta deixa texto
              e código mais nítidos.
            </p>

            <div className="field">
              <span>Conteúdo</span>
              <div className="chips">
                {SCREEN_CONTENTS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="chip"
                    data-on={options.content === value}
                    onClick={() => change({ ...options, content: value })}
                  >
                    {CONTENT_LABEL[value]}
                  </button>
                ))}
              </div>
            </div>

            <p className="hint">{CONTENT_HINT[options.content]}</p>

            <label className="toggle">
              <input
                type="checkbox"
                checked={options.systemAudio && systemAudioCapable}
                disabled={screenOn || !systemAudioCapable}
                onChange={(event) => change({ ...options, systemAudio: event.target.checked })}
              />
              <span>
                <strong>Levar o som do sistema</strong>
                <em>
                  {!systemAudioCapable
                    ? "O app só captura o som do sistema no Windows. Aqui a transmissão vai sem áudio."
                    : screenOn
                      ? "O som só pode ser ligado ou desligado ao começar a transmissão."
                      : desktop
                        ? "Manda o áudio do Windows junto: o som do jogo ou do vídeo."
                        : "No Chrome vem o som da aba ou da tela escolhida. O Firefox não manda áudio."}
                </em>
              </span>
            </label>
          </section>

          <section className="settings-section">
            <h3>Câmera</h3>

            <div className="field">
              <span>Resolução</span>
              <div className="chips">
                {CAMERA_RESOLUTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="chip"
                    data-on={camera.resolution === value}
                    onClick={() => void applySettings({ camera: { ...camera, resolution: value } })}
                  >
                    {CAMERA_LABEL[value]}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <span>Taxa de quadros</span>
              <div className="chips">
                {FRAME_RATES.map((value: FrameRate) => (
                  <button
                    key={value}
                    type="button"
                    className="chip"
                    data-on={camera.frameRate === value}
                    onClick={() => void applySettings({ camera: { ...camera, frameRate: value } })}
                  >
                    {value} fps
                  </button>
                ))}
              </div>
            </div>

            <label className="toggle">
              <input
                type="checkbox"
                checked={mirrorSelf}
                onChange={(event) => void applySettings({ mirrorSelf: event.target.checked })}
              />
              <span>
                <strong>Espelhar a minha imagem</strong>
                <em>Vale só pra você; os outros continuam vendo o lado certo.</em>
              </span>
            </label>
          </section>

          <p className={total > 10_000_000 ? "status-warn" : "hint"}>
            Sobe ~{mbps(perPerson)} Mbps para cada pessoa
            {camOn ? " (tela + câmera)" : ""}.{" "}
            {listeners > 0
              ? `Com ${listeners} na call, ~${mbps(total)} Mbps de upload.`
              : "Cada pessoa que entrar soma outro tanto: é conexão direta, não passa por servidor."}
            {total > 10_000_000 && " Se travar, baixe a resolução ou a taxa de quadros."}
          </p>
        </div>

        <footer className="modal-footer">
          {screenOn ? (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void toggleScreen();
                  closeScreenPicker();
                }}
              >
                Parar de transmitir
              </button>
              <button type="button" className="join-submit share-submit" autoFocus onClick={closeScreenPicker}>
                Pronto
              </button>
            </>
          ) : (
            <>
              <button type="button" className="secondary-button" onClick={closeScreenPicker}>
                Cancelar
              </button>
              <button
                type="button"
                className="join-submit share-submit"
                disabled={!ready}
                autoFocus
                onClick={() => void startScreen(effective, selected?.id ?? null)}
              >
                Compartilhar
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
