'use strict';

/**
 * 构建检查：对项目全部 JS 源码做语法检查（node --check），
 * 校验 JSON 文件可解析，并确认运行所需文件齐备。
 * 任一失败以非零退出码结束。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function pass(msg) { console.log(`  PASS  ${msg}`); }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures += 1; }

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

console.log('[check] JS 语法检查');
const jsFiles = walk(ROOT).filter((f) => f.endsWith('.js'));
if (jsFiles.length === 0) fail('未找到任何 JS 文件');
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    pass(path.relative(ROOT, file));
  } catch (err) {
    fail(`${path.relative(ROOT, file)}: ${err.stderr || err.message}`);
  }
}

console.log('[check] JSON 文件解析');
for (const file of walk(ROOT).filter((f) => f.endsWith('.json'))) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    pass(path.relative(ROOT, file));
  } catch (err) {
    fail(`${path.relative(ROOT, file)}: ${err.message}`);
  }
}

console.log('[check] 必备文件齐备');
const required = [
  'package.json',
  'src/server.js',
  'src/solver.js',
  'public/index.html',
  'public/app.js',
  'public/style.css',
  'Dockerfile',
  'docker-compose.yml',
];
for (const rel of required) {
  if (fs.existsSync(path.join(ROOT, rel))) pass(rel);
  else fail(`缺少 ${rel}`);
}

if (failures > 0) {
  console.error(`[check] 构建检查失败（${failures} 项）`);
  process.exit(1);
}
console.log('[check] 构建检查全部通过');
