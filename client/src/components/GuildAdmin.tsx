import { useEffect, useState } from "react";
import { CloseIcon, PlusIcon } from "@/components/Icons";
import { useStore } from "@/state/store";

const relative = (at: number): string => {
  const days = Math.round((at - Date.now()) / 86_400_000);
  if (days <= 0) return "hoje";
  if (days === 1) return "amanhã";
  return `em ${days} dias`;
};

/** Duração do convite. `null` é sem prazo, e é o padrão de quem só quer chamar um amigo. */
const DURATIONS: Array<[string, number | null]> = [
  ["Sem prazo", null],
  ["1 dia", 24],
  ["7 dias", 24 * 7],
];

const USES: Array<[string, number | null]> = [
  ["Ilimitado", null],
  ["1 pessoa", 1],
  ["5 pessoas", 5],
];

/**
 * Administração do servidor: convites, membros e banimentos.
 *
 * Um pedido só ao abrir traz as três listas, e o painel guarda o resultado. As
 * ações são poucas de propósito — é o mínimo para um servidor ser usável por um
 * grupo de amigos, não um painel de moderação completo.
 */
export function GuildAdminModal() {
  const admin = useStore((state) => state.admin);
  const guilds = useStore((state) => state.guilds);
  const selfId = useStore((state) => state.selfId);
  const closeAdmin = useStore((state) => state.closeAdmin);
  const createInvite = useStore((state) => state.createInvite);
  const revokeInvite = useStore((state) => state.revokeInvite);
  const banMember = useStore((state) => state.banMember);
  const unbanMember = useStore((state) => state.unbanMember);
  const leaveGuild = useStore((state) => state.leaveGuild);

  const [expiresInHours, setExpires] = useState<number | null>(null);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAdmin();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAdmin]);

  // O aviso de "copiado" é passageiro: sem o prazo ele ficaria aceso para sempre.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!admin) return null;
  const guild = guilds.find((item) => item.id === admin.guildId);

  /**
   * O link inteiro, não só o código: é o que se cola numa conversa. A origem vem
   * da página, então serve tanto no túnel quanto no domínio publicado.
   */
  const inviteLink = (code: string) => `${location.origin}/?convite=${code}`;

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(inviteLink(code));
      setCopied(true);
    } catch {
      // Sem permissão de área de transferência: o código continua visível na tela
      // para quem quiser copiar à mão.
    }
  }

  return (
    <div className="modal-backdrop" onClick={closeAdmin}>
      <div
        className="modal admin-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Administrar ${guild?.name ?? "servidor"}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{guild?.name ?? "Servidor"}</h2>
          <button type="button" className="modal-close" onClick={closeAdmin} title="Fechar">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="modal-body">
          {admin.error && <p className="status-warn">{admin.error}</p>}

          <section className="settings-section">
            <h3>Convidar</h3>
            <p className="hint">
              Quem abrir o link entra neste servidor. Sem convite, ele fica só entre quem já está.
            </p>

            <div className="admin-invite-form">
              <label>
                <span>Validade</span>
                <select
                  value={String(expiresInHours)}
                  onChange={(event) =>
                    setExpires(event.target.value === "null" ? null : Number(event.target.value))
                  }
                >
                  {DURATIONS.map(([label, value]) => (
                    <option key={label} value={String(value)}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Usos</span>
                <select
                  value={String(maxUses)}
                  onChange={(event) =>
                    setMaxUses(event.target.value === "null" ? null : Number(event.target.value))
                  }
                >
                  {USES.map(([label, value]) => (
                    <option key={label} value={String(value)}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={admin.busy}
                onClick={() => {
                  void createInvite({ maxUses, expiresInHours }).then((code) => {
                    if (code) void copy(code);
                  });
                }}
              >
                Criar convite
              </button>
            </div>

            {admin.lastCode && (
              <p className="admin-invite-fresh">
                <code>{inviteLink(admin.lastCode)}</code>
                <button type="button" className="link-button" onClick={() => void copy(admin.lastCode!)}>
                  {copied ? "Copiado" : "Copiar"}
                </button>
              </p>
            )}

            {admin.invites.length > 0 && (
              <ul className="admin-list">
                {admin.invites.map((invite) => (
                  <li key={invite.code}>
                    <code>{invite.code}</code>
                    <span>
                      {invite.uses}
                      {invite.maxUses === null ? "" : `/${invite.maxUses}`} uso
                      {invite.uses === 1 ? "" : "s"}
                      {invite.expiresAt ? ` · expira ${relative(invite.expiresAt)}` : ""}
                    </span>
                    <button
                      type="button"
                      className="link-button"
                      disabled={admin.busy}
                      onClick={() => void revokeInvite(invite.code)}
                    >
                      Revogar
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="settings-section">
            <h3>Membros — {admin.roster.length}</h3>
            <ul className="admin-list">
              {admin.roster.map((entry) => (
                <li key={entry.id}>
                  <span className="admin-name">{entry.username}</span>
                  {entry.id === selfId && <span className="admin-tag">você</span>}
                  {entry.id === guild?.ownerId && <span className="admin-tag">dono</span>}
                  {admin.owner && entry.id !== selfId && (
                    <button
                      type="button"
                      className="link-button danger"
                      disabled={admin.busy}
                      onClick={() => void banMember(entry.id)}
                    >
                      Banir
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {admin.owner && admin.bans.length > 0 && (
            <section className="settings-section">
              <h3>Banidos — {admin.bans.length}</h3>
              <ul className="admin-list">
                {admin.bans.map((ban) => (
                  <li key={ban.userId}>
                    <span className="admin-name">{ban.username ?? "Pessoa removida"}</span>
                    {ban.reason && <span>{ban.reason}</span>}
                    <button
                      type="button"
                      className="link-button"
                      disabled={admin.busy}
                      onClick={() => void unbanMember(ban.userId)}
                    >
                      Readmitir
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Sair fecha o painel junto: ele mostra um servidor que deixou de ser seu. */}
          {!admin.owner && (
            <section className="settings-section">
              <button
                type="button"
                className="secondary-button danger"
                disabled={admin.busy}
                onClick={() => {
                  void leaveGuild(admin.guildId).then((error) => {
                    if (!error) closeAdmin();
                  });
                }}
              >
                Sair deste servidor
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Criar servidor ou entrar por convite. As duas coisas na mesma janela porque são
 * a mesma intenção vista de dois lados — "quero outro lugar para conversar" — e
 * quem abriu o `+` pode não saber ainda qual dos dois quer.
 */
export function GuildCreateModal({ onClose }: { onClose: () => void }) {
  const createGuild = useStore((state) => state.createGuild);
  const joinByInvite = useStore((state) => state.joinByInvite);

  const [tab, setTab] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Aceita o link inteiro ou só o código: quem cola o link não deveria ter que
    // recortar o pedaço certo à mão.
    const failure =
      tab === "create"
        ? await createGuild(name.trim())
        : await joinByInvite(code.trim().split(/[?=/]/).pop() ?? "");
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  }

  const ready = tab === "create" ? name.trim().length >= 2 : code.trim().length > 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal guild-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Adicionar servidor"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Adicionar servidor</h2>
          <button type="button" className="modal-close" onClick={onClose} title="Fechar">
            <CloseIcon size={18} />
          </button>
        </header>

        <nav className="settings-nav">
          <button
            type="button"
            className="settings-tab"
            data-on={tab === "create"}
            onClick={() => setTab("create")}
          >
            Criar
          </button>
          <button
            type="button"
            className="settings-tab"
            data-on={tab === "join"}
            onClick={() => setTab("join")}
          >
            Entrar com convite
          </button>
        </nav>

        <div className="modal-body">
          {tab === "create" ? (
            <label className="field">
              <span>Nome do servidor</span>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void submit()}
                placeholder="Ex.: Jogatina de sexta"
                maxLength={48}
              />
              <em>Ele começa com um canal de texto e um de voz. Só quem você convidar entra.</em>
            </label>
          ) : (
            <label className="field">
              <span>Link ou código do convite</span>
              <input
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void submit()}
                placeholder="BCDF23GHJK"
                maxLength={200}
              />
            </label>
          )}

          {error && <p className="status-warn">{error}</p>}

          <button type="button" className="primary-button" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? "Aguarde…" : tab === "create" ? "Criar servidor" : "Entrar"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Criar canal de texto ou de voz. Só o dono do servidor vê o botão que abre isto. */
export function ChannelCreateModal({
  guildId,
  onClose,
}: {
  guildId: string;
  onClose: () => void;
}) {
  const createChannel = useStore((state) => state.createChannel);

  const [type, setType] = useState<"text" | "voice">("text");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (busy || name.trim().length === 0) return;
    setBusy(true);
    setError(null);
    const failure = await createChannel(guildId, type, name.trim());
    setBusy(false);
    if (failure) setError(failure);
    else onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal guild-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Criar canal"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2>Criar canal</h2>
          <button type="button" className="modal-close" onClick={onClose} title="Fechar">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="modal-body">
          <div className="choice-row">
            <button
              type="button"
              className="choice"
              data-on={type === "text"}
              onClick={() => setType("text")}
            >
              Texto
            </button>
            <button
              type="button"
              className="choice"
              data-on={type === "voice"}
              onClick={() => setType("voice")}
            >
              Voz
            </button>
          </div>

          <label className="field">
            <span>Nome</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void submit()}
              placeholder={type === "voice" ? "Sala de Jogo" : "assuntos-gerais"}
              maxLength={32}
            />
            {type === "text" && <em>Espaços viram hífen, como nos canais que já existem.</em>}
          </label>

          {error && <p className="status-warn">{error}</p>}

          <button
            type="button"
            className="primary-button"
            disabled={busy || name.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? "Criando…" : "Criar canal"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** O `+` da barra de servidores, que abre a janela de criar/entrar. */
export function AddGuildButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="guild add-guild" onClick={() => setOpen(true)} title="Adicionar servidor">
        <PlusIcon size={20} />
      </button>
      {open && <GuildCreateModal onClose={() => setOpen(false)} />}
    </>
  );
}
