import fs from "node:fs/promises";
import path from "node:path";

import {
  OPS,
  DEFAULT_CHUNK_SIZE,
  buildRpcPayload,
  parseRpcPayload,
  toSessionId,
} from "../shared/protocol.js";

function ensureMaster(instance) {
  if (!instance || instance.role !== "master") {
    throw new Error("fs 命名空间只能挂载在 master 实例上。");
  }
}

function normalizeOptions(options) {
  if (!options) return {};
  return typeof options === "object" ? options : {};
}

function normalizeChunkSize(size) {
  const v = Number(size);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.max(64 * 1024, Math.floor(v));
}

async function request(master, slaveId, meta, bodyFrames = [], options = {}) {
  const payload = buildRpcPayload(meta, bodyFrames);
  const response = await master.ROUTER(slaveId, payload, options);
  const parsed = parseRpcPayload(response);
  return parsed;
}

export function createMasterFsApi(master) {
  ensureMaster(master);

  return {
    async list(slaveId, dirPath, options) {
      const parsed = await request(
        master,
        slaveId,
        { op: OPS.LIST, path: String(dirPath ?? "") },
        [],
        normalizeOptions(options),
      );
      return parsed.meta;
    },

    async stat(slaveId, targetPath, options) {
      const parsed = await request(
        master,
        slaveId,
        { op: OPS.STAT, path: String(targetPath ?? "") },
        [],
        normalizeOptions(options),
      );
      return parsed.meta;
    },

    async get(slaveId, targetPath, options) {
      const parsed = await request(
        master,
        slaveId,
        { op: OPS.GET, path: String(targetPath ?? "") },
        [],
        normalizeOptions(options),
      );
      return parsed;
    },

    async delete(slaveId, targetPath, options) {
      const parsed = await request(
        master,
        slaveId,
        { op: OPS.DELETE, path: String(targetPath ?? "") },
        [],
        normalizeOptions(options),
      );
      return parsed.meta;
    },

    async rename(slaveId, fromPath, toPath, options) {
      const parsed = await request(
        master,
        slaveId,
        {
          op: OPS.RENAME,
          from: String(fromPath ?? ""),
          to: String(toPath ?? ""),
        },
        [],
        normalizeOptions(options),
      );
      return parsed.meta;
    },

    async patch(slaveId, targetPath, unifiedDiff, options) {
      const parsed = await request(
        master,
        slaveId,
        {
          op: OPS.PATCH,
          path: String(targetPath ?? ""),
          patch: String(unifiedDiff ?? ""),
        },
        [],
        normalizeOptions(options),
      );
      return parsed.meta;
    },

    async download(slaveId, remotePath, localPath, options = {}) {
      const opts = normalizeOptions(options);
      const chunkSize = normalizeChunkSize(opts.chunkSize);
      const sessionId = toSessionId(
        opts.sessionId ?? `${Date.now()}-${Math.random()}`,
      );
      const logChunks = Boolean(opts.logChunks);

      const absolutePath = path.resolve(String(localPath ?? ""));
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });

      const tmpPath = `${absolutePath}.tmp`;
      let offset = 0;

      try {
        const stat = await fs.stat(tmpPath);
        if (stat.isFile()) offset = stat.size;
      } catch {}

      const initResp = await request(
        master,
        slaveId,
        {
          op: OPS.DOWNLOAD_INIT,
          sessionId,
          path: String(remotePath ?? ""),
          chunkSize,
          offset,
        },
        [],
        opts,
      );

      const fileSize = Number(
        initResp.meta?.fileSize ?? initResp.meta?.size ?? 0,
      );
      if (!Number.isFinite(fileSize) || fileSize < 0) {
        throw new Error("download 初始化失败：fileSize 无效。");
      }

      const resumeOffset = Number(initResp.meta?.offset ?? offset);
      offset =
        Number.isFinite(resumeOffset) && resumeOffset > 0 ? resumeOffset : 0;

      const totalChunks = Math.ceil(fileSize / chunkSize);

      const createHandle = await fs.open(tmpPath, "a");
      await createHandle.close();

      const handle = await fs.open(tmpPath, "r+");
      try {
        let chunkId = Math.floor(offset / chunkSize);
        while (offset < fileSize) {
          const resp = await request(
            master,
            slaveId,
            {
              op: OPS.DOWNLOAD_CHUNK,
              sessionId,
              path: String(remotePath ?? ""),
              chunkId,
              offset,
              chunkSize,
              totalChunks,
            },
            [],
            opts,
          );

          const chunk = resp.body?.[0];
          if (!Buffer.isBuffer(chunk)) {
            throw new Error("download chunk payload 缺失或格式非法。");
          }

          await handle.write(chunk, 0, chunk.length, offset);

          if (logChunks) {
            console.log("[download chunk]", {
              sessionId,
              path: remotePath,
              chunkId,
              offset,
              size: chunk.length,
            });
          }

          offset += chunk.length;
          chunkId += 1;
        }
      } finally {
        await handle.close();
      }

      await fs.rm(absolutePath, { force: true });
      await fs.rename(tmpPath, absolutePath);

      const complete = await request(
        master,
        slaveId,
        {
          op: OPS.DOWNLOAD_COMPLETE,
          sessionId,
          path: String(remotePath ?? ""),
          fileSize,
          totalChunks,
        },
        [],
        opts,
      );

      return complete.meta;
    },

    async upload(slaveId, localPath, remotePath, options = {}) {
      const opts = normalizeOptions(options);
      const chunkSize = normalizeChunkSize(opts.chunkSize);
      const sessionId = toSessionId(
        opts.sessionId ?? `${Date.now()}-${Math.random()}`,
      );
      const logChunks = Boolean(opts.logChunks);

      const absolutePath = path.resolve(String(localPath ?? ""));
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        throw new Error("upload 仅支持文件路径。");
      }

      const initResp = await request(
        master,
        slaveId,
        {
          op: OPS.INIT,
          sessionId,
          path: String(remotePath ?? ""),
          fileName: path.basename(absolutePath),
          fileSize: stat.size,
          chunkSize,
        },
        [],
        opts,
      );

      const resumeOffset = Number(initResp.meta?.offset ?? 0);
      const startOffset =
        Number.isFinite(resumeOffset) && resumeOffset > 0 ? resumeOffset : 0;

      const totalChunks = Math.ceil(stat.size / chunkSize);
      let offset = startOffset;
      let chunkId = Math.floor(offset / chunkSize);

      const handle = await fs.open(absolutePath, "r");
      try {
        while (offset < stat.size) {
          const remaining = stat.size - offset;
          const readSize = Math.min(chunkSize, remaining);
          const buffer = Buffer.allocUnsafe(readSize);
          const { bytesRead } = await handle.read(buffer, 0, readSize, offset);
          const chunk =
            bytesRead === buffer.length
              ? buffer
              : buffer.subarray(0, bytesRead);

          const ack = await request(
            master,
            slaveId,
            {
              op: OPS.CHUNK,
              sessionId,
              path: String(remotePath ?? ""),
              chunkId,
              totalChunks,
              offset,
              size: chunk.length,
            },
            [chunk],
            opts,
          );

          if (ack.meta?.op && ack.meta.op !== OPS.ACK) {
            throw new Error(`Chunk ACK 异常：${ack.meta.op}`);
          }

          if (logChunks) {
            console.log("[upload chunk]", {
              sessionId,
              path: remotePath,
              chunkId,
              offset,
              size: chunk.length,
            });
          }

          offset += chunk.length;
          chunkId += 1;
        }

        const complete = await request(
          master,
          slaveId,
          {
            op: OPS.COMPLETE,
            sessionId,
            path: String(remotePath ?? ""),
            fileName: path.basename(absolutePath),
            fileSize: stat.size,
            totalChunks,
          },
          [],
          opts,
        );

        return complete.meta;
      } finally {
        await handle.close();
      }
    },
  };
}
