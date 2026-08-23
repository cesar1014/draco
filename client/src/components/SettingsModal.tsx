import { useEffect, useMemo, useState } from "react";
import { CloseIcon } from "@/components/Icons";
import { runIceDiagnostics } from "@/rtc/iceConfig";
import { membersInVoice, micLevel, useStore } from "@/state/store";

/** Rótulo de dispositivo vem vazio até a primeira permissão; daí o reserva. */
function deviceLabel(device: MediaDeviceInfo, index: number, fallback: string): string {
  return device.label || `${fallback} ${index + 1}`;
}

type Diagnostics = Awaited<ReturnType<typeof runIceDiagnostics>>;

export function SettingsModal() {
  const settings = useStore((state) => state.settings);
  const devices = useStore((state) => state.devices);
  const ice = useStore((state) => state.ice);
  const members = useStore((state) => state.members);
  const selfId = useStore((state) => state.selfId);
  const voiceChannelId = useStore((state) => state.voiceChannelId);
  const peerVolumes = useStore((state) => state.peerVolumes);
  const closeSettings = useStore((state) => state.closeSettings);
  const applySettings = useStore((state) => state.applySettings);
  const refreshDevices = useStore((state) => state.refreshDevices);
  const setPeerVolume = useStore((state) => state.setPeerVolume);

  const [level, setLevel] = useState(0);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<Diagnostics | null>(null);

  const peers = useMemo(
    () => membersInVoice(members, voiceChannelId).filter((member) => member.id !== selfId),
    [members, voiceChannelId, selfId],
  );

  useEffect(() => {
    const timer = setInterval(() => setLevel(micLevel()), 80);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSettings]);

  // A lista de dispositivos muda quando um fone é plugado; abrir as configurações
  // é justamente quando isso costuma ter acabado de acontecer.
  useEffect(() => {
    const onChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", onChange);
  }, [refreshDevices]);

  async function testConnection() {
    if (!ice) return;
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await runIceDiagnostics(ice));
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={closeSettings}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Configurações"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Voz e vídeo</h2>
          <button type="button" className="modal-close" onClick={closeSettings} title="Fechar">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="modal-body">
          <section className="settings-section">
            <label className="field">
              <span>Microfone</span>
              <select
                value={settings.micDeviceId ?? ""}
                onChange={(event) => void applySettings({ micDeviceId: event.target.value || null })}
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
                onChange={(event) => void applySettings({ outputDeviceId: event.target.value || null })}
              >
                <option value="">Padrão do sistema</option>
                {devices.speakers.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {deviceLabel(device, index, "Saída")}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Câmera</span>
              <select
                value={settings.cameraDeviceId ?? ""}
                onChange={(event) => void applySettings({ cameraDeviceId: event.target.value || null })}
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
            <h3>Processamento de áudio</h3>
            {(
              [
                ["echoCancellation", "Cancelamento de eco", "Evita que o som da caixa volte pelo microfone."],
                ["noiseSuppression", "Redução de ruído", "Corta ventilador, teclado e chiado de fundo."],
                ["autoGainControl", "Volume automático", "Nivela a voz de quem fala longe do microfone."],
              ] as const
            ).map(([key, label, hint]) => (
              <label key={key} className="toggle">
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={(event) => void applySettings({ [key]: event.target.checked })}
                />
                <span>
                  <strong>{label}</strong>
                  <em>{hint}</em>
                </span>
              </label>
            ))}
          </section>

          <section className="settings-section">
            <h3>Volume das pessoas</h3>
            {peers.length === 0 ? (
              <p className="hint">Ninguém mais está na call.</p>
            ) : (
              peers.map((member) => (
                <label key={member.id} className="volume-row">
                  <span>
                    {member.username}
                    <b>{Math.round((peerVolumes[member.id] ?? 1) * 100)}%</b>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round((peerVolumes[member.id] ?? 1) * 100)}
                    onChange={(event) => setPeerVolume(member.id, Number(event.target.value) / 100)}
                  />
                </label>
              ))
            )}
          </section>

          <section className="settings-section">
            <h3>Conexão</h3>
            <p className="hint">
              Origem da configuração: <code>{ice?.source ?? "—"}</code>
            </p>
            <p className={ice?.hasTurn ? "status-ok" : "status-warn"}>
              {ice?.hasTurn
                ? "TURN configurado: a call atravessa redes restritas."
                : "Sem TURN: funciona na maioria das redes domésticas, mas pode falhar em rede corporativa ou 4G."}
            </p>
            {ice?.warning && <p className="status-warn">{ice.warning}</p>}

            <button type="button" className="secondary-button" onClick={() => void testConnection()} disabled={probing}>
              {probing ? "Testando…" : "Testar conexão"}
            </button>

            {probe && (
              <ul className="probe">
                <li data-ok={probe.host}>Rede local (host): {probe.host ? "ok" : "nada"}</li>
                <li data-ok={probe.srflx}>STUN (srflx): {probe.srflx ? "ok" : "nada"}</li>
                <li data-ok={probe.relay}>TURN (relay): {probe.relay ? "ok" : "nada"}</li>
              </ul>
            )}

            <p className="hint">
              Para verificar o núcleo da call sem depender de outra pessoa, abra o{" "}
              <a href="?selftest=1" target="_blank" rel="noreferrer">
                autoteste do WebRTC
              </a>{" "}
              — ele roda em outra aba e não interrompe esta call.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
