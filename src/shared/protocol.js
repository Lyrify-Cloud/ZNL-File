export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;

export const OPS = Object.freeze({
  LIST: "file/list",
  GET: "file/get",
  PATCH: "file/patch",
  INIT: "file/init",
  RESUME: "file/resume",
  CHUNK: "file/chunk",
  ACK: "file/ack",
  COMPLETE: "file/complete",
  DOWNLOAD_INIT: "file/download_init",
  DOWNLOAD_CHUNK: "file/download_chunk",
  DOWNLOAD_COMPLETE: "file/download_complete",
  DELETE: "file/delete",
  RENAME: "file/rename",
  STAT: "file/stat",
});

export function encodeJson(value) {
  return Buffer.from(JSON.stringify(value ?? {}), "utf8");
}

export function decodeJson(buffer) {
  if (!buffer) return {};
  const text = Buffer.isBuffer(buffer)
    ? buffer.toString("utf8")
    : String(buffer);
  if (!text) return {};
  return JSON.parse(text);
}

export function normalizePayloadFrames(payload) {
  if (Array.isArray(payload)) return payload;
  return [payload];
}

export function parseRpcPayload(payload) {
  const frames = normalizePayloadFrames(payload);
  if (!frames.length) return { meta: {}, body: [] };
  const [metaFrame, ...body] = frames;
  return { meta: decodeJson(metaFrame), body };
}

export function buildRpcPayload(meta, bodyFrames = []) {
  const metaFrame = encodeJson(meta);
  return [metaFrame, ...bodyFrames];
}

export function ensureOp(meta, expectedOp) {
  const op = meta?.op;
  if (op !== expectedOp) {
    throw new Error(`协议错误：期望 op=${expectedOp}，实际 op=${op}`);
  }
}

export function toSessionId(value) {
  const text = String(value ?? "");
  if (!text) throw new Error("sessionId 不能为空。");
  return text;
}
