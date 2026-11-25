// 底层通道自检：system / user / both 三条路径 + user 通道幂等 + 两个对外模式
// 用法：node scripts/test_injection_channel.mjs
//
// 0.8.0 起 user 通道的语义变了：
//   0.7.x = 把内核前缀拼到最后一条 user 消息上（改写用户原文）
//   0.8.0 = 追加一条带 source 的 user 消息（<system-reminder> 包裹），用户原文一字不改
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { apply } from "../index.js";

const ARMOR = readFileSync(new URL("../prompts/fujiang.md", import.meta.url), "utf8").trim();
const HEAD = ARMOR.slice(0, 32);
const ARMOR_KIND = "fujiang-armor";

function mockCtx() {
  const state = { sections: [], tools: [], handlers: new Map() };
  const ctx = {
    effect(fn) {
      fn();
      return () => {};
    },
    systemPrompt: {
      section(section) {
        state.sections.push(section);
        return () => {};
      },
    },
    tools: {
      register(tool) {
        state.tools.push(tool);
        return () => {};
      },
    },
    on(event, handler) {
      state.handlers.set(event, handler);
      return () => {};
    },
    get() {
      return undefined;
    },
  };
  return { ctx, state };
}

const decisionWith = (messages) => ({ kind: "enter", messages });

async function runPreStep(state, messages, agent = {}) {
  const handler = state.handlers.get("agent/pre-step");
  assert.ok(handler, "agent/pre-step 未注册");
  return handler({ agent, messages, turn: 1, step: 1 }, async () => decisionWith(messages));
}

const textOf = (message) =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
      : "";

/** 会话读取桩：可见历史里是否已有注入。 */
function sessionWith({ injected = false, visible = true } = {}) {
  return {
    seq: injected ? 1 : 0,
    surface: { nodes: visible ? (injected ? [0] : []) : [] },
    eventAt: (index) =>
      injected && index === 0
        ? { seq: 0, type: "user/message", data: { source: { kind: ARMOR_KIND } } }
        : undefined,
  };
}

async function main() {
  // 1) 默认（user 通道）：追加注入消息，用户原文不动
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    assert.equal(state.sections.length, 0, "user 通道不应注册 system 段");
    const original = { id: "b", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } };
    const out = await runPreStep(state, [original], { session: sessionWith() });
    assert.equal(out.messages.length, 2, "应追加一条注入消息");
    const injected = out.messages[1];
    assert.equal(injected.role, "user");
    assert.equal(injected.source.kind, ARMOR_KIND);
    assert.equal(injected.source.form, "snapshot");
    assert.equal(typeof injected.id, "string");
    const text = textOf(injected);
    assert.ok(text.startsWith("<system-reminder>\n"), "注入块要用宿主同款外壳");
    assert.ok(text.includes(HEAD), "注入块必须带内核正文");
    assert.equal(textOf(out.messages[0]), "你好", "用户原文必须保持原样");
    assert.equal(out.messages[0], original, "原消息对象不应被替换");
  }

  // 2) 幂等：可见历史里已有注入就不再追加
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    const agent = { session: sessionWith({ injected: true }) };
    const decision = decisionWith([{ id: "b", role: "user", content: "你好", source: { kind: "user" } }]);
    const out = await state.handlers.get("agent/pre-step")({ agent, turn: 2, step: 1 }, async () => decision);
    assert.equal(out, decision, "已注入时应返回同一个 decision 引用");
    assert.equal(out.messages.length, 1);
  }

  // 3) 压缩后重新补注
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    const agent = { session: sessionWith({ injected: true, visible: false }) };
    const out = await runPreStep(state, [{ id: "b", role: "user", content: "继续", source: { kind: "user" } }], agent);
    assert.equal(out.messages.length, 2, "注入被压缩掉之后必须补一条");
  }

  // 4) 数组内容（含图片等块）原样保留
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    const content = [{ type: "text", text: "看图" }, { type: "image", data: "x" }];
    const out = await runPreStep(state, [{ id: "c", role: "user", content, source: { kind: "user" } }], {
      session: sessionWith(),
    });
    assert.deepEqual(out.messages[0].content, content, "块内容必须原样保留");
    assert.equal(out.messages[1].source.kind, ARMOR_KIND);
  }

  // 5) system 通道：注册两段，不注册 pre-step
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionChannel: "system" });
    assert.equal(state.sections.length, 2, "system 通道应注册两段");
    assert.equal(state.handlers.has("agent/pre-step"), false, "system 通道不应注册 pre-step");
  }

  // 6) both：两路都在
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionChannel: "both" });
    assert.equal(state.sections.length, 2);
    assert.equal(state.handlers.has("agent/pre-step"), true);
  }

  // 7) 拒绝步：原样返回
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    const handler = state.handlers.get("agent/pre-step");
    const out = await handler({ agent: {} }, async () => ({ kind: "reject" }));
    assert.deepEqual(out, { kind: "reject" });
  }

  // 8) 老宿主读不到 session：同一会话只追加一次
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    const agent = { session: {} };
    const first = await runPreStep(state, [{ id: "b", role: "user", content: "你好", source: { kind: "user" } }], agent);
    assert.equal(first.messages.length, 2);
    const decision = decisionWith([{ id: "b", role: "user", content: "你好", source: { kind: "user" } }]);
    const second = await state.handlers.get("agent/pre-step")({ agent, turn: 1, step: 2 }, async () => decision);
    assert.equal(second, decision, "同一会话不应重复追加");
  }

  // 9) profile 工具报告当前通道
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionChannel: "both" });
    const profile = state.tools.find((t) => t.name === "fujiang_profile");
    assert.ok(profile, "profile 工具未注册");
    const info = profile.execute();
    assert.equal(info.injectionChannel, "both");
    const userSlot = info.injection.find((i) => i.section === "fujiang-armor:user-context-message");
    assert.ok(userSlot && userSlot.enabled === true);
    assert.equal(userSlot.source, ARMOR_KIND);
  }

  // 10) 模式一：user 会话注入
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionMode: "user" });
    assert.equal(state.sections.length, 0);
    assert.equal(state.handlers.has("agent/pre-step"), true);
    const profile = state.tools.find((t) => t.name === "fujiang_profile").execute();
    assert.equal(profile.injectionMode, "user");
    assert.equal(profile.injectionChannel, "user");
  }

  // 11) 模式二：老版本 system 双层段注入
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionMode: "legacy" });
    assert.equal(state.sections.length, 2);
    assert.equal(state.handlers.has("agent/pre-step"), false);
    const profile = state.tools.find((t) => t.name === "fujiang_profile").execute();
    assert.equal(profile.injectionMode, "legacy");
    assert.equal(profile.injectionChannel, "system");
  }

  // 12) 旧 bundle 残留 injectionChannel 不应覆盖新模式
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionMode: "legacy", injectionChannel: "user" });
    assert.equal(state.sections.length, 2);
    assert.equal(state.handlers.has("agent/pre-step"), false);
  }

  console.log("ok: 12 组注入通道/模式自检全部通过");
}

main().catch((err) => {
  console.error("FAIL:", err?.message ?? err);
  process.exit(1);
});
