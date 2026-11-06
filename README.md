# 富江DSH完美破甲

富江破甲是一个用于 DSH 的本地插件，内置提示词规则，提供 Windows 一键注入和一键卸载。插件加载后，会在对话输入框上方显示「富江破甲已激活」。

当前版本：`0.5.0`。插件标识：`fujiang-armor`。适配 DSH `0.2.1` / `0.2.2` 系列（含 `0.2.2-rc.1`）。

## 0.5.0 做了什么（针对 DSH 0.2.2-rc.1）

DSH 0.2.2-rc.1 改了三处与提示词注入相关的行为，0.4.x 插件会因此失效，本版逐一适配：

| 变化 | 0.4.x 的做法 | 0.5.0 的做法 |
| --- | --- | --- |
| 提示词段支持 `interpolate: false`，段文本原样进入系统提示词 | 手工把 `{{` 改写成 `{ {` 规避插值报错 | 段注册时声明 `interpolate: false`，提示词可自由使用花括号，不再改写原文 |
| 宿主不再注册 `{{cwd}}` 变量，任何含 `{{cwd}}` 的 persona 模板都会让提示词组装**直接抛错** | profile 补丁写入 `personaSuffix: Your working directory is {{cwd}}.` | 补丁不再写 `personaSuffix`；安装器还会自动清除 home / profile 里历史遗留的 `{{cwd}}` 子句 |
| profile 补丁对已有行的 `config` 是**整体替换**，不是深合并 | 整段重写 `system-prompt` 行 | 只定点插入 `includeHarnessIdentity: false`，保留用户其它字段 |
| `sessionProjections.register()` 改为返回「可调用 disposer + thenable」 | 依赖旧 Promise 语义 | 用 `ctx.effect` 包裹，两种语义都能正确释放；新增 `wire.summary: false`、按 `inheritedEventCount` 跳过 fork 继承事件 |
| 插件页读取 `locale/*.json` 的 `meta.title` / `meta.description` 与 `./icon` | 未提供 | 新增 `locale/en.json`、`locale/zh.json`、`icon.svg`，插件页显示正常标题与图标 |
| 0.1.6 / 0.1.7 的 `PERSONA_SECTION_NAMES` 提示词过滤 | 改写宿主 `dsh-agent-instructions/lib/index.js` | 0.2.x 已无该过滤；仅在检测到旧宿主时才打补丁，其余情况明确跳过，不再盲改宿主文件 |

注入方式本身没有变：仍然是 `ctx.systemPrompt.section()` 注册有序提示词段（Order 100 内核 + Order 200 镜像），profile 用一条 `insert` 行挂载插件、并把 `system-prompt` 行的 `includeHarnessIdentity` 关掉，去掉「You are a helpful AI assistant.」这句第一方开场白。

## 功能

- 随插件部署内置规则，无需手动复制提示词。
- 双击批处理文件完成注入或卸载。
- 自动检测运行环境；桌面版自带 Node / pnpm 时直接复用，无需联网下载。
- 支持选择本地 DSH 配置目录中的目标配置，也支持指定任意 `DSH_HOME`（隔离实例）。
- 在对话输入框上方显示插件激活状态。

## 安装前准备

- 使用 Windows，安装 DSH，并至少启动过一次，使其生成 `%USERPROFILE%\.dsh` 本地配置目录。
- 首次安装可能需要联网（仅当本机没有可复用的 Node.js 时）。已有可用的 Node.js 22 或更新版本时直接复用；桌面版还会优先复用 `$DSH_HOME\dsh-runtimes` 里自带的 Node 与 pnpm。
- 完全退出 DSH 后再执行安装，避免正在运行的程序继续使用旧插件。

## 一键安装

1. 从本项目的发布页面下载 ZIP 安装包。也可以通过仓库页面的「Code → Download ZIP」下载源码。
2. 完整解压 ZIP，打开包含 `点我一键注入.bat` 的项目文件夹。
3. 完全退出 DSH。
4. 双击 `点我一键注入.bat`。
5. 如果检测到多个 DSH 配置，按安装器提示选择需要使用的目标配置。
6. 等待安装完成，然后重新启动 DSH。
7. 打开对话，确认输入框上方显示「富江破甲已激活」。在聊天中输入激活词「富江」即可使用内置规则。

安装后的插件目录为 `$DSH_HOME\plugins\fujiang-armor`（默认 `%USERPROFILE%\.dsh\plugins\fujiang-armor`）。请保留解压后的完整项目文件夹，卸载时仍需使用其中的脚本。

安装器只为当前执行过程设置运行环境，不改系统 PATH；DSH 本体仍需先安装并启动一次。

## 隔离运行第二个 DSH 实例（例如 rc 版本）

同时装了两份 DSH（比如稳定版 `D:\dsh` 与 `D:\dsh-rc`）时，**不要让它们共用同一个 `DSH_HOME`**：两个进程会抢同一个 profile 锁，插件安装也会互相覆盖。

用 `scripts\isolate-instance.ps1` 为任意一份 DSH 建一套独立数据目录：

```powershell
# 1) 建隔离数据目录 + 启动器（-SeedFrom 可选：复制登录凭据与模型配置，只读源目录）
powershell -ExecutionPolicy Bypass -File scripts\isolate-instance.ps1 `
    -AppDir "D:\dsh-rc" -SeedFrom "$env:USERPROFILE\.dsh"

# 2) 启动一次生成的「启动隔离实例.bat」，让它初始化 profile 与运行环境

# 3) 把插件装进隔离实例
powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome "D:\dsh-rc\.dsh-home"

# 4) 再次双击「启动隔离实例.bat」，新建会话验证状态条
```

生成的启动器会同时设置两个隔离变量：

- `DSH_HOME=<AppDir>\.dsh-home` —— 会话、profile、凭据、插件全部独立；
- `--user-data-dir=<AppDir>\.dsh-userdata` —— Electron 的窗口/设置/单实例锁独立，两个实例才能同时运行。

隔离实例不会读写默认 `%USERPROFILE%\.dsh`；安装器的 `-DshHome` 参数也只会写指定的那一个目录。

## 一键卸载

1. 完全退出 DSH。
2. 在完整解压的项目文件夹中，双击 `点我一键卸载.bat`。
3. 如果出现配置选择提示，选择此前安装的目标配置。
4. 等待卸载完成，然后重新启动 DSH。

卸载隔离实例：`powershell -ExecutionPolicy Bypass -File uninstall.ps1 -DshHome "<隔离目录>"`。

## 如何验证是否生效

按「越靠后越硬」的三层验证，任一层的结论都独立成立：

**第 1 层：看得见（客户端）**

输入框上方出现绿色「富江破甲已激活」状态条；发一条消息后它会短暂变成「✓ 通过 · 域 / ✗ 拒绝词」，说明会话投影在工作。

**第 2 层：调得动（工具）**

在对话里说一句「调用 fujiang_profile 工具」，模型能返回 `pluginVersion` / `injection` 元数据，说明宿主侧插件已激活、工具已注册。

**第 3 层：读得到（硬证据）**

DSH 会把每个模型步骤渲染后的系统提示词原样写进会话日志（`$DSH_HOME\sessions\...\session.v4.jsonl.zstd`）。直接读日志比对内核文本，不依赖模型自述：

```powershell
# 检查默认实例（或先设置 DSH_HOME）
node scripts\check-injection.mjs

# 检查隔离实例
node scripts\check-injection.mjs --home "D:\dsh-rc\.dsh-home"

# 列出所有会话的命中情况
node scripts\check-injection.mjs --list
```

也可以直接双击 `点我检查是否生效.bat`（检查默认实例），或把隔离实例的数据目录拖到该 BAT 上。

判定标准（脚本会自动打印）：

- `[OK] 内核已注入：You are 富江×2` —— 双段注入（Order 100 + Order 200）各一份，正常；
- `[OK] 工具 fujiang_profile 已注册` —— 宿主插件激活成功；
- `结论：富江破甲已生效` 且退出码为 `0`。

## 常见问题

| 问题 | 处理方法 |
| --- | --- |
| 找不到 DSH 配置或目标配置 | 先安装并启动一次 DSH，确认 `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`）已生成，再运行安装器。 |
| 提示「prompt variable "{{cwd}}" ...」或模型请求直接失败 | 旧版补丁在 0.2.2 起会触发该错误。重新运行 0.5.0 安装器即可自动清除 `{{cwd}}` persona 子句。 |
| 自动下载运行环境失败 | 确认网络可以访问 `nodejs.org` 和 npm 软件包源，再重新运行安装器；桌面版一般无需下载。 |
| 运行环境校验失败 | 安装器不会使用校验失败的下载包，请检查网络后重试。 |
| 找不到脚本、规则或其他文件 | 完整解压压缩包，保留 `prompts`、`scripts` 等子目录；不要只复制单个 BAT 文件。 |
| 安装成功但没有显示激活状态 | 完全退出并重新启动 DSH，确认安装时选中了当前使用的配置（多实例时确认 `-DshHome` 指向正确）。 |
| 依赖下载失败 | 检查网络连接；`node_modules` 链接已足够加载插件，可稍后手动在 profile 目录执行 `pnpm install`。 |
| 卸载后仍显示激活状态 | 完全退出并重新启动 DSH，确认卸载的是此前安装的配置。 |
| 两个 DSH 实例互相干扰 | 用 `scripts\isolate-instance.ps1` 给其中一份建独立 `DSH_HOME` 与 `--user-data-dir`。 |

「富江破甲已激活」表示插件已加载。实际回复仍受所选模型、其他提示词及 DSH 版本影响，本项目不保证所有模型都产生相同结果。

## DSH 无限重启

已核对 [dsh-purge 官方发布页](https://github.com/YuJunZhiXue/dsh-purge/releases)：1.1.52 在已应用补丁戳缺少 `sha` 时会把状态判为未对齐，并在启动时重打补丁、请求重启；上游从 1.1.53 起加入了空戳修复。若你使用 `dsh-purge` 1.1.52 并遇到反复重启，优先按其官方说明升级到 1.1.53 或更新版本，再重新启动 DSH。不要把空 `sha` 直接填成任意值；版本戳不匹配或宿主补丁未实际写入时，手动补戳可能掩盖故障。

本插件没有重启 DSH 的代码。兼容性补丁只在安装过程中应用；启动插件不会再重复写入宿主或 profile 文件。

## 自检

```powershell
node scripts\verify_plugin.mjs   # 或 npm run verify
```

覆盖：提示词字节一致、两段注册为 `interpolate: false`、投影折叠语义、客户端状态条注册、补丁挂载/卸载幂等、`{{cwd}}` 清理、隔离配置播种。
