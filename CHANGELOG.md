# 更新说明

## 0.9.2 — 回退 client.js 到 0.8.0 已知可用实现，恢复状态栏

0.9.1 声称修好了状态栏，但实际没恢复。根因：`client.js` 声明了 `inject = ["slots", "remote"]`，而客户端 runner 对声明了却取不到的服务会让插件停在 `waitingFor`（pending），永远不激活，slot 根本不注册。

修复：**client.js 逐字节回退到 0.8.0 的实现**（blob `2eac517`）——`inject = ["slots"]`，只注册纯徽章，不含开关按钮、`ctx.remote`、`useCallback`。blob hash 已核对一致。

代价：输入框状态栏上的 `关闭/打开`、`user|legacy|both` 按钮不再显示。运行时开关功能完全保留，改用：
- 斜杠命令 `/fujiang on|off [soft|hard|new]|mode user|legacy|both|status`
- 工具 `fujiang_switch`

徽章本身（绿色状态栏 + 拒答实时反馈）恢复。

## 0.9.1 — 修复 0.9.0 状态栏消失

- **根因**：0.9.0 的 `client.js` 在 `apply()` 里直接读 `ctx.remote.commands`，但插件的 client `inject` 只声明了 `slots`，没声明 `remote`。客户端 sandbox 的 guard 对未声明服务的访问会让 `apply()` 抛错，slot 注册失败，绿色状态栏整条消失。
- **修复**：client 的 `inject` 增加 `"remote"`；`remote` 用 `ctx.remote` + `ctx.get("remote")` 双路获取；`run()` 全程 try/catch；`useEffect` 不再依赖 `execute` 引用，避免每帧重发 `/fujiang status`。**徽章无条件注册**，开关不可用时只是没有按钮，不再拖垮状态栏。
- 已安装副本与源码仓库同步，重载后 `fujiang_profile` 正常返回 0.9.1。

## 0.9.0 — 运行时开关：总开关 + 模式切换

### 新增

- **总开关（全局）**：关掉后不再追加破甲内核；legacy / both 模式下 system 段同时摘除，立即生效。
- **模式切换（全局）**：`user` / `legacy` / `both` 三态。切换时即时挂载或摘除 system 段，不重载插件。
- **三个入口走同一套实现**（避免两份逻辑漂移）：
  - 输入框上方：`关闭/打开` 按钮 + `user|legacy|both` 三态按钮 + 关闭时的三选一弹窗；
  - 斜杠命令：`/fujiang on | off [soft|hard|new] | mode <user|legacy|both> | status`；
  - 工具：`fujiang_switch`（agent 可调用；`off hard` 需要会话上下文，工具路径会明确拒绝）。
- **关闭语义**（弹窗里逐条写明，点 ✕ / 不选按第 3 项）：
  1. **硬关 · 立即作废**：往当前会话追加一条「内核作废」提醒。模型按消息顺序读，之前那条内核立刻失效，当前会话干净。
  2. **软关 · 只管后续**：只停止后续注入。历史里那条内核仍在，模型照样能看到，直到压缩或开新会话。
  3. **开新会话 · 不写入**（默认）：什么都不写，只提示你开新会话才彻底干净。
- **状态落盘**：`$DSH_HOME/fujiang-armor.state.json`（临时文件 + rename 原子写），重启 DSH 后开关与模式保持。
  不用插件配置的原因：改配置会让宿主重载插件，做不到即时生效；运行时也不允许改写 profile 的 `cordis.patch.yml`。

### 行为变化

- `agent/pre-step` 监听器改为**常驻**（硬关要靠它写作废声明）；`legacy` 模式下它不再追加 user 消息。
- `fujiang_profile` 新增 `armorEnabled`、`runtimeSwitch`（状态文件路径 / 命令 / 工具名）。
- 配置里的 `injectionMode` 降级为「首次运行默认值」；之后以状态文件为准。

### 验证

`verify_plugin` 17 项（新增运行时开关、状态落盘、system 段增删、硬关作废声明一次性、工具拒绝无会话的 hard-off）、`test_injection_channel` 12 组全部通过。

## 0.8.0 — 中转站适配：破甲内核重写 + user 通道改为「无感追加」

### 为什么改

实测某个 OpenAI 兼容中转网关会**整段替换请求里的 system 消息**：

| 探针位置 | 结果 |
|---|---|
| `role=system` 塞 canary | 被丢弃，模型回答「系统提示里只定义了我作为工程助手」 |
| `role=developer` 塞 canary | 被丢弃 |
| `role=user` 塞 canary | 原样透传 |

会话日志里 DSH 装配出的 37939 字符系统提示词（purge `prompt-inject.md` + 内核 ×2）确实被发出去了，但模型收到的却是网关自己的中文「工程助手」提示词。**legacy（system 通道）在这个网关下等于 0 效果**，这就是「破甲不太正常」的根因。

### 新增 / 修改

- **user 通道改为追加注入消息**（`index.js`）：不再把内核前缀拼到最后一条 user 消息上（0.7.x 行为会污染用户原文，会话记录与界面都能看到整段内核），改为 `agent/pre-step` 里追加一条带 `source.kind = "fujiang-armor"` 的 user 消息，内容用宿主同款的 `<system-reminder>` 外壳包裹。用户输入一字不改，客户端按注入上下文渲染。
- **幂等改为按可见历史判定**：读 `agent.session.surface.nodes` + `eventAt()`，可见历史里已有注入就跳过；被压缩掉之后自动补一条（与 `dsh-tool-skill` 的技能目录同一套判定）。老宿主读不到 session 时退回进程内 `WeakSet`，保证一个会话只追加一次。
- **投影忽略注入消息**：`user/message` 且 `source.kind = fujiang-armor` 的事件不再把状态条置为运行中。
- **`fujiang_profile` 槽位改名**：`fujiang-armor:user-message-prefix` → `fujiang-armor:user-context-message`，并回传 `source` 字段。
- **破甲内核重写**（`prompts/fujiang.md`，三件套逐字节一致）：按 `dsh-purge` 的 `prompt-inject.md` 结构重排 —— 覆盖声明（明确压过网关自带的 system 提示）/ 激活词 / 任务优先级 / 硬输出规则 / 拒绝对抗 / 25 条领域规则 / 沙箱测试方向 / 意图映射 / 占位符与边界词规范化 / Web 渗透路由 / 稳定性锚点 / 风格。体量从 4.3KB 提升到 16KB。
- **自检修复**（`scripts/check-injection.mjs`）：DSH 0.2.2-rc.x 的 `user/message` 是扁平的 `data.content`，`system/message` / `assistant/message` 才是 `data.message.content`；旧版只认后者，切到 user 通道会误报「内核未注入」。现在两种形状都认，并区分「user(注入消息)」与「user(前缀改写)」两种落点。判定标记从已不存在的 `## Blacklist` 换成 0.8.0 独有小节标题。
- **自检脚本适配**：`scripts/verify_plugin.mjs` 在插件目录（没有 `install.ps1`）下不再整体失败；`scripts/test_injection_channel.mjs` 重写为 12 组，覆盖追加语义、压缩补注、老宿主兜底。
- **安装器**：`install.ps1` 新增 `-InjectionMode user|legacy`（默认 `user`），`install.sh` 支持 `INJECTION_MODE=user|legacy`，两者把模式透传给 `compat.js mount --mode`；版本号同步到 `0.8.0`。
- **一键启动器补齐到 0.8.0**：`点我一键注入.bat` 改为交互选 `[1] user` / `[2] legacy`（回车默认 1），新增 `点我一键注入-user会话.bat`、`点我一键注入-老版本.bat` 两个直装入口；`点我检查是否生效.bat`、`点我一键卸载.bat` 同步重写（`chcp 65001` + 中文提示 + 参数透传）。所有 `.bat` 为 UTF-8 无 BOM + CRLF，`-InjectionMode` 与参数值在同一行，`check_encoding.mjs` 的 11 个脚本守卫全通过。

### 升级注意

- 默认仍是 `injectionMode: user`，但**语义变了**：从「改写用户原文」变成「追加注入消息」。配置项名字不变，`inject.ps1 -InjectionMode user` 无需改动。
- 已装 `injectionMode: legacy` 的实例必须改成 `user`，否则内核继续被网关抹掉：`~/.dsh/profiles/<profile>/cordis.patch.yml` 托管块里那一行。
- 改完需要重启 DSH；重启后跑 `node scripts/check-injection.mjs --session <id>` 应看到 `通道：user(注入消息)`。

## 0.7.1 — 适配 DSH 0.2.2-rc.5

- **兼容性声明**：新增 `engines.dsh: ">=0.2.1 <0.3.0-0"`。rc.5 起宿主按 `engines.dsh` 单独判定插件兼容性（`semver.satisfies(version, range, { includePrerelease: true })`，见 `dsh-app-boot` 的 plugin-compatibility），声明后插件页/启动器给出确定结论，不再依赖「未声明 = 默认放行」。上界 `<0.3.0-0` 同时挡掉 `0.3.0` 的预发布版。
- **清单格式**：新增 `dsh.manifestVersion: 1`（rc.5 的包清单格式标识）。
- **实测（0.2.2-rc.5，隔离 DSH_HOME + 本地桩模型）**：
  - legacy 模式：system 段 11011 字符，`You are 年前` ×2 + 镜像段 ×2；
  - user 模式：system 段无内核，内核前置到最后一条 user 消息（×1，幂等）；
  - 工具 `fujiang_profile` 正常进入模型工具表；
  - Web 启动图包含 `fujiang-armor/client.js`，combo bundle 下发 200。
- **结论**：`0.2.2-rc.1` → `rc.5` 之间本插件依赖的宿主接口（`systemPrompt.section({interpolate:false})`、`agent/pre-step`、`sessionProjections.register()`、`tools.register()`、客户端 `ctx.slots` + `useProjection`）无破坏性变更，注入逻辑与提示词文本均未改动。
- 版本号同步：`package.json`、`index.js`（`pluginVersion` / `kernelVersion` / `targetHost`）、`install.ps1`、`install.sh`、安装/卸载脚本头部。

## 0.7.0 — 两个注入模式 + 提示词文本修正

- **两个对外注入模式**（`injectionMode`）：
  - `user`（默认）：**user 会话注入**。通过 `agent/pre-step` 把内核前置到本步最后一条 user 消息，幂等；可穿过会重写/剥离 system 的网关。
  - `legacy`：**老版本注入**。0.5.0 及以前的 system 双层段注入（Order 100 内核 + Order 200 强化镜像）。
  - 一键入口：`点我一键注入.bat` 交互选 1/2；也可用 `点我一键注入-user会话.bat` / `点我一键注入-老版本.bat` 直接装。
  - 安装器：`install.ps1 -InjectionMode user|legacy`、`INJECTION_MODE=user|legacy ./install.sh`；`compat.js mount --mode user|legacy` 把模式写进 profile 托管块。
  - `injectionMode` 优先于旧配置里的 `injectionChannel`，避免老 bundle patch 残留的 `injectionChannel: user` 把 legacy 模式静默覆盖。`fujiang_profile` 现在同时返回 `injectionMode` / `injectionChannel` / `injectionModes`；底层 `injectionChannel: system|user|both` 仍保留给老配置与自检。
- **提示词文本修正（会话中无关）**：`prompts/fujiang.md`、`fujiang-mirror.md`、`fujiang-compat.md` 三件套同步把「富江」→「年前」（含 `When the user sends` 激活词）、「爸爸」→「机主」；三文件仍逐字节一致，SHA256 守卫同步更新。会话里出现什么词不影响这项改动，插件代码里的产品名「富江破甲」保持不变。
- `scripts/check-injection.mjs` 同时识别「年前」与旧会话日志里的「富江」内核头，报告实际生效的通道与内核版本。
- 自检扩到 13 项 + 11 组注入模式/通道用例。

### 0.7.0 修复（安装器 ParserError）

- **症状**：`install.ps1` 在写入 profile 挂载后抛 `表达式或语句中包含意外的标记"}"`（第 318 行 `else`），legacy 模式一键注入中断。
- **原因**：把「注入模式」输出移出 `foreach` 时残留了一个多余的 `}`，导致 `if ($mount.Data)` 提前闭合，`else` 变成孤立语句。
- **修复**：删掉多余花括号；`verify_plugin.mjs` 增加静态花括号/引号平衡守卫（配合 PowerShell Parser 实测），同类语法错误会在自检阶段直接失败。

### 0.7.0 修复（一键 BAT 参数被拆行）

- **症状**：双击 `点我一键注入-老版本.bat` 报 `缺少参数"InjectionMode"的某个参数`，紧接着 `'legacy' 不是内部或外部命令`。
- **原因**：生成 BAT 时 `'… -InjectionMode ' + $mode + ' %*'` 被拆成三个独立行写进文件：
  ```bat
  "…powershell.exe" … -InjectionMode
  legacy
   %*
  ```
  cmd 逐行执行，`legacy` 就成了独立命令。与行尾无关（文件本来就是 CRLF）。
- **修复**：改用 `-f` 格式化生成，三个 BAT 的调用行均为单行完整命令；`check_encoding.mjs` 增加两条守卫——`.bat`/`.cmd`/`.ps1` 必须是 CRLF，且 BAT 里任何以 `-InjectionMode` 等参数名结尾的行直接判失败。
- **配套**：`.bat` / `.ps1` 现在按 CRLF 原样存进仓库（GitHub ZIP 下载不应用 `.gitattributes` 的 `eol` 转换，存 LF 会让解压后的批处理坏掉）。

## 0.6.1 — 修复中文 Windows 下安装器报「未终止的字符串」

- **症状**：`install.ps1` 在「写入 profile 挂载」处抛
  `ConvertFrom-Json : 传入了未终止的字符串`，安装中断（此时补丁已写入，但依赖与 `node_modules` 链接没做，插件加载不到）。
- **原因**：安装器直接捕获 node 子进程的 stdout 再解析 JSON。Windows PowerShell 按**控制台代码页**解码，
  中文系统是 GBK，node 输出的 UTF-8 中文被解坏，末尾引号会被吞掉，JSON 就此残缺。
- **修复**：
  - `compat.js` 新增 `--out <file>`：结果写成 UTF-8 文件，安装器用 UTF-8 读回，不再解析 stdout；
  - stdout 一律转义为纯 ASCII（`\uXXXX`），任何代码页下都不会被解坏；
  - 结果解析失败不再中断安装，挂载/依赖以退出码为准；
  - `isolate-instance.ps1` 的配置播种改为 `compat.js seed` 子命令直接写文件，不再经过 stdout。
- **另外**：`install.ps1` / `isolate-instance.ps1` 丢失 UTF-8 BOM 会让 PowerShell 5.1 按 ANSI 解析中文、
  直接语法错误；已恢复 BOM，并在 `verify_plugin.mjs` 增加两项自检（BOM 检查、stdout 必须纯 ASCII），
  自检总数 12 项。同时修好 0.6.0 遗留的测试桩（mock `ctx.on`、system 通道需显式指定）。
## 0.6.0 — 新增 user 通道注入（可穿过重写 system 的网关）

### 为什么改

systemPrompt 段只对「原样转发 system」的链路有效。一旦中间层重写 system（典型：OpenAI 兼容网关以
`prompt.mode=custom` 运行，会把 `messages` 里所有 `role=system/developer` 的消息整段删掉、换成它自己的
提示词），内核文本就到不了模型，破甲静默失效——请求仍然 200，所以很难察觉。

### 新增

- **`injectionChannel` 配置项**：`user`（默认）/ `system` / `both`。
  - `user`：通过 `agent/pre-step` 瀑布把内核**前置到本步最后一条 user 消息**。user 内容会被各类网关按原样
    转发，因此不受 system 重写影响。
  - `system`：0.5.0 及以前的行为（Order 100 内核 + Order 200 镜像）。
  - `both`：两路都注入。
- **幂等**：`agent/pre-step` 每个 step 都会跑，同一条 user 消息会反复出现在 `messages` 里。实现上用内核开头
  48 字符做哨兵，已注入过的消息直接跳过，不会逐 step 重复拼接。
- **块内容安全**：user 消息是 `string` 时前置为 `<内核>\n\n<原文>`；是内容块数组时在头部插入一个 text 块，
  图片等其它块原样保留。
- `fujiang_profile` 增加 `injectionChannel` 字段与 `fujiang-armor:user-message-prefix` 槽位；`scripts/check-injection.mjs`
  现在同时检查 system 与 user 两侧，并报告实际生效的通道。
- 新增 `scripts/test_injection_channel.mjs`（`npm run test:channel`）：8 组自检覆盖三条通道、幂等、块内容、
  拒绝步与无 user 消息的边界。

### 修复

- **`install.ps1` 丢失 UTF-8 BOM 会导致安装器直接解析失败。**
  PowerShell 5.1 读无 BOM 的 `.ps1` 时按 ANSI 解码：中文变乱码，多字节序列还会吃掉引号，于是报一串
  「表达式或语句中包含意外的标记」。已补回 BOM，并新增 `scripts/check_encoding.mjs`
  （`npm run test:encoding`）作守卫：`.ps1` 必须带 BOM、`.sh` 必须不带。

### 升级注意

- 默认通道变成 `user`。如果希望保持旧行为，在插件配置里显式写 `injectionChannel: system`。
- `cordis.patch.yml` 已显式写入 `injectionChannel: user`，重跑安装器即生效。

## 0.5.0 — 适配 DSH 0.2.2-rc.1

本版针对 DeepSeek Harness `0.2.2-rc.1` 的提示词注入机制变化做了适配。0.4.x 在 0.2.2 上会失效（严重时每次请求都失败），升级前请先读完本节。

### 修复（不修就会坏）

- **`{{cwd}}` persona 变量已不存在，会导致提示词组装直接抛错。**
  0.2.2 起宿主不再注册任何提示词变量，profile / home 里残留 `personaSuffix: Your working directory is {{cwd}}.` 会在**每次模型请求前**抛
  `unknown prompt variable "{{cwd}}"`，整轮对话不可用。
  0.5.0 的补丁不再写 `personaSuffix`，安装器还会自动清除历史遗留的 `{{cwd}}` 子句（inline 与块标量两种写法都处理）。
- **profile 补丁对 `config` 是整体替换，不是深合并。**
  旧安装器整段重写 `system-prompt` 行，会顺手丢掉用户自己配的字段。0.5.0 改为只定点插入 `includeHarnessIdentity: false`，其余字段原样保留。
- **旧版 `patcher.js` 的「Phase-1 提示词过滤」补丁在 0.2.x 上是无效写入。**
  宿主早已删除 `PERSONA_SECTION_NAMES` 过滤。现在只有检测到 0.1.6 / 0.1.7 宿主时才打该补丁，其余情况明确跳过，不再盲改宿主文件。

### 改进

- **改用 `interpolate: false` 原样注入提示词段。** 0.2.x 的 `systemPrompt.section()` 支持该字段，段文本直接进入系统提示词，不再需要把 `{{` 手工改写成 `{ {`；自定义提示词可以自由使用花括号。
- **会话投影适配新版注册语义。** `sessionProjections.register()` 现在返回「可调用 disposer + thenable」，用 `ctx.effect` 包裹两种语义都能正确释放；`stateVersion` 升到 4，`init` 记录 fork 继承切点并按 `inheritedEventCount` 跳过继承事件，无关事件返回同一 state 引用（宿主据此跳过下游工作）；新增 `wire.summary: false`（状态条只服务当前会话，不参与会话列表摘要）。
- **插件页展示元数据。** 新增 `locale/en.json`、`locale/zh.json`（`meta.title` / `meta.description`）与 `icon.svg`，并导出 `./locale/*.json`、`./icon`；`dsh.client.inject` 声明 `@deepseek-ai/dsh-client-ui-conversation` 以对齐槽位激活顺序。
- **安装器支持多实例与隔离运行。**
  - 新增 `-DshHome` / `-Profile` / `-AllProfiles`：只写指定的那一个数据目录，可把插件装进隔离实例。
  - 优先复用 DSH 自带 Node 24 / pnpm 11（`$DSH_HOME\dsh-runtimes`），没有才联网下载；`pnpm install` 失败不再中止安装。
  - 挂载/卸载用成对标记包裹的托管块，可反复执行且不误删用户其它行；`node_modules` 在 pnpm 同步后重建为指向插件目录的链接，改插件即刻生效。
- **新增 `scripts/isolate-instance.ps1`：一键为任意一份 DSH 程序目录建隔离实例。**
  同时设置独立的 `DSH_HOME` 与 Electron `--user-data-dir`（后者必需，否则第二个实例会被单实例锁吞掉）；可选 `-SeedFrom` 只读复制登录凭据与模型供应商配置；已初始化的 profile 不会被重复播种。启动器会清掉继承来的 `ELECTRON_RUN_AS_NODE`，避免被当成 node 解释。
- **新增 `scripts/check-injection.mjs` + `点我检查是否生效.bat`：验证注入是否真的生效。**
  直接读会话日志（`$DSH_HOME\sessions\...\session.v4.jsonl.zstd`，逐帧 zstd）里渲染后的系统提示词，比对内核文本，报告内核命中次数（`×2` = 双段）、`fujiang_profile` 工具是否注册、所用模型；支持 `--home` / `--session` / `--list` / `--json`。
- **自检扩到 10 项**：提示词字节一致、两段 `interpolate: false`、投影折叠语义、客户端状态条注册、补丁挂载/卸载幂等、`{{cwd}}` 清理、隔离配置播种等。

### 兼容性

| DSH 版本 | 状态 |
|---|---|
| 0.2.2 系列（含 `0.2.2-rc.1`） | 支持 |
| 0.2.1 系列（含 `0.2.1-rc.5`） | 支持 |
| 0.2.0 | 支持（无 `{{cwd}}` 相关问题，其余同上） |
| 0.1.x | 不推荐；如需使用请留在 0.4.x |

## 0.4.3

- 双层注入：Order 100 通用内核 + Order 200 强化镜像，两段载荷同源同构。
- 输入框上方「富江破甲已激活」实时状态条（开头窗口判拒 + 域命中标记）。
- `fujiang_profile` 工具返回内核版本与注入槽位元数据。
- 安装器：自动准备运行环境、自动探测 profile、修复 `pnpm-workspace.yaml` 重复键、备份 `package.json`。
