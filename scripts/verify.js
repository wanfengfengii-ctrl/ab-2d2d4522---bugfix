'use strict';

/**
 * 验收编排：依次执行
 *   1. 代码测试（node --test）
 *   2. 构建检查（scripts/check.js）
 *   3. API / HTTP 冒烟（针对 APP_URL 指向的运行中服务）
 * 全部通过以退出码 0 结束，否则退出码 1。供 Compose 的 verify 服务使用。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function runStep(name, args) {
  console.log(`\n[verify] ${name}`);
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  record(name, res.status === 0, res.status === 0 ? '' : `退出码 ${res.status}`);
  return res.status === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForApp(attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${APP_URL}/api/health`);
      if (res.ok) return true;
    } catch { /* 尚未就绪 */ }
    await sleep(1000);
  }
  return false;
}

async function postJson(pathname, body) {
  return fetch(`${APP_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function smoke() {
  console.log(`\n[verify] API / HTTP 冒烟（目标 ${APP_URL}）`);
  if (!(await waitForApp())) {
    record('服务就绪等待', false, `${APP_URL}/api/health 在 30 秒内未就绪`);
    return;
  }
  record('服务就绪等待', true);

  // 健康检查
  try {
    const res = await fetch(`${APP_URL}/api/health`);
    const data = await res.json();
    record('健康检查 GET /api/health', res.status === 200 && data.status === 'ok');
  } catch (err) {
    record('健康检查 GET /api/health', false, err.message);
  }

  // 页面可达
  try {
    const res = await fetch(`${APP_URL}/`);
    const html = await res.text();
    record('页面 GET /', res.status === 200 && html.includes('空鼓'));
  } catch (err) {
    record('页面 GET /', false, err.message);
  }

  // 有唯一解的业务用例：行列条带约束 => 仅 (行1,列2) 与 (行1,列4) 空鼓
  const uniqueCase = {
    rows: 4,
    cols: 4,
    regions: [
      { r1: 0, c1: 0, r2: 0, c2: 3, count: 2 },
      { r1: 1, c1: 0, r2: 1, c2: 3, count: 0 },
      { r1: 2, c1: 0, r2: 2, c2: 3, count: 0 },
      { r1: 3, c1: 0, r2: 3, c2: 3, count: 0 },
      { r1: 0, c1: 0, r2: 3, c2: 0, count: 0 },
      { r1: 0, c1: 1, r2: 3, c2: 1, count: 1 },
      { r1: 0, c1: 2, r2: 3, c2: 2, count: 0 },
      { r1: 0, c1: 3, r2: 3, c2: 3, count: 1 },
    ],
  };
  try {
    const res = await postJson('/api/solve', uniqueCase);
    const data = await res.json();
    const flat = data.status === 'ok' ? data.grid.flat() : [];
    const expected = [0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const countsOk = data.status === 'ok'
      && data.regions.every((r) => r.actual === r.expected)
      && data.totalHollow === 2;
    record(
      '求解 POST /api/solve（唯一解用例）',
      res.status === 200 && countsOk && JSON.stringify(flat) === JSON.stringify(expected),
      res.status === 200 ? '' : `HTTP ${res.status}`,
    );
  } catch (err) {
    record('求解 POST /api/solve（唯一解用例）', false, err.message);
  }

  // 无解用例
  try {
    const res = await postJson('/api/solve', {
      rows: 4,
      cols: 4,
      regions: [
        { r1: 0, c1: 0, r2: 0, c2: 0, count: 1 },
        { r1: 0, c1: 0, r2: 0, c2: 0, count: 0 },
        { r1: 0, c1: 0, r2: 3, c2: 3, count: 1 },
      ],
    });
    const data = await res.json();
    record(
      '无解识别 POST /api/solve',
      res.status === 200 && data.status === 'unsatisfiable' && !data.grid,
    );
  } catch (err) {
    record('无解识别 POST /api/solve', false, err.message);
  }

  // 合法但彼此矛盾的重叠饰砖记录（5x5 右下角同一块砖计数 0/1/0）：
  // 单条均合法、允许重叠，但无法共同满足，须作为合法求解返回 unsatisfiable。
  const overlapCase = {
    rows: 5,
    cols: 5,
    regions: [
      { r1: 4, c1: 4, r2: 4, c2: 4, count: 0 },
      { r1: 4, c1: 4, r2: 4, c2: 4, count: 1 },
      { r1: 4, c1: 4, r2: 4, c2: 4, count: 0 },
    ],
  };
  try {
    const res = await postJson('/api/solve', overlapCase);
    const data = await res.json();
    record(
      '重叠矛盾记录返回 unsatisfiable（非输入错误）',
      res.status === 200 && data.status === 'unsatisfiable' && !data.grid,
      res.status === 200 ? '' : `HTTP ${res.status}`,
    );
  } catch (err) {
    record('重叠矛盾记录返回 unsatisfiable（非输入错误）', false, err.message);
  }

  // 并发 3 个矛盾求解，100ms 后发起健康检查：求解都应及时判无解，
  // 健康检查的服务端等待不得超过 1 秒。
  try {
    const start = Date.now();
    const solves = [0, 1, 2].map(() => postJson('/api/solve', overlapCase).then(async (res) => {
      const data = await res.json();
      return res.status === 200 && data.status === 'unsatisfiable';
    }));
    await sleep(100);
    const healthBegin = Date.now();
    const healthRes = await fetch(`${APP_URL}/api/health`);
    const healthBody = await healthRes.json();
    const healthWait = Date.now() - healthBegin;
    const solveResults = await Promise.all(solves);
    const allUnsat = solveResults.every(Boolean);
    const totalMs = Date.now() - start;
    record(
      '并发矛盾求解不阻塞健康检查',
      healthRes.ok && healthBody.status === 'ok'
        && allUnsat && healthWait < 1000 && totalMs < 5000,
      `health 等待 ${healthWait}ms，3 个求解均无解=${allUnsat}，总耗时 ${totalMs}ms`,
    );
  } catch (err) {
    record('并发矛盾求解不阻塞健康检查', false, err.message);
  }

  // 非法输入拒绝
  try {
    const res = await postJson('/api/solve', { rows: 9, cols: 4, regions: [] });
    const data = await res.json();
    record('非法输入拒绝 POST /api/solve', res.status === 400 && data.error === 'invalid_input');
  } catch (err) {
    record('非法输入拒绝 POST /api/solve', false, err.message);
  }
}

async function main() {
  console.log('[verify] 开始验收');
  runStep('代码测试（node --test）', ['--test']);
  runStep('构建检查（scripts/check.js）', ['scripts/check.js']);
  await smoke();

  const failed = results.filter((r) => !r.ok);
  console.log('\n[verify] 验收汇总');
  for (const r of results) {
    console.log(`  ${r.ok ? '✔' : '✘'} ${r.name}`);
  }
  if (failed.length > 0) {
    console.error(`\n[verify] 验收未通过：${failed.length} 项失败`);
    process.exit(1);
  }
  console.log('\n[verify] 验收全部通过');
  process.exit(0);
}

main().catch((err) => {
  console.error(`[verify] 验收过程异常: ${err.stack || err}`);
  process.exit(1);
});
