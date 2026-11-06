# 更新说明

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
