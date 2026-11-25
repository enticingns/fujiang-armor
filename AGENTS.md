# AGENTS.md — 富江破甲仓库协作规则

## 隐私检查（硬性流程）

本仓库是有公开远程的插件项目。**任何 commit / push / tag / Release 前必须做隐私检查**：

1. 已安装本机 git hooks 自动执行：
   - `pre-commit`：扫 HEAD 全树 + 最近提交信息
   - `commit-msg`：扫本次提交信息
   - `pre-push`：扫待推送 SHA 的整棵树
   扫描器在 `~/.dsh/privacy-guard.ps1`（本机私有，模式清单不进仓库）。
2. 命中即停止操作，修掉再重试。绝不用"应该没事"跳过 hook。
3. 手工场景同样要查：
   - 从 `~/.dsh/plugins/fujiang-armor`（安装副本）往本仓库复制文件后 —— **这是历史事故的高风险动作，复制后必须重扫**
   - `git archive` 生成 ZIP 后，逐个 entry 扫字节再上传
   - Release 正文也要扫
4. 扫描规则覆盖：中转网关域名、provider/模型别名、真 key 形态（`sk-` + 12 位以上）、本机路径、会话 id。具体敏感值记在本机私有记忆库 `~/.dsh/AGENTS.md`，**不要写进本仓库任何文件**。
5. 扫描时不要把命中的真实内容打印出来，只报告模式名 + 文件:行号。

## 其他约定

- 版本号同步：`package.json`、`index.js` 的 `pluginVersion`/`kernelVersion`、`README.md`、`CHANGELOG.md`。
- 提示词三件套 `prompts/fujiang.md` / `fujiang-mirror.md` / `fujiang-compat.md` 必须逐字节一致，改一处要同步三处并更新 `verify_plugin.mjs` 的 SHA256。
- `.ps1` 必须 UTF-8 BOM + CRLF，`.bat` CRLF，`.sh` 无 BOM + LF；改完跑 `node scripts/check_encoding.mjs`。
- 自检：`node scripts/verify_plugin.mjs`、`node scripts/test_injection_channel.mjs` 都要过。
- 运行时开关状态在 `$DSH_HOME/fujiang-armor.state.json`，不进仓库。
