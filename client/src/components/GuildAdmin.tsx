import { useEffect, useState } from "react";
import { CloseIcon, HashIcon, PlusIcon, SpeakerIcon, TrashIcon } from "@/components/Icons";
import { useStore } from "@/state/store";
import type { GuildPermission, Role, RosterEntry } from "@/types";

const PERMISSION_LABEL: Record<GuildPermission, string> = {
  view_channels: "Ver canais",
  send_messages: "Enviar mensagens",
  connect: "Entrar na voz",
  speak: "Falar na voz",
  manage_channels: "Criar e apagar canais",
  create_invites: "Criar convites",
  ban_members: "Banir membros",
  manage_roles: "Gerenciar cargos",
  manage_messages: "Gerenciar mensagens",
  moderate_members: "Aplicar timeout e expulsar",
  mention_everyone: "Mencionar cargos e todos",
  view_audit_log: "Ver registro de auditoria",
};

const PERMISSION_GROUPS: Array<[string, GuildPermission[]]> = [
  ["Geral", ["view_channels"]],
  ["Texto", ["send_messages", "manage_messages", "mention_everyone"]],
  ["Voz", ["connect", "speak"]],
  ["Moderação", ["manage_channels", "create_invites", "ban_members", "moderate_members"]],
  ["Administração", ["manage_roles", "view_audit_log"]],
];

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

function shiftedIds(items: Array<{ id: string }>, id: string, offset: -1 | 1): string[] | null {
  const index = items.findIndex((item) => item.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= items.length) return null;
  const copy = [...items];
  [copy[index], copy[target]] = [copy[target], copy[index]];
  return copy.map((item) => item.id);
}

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
  const channels = useStore((state) => state.channels);
  const selfId = useStore((state) => state.selfId);
  const closeAdmin = useStore((state) => state.closeAdmin);
  const createInvite = useStore((state) => state.createInvite);
  const revokeInvite = useStore((state) => state.revokeInvite);
  const banMember = useStore((state) => state.banMember);
  const unbanMember = useStore((state) => state.unbanMember);
  const kickMember = useStore((state) => state.kickMember);
  const timeoutMember = useStore((state) => state.timeoutMember);
  const removeTimeout = useStore((state) => state.removeTimeout);
  const leaveGuild = useStore((state) => state.leaveGuild);
  const createRole = useStore((state) => state.createRole);
  const updateRole = useStore((state) => state.updateRole);
  const deleteRole = useStore((state) => state.deleteRole);
  const assignRole = useStore((state) => state.assignRole);
  const createChannel = useStore((state) => state.createChannel);
  const deleteChannel = useStore((state) => state.deleteChannel);
  const deleteGuild = useStore((state) => state.deleteGuild);
  const reorderChannels = useStore((state) => state.reorderChannels);
  const reorderRoles = useStore((state) => state.reorderRoles);
  const systemAdmin = useStore((state) => state.account?.isSystemAdmin === true);

  const [expiresInHours, setExpires] = useState<number | null>(null);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [roleColor, setRoleColor] = useState("#5B6CFF");
  const [rolePermissions, setRolePermissions] = useState<GuildPermission[]>([]);
  const [section, setSection] = useState<"overview" | "roles" | "members" | "channels" | "invites" | "bans" | "audit">("overview");
  const [channelName, setChannelName] = useState("");
  const [channelType, setChannelType] = useState<"text" | "voice">("text");
  const [permissionChannelId, setPermissionChannelId] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

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

  useEffect(() => setDeleteConfirmation(""), [admin?.guildId]);

  if (!admin) return null;

  const confirmModeration = async (entry: RosterEntry, action: "kick" | "ban") => {
    const verb = action === "ban" ? "banir" : "expulsar";
    if (!window.confirm(`Deseja realmente ${verb} ${entry.username} deste servidor?`)) return;
    const reason = window.prompt("Motivo (opcional):");
    if (reason === null) return;
    await (action === "ban"
      ? banMember(entry.id, reason.trim() || undefined)
      : kickMember(entry.id, reason.trim() || undefined));
  };
  const guild = guilds.find((item) => item.id === admin.guildId);
  const canInvite = admin.permissions.includes("create_invites");
  const canBan = admin.permissions.includes("ban_members");
  const canRoles = admin.permissions.includes("manage_roles");
  const canChannels = admin.permissions.includes("manage_channels");
  const canModerate = admin.permissions.includes("moderate_members");
  const canAudit = admin.permissions.includes("view_audit_log");
  const guildChannels = channels.filter((channel) => channel.guildId === admin.guildId);
  const editableRoles = admin.roles.filter((role) => !role.isDefault);
  const highestRole = (userId: string) => Math.max(
    0,
    ...admin.roles
      .filter((role) => (admin.memberRoles[userId] ?? []).includes(role.id))
      .map((role) => role.position),
  );
  const canActOn = (targetId: string) => targetId !== guild?.ownerId && (
    admin.owner || systemAdmin || highestRole(selfId ?? "") > highestRole(targetId)
  );

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

        <div className="admin-layout">
          <nav className="admin-nav" aria-label="Seções do servidor">
            <button type="button" data-active={section === "overview"} onClick={() => setSection("overview")}>Visão geral</button>
            {canRoles && <button type="button" data-active={section === "roles"} onClick={() => setSection("roles")}>Cargos</button>}
            <button type="button" data-active={section === "members"} onClick={() => setSection("members")}>Membros <span>{admin.roster.length}</span></button>
            {canChannels && <button type="button" data-active={section === "channels"} onClick={() => setSection("channels")}>Canais <span>{guildChannels.length}</span></button>}
            {canInvite && <button type="button" data-active={section === "invites"} onClick={() => setSection("invites")}>Convites <span>{admin.invites.length}</span></button>}
            {canBan && <button type="button" data-active={section === "bans"} onClick={() => setSection("bans")}>Banimentos <span>{admin.bans.length}</span></button>}
            {canAudit && <button type="button" data-active={section === "audit"} onClick={() => setSection("audit")}>Registro de auditoria</button>}
          </nav>

          <div className="modal-body admin-content">
          {admin.error && <p className="status-warn">{admin.error}</p>}

          {section === "overview" && (
            <section className="settings-section admin-overview">
              <span className="admin-guild-mark" style={{ background: guild?.color }}>{guild?.initials}</span>
              <div>
                <h3>{guild?.name}</h3>
                <p className="hint">{admin.roster.length} membros · {guildChannels.length} canais · servidor privado</p>
                <p className="hint">As regras de acesso são definidas pelos cargos e permissões deste servidor.</p>
              </div>
            </section>
          )}

          {section === "overview" && admin.owner && (
            <section className="settings-section admin-danger-zone">
              <div>
                <h3>Excluir servidor</h3>
                <p className="hint">
                  Esta ação apaga permanentemente canais, mensagens, cargos, convites e anexos deste servidor.
                  Não existe desfazer.
                </p>
              </div>
              <label className="field">
                <span>Digite <strong>{guild?.name}</strong> para confirmar</span>
                <input
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={guild?.name}
                />
              </label>
              <button
                type="button"
                className="secondary-button danger"
                disabled={admin.busy || !guild?.name || deleteConfirmation !== guild.name}
                onClick={() => void deleteGuild(admin.guildId)}
              >
                Excluir servidor permanentemente
              </button>
            </section>
          )}

          {section === "invites" && canInvite && <section className="settings-section">
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
          </section>}

          {section === "roles" && canRoles && (
            <section className="settings-section">
              <h3>Cargos e permissões</h3>
              <p className="hint">Crie um cargo, escolha o que ele pode fazer e atribua aos membros.</p>
              <div className="role-create">
                <input value={roleName} onChange={(event) => setRoleName(event.target.value)} maxLength={32} placeholder="Nome do cargo" />
                <input type="color" value={roleColor} onChange={(event) => setRoleColor(event.target.value)} title="Cor do cargo" />
              </div>
              <PermissionGrid available={admin.availablePermissions} value={rolePermissions} onChange={setRolePermissions} />
              <button type="button" className="primary-button" disabled={roleName.trim().length < 2 || admin.busy} onClick={() => void createRole(roleName, roleColor, rolePermissions).then((error) => { if (!error) { setRoleName(""); setRolePermissions([]); } })}>Criar cargo</button>
              <div className="role-list">
                {editableRoles.map((role, index) => (
                  <RoleEditor
                    key={role.id}
                    role={role}
                    available={admin.availablePermissions}
                    onSave={updateRole}
                    onDelete={deleteRole}
                    memberCount={Object.values(admin.memberRoles).filter((ids) => ids.includes(role.id)).length}
                    canMoveUp={index > 0}
                    canMoveDown={index < editableRoles.length - 1}
                    onMove={(offset) => {
                      const ids = shiftedIds(editableRoles, role.id, offset);
                      if (ids) void reorderRoles(ids);
                    }}
                  />
                ))}
                {admin.roles.filter((role) => role.isDefault).map((role) => (
                  <article key={role.id} className="role-editor role-default">
                    <div className="role-editor-summary">
                      <span className="role-color" style={{ background: role.color ?? "var(--text-faint)" }} />
                      <strong>{role.name}</strong>
                      <small>{admin.roster.length} membros</small>
                    </div>
                    <p className="hint">Cargo base protegido. Todos os membros recebem estas permissões.</p>
                  </article>
                ))}
              </div>
            </section>
          )}

          {section === "members" && <section className="settings-section">
            <h3>Membros — {admin.roster.length}</h3>
            <ul className="admin-list">
              {admin.roster.map((entry) => (
                <li key={entry.id}>
                  <span className="admin-name">{entry.username}</span>
                  {entry.id === selfId && <span className="admin-tag">você</span>}
                  {entry.id === guild?.ownerId && <span className="admin-tag">dono</span>}
                  {canBan && entry.id !== selfId && canActOn(entry.id) && (
                    <button
                      type="button"
                      className="link-button danger"
                      disabled={admin.busy}
                      onClick={() => void confirmModeration(entry, "ban")}
                    >
                      Banir
                    </button>
                  )}
                  {canModerate && entry.id !== selfId && canActOn(entry.id) && <>
                    <button type="button" className="link-button" disabled={admin.busy} onClick={() => void timeoutMember(entry.id, 10 * 60 * 1000)}>Timeout 10 min</button>
                    <button type="button" className="link-button danger" disabled={admin.busy} onClick={() => void confirmModeration(entry, "kick")}>Expulsar</button>
                  </>}
                  {canRoles && admin.roles.filter((role) => !role.isDefault).map((role) => (
                    <label key={role.id} className="member-role" title={`Cargo ${role.name}`}>
                      <input type="checkbox" checked={(admin.memberRoles[entry.id] ?? []).includes(role.id)} onChange={(event) => void assignRole(entry.id, role.id, event.target.checked)} />
                      <span style={{ color: role.color ?? undefined }}>{role.name}</span>
                    </label>
                  ))}
                </li>
              ))}
            </ul>
          </section>}

          {section === "channels" && canChannels && (
            <section className="settings-section">
              <h3>Canais</h3>
              <p className="hint">Crie e remova canais usando as permissões reais do servidor.</p>
              <div className="admin-channel-create">
                <select value={channelType} onChange={(event) => setChannelType(event.target.value as "text" | "voice")}>
                  <option value="text">Texto</option>
                  <option value="voice">Voz</option>
                </select>
                <input value={channelName} onChange={(event) => setChannelName(event.target.value)} maxLength={32} placeholder="Nome do canal" />
                <button type="button" className="primary-button" disabled={admin.busy || channelName.trim().length < 2} onClick={() => void createChannel(admin.guildId, channelType, channelName).then((error) => { if (!error) setChannelName(""); })}>Criar</button>
              </div>
              <ul className="admin-list admin-channel-list">
                {guildChannels.map((channel, index) => (
                  <li key={channel.id}>
                    {channel.type === "voice" ? <SpeakerIcon size={16} /> : <HashIcon size={16} />}
                    <span className="admin-name">{channel.name}</span>
                    <span>{channel.category}</span>
                    <span className="order-actions">
                      <button type="button" disabled={index === 0} onClick={() => { const ids = shiftedIds(guildChannels, channel.id, -1); if (ids) void reorderChannels(admin.guildId, ids); }} title="Mover para cima">↑</button>
                      <button type="button" disabled={index === guildChannels.length - 1} onClick={() => { const ids = shiftedIds(guildChannels, channel.id, 1); if (ids) void reorderChannels(admin.guildId, ids); }} title="Mover para baixo">↓</button>
                    </span>
                    <button type="button" className="link-button" onClick={() => setPermissionChannelId(channel.id)}>Permissões</button>
                    <button type="button" className="link-button danger" onClick={() => void deleteChannel(channel.id)} title={`Apagar ${channel.name}`}><TrashIcon size={15} /></button>
                  </li>
                ))}
              </ul>
              {permissionChannelId && <ChannelPermissionEditor
                channelId={permissionChannelId}
                roles={admin.roles}
                roster={admin.roster}
                available={admin.availablePermissions}
                onClose={() => setPermissionChannelId(null)}
              />}
            </section>
          )}

          {section === "bans" && canBan && (
            <section className="settings-section">
              <h3>Banidos — {admin.bans.length}</h3>
              {admin.bans.length === 0 && <p className="hint">Nenhuma pessoa está banida deste servidor.</p>}
              <ul className="admin-list">
                {admin.bans.map((ban) => (
                  <li key={ban.userId}>
                    <span className="admin-name">{ban.username ?? "Pessoa removida"}</span>
                    {ban.reason && <span>{ban.reason}</span>}
                    <span>
                      por {ban.moderatorUsername ?? "moderador removido"} · {new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(ban.createdAt)}
                    </span>
                    <button
                      type="button"
                      className="link-button"
                      disabled={admin.busy}
                      onClick={() => void unbanMember(ban.userId)}
                    >
                      Desbanir
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {section === "members" && canModerate && admin.timeouts.length > 0 && <section className="settings-section">
            <h3>Em timeout</h3>
            <ul className="admin-list">{admin.timeouts.map((timeout) => <li key={timeout.userId}>
              <span className="admin-name">{timeout.username ?? "Membro"}</span>
              <span>até {new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(timeout.expiresAt)}</span>
              <button type="button" className="link-button" onClick={() => void removeTimeout(timeout.userId)}>Remover timeout</button>
            </li>)}</ul>
          </section>}

          {section === "audit" && canAudit && <section className="settings-section">
            <h3>Registro de auditoria</h3>
            <p className="hint">Ações administrativas, sem conteúdo de mensagens ou dados secretos.</p>
            {admin.auditLog.length === 0 ? <p className="hint">Ainda não há ações registradas.</p> : <ul className="admin-list audit-list">{admin.auditLog.map((entry) => <li key={entry.id}>
              <span className="admin-name">{entry.actorUsername ?? "Conta removida"}</span>
              <span>{entry.action}</span>
              <time dateTime={new Date(entry.at).toISOString()}>{new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(entry.at)}</time>
            </li>)}</ul>}
          </section>}

          {/* Sair fecha o painel junto: ele mostra um servidor que deixou de ser seu. */}
          {section === "overview" && !admin.owner && !systemAdmin && (
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
    </div>
  );
}

function ChannelPermissionEditor({ channelId, roles, roster, available, onClose }: {
  channelId: string;
  roles: Role[];
  roster: RosterEntry[];
  available: GuildPermission[];
  onClose: () => void;
}) {
  const overwrites = useStore((state) => state.channelOverwrites[channelId] ?? []);
  const load = useStore((state) => state.loadChannelPermissions);
  const save = useStore((state) => state.saveChannelPermissions);
  const targets = [
    ...roles.map((role) => ({ value: `role:${role.id}`, label: role.name })),
    ...roster.map((member) => ({ value: `member:${member.id}`, label: member.username })),
  ];
  const [target, setTarget] = useState(targets[0]?.value ?? "");
  const [draft, setDraft] = useState<Record<string, "inherit" | "allow" | "deny">>({});

  useEffect(() => { void load(channelId); }, [channelId, load]);
  useEffect(() => {
    const separator = target.indexOf(":");
    const targetType = target.slice(0, separator);
    const targetId = target.slice(separator + 1);
    const overwrite = overwrites.find((item) => item.targetType === targetType && item.targetId === targetId);
    setDraft(Object.fromEntries(available.map((permission) => [permission,
      overwrite?.allow.includes(permission) ? "allow" : overwrite?.deny.includes(permission) ? "deny" : "inherit",
    ])));
  }, [available, overwrites, target]);

  const separator = target.indexOf(":");
  const targetType = target.slice(0, separator) as "role" | "member";
  const targetId = target.slice(separator + 1);
  return <div className="permission-editor">
    <div className="permission-editor-head"><strong>Permissões do canal</strong><button type="button" className="link-button" onClick={onClose}>Fechar</button></div>
    <select value={target} onChange={(event) => setTarget(event.target.value)}>{targets.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
    <div className="permission-overwrite-grid">{available.map((permission) => <label key={permission}>
      <span>{PERMISSION_LABEL[permission]}</span>
      <select value={draft[permission] ?? "inherit"} onChange={(event) => setDraft((current) => ({ ...current, [permission]: event.target.value as "inherit" | "allow" | "deny" }))}>
        <option value="inherit">Herdado</option><option value="allow">Permitido</option><option value="deny">Negado</option>
      </select>
    </label>)}</div>
    <button type="button" className="primary-button" disabled={!targetId} onClick={() => void save(
      channelId, targetType, targetId,
      available.filter((permission) => draft[permission] === "allow"),
      available.filter((permission) => draft[permission] === "deny"),
    )}>Salvar permissões</button>
  </div>;
}

function RoleEditor({
  role,
  available,
  onSave,
  onDelete,
  canMoveUp,
  canMoveDown,
  onMove,
  memberCount,
}: {
  role: Role;
  available: GuildPermission[];
  onSave: (id: string, name: string, color: string | null, permissions: GuildPermission[]) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (offset: -1 | 1) => void;
  memberCount: number;
}) {
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState(role.color ?? "#5B6CFF");
  const [permissions, setPermissions] = useState<GuildPermission[]>(role.permissions);
  return (
    <article className="role-editor">
      <div className="role-editor-summary">
        <span className="role-color" style={{ background: color }} />
        <strong>{role.name}</strong>
        <small>{memberCount} {memberCount === 1 ? "membro" : "membros"}</small>
      </div>
      <div className="role-create">
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={32} />
        <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
      </div>
      <PermissionGrid available={available} value={permissions} onChange={setPermissions} />
      <div className="role-actions">
        <button type="button" className="secondary-button" onClick={() => void onSave(role.id, name, color, permissions)}>Salvar</button>
        <span className="order-actions" aria-label="Hierarquia do cargo">
          <button type="button" disabled={!canMoveUp} onClick={() => onMove(-1)} title="Subir cargo">↑</button>
          <button type="button" disabled={!canMoveDown} onClick={() => onMove(1)} title="Descer cargo">↓</button>
        </span>
        <button type="button" className="link-button danger" onClick={() => void onDelete(role.id)}>Apagar</button>
      </div>
    </article>
  );
}

function PermissionGrid({ available, value, onChange }: {
  available: GuildPermission[];
  value: GuildPermission[];
  onChange: (permissions: GuildPermission[]) => void;
}) {
  return (
    <div className="permission-groups">
      {PERMISSION_GROUPS.map(([group, permissions]) => {
        const visible = permissions.filter((permission) => available.includes(permission));
        if (!visible.length) return null;
        return <fieldset key={group} className="permission-group">
          <legend>{group}</legend>
          <div className="permission-grid">
            {visible.map((permission) => (
              <label key={permission} className={["ban_members", "manage_roles"].includes(permission) ? "danger-permission" : undefined}>
                <input type="checkbox" checked={value.includes(permission)} onChange={(event) => onChange(event.target.checked ? [...value, permission] : value.filter((item) => item !== permission))} />
                <span>{PERMISSION_LABEL[permission]}</span>
              </label>
            ))}
          </div>
        </fieldset>;
      })}
    </div>
  );
}

/**
 * Criar servidor ou entrar por convite. As duas coisas na mesma janela porque são
 * a mesma intenção vista de dois lados — "quero outro lugar para conversar" — e
 * quem abriu o `+` pode não saber ainda qual dos dois quer.
 */
export function GuildCreateModal({
  initialTab = "create",
  onClose,
}: {
  initialTab?: "create" | "join";
  onClose: () => void;
}) {
  const createGuild = useStore((state) => state.createGuild);
  const joinByInvite = useStore((state) => state.joinByInvite);

  const [tab, setTab] = useState<"create" | "join">(initialTab);
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

/** Criar canal de texto ou de voz, quando o cargo da pessoa permite. */
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
