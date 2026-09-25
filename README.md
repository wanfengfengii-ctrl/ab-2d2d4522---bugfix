# 古建筑墙面饰砖空鼓联合反演

检测员在修缮前对墙面饰砖做有限次矩形区域敲击抽检，记录每次区域内听到的空鼓砖数量。
本系统将多次检测记录**联合反演**为每块砖的空鼓/完好状态，避免孤立解释单次听诊导致的相互矛盾。

## 业务规则

- 网格：4–5 行 × 4–5 列饰砖。
- 检测记录：3–12 次矩形区域抽检，每次记录该区域内空鼓砖的整数数量。
- 服务端对每块砖联合判定空鼓（1）或完好（0），使**每次**检测区域内的空鼓总数与记录**精确相等**。
- 存在多种解释时，依次选取：
  1. 空鼓总数最少；
  2. 按“从上到下、从左到右”展开的状态序列字典序最小（完好 0 排在空鼓 1 之前）。
- 无解时返回 `unsatisfiable`；非法输入返回 400。前端在输入修改、无解或服务端拒绝后
  立即清除旧结论，并明确提示“无法满足全部记录”。

## 目录结构

```
src/solver.js        联合反演求解器（约束传播 + 分支限界：贪心初界、失败先行分支、装箱式计数边界）
src/solver-worker.js worker 线程入口，在事件循环之外运行同步求解
src/solver-pool.js   worker 池：求解任务排队、超时终止重启，保证健康检查不被求解阻塞
src/server.js        零依赖 HTTP 服务：静态页面 + /api/solve + /api/health
public/              前端页面（网格录入、结果网格、区域计数核对、一致性结论）
test/                node:test 单元测试与 API 测试（含暴力枚举对照）
scripts/check.js     构建检查（语法 / JSON / 必备文件）
scripts/verify.js    验收编排：代码测试 + 构建检查 + API/HTTP 冒烟，以退出码报告结论
```

CPU 密集的搜索运行在 worker 线程池中，主事件循环只负责收发消息，
因此求解请求（即使是耗时的矛盾实例）不会阻塞 `/api/health` 或静态
资源等无关请求。可用环境变量 `SOLVE_WORKERS`（worker 数，默认
`min(4, CPU-1)`）、`SOLVE_TIMEOUT_MS`（单任务超时，默认 8000ms）、
`SOLVE_NODE_LIMIT`（单次搜索节点预算，默认 2000000）调节。

## 本地运行

```bash
npm start          # 默认监听 3000 端口，可用 PORT 环境变量覆盖
npm test           # 代码测试
npm run check      # 构建检查
npm run verify     # 完整验收（需服务已在 APP_URL 运行，默认 http://127.0.0.1:3000）
```

## Docker / Compose

```bash
# 构建并启动（宿主机端口默认 8080，可用 HOST_PORT 覆盖）
HOST_PORT=9000 docker compose up --build app

# 验收：verify 等待 app 健康后执行测试/构建检查/冒烟，随后自行退出，
# 命令退出码即 verify 的验收结论
docker compose up --build --exit-code-from verify verify
```

Dockerfile 内置 `HEALTHCHECK`，Compose 的 app 服务另配独立健康检查；
verify 服务 `depends_on: service_healthy`，完成后自动退出。

## API

### `POST /api/solve`

请求体（区域坐标为 0 起始闭区间）：

```json
{
  "rows": 4,
  "cols": 4,
  "regions": [
    { "r1": 0, "c1": 0, "r2": 3, "c2": 3, "count": 4 },
    { "r1": 0, "c1": 0, "r2": 1, "c2": 3, "count": 2 },
    { "r1": 0, "c1": 0, "r2": 3, "c2": 1, "count": 2 }
  ]
}
```

成功（200）：

```json
{
  "status": "ok",
  "rows": 4, "cols": 4,
  "grid": [[0,0,0,0],[0,0,1,1],[0,0,0,0],[1,1,0,0]],
  "totalHollow": 4,
  "regions": [{ "r1": 0, "c1": 0, "r2": 3, "c2": 3, "count": 4, "expected": 4, "actual": 4 }]
}
```

无解（200）：`{ "status": "unsatisfiable", "message": "无法满足全部记录：…" }`
非法输入（400）：`{ "error": "invalid_input", "message": "…" }`

### `GET /api/health`

返回 `{ "status": "ok" }`，供健康检查使用。
