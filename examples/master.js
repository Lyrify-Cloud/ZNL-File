import { ZNL } from "@lyrify/znl";
import { createTwoFilesPatch } from "diff";
import "../index.js";

const master = new ZNL({
  role: "master",
  id: "master-1",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: "your-shared-key",
  encrypted: false,
});

function waitForSlave(id, timeoutMs = 10000) {
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

async function run() {
  await master.start();

  const slaveId = "core-001";
  await waitForSlave(slaveId, 10000);

  // 列目录
  const listResult = await master.fs.list(slaveId, ".");
  console.log("list:", listResult);

  // 获取文件
  const getResult = await master.fs.get(slaveId, "kuke.json");
  const content = Buffer.isBuffer(getResult.body?.[0])
    ? getResult.body[0].toString("utf8")
    : String(getResult.body?.[0] ?? "");
  console.log("get:", content);

  // Patch 示例（Master 只发送统一 diff）
  const originalText = content;
  const updatedText = content.replace('"name": "restaurant"', '"name": "aura"');
  const unifiedDiff = createTwoFilesPatch(
    "kuke.json",
    "kuke.json",
    originalText,
    updatedText,
  );

  const patchResult = await master.fs.patch(slaveId, "kuke.json", unifiedDiff);
  console.log("patch:", patchResult);

  // 上传示例
  const uploadResult = await master.fs.upload(
    slaveId,
    "./examples/upload.txt",
    "upload.txt",
  );
  console.log("upload:", uploadResult);

  // 下载示例
  const downloadResult = await master.fs.download(
    slaveId,
    "upload.txt",
    "./examples/download.txt",
  );
  console.log("download:", downloadResult);
}

run().catch((error) => {
  console.error("master error:", error);
  process.exitCode = 1;
});
