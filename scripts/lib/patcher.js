// scripts/lib/patcher.js
// 兼容层：0.5.0 起补丁逻辑迁到 compat.js（面向 DSH 0.2.x）。
// 这里保留旧导出名，避免旧脚本/旧调用方失效。

import { mountProfiles } from "./compat.js";

export {
  applyAllPatches,
  applyPhase1Patch,
  detectDshVersion,
  findAiBase,
  findDshHome,
  mountProfilePatch,
  stripCwdPersona,
  unmountProfilePatch,
} from "./compat.js";

/**
 * 旧接口：为单个 profile 写入系统提示词覆盖与插件挂载。
 * @param {string} profileDir profile 目录
 * @param {string} pluginName 插件标识
 */
export function applyCordisPatch(profileDir, pluginName = "fujiang-armor", mode = "user") {
  try {
    const [report] = mountProfiles([profileDir], pluginName, mode);
    return { status: report.changed ? "patched" : "already_configured", path: report.file };
  } catch (error) {
    return { status: "error", error: error.message };
  }
}
