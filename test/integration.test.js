import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { ZNL } from "@lyrify/znl";
import "../index.js";

const ROUTER_ENDPOINT_PLAIN = "tcp://127.0.0.1:6007";
const ROUTER_ENDPOINT_SECURE = "tcp://127.0.0.1:6008";
const AUTH_KEY = "test-shared-key";

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeFile(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf8");
}

async function readFile(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function logLine(label, data) {
  console.log(label, JSON.stringify(data));
}

function createMaster({ endpoint, encrypted }) {
  return new ZNL({
    role: "master",
    id: "master-it",
    endpoints: { router: endpoint },
    authKey: AUTH_KEY,
    encrypted,
  });
}

function createSlave({ endpoint, encrypted }) {
  return new ZNL({
    role: "slave",
    id: "core-001",
    endpoints: { router: endpoint },
    authKey: AUTH_KEY,
    encrypted,
  });
}

function waitForSlave(master, id, timeoutMs = 10000) {
  if (master.slaves.includes(id)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      master.off("slave_connected", onConnected);
      reject(new Error(`等待 slave 超时：${id}`));
    }, timeoutMs);

    function onConnected(connectedId) {
      if (connectedId !== id) return;
      clearTimeout(timer);
      master.off("slave_connected", onConnected);
      resolve();
    }

    master.on("slave_connected", onConnected);
  });
}

async function runScenario({ label, encrypted, endpoint }) {
  const root = path.join(process.cwd(), "test", "tmp", label);
  const slaveRoot = path.join(root, "slave");
  const localRoot = path.join(root, "local");
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const initialName = `kuke-${suffix}.json`;
  const renamedName = `kuke-${suffix}-renamed.json`;
  const uploadName = `upload-${suffix}.txt`;
  const downloadName = `download-${suffix}.txt`;
  const largeName = `large-${suffix}.bin`;
  const largeDownloadName = `large-${suffix}-download.bin`;

  console.log(`场景开始：${label} (encrypted=${encrypted})`);
  console.log("步骤 1/15：初始化测试目录");

  await ensureDir(slaveRoot);
  await ensureDir(localRoot);

  console.log("步骤 2/15：准备初始文件");

  const initialFile = path.join(slaveRoot, initialName);
  await writeFile(initialFile, '{\n  "name": "restaurant"\n}\n');

  console.log("步骤 3/15：启动 Master / Slave");

  const master = createMaster({ endpoint, encrypted });
  const slave = createSlave({ endpoint, encrypted });

  await master.start();
  await slave.start();

  console.log("步骤 4/15：启用 Slave 文件服务并等待上线");

  await slave.fs.enable({ root: slaveRoot, logChunks: true });
  await waitForSlave(master, "core-001", 10000);

  console.log("步骤 5/15：执行 list");

  const listResult = await master.fs.list("core-001", ".");
  logLine("list 返回：", listResult);
  assert.equal(listResult.ok, true);

  console.log("步骤 6/15：执行 stat");
  assert.ok(
    Array.isArray(listResult.entries) &&
      listResult.entries.some((e) => e.name === initialName),
  );

  const statResult = await master.fs.stat("core-001", initialName);
  logLine("stat 返回：", statResult);
  assert.equal(statResult.ok, true);
  assert.equal(statResult.isFile, true);

  console.log("步骤 7/15：执行 get");

  const getResult = await master.fs.get("core-001", initialName);
  const getBuffer = Buffer.isBuffer(getResult.body?.[0])
    ? getResult.body[0]
    : Buffer.from(String(getResult.body?.[0] ?? ""), "utf8");
  const getText = getBuffer.toString("utf8");
  logLine("get 返回内容：", { text: getText });

  const initialHash = await hashFile(initialFile);
  const getHash = hashBuffer(getBuffer);
  logLine("get hash 校验：", { file: initialHash, get: getHash });
  assert.equal(getHash, initialHash);

  console.log("步骤 8/15：执行 patch");
  assert.ok(getText.includes('"name": "restaurant"'));

  const originalText = getText;
  const updatedText = getText.replace('"name": "restaurant"', '"name": "aura"');

  const { createTwoFilesPatch } = await import("diff");
  const unifiedDiff = createTwoFilesPatch(
    initialName,
    initialName,
    originalText,
    updatedText,
  );

  const patchResult = await master.fs.patch(
    "core-001",
    initialName,
    unifiedDiff,
  );
  logLine("patch 返回：", patchResult);
  assert.equal(patchResult.ok, true);
  assert.equal(patchResult.applied, true);

  const patchedText = await readFile(initialFile);
  assert.ok(patchedText.includes('"name": "aura"'));
  const patchedHash = await hashFile(initialFile);
  const expectedPatchHash = hashBuffer(Buffer.from(updatedText, "utf8"));
  logLine("patch hash 校验：", {
    file: patchedHash,
    expected: expectedPatchHash,
  });
  assert.equal(patchedHash, expectedPatchHash);

  console.log("步骤 9/15：执行 rename");
  const renameResult = await master.fs.rename(
    "core-001",
    initialName,
    renamedName,
  );
  logLine("rename 返回：", renameResult);
  assert.equal(renameResult.ok, true);

  const renamedStat = await master.fs.stat("core-001", renamedName);
  logLine("rename 后 stat 返回：", renamedStat);
  assert.equal(renamedStat.ok, true);
  assert.equal(renamedStat.isFile, true);

  console.log("步骤 10/15：执行 upload");

  const uploadSource = path.join(localRoot, uploadName);
  await writeFile(uploadSource, "example upload content\n");

  console.log("步骤 11/15：执行 download");

  const uploadResult = await master.fs.upload(
    "core-001",
    uploadSource,
    uploadName,
    { logChunks: true },
  );
  logLine("upload 返回：", uploadResult);
  assert.equal(uploadResult.ok, true);

  const downloadTarget = path.join(localRoot, downloadName);
  const downloadResult = await master.fs.download(
    "core-001",
    uploadName,
    downloadTarget,
    { logChunks: true },
  );
  logLine("download 返回：", downloadResult);
  assert.equal(downloadResult.ok, true);

  console.log("步骤 12/15：执行大文件上传（20MB）");
  const largeSize = 20 * 1024 * 1024;
  const largeSource = path.join(localRoot, largeName);
  await fs.writeFile(largeSource, Buffer.alloc(largeSize, 97));

  const largeUploadResult = await master.fs.upload(
    "core-001",
    largeSource,
    largeName,
    { logChunks: true },
  );
  logLine("大文件 upload 返回：", largeUploadResult);
  assert.equal(largeUploadResult.ok, true);

  console.log("步骤 13/15：执行大文件下载（20MB）");
  const largeDownloadTarget = path.join(localRoot, largeDownloadName);
  const largeDownloadResult = await master.fs.download(
    "core-001",
    largeName,
    largeDownloadTarget,
    { logChunks: true },
  );
  logLine("大文件 download 返回：", largeDownloadResult);
  assert.equal(largeDownloadResult.ok, true);

  const largeStat = await fs.stat(largeDownloadTarget);
  assert.equal(largeStat.size, largeSize);

  const largeSourceHash = await hashFile(largeSource);
  const largeDownloadHash = await hashFile(largeDownloadTarget);
  logLine("大文件 hash 校验：", {
    source: largeSourceHash,
    download: largeDownloadHash,
  });
  assert.equal(largeDownloadHash, largeSourceHash);

  console.log("步骤 14/15：执行 delete");
  const deleteResult = await master.fs.delete("core-001", renamedName);
  logLine("delete 返回：", deleteResult);
  assert.equal(deleteResult.ok, true);

  const downloadedText = await readFile(downloadTarget);
  assert.equal(downloadedText.trim(), "example upload content");

  console.log("步骤 15/15：结束测试并清理");

  await slave.stop();
  await master.stop();

  console.log(`integration test (${label}): OK`);
}

async function run() {
  await runScenario({
    label: "plain",
    encrypted: false,
    endpoint: ROUTER_ENDPOINT_PLAIN,
  });

  await runScenario({
    label: "encrypted",
    encrypted: true,
    endpoint: ROUTER_ENDPOINT_SECURE,
  });

  await fs.rm(path.join(process.cwd(), "test", "tmp"), {
    recursive: true,
    force: true,
  });
}

run().catch((error) => {
  console.error("integration test failed:", error);
  process.exitCode = 1;
});
