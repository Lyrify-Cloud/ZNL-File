import { ZNL } from "@lyrify/znl";
import { createMasterFsApi } from "./src/master/api.js";
import { createSlaveFsApi } from "./src/slave/api.js";

const NAMESPACE_MAP = new WeakMap();
const INJECTED_FLAG = Symbol.for("znl.plugin.fs.injected");

function buildNamespace(instance) {
  if (!instance || typeof instance !== "object") {
    throw new TypeError("ZNL 实例无效，无法注入 fs 命名空间。");
  }

  if (instance.role === "master") {
    return createMasterFsApi(instance);
  }

  if (instance.role === "slave") {
    return createSlaveFsApi(instance);
  }

  throw new Error('无法识别实例角色：`role` 必须为 "master" 或 "slave"。');
}

function ensureNamespace(instance) {
  if (NAMESPACE_MAP.has(instance)) {
    return NAMESPACE_MAP.get(instance);
  }
  const api = buildNamespace(instance);
  NAMESPACE_MAP.set(instance, api);
  return api;
}

export function injectFsNamespace() {
  if (!ZNL?.prototype) {
    throw new Error("未找到 ZNL.prototype，无法注入插件命名空间。");
  }

  if (ZNL.prototype[INJECTED_FLAG]) return;

  const existing = Object.getOwnPropertyDescriptor(ZNL.prototype, "fs");
  if (!existing) {
    Object.defineProperty(ZNL.prototype, "fs", {
      configurable: true,
      enumerable: false,
      get() {
        return ensureNamespace(this);
      },
    });
  }

  Object.defineProperty(ZNL.prototype, INJECTED_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });
}

injectFsNamespace();
