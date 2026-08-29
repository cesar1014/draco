export const GUILD_PERMISSIONS = [
  "view_channels",
  "send_messages",
  "connect",
  "speak",
  "manage_channels",
  "create_invites",
  "ban_members",
  "manage_roles",
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
