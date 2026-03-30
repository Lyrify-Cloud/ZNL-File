# @lyrify/znl-plugin-fs

基于 ZNL 的文件管理插件（Master 管理、Slave 存储），提供：
- 目录/文件的增删查改（CRUD）
- 统一 diff 的 patch 应用
- 大文件分片上传/下载（5MB 分片、ACK 确认、断点续传）

> 适用场景：使用 ZNL 作为通信层，在远程节点上进行可靠的文件管理。

---

## 特性

- **命名空间注入**：加载插件后自动为 `ZNL` 实例注入 `fs` 命名空间
- **CRUD**：`list` / `get` / `patch` / `delete` / `rename` / `stat`
- **分片传输**：上传/下载均支持 5MB 分片 + ACK
- **断点续传**：断线后自动从已写入偏移继续
- **Patch 支持**：Slave 端使用 `diff` 解析 unified diff 并落盘

---

## 安装

```/dev/null/install.txt#L1-L1
pnpm add @lyrify/znl-plugin-fs
```

---

## 使用方式（基于示例脚本）

### 1) Slave 端
```ZNL-File/examples/slave.js#L1-L27
import { ZNL } from "@lyrify/znl";
import "../index.js";

const slave = new ZNL({
  role: "slave",
  id: "core-001",
  endpoints: {
    router: "tcp://127.0.0.1:6003",
  },
  authKey: "your-shared-key",
  encrypted: false,
});

async function run() {
  await slave.start();

  await slave.fs.enable({
    root: "./examples/storage",
    logChunks: true,
  });

  console.log("slave ready: core-001");
}

run().catch((error) => {
  console.error("slave error:", error);
  process.exitCode = 1;
});
```

### 2) Master 端
```ZNL-File/examples/master.js#L1-L68
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
```

---

## API 列表

### Master 端
- `master.fs.list(slaveId, path)`：列出 `path` 目录下的文件与子目录信息
- `master.fs.get(slaveId, path)`：读取 `path` 文件内容（返回 Buffer 或文本）
- `master.fs.patch(slaveId, path, unifiedDiff)`：对 `path` 文件应用统一 diff 补丁
- `master.fs.upload(slaveId, localPath, remotePath)`：把本地 `localPath` 上传到 Slave 的 `remotePath`
- `master.fs.download(slaveId, remotePath, localPath)`：从 Slave 的 `remotePath` 下载到本地 `localPath`
- `master.fs.delete(slaveId, path)`：删除 Slave 上的文件或目录
- `master.fs.rename(slaveId, from, to)`：重命名或移动路径
- `master.fs.stat(slaveId, path)`：读取文件/目录元信息（size、mtime、类型等）

### Slave 端
- `slave.fs.enable({ root })`：启用文件服务并限定根目录为 `root`

---

## 测试

### 集成测试（真实 Master/Slave）
```/dev/null/test.txt#L1-L1
pnpm test
```

说明：
- `pnpm test` 会顺序跑 **plain** 与 **encrypted** 两套流程
- 测试目录为 `test/tmp/<scene>`，脚本结束后自动清理

---

## 注意事项

- `slave.fs.enable({ root })` 必须传入 `root`
- 传入路径必须在 `root` 范围内
- Patch 使用 unified diff，Slave 端自动解析并应用
- 大文件传输请使用 `upload` / `download`（已实现分片 + 断点续传）
- `upload` / `download` 支持可选参数 `{ chunkSize, logChunks }`
- `slave.fs.enable({ root, logChunks })` 可开启分片日志