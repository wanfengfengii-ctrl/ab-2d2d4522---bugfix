'use strict';

/**
 * 求解 worker 池：把 CPU 密集的反演搜索限制在 worker 线程内，
 * 主事件循环只负责收发短消息，因此健康检查与静态资源等无关请求
 * 不会被正在进行的求解阻塞。
 *
 * 任务数超过 worker 数时排队；单个任务带超时，超时后终止并重启
 * 对应 worker，防止任何请求长期占用线程。
 */
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

const WORKER_FILE = path.join(__dirname, 'solver-worker.js');

function defaultPoolSize() {
  const v = Number(process.env.SOLVE_WORKERS);
  if (Number.isInteger(v) && v > 0) return v;
  const cpus = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : 2;
  // 至少 1 个 worker，最多 4 个；为主事件循环留出一个核。
  return Math.max(1, Math.min(4, cpus - 1));
}

const DEFAULT_TASK_TIMEOUT_MS = 8000;
function taskTimeoutMs() {
  const v = Number(process.env.SOLVE_TIMEOUT_MS);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_TASK_TIMEOUT_MS;
}

class SolverPool {
  constructor(size = defaultPoolSize()) {
    this.size = size;
    this.queue = []; // 等待空闲 worker 的任务
    this.workers = [];
    for (let i = 0; i < size; i += 1) this.workers.push(this.spawnWorker(i));
  }

  spawnWorker(index) {
    const worker = new Worker(WORKER_FILE);
    const slot = { worker, index, busy: false, draining: false, current: null };
    worker.on('message', (msg) => {
      const cur = slot.current;
      slot.current = null;
      slot.busy = false;
      if (cur) {
        clearTimeout(cur.timer);
        if (msg && Object.prototype.hasOwnProperty.call(msg, 'error')) {
          cur.reject(new Error(msg.error));
        } else {
          cur.resolve(msg ? msg.result : { satisfiable: false, inconclusive: true });
        }
      }
      this.pump(slot);
    });
    worker.on('error', (err) => {
      const cur = slot.current;
      slot.current = null;
      slot.busy = false;
      if (cur) {
        clearTimeout(cur.timer);
        cur.reject(err);
      }
      // 异常退出的 worker 重启后继续服务排队任务。
      this.workers[index] = this.spawnWorker(index);
      this.pump(this.workers[index]);
    });
    return slot;
  }

  pump(slot) {
    // draining：该 worker 已超时、正在终止重启，绝不能再派任务给它。
    if (slot.draining || slot.busy || slot.current) return;
    const task = this.queue.shift();
    if (!task) return;
    slot.busy = true;
    slot.current = task;
    task.timer = setTimeout(() => {
      // 无法取消 worker 中正在运行的同步任务：终止并重启该 worker。
      const cur = slot.current;
      slot.current = null;
      slot.busy = false;
      slot.draining = true; // 重启完成前该槽位不得接新任务
      if (cur) cur.reject(Object.assign(new Error('solver_timeout'), { code: 'SOLVER_TIMEOUT' }));
      slot.worker.terminate().finally(() => {
        this.workers[slot.index] = this.spawnWorker(slot.index);
        this.pump(this.workers[slot.index]);
      });
    }, taskTimeoutMs());
    if (typeof task.timer.unref === 'function') task.timer.unref();
    slot.worker.postMessage({
      id: task.id,
      rows: task.rows,
      cols: task.cols,
      regions: task.regions,
    });
  }

  run(rows, cols, regions) {
    return new Promise((resolve, reject) => {
      const task = {
        id: (this.nextId = (this.nextId || 0) + 1),
        rows, cols, regions, resolve, reject, timer: null,
      };
      this.queue.push(task);
      const free = this.workers.find((w) => !w.draining && !w.busy && !w.current);
      if (free) this.pump(free);
    });
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.worker.terminate().catch(() => {})));
    this.workers = [];
    this.queue.forEach((t) => t.reject(new Error('pool_closed')));
    this.queue = [];
  }
}

module.exports = { SolverPool };
