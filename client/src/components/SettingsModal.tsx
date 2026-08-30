import { useEffect, useMemo, useState } from "react";
import { keyLabel } from "@/components/CallControls";
import { CloseIcon, ScreenIcon, SpeakerOffIcon } from "@/components/Icons";
import {
  CAMERA_RESOLUTIONS,
  FRAME_RATES,
  cameraBitrate,
  type CameraResolution,
  type FrameRate,
} from "@/rtc/MediaManager";
import {
  DENOISE_MODES,
  DENOISE_STRENGTHS,
  type DenoiseMode,
  type DenoiseStrength,
} from "@/rtc/denoise";
import { runConnectionDiagnostics, VERDICT_LABEL, type DiagnosticsReport } from "@/rtc/diagnostics";
import { checkDesktopUpdate, downloadDesktopUpdate, installDesktopUpdate, isDesktopApp, onDesktopUpdateStatus, openDesktopRelease, type UpdateProgress, type UpdateStatus } from "@/desktop";
import { playCue } from "@/rtc/sounds";
import { MAX_PERSON_VOLUME, membersInVoice, micLevel, prefsFor, useStore } from "@/state/store";
import { listConnectedSessions, loadPlatformHealth, revokeAllConnectedSessions, revokeConnectedSession, type ConnectedSession } from "@/auth";

/** Rótulo de dispositivo vem vazio até a primeira permissão; daí o reserva. */
function deviceLabel(device: MediaDeviceInfo, index: number, fallback: string): string {
  return device.label || `${fallback} ${index + 1}`;
}

const RESOLUTION_LABEL: Record<CameraResolution, string> = {
  "360": "360p",
  "480": "480p",
  "720": "720p",
  "1080": "1080p",
};

const DENOISE_LABEL: Record<DenoiseMode, string> = {
  off: "Desligada",
  browser: "Do navegador",
  draco: "Draco",
};

const DENOISE_HINT: Record<DenoiseMode, string> = {
  off: "Nada é filtrado: o microfone vai cru, com tudo o que houver no quarto.",
  browser: "A do próprio navegador. Corta o básico e às vezes engole o começo das frases.",
  draco: "Nossa: aprende o chiado do seu ambiente e o apaga sem afinar a voz. Ventilador, chuva e teclado somem.",
};

const STRENGTH_LABEL: Record<DenoiseStrength, string> = {
  light: "Leve",
  medium: "Média",
  strong: "Forte",
};

const TABS = [
  ["account", "Conta"],
  ["audio", "Áudio"],
  ["video", "Vídeo"],
  ["people", "Pessoas"],
  ["look", "Aparência"],
  ["net", "Conexão"],
] as const;

type Tab = (typeof TABS)[number][0];

const mbps = (bits: number) => (bits / 1_000_000).toFixed(1).replace(".", ",");

export function SettingsModal() {
  const settings = useStore((state) => state.settings);
  const devices = useStore((state) => state.devices);
  const ice = useStore((state) => state.ice);
  const sfuHealth = useStore((state) => state.sfuHealth);
  const members = useStore((state) => state.members);
  const selfId = useStore((state) => state.selfId);
  const voiceChannelId = useStore((state) => state.voiceChannelId);
  const people = useStore((state) => state.people);
  const closeSettings = useStore((state) => state.closeSettings);
  const applySettings = useStore((state) => state.applySettings);
  const refreshDevices = useStore((state) => state.refreshDevices);
  const setPersonVolume = useStore((state) => state.setPersonVolume);
  const togglePersonMuted = useStore((state) => state.togglePersonMuted);
  const setScreenVolume = useStore((state) => state.setScreenVolume);
  const toggleScreenMuted = useStore((state) => state.toggleScreenMuted);
  const resetPerson = useStore((state) => state.resetPerson);
  const account = useStore((state) => state.account);
  const requestOwnPassword = useStore((state) => state.requestOwnPassword);
  const logout = useStore((state) => state.logout);

  const [tab, setTab] = useState<Tab>("account");
  const [level, setLevel] = useState(0);
  const [capturing, setCapturing] = useState(false);
  const [probing, setProbing] = useState(false);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ConnectedSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [platformHealth, setPlatformHealth] = useState<Record<string, any> | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(() =>
    "Notification" in window ? Notification.permission : "unsupported");

  const peers = useMemo(
    () => membersInVoice(members, voiceChannelId).filter((member) => member.id !== selfId),
    [members, voiceChannelId, selfId],
  );

  useEffect(() => {
    const timer = setInterval(() => setLevel(micLevel()), 80);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (capturing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSettings, capturing]);

  // Enquanto espera a tecla do push-to-talk, o teclado inteiro é nosso: qualquer
  // atalho que passe reto seria gravado como "a tecla" ou fecharia o painel.
  useEffect(() => {
    if (!capturing) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setCapturing(false);
      if (event.key !== "Escape") void applySettings({ pushToTalkKey: event.code });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, applySettings]);

  // A lista de dispositivos muda quando um fone é plugado; abrir as configurações
  // é justamente quando isso costuma ter acabado de acontecer.
  useEffect(() => {
    const onChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", onChange);
  }, [refreshDevices]);

  // Só quando a aba de conexão aparece: no navegador não há o que verificar, e
  // fazer isso na abertura das configurações gastaria uma requisição por clique.
  useEffect(() => {
    if (tab !== "net") return;
    let active = true;
    void checkDesktopUpdate().then((status) => {
      if (active) setUpdate(status);
    });
    return () => {
      active = false;
    };
  }, [tab]);

  useEffect(() => onDesktopUpdateStatus(setUpdateProgress), []);

  useEffect(() => {
    if (tab !== "account" || account?.guest) return;
    let active = true;
    void listConnectedSessions().then((reply) => {
      if (active && reply.ok) {
        setSessions(reply.sessions ?? []);
        setCurrentSessionId(reply.currentSessionId ?? null);
      }
    });
    return () => { active = false; };
  }, [tab, account?.guest]);

  useEffect(() => {
    if (tab !== "account" || !account?.isSystemAdmin) return;
    void loadPlatformHealth().then((reply) => setPlatformHealth(reply.ok ? reply.metrics ?? null : null));
  }, [tab, account?.isSystemAdmin]);

  async function testConnection() {
    setProbing(true);
    setReport(null);
    try {
      setReport(await runConnectionDiagnostics());
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={closeSettings}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Configurações</h2>
          <button type="button" className="modal-close" onClick={closeSettings} title="Fechar">
            <CloseIcon size={18} />
          </button>
        </header>

        <nav className="settings-nav">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="settings-tab"
              data-on={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="modal-body">
          {tab === "account" && (
            <section className="settings-section account-settings">
              <h3>{account?.guest ? "Sessão de visitante" : "Sua conta"}</h3>
              <p className="hint">
                <strong>{account?.username}</strong>
                {!account?.guest && <> · {account?.email}</>}
                {account?.isSystemAdmin && <> · administrador global</>}
              </p>
              {!isDesktopApp() && notificationPermission !== "unsupported" && <button type="button" className="secondary-button" disabled={notificationPermission === "denied"} onClick={() => void Notification.requestPermission().then(setNotificationPermission)}>
                {notificationPermission === "granted" ? "Notificações do navegador ativadas" : notificationPermission === "denied" ? "Notificações bloqueadas no navegador" : "Ativar notificações do navegador"}
              </button>}
              {!account?.guest && (
                <>
                  <p className="hint">A troca de senha exige confirmação pelo seu próprio e-mail. Ao concluir, as sessões antigas são encerradas.</p>
                  <button type="button" className="secondary-button" onClick={() => { setAccountMessage(null); void requestOwnPassword().then((error) => setAccountMessage(error ?? "Enviamos o link de troca para seu e-mail.")); }}>
                    Trocar minha senha
                  </button>
                  <div className="session-devices">
                    <h4>Dispositivos conectados</h4>
                    {sessions.map((session) => <div key={session.id} className="session-device">
                      <span><strong>{session.deviceName}</strong><small>{session.id === currentSessionId ? "Este dispositivo · agora" : new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" }).format(Math.round((session.lastSeenAt - Date.now()) / 3_600_000), "hour")}</small></span>
                      <button type="button" className="link-button danger" onClick={() => void revokeConnectedSession(session.id).then((reply) => {
                        if (!reply.ok) return setAccountMessage("Não foi possível encerrar a sessão.");
                        if (session.id === currentSessionId) { closeSettings(); logout(); }
                        else setSessions((current) => current.filter((item) => item.id !== session.id));
                      })}>Encerrar</button>
                    </div>)}
                    <button type="button" className="secondary-button danger" onClick={() => void revokeAllConnectedSessions().then((reply) => { if (reply.ok) { closeSettings(); logout(); } })}>Sair de todos os dispositivos</button>
                  </div>
                  {account?.isSystemAdmin && platformHealth && <div className="platform-health">
                    <h4>Saúde do Draco</h4>
                    <span><strong>{platformHealth.users?.online ?? 0}</strong><small>online</small></span>
                    <span><strong>{platformHealth.server?.socketClients ?? 0}</strong><small>sockets</small></span>
                    <span><strong>{platformHealth.calls?.active ?? 0}</strong><small>calls ativas</small></span>
                    <span><strong>{platformHealth.chat?.messagesPerMinute ?? 0}</strong><small>mensagens/min</small></span>
                    <span><strong>{platformHealth.server?.eventLoopP95Ms ?? 0} ms</strong><small>event loop p95</small></span>
                    <span><strong>{Math.round((platformHealth.database?.sizeBytes ?? 0) / 1024 / 1024)} MB</strong><small>banco</small></span>
                  </div>}
                </>
              )}
              {accountMessage && <p className={accountMessage.startsWith("Enviamos") ? "status-ok" : "status-warn"}>{accountMessage}</p>}
              <button type="button" className="secondary-button danger" onClick={() => { closeSettings(); logout(); }}>
                Sair {account?.guest ? "da visita" : "da conta"}
              </button>
            </section>
          )}

          {tab === "audio" && (
            <>
              <section className="settings-section">
                <label className="field">
                  <span>Microfone</span>
                  <select
                    value={settings.micDeviceId ?? ""}
                    onChange={(event) =>
                      void applySettings({ micDeviceId: event.target.value || null })
                    }
                  >
                    <option value="">Padrão do sistema</option>
                    {devices.mics.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {deviceLabel(device, index, "Microfone")}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>Saída de som</span>
                  <select
                    value={settings.outputDeviceId ?? ""}
                    onChange={(event) =>
                      void applySettings({ outputDeviceId: event.target.value || null })
                    }
                  >
                    <option value="">Padrão do sistema</option>
                    {devices.speakers.map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {deviceLabel(device, index, "Saída")}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="field">
                  <span>Teste do microfone</span>
                  <div className="meter" role="meter" aria-valuenow={Math.round(level * 100)}>
                    <div className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
                  </div>
                  <p className="hint">
                    {voiceChannelId
                      ? "Fale: a barra acompanha o que os outros recebem."
                      : "Entre num canal de voz para medir o microfone."}
                  </p>
                </div>
              </section>

              <section className="settings-section">
                <h3>Processamento</h3>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.echoCancellation}
                    onChange={(event) =>
                      void applySettings({ echoCancellation: event.target.checked })
                    }
                  />
                  <span>
                    <strong>Cancelamento de eco</strong>
                    <em>Evita que o som da caixa volte pelo microfone.</em>
                  </span>
                </label>

                <label className="field">
                  <span>Redução de ruído</span>
                  <select
                    value={settings.denoise}
                    onChange={(event) =>
                      void applySettings({ denoise: event.target.value as DenoiseMode })
                    }
                  >
                    {DENOISE_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {DENOISE_LABEL[mode]}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="hint">{DENOISE_HINT[settings.denoise]}</p>

                {settings.denoise === "draco" && (
                  <div className="field">
                    <span>Força do filtro</span>
                    <div className="chips">
                      {DENOISE_STRENGTHS.map((value) => (
                        <button
                          key={value}
                          type="button"
                          className="chip"
                          data-on={settings.denoiseStrength === value}
                          onClick={() => void applySettings({ denoiseStrength: value })}
                        >
                          {STRENGTH_LABEL[value]}
                        </button>
                      ))}
                    </div>
                    <p className="hint">
                      Muda na hora, sem cortar o áudio. Se a voz começar a soar metálica ou sumir
                      entre as palavras, desça um degrau.
                    </p>
                  </div>
                )}

                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.autoGainControl}
                    onChange={(event) =>
                      void applySettings({ autoGainControl: event.target.checked })
                    }
                  />
                  <span>
                    <strong>Volume automático</strong>
                    <em>Nivela a voz de quem fala longe do microfone.</em>
                  </span>
                </label>
              </section>

              <section className="settings-section">
                <h3>Modo de fala</h3>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.pushToTalk}
                    onChange={(event) => void applySettings({ pushToTalk: event.target.checked })}
                  />
                  <span>
                    <strong>Apertar para falar</strong>
                    <em>O microfone só abre enquanto a tecla está pressionada.</em>
                  </span>
                </label>

                {settings.pushToTalk && (
                  <div className="field">
                    <span>Tecla</span>
                    <button
                      type="button"
                      className="secondary-button key-capture"
                      data-on={capturing}
                      onClick={() => setCapturing(true)}
                    >
                      {capturing ? "Aperte qualquer tecla…" : keyLabel(settings.pushToTalkKey)}
                    </button>
                    <p className="hint">Não vale enquanto você digita no chat.</p>
                  </div>
                )}
              </section>

              <section className="settings-section">
                <h3>Sons do sistema</h3>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={settings.sounds}
                    onChange={(event) => void applySettings({ sounds: event.target.checked })}
                  />
                  <span>
                    <strong>Avisos sonoros</strong>
                    <em>Toque curto ao entrar, sair, mutar e desmutar.</em>
                  </span>
                </label>

                {settings.sounds && (
                  <div className="volume-row">
                    <span>
                      Volume dos avisos
                      <b>{Math.round(settings.soundVolume * 100)}%</b>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(settings.soundVolume * 100)}
                      onChange={(event) =>
                        void applySettings({ soundVolume: Number(event.target.value) / 100 })
                      }
                    />
                    <div className="volume-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => playCue("join")}
                      >
                        Ouvir
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}

          {tab === "video" && (
            <section className="settings-section">
              <label className="field">
                <span>Câmera</span>
                <select
                  value={settings.cameraDeviceId ?? ""}
                  onChange={(event) =>
                    void applySettings({ cameraDeviceId: event.target.value || null })
                  }
                >
                  <option value="">Padrão do sistema</option>
                  {devices.cameras.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {deviceLabel(device, index, "Câmera")}
                    </option>
                  ))}
                </select>
              </label>

              <div className="field">
                <span>Resolução</span>
                <div className="chips">
                  {CAMERA_RESOLUTIONS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className="chip"
                      data-on={settings.camera.resolution === value}
                      onClick={() =>
                        void applySettings({ camera: { ...settings.camera, resolution: value } })
                      }
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
                      data-on={settings.camera.frameRate === value}
                      onClick={() =>
                        void applySettings({ camera: { ...settings.camera, frameRate: value } })
                      }
                    >
                      {value} fps
                    </button>
                  ))}
                </div>
              </div>

              <p className="hint">
                Sobe ~{mbps(cameraBitrate(settings.camera))} Mbps por pessoa na call. Se a imagem
                travar, desça a resolução antes dos quadros.
              </p>

              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.mirrorSelf}
                  onChange={(event) => void applySettings({ mirrorSelf: event.target.checked })}
                />
                <span>
                  <strong>Espelhar minha câmera</strong>
                  <em>Só muda o que você vê. Os outros recebem a imagem normal.</em>
                </span>
              </label>
            </section>
          )}

          {tab === "people" && (
            <section className="settings-section">
              <h3>Volume de cada um</h3>
              {peers.length === 0 ? (
                <p className="hint">Ninguém mais está na call.</p>
              ) : (
                peers.map((member) => {
                  const prefs = prefsFor(people, member.username);
                  const percent = Math.round(prefs.volume * 100);
                  const screenPercent = Math.round(prefs.screenVolume * 100);
                  return (
                    <div key={member.id} className="volume-group">
                      <div
                        className="volume-row"
                        data-muted={prefs.muted}
                        data-boost={percent > 100}
                      >
                        <span>
                          {member.username}
                          <b>{prefs.muted ? "mudo" : `${percent}%`}</b>
                        </span>
                        <input
                          type="range"
                          className="range-boost"
                          min={0}
                          max={MAX_PERSON_VOLUME * 100}
                          step={5}
                          value={percent}
                          disabled={prefs.muted}
                          onChange={(event) =>
                            setPersonVolume(member.username, Number(event.target.value) / 100)
                          }
                        />
                        <div className="volume-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            data-on={prefs.muted}
                            onClick={() => togglePersonMuted(member.username)}
                            title={prefs.muted ? "Ouvir de novo" : "Silenciar para mim"}
                          >
                            <SpeakerOffIcon size={16} />
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => resetPerson(member.username)}
                          >
                            Padrão
                          </button>
                        </div>
                      </div>

                      {member.screenOn && (
                        <div
                          className="volume-row"
                          data-muted={prefs.screenMuted}
                          data-boost={screenPercent > 100}
                        >
                          <span>
                            <ScreenIcon size={13} /> Transmissão de tela
                            <b>{prefs.screenMuted ? "mudo" : `${screenPercent}%`}</b>
                          </span>
                          <input
                            type="range"
                            className="range-boost"
                            min={0}
                            max={MAX_PERSON_VOLUME * 100}
                            step={5}
                            value={screenPercent}
                            disabled={prefs.screenMuted}
                            onChange={(event) =>
                              setScreenVolume(member.username, Number(event.target.value) / 100)
                            }
                          />
                          <div className="volume-actions">
                            <button
                              type="button"
                              className="secondary-button"
                              data-on={prefs.screenMuted}
                              onClick={() => toggleScreenMuted(member.username)}
                              title={
                                prefs.screenMuted
                                  ? "Ouvir a transmissão"
                                  : "Silenciar a transmissão"
                              }
                            >
                              <SpeakerOffIcon size={16} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
              <p className="hint">
                Vale só para você, e continua valendo quando a pessoa entrar de novo. Acima de 100%
                o som é reforçado, o que resolve microfone fraco, e o limitador evita estouro. O som da
                tela é separado: dá pra baixar o jogo de alguém e continuar ouvindo a pessoa.
              </p>
            </section>
          )}

          {tab === "look" && (
            <section className="settings-section">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.liteMode}
                  onChange={(event) => void applySettings({ liteMode: event.target.checked })}
                />
                <span>
                  <strong>Modo leve</strong>
                  <em>Desliga desfoque, sombras e animações. Ajuda em PC antigo e em notebook na bateria.</em>
                </span>
              </label>

              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.showStats}
                  onChange={(event) => void applySettings({ showStats: event.target.checked })}
                />
                <span>
                  <strong>Mostrar números da conexão</strong>
                  <em>Ping, perda e resolução em cima de cada vídeo.</em>
                </span>
              </label>
            </section>
          )}

          {tab === "net" && (
            <section className="settings-section">
              <p className="hint">
                Origem da configuração: <code>{ice?.source ?? "—"}</code>
              </p>
              <p className={ice?.hasTurn ? "status-ok" : "status-warn"}>
                {ice?.hasTurn
                  ? "TURN configurado: a call atravessa redes restritas."
                  : "Sem TURN: funciona na maioria das redes domésticas, mas pode falhar em rede corporativa ou 4G."}
              </p>
              {ice?.warning && <p className="status-warn">{ice.warning}</p>}
              <p className={sfuHealth?.status === "AVAILABLE" ? "status-ok" : "status-warn"}>
                SFU: {sfuHealth?.status === "AVAILABLE" ? "disponível" : sfuHealth?.status === "DEGRADED" ? "degradado" : "indisponível"}
                {sfuHealth?.checkedAt ? ` · verificado ${new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" }).format(Math.round((sfuHealth.checkedAt - Date.now()) / 60_000), "minute")}` : ""}
              </p>

              <button
                type="button"
                className="secondary-button"
                onClick={() => void testConnection()}
                disabled={probing}
              >
                {probing ? "Testando…" : "Testar minha conexão"}
              </button>

              {report && (
                <>
                  <p className="probe-verdict" data-verdict={report.verdict}>
                    {VERDICT_LABEL[report.verdict]}
                  </p>
                  <ul className="probe">
                    {report.checks.map((check) => (
                      <li key={check.id} data-status={check.status}>
                        <strong>{check.label}</strong>
                        <span>{check.detail}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {update?.available && (
                <p className="status-warn">
                  Versão {update.latest} disponível (você tem a {update.current}).{" "}
                  {update.automatic ? <button type="button" className="link-button" onClick={() => void downloadDesktopUpdate()}>Baixar atualização</button> : <button type="button" className="link-button" onClick={() => void openDesktopRelease()}>Abrir a página de download</button>}
                </p>
              )}
              {updateProgress?.phase === "downloading" && <p className="hint">Baixando atualização · {updateProgress.percent ?? 0}%</p>}
              {updateProgress?.phase === "downloaded" && <p className="status-ok">Atualização pronta. <button type="button" className="link-button" onClick={() => void installDesktopUpdate()}>Reiniciar e instalar</button></p>}
              {updateProgress?.phase === "error" && <p className="status-warn">{updateProgress.message}</p>}
              {update && !update.available && (
                <p className="hint">Aplicativo atualizado (versão {update.current}).</p>
              )}

              <p className="hint">
                Para verificar o núcleo da call sem depender de outra pessoa, abra o{" "}
                <a href="?selftest=1" target="_blank" rel="noreferrer">
                  autoteste
                </a>{" "}
                (roda em outra aba e não interrompe esta call).
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
