'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { countInRegion } = require('./solver');
const { SolverPool } = require('./solver-pool');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MIN_DIM = 4;
const MAX_DIM = 5;
const MIN_REGIONS = 3;
const MAX_REGIONS = 12;
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 校验求解请求体。返回 null 表示合法，否则返回中文错误信息。
 */
function validatePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return '请求体必须是 JSON 对象';
  }
  const { rows, cols, regions } = payload;
  if (!isInt(rows) || rows < MIN_DIM || rows > MAX_DIM) {
    return `行数必须是 ${MIN_DIM} 至 ${MAX_DIM} 的整数`;
  }
  if (!isInt(cols) || cols < MIN_DIM || cols > MAX_DIM) {
    return `列数必须是 ${MIN_DIM} 至 ${MAX_DIM} 的整数`;
  }
  if (!Array.isArray(regions) || regions.length < MIN_REGIONS || regions.length > MAX_REGIONS) {
    return `检测区域数量必须在 ${MIN_REGIONS} 至 ${MAX_REGIONS} 之间`;
  }
  for (let i = 0; i < regions.length; i += 1) {
    const reg = regions[i];
    if (reg === null || typeof reg !== 'object' || Array.isArray(reg)) {
      return `第 ${i + 1} 个检测区域必须是对象`;
    }
    const { r1, c1, r2, c2, count } = reg;
    if (![r1, c1, r2, c2].every(isInt)) {
      return `第 ${i + 1} 个检测区域的坐标必须是整数`;
    }
    if (r1 < 0 || c1 < 0 || r2 < r1 || c2 < c1 || r2 >= rows || c2 >= cols) {
      return `第 ${i + 1} 个检测区域超出网格范围或坐标次序颠倒`;
    }
    const area = (r2 - r1 + 1) * (c2 - c1 + 1);
    if (!isInt(count) || count < 0 || count > area) {
      return `第 ${i + 1} 个检测区域的空鼓数必须是 0 至 ${area} 的整数`;
    }
  }
  return null;
}

async function handleSolve(pool, req, res) {
  let body = '';
  let tooLarge = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
    }
  });
  req.on('end', async () => {
    if (tooLarge) {
      sendJson(res, 413, { error: 'payload_too_large', message: '请求体过大' });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: 'invalid_json', message: '请求体不是合法的 JSON' });
      return;
    }
    const invalid = validatePayload(payload);
    if (invalid) {
      sendJson(res, 400, { error: 'invalid_input', message: invalid });
      return;
    }
    const { rows, cols, regions } = payload;
    let result;
    try {
      // 在 worker 线程中求解，避免搜索占用主事件循环而阻塞健康检查。
      result = await pool.run(rows, cols, regions);
    } catch (err) {
      sendJson(res, 503, {
        error: 'solver_unavailable',
        message: '求解服务暂时繁忙或超时，请稍后重试',
      });
      return;
    }
    if (result.inconclusive) {
      sendJson(res, 503, {
        error: 'solver_overloaded',
        message: '该请求的求解搜索超出计算预算，请稍后重试或精简检测区域',
      });
      return;
    }
    if (!result.satisfiable) {
      sendJson(res, 200, {
        status: 'unsatisfiable',
        message: '无法满足全部记录：不存在同时符合所有检测结果的饰砖状态',
      });
      return;
    }
    const grid2d = [];
    for (let r = 0; r < rows; r += 1) {
      grid2d.push(result.grid.slice(r * cols, (r + 1) * cols));
    }
    sendJson(res, 200, {
      status: 'ok',
      rows,
      cols,
      grid: grid2d,
      totalHollow: result.total,
      regions: regions.map((reg) => ({
        ...reg,
        expected: reg.count,
        actual: countInRegion(result.grid, cols, reg),
      })),
    });
  });
  req.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 400, { error: 'bad_request', message: '请求读取失败' });
    }
  });
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    sendJson(res, 400, { error: 'bad_request', message: '非法的请求路径' });
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'forbidden', message: '禁止访问' });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not_found', message: '资源不存在' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function createServer(pool = new SolverPool(), ownsPool = true) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/solve') {
      handleSolve(pool, req, res);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed', message: '不支持的请求方法' });
  });
  if (ownsPool) {
    server.on('close', () => { pool.close().catch(() => {}); });
  }
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const pool = new SolverPool();
  const server = createServer(pool, false);
  server.listen(port, () => {
    console.log(`空鼓反演服务已启动: http://0.0.0.0:${port}`);
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      pool.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, validatePayload };
