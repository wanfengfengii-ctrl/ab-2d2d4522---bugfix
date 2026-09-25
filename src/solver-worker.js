'use strict';

/**
 * 求解 worker：在独立线程中运行同步求解器，避免 CPU 密集的搜索
 * 阻塞主事件循环（健康检查与无关请求因此不会排队等待求解）。
 *
 * 协议：父线程 postMessage({ id, rows, cols, regions })，
 * worker 回送 { id, result } 或 { id, error }。
 */
const { parentPort } = require('worker_threads');
const { solve } = require('./solver');

parentPort.on('message', (msg) => {
  if (!msg || typeof msg.id !== 'number') return;
  try {
    const result = solve(msg.rows, msg.cols, msg.regions);
    parentPort.postMessage({ id: msg.id, result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
});
