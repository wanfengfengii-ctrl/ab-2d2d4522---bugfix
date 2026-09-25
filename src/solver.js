'use strict';

/**
 * 空鼓联合反演求解器。
 *
 * 问题模型：rows x cols 的饰砖网格，每块砖为二元变量
 * （0 = 完好，1 = 空鼓）。每次矩形抽检给出其覆盖砖块中空鼓的
 * 精确总数。所有检测记录必须同时精确成立（联合判定，而非孤立
 * 解释单次听诊）。
 *
 * 解的选取规则（存在多种解释时）：
 *   1. 空鼓总数最少；
 *   2. 仍并列时，按“从上到下、从左到右”展开的状态序列取字典序
 *      最小（0 完好 排在 1 空鼓 之前）。
 *
 * 实现为带约束传播的分支限界：
 *   - 仅被至少一条区域覆盖的砖块参与搜索，未覆盖砖块恒为 0；
 *   - 每次赋值后做定点传播（计数已满 => 余砖强制 0；剩余砖必须
 *     全部空鼓才能凑满 => 强制 1），矛盾立即剪枝；
 *   - 阶段一先用贪心构造快速获得任意可行解作为上界，再以
 *     “最紧区域优先”的失败先行分支求空鼓总数最小值；
 *   - 阶段二严格按行主序逐砖决策（传播只能强制未来砖的取值，
 *     不影响字典序），第一个完成的解即字典序最小。
 */

const DEFAULT_SOLVE_NODE_LIMIT = 2000000;
/**
 * 单次求解允许访问的搜索节点数上限（可用环境变量 SOLVE_NODE_LIMIT 覆盖）。
 *
 * 网格至多 5×5（25 块砖、12 条区域），合法规模的反演在该预算内
 * 必然结束；硬上限是最后一道防线，确保病态实例也只能占用有限
 * CPU。超预算时返回 { satisfiable: false, inconclusive: true }，
 * 调用方不得将其当作“无解”，而应显式降级（如 503 稍后重试）。
 */
const SOLVE_NODE_LIMIT = (() => {
  const v = Number(process.env.SOLVE_NODE_LIMIT);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_SOLVE_NODE_LIMIT;
})();

/**
 * 计算某个矩形区域在给定状态序列（行主序展开）下的空鼓数。
 * 区域坐标为 0 起始的闭区间 { r1, c1, r2, c2 }。
 */
function countInRegion(grid, cols, region) {
  let sum = 0;
  for (let r = region.r1; r <= region.r2; r += 1) {
    for (let c = region.c1; c <= region.c2; c += 1) {
      sum += grid[r * cols + c];
    }
  }
  return sum;
}

/**
 * 求解空鼓反演问题。
 *
 * @param {number} rows 行数（4..5）
 * @param {number} cols 列数（4..5）
 * @param {Array<{r1:number,c1:number,r2:number,c2:number,count:number}>} regions
 *        矩形检测区域（0 起始闭区间）及其中听到的空鼓砖整数数量。
 * @returns {{satisfiable:false, inconclusive?:boolean} | {satisfiable:true, grid:number[], total:number}}
 *          grid 为行主序展开的 0/1 状态序列。
 */
function solve(rows, cols, regions) {
  const n = rows * cols;

  // 每个区域覆盖的砖块下标与位掩码（至多 25 块砖，可放入安全整数）。
  const regionTiles = regions.map((reg) => {
    const tiles = [];
    for (let r = reg.r1; r <= reg.r2; r += 1) {
      for (let c = reg.c1; c <= reg.c2; c += 1) {
        tiles.push(r * cols + c);
      }
    }
    return tiles;
  });
  const regionMasks = regionTiles.map((tiles) => {
    let mask = 0;
    for (const t of tiles) mask |= (1 << t);
    return mask;
  });

  // ---- 预处理：合并覆盖完全相同砖块的重复区域 ----
  // 同一砖块集合上计数不同 => 直接矛盾；相同则只需保留一条约束，
  // 既减少冗余传播，也避免下界被重复计数放大。
  const uniqueByMask = new Map();
  for (let i = 0; i < regions.length; i += 1) {
    const m = regionMasks[i];
    const cnt = regions[i].count;
    if (uniqueByMask.has(m)) {
      if (uniqueByMask.get(m) !== cnt) return { satisfiable: false };
    } else {
      uniqueByMask.set(m, cnt);
    }
  }
  const masks = [...uniqueByMask.keys()];
  const target = [...uniqueByMask.values()];
  const regionCount = masks.length;
  const tilesByMask = masks.map((m) => {
    const tiles = [];
    let x = m;
    while (x) {
      const b = x & -x;
      tiles.push(31 - Math.clz32(b));
      x ^= b;
    }
    return tiles;
  });

  // ---- 预处理：矩形间包含关系导致的计数矛盾 ----
  // A ⊆ B 时必有 count(A) <= count(B)。
  for (let i = 0; i < regionCount; i += 1) {
    for (let j = 0; j < regionCount; j += 1) {
      if (i !== j && (masks[i] & masks[j]) === masks[i] && target[i] > target[j]) {
        return { satisfiable: false };
      }
    }
  }

  // 仅被至少一条区域覆盖的砖块才需要参与搜索；未被任何区域覆盖的
  // 砖块不影响任何计数，按字典序最小原则恒为 0（完好）。
  let coveredMask = 0;
  for (const m of masks) coveredMask |= m;
  const tileRegions = Array.from({ length: n }, () => []);
  tilesByMask.forEach((tiles, ri) => {
    tiles.forEach((t) => tileRegions[t].push(ri));
  });
  const tileOrder = [];
  for (let t = 0; t < n; t += 1) {
    if (coveredMask & (1 << t)) tileOrder.push(t);
  }

  const assigned = new Int32Array(regionCount); // 区域内已确定的空鼓数量
  const remaining = Int32Array.from(tilesByMask, (tiles) => tiles.length); // 未判定砖数
  const domain = new Int8Array(n).fill(-1); // -1 未定，0/1 已定
  const trail = []; // { tile, value, regs }，用于回滚

  function pushAssign(tile, value) {
    if (domain[tile] !== -1) return domain[tile] === value;
    domain[tile] = value;
    const regs = tileRegions[tile];
    for (let k = 0; k < regs.length; k += 1) {
      const r = regs[k];
      assigned[r] += value;
      remaining[r] -= 1;
    }
    trail.push({ tile, value, regs });
    return true;
  }

  function rollback(to) {
    while (trail.length > to) {
      const { tile, value, regs } = trail.pop();
      domain[tile] = -1;
      for (let k = 0; k < regs.length; k += 1) {
        const r = regs[k];
        assigned[r] -= value;
        remaining[r] += 1;
      }
    }
  }

  // 定点传播：任何区域计数已满则其余砖强制 0；必须所有余砖都为空鼓
  // 才能凑满则强制 1。返回 false 表示出现矛盾。
  function propagate() {
    for (;;) {
      let changed = false;
      for (let r = 0; r < regionCount; r += 1) {
        const deficit = target[r] - assigned[r];
        if (deficit < 0 || deficit > remaining[r]) return false;
        let force = -1;
        if (remaining[r] > 0 && deficit === 0) force = 0;
        else if (remaining[r] > 0 && deficit === remaining[r]) force = 1;
        if (force !== -1) {
          const tiles = tilesByMask[r];
          for (let k = 0; k < tiles.length; k += 1) {
            const t = tiles[k];
            if (domain[t] === -1) {
              if (!pushAssign(t, force)) return false;
              changed = true;
            }
          }
        }
      }
      if (!changed) return true;
    }
  }

  let nodes = 0;
  let aborted = false;
  function tick() {
    nodes += 1;
    if (nodes > SOLVE_NODE_LIMIT) aborted = true;
  }

  // 当前路径上已确定的空鼓砖数（trail 记录了全部决策与传播赋值）。
  function decidedOnes() {
    let sum = 0;
    for (let k = 0; k < trail.length; k += 1) sum += trail[k].value;
    return sum;
  }

  // 计数边界（仅统计尚未判定的砖块）：
  //   缺额 d_r = 目标 - 已定空鼓；零额 s_r = 余砖 - 缺额（仍需的完好数）。
  // 一块砖可同时贡献于多个区域，故用“最大重叠数”做装箱式放缩：
  //   至少还需空鼓 max(max d,  ceil(Σd / 空鼓侧最大重叠))；
  //   至少还需完好 max(max s,  ceil(Σs / 完好侧最大重叠))。
  // 返回未定砖中空鼓数的可行区间 [lb, ub]。
  function bounds() {
    let undecided = 0;
    for (let k = 0; k < tileOrder.length; k += 1) {
      if (domain[tileOrder[k]] === -1) undecided += 1;
    }
    let maxD = 0;
    let maxS = 0;
    let sumD = 0;
    let sumS = 0;
    let hasDeficit = false;
    let hasSlack = false;
    for (let r = 0; r < regionCount; r += 1) {
      const d = target[r] - assigned[r];
      const s = remaining[r] - d;
      if (d > 0) { hasDeficit = true; sumD += d; if (d > maxD) maxD = d; }
      if (s > 0) { hasSlack = true; sumS += s; if (s > maxS) maxS = s; }
    }
    let lb = maxD;
    let zerosLb = maxS;
    if (hasDeficit || hasSlack) {
      let maxOnesOverlap = 1;
      let maxZerosOverlap = 1;
      for (let k = 0; k < tileOrder.length; k += 1) {
        const t = tileOrder[k];
        if (domain[t] !== -1) continue;
        let hitsD = 0;
        let hitsS = 0;
        const regs = tileRegions[t];
        for (let j = 0; j < regs.length; j += 1) {
          const r = regs[j];
          if (target[r] - assigned[r] > 0) hitsD += 1;
          if (remaining[r] - (target[r] - assigned[r]) > 0) hitsS += 1;
        }
        if (hitsD > maxOnesOverlap) maxOnesOverlap = hitsD;
        if (hitsS > maxZerosOverlap) maxZerosOverlap = hitsS;
      }
      if (hasDeficit) {
        const lb2 = Math.ceil(sumD / maxOnesOverlap);
        if (lb2 > lb) lb = lb2;
      }
      if (hasSlack) {
        const zlb2 = Math.ceil(sumS / maxZerosOverlap);
        if (zlb2 > zerosLb) zerosLb = zlb2;
      }
    }
    return { undecided, lb, ub: undecided - zerosLb };
  }

  // 失败先行：选 slack（剩余砖数 - 缺额）最小的未满区域，再在其中
  // 选覆盖最紧区域最多的未定砖。
  function pickBranchTile() {
    let bestR = -1;
    let bestSlack = Infinity;
    for (let r = 0; r < regionCount; r += 1) {
      const deficit = target[r] - assigned[r];
      if (deficit <= 0) continue;
      const slack = remaining[r] - deficit;
      if (slack < bestSlack) {
        bestSlack = slack;
        bestR = r;
      }
    }
    if (bestR === -1) return -1;
    const tiles = tilesByMask[bestR];
    let bestTile = -1;
    let bestScore = -1;
    for (let k = 0; k < tiles.length; k += 1) {
      const t = tiles[k];
      if (domain[t] !== -1) continue;
      let score = 0;
      const regs = tileRegions[t];
      for (let j = 0; j < regs.length; j += 1) {
        const r = regs[j];
        const deficit = target[r] - assigned[r];
        if (deficit > 0) score += 1 + (deficit === remaining[r] ? 1 : 0);
      }
      if (score > bestScore || (score === bestScore && t < bestTile)) {
        bestScore = score;
        bestTile = t;
      }
    }
    return bestTile;
  }

  // ---- 阶段零：贪心构造任意可行解，尽快建立总数上界 ----
  function greedyConstruct() {
    const mark = trail.length;
    let ok = true;
    outer:
    for (;;) {
      if (!propagate()) { ok = false; break; }
      // 选缺额比例最高的未满区域。
      let bestR = -1;
      let bestRatio = -1;
      for (let r = 0; r < regionCount; r += 1) {
        const deficit = target[r] - assigned[r];
        if (deficit <= 0) continue;
        const ratio = deficit / remaining[r];
        if (ratio > bestRatio) { bestRatio = ratio; bestR = r; }
      }
      if (bestR === -1) break; // 所有缺额已满足，余砖由传播置 0
      let tile = -1;
      let bestScore = -1;
      const tiles = tilesByMask[bestR];
      for (let k = 0; k < tiles.length; k += 1) {
        const t = tiles[k];
        if (domain[t] !== -1) continue;
        let score = 0;
        const regs = tileRegions[t];
        for (let j = 0; j < regs.length; j += 1) {
          if (target[regs[j]] - assigned[regs[j]] > 0) score += 1;
        }
        if (score > bestScore || (score === bestScore && t < tile)) {
          bestScore = score;
          tile = t;
        }
      }
      if (tile === -1) { ok = false; break; }
      // 缺额为正，优先尝试空鼓；失败再试完好。
      let progressed = false;
      for (const value of [1, 0]) {
        const to = trail.length;
        if (pushAssign(tile, value) && propagate()) { progressed = true; break; }
        rollback(to);
      }
      if (!progressed) { ok = false; break outer; }
    }
    let total = Infinity;
    if (ok) {
      // 传播收敛后不应再有未定砖（未满区域已全部满足，余砖被置 0）。
      total = decidedOnes();
    }
    rollback(mark);
    return total;
  }

  // ---- 阶段一：分支限界求空鼓总数的最小值 ----
  let best = greedyConstruct();
  if (aborted) return { satisfiable: false, inconclusive: true };

  function dfsMin() {
    if (aborted) return;
    tick();
    const sum = decidedOnes();
    if (sum >= best) return;
    const { lb, ub } = bounds();
    if (lb > ub || sum + lb >= best) return;
    const tile = pickBranchTile();
    if (tile === -1) {
      if (sum < best) best = sum;
      return;
    }
    // 先 0 后 1：目标是空鼓总数最少。
    for (const value of [0, 1]) {
      const to = trail.length;
      if (pushAssign(tile, value) && propagate()) {
        dfsMin();
        if (aborted) return;
      }
      rollback(to);
    }
  }

  {
    const mark = trail.length;
    if (propagate()) dfsMin();
    rollback(mark);
  }
  if (aborted) return { satisfiable: false, inconclusive: true };
  if (best === Infinity) return { satisfiable: false };

  // ---- 阶段二：在总数等于最小值的解中，按行主序字典序取最小 ----
  // 严格按 tileOrder（行主序）逐砖决策；传播只能强制“之后”砖的
  // 取值，不会跳过当前砖，因此先尝试 0 找到的第一个解即字典序最小。
  let found = false;
  nodes = 0;

  function dfsLex(pos) {
    if (found || aborted) return;
    tick();
    const sum = decidedOnes();
    if (sum > best) return;
    const { lb, ub } = bounds();
    // 未定砖中空鼓数 x ∈ [lb, ub]；总数须恰好为 best。
    if (lb > ub || sum + lb > best || sum + ub < best) return;
    if (pos === tileOrder.length) {
      if (sum === best) found = true;
      return;
    }
    const tile = tileOrder[pos];
    if (domain[tile] !== -1) {
      dfsLex(pos + 1); // 传播已强制该砖取值
      return;
    }
    for (const value of [0, 1]) {
      const to = trail.length;
      if (pushAssign(tile, value) && propagate()) {
        dfsLex(pos + 1);
        if (found || aborted) return;
      }
      rollback(to);
    }
  }

  let resultGrid = null;
  {
    const mark = trail.length;
    if (propagate()) {
      dfsLex(0);
      if (found) {
        resultGrid = new Array(n).fill(0);
        for (let k = 0; k < trail.length; k += 1) {
          resultGrid[trail[k].tile] = trail[k].value;
        }
      }
    }
    rollback(mark);
  }
  if (aborted) return { satisfiable: false, inconclusive: true };
  if (!found) return { satisfiable: false }; // 理论上不可达，防御性返回
  return { satisfiable: true, grid: resultGrid, total: best };
}

module.exports = { solve, countInRegion, SOLVE_NODE_LIMIT };
