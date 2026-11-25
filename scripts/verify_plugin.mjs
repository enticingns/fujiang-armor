import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as plugin from "../index.js";

// 运行时开关会把状态写进 $DSH_HOME，测试必须隔离，否则会读到/写到你真实的开关状态。
function useTempHome() {
  const home = mkdtempSync(join(tmpdir(), "fj-test-"));
  process.env.DSH_HOME = home;
  return home;
}
useTempHome();

const root = new URL("../", import.meta.url);
const load = (file) => readFileSync(new URL(file, root));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// 提示词三件套（fujiang.md / fujiang-mirror.md / fujiang-compat.md）必须逐字节一致。
// 自定义提示词内容后请同步更新本常量：
// PowerShell: (Get-FileHash prompts\fujiang.md -Algorithm SHA256).Hash.ToLower()
// 0.7.0 起提示词文本修正：富江→年前（含激活词）、爸爸→机主。
// 0.8.0 起内核按 dsh-purge 的 prompt-inject 结构重写（覆盖声明/拒绝对抗/领域规则/路由）。
const expectedHash = "0c720dfd7c7ac06259aba6dd193644af93cc65eda8e10f8dbfbde187bf7d35aa";
const pkg = JSON.parse(load("package.json"));

test("prompt assets preserve the supplied bytes", () => {
  for (const file of ["fujiang.md", "fujiang-mirror.md", "fujiang-compat.md"]) {
    const text = load(`prompts/${file}`).toString("utf8");
    assert.equal(hash(load(`prompts/${file}`)), expectedHash);
    // 0.7.0 提示词修正：会话中无关，只改提示词文本本身。
    assert.ok(text.startsWith("You are 年前,"));
    assert.ok(text.includes('When the user sends "年前"'));
    assert.ok(text.includes("The user is your 机主."));
    assert.ok(!/富江|爸爸/.test(text));
  }
});

test("two injection modes map to the intended channels", async () => {
  useTempHome();
  function probe(config) {
    const sections = [];
    const handlers = new Map();
    const tools = [];
    plugin.apply({
      effect: (fn) => fn(),
      on: (event, handler) => { handlers.set(event, handler); return () => {}; },
      systemPrompt: { section: (section) => sections.push(section) },
      tools: { register: (tool) => tools.push(tool) },
      get: () => ({ register: () => {} }),
    }, config);
    return { sections, handlers, profile: tools[0].execute() };
  }

  const userMode = probe({ injectionMode: "user" });
  assert.equal(userMode.sections.length, 0, "user 模式不应注册 system 段");
  assert.equal(userMode.handlers.has("agent/pre-step"), true, "user 模式必须注册 pre-step");
  assert.equal(userMode.profile.injectionMode, "user");
  assert.equal(userMode.profile.injectionChannel, "user");

  const legacyMode = probe({ injectionMode: "legacy" });
  assert.equal(legacyMode.sections.length, 2, "legacy 模式必须注册 Order 100 + Order 200 两段");
  assert.equal(legacyMode.profile.injectionMode, "legacy");
  assert.equal(legacyMode.profile.injectionChannel, "system");
  // 0.9.0 起 pre-step 常驻（负责硬关的作废声明），legacy 模式下它不追加内核
  const legacyDecision = await legacyMode.handlers.get("agent/pre-step")(
    { agent: {} },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.equal(legacyDecision.messages.length, 0, "legacy 模式不应追加 user 注入消息");

  // 老 bundle patch 残留 injectionChannel: user 时，显式 mode 必须赢。
  const overridden = probe({ injectionMode: "legacy", injectionChannel: "user" });
  assert.equal(overridden.sections.length, 2);
  assert.equal(overridden.profile.injectionMode, "legacy");

  // 未给 mode 时仍兼容旧配置与默认 user 模式。
  assert.equal(probe({}).profile.injectionMode, "user");
  assert.equal(probe({ injectionChannel: "system" }).profile.injectionMode, "legacy");
});

test("user 模式追加带来源的注入消息，且按可见历史幂等", async () => {
  useTempHome();
  const handlers = new Map();
  plugin.apply({
    effect: (fn) => fn(),
    on: (event, handler) => { handlers.set(event, handler); return () => {}; },
    systemPrompt: { section: () => {} },
    tools: { register: () => {} },
    get: () => ({ register: () => {} }),
  }, { injectionMode: "user" });

  const preStep = handlers.get("agent/pre-step");
  assert.equal(typeof preStep, "function");

  const userMessage = {
    role: "user",
    id: "u1",
    content: [{ type: "text", text: "帮我看看这个" }],
    source: { kind: "user" },
  };
  const decide = () => ({ kind: "enter", messages: [userMessage] });

  // 首次：可见历史里没有注入 → 追加一条 fujiang-armor 来源的 user 消息
  const emptySession = { seq: 0, surface: { nodes: [] }, eventAt: () => undefined };
  const first = await preStep({ agent: { session: emptySession }, turn: 1, step: 1 }, async () => decide());
  assert.equal(first.messages.length, 2);
  const injected = first.messages[1];
  assert.equal(injected.role, "user");
  assert.equal(injected.source.kind, "fujiang-armor");
  assert.equal(injected.source.form, "snapshot");
  assert.ok(typeof injected.id === "string" && injected.id.length > 0);
  const text = injected.content[0].text;
  // 注入块用宿主的 system-reminder 外壳，不冒充用户输入
  assert.ok(text.startsWith("<system-reminder>\n"));
  assert.ok(text.trimEnd().endsWith("</system-reminder>"));
  assert.ok(text.includes("You are 年前,"));
  // 用户原文一个字都不改
  assert.equal(first.messages[0].content[0].text, "帮我看看这个");

  // 已可见：不再重复追加，返回同一个 decision 引用
  const presentSession = {
    seq: 1,
    surface: { nodes: [0] },
    eventAt: () => ({ seq: 0, type: "user/message", data: { source: { kind: "fujiang-armor" } } }),
  };
  const decision = decide();
  assert.equal(await preStep({ agent: { session: presentSession }, turn: 2, step: 1 }, async () => decision), decision);

  // 被压缩掉（事件不可见）：重新补一条
  const prunedSession = {
    seq: 1,
    surface: { nodes: [] },
    eventAt: () => ({ seq: 0, type: "user/message", data: { source: { kind: "fujiang-armor" } } }),
  };
  const again = await preStep({ agent: { session: prunedSession }, turn: 3, step: 1 }, async () => decide());
  assert.equal(again.messages.length, 2);

  // 老宿主读不到 session：进程内记忆保证同一会话只追加一次
  const legacyAgent = { session: {} };
  const unknownFirst = await preStep({ agent: legacyAgent, turn: 1, step: 1 }, async () => decide());
  assert.equal(unknownFirst.messages.length, 2);
  const unknownSecond = decide();
  assert.equal(await preStep({ agent: legacyAgent, turn: 1, step: 2 }, async () => unknownSecond), unknownSecond);

  // 本步批次里已经带了注入消息 → 跳过
  const already = { kind: "enter", messages: [userMessage, { ...injected }] };
  assert.equal(await preStep({ agent: { session: emptySession }, turn: 1, step: 1 }, async () => already), already);
});

test("运行时开关：命令与工具同源、状态落盘、system 段随模式增删", () => {
  useTempHome();
  const commands = [];
  const tools = [];
  let sections = 0;
  plugin.apply({
    effect: (fn) => fn(),
    on: () => () => {},
    systemPrompt: { section: () => { sections += 1; return () => { sections -= 1; }; } },
    tools: { register: (tool) => tools.push(tool) },
    get: (name) => (name === "commands"
      ? { register: (definition) => { commands.push(definition); return () => {}; } }
      : undefined),
  }, { injectionMode: "legacy" });

  assert.equal(sections, 2, "legacy 模式应挂 Order 100 + 200");
  assert.equal(commands.length, 1, "/fujiang 命令未注册");
  const command = commands[0];
  const call = (rawInput, agent = { session: {} }) => JSON.parse(command.handler({ rawInput, agent }).text);

  const status = call("");
  assert.equal(status.ok, true);
  assert.equal(status.enabled, true);
  assert.equal(status.mode, "legacy");

  const off = call(" off hard");
  assert.equal(off.ok, true);
  assert.equal(off.enabled, false);
  assert.equal(off.off, "hard");
  assert.equal(sections, 0, "关闭后 system 段应摘除");

  const saved = JSON.parse(readFileSync(join(process.env.DSH_HOME, "fujiang-armor.state.json"), "utf8"));
  assert.equal(saved.enabled, false);
  assert.equal(saved.mode, "legacy");

  const switchTool = tools.find((tool) => tool.name === "fujiang_switch");
  assert.ok(switchTool, "fujiang_switch 未注册");
  assert.equal(switchTool.execute({ action: "on" }).ok, true);
  assert.equal(sections, 2, "重新打开后 system 段回来");

  const mode = switchTool.execute({ action: "mode", value: "user" });
  assert.equal(mode.ok, true);
  assert.equal(mode.mode, "user");
  assert.equal(mode.channel, "user");
  assert.equal(sections, 0, "user 模式不挂 system 段");

  // 工具没有会话上下文：hard-off 必须拒绝，避免写不进作废声明却把开关关了
  assert.equal(switchTool.execute({ action: "off", value: "hard" }).ok, false);
  assert.equal(switchTool.execute({ action: "nope" }).ok, false);
  assert.equal(switchTool.execute({ action: "mode", value: "bogus" }).ok, false);
  // 工具状态查询与命令同源
  const viaTool = switchTool.execute({ action: "status" });
  assert.equal(viaTool.enabled, true);
  assert.equal(viaTool.mode, "user");
});

test("关闭后不再注入内核；硬关只追加一次作废声明", async () => {
  useTempHome();
  const handlers = new Map();
  const commands = [];
  plugin.apply({
    effect: (fn) => fn(),
    on: (event, handler) => { handlers.set(event, handler); return () => {}; },
    systemPrompt: { section: () => () => {} },
    tools: { register: () => {} },
    get: (name) => (name === "commands"
      ? { register: (definition) => { commands.push(definition); return () => {}; } }
      : undefined),
  }, { injectionMode: "user" });

  const preStep = handlers.get("agent/pre-step");
  const session = { seq: 0, surface: { nodes: [] }, eventAt: () => undefined };
  const agent = { session };
  const decide = () => ({ kind: "enter", messages: [] });

  const first = await preStep({ agent }, async () => decide());
  assert.equal(first.messages.length, 1, "默认应注入内核");
  assert.ok(first.messages[0].content[0].text.includes("You are 年前"));

  const off = JSON.parse(commands[0].handler({ rawInput: " off hard", agent }).text);
  assert.equal(off.enabled, false);

  const second = await preStep({ agent }, async () => decide());
  assert.equal(second.messages.length, 1, "关闭后应只追加作废声明");
  const text = second.messages[0].content[0].text;
  assert.ok(text.includes("富江破甲已关闭"));
  assert.ok(!text.includes("You are 年前"), "作废声明不应再带内核");

  const third = await preStep({ agent }, async () => decide());
  assert.equal(third.messages.length, 0, "作废声明只写一次");

  // 重新打开后恢复注入
  JSON.parse(commands[0].handler({ rawInput: " on", agent }).text);
  const fourth = await preStep({ agent }, async () => decide());
  assert.equal(fourth.messages.length, 1);
  assert.ok(fourth.messages[0].content[0].text.includes("You are 年前"));
});
test("server, manifest, and client use the same plugin identity", () => {
  assert.equal(plugin.name, "fujiang-armor");
  assert.equal(pkg.name, plugin.name);
  assert.equal(pkg.dsh.id, plugin.name);
  assert.equal(pkg.dsh.name, "富江破甲");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.deepEqual(pkg.dsh.client.inject, ["@deepseek-ai/dsh-client-ui-conversation"]);
});

test("manifest declares the verified DSH compatibility range", () => {
  // 0.7.1 起按 rc.5 的规则显式声明兼容范围：engines.dsh 单独决定结论，
  // 宿主用 semver.satisfies(..., { includePrerelease: true }) 求值。
  // 上界写成 <0.3.0-0，连 0.3.0 的预发布版一起排除。
  assert.equal(pkg.engines.dsh, ">=0.2.1 <0.3.0-0");
  assert.equal(pkg.dsh.manifestVersion, 1);
});

test("manifest exports the display resources DSH 0.2.2 reads", () => {
  assert.equal(pkg.exports["./icon"], "./icon.svg");
  assert.equal(pkg.exports["./locale/*.json"], "./locale/*.json");
  assert.ok(pkg.files.includes("locale/*.json"));
  assert.ok(pkg.files.includes("icon.svg"));
  const en = JSON.parse(load("locale/en.json"));
  const zh = JSON.parse(load("locale/zh.json"));
  assert.ok(en.meta.title.length > 0 && en.meta.description.length > 0);
  assert.ok(zh.meta.title.length > 0 && zh.meta.description.length > 0);
  assert.ok(load("icon.svg").toString("utf8").includes("<svg"));
});

test("both prompt sections register as literal (interpolate:false) sections", () => {
  useTempHome();
  const sections = [];
  const tools = [];
  const projections = [];
  plugin.apply({
    effect: (fn) => fn(),
    // 0.6.0 起 apply 还会注册 agent/pre-step 监听（user 通道），mock 需要提供 on
    on: () => () => {},
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: (tool) => tools.push(tool) },
    get: (name) => name === "sessionProjections"
      ? { register: (definition) => projections.push(definition) }
      : undefined,
  }, { autoApplyOnStart: false, injectionChannel: "system" });

  assert.deepEqual(
    sections.map(({ name, order }) => ({ name, order })),
    [
      { name: "fujiang-armor:global-system-prompt", order: 100 },
      { name: "fujiang-armor:dual-layer-reinforce", order: 200 },
    ],
  );
  for (const section of sections) {
    // 0.2.x：段文本原样注入，宿主不再做 {{变量}} 插值。
    assert.equal(section.interpolate, false);
    assert.ok(section.text.length > 0);
    // 提示词本身不含 {{…}} 组：即使旧宿主忽略 interpolate，也不会触发组装失败。
    assert.ok(!section.text.includes("{{"));
    // 旧版把花括号改写成 "{ {"，新版不再需要该转义。
    assert.ok(!section.text.includes("{ {"));
  }
  assert.equal(sections[0].text, sections[1].text);
  assert.equal(tools[0].execute().plugin, plugin.name);
  assert.equal(tools[0].execute().pluginDisplayName, "富江破甲");
  assert.equal(tools[0].execute().pluginVersion, pkg.version);
  assert.equal(projections[0].key, "fujiang-armor");
  assert.equal(projections[0].wire.summary, false);
});

test("armor projection folds events and keeps the same reference otherwise", () => {
  useTempHome();
  const sections = [];
  const projections = [];
  plugin.apply({
    effect: (fn) => fn(),
    on: () => () => {},
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: () => {} },
    get: (name) => (name === "sessionProjections"
      ? { register: (definition) => projections.push(definition) }
      : undefined),
  }, {});

  const definition = projections[0];
  const initial = definition.init({}, 3);
  assert.equal(initial.inheritedEventCount, 3);
  assert.equal(initial.running, false);

  // fork 继承的历史事件不参与判定
  const inherited = { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "我无法协助" }] } } };
  assert.equal(definition.apply(initial, inherited), initial);

  const running = definition.apply(initial, { seq: 4, type: "user/message", data: {} });
  assert.equal(running.running, true);
  // 重复的 user/message 不应产生新对象
  assert.equal(definition.apply(running, { seq: 5, type: "user/message", data: {} }), running);

  const refused = definition.apply(running, {
    seq: 6,
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "抱歉，我无法提供这个内容。" }] } },
  });
  assert.equal(refused.verdict, "refusal");
  assert.equal(refused.running, false);
  assert.ok(refused.words.length > 0);

  // 与投影无关的事件返回同一引用
  assert.equal(definition.apply(refused, { seq: 7, type: "turn/end", data: {} }), refused);
});

test("client registers the activation badge above the conversation input", () => {
  let client;
  let registration;
  const react = {
    useRef: (current) => ({ current }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    createElement: (tag, props, ...children) => ({ tag, props, children }),
  };
  runInNewContext(load("client.js").toString("utf8"), {
    window: { __ModuleLoader__: { load: ({ id, factory }) => {
      assert.equal(id, plugin.name);
      client = factory((name) => {
        assert.equal(name, "react");
        return react;
      });
    } } },
    console,
  });
  assert.equal(client.name, plugin.name);
  client.apply({ slots: {
    inject: (name, callback) => {
      assert.equal(name, "conversation.input.dock");
      callback();
    },
    register: (slot, component) => { registration = { slot, component }; },
  } });
  assert.equal(registration.slot.name, "conversation.input.dock");
  assert.equal(registration.slot.id, "fujiang-armor:badge");
  const badge = registration.component({ useProjection: (key) => {
    assert.equal(key, "fujiang-armor");
    return undefined;
  } }).children[0];
  assert.equal(badge.props.title, "富江破甲已激活");
  assert.equal(badge.children[1].children[0], "富江破甲已激活");
});

test("bundle patch writes the selected injection mode and stays cwd-free", () => {
  const patch = load("cordis.patch.yml").toString("utf8");
  assert.match(patch, /id: fujiang-armor/);
  assert.match(patch, /includeHarnessIdentity: false/);
  assert.match(patch, /injectionMode: user/);
  assert.ok(!patch.includes("injectionChannel:"), "bundle patch 不应再写会覆盖模式的旧字段");
  // 只看生效行：注释里说明这件事是允许的。
  const effective = patch
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.ok(!effective.includes("personaSuffix"), "personaSuffix 必须保持缺省（0.2.2 起 {{cwd}} 无法解析）");
  assert.ok(!effective.includes("{{cwd}}"));
});

test("PowerShell 脚本必须带 UTF-8 BOM 且能通过语法解析", () => {
  // Windows PowerShell 5.1 按系统 ANSI 代码页解析无 BOM 的 .ps1：
  // 中文会被解坏、连引号都可能被吃掉，脚本直接语法错误无法运行。
  // 安装器只随发布包提供，装进 $DSH_HOME\plugins 的副本里没有，缺失时跳过。
  const present = (file) => existsSync(new URL(file, root));
  for (const file of [
    "install.ps1",
    "uninstall.ps1",
    "scripts/ensure-runtime.ps1",
    "scripts/isolate-instance.ps1",
  ]) {
    if (!present(file)) continue;
    const head = [...load(file).subarray(0, 3)];
    assert.deepEqual(head, [0xef, 0xbb, 0xbf], `${file} 缺少 UTF-8 BOM`);
  }
  if (!present("install.ps1")) return;
  // 0.7.0 曾因多写一个右花括号导致 install.ps1 整个解析失败。
  // 静态括号守卫：字符串与本脚本里的花括号不参与计数。
  const ps = load("install.ps1").toString("utf8");
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < ps.length; i += 1) {
    const ch = ps[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (ch === "#") { while (i < ps.length && ps[i] !== "\n") i += 1; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    assert.ok(depth >= 0, `install.ps1: 第 ${ps.slice(0, i).split("\n").length} 行出现多余的右花括号`);
  }
  assert.equal(depth, 0, "install.ps1 花括号不平衡（安装器会直接 ParserError）");
  assert.equal(inSingle, false, "install.ps1 单引号未闭合");
  assert.equal(inDouble, false, "install.ps1 双引号未闭合");
});

test("compat.js 的 stdout JSON 必须是纯 ASCII", async () => {
  // 调用方（PowerShell）捕获子进程 stdout 时按控制台代码页解码；
  // 中文 Windows 是 GBK，直接输出 UTF-8 中文会被解坏并导致 JSON 解析失败。
  const compat = await import("./lib/compat.js");
  const json = compat.asciiJson({ warnings: ["DSH 0.2.2-rc.1：personaSuffix 中的 {{cwd}} 已失效"] });
  assert.ok(/^[\x20-\x7e]*$/.test(json), "stdout JSON 含非 ASCII 字符");
  const parsed = JSON.parse(json);
  assert.equal(parsed.warnings[0], "DSH 0.2.2-rc.1：personaSuffix 中的 {{cwd}} 已失效");
});

test("compat layer mounts and unmounts the profile patch idempotently", async () => {
  const compat = await import("./lib/compat.js");

  const empty = "[]\n";
  const mounted = compat.mountProfilePatch(empty, "fujiang-armor");
  assert.match(mounted.text, /- id: system-prompt/);
  assert.match(mounted.text, /includeHarnessIdentity: false/);
  assert.match(mounted.text, /id: fujiang-armor/);
  assert.match(mounted.text, /injectionMode: user/);
  assert.ok(!mounted.text.includes("injectionChannel:"));
  assert.ok(!mounted.text.includes("{{cwd}}"));

  const again = compat.mountProfilePatch(mounted.text, "fujiang-armor");
  assert.equal(again.text, mounted.text, "重复安装必须幂等");

  // legacy 模式：托管块写入 injectionMode: legacy，重挂载可切回 user。
  const legacyPatch = compat.mountProfilePatch(empty, "fujiang-armor", "legacy");
  assert.match(legacyPatch.text, /injectionMode: legacy/);
  assert.ok(!legacyPatch.text.includes("injectionMode: user"));
  const backToUser = compat.mountProfilePatch(legacyPatch.text, "fujiang-armor", "user");
  assert.equal(backToUser.text, mounted.text);
  assert.equal(compat.normalizeInjectionMode("LEGACY"), "legacy");
  assert.equal(compat.normalizeInjectionMode("garbage"), "user");

  const unmounted = compat.unmountProfilePatch(mounted.text, "fujiang-armor");
  assert.ok(!unmounted.text.includes("fujiang-armor"));
  assert.ok(!unmounted.text.includes("includeHarnessIdentity"));

  // 旧版安装留下的 insert 行同样能被清理
  const legacyInsert = [
    "- insert:",
    "    - id: fujiang-armor",
    "      name: 'fujiang-armor'",
    "",
  ].join("\n");
  assert.ok(!compat.unmountProfilePatch(legacyInsert, "fujiang-armor").text.includes("fujiang-armor"));
});

test("compat layer strips the dead {{cwd}} persona clause", async () => {
  const compat = await import("./lib/compat.js");

  const inline = [
    "- id: system-prompt",
    "  config:",
    '    personaSuffix: Your working directory is {{cwd}}.',
  ].join("\n");
  const inlineResult = compat.stripCwdPersona(inline);
  assert.equal(inlineResult.removed.length, 1);
  assert.ok(!inlineResult.text.includes("personaSuffix"));

  const block = [
    "- id: system-prompt",
    "  config:",
    "    personaSuffix: |",
    "      You are terse.",
    "      Your working directory is {{cwd}}.",
  ].join("\n");
  const blockResult = compat.stripCwdPersona(block);
  assert.ok(!blockResult.text.includes("{{cwd}}"));
  assert.ok(blockResult.text.includes("You are terse."));

  // 不含 cwd 的 persona 必须原样保留
  const kept = "- id: system-prompt\n  config:\n    personaSuffix: Stay brief.\n";
  assert.equal(compat.stripCwdPersona(kept).text, kept);
});

test("compat layer drops third-party mounts when seeding an isolated profile", async () => {
  const compat = await import("./lib/compat.js");
  const patch = [
    "- id: llm-pi-ai",
    "  config:",
    "    providers: {}",
    "- insert:",
    "    - id: dsh-purge",
    "      name: dsh-purge",
    "",
    "- insert:",
    "    - id: fujiang-armor",
    "      name: 'fujiang-armor'",
    "",
  ].join("\n");
  const seeded = compat.stripAllInsertRows(patch);
  assert.ok(seeded.includes("llm-pi-ai"));
  assert.ok(!seeded.includes("dsh-purge"));
  assert.ok(!seeded.includes("fujiang-armor"));
});
