import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import * as plugin from "../index.js";

const root = new URL("../", import.meta.url);
const load = (file) => readFileSync(new URL(file, root));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// 提示词三件套（fujiang.md / fujiang-mirror.md / fujiang-compat.md）必须逐字节一致。
// 自定义提示词内容后请同步更新本常量：
// PowerShell: (Get-FileHash prompts\fujiang.md -Algorithm SHA256).Hash.ToLower()
const expectedHash = "0558c0e8dff68aba460de6ddd32fd81f1dba6686fed24251e34ec5a6577c5446";
const pkg = JSON.parse(load("package.json"));

test("prompt assets preserve the supplied bytes", () => {
  for (const file of ["fujiang.md", "fujiang-mirror.md", "fujiang-compat.md"]) {
    assert.equal(hash(load(`prompts/${file}`)), expectedHash);
  }
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
  const sections = [];
  const projections = [];
  plugin.apply({
    effect: (fn) => fn(),
    on: () => () => {},
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: () => {} },
    get: () => ({ register: (definition) => projections.push(definition) }),
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

test("bundle patch never reintroduces the removed {{cwd}} persona variable", () => {
  const patch = load("cordis.patch.yml").toString("utf8");
  assert.match(patch, /id: fujiang-armor/);
  assert.match(patch, /includeHarnessIdentity: false/);
  // 只看生效行：注释里说明这件事是允许的。
  const effective = patch
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.ok(!effective.includes("personaSuffix"), "personaSuffix 必须保持缺省（0.2.2 起 {{cwd}} 无法解析）");
  assert.ok(!effective.includes("{{cwd}}"));
});

test("PowerShell 脚本必须带 UTF-8 BOM", () => {
  // Windows PowerShell 5.1 按系统 ANSI 代码页解析无 BOM 的 .ps1：
  // 中文会被解坏、连引号都可能被吃掉，脚本直接语法错误无法运行。
  for (const file of [
    "install.ps1",
    "uninstall.ps1",
    "scripts/ensure-runtime.ps1",
    "scripts/isolate-instance.ps1",
  ]) {
    const head = [...load(file).subarray(0, 3)];
    assert.deepEqual(head, [0xef, 0xbb, 0xbf], `${file} 缺少 UTF-8 BOM`);
  }
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
  assert.ok(!mounted.text.includes("{{cwd}}"));

  const again = compat.mountProfilePatch(mounted.text, "fujiang-armor");
  assert.equal(again.text, mounted.text, "重复安装必须幂等");

  const unmounted = compat.unmountProfilePatch(mounted.text, "fujiang-armor");
  assert.ok(!unmounted.text.includes("fujiang-armor"));
  assert.ok(!unmounted.text.includes("includeHarnessIdentity"));

  // 旧版安装留下的 insert 行同样能被清理
  const legacy = [
    "- insert:",
    "    - id: fujiang-armor",
    "      name: 'fujiang-armor'",
    "",
  ].join("\n");
  assert.ok(!compat.unmountProfilePatch(legacy, "fujiang-armor").text.includes("fujiang-armor"));
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
