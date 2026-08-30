import type { Attachment, DirectMessage, Message } from "@/types";

export const ATTACHMENT_ACCEPT = "image/jpeg,image/png,image/gif,image/webp,application/pdf";
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

interface ApiReply {
  ok: boolean;
  error?: string;
  attachmentId?: string;
  uploadUrl?: string;
  headers?: Record<string, string>;
}

function token(): string | null {
  try {
    const value = JSON.parse(localStorage.getItem("draco:session") ?? "null");
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function explain(code?: string): string {
  if (code === "storage-unavailable") return "O armazenamento de anexos ainda não foi configurado.";
  if (code === "attachment-type") return "Use JPG, PNG, GIF, WebP ou PDF.";
  if (code === "attachment-size") return "Cada arquivo pode ter no máximo 25 MB.";
  if (code === "attachment-invalid") return "O conteúdo do arquivo não corresponde ao formato informado.";
  if (code === "not-authenticated") return "Sua sessão expirou. Entre novamente.";
  return "Não foi possível enviar o anexo.";
}

async function json(path: string, body: unknown): Promise<ApiReply> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token() ?? ""}` },
    body: JSON.stringify(body),
  });
  const result = await response.json() as ApiReply;
  if (!response.ok || !result.ok) throw new Error(explain(result.error));
  return result;
}

export function validateAttachments(files: File[]): string | null {
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) return `Escolha no máximo ${MAX_ATTACHMENTS_PER_MESSAGE} arquivos por mensagem.`;
  for (const file of files) {
    if (!ATTACHMENT_ACCEPT.split(",").includes(file.type)) return `${file.name}: formato não permitido.`;
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) return `${file.name}: o limite é 25 MB.`;
  }
  return null;
}

export async function uploadAttachments(
  scope: "channel" | "direct",
  message: Message | DirectMessage,
  files: File[],
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  const validation = validateAttachments(files);
  if (validation) throw new Error(validation);
  let completed = 0;
  for (const file of files) {
    const signed = await json("/api/attachments/presign", {
      scope,
      messageId: message.id,
      filename: file.name,
      mime: file.type,
      size: file.size,
    });
    if (!signed.uploadUrl || !signed.attachmentId) throw new Error("Resposta inválida do armazenamento.");
    const uploaded = await fetch(signed.uploadUrl, { method: "PUT", headers: signed.headers, body: file });
    if (!uploaded.ok) throw new Error(`Falha ao transferir ${file.name}.`);
    await json("/api/attachments/complete", { attachmentId: signed.attachmentId });
    completed += 1;
    onProgress?.(completed, files.length);
  }
}

export function isImageAttachment(attachment: Attachment): boolean {
  return attachment.mime.startsWith("image/");
}
