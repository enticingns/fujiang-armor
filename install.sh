#!/usr/bin/env bash
# 富江破甲安装脚本（DSH 0.2.x / 0.2.2-rc.1 适配版）
#
# 用法：
#   ./install.sh                                        # 安装到 $DSH_HOME 或 ~/.dsh
#   DSH_HOME=/path/to/isolated ./install.sh             # 安装到隔离实例
#   DSH_PROFILE=desktop ./install.sh                    # 只装指定 profile
set -euo pipefail

PLUGIN_NAME="fujiang-armor"
PLUGIN_LABEL="富江破甲"
PLUGIN_VERSION="0.6.0"
DSH_ROOT="${DSH_HOME:-$HOME/.dsh}"
PLUGINS_DIR="$DSH_ROOT/plugins"
DEST_DIR="$PLUGINS_DIR/$PLUGIN_NAME"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf "\n==> %s\n" "$1"; }
ok()   { printf "    [OK] %s\n" "$1"; }
warn() { printf "    [!] %s\n" "$1"; }
err()  { printf "    [X] %s\n" "$1" >&2; }

command -v node >/dev/null 2>&1 || { err "未检测到 node，请先安装 Node.js 22+"; exit 1; }
COMPAT="$SRC_DIR/scripts/lib/compat.js"
[[ -f "$COMPAT" ]] || { err "安装包缺少 scripts/lib/compat.js，请完整解压后重试"; exit 1; }

# ---------- 探测 profile 目录 ----------
find_profile_dirs() {
  local profiles_root="$1"

  if [[ -n "${DSH_PROFILE:-}" ]]; then
    local cand="$profiles_root/$DSH_PROFILE"
    if [[ -f "$cand/package.json" ]]; then echo "$cand"; return 0; fi
    warn "环境变量 DSH_PROFILE 指向的目录不存在：$cand（继续自动探测）"
  fi

  local found=()
  for name in desktop web default tui; do
    local cand="$profiles_root/$name"
    if [[ -f "$cand/package.json" ]]; then found+=("$cand"); fi
  done
  if [[ ${#found[@]} -gt 0 ]]; then printf '%s\n' "${found[@]}"; return 0; fi

  local dirs=()
  for d in "$profiles_root"/*/; do
    [[ -d "$d" && -f "$d/package.json" ]] && dirs+=("${d%/}")
  done
  if [[ ${#dirs[@]} -eq 1 ]]; then echo "${dirs[0]}"; return 0; fi
  if [[ ${#dirs[@]} -gt 1 ]]; then
    echo "检测到多个 DSH profile，请选择要安装的目标：" >&2
    for i in "${!dirs[@]}"; do printf "  [%d] %s\n" "$((i+1))" "${dirs[$i]}" >&2; done
    read -rp "请输入序号: " sel
    local idx=$((sel-1))
    if (( idx >= 0 && idx < ${#dirs[@]} )); then echo "${dirs[$idx]}"; return 0; fi
    err "选择无效，退出。"
    exit 1
  fi
  return 1
}

step "检查环境"
printf "\n====================\n  %s v%s 一键安装\n====================\n" "$PLUGIN_LABEL" "$PLUGIN_VERSION"
[[ -d "$DSH_ROOT" ]] || { err "未找到 DSH 目录：$DSH_ROOT"; exit 1; }
ok "数据目录：$DSH_ROOT"

mapfile -t PROFILE_DIRS < <(find_profile_dirs "$DSH_ROOT/profiles") || {
  err "未找到 DSH profile 目录（$DSH_ROOT/profiles 下没有含 package.json 的目录）。"
  echo "可通过 DSH_PROFILE=desktop 指定，或先启动一次 DSH 生成 profile。"
  exit 1
}
for p in "${PROFILE_DIRS[@]}"; do ok "DSH profile 目录：$p"; done

# ---------- 版本探测 ----------
step "探测 DSH 版本"
DSH_VERSION="$(node "$COMPAT" check "$DSH_ROOT" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version||"")}catch{console.log("")}})' || true)"
if [[ -n "$DSH_VERSION" ]]; then ok "DSH 版本：$DSH_VERSION"; else warn "无法确定 DSH 版本，按最新版规则安装"; fi

# ---------- 复制插件 ----------
step "复制插件文件"
mkdir -p "$PLUGINS_DIR"
if [[ -d "$DEST_DIR" ]]; then
  warn "检测到已存在的 $PLUGIN_NAME 目录，自动覆盖更新"
  rm -rf "$DEST_DIR"
fi
mkdir -p "$DEST_DIR"
cp -R "$SRC_DIR"/. "$DEST_DIR"/
rm -rf "$DEST_DIR/.git" "$DEST_DIR/install.sh" "$DEST_DIR/uninstall.sh" \
       "$DEST_DIR/install.ps1" "$DEST_DIR/uninstall.ps1" 2>/dev/null || true
ok "插件已复制到：$DEST_DIR"

# ---------- 挂载 ----------
step "写入 profile 挂载"
MOUNT_ARGS=("mount" "$DSH_ROOT" "${PROFILE_DIRS[@]}")
node "$COMPAT" "${MOUNT_ARGS[@]}" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const r=JSON.parse(s);
    for(const p of r.profiles||[]){
      const name=p.profileDir.split(/[\\/]/).pop();
      if((p.cwdRemoved||[]).length) console.log("    [OK] ["+name+"] 已清除失效的 {{cwd}} persona 子句（0.2.2 起会导致提示词组装失败）");
      console.log("    [OK] ["+name+"] cordis.patch.yml "+(p.changed?"已更新（"+p.actions.join(", ")+"）":"已是最新"));
    }
    for(const w of r.warnings||[]) console.log("    [!] "+w);
    if(r.homePatch) console.log("    [OK] 已修复 home 级补丁中的 {{cwd}}："+r.homePatch.file);
  }catch(e){console.log("    [!] 挂载输出解析失败");}
})'

step "写入依赖声明"
node "$COMPAT" link "$DSH_ROOT" "file:../../plugins/$PLUGIN_NAME" "${PROFILE_DIRS[@]}" >/dev/null
ok "dependencies 已写入 $PLUGIN_NAME"

# ---------- node_modules 链接与依赖安装 ----------
step "同步 node_modules"
for p in "${PROFILE_DIRS[@]}"; do
  mkdir -p "$p/node_modules"
  rm -rf "$p/node_modules/$PLUGIN_NAME"
  ln -sfn "$DEST_DIR" "$p/node_modules/$PLUGIN_NAME"
  ok "[$(basename "$p")] 符号链接已就绪"

  if command -v pnpm >/dev/null 2>&1; then
    if ( cd "$p" && pnpm install >/dev/null 2>&1 ); then
      ok "[$(basename "$p")] 依赖安装完成"
    else
      warn "[$(basename "$p")] pnpm install 未完成，插件仍会通过符号链接加载"
    fi
  else
    warn "[$(basename "$p")] 未检测到 pnpm，跳过依赖安装（符号链接已足够加载插件）"
  fi
done

# ---------- 完成 ----------
step "安装完成"
cat <<EOF

  $PLUGIN_LABEL v$PLUGIN_VERSION 已安装！
  数据目录：$DSH_ROOT
  目标 profile：$(printf '%s ' "${PROFILE_DIRS[@]}" | sed 's/ *$//')
  最后一步：重启该 DSH 实例，新建会话即可生效。
  验证方法：输入框上方应显示绿色状态条「富江破甲已激活」。
  卸载方法：运行 ./uninstall.sh（同样支持 DSH_HOME 指定隔离实例）。
EOF
