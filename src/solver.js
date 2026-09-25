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
 * 求解顺序：
 *   0. 约束传播：单区域可行性检查 + 强制赋值，直至不动点。
 *      彼此矛盾的重叠记录（例如同一块砖被记为 0 又被记为 1）
 *      在此被立即识别，无需进入指数级搜索；
 *   1. 分支限界求空鼓总数最小值（未定砖按受约束程度降序试探，
 *      使深层矛盾尽早暴露）；
 *   2. 在总数最小的解中按行主序构造字典序最小解。
 */

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
 * @returns {{satisfiable:false} | {satisfiable:true, grid:number[], total:number}}
 *          grid 为行主序展开的 0/1 状态序列。
 */
function solve(rows, cols, regions) {
  const n = rows * cols;
  const regionCount = regions.length;

  // 每个区域覆盖的砖块下标，以及每块砖被哪些区域覆盖。
  const regionTiles = regions.map((reg) => {
    const tiles = [];
    for (let r = reg.r1; r <= reg.r2; r += 1) {
      for (let c = reg.c1; c <= reg.c2; c += 1) {
        tiles.push(r * cols + c);
      }
    }
    return tiles;
  });
  const tileRegions = Array.from({ length: n }, () => []);
  regionTiles.forEach((tiles, ri) => {
    tiles.forEach((t) => tileRegions[t].push(ri));
  });

  const target = regions.map((reg) => reg.count);
  const assigned = new Array(regionCount).fill(0); // 区域内已确定为空的数量
  const remaining = regionTiles.map((tiles) => tiles.length); // 区域内未判定的砖数

  // value[i]：-1 未定；0/1 已被约束传播唯一确定（任何解都必须取该值）。
  const value = new Array(n).fill(-1);
  let forcedOnes = 0;

  function assignTile(i, v) {
    value[i] = v;
    if (v === 1) forcedOnes += 1;
    for (const r of tileRegions[i]) {
      assigned[r] += v;
      remaining[r] -= 1;
    }
  }

  // ---- 阶段零：约束传播（至不动点） ----
  // 对每个区域反复检查：
  //   已确定空鼓数 > 记录数，或 已确定数 + 未判定砖数 < 记录数 => 联合矛盾；
  //   已确定数 == 记录数 => 区域内其余砖必为完好（0）；
  //   已确定数 + 未判定砖数 == 记录数 => 区域内其余砖必为空鼓（1）。
  // 合法但彼此矛盾的重叠记录在此被即时判为无解。
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = 0; r < regionCount; r += 1) {
      const a = assigned[r];
      const rem = remaining[r];
      const t = target[r];
      if (a > t || a + rem < t) return { satisfiable: false };
      if (rem === 0) continue;
      let force = -1;
      if (a === t) force = 0;
      else if (a + rem === t) force = 1;
      if (force === -1) continue;
      for (const tile of regionTiles[r]) {
        if (value[tile] !== -1) continue;
        assignTile(tile, force);
        changed = true;
      }
    }
  }

  // 尝试为第 i 块砖赋值 v 后，各区域约束是否仍可能成立。
  function feasibleAfterAssign(regs, v) {
    for (const r of regs) {
      const a = assigned[r] + v;
      const rem = remaining[r] - 1;
      if (a > target[r] || a + rem < target[r]) return false;
    }
    return true;
  }

  function applyAssign(regs, v) {
    for (const r of regs) {
      assigned[r] += v;
      remaining[r] -= 1;
    }
  }

  function undoAssign(regs, v) {
    for (const r of regs) {
      assigned[r] -= v;
      remaining[r] += 1;
    }
  }

  // ---- 阶段一：分支限界求空鼓总数的最小值 ----
  // 未定砖按“被区域覆盖次数多者优先”排序：受约束越多的砖越早试探，
  // 矛盾在浅层即可暴露，避免在无关砖块上空耗指数级搜索。
  const order = [];
  for (let i = 0; i < n; i += 1) {
    if (value[i] === -1) order.push(i);
  }
  order.sort((a, b) => tileRegions[b].length - tileRegions[a].length || a - b);
  const m = order.length;

  let best = Infinity;

  function dfsMin(k, sum) {
    if (sum >= best) return;
    // 下界剪枝：剩余各区域仍缺的空鼓数，至少还要 max(缺额) 块
    // （一块砖可同时补足多个区域的缺额）。
    let need = 0;
    for (let r = 0; r < regionCount; r += 1) {
      const lack = target[r] - assigned[r];
      if (lack > need) need = lack;
    }
    if (sum + need >= best) return;
    if (k === m) {
      best = sum;
      return;
    }
    const regs = tileRegions[order[k]];
    if (feasibleAfterAssign(regs, 0)) {
      applyAssign(regs, 0);
      dfsMin(k + 1, sum);
      undoAssign(regs, 0);
    }
    if (feasibleAfterAssign(regs, 1)) {
      applyAssign(regs, 1);
      dfsMin(k + 1, sum + 1);
      undoAssign(regs, 1);
    }
  }

  dfsMin(0, forcedOnes);
  if (best === Infinity) return { satisfiable: false };

  // ---- 阶段二：在总数等于最小值的解中，按行主序字典序取最小 ----
  const grid = new Array(n).fill(0);
  let found = false;

  function dfsLex(i, sum) {
    if (found) return;
    if (sum > best || sum + (n - i) < best) return;
    if (i === n) {
      if (sum === best) found = true;
      return;
    }
    if (value[i] !== -1) {
      // 传播阶段已唯一确定的砖无分支，直接取其定值。
      grid[i] = value[i];
      dfsLex(i + 1, sum + value[i]);
      return;
    }
    const regs = tileRegions[i];
    // 先尝试 0（完好），保证第一个找到的解字典序最小。
    if (feasibleAfterAssign(regs, 0)) {
      applyAssign(regs, 0);
      grid[i] = 0;
      dfsLex(i + 1, sum);
      if (found) return;
      undoAssign(regs, 0);
    }
    if (feasibleAfterAssign(regs, 1)) {
      applyAssign(regs, 1);
      grid[i] = 1;
      dfsLex(i + 1, sum + 1);
      if (found) return;
      undoAssign(regs, 1);
    }
  }

  dfsLex(0, 0);
  if (!found) return { satisfiable: false }; // 理论上不可达，防御性返回
  return { satisfiable: true, grid, total: best };
}

module.exports = { solve, countInRegion };
