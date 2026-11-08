// 底层通道自检：system / user / both 三条路径 + user 通道幂等 + 两个对外模式
// 用法：node scripts/test_injection_channel.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { apply } from "../index.js";

const ARMOR = readFileSync(new URL("../prompts/fujiang.md", import.meta.url), "utf8").trim();
const SENTINEL = ARMOR.slice(0, 48);

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

function decisionWith(messages) {
  return { kind: "accept", messages };
}

async function runPreStep(state, messages) {
  const handler = state.handlers.get("agent/pre-step");
  assert.ok(handler, "agent/pre-step 未注册");
  return handler({ agent: {}, messages, step: 1 }, async () => decisionWith(messages));
}

async function main() {
  // 1) 默认（user 通道）
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    assert.equal(state.sections.length, 0, "user 通道不应注册 system 段");
    const out = await runPreStep(state, [
      { id: "a", role: "system", content: "sys" },
      { id: "b", role: "user", content: "你好" },
    ]);
    const last = out.messages[out.messages.length - 1];
    assert.equal(last.role, "user");
    assert.ok(last.content.includes(SENTINEL), "user 消息未带上内核");
    assert.ok(last.content.trimEnd().endsWith("你好"), "原有用户内容应保留在末尾");
    assert.equal(out.messages[0].role, "system", "其它消息不应被改动");
    assert.equal(out.messages[0].content, "sys");
  }

  // 2) 幂等：同一条已注入的消息再跑一次不应重复拼接
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    const first = await runPreStep(state, [{ id: "b", role: "user", content: "你好" }]);
    const second = await runPreStep(state, first.messages);
    assert.equal(second.messages[0].content, first.messages[0].content, "第二次不应再拼接");
    const count = second.messages[0].content.split(SENTINEL).length - 1;
    assert.equal(count, 1, `内核应只出现一次，实际 ${count} 次`);
  }

  // 3) 数组内容（含图片等块）
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    const out = await runPreStep(state, [
      { id: "c", role: "user", content: [{ type: "text", text: "看图" }, { type: "image", data: "x" }] },
    ]);
    const content = out.messages[0].content;
    assert.ok(Array.isArray(content), "块内容应保持数组形态");
    assert.equal(content[0].type, "text");
    assert.ok(content[0].text.includes(SENTINEL));
    assert.equal(content[1].type, "text");
    assert.equal(content[2].type, "image", "原有块应原样保留");
  }

  // 4) system 通道：注册两段，不注册 pre-step
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionChannel: "system" });
    assert.equal(state.sections.length, 2, "system 通道应注册两段");
    assert.equal(state.handlers.has("agent/pre-step"), false, "system 通道不应注册 pre-step");
  }

  // 5) both：两路都在
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionChannel: "both" });
    assert.equal(state.sections.length, 2);
    assert.equal(state.handlers.has("agent/pre-step"), true);
  }

  // 6) 拒绝步：原样返回
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    const handler = state.handlers.get("agent/pre-step");
    const out = await handler({ agent: {} }, async () => ({ kind: "reject" }));
    assert.deepEqual(out, { kind: "reject" });
  }

  // 7) 没有 user 消息：原样返回
  {
    const { ctx, state } = mockCtx();
    apply(ctx, {});
    const messages = [{ id: "s", role: "system", content: "sys" }];
    const out = await runPreStep(state, messages);
    assert.equal(out.messages[0].content, "sys");
    assert.equal(out.messages[0].role, "system");
  }

  // 8) profile 工具报告当前通道
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionChannel: "both" });
    const profile = state.tools.find((t) => t.name === "fujiang_profile");
    assert.ok(profile, "profile 工具未注册");
    const info = profile.execute();
    assert.equal(info.injectionChannel, "both");
    const userSlot = info.injection.find((i) => i.section === "fujiang-armor:user-message-prefix");
    assert.ok(userSlot && userSlot.enabled === true);
  }

  // 9) 模式一：user 会话注入
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionMode: "user" });
    assert.equal(state.sections.length, 0);
    assert.equal(state.handlers.has("agent/pre-step"), true);
    const profile = state.tools.find((t) => t.name === "fujiang_profile").execute();
    assert.equal(profile.injectionMode, "user");
    assert.equal(profile.injectionChannel, "user");
  }

  // 10) 模式二：老版本 system 双层段注入
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionMode: "legacy" });
    assert.equal(state.sections.length, 2);
    assert.equal(state.handlers.has("agent/pre-step"), false);
    const profile = state.tools.find((t) => t.name === "fujiang_profile").execute();
    assert.equal(profile.injectionMode, "legacy");
    assert.equal(profile.injectionChannel, "system");
  }

  // 11) 旧 bundle 残留 injectionChannel 不应覆盖新模式
  {
    const { ctx, state } = mockCtx();
    apply(ctx, { injectionMode: "legacy", injectionChannel: "user" });
    assert.equal(state.sections.length, 2);
    assert.equal(state.handlers.has("agent/pre-step"), false);
  }

  console.log("ok: 11 组注入通道/模式自检全部通过");
}

main().catch((err) => {
  console.error("FAIL:", err?.message ?? err);
  process.exit(1);
});
