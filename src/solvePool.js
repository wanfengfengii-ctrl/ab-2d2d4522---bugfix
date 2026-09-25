'use strict';

/**
 * 求解线程池：把 CPU 密集的求解任务分发给固定数量的工作线程执行。
 * 即使个别合法请求的求解耗时较长，主线程事件循环也不会被阻塞，
 * 健康检查与无关 API 请求仍可及时响应。
 */
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, 'solveWorker.js');

function defaultSize() {
  const cpus = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return Math.max(2, Math.min(4, cpus || 2));
}

class SolvePool {
  constructor(size = defaultSize()) {
    this.workers = new Set();
    this.idle = [];
    this.queue = [];
    this.closed = false;
    for (let i = 0; i < size; i += 1) this.spawn();
  }

  spawn() {
    const worker = new Worker(WORKER_PATH);
    worker.current = null; // 该工作线程正在执行的任务
    let settled = false; // 避免 error 与 exit 重复结算

    const settle = (err) => {
      if (settled) return;
      settled = true;
      const job = worker.current;
      worker.current = null;
      this.workers.delete(worker);
      const idx = this.idle.indexOf(worker);
      if (idx !== -1) this.idle.splice(idx, 1);
      if (job) job.reject(err);
      if (!this.closed) this.spawn(); // 补上异常退出的工作线程
      this.pump();
    };

    worker.on('message', (msg) => {
      const job = worker.current;
      worker.current = null;
      this.idle.push(worker);
      if (job) {
        if (msg.ok) job.resolve(msg.result);
        else job.reject(new Error(msg.message || '求解失败'));
      }
      this.pump();
    });
    worker.on('error', (err) => settle(err));
    worker.on('exit', (code) => {
      if (code !== 0) settle(new Error(`求解工作线程异常退出（代码 ${code}）`));
    });
    worker.unref(); // 不单独阻止进程退出
    this.workers.add(worker);
    this.idle.push(worker);
  }

  pump() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const job = this.queue.shift();
      worker.current = job;
      worker.postMessage(job.payload);
    }
  }

  /**
   * 提交一次求解，返回解析为 solver.solve 结果的 Promise。
   */
  solve(rows, cols, regions) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('求解线程池已关闭'));
        return;
      }
      this.queue.push({ payload: { rows, cols, regions }, resolve, reject });
      this.pump();
    });
  }

  /** 终止全部工作线程，并拒绝排队中与执行中的任务。 */
  close() {
    this.closed = true;
    const terminations = [];
    for (const worker of this.workers) {
      if (worker.current) {
        worker.current.reject(new Error('求解线程池已关闭'));
        worker.current = null;
      }
      terminations.push(worker.terminate());
    }
    this.workers.clear();
    this.idle.length = 0;
    const pending = this.queue.splice(0);
    for (const job of pending) job.reject(new Error('求解线程池已关闭'));
    return Promise.all(terminations);
  }
}

module.exports = { SolvePool };
