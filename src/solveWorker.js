'use strict';

/**
 * 求解工作线程：在独立线程中执行 CPU 密集的联合反演，
 * 使主线程事件循环始终保持可响应（健康检查与无关请求不被阻塞）。
 */
const { parentPort } = require('worker_threads');
const { solve } = require('./solver');

parentPort.on('message', ({ rows, cols, regions }) => {
  let msg;
  try {
    msg = { ok: true, result: solve(rows, cols, regions) };
  } catch (err) {
    msg = { ok: false, message: String((err && err.message) || err) };
  }
  parentPort.postMessage(msg);
});
