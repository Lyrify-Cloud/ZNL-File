import fs from "node:fs/promises";
import path from "node:path";
import { applyPatch } from "diff";

import {
  OPS,
  DEFAULT_CHUNK_SIZE,
  buildRpcPayload,
  parseRpcPayload,
  toSessionId,
} from "../shared/protocol.js";

import {
  assertRoot,
  toSafePath,
  ensureDir,
  statSafe,
  sanitizeListEntry,
  pathExists,
} from "../shared/utils.js";

function ensureSlave(instance) {
  if (!instance || instance.role !== "slave") {
    throw new Error("fs 命名空间只能挂载在 slave 实例上。");
  }
}

function normalizeChunkSize(size) {
  const v = Number(size);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.max(64 * 1024, Math.floor(v));
}

function normalizeClientPath(inputPath) {
  const raw = String(inputPath ?? "");
  if (!raw) return raw;

  if (path.isAbsolute(raw)) {
    const root = path.parse(raw).root;
    return path.relative(root, raw);
  }

  return raw;
}

function safePath(root, inputPath) {
  const normalized = normalizeClientPath(inputPath);
  return toSafePath(root, normalized);
}

function okMeta(op, extra = {}) {
  return { ok: true, op, ...extra };
}

function errMeta(op, error) {
  return {
    ok: false,
    op,
    error: error?.message ? String(error.message) : String(error),
  };
}

function createSessionStore() {
  return new Map();
}

async function openOrCreateTmpFile(tmpPath) {
  await ensureDir(path.dirname(tmpPath));
  await fs.open(tmpPath, "a").then((h) => h.close());
}

async function getTmpSize(tmpPath) {
  const stat = await statSafe(tmpPath);
  return stat?.size ?? 0;
}

async function writeChunk(tmpPath, offset, chunk) {
  const handle = await fs.open(tmpPath, "r+");
  try {
    await handle.write(chunk, 0, chunk.length, offset);
  } finally {
    await handle.close();
  }
}

async function removeIfExists(targetPath) {
  if (!(await pathExists(targetPath))) return;
  await fs.rm(targetPath, { force: true, recursive: true });
}

export function createSlaveFsApi(slave) {
  ensureSlave(slave);

  const sessions = createSessionStore();
  let rootDir = null;
  let logChunks = false;
  let handlerInstalled = false;

  async function handleList(meta) {
    const target = safePath(rootDir, meta.path);
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      throw new Error("目标不是目录。");
    }

    const entries = await fs.readdir(target, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const full = path.join(target, entry.name);
      const childStat = await statSafe(full);
      result.push(sanitizeListEntry(entry, childStat));
    }

    return buildRpcPayload(
      okMeta(OPS.LIST, { entries: result, path: meta.path }),
    );
  }

  async function handleStat(meta) {
    const target = safePath(rootDir, meta.path);
    const stat = await fs.stat(target);
    return buildRpcPayload(
      okMeta(OPS.STAT, {
        path: meta.path,
        size: stat.size,
        mtime: stat.mtimeMs,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
      }),
    );
  }

  async function handleGet(meta) {
    const target = safePath(rootDir, meta.path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new Error("目标不是文件。");
    }

    const buffer = await fs.readFile(target);
    const payload = buildRpcPayload(
      okMeta(OPS.GET, { path: meta.path, size: buffer.length }),
      [buffer],
    );
    return payload;
  }

  async function handleDelete(meta) {
    const target = safePath(rootDir, meta.path);
    await fs.rm(target, { recursive: true, force: true });
    return buildRpcPayload(okMeta(OPS.DELETE, { path: meta.path }));
  }

  async function handleRename(meta) {
    const fromPath = safePath(rootDir, meta.from);
    const toPath = safePath(rootDir, meta.to);
    await ensureDir(path.dirname(toPath));
    await fs.rename(fromPath, toPath);
    return buildRpcPayload(
      okMeta(OPS.RENAME, { from: meta.from, to: meta.to }),
    );
  }

  async function handlePatch(meta) {
    const target = safePath(rootDir, meta.path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new Error("目标不是文件。");
    }

    const content = await fs.readFile(target, "utf8");
    const rawPatch = String(meta.patch ?? "");
    const patchText = rawPatch
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("==="))
      .join("\n")
      .replace(/\s+$/u, "");

    const normalizedContent = content.replace(/\r\n/g, "\n");
    const candidates = [
      patchText,
      `${patchText}\n`,
      patchText.replace(/^\uFEFF/, ""),
    ];

    let patched = false;
    for (const candidate of candidates) {
      patched = applyPatch(normalizedContent, candidate, { fuzzFactor: 3 });
      if (patched !== false) break;
    }

    if (patched === false) {
      return buildRpcPayload(
        okMeta(OPS.PATCH, {
          path: meta.path,
          applied: false,
          message: "patch 应用失败",
        }),
      );
    }

    await fs.writeFile(target, patched, "utf8");
    return buildRpcPayload(
      okMeta(OPS.PATCH, {
        path: meta.path,
        applied: true,
      }),
    );
  }

  async function handleInit(meta) {
    const sessionId = toSessionId(meta.sessionId);
    const chunkSize = normalizeChunkSize(meta.chunkSize);
    const target = safePath(rootDir, meta.path);
    const tmpPath = `${target}.tmp`;

    await openOrCreateTmpFile(tmpPath);
    const offset = await getTmpSize(tmpPath);

    sessions.set(sessionId, {
      sessionId,
      targetPath: target,
      tmpPath,
      chunkSize,
      fileSize: Number(meta.fileSize ?? 0),
    });

    return buildRpcPayload(
      okMeta(OPS.RESUME, {
        sessionId,
        path: meta.path,
        offset,
        chunkSize,
      }),
    );
  }

  async function handleChunk(meta, body) {
    const sessionId = toSessionId(meta.sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error("session 不存在或已过期。");
    }

    const chunk = body?.[0];
    if (!Buffer.isBuffer(chunk)) {
      throw new Error("chunk payload 缺失或格式非法。");
    }

    const expectedOffset = Number(meta.offset ?? 0);
    const expectedChunkId = Number(meta.chunkId ?? 0);

    const offset = await getTmpSize(session.tmpPath);
    const currentChunkId = Math.floor(offset / session.chunkSize);

    if (offset !== expectedOffset || currentChunkId !== expectedChunkId) {
      throw new Error(
        `chunk 偏移不一致：expect offset=${expectedOffset}, actual offset=${offset}`,
      );
    }

    await writeChunk(session.tmpPath, offset, chunk);

    if (logChunks) {
      console.log("[slave upload chunk]", {
        sessionId,
        path: meta.path,
        chunkId: expectedChunkId,
        offset,
        size: chunk.length,
      });
    }

    return buildRpcPayload(
      okMeta(OPS.ACK, {
        sessionId,
        path: meta.path,
        chunkId: expectedChunkId,
        offset: offset + chunk.length,
        size: chunk.length,
      }),
    );
  }

  async function handleComplete(meta) {
    const sessionId = toSessionId(meta.sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error("session 不存在或已过期。");
    }

    await ensureDir(path.dirname(session.targetPath));
    await removeIfExists(session.targetPath);
    await fs.rename(session.tmpPath, session.targetPath);

    sessions.delete(sessionId);

    return buildRpcPayload(
      okMeta(OPS.COMPLETE, {
        sessionId,
        path: meta.path,
        ok: true,
      }),
    );
  }

  async function handleDownloadInit(meta) {
    const sessionId = toSessionId(meta.sessionId);
    const chunkSize = normalizeChunkSize(meta.chunkSize);
    const target = safePath(rootDir, meta.path);

    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new Error("目标不是文件。");
    }

    const fileSize = stat.size;
    const offsetInput = Number(meta.offset ?? 0);
    const offset =
      Number.isFinite(offsetInput) && offsetInput > 0 ? offsetInput : 0;

    if (offset > fileSize) {
      throw new Error("download offset 超出文件大小。");
    }

    sessions.set(sessionId, {
      sessionId,
      targetPath: target,
      chunkSize,
      fileSize,
      mode: "download",
    });

    return buildRpcPayload(
      okMeta(OPS.DOWNLOAD_INIT, {
        sessionId,
        path: meta.path,
        fileSize,
        offset,
        chunkSize,
      }),
    );
  }

  async function handleDownloadChunk(meta) {
    const sessionId = toSessionId(meta.sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error("session 不存在或已过期。");
    }

    const offset = Number(meta.offset ?? 0);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error("download offset 非法。");
    }

    if (offset > session.fileSize) {
      throw new Error("download offset 超出文件大小。");
    }

    const size = Math.min(session.chunkSize, session.fileSize - offset);
    const buffer = Buffer.allocUnsafe(size);

    const handle = await fs.open(session.targetPath, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      const chunk =
        bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);

      if (logChunks) {
        console.log("[slave download chunk]", {
          sessionId,
          path: meta.path,
          chunkId: Number(meta.chunkId ?? 0),
          offset,
          size: chunk.length,
        });
      }

      return buildRpcPayload(
        okMeta(OPS.DOWNLOAD_CHUNK, {
          sessionId,
          path: meta.path,
          chunkId: Number(meta.chunkId ?? 0),
          offset,
          size: chunk.length,
        }),
        [chunk],
      );
    } finally {
      await handle.close();
    }
  }

  async function handleDownloadComplete(meta) {
    const sessionId = toSessionId(meta.sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error("session 不存在或已过期。");
    }

    sessions.delete(sessionId);

    return buildRpcPayload(
      okMeta(OPS.DOWNLOAD_COMPLETE, {
        sessionId,
        path: meta.path,
        ok: true,
      }),
    );
  }

  async function dispatch(payload) {
    const { meta, body } = parseRpcPayload(payload);

    switch (meta?.op) {
      case OPS.LIST:
        return await handleList(meta);
      case OPS.STAT:
        return await handleStat(meta);
      case OPS.GET:
        return await handleGet(meta);
      case OPS.DELETE:
        return await handleDelete(meta);
      case OPS.RENAME:
        return await handleRename(meta);
      case OPS.PATCH:
        return await handlePatch(meta);
      case OPS.INIT:
        return await handleInit(meta);
      case OPS.CHUNK:
        return await handleChunk(meta, body);
      case OPS.COMPLETE:
        return await handleComplete(meta);
      case OPS.DOWNLOAD_INIT:
        return await handleDownloadInit(meta);
      case OPS.DOWNLOAD_CHUNK:
        return await handleDownloadChunk(meta);
      case OPS.DOWNLOAD_COMPLETE:
        return await handleDownloadComplete(meta);
      default:
        throw new Error(`未知 op：${meta?.op}`);
    }
  }

  async function installHandler() {
    if (handlerInstalled) return;
    handlerInstalled = true;

    await slave.DEALER(async ({ payload }) => {
      try {
        const reply = await dispatch(payload);
        return reply;
      } catch (error) {
        const meta = parseRpcPayload(payload).meta || {};
        return buildRpcPayload(errMeta(meta.op || "error", error));
      }
    });
  }

  return {
    enable(options = {}) {
      const { root, logChunks: logChunksInput } = options || {};
      rootDir = assertRoot(root);
      logChunks = Boolean(logChunksInput);
      return installHandler();
    },
  };
}
