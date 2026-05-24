import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { getServerSideConfig } from "@/app/config/server";

const serverConfig = getServerSideConfig();
const DEFAULT_UPLOAD_SUBDIR = ".nextchat/uploads";

export function resolveUploadDir(): string {
  const configured = serverConfig.nextchatUploadDir?.trim();
  return configured || path.join(process.cwd(), DEFAULT_UPLOAD_SUBDIR);
}

export function resolveUploadMaxBytes(): number {
  const raw = Number(serverConfig.nextchatUploadMaxBytes ?? 0);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return 20 * 1024 * 1024;
}

export function sanitizeSlug(parts: string[]): string[] {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.includes("..") && !path.isAbsolute(part));
}

export function buildStoredFilename(originalName?: string, fallbackExtension?: string): string {
  const ext =
    path.extname(originalName ?? "").replace(/[^a-zA-Z0-9.]/g, "") ||
    (fallbackExtension ? `.${fallbackExtension.replace(/[^a-zA-Z0-9]/g, "")}` : "");
  return `${new Date().toISOString().slice(0, 10)}/${randomUUID()}${ext}`;
}

export async function ensureUploadDirFor(relativePath: string): Promise<string> {
  const absolutePath = path.join(resolveUploadDir(), relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  return absolutePath;
}

export function buildPublicFileUrl(reqUrl: string, relativePath: string): string {
  const base = serverConfig.nextchatPublicBaseUrl?.trim() || new URL(reqUrl).origin;
  return new URL(
    `/api/files/${relativePath.split(path.sep).join("/")}`,
    base.endsWith("/") ? base : `${base}/`,
  ).toString();
}

export function getContentTypeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}
