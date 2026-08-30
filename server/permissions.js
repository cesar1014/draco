export const GUILD_PERMISSIONS = [
  "view_channels",
  "send_messages",
  "connect",
  "speak",
  "manage_channels",
  "create_invites",
  "ban_members",
  "manage_roles",
  "manage_messages",
  "moderate_members",
  "mention_everyone",
  "view_audit_log",
];

export const DEFAULT_GUILD_PERMISSIONS = [
  "view_channels",
  "send_messages",
  "connect",
  "speak",
];

const known = new Set(GUILD_PERMISSIONS);

export function sanitizePermissions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((permission) => known.has(permission)))];
}
