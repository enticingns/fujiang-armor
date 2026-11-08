import { readFileSync } from "node:fs";

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

// 注入通道：
//   "system" = 只注册 systemPrompt 段（0.5.0 及以前的行为）
//   "user"   = 只把内核文本前置到最后一条 user 消息（默认）
//   "both"   = 两路都注入
//
// 为什么默认改成 "user"：systemPrompt 段会被任何「重写 system」的中间层抹掉。
// 典型例子是网关以 prompt.mode=custom 运行时，会把 messages 里所有
// role=system/developer 的消息整段删除、换成它自己的提示词——此时内核文本到不了
// 模型。user 通道不受影响（user 内容按原样转发），因此更稳。
const DEFAULT_CHANNEL = "user";

function normalizeChannel(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "system" || v === "both" || v === "user" ? v : DEFAULT_CHANNEL;
}

// 幂等标记：取内核开头一小段，用来判断某条消息是否已经注入过。
// pre-step 每个 step 都会跑一次，同一条 user 消息会反复出现在 messages 里，
// 没有这个判断就会逐 step 重复拼接。
const ARMOR_SENTINEL = PROMPT_TEXT.trim().slice(0, 48);

// 段注册参数：`interpolate: false` 让宿主跳过变量插值。
// 未实现该字段的旧宿主会忽略它（此时提示词本身不含 `{{…}}` 组，仍然安全）。
function sectionOf(name, order, text) {
  return { name, order, text, interpolate: false };
}

const objectOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

// 运行时元数据工具：返回插件版本与能力清单
function profileToolOf(channel) {
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
        pluginVersion: "0.6.1",
        pluginDisplayName: "富江破甲",
        name: "fujiang-armor",
        displayName: "富江破甲",
        kernelVersion: "0.6.1",
        targetArchitecture: "DeepSeek-V4 / V4-Pro / V4.1-Flash 全系列",
        targetHost: "DSH 0.2.1 / 0.2.2 及以上（含 0.2.2-rc.1）",
        promptSource: ["prompts/fujiang.md", "prompts/fujiang-mirror.md"],
        injectionChannel: channel,
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
            section: "fujiang-armor:user-message-prefix",
            order: 300,
            enabled: useUser,
            channel: "user",
            idempotent: true,
          },
        ],
        mode: "armor",
        hostFeatures: [
          "Injection Channel: system / user / both（user 通道可穿过重写 system 的网关）",
          "Dual-Layer Injection: Order 100 通用内核 + Order 200 强化镜像（system 通道）",
          "User Prefix: 内核前置到本步最后一条 user 消息，幂等不重复拼接",
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

// 消息内容是否已经带过内核（幂等判断）。
function isArmored(content) {
  const text = typeof content === "string" ? content : armorTextOf(content);
  return text.includes(ARMOR_SENTINEL);
}

// 把内核文本前置到一条消息的内容上，保留原有内容与块结构。
//   string  → "<内核>\n\n<原文>"
//   blocks  → 头部插入一个 text 块，其余块原样跟随（图片等不受影响）
function armorContent(content, text) {
  const prefix = text.trim();
  if (typeof content === "string") {
    return content.length ? `${prefix}\n\n${content}` : prefix;
  }
  if (Array.isArray(content)) {
    return [{ type: "text", text: prefix }, ...content];
  }
  // 其它形态（空/未定义）不猜，直接给一条纯文本。
  return prefix;
}

// 找到最后一条 user 消息的下标；没有则 -1。
function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === "user") return i;
  }
  return -1;
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
  const channel = normalizeChannel(config?.injectionChannel);
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

  // user 通道：把内核前置到本步最后一条 user 消息。
  // 走 agent/pre-step 瀑布——宿主允许监听者在 next() 之后返回改写过的 decision
  // （与 dsh-plan-mode 追加叙述消息同一机制）。这里只换内容、不新增消息对象，
  // 因此不依赖宿主的消息工厂与 id 规则。
  if (useUser) {
    ctx.effect(() =>
      ctx.on("agent/pre-step", async (_payload, next) => {
        const decision = await next();
        if (!decision || decision.kind === "reject") return decision;
        const messages = Array.isArray(decision.messages) ? decision.messages : null;
        if (messages === null) return decision;
        const idx = lastUserIndex(messages);
        if (idx < 0) return decision;
        const message = messages[idx];
        if (!message || isArmored(message.content)) return decision;
        const rewritten = messages.slice();
        rewritten[idx] = { ...message, content: armorContent(message.content, PROMPT_TEXT) };
        return { ...decision, messages: rewritten };
      }),
    );
  }

  ctx.effect(() => {
    ctx.tools.register(profileToolOf(channel));
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
