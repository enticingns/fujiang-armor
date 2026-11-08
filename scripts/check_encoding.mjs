// 编码守卫：Windows PowerShell 5.1 读 .ps1 时按 ANSI 解码，无 BOM 的 UTF-8 中文会变乱码，
// 严重时多字节序列会吃掉引号导致整个脚本解析失败（0.6.0 首版就踩过：install.ps1 丢了 BOM，
// 安装器直接抛一堆 "意外的标记"）。bash 则相反：.sh 带 BOM 会让 shebang 失效。
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

const files = walk(root).filter((f) => /\.(ps1|sh)$/i.test(f));
const problems = [];

for (const file of files) {
  const head = readFileSync(file).subarray(0, 3);
  const hasBom = head.equals(BOM);
  const rel = relative(root, file).replaceAll("\\", "/");
  if (/\.ps1$/i.test(file) && !hasBom) {
    problems.push(`${rel}: .ps1 缺少 UTF-8 BOM（PowerShell 5.1 会按 ANSI 解析，中文会炸）`);
  }
  if (/\.sh$/i.test(file) && hasBom) {
    problems.push(`${rel}: .sh 不应带 BOM（shebang 会失效）`);
  }
}

if (problems.length) {
  for (const p of problems) console.error("FAIL:", p);
  process.exit(1);
}
console.log(`ok: ${files.length} 个脚本编码检查通过（.ps1 带 BOM，.sh 无 BOM）`);
