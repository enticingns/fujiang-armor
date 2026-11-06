#!/usr/bin/env bash
# 富江破甲卸载脚本（DSH 0.2.x / 0.2.2-rc.1 适配版）
#
# 用法：
#   ./uninstall.sh                                  # 卸载 $DSH_HOME 或 ~/.dsh 里的插件
#   DSH_HOME=/path/to/isolated ./uninstall.sh       # 只卸载隔离实例
set -euo pipefail

PLUGIN_NAME="fujiang-armor"
PLUGIN_LABEL="富江破甲"
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
PLUGINS_DIR="$DSH_ROOT/plugins"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPAT="$SRC_DIR/scripts/lib/compat.js"

step() { printf "\n==> %s\n" "$1"; }
ok()   { printf "    [OK] %s\n" "$1"; }
warn() { printf "    [!] %s\n" "$1"; }
err()  { printf "    [X] %s\n" "$1" >&2; }

step "查找 profile 配置"
[[ -d "$DSH_ROOT/profiles" ]] || { err "未找到 DSH 数据目录：$DSH_ROOT"; exit 1; }
ok "数据目录：$DSH_ROOT"

PROFILE_DIRS=()
for d in "$DSH_ROOT"/profiles/*/; do
  d="${d%/}"
  [[ "$(basename "$d")" == "node_modules" ]] && continue
  [[ -f "$d/package.json" ]] && PROFILE_DIRS+=("$d")
done
if [[ ${#PROFILE_DIRS[@]} -eq 0 ]]; then err "没有可处理的 profile"; exit 1; fi
for p in "${PROFILE_DIRS[@]}"; do ok "profile：$p"; done

if command -v node >/dev/null 2>&1 && [[ -f "$COMPAT" ]]; then
  step "移除 profile 挂载"
  node "$COMPAT" unmount "$DSH_ROOT" "${PROFILE_DIRS[@]}" >/dev/null
  node "$COMPAT" unlink "$DSH_ROOT" "${PROFILE_DIRS[@]}" >/dev/null
  ok "已移除 cordis.patch.yml 托管块、dependencies 与 bundles 记录"
else
  warn "缺少 node 或 compat.js，跳过挂载清理；请手动删除 cordis.patch.yml 中的 fujiang-armor 块"
fi

step "清理 node_modules 链接"
for p in "${PROFILE_DIRS[@]}"; do
  rm -rf "$p/node_modules/$PLUGIN_NAME" 2>/dev/null || true
  ok "[$(basename "$p")] 已清理 node_modules/$PLUGIN_NAME"
  if command -v pnpm >/dev/null 2>&1; then
    ( cd "$p" && pnpm install >/dev/null 2>&1 || true )
  fi
done

step "删除插件目录"
if [[ -d "$PLUGINS_DIR/$PLUGIN_NAME" ]]; then
  rm -rf "$PLUGINS_DIR/$PLUGIN_NAME"
  ok "已删除：$PLUGINS_DIR/$PLUGIN_NAME"
else
  ok "插件目录不存在，无需删除"
fi

step "卸载完成"
printf "\n  %s 已从 %s 卸载，请重启该 DSH 实例。\n" "$PLUGIN_LABEL" "$DSH_ROOT"
printf "  注意：profile 补丁里其它插件（如 dsh-purge）不受影响。\n"
