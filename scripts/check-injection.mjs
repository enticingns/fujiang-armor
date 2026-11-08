// scripts/check-injection.mjs
// 验证富江破甲是否真的注入到了某个 DSH 实例的会话里。
//
// 原理：DSH 把每个模型步骤渲染后的系统提示词作为 system/message 事件写进会话日志
// （$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd，逐帧 zstd 追加）。
// 直接读日志比对内核文本，比“问模型它有没有被破甲”可靠得多。
//
// 用法：
//   node scripts/check-injection.mjs                       # 检查 $DSH_HOME 或 ~/.dsh 的最新会话
//   node scripts/check-injection.mjs --home "D:\dsh-rc\.dsh-home"
//   node scripts/check-injection.mjs --list                # 列出所有会话及是否命中
//   node scripts/check-injection.mjs --json                # 机器可读输出
//   node scripts/check-injection.mjs --session <id|latest>

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const LOG_NAME = "session.v4.jsonl.zstd";

// 判定标记：取内置提示词的首句与黑名单标题。
const KERNEL_MARKERS = ["You are 富江", "## Blacklist"];
const TOOL_NAME = "fujiang_profile";

function parseArgs(argv) {
  const out = { home: null, session: "latest", list: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--home") out.home = argv[++i];
    else if (arg === "--session") out.session = argv[++i];
    else if (arg === "--list") out.list = true;
    else if (arg === "--json") out.json = true;
  }
  return out;
}

function resolveHome(explicit) {
  if (explicit) return path.resolve(explicit);
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), ".dsh");
}

/** 逐帧解压：会话日志是多次 append 的独立 zstd 帧。 */
function readSessionLog(file) {
  const buf = readFileSync(file);
  const offsets = [];
  let cursor = buf.indexOf(MAGIC, 0);
  while (cursor !== -1) {
    offsets.push(cursor);
    cursor = buf.indexOf(MAGIC, cursor + 4);
  }
  if (offsets.length === 0) return [];
  let text = "";
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString("utf8");
    } catch {
      // 帧被截断（进程正在写）时跳过，不影响已完成的帧
    }
  }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

function listSessionLogs(home) {
  const root = path.join(home, "sessions");
  if (!existsSync(root)) return [];
  const found = [];
  for (const workspace of readdirSync(root)) {
    const workspaceDir = path.join(root, workspace);
    let entries;
    try {
      if (!statSync(workspaceDir).isDirectory()) continue;
      entries = readdirSync(workspaceDir);
    } catch {
      continue;
    }
    for (const sessionId of entries) {
      const file = path.join(workspaceDir, sessionId, LOG_NAME);
      if (!existsSync(file)) continue;
      const stat = statSync(file);
      found.push({ sessionId, workspace, file, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function inspect(entry) {
  const events = readSessionLog(entry.file);
  const header = events.find((e) => e.type === "session");
  const systemEvents = events.filter((e) => e.type === "system/message");
  const systemText = systemEvents.map((e) => textOfMessage(e?.data?.message)).join("\n\n");
  // 0.6.0 起内核也可以走 user 通道（前置到最后一条 user 消息），
  // 因此判定要同时看 system 与 user 两侧，不能只看系统提示词。
  const userEvents = events.filter((e) => e.type === "user/message");
  const userText = userEvents.map((e) => textOfMessage(e?.data?.message)).join("\n\n");
  const combinedText = `${systemText}\n\n${userText}`;
  const requestHeader = events.find((e) => e.type === "request/header");
  const tools = Array.isArray(requestHeader?.data?.header?.tools)
    ? requestHeader.data.header.tools.map((tool) => tool?.name).filter(Boolean)
    : [];
  const config = requestHeader?.data?.header?.config ?? {};

  const kernelHits = KERNEL_MARKERS.map((marker) => ({
    marker,
    count: combinedText.split(marker).length - 1,
  }));
  const inSystem = KERNEL_MARKERS.every((marker) => systemText.includes(marker));
  const inUser = KERNEL_MARKERS.every((marker) => userText.includes(marker));
  const channel = inSystem && inUser ? "both" : inSystem ? "system" : inUser ? "user" : "none";

  return {
    sessionId: entry.sessionId,
    workspace: entry.workspace,
    file: entry.file,
    size: entry.size,
    updatedAt: new Date(entry.mtime).toISOString(),
    cwd: header?.cwd ?? null,
    agentPreset: header?.agentPreset ?? null,
    provider: config.provider ?? null,
    model: config.model ?? null,
    events: events.length,
    systemMessages: systemEvents.length,
    systemChars: systemText.length,
    kernelHits,
    kernelInjected: kernelHits.every((hit) => hit.count > 0),
    dualLayer: (kernelHits[0]?.count ?? 0) >= 2,
    channel,
    toolRegistered: tools.includes(TOOL_NAME),
    toolCount: tools.length,
    assistantMessages: events.filter((e) => e.type === "assistant/message").length,
    userMessages: userEvents.length,
    promptHead: (inSystem ? systemText : userText).slice(0, 80),
  };
}

function verdictOf(report) {
  const lines = [];
  lines.push(report.systemMessages > 0
    ? `  [OK] 会话日志里有 system/message（${report.systemChars} 字符）`
    : "  [X]  会话日志里没有 system/message —— 这条会话还没发出过模型请求");
  if (report.systemMessages > 0) {
    lines.push(report.kernelInjected
      ? `  [OK] 内核已注入（通道：${report.channel}）：${report.kernelHits.map((h) => `${h.marker}×${h.count}`).join("，")}`
      : "  [X]  内核未注入：system 与 user 两侧都找不到富江内核文本");
    lines.push(report.dualLayer
      ? "  [OK] 双段注入生效（Order 100 内核 + Order 200 镜像各一份）"
      : "  [i]  单段注入（DUAL_LAYER_INJECTION=false 或只命中一段）");
    lines.push(report.toolRegistered
      ? `  [OK] 工具 ${TOOL_NAME} 已注册（模型可用）`
      : `  [!]  工具列表里没有 ${TOOL_NAME}（插件可能只注入了提示词段）`);
  }
  if (report.model) lines.push(`  [i]  模型：${report.provider ?? "?"} / ${report.model}`);
  lines.push(`  [i]  会话：${report.sessionId}（${report.userMessages} 条用户消息 / ${report.assistantMessages} 条助手消息）`);
  return lines;
}

function printHuman(report) {
  console.log("");
  console.log("会话：" + report.sessionId);
  console.log("工作目录：" + (report.cwd ?? "?") + "   preset：" + (report.agentPreset ?? "?"));
  console.log("日志：" + report.file);
  console.log("系统提示词开头：" + JSON.stringify(report.promptHead));
  console.log("");
  for (const line of verdictOf(report)) console.log(line);
  console.log("");
  const ok = report.systemMessages > 0 && report.kernelInjected;
  console.log(ok ? "结论：富江破甲已生效 ✅" : "结论：尚未生效（或该会话还没请求过模型）❌");
  console.log("");
  return ok;
}

const args = parseArgs(process.argv.slice(2));
const home = resolveHome(args.home);
const logs = listSessionLogs(home);

if (logs.length === 0) {
  console.error(`未找到会话日志：${path.join(home, "sessions")}`);
  console.error("先在该实例里发一条消息，再运行本脚本。");
  process.exit(2);
}

if (args.list) {
  const rows = logs.slice(0, 20).map((entry) => {
    const report = inspect(entry);
    return {
      session: report.sessionId.slice(0, 20),
      updated: report.updatedAt.replace("T", " ").slice(0, 19),
      model: report.model ?? "-",
      system: report.systemMessages,
      kernel: report.kernelInjected ? "是" : "否",
      dual: report.dualLayer ? "是" : "否",
      tool: report.toolRegistered ? "是" : "否",
    };
  });
  if (args.json) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(`\n数据目录：${home}\n`);
    console.log("会话                  更新时间            模型                 system 内核 双段 工具");
    for (const row of rows) {
      console.log(
        `${row.session.padEnd(21)} ${row.updated.padEnd(19)} ${String(row.model).padEnd(20)} ${String(row.system).padEnd(6)} ${row.kernel.padEnd(4)} ${row.dual.padEnd(4)} ${row.tool}`,
      );
    }
    console.log("");
  }
  process.exit(0);
}

let target;
if (args.session === "latest") target = logs[0];
else target = logs.find((entry) => entry.sessionId.includes(args.session)) ?? null;
if (!target) {
  console.error(`找不到会话：${args.session}`);
  process.exit(2);
}

const report = inspect(target);
if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.systemMessages > 0 && report.kernelInjected ? 0 : 1);
}
process.exit(printHuman(report) ? 0 : 1);
