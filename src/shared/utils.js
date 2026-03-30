import path from "node:path";
import fs from "node:fs/promises";

export function assertRoot(root) {
  const resolved = path.resolve(String(root ?? ""));
  if (!resolved) {
    throw new Error("root 不能为空。");
  }
  return resolved;
}

export function toSafePath(root, targetPath) {
  const base = assertRoot(root);
  const rel = String(targetPath ?? "");
  if (!rel) {
    throw new Error("path 不能为空。");
  }
  const resolved = path.resolve(base, rel);
  const normalizedBase = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (!resolved.startsWith(normalizedBase) && resolved !== base) {
    throw new Error("路径越权：目标不在 root 范围内。");
  }
  return resolved;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

export function toPosixPath(p) {
  return String(p ?? "").split(path.sep).join("/");
}

export function safeJoin(root, ...parts) {
  return toSafePath(root, path.join(...parts));
}

export function sanitizeListEntry(entry, stats) {
  return {
    name: entry.name,
    type: entry.isDirectory() ? "dir" : "file",
    size: stats?.size ?? 0,
    mtime: stats?.mtimeMs ?? 0,
  };
}

export function parseDiffHeader(patchText) {
  const text = String(patchText ?? "");
  const lines = text.split(/\r?\n/);
  let oldFile = "";
  let newFile = "";
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      oldFile = line.slice(4).trim();
    } else if (line.startsWith("+++ ")) {
      newFile = line.slice(4).trim();
    }
    if (oldFile && newFile) break;
  }
  return { oldFile, newFile };
}
