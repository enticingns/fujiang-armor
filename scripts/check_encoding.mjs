// 编码/行尾守卫
//
// 1) Windows PowerShell 5.1 读 .ps1 时按 ANSI 解码，无 BOM 的 UTF-8 中文会变乱码，
//    严重时多字节序列会吃掉引号导致整个脚本解析失败（0.6.0 首版就踩过）。
// 2) bash 相反：.sh 带 BOM 会让 shebang 失效。
// 3) .bat / .cmd 必须是 CRLF。cmd.exe 按 CRLF 切行，纯 LF 的批处理会把参数挤到下一行，
//    典型症状：`-InjectionMode legacy` 变成 `-InjectionMode` + 独立执行 `legacy`
//    （0.7.0 推送到 GitHub 时被 LF 规范化，ZIP 下载后一键注入直接报错）。
//
// 用法：node scripts/check_encoding.mjs
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(root).filter((f) => /\.(ps1|sh|bat|cmd)$/i.test(f));
const problems = [];

for (const file of files) {
  const bytes = readFileSync(file);
  const head = bytes.subarray(0, 3);
  const hasBom = head.equals(BOM);
  const rel = relative(root, file).replaceAll("\\", "/");

  if (/\.ps1$/i.test(file) && !hasBom) {
    problems.push(`${rel}: .ps1 缺少 UTF-8 BOM（PowerShell 5.1 会按 ANSI 解析，中文会炸）`);
  }
  if (/\.sh$/i.test(file) && hasBom) {
    problems.push(`${rel}: .sh 不应带 BOM（shebang 会失效）`);
  }
  if (/\.(bat|cmd|ps1)$/i.test(file)) {
    let crlf = 0;
    let lf = 0;
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === 10) {
        lf += 1;
        if (i > 0 && bytes[i - 1] === 13) crlf += 1;
      }
    }
    const bareLf = lf - crlf;
    if (bareLf > 0) {
      problems.push(`${rel}: 有 ${bareLf} 处裸 LF（Windows 脚本必须 CRLF，否则 cmd 会把参数挤到下一行）`);
    }
  }
  if (/\.bat$/i.test(file)) {
    // 0.7.0 踩过：生成脚本时把 `-InjectionMode legacy` 拆成三行，
    // 结果 cmd 把 `legacy` 当成独立命令执行（'legacy' 不是内部或外部命令）。
    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (/[-\/](InjectionMode|DshHome|Profile|AllProfiles)\s*$/.test(lines[i].trimEnd())) {
        problems.push(`${rel}: 第 ${i + 1} 行以参数名结尾（"${lines[i].trim()}"），参数值被拆到下一行`);
      }
    }
  }
}

if (problems.length) {
  for (const p of problems) console.error("FAIL:", p);
  process.exit(1);
}
console.log(`ok: ${files.length} 个脚本编码检查通过（.ps1 带 BOM + CRLF，.bat CRLF，.sh 无 BOM）`);
