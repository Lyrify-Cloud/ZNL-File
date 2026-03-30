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

## 协议构成（ZNL RPC）

本插件在 ZNL 的 RPC 之上定义业务协议，所有请求与响应都使用 **多帧 payload**：
- **第 1 帧**：JSON 元信息（包含 `op` 等字段）
- **第 2+ 帧**：可选的二进制数据（例如文件分片 Buffer）

### 通用字段（Meta）
- `op`：操作类型（如 `file/list`、`file/get`、`file/patch` 等）
- `path`：目标路径（相对 `root` 的路径）
- `sessionId`：分片传输的会话 ID（上传/下载用）
- `chunkId` / `totalChunks` / `offset` / `size`：分片序号与偏移信息

### CRUD 协议
- `file/list`：列目录
- `file/get`：读取文件
- `file/patch`：应用 unified diff
- `file/delete`：删除文件/目录
- `file/rename`：重命名/移动
- `file/stat`：获取文件/目录元信息

### 上传协议（Master → Slave）
- `file/init`：启动上传会话（文件名、大小、分片大小）
- `file/resume`：Slave 回传断点偏移
- `file/chunk`：上传分片（附带 `chunkId` / `offset`）
- `file/ack`：Slave 确认分片
- `file/complete`：上传完成

### 下载协议（Slave → Master）
- `file/download_init`：启动下载会话
- `file/download_chunk`：请求/返回分片
- `file/download_complete`：下载完成

### 帧级示例（示意）

说明：以下仅展示 **payload 的帧结构**（ZNL 的 request/response 外层已省略）。

#### list
请求：
```/dev/null/protocol-list-request.txt#L1-L4
[
  {"op":"file/list","path":"."}
]
```
响应：
```/dev/null/protocol-list-response.txt#L1-L5
[
  {"op":"file/list","ok":true,"entries":[{"name":"a.txt","type":"file","size":12,"mtime":1700000000000}]}
]
```

#### get
请求：
```/dev/null/protocol-get-request.txt#L1-L4
[
  {"op":"file/get","path":"kuke.json"}
]
```
响应（单帧文本/Buffer）：
```/dev/null/protocol-get-response.txt#L1-L5
[
  {"op":"file/get","ok":true,"path":"kuke.json","size":27},
  "<Buffer ...>"
]
```

#### patch
请求：
```/dev/null/protocol-patch-request.txt#L1-L7
[
  {"op":"file/patch","path":"kuke.json","patch":"@@ -1,3 +1,3 @@\n-  \"name\": \"restaurant\"\n+  \"name\": \"aura\"\n"}
]
```
响应：
```/dev/null/protocol-patch-response.txt#L1-L4
[
  {"op":"file/patch","ok":true,"path":"kuke.json","applied":true}
]
```

#### upload（分片）
初始化请求：
```/dev/null/protocol-upload-init.txt#L1-L6
[
  {"op":"file/init","sessionId":"s1","path":"upload.txt","fileSize":10485760,"chunkSize":5242880}
]
```
断点响应：
```/dev/null/protocol-upload-resume.txt#L1-L5
[
  {"op":"file/resume","sessionId":"s1","path":"upload.txt","offset":0,"chunkSize":5242880}
]
```
分片请求（含数据帧）：
```/dev/null/protocol-upload-chunk.txt#L1-L7
[
  {"op":"file/chunk","sessionId":"s1","path":"upload.txt","chunkId":0,"offset":0,"size":5242880},
  "<Buffer ...>"
]
```
ACK 响应：
```/dev/null/protocol-upload-ack.txt#L1-L6
[
  {"op":"file/ack","sessionId":"s1","path":"upload.txt","chunkId":0,"offset":5242880,"size":5242880}
]
```
完成请求：
```/dev/null/protocol-upload-complete.txt#L1-L6
[
  {"op":"file/complete","sessionId":"s1","path":"upload.txt","fileSize":10485760,"totalChunks":2}
]
```

#### download（分片）
初始化请求：
```/dev/null/protocol-download-init.txt#L1-L6
[
  {"op":"file/download_init","sessionId":"d1","path":"upload.txt","chunkSize":5242880,"offset":0}
]
```
分片请求：
```/dev/null/protocol-download-chunk-req.txt#L1-L6
[
  {"op":"file/download_chunk","sessionId":"d1","path":"upload.txt","chunkId":0,"offset":0,"chunkSize":5242880}
]
```
分片响应（含数据帧）：
```/dev/null/protocol-download-chunk-res.txt#L1-L7
[
  {"op":"file/download_chunk","sessionId":"d1","path":"upload.txt","chunkId":0,"offset":0,"size":5242880},
  "<Buffer ...>"
]
```
完成请求：
```/dev/null/protocol-download-complete.txt#L1-L6
[
  {"op":"file/download_complete","sessionId":"d1","path":"upload.txt","fileSize":10485760,"totalChunks":2}
]
```

> 以上协议均通过 ZNL 的 RPC 调用完成，确保每一步都有响应与超时控制。

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