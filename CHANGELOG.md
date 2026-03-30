# Changelog

## v0.1.3
- 集成测试新增 encrypted 场景，与 plain 顺序执行
- 测试清理调整为脚本结束后统一删除 `test/tmp`
- README 增加 logChunks 说明与测试说明更新
- package.json 补充仓库与主页信息

## v0.1.2
- 默认分片大小调整为 5MB
- 集成测试新增 20MB 大文件上传/下载与 hash 校验
- 测试文件名增加随机后缀，输出日志压缩为单行 JSON
- 支持可选分片日志（logChunks）并在测试中启用
- README 更新默认分片说明

## v0.1.1
- 更新 README：补充项目简介、API 说明与使用方式（基于示例脚本路径）
- 集成测试覆盖扩展：新增 stat / rename / delete 校验
- 集成测试目录调整为项目内 `test/tmp`，运行前自动重置

## v0.1.0
- 初始化 `@lyrify/znl-plugin-fs` 包结构与命名空间注入
- 增加 Master/Slave 端文件管理 API（list/get/patch/delete/rename/stat）
- 支持分片上传与断点续传（1MB 分片 + ACK）
- 支持下载（分片读取 + 断点续传）
- Slave 端使用 jsdiff 解析统一 diff 并应用 patch
- 添加真实 Master/Slave 示例与集成测试（含中文步骤日志）