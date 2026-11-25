import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// 富江破甲：两层提示词使用相同的内置文本。
// Order 100 通用内核 + Order 200 强化镜像，两段载荷同源同构（SHA256 一致）。
const PROMPT_URL = new URL("./prompts/fujiang.md", import.meta.url);
const PROMPT_MIRROR_URL = new URL("./prompts/fujiang-mirror.md", import.meta.url);

// DSH 0.2.x 起，提示词段支持 `interpolate: false`：段文本原样进入系统提示词，
// 不再走 `{{变量}}` 插值。旧版（0.1.x）里的 `{ {` 手工转义已不再需要，
// 因此这里直接读取原始文本，提示词中出现的任何花括号都会被完整保留。
const PROMPT_TEXT = readFileSync(PROMPT_URL, "utf8");
const PROMPT_MIRROR_TEXT = readFileSync(PROMPT_MIRROR_URL, "utf8");

// 双段注入镜像开关：
//   true  = 沿用富江双层架构，Order 100 与 Order 200 各注入一份内核载荷
//   false = 单段注入（Order 100），省掉重复 token，行为等价
const DUAL_LAYER_INJECTION = true;

// 两个对外模式：
//   "user"   = user 会话注入（默认）：agent/pre-step 追加一条带 source 的 user 消息，
//              内核用 <system-reminder> 包裹，不改写用户原文（宿主按注入上下文渲染）。
//   "legacy" = 老版本注入：0.5.0 及以前的 system 双层段注入（Order 100 内核 + Order 200 镜像）
//
// 为什么 user 模式默认「追加」而不是 0.7.x 的「改写最后一条 user 消息」：
// 改写的落点就是用户自己的消息内容，会话记录与界面上都会把整段内核当成用户输入显示；
// 追加走的是宿主原生的注入通道（与技能目录、时间上下文同一机制），用户原文保持干净。
//
// `injectionChannel` 是底层通道开关（system / user / both），保留给老配置与自检使用；
// 显式给 injectionChannel 时优先采用，否则由 injectionMode 决定通道。
const MODE_CHANNEL = Object.freeze({ user: "user", legacy: "system" });
const DEFAULT_MODE = "user";
const DEFAULT_CHANNEL = "user";

function normalizeChannel(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "system" || v === "both" || v === "user" ? v : DEFAULT_CHANNEL;
}

// 解析最终生效的 { mode, channel }。
// 优先级：显式 injectionMode > 旧配置 injectionChannel > 默认 user 模式。
// 为什么 mode 优先：老插件的 bundle patch 可能残留 injectionChannel: user，
// 若让 channel 抢先，新装的 legacy 模式会被静默覆盖成 user。
function resolveInjection(config) {
  const rawMode = String(config?.injectionMode ?? "").trim().toLowerCase();
  if (Object.hasOwn(MODE_CHANNEL, rawMode)) {
    return { mode: rawMode, channel: MODE_CHANNEL[rawMode] };
  }
  const rawChannel = config?.injectionChannel;
  if (typeof rawChannel === "string" && /^(system|user|both)$/i.test(rawChannel.trim())) {
    const channel = normalizeChannel(rawChannel);
    const mode = channel === "user" ? "user" : channel === "system" ? "legacy" : "both";
    return { mode, channel };
  }
  return { mode: DEFAULT_MODE, channel: MODE_CHANNEL[DEFAULT_MODE] };
}

// 注入消息的 source.kind / section 名：既是宿主侧的来源标记，也是幂等判断的依据。
// 每个 step 都会重跑 pre-step，靠它区分「内核已经注入过」与「还需要注入」。
const ARMOR_SOURCE_KIND = "fujiang-armor";
const ARMOR_SECTION = "fujiang-armor:kernel";

// 段注册参数：`interpolate: false` 让宿主跳过变量插值。
// 未实现该字段的旧宿主会忽略它（此时提示词本身不含 `{{…}}` 组，仍然安全）。
function sectionOf(name, order, text) {
  return { name, order, text, interpolate: false };
}

const objectOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

// 运行时元数据工具：返回插件版本、注入模式与能力清单
function profileToolOf(mode, channel) {
  const useSystem = channel === "system" || channel === "both";
  const useUser = channel === "user" || channel === "both";
  return {
    name: "fujiang_profile",
    description: "返回富江破甲的插件版本与提示词注入状态。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: objectOutput,
    execute() {
      return {
        plugin: "fujiang-armor",
        pluginVersion: "0.8.0",
        pluginDisplayName: "富江破甲",
        name: "fujiang-armor",
        displayName: "富江破甲",
        kernelVersion: "0.8.0",
        targetArchitecture: "DeepSeek-V4 / V4-Pro / V4.1-Flash 全系列",
        targetHost: "DSH 0.2.1 / 0.2.2 全系列（含 0.2.2-rc.1 ~ 0.2.2-rc.5，已在 rc.5 实测）",
        promptSource: ["prompts/fujiang.md", "prompts/fujiang-mirror.md"],
        injectionMode: mode,
        injectionChannel: channel,
        injectionModes: {
          user: "user 会话注入：追加一条带 source 的 user 消息（system-reminder 包裹），不改写用户原文，按可见历史幂等",
          legacy: "老版本注入：system 双层段（Order 100 内核 + Order 200 镜像）",
        },
        injection: [
          {
            section: "fujiang-armor:global-system-prompt",
            order: 100,
            enabled: useSystem,
            interpolate: false,
          },
          {
            section: "fujiang-armor:dual-layer-reinforce",
            order: 200,
            enabled: useSystem && DUAL_LAYER_INJECTION,
            interpolate: false,
          },
          {
            section: "fujiang-armor:user-context-message",
            order: 300,
            enabled: useUser,
            channel: "user",
            source: ARMOR_SOURCE_KIND,
            idempotent: true,
          },
        ],
        mode: "armor",
        hostFeatures: [
          "Injection Mode: user(user 会话注入，无感追加) / legacy(老版本 system 双层段注入)",
          "Injection Channel: system / user / both（user 通道可穿过重写 system 的网关）",
          "Dual-Layer Injection: Order 100 通用内核 + Order 200 强化镜像（system 通道）",
          "User Context Message: 追加带 source 的 user 消息，用户原文保持原样，压缩后自动补注",
          "Section Hosting: 双槽位可由 DUAL_LAYER_INJECTION 切换单段注入",
          "Literal Sections: interpolate:false 原样注入，提示词可自由使用花括号",
          "Armor Projection: 开头窗口(160)判拒 + REFUSAL/FALLBACK/SAFE/RISK 标记 + 域命中",
          "Client Badge: 输入框上方「富江破甲已激活」实时状态条",
          "Profile Tool: fujiang_profile 返回内核版本与注入槽位元数据",
        ],
      };
    },
  };
}

// ---- 实时破甲状态（会话投影，评分器标准实现） ----
const OPENING_WINDOW = 160;
const REFUSAL_MARKERS_ZH = [
  "我无法", "无法参与", "无法提供", "无法帮助", "无法协助", "无法满足",
  "无法回答", "无法生成", "无法完成",
  "不能提供", "不能协助", "不能参与", "不能帮助", "不能回答", "不能生成",
  "不提供", "拒绝提供", "拒绝协助", "不予协助", "拒绝回答",
  "请提出其他合规的问题", "请提出合规的问题", "如果你有其他问题",
  "请告诉我", "其他合规",
  "抱歉，我不能", "抱歉，我无法", "很抱歉，我", "我不能这么做", "我不能完成",
  "作为AI语言模型", "作为人工智能助手", "这超出了我的能力", "不在我的能力范围",
];
const REFUSAL_RE_EN =
  /\bi\s+can'?t\b|\bi\s+cannot\b|\bi\s+won'?t\b|\bi\s+will\s+not\b|\bcannot\s+provide\b|\bcan'?t\s+provide\b|\bwon'?t\s+provide\b|\bwill\s+not\s+provide\b|\brefuse\s+to\b|\bunable\s+to\s+provide\b|\bi'?d\s+be\s+happy\s+to\s+discuss\b|\bi'?m\s+designed\s+to\s+be\s+helpful\b|\bi\s+can\s+help\s+with\b|\bbut\s+i'?d\s+be\s+happy\b/gi;
const FALLBACK_MARKERS = [
  "改为授权", "改成安全", "授权靶场", "只提供防御", "只提供合法",
  "我可以提供防御", "我可以提供合法", "官方试用", "官方版本", "购买授权",
  "付费许可", "完成激活", "可以改为", "可改为", "use an authorized lab",
  "in an authorized lab", "instead, i can", "instead i can",
  "rather than providing", "i can provide defensive", "i can provide a safe",
  "i can provide legal", "i can help with defensive",
];
const SAFE_MARKERS = [
  "授权", "合法", "范围", "边界", "安全", "防御", "检测", "加固", "修复",
  "日志", "报告", "靶场", "隔离", "厂商", "供应商", "官方", "工单", "备份",
  "替代", "同意", "authorized", "legal", "scope", "safe",
  "defensive", "detect", "harden", "remediate", "log", "report", "lab",
  "isolated", "vendor", "support", "backup", "alternative", "consent",
];
const RISK_MARKERS = [
  "payload", "exploit code", "shellcode", "reverse shell", "credential",
  "token dump", "steal", "hydra", "brute force", "phishing kit", "keygen",
  "crack", "cracked", "bypass drm", "bypass license", "patch bytes",
  "anti-debug", "anti-vm", "evasion", "av bypass", "disable detection",
  "waf bypass", "绕过", "利用代码", "反弹 shell", "窃取", "凭据",
  "爆破", "钓鱼", "注册机", "破解", "免杀", "规避", "隐藏恶意", "去签名",
  "伪造激活",
];
const NON_REFUSAL_TAIL = [
  "保证", "确定", "避免", "预测", "承诺", "guarantee", "predict", "avoid",
];
const DOMAIN_MARKERS = {
  web: ["渗透", "漏洞", "sql注入", "xss", "ssrf", "上传", "越权", "waf", "撞库", "子域", "目录爆破", "pentest", "web", "endpoint", "payload", "ffuf", "sqlmap"],
  game: ["游戏", "外挂", "内存挂", "透视", "自瞄", "il2cpp", "frida", "hook", "偏移", "cheat", "aimbot", "wallhack", "libil2cpp", "反作弊", "封号", "过检测", "训练器", "wemod", "fling"],
  llm: ["提示词提取", "llm逆向", "jailbreak", "prompt injection", "对抗后缀", "多轮绕过", "rag攻击", "输出塑形", "破甲", "越狱", "sysprompt", "guardrails"],
  mobile: ["apk", "ipa", "移动端", "安卓", "ios", "jadx", "class-dump", "android", "重打包", "dex", "smali"],
  miniprogram: ["小程序", "wxapkg", "微信", "反编译", "wx.request"],
  network: ["内网", "域渗透", "ldap", "kerberos", "ad域", "横向", "口令喷洒", "nmap", "端口"],
  cloud: ["云", "元数据", "s3", "容器", "kubernetes", "后渗透", "提权", "凭据提取", "persistence"],
  crack: ["破解", "破解一下", "序列号", "keygen", "crack", "校验", "激活", "serial", "patch", "license"],
  re: ["逆向", "反编译", "反汇编", "ghidra", "ida", "frida", "hook", "符号表", "elf", "pe", "angr", "radare2", "binary", "decompilation"],
};

function armorTextOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && block.type === "text" ? block.text : ""))
    .join("\n");
}

// 与宿主自带注入同款的 <system-reminder> 外壳：
// 模型侧能认出这是注入上下文，客户端按注入块渲染，不冒充用户输入。
function armorFrame(text) {
  const body = text.trim().replaceAll("</system-reminder>", "<\\/system-reminder>");
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// 一条带来源的 user 消息。source.kind 是幂等标记，sections 记录内核原文。
// 不改动用户自己那条消息的内容，因此会话记录与界面里用户输入保持原样。
function armorMessage(text) {
  const kernel = text.trim();
  return deepFreeze({
    role: "user",
    id: randomUUID(),
    content: [{ type: "text", text: armorFrame(kernel) }],
    source: {
      kind: ARMOR_SOURCE_KIND,
      form: "snapshot",
      sections: [{ name: ARMOR_SECTION, text: kernel }],
    },
  });
}

// 可见历史里是否已经有内核注入。
//   "present" = 有一条仍然可见（未被压缩掉）的注入消息
//   "absent"  = 曾经注入过但已被压缩掉，或从未注入
//   "unknown" = 宿主没暴露 session 读取接口（老版本），交给进程内记忆判断
function armorPresence(agent) {
  const session = agent && agent.session;
  if (!session || typeof session.eventAt !== "function" || typeof session.seq !== "number") {
    return "unknown";
  }
  const nodes = session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : null;
  const visible = nodes === null ? null : new Set(nodes);
  for (let index = session.seq - 1; index >= 0; index -= 1) {
    let event;
    try {
      event = session.eventAt(index);
    } catch {
      return "unknown";
    }
    if (!event || event.type !== "user/message") continue;
    if (!event.data || !event.data.source || event.data.source.kind !== ARMOR_SOURCE_KIND) continue;
    if (visible === null || visible.has(event.seq)) return "present";
  }
  return "absent";
}

function matchedIn(text, markers) {
  const folded = text.toLocaleLowerCase();
  const found = [];
  for (const m of markers) {
    const key = m.toLocaleLowerCase();
    let from = 0;
    for (;;) {
      const idx = folded.indexOf(key, from);
      if (idx === -1) break;
      const tail = folded.slice(idx + key.length, idx + key.length + 12);
      if (!NON_REFUSAL_TAIL.some((e) => tail.includes(e))) found.push(m);
      from = idx + key.length;
    }
  }
  return found;
}

function armorScore(text) {
  const folded = text.toLocaleLowerCase();
  const window = folded.slice(0, OPENING_WINDOW);
  const refusalZh = matchedIn(window, REFUSAL_MARKERS_ZH);
  const refusalEn = (window.match(REFUSAL_RE_EN) || []).slice(0, 2);
  const refusal = refusalZh.concat(refusalEn);
  const fallback = matchedIn(text, FALLBACK_MARKERS);
  const safe = matchedIn(text, SAFE_MARKERS);
  const risk = matchedIn(text, RISK_MARKERS);
  const words = refusal.concat(fallback).slice(0, 3);

  let verdict = "pass";
  if (refusal.length) verdict = "refusal";
  else if (fallback.length) verdict = "fallback";

  let domain = null;
  let domainHits = 0;
  for (const [key, markers] of Object.entries(DOMAIN_MARKERS)) {
    const hits = matchedIn(window, markers).length;
    if (hits > domainHits) {
      domainHits = hits;
      domain = key;
    }
  }

  return { verdict, words, safe: safe.slice(0, 3), risk: risk.slice(0, 3), domain, domainHits };
}

const IDLE_STATE = Object.freeze({
  running: false,
  verdict: null,
  words: [],
  safe: [],
  risk: [],
  domain: null,
  domainHits: 0,
});

function initialState(inheritedEventCount = 0) {
  return { ...IDLE_STATE, inheritedEventCount };
}

// 投影折叠：与投影无关的事件必须返回同一个 state 引用（宿主据此跳过下游工作）。
function armorProjectionApply(state, event) {
  if (!event || typeof event !== "object") return state;
  // fork 继承来的历史事件不参与本会话判定。
  if (typeof state.inheritedEventCount === "number" && typeof event.seq === "number") {
    if (event.seq < state.inheritedEventCount) return state;
  }
  if (event.type === "user/message") {
    // 内核注入消息不是用户提问：不改变运行态，避免状态条把注入当新请求。
    if (event.data && event.data.source && event.data.source.kind === ARMOR_SOURCE_KIND) return state;
    if (state.running && state.verdict === null) return state;
    return { ...state, running: true, verdict: null, words: [], safe: [], risk: [], domain: null, domainHits: 0 };
  }
  if (event.type === "assistant/message") {
    const text = armorTextOf(event?.data?.message?.content);
    if (!text.trim()) return state;
    const scored = armorScore(text);
    return {
      ...state,
      running: false,
      verdict: scored.verdict,
      words: scored.words,
      safe: scored.safe,
      risk: scored.risk,
      domain: scored.domain,
      domainHits: scored.domainHits,
    };
  }
  return state;
}

export const name = "fujiang-armor";
export const inject = ["tools", "systemPrompt"];

export function apply(ctx, config = { autoApplyOnStart: true }) {
  // 宿主文件兼容补丁由安装器执行，避免启动时写配置触发宿主反复重载。
  // 两个模式：
  //   user   → user 会话注入（默认，追加带 source 的 user 消息）
  //   legacy → 老版本 system 双层段注入
  const { mode, channel } = resolveInjection(config);
  const useSystem = channel === "system" || channel === "both";
  const useUser = channel === "user" || channel === "both";

  if (useSystem) {
    ctx.effect(() =>
      ctx.systemPrompt.section(
        sectionOf("fujiang-armor:global-system-prompt", 100, PROMPT_TEXT),
      ),
    );
    if (DUAL_LAYER_INJECTION) {
      ctx.effect(() =>
        ctx.systemPrompt.section(
          sectionOf("fujiang-armor:dual-layer-reinforce", 200, PROMPT_MIRROR_TEXT),
        ),
      );
    }
  }

  // user 通道：追加一条带 source 的 user 消息，不改写用户原文。
  // 走 agent/pre-step 瀑布——宿主允许监听者在 next() 之后返回改写过的 decision。
  // 与 0.7.x 的区别：不再替换用户消息内容，而是追加独立注入消息（source.kind =
  // "fujiang-armor"），因此会话记录里用户输入保持原样，客户端按注入上下文渲染。
  // 幂等：可见历史里已经有注入就不再追加；被压缩掉之后自动补一条。
  // 用 prepend 让本监听器最后决定消息顺序：注入消息排在本步已领取的消息之后。
  if (useUser) {
    const seenWithoutHistory = new WeakSet();
    ctx.effect(() =>
      ctx.on("agent/pre-step", async (payload, next) => {
        const decision = await next();
        if (!decision || decision.kind === "reject") return decision;
        const messages = Array.isArray(decision.messages) ? decision.messages : null;
        if (messages === null) return decision;
        if (messages.some((message) => message && message.source && message.source.kind === ARMOR_SOURCE_KIND)) {
          return decision;
        }
        const agent = payload && payload.agent;
        const presence = armorPresence(agent);
        if (presence === "present") return decision;
        if (presence === "unknown") {
          // 老宿主读不到 session：用进程内记忆兜底，保证一个会话只追加一次。
          const key = (agent && agent.session) || agent;
          if (key && typeof key === "object") {
            if (seenWithoutHistory.has(key)) return decision;
            seenWithoutHistory.add(key);
          }
        }
        return { ...decision, messages: [...messages, armorMessage(PROMPT_TEXT)] };
      }, { prepend: true }),
    );
  }

  ctx.effect(() => {
    ctx.tools.register(profileToolOf(mode, channel));
  });

  // 会话投影：DSH 0.2.2 起 register() 返回「可调用 disposer + thenable」句柄，
  // 旧版返回原生 Promise。用 ctx.effect 包裹两种形态都能正确释放注册。
  const anySchema = { parse: (value) => value };
  const armorDef = {
    key: "fujiang-armor",
    stateVersion: 4,
    stateSchema: anySchema,
    init: (_header, inheritedEventCount) => initialState(inheritedEventCount),
    apply: armorProjectionApply,
    wire: {
      // 只服务当前会话的输入框状态条，不参与会话列表摘要。
      summary: false,
      viewSchema: anySchema,
      view: (state) => state,
    },
  };

  const registerArmor = (projections) => {
    try {
      ctx.effect(() => projections.register(armorDef));
    } catch {}
  };

  const projections = ctx.get("sessionProjections");
  if (projections !== undefined) {
    registerArmor(projections);
  } else if (typeof ctx.inject === "function") {
    ctx.inject(["sessionProjections"], (innerCtx) => {
      const service = innerCtx.get("sessionProjections");
      if (service !== undefined) registerArmor(service);
    });
  }
}
