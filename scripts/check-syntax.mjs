// 语法检查：只检查**可执行**的文件。
// bridge/ 与 mcp/、console/ 下是"按函数边界抽取的参考片段"（没有完整的函数包裹），
// 本来就不是独立可解析的模块，所以不在这里检查——它们靠人工按文档搬运。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'bridge']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    if (/\.(mjs|cjs)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(path.join(ROOT, 'packages')).concat(walk(path.join(ROOT, 'plugins')));
let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed += 1;
    console.error(`FAIL ${path.relative(ROOT, file)}`);
    console.error((res.stderr || '').trim());
  }
}
console.log(`checked ${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
