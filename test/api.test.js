'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, validatePayload } = require('../src/server');

let server;
let baseUrl;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

const VALID_BODY = {
  rows: 4,
  cols: 4,
  regions: [
    { r1: 0, c1: 0, r2: 3, c2: 3, count: 4 },
    { r1: 0, c1: 0, r2: 1, c2: 3, count: 2 },
    { r1: 0, c1: 0, r2: 3, c2: 1, count: 2 },
  ],
};

test('GET /api/health 返回 ok', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('GET / 返回页面 HTML', async () => {
  const res = await fetch(`${baseUrl}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /古建筑墙面饰砖空鼓联合反演/);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('GET /app.js 与 /style.css 可访问', async () => {
  for (const p of ['/app.js', '/style.css']) {
    const res = await fetch(`${baseUrl}${p}`);
    assert.equal(res.status, 200, p);
  }
});

test('POST /api/solve 合法请求：每次区域实际计数与记录精确相等', async () => {
  const res = await fetch(`${baseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(VALID_BODY),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.rows, 4);
  assert.equal(data.cols, 4);
  assert.equal(data.grid.length, 4);
  assert.equal(data.grid[0].length, 4);
  assert.equal(data.totalHollow, 4);
  assert.equal(data.regions.length, 3);
  for (const reg of data.regions) {
    assert.equal(reg.actual, reg.expected);
  }
  // 网格中的空鼓总数与 totalHollow 一致
  const flat = data.grid.flat();
  assert.equal(flat.reduce((a, b) => a + b, 0), data.totalHollow);
});

test('POST /api/solve 矛盾记录：返回 unsatisfiable 且不携带网格结论', async () => {
  const res = await fetch(`${baseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rows: 4,
      cols: 4,
      regions: [
        { r1: 0, c1: 0, r2: 0, c2: 0, count: 1 },
        { r1: 0, c1: 0, r2: 0, c2: 0, count: 0 },
        { r1: 0, c1: 0, r2: 3, c2: 3, count: 1 },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'unsatisfiable');
  assert.match(data.message, /无法满足全部记录/);
  assert.equal(data.grid, undefined);
});

test('合法但彼此矛盾的重叠饰砖记录（5x5 右下角计数 0/1/0）判为 unsatisfiable 而非输入错误', async () => {
  // 三条记录各自合法、允许重叠，但无法同时满足：右下角同一块砖
  // 不可能既完好（计数 0）又空鼓（计数 1）。
  const body = {
    rows: 5,
    cols: 5,
    regions: [
      { r1: 4, c1: 4, r2: 4, c2: 4, count: 0 },
      { r1: 4, c1: 4, r2: 4, c2: 4, count: 1 },
      { r1: 4, c1: 4, r2: 4, c2: 4, count: 0 },
    ],
  };
  const res = await fetch(`${baseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'unsatisfiable');
  assert.equal(data.grid, undefined);
});

test('并发矛盾求解不阻塞健康检查与无关请求', async () => {
  const body = {
    rows: 5,
    cols: 5,
    regions: [
      { r1: 4, c1: 4, r2: 4, c2: 4, count: 0 },
      { r1: 4, c1: 4, r2: 4, c2: 4, count: 1 },
      { r1: 4, c1: 4, r2: 4, c2: 4, count: 0 },
    ],
  };
  const t0 = Date.now();
  const postSolve = () => fetch(`${baseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // 并发提交 3 个求解请求。
  const solves = [0, 1, 2].map((i) => postSolve().then(async (res) => {
    const data = await res.json();
    return { i, status: res.status, body: data, ms: Date.now() - t0 };
  }));

  // 100ms 后发起健康检查，随后再发一个无关请求。
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await sleep(100);
  const healthStart = Date.now();
  const healthRes = await fetch(`${baseUrl}/api/health`);
  const healthLatency = Date.now() - healthStart;
  const healthBody = await healthRes.json();

  const unrelatedStart = Date.now();
  const pageRes = await fetch(`${baseUrl}/`);
  const unrelatedLatency = Date.now() - unrelatedStart;
  assert.equal(pageRes.status, 200);

  const results = await Promise.all(solves);
  for (const r of results) {
    assert.equal(r.status, 200, `求解 ${r.i} 应为 200`);
    assert.equal(r.body.status, 'unsatisfiable', `求解 ${r.i} 应判无解`);
  }
  assert.equal(healthRes.status, 200);
  assert.deepEqual(healthBody, { status: 'ok' });
  // 健康检查与无关请求的服务端等待均不得超过 1 秒。
  assert.ok(healthLatency < 1000, `健康检查耗时 ${healthLatency}ms`);
  assert.ok(unrelatedLatency < 1000, `无关请求耗时 ${unrelatedLatency}ms`);
});

test('POST /api/solve 非法输入被服务端拒绝（400）', async () => {
  const cases = [
    { ...VALID_BODY, rows: 6 },                       // 行数越界
    { ...VALID_BODY, cols: 3 },                       // 列数越界
    { ...VALID_BODY, rows: 4.5 },                     // 非整数
    { ...VALID_BODY, regions: VALID_BODY.regions.slice(0, 2) }, // 区域过少
    { ...VALID_BODY, regions: [...VALID_BODY.regions, ...Array(10).fill(VALID_BODY.regions[0])] }, // 区域过多
    { ...VALID_BODY, regions: [{ r1: 0, c1: 0, r2: 3, c2: 3, count: 17 }, ...VALID_BODY.regions.slice(1)] }, // 计数超面积
    { ...VALID_BODY, regions: [{ r1: 2, c1: 0, r2: 1, c2: 3, count: 0 }, ...VALID_BODY.regions.slice(1)] }, // 起止颠倒
    { ...VALID_BODY, regions: [{ r1: 0, c1: 0, r2: 3, c2: 4, count: 1 }, ...VALID_BODY.regions.slice(1)] }, // 越出网格
    { ...VALID_BODY, regions: [{ r1: 0, c1: 0, r2: 3, c2: 3, count: 1.5 }, ...VALID_BODY.regions.slice(1)] }, // 计数非整数
  ];
  for (const body of cases) {
    const res = await fetch(`${baseUrl}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body));
    const data = await res.json();
    assert.equal(data.error, 'invalid_input');
    assert.ok(data.message);
  }
});

test('POST /api/solve 非法 JSON 被拒绝', async () => {
  const res = await fetch(`${baseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_json');
});

test('静态资源 404 与路径穿越防护', async () => {
  const res404 = await fetch(`${baseUrl}/no-such-file`);
  assert.equal(res404.status, 404);
  const resTraversal = await fetch(`${baseUrl}/%2e%2e%2fpackage.json`);
  assert.ok([403, 404].includes(resTraversal.status));
});

test('validatePayload 单元校验', () => {
  assert.equal(validatePayload(VALID_BODY), null);
  assert.match(validatePayload({ ...VALID_BODY, rows: 2 }), /行数/);
  assert.match(validatePayload({ ...VALID_BODY, regions: [] }), /检测区域数量/);
  assert.match(validatePayload(null), /JSON 对象/);
  assert.match(validatePayload({ ...VALID_BODY, regions: [{ r1: 0, c1: 0, r2: 0, c2: 0, count: -1 }, ...VALID_BODY.regions.slice(1)] }), /空鼓数/);
});
