// scripts/lib/compat.js
// 富江破甲宿主兼容层（DSH 0.2.x / 0.2.2-rc.1 及以后）。
//
// 与旧版 patcher.js 的区别：
//   1. 不再改写宿主 node_modules（0.1.6/0.1.7 的 PERSONA_SECTION_NAMES 过滤在 0.2.x
//      已不存在，旧补丁在 0.2.x 上永远匹配不到；仅在检测到旧宿主时才保留该分支）。
//   2. 0.2.2-rc.1 起循环不再注册 {{cwd}} 变量，profile/home 里任何含 {{cwd}} 的
//      personaSuffix 都会让提示词组装抛错 —— 这里主动清掉该子句。
//   3. profile 补丁对已有行的 config 是整体替换：这里改成「定点插入」
//      includeHarnessIdentity: false，不再整段覆盖用户配置。
//   4. 挂载/卸载用成对标记包裹，可反复执行且不会误删用户其它行。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { stripPluginMounts } from "./migrate.js";

const isWindows = process.platform === "win32";

export const PLUGIN_NAME = "fujiang-armor";
const MARK_BEGIN = "# >>> fujiang-armor managed block (install.ps1) - do not edit inside";
const MARK_END = "# <<< fujiang-armor managed block";
const MARK_BEGIN_RE = /^[ \t]*# >>> fujiang-armor/m;
const MARK_END_RE = /^[ \t]*# <<< fujiang-armor/m;
const LEGACY_MARK = "# [fujiang-armor]";

// 两个对外注入模式（与 index.js 的 resolveInjection 保持一致）。
//   user   = user 会话注入（默认）
//   legacy = 老版本 system 双层段注入
const INJECTION_MODES = new Set(["user", "legacy"]);
export function normalizeInjectionMode(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return INJECTION_MODES.has(v) ? v : "user";
}

// ---------------------------------------------------------------- 基础工具

export function findDshHome() {
  const configured = process.env.DSH_HOME;
  if (configured && configured.trim() && fs.existsSync(configured)) return configured;
  return path.join(os.homedir(), ".dsh");
}

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

function writeTextAtomic(file, text) {
  const temporary = file + ".fujiang.tmp";
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, file);
}

function backupOnce(file) {
  const backup = file + ".before-fujiang.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  return backup;
}

function leadingSpaces(line) {
  return /^[ ]*/.exec(line)[0].length;
}

function splitLines(text) {
  return text.split(/\r?\n/);
}

// ---------------------------------------------------------------- 版本探测

/**
 * 探测 DSH 版本。桌面版把版本写在 $DSH_HOME/dsh-runtimes/<id>/runtime.json；
 * npm 版则可以从 profile 的 @deepseek-ai/dsh 包里读到。
 * @returns {{version: string|null, source: string|null}}
 */
export function detectDshVersion(dshHome = findDshHome()) {
  const runtimes = path.join(dshHome, "dsh-runtimes");
  if (fs.existsSync(runtimes)) {
    let best = null;
    for (const name of fs.readdirSync(runtimes)) {
      const manifest = path.join(runtimes, name, "runtime.json");
      if (!fs.existsSync(manifest)) continue;
      try {
        const value = JSON.parse(readText(manifest));
        const version = value.desktopVersion || value.version;
        if (typeof version !== "string") continue;
        const mtime = fs.statSync(manifest).mtimeMs;
        if (best === null || mtime > best.mtime) best = { version, source: manifest, mtime };
      } catch {}
    }
    if (best) return { version: best.version, source: best.source };
  }

  const profilesRoot = path.join(dshHome, "profiles");
  if (fs.existsSync(profilesRoot)) {
    for (const name of fs.readdirSync(profilesRoot)) {
      for (const pkg of ["dsh", "dsh-base"]) {
        const manifest = path.join(profilesRoot, name, "node_modules", "@deepseek-ai", pkg, "package.json");
        if (!fs.existsSync(manifest)) continue;
        try {
          const value = JSON.parse(readText(manifest));
          if (typeof value.version === "string") return { version: value.version, source: manifest };
        } catch {}
      }
    }
  }
  return { version: null, source: null };
}

/** 版本号比较：只比较数字段，忽略 -rc 之类后缀（rc 视为同主版本的最新）。 */
export function compareVersion(a, b) {
  const parse = (v) => String(v || "0").split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------- persona 修复

const CWD_REF = /\{\{\s*cwd\s*\}\}/i;
const CWD_CLAUSE = /your working directory is\s*\{\{\s*cwd\s*\}\}\s*\.?/gi;

/**
 * 删除 personaSuffix / suffix 中的 {{cwd}} 子句。
 * 0.2.2-rc.1 的 system-prompt 不再注册 cwd 变量，残留该引用会让组装直接抛错。
 * @returns {{text: string, removed: string[]}}
 */
export function stripCwdPersona(text) {
  const src = splitLines(text);
  const out = [];
  const removed = [];
  for (let i = 0; i < src.length; i += 1) {
    const line = src[i];
    const match = /^([ ]*)(personaSuffix|suffix)[ ]*:[ ]*(.*)$/.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const [, indent, key, rawValue] = match;

    // 块标量：personaSuffix: |
    if (/^[|>][+-]?\d*[ ]*(#.*)?$/.test(rawValue)) {
      const body = [];
      let j = i + 1;
      while (j < src.length) {
        const next = src[j];
        if (next.trim() === "") { body.push(next); j += 1; continue; }
        if (leadingSpaces(next) <= indent.length) break;
        body.push(next);
        j += 1;
      }
      const joined = body.join("\n");
      if (!CWD_REF.test(joined)) {
        out.push(line, ...body);
      } else {
        const kept = body.filter((entry) => !CWD_REF.test(entry) && !/your working directory is/i.test(entry));
        removed.push(`${key}: (block)`);
        if (kept.join("").trim() !== "") out.push(line, ...kept);
      }
      i = j - 1;
      continue;
    }

    if (!CWD_REF.test(rawValue)) {
      out.push(line);
      continue;
    }
    let value = rawValue.replace(CWD_CLAUSE, "").replace(CWD_REF, "").trim();
    value = value.replace(/^(["'])[ ]*\1$/, "").trim();
    removed.push(`${key}: ${rawValue.trim()}`);
    if (value === "") continue;
    out.push(`${indent}${key}: ${value}`);
  }
  return { text: out.join("\n"), removed };
}

// ---------------------------------------------------------------- 补丁手术

/** 找到 `- id: system-prompt` 行，返回其块的行区间。 */
function findRow(lines, id) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (leadingSpaces(line) !== 0) continue;
    if (!/^-[ ]+id[ ]*:[ ]*(?:['"])?/.test(line)) continue;
    const value = line.replace(/^-[ ]+id[ ]*:[ ]*/, "").replace(/#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
    if (value !== id) continue;
    let end = i + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (next.trim() !== "" && leadingSpaces(next) === 0) break;
      end += 1;
    }
    while (end > i + 1 && lines[end - 1].trim() === "") end -= 1;
    return { start: i, end };
  }
  return null;
}

/** 确保 system-prompt 行开启 includeHarnessIdentity: false（定点插入，不覆盖其它字段）。 */
export function ensureHarnessIdentityOff(text) {
  const lines = splitLines(text);
  const row = findRow(lines, "system-prompt");
  if (row === null) {
    const block = [
      "- id: system-prompt",
      "  config:",
      "    includeHarnessIdentity: false",
    ];
    const body = text.trim();
    return { text: body ? `${body}\n${block.join("\n")}` : block.join("\n"), action: "appended" };
  }

  for (let i = row.start; i < row.end; i += 1) {
    if (/^[ ]*includeHarnessIdentity[ ]*:/.test(lines[i])) {
      if (/false/.test(lines[i])) return { text, action: "already" };
      lines[i] = lines[i].replace(/(includeHarnessIdentity[ ]*:[ ]*)(\S+)/, "$1false");
      return { text: lines.join("\n"), action: "flipped" };
    }
  }

  for (let i = row.start; i < row.end; i += 1) {
    if (/^[ ]*config[ ]*:[ ]*$/.test(lines[i])) {
      lines.splice(i + 1, 0, `${" ".repeat(leadingSpaces(lines[i]) + 2)}includeHarnessIdentity: false`);
      return { text: lines.join("\n"), action: "inserted" };
    }
  }

  lines.splice(row.end, 0, "  config:", "    includeHarnessIdentity: false");
  return { text: lines.join("\n"), action: "config-added" };
}

/**
 * 删除补丁里所有根级 `- insert:` 块，只保留针对已装插件的 config 覆盖行。
 * 用于「复制一份干净配置到隔离实例」：保留用户的模型/界面配置，丢掉第三方插件挂载。
 */
export function stripAllInsertRows(text) {
  const lines = splitLines(text);
  const keep = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (leadingSpaces(lines[i]) === 0 && /^-[ ]+insert[ ]*:/.test(lines[i])) {
      i += 1;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() !== "" && leadingSpaces(line) === 0) break;
        i += 1;
      }
      i -= 1;
      continue;
    }
    keep.push(lines[i]);
  }
  return normalizeBlankLines(keep.join("\n"));
}

/** 卸载时把 includeHarnessIdentity 恢复为默认（true）。 */export function ensureHarnessIdentityRestored(text) {
  const lines = splitLines(text);
  const row = findRow(lines, "system-prompt");
  if (row === null) return { text, action: "absent" };
  for (let i = row.start; i < row.end; i += 1) {
    if (/^[ ]*includeHarnessIdentity[ ]*:[ ]*false\b/.test(lines[i])) {
      lines.splice(i, 1);
      return { text: lines.join("\n"), action: "removed" };
    }
  }
  return { text, action: "already" };
}

function managedBlock(pluginName, mode = "user") {
  return [
    MARK_BEGIN,
    "- insert:",
    `    - id: ${pluginName}`,
    `      name: '${pluginName}'`,
    "      config:",
    "        enabled: true",
    "        autoApplyOnStart: true",
    `        injectionMode: ${normalizeInjectionMode(mode)}`,
    MARK_END,
  ];
}

/** 删除本插件写入的托管块、旧版注释行，以及所有 id 命中的 insert 行。 */
function dropOwnedRows(text, pluginName) {
  let next = text;

  // 1) 成对标记包裹的托管块（标记文本可能随版本变化，这里只认前缀）。
  for (;;) {
    const begin = next.search(MARK_BEGIN_RE);
    if (begin === -1) break;
    const afterBegin = next.slice(begin);
    const endOffset = afterBegin.search(MARK_END_RE);
    if (endOffset === -1) {
      // 只有开头标记：删到文件末尾再继续（由后续规则清理残留）。
      next = next.slice(0, begin);
      break;
    }
    const endIndex = begin + endOffset;
    const endLineBreak = next.indexOf("\n", endIndex);
    next = next.slice(0, begin) + (endLineBreak === -1 ? "" : next.slice(endLineBreak + 1));
  }

  // 2) 残留的孤立标记行与旧版注释行。
  next = next
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("# >>> fujiang-armor")) return false;
      if (trimmed.startsWith("# <<< fujiang-armor")) return false;
      if (trimmed.startsWith(LEGACY_MARK)) return false;
      return true;
    })
    .join("\n");

  // 3) 旧版遗留的 insert 行（含未加标记的历史安装）。
  return stripPluginMounts(next, [pluginName]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBlankLines(text) {
  return text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim();
}

/** 生成挂载后的 profile 补丁文本。 */
export function mountProfilePatch(text, pluginName = PLUGIN_NAME, mode = "user") {
  const base = normalizeBlankLines(dropOwnedRows(text, pluginName));
  const identity = ensureHarnessIdentityOff(base);
  const withIdentity = identity.text;
  const block = managedBlock(pluginName, mode).join("\n");
  const joined = normalizeBlankLines(withIdentity) === "" ? block : `${normalizeBlankLines(withIdentity)}\n\n${block}`;
  return { text: `${joined}\n`, actions: [identity.action, "mount"] };
}

/** 生成卸载后的 profile 补丁文本。 */
export function unmountProfilePatch(text, pluginName = PLUGIN_NAME) {
  const base = normalizeBlankLines(dropOwnedRows(text, pluginName));
  const identity = ensureHarnessIdentityRestored(base);
  const body = normalizeBlankLines(identity.text);
  // 只剩模板自带的空数组时，写回 "[]"，保持与出厂 profile 一致。
  if (body === "" || body === "[]") return { text: "[]\n", actions: [identity.action, "unmount"] };
  return { text: `${body}\n`, actions: [identity.action, "unmount"] };
}

// ---------------------------------------------------------------- package.json

function readJson(file) {
  const text = readText(file);
  return { text, value: JSON.parse(text) };
}

function writeJsonLike(file, value, originalText) {
  const indentMatch = /^[ \t]+"/m.exec(originalText);
  const indent = indentMatch ? indentMatch[0].replace(/"/g, "") : "  ";
  const eol = originalText.includes("\r\n") ? "\r\n" : "\n";
  const text = JSON.stringify(value, null, indent).replace(/\n/g, eol) + eol;
  writeTextAtomic(file, text);
}

export function setDependency(profileDir, name, spec) {
  const file = path.join(profileDir, "package.json");
  const { text, value } = readJson(file);
  if (!value.dependencies || typeof value.dependencies !== "object") value.dependencies = {};
  if (value.dependencies[name] === spec) return { changed: false, file };
  value.dependencies[name] = spec;
  backupOnce(file);
  writeJsonLike(file, value, text);
  return { changed: true, file, spec };
}

export function removeDependency(profileDir, name) {
  const file = path.join(profileDir, "package.json");
  if (!fs.existsSync(file)) return { changed: false, file };
  const { text, value } = readJson(file);
  let changed = false;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const bag = value[field];
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
    if (Object.hasOwn(bag, name)) {
      delete bag[name];
      changed = true;
    }
  }
  if (!changed) return { changed: false, file };
  backupOnce(file);
  writeJsonLike(file, value, text);
  return { changed: true, file };
}

/** 第三方插件不能同时作为基础 bundle 加载（会重复挂载并撞名）。 */
export function removeFromBundles(profileDir, name) {
  const file = path.join(profileDir, "package.json");
  if (!fs.existsSync(file)) return { changed: false, file };
  const { text, value } = readJson(file);
  const bundles = value?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes(name)) return { changed: false, file };
  value.dsh.profile.bundles = bundles.filter((entry) => entry !== name);
  backupOnce(file);
  writeJsonLike(file, value, text);
  return { changed: true, file };
}

// ---------------------------------------------------------------- 旧宿主补丁

export function findAiBase(dshHome = findDshHome()) {
  const candidates = [];
  if (process.env.DSH_BASE && fs.existsSync(process.env.DSH_BASE)) candidates.push(process.env.DSH_BASE);

  const profilesRoot = path.join(dshHome, "profiles");
  if (fs.existsSync(profilesRoot)) {
    try {
      for (const name of fs.readdirSync(profilesRoot)) {
        candidates.push(path.join(profilesRoot, name, "node_modules", "@deepseek-ai"));
      }
    } catch {}
  }
  if (isWindows) {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const localappdata = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    candidates.push(path.join(appdata, "npm", "node_modules", "@deepseek-ai"));
    candidates.push(path.join(appdata, "npm", "node_modules", "dsh", "node_modules", "@deepseek-ai"));
    candidates.push(path.join(localappdata, "Programs", "DeepSeek-Harness", "resources", "app", "dsh", "node_modules", "@deepseek-ai"));
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, "dsh-agent-instructions", "lib"))) return candidate;
  }
  return null;
}

/**
 * 旧宿主（0.1.6 / 0.1.7）的 Phase-1 提示词过滤放行补丁。
 * 0.2.x 起宿主已删除 PERSONA_SECTION_NAMES 过滤，本函数在这些版本上只会返回 skipped。
 */
export function applyPhase1Patch(dshHome = findDshHome()) {
  const marker = "[fujiang-armor] phase-1 keep persona+fujiang-armor sections";
  const files = [];
  const aiBase = findAiBase(dshHome);
  if (aiBase) {
    for (const file of [
      path.join(aiBase, "dsh-agent-instructions", "lib", "index.js"),
      path.join(aiBase, "dsh-agent-instructions", "lib", "bootstrap.js"),
    ]) {
      if (fs.existsSync(file)) files.push(file);
    }
  }
  if (files.length === 0) return { status: "skipped", reason: "host files not found (0.2.x bundles the harness inside app.asar)", results: [] };

  const results = [];
  for (const file of files) {
    try {
      const text = readText(file);
      if (text.includes(marker)) {
        results.push({ file, status: "already_patched" });
        continue;
      }
      const needle = /section\s*=>\s*PERSONA_SECTION_NAMES\.has\(section\?\.name\)/g;
      if (!needle.test(text)) {
        results.push({ file, status: "not_applicable" });
        continue;
      }
      backupOnce(file);
      const next = text.replace(
        needle,
        `/* ${marker} */ section => PERSONA_SECTION_NAMES.has(section?.name) || String(section?.name || "").startsWith("fujiang-armor")`,
      );
      writeTextAtomic(file, next);
      results.push({ file, status: "patched" });
    } catch (error) {
      results.push({ file, status: "error", error: error.message });
    }
  }
  return { status: "ok", results };
}

// ---------------------------------------------------------------- 批量入口

export function listProfiles(dshHome = findDshHome()) {
  const root = path.join(dshHome, "profiles");
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (name === "node_modules") continue;
    const dir = path.join(root, name);
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const value = JSON.parse(readText(manifest));
      if (!value?.dsh?.profile || typeof value.dsh.profile !== "object") continue;
      out.push(dir);
    } catch {}
  }
  return out;
}

function patchFileOf(profileDir) {
  return path.join(profileDir, "cordis.patch.yml");
}

/**
 * 挂载插件：修 persona、去掉重复挂载、开启 includeHarnessIdentity: false、追加托管块。
 * @param {string[]} profileDirs
 * @param {string} pluginName
 * @param {string} mode user(user 会话注入) / legacy(老版本 system 双层段注入)
 * @returns 每个 profile 的变更明细
 */
export function mountProfiles(profileDirs, pluginName = PLUGIN_NAME, mode = "user") {
  const injectionMode = normalizeInjectionMode(mode);
  const reports = [];
  for (const profileDir of profileDirs) {
    const file = patchFileOf(profileDir);
    const before = fs.existsSync(file) ? readText(file) : "[]\n";
    const cwd = stripCwdPersona(before);
    const mounted = mountProfilePatch(cwd.text, pluginName, injectionMode);
    const after = mounted.text;
    const changed = after !== before;
    if (changed) {
      backupOnce(file);
      writeTextAtomic(file, after);
    }
    reports.push({
      profileDir,
      file,
      changed,
      injectionMode,
      cwdRemoved: cwd.removed,
      actions: mounted.actions,
    });
  }
  return reports;
}

/** 卸载插件：移除托管块与 insert 行，恢复 includeHarnessIdentity。 */
export function unmountProfiles(profileDirs, pluginName = PLUGIN_NAME) {
  const reports = [];
  for (const profileDir of profileDirs) {
    const file = patchFileOf(profileDir);
    if (!fs.existsSync(file)) continue;
    const before = readText(file);
    const unmounted = unmountProfilePatch(before, pluginName);
    const changed = unmounted.text !== before;
    if (changed) {
      backupOnce(file);
      writeTextAtomic(file, unmounted.text);
    }
    reports.push({ profileDir, file, changed, actions: unmounted.actions });
  }
  return reports;
}

/**
 * 全量兼容处理：版本探测 + persona 修复 + 旧宿主补丁。
 * @param {{dshHome?: string, profiles?: string[], pluginName?: string}} options
 */
export function applyAllPatches(options = {}) {
  const dshHome = options.dshHome || findDshHome();
  const pluginName = options.pluginName || PLUGIN_NAME;
  const mode = normalizeInjectionMode(options.mode);
  const version = detectDshVersion(dshHome);
  const profileDirs = options.profiles && options.profiles.length ? options.profiles : listProfiles(dshHome);

  const warnings = [];
  if (version.version && compareVersion(version.version, "0.2.0") < 0) {
    warnings.push(
      `检测到 DSH ${version.version}（0.2.0 之前）。本版插件面向 0.2.x 提示词段接口，旧宿主请使用 0.4.x 插件。`,
    );
  }
  if (version.version && compareVersion(version.version, "0.2.2") >= 0) {
    warnings.push(
      `DSH ${version.version}：personaSuffix 中的 {{cwd}} 已失效，安装器会自动清除该子句。`,
    );
  }

  // home 级补丁（$DSH_HOME/cordis.patch.yml）同样要清 {{cwd}}
  const homePatch = path.join(dshHome, "cordis.patch.yml");
  let homeFix = null;
  if (fs.existsSync(homePatch)) {
    const before = readText(homePatch);
    const cwd = stripCwdPersona(before);
    if (cwd.removed.length) {
      backupOnce(homePatch);
      writeTextAtomic(homePatch, cwd.text);
      homeFix = { file: homePatch, removed: cwd.removed };
    }
  }

  return {
    dshHome,
    version: version.version,
    versionSource: version.source,
    injectionMode: mode,
    profiles: mountProfiles(profileDirs, pluginName, mode),
    homePatch: homeFix,
    phase1: applyPhase1Patch(dshHome),
    warnings,
  };
}

// ---------------------------------------------------------------- CLI

/**
 * 把非 ASCII 字符转成 \uXXXX。
 * 调用方（PowerShell 等）捕获子进程 stdout 时按控制台代码页解码，中文 Windows 是 GBK，
 * 直接输出 UTF-8 中文会被解成乱码、甚至吃掉引号导致 JSON 解析失败，所以 stdout 只给纯 ASCII。
 */
export function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * 为隔离实例播种 profile 补丁：保留用户 config 覆盖行，丢掉所有第三方 insert 与失效的 {{cwd}}。
 * 直接写文件，不经过 stdout，避免编码问题。
 * @returns {{file: string, cwdRemoved: string[], chars: number}}
 */
export function seedProfilePatchFile(srcFile, dstFile) {
  const text = fs.existsSync(srcFile) ? readText(srcFile) : "[]\n";
  const cwd = stripCwdPersona(text);
  const seeded = stripAllInsertRows(cwd.text);
  const body = seeded.trim();
  const out = body === "" || body === "[]" ? "[]\n" : `${body}\n`;
  writeTextAtomic(dstFile, out);
  return { file: dstFile, cwdRemoved: cwd.removed, chars: out.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , command, dshHome, ...rawRest] = process.argv;
    if (!command) {
      throw new Error(
        "Usage: node scripts/lib/compat.js <mount|unmount|link|unlink|check|seed> <dshHome> [spec|profileDir ...] [--mode user|legacy] [--out <file>]",
      );
    }

    // --out <file>：把结果写成 UTF-8 文件，供调用方用 UTF-8 读取（推荐路径）。
    // --mode <user|legacy>：mount 子命令选择两个注入模式之一。
    let outFile = null;
    let mode = "user";
    const rest = [];
    for (let i = 0; i < rawRest.length; i += 1) {
      if (rawRest[i] === "--out") {
        outFile = rawRest[i + 1];
        i += 1;
        continue;
      }
      if (rawRest[i] === "--mode") {
        mode = rawRest[i + 1] ?? "user";
        i += 1;
        continue;
      }
      rest.push(rawRest[i]);
    }

    const home = dshHome || findDshHome();
    let result;

    if (command === "check") {
      const version = detectDshVersion(home);
      result = { dshHome: home, version: version.version, versionSource: version.source, profiles: listProfiles(home) };
    } else if (command === "mount") {
      const dirs = rest.length ? rest.map((entry) => path.resolve(entry)) : listProfiles(home);
      result = applyAllPatches({ dshHome: home, profiles: dirs, mode });
    } else if (command === "unmount") {
      const dirs = rest.length ? rest.map((entry) => path.resolve(entry)) : listProfiles(home);
      result = { dshHome: home, profiles: unmountProfiles(dirs) };
    } else if (command === "link" || command === "unlink") {
      const [spec, ...profileArgs] = rest;
      const dirs = profileArgs.length ? profileArgs.map((entry) => path.resolve(entry)) : listProfiles(home);
      const reports = [];
      for (const profileDir of dirs) {
        if (command === "link") {
          const dependency = setDependency(profileDir, PLUGIN_NAME, spec || `file:../../plugins/${PLUGIN_NAME}`);
          const bundles = removeFromBundles(profileDir, PLUGIN_NAME);
          reports.push({ profileDir, dependency, bundles });
        } else {
          const dependency = removeDependency(profileDir, PLUGIN_NAME);
          const bundles = removeFromBundles(profileDir, PLUGIN_NAME);
          reports.push({ profileDir, dependency, bundles });
        }
      }
      result = { dshHome: home, profiles: reports };
    } else if (command === "seed") {
      // seed <源补丁> <目标补丁>
      const [srcFile, dstFile] = rest;
      if (!srcFile || !dstFile) throw new Error("Usage: node scripts/lib/compat.js seed <sourcePatch> <targetPatch>");
      result = seedProfilePatchFile(path.resolve(srcFile), path.resolve(dstFile));
    } else {
      throw new Error(`unknown command: ${command}`);
    }

    if (outFile) {
      const target = path.resolve(outFile);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(asciiJson({ out: target }));
    } else {
      console.log(asciiJson(result));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
