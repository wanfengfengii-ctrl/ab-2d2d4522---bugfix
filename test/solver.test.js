'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solve, countInRegion } = require('../src/solver');

/** 暴力枚举全部 2^(rows*cols) 种状态，按规则取最优，作为对照基准。 */
function bruteForce(rows, cols, regions) {
  const n = rows * cols;
  let best = null;
  for (let mask = 0; mask < (1 << n); mask += 1) {
    const grid = new Array(n);
    for (let i = 0; i < n; i += 1) grid[i] = (mask >> i) & 1;
    let ok = true;
    for (const reg of regions) {
      if (countInRegion(grid, cols, reg) !== reg.count) { ok = false; break; }
    }
    if (!ok) continue;
    const total = grid.reduce((a, b) => a + b, 0);
    if (best === null || total < best.total) {
      best = { grid, total };
    } else if (total === best.total) {
      for (let i = 0; i < n; i += 1) {
        if (grid[i] !== best.grid[i]) {
          if (grid[i] < best.grid[i]) best = { grid, total };
          break;
        }
      }
    }
  }
  return best;
}

/** 确定性伪随机数（LCG），保证测试可复现。 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('行列条带约束下的唯一解', () => {
  // 真解：仅第 1 行的第 2、4 列空鼓。
  const rows = 4; const cols = 4;
  const regions = [
    { r1: 0, c1: 0, r2: 0, c2: 3, count: 2 },
    { r1: 1, c1: 0, r2: 1, c2: 3, count: 0 },
    { r1: 2, c1: 0, r2: 2, c2: 3, count: 0 },
    { r1: 3, c1: 0, r2: 3, c2: 3, count: 0 },
    { r1: 0, c1: 0, r2: 3, c2: 0, count: 0 },
    { r1: 0, c1: 1, r2: 3, c2: 1, count: 1 },
    { r1: 0, c1: 2, r2: 3, c2: 2, count: 0 },
    { r1: 0, c1: 3, r2: 3, c2: 3, count: 1 },
  ];
  const res = solve(rows, cols, regions);
  assert.equal(res.satisfiable, true);
  assert.equal(res.total, 2);
  assert.deepEqual(res.grid, [
    0, 1, 0, 1,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
});

test('总数最少优先，其次按行主序字典序最小', () => {
  // 约束：全盘 1 块空鼓、上半区 1 块、下半区 0 块。
  // 候选：上半区 8 格中任一格。字典序最小 => 空鼓尽量靠后 => 第 2 行最后一列（下标 7）。
  const regions = [
    { r1: 0, c1: 0, r2: 3, c2: 3, count: 1 },
    { r1: 0, c1: 0, r2: 1, c2: 3, count: 1 },
    { r1: 2, c1: 0, r2: 3, c2: 3, count: 0 },
  ];
  const res = solve(4, 4, regions);
  assert.equal(res.satisfiable, true);
  assert.equal(res.total, 1);
  const expected = new Array(16).fill(0);
  expected[7] = 1;
  assert.deepEqual(res.grid, expected);
});

test('互相矛盾的记录判定为无解', () => {
  const regions = [
    { r1: 0, c1: 0, r2: 0, c2: 0, count: 1 },
    { r1: 0, c1: 0, r2: 0, c2: 0, count: 0 },
    { r1: 0, c1: 0, r2: 3, c2: 3, count: 1 },
  ];
  assert.deepEqual(solve(4, 4, regions), { satisfiable: false });
});

test('包含与被包含区域数量矛盾判定为无解', () => {
  const regions = [
    { r1: 0, c1: 0, r2: 1, c2: 1, count: 1 },
    { r1: 0, c1: 0, r2: 0, c2: 0, count: 2 }, // 单格不可能有 2 块——由服务端校验拦截；此处构造区域和矛盾
    { r1: 1, c1: 1, r2: 1, c2: 1, count: 0 },
  ];
  // 注意：count=2 超出 1x1 区域面积，属于服务端校验职责；求解器层面替换为合法但矛盾的约束。
  regions[1] = { r1: 0, c1: 0, r2: 0, c2: 1, count: 0 };
  regions[0] = { r1: 0, c1: 0, r2: 0, c2: 0, count: 1 };
  assert.deepEqual(solve(4, 4, regions), { satisfiable: false });
});

test('4x4 随机用例与暴力枚举完全一致', () => {
  const rand = lcg(20260925);
  for (let trial = 0; trial < 40; trial += 1) {
    const rows = 4; const cols = 4;
    const truth = Array.from({ length: 16 }, () => (rand() < 0.3 ? 1 : 0));
    const regionCount = 3 + Math.floor(rand() * 10); // 3..12
    const regions = [];
    for (let k = 0; k < regionCount; k += 1) {
      const r1 = Math.floor(rand() * rows);
      const r2 = r1 + Math.floor(rand() * (rows - r1));
      const c1 = Math.floor(rand() * cols);
      const c2 = c1 + Math.floor(rand() * (cols - c1));
      regions.push({ r1, c1, r2, c2, count: countInRegion(truth, cols, { r1, c1, r2, c2 }) });
    }
    const expected = bruteForce(rows, cols, regions);
    const got = solve(rows, cols, regions);
    assert.equal(got.satisfiable, expected !== null, `trial ${trial} 可满足性不一致`);
    if (expected) {
      assert.equal(got.total, expected.total, `trial ${trial} 最少空鼓数不一致`);
      assert.deepEqual(got.grid, expected.grid, `trial ${trial} 字典序最小解不一致`);
      for (const reg of regions) {
        assert.equal(countInRegion(got.grid, cols, reg), reg.count, `trial ${trial} 区域计数不一致`);
      }
    }
  }
});

test('4x4 随机矛盾用例（暴力确认无解时求解器必须判无解）', () => {
  const rand = lcg(777);
  for (let trial = 0; trial < 30; trial += 1) {
    const rows = 4; const cols = 4;
    const regionCount = 3 + Math.floor(rand() * 10);
    const regions = [];
    for (let k = 0; k < regionCount; k += 1) {
      const r1 = Math.floor(rand() * rows);
      const r2 = r1 + Math.floor(rand() * (rows - r1));
      const c1 = Math.floor(rand() * cols);
      const c2 = c1 + Math.floor(rand() * (cols - c1));
      const area = (r2 - r1 + 1) * (c2 - c1 + 1);
      regions.push({ r1, c1, r2, c2, count: Math.floor(rand() * (area + 1)) });
    }
    const expected = bruteForce(rows, cols, regions);
    const got = solve(rows, cols, regions);
    assert.equal(got.satisfiable, expected !== null, `trial ${trial} 可满足性不一致`);
    if (expected) assert.deepEqual(got.grid, expected.grid);
  }
});

test('5x5 网格：解满足全部记录且总数自洽', () => {
  const rand = lcg(555);
  const rows = 5; const cols = 5;
  const truth = Array.from({ length: 25 }, () => (rand() < 0.35 ? 1 : 0));
  const regions = [];
  for (let k = 0; k < 12; k += 1) {
    const r1 = Math.floor(rand() * rows);
    const r2 = r1 + Math.floor(rand() * (rows - r1));
    const c1 = Math.floor(rand() * cols);
    const c2 = c1 + Math.floor(rand() * (cols - c1));
    regions.push({ r1, c1, r2, c2, count: countInRegion(truth, cols, { r1, c1, r2, c2 }) });
  }
  const res = solve(rows, cols, regions);
  assert.equal(res.satisfiable, true);
  assert.equal(res.grid.length, 25);
  assert.equal(res.grid.reduce((a, b) => a + b, 0), res.total);
  for (const reg of regions) {
    assert.equal(countInRegion(res.grid, cols, reg), reg.count);
  }
});

test('全部区域计数为零 => 全完好', () => {
  const regions = [
    { r1: 0, c1: 0, r2: 4, c2: 4, count: 0 },
    { r1: 0, c1: 0, r2: 2, c2: 4, count: 0 },
    { r1: 2, c1: 0, r2: 4, c2: 2, count: 0 },
  ];
  const res = solve(5, 5, regions);
  assert.equal(res.satisfiable, true);
  assert.equal(res.total, 0);
  assert.deepEqual(res.grid, new Array(25).fill(0));
});

test('5x5 右下角重叠记录计数 0/1/0：单条合法、联合矛盾 => 无解', () => {
  const regions = [
    { r1: 4, c1: 4, r2: 4, c2: 4, count: 0 },
    { r1: 4, c1: 4, r2: 4, c2: 4, count: 1 },
    { r1: 4, c1: 4, r2: 4, c2: 4, count: 0 },
  ];
  assert.deepEqual(solve(5, 5, regions), { satisfiable: false });
});

test('相同砖块集合计数冲突直接判无解，未覆盖砖恒为完好', () => {
  // 同一 1x1 区域给出 0 与 1 两个计数；其余 24 块砖未被覆盖。
  const regions = [
    { r1: 0, c1: 0, r2: 0, c2: 0, count: 0 },
    { r1: 0, c1: 0, r2: 0, c2: 0, count: 1 },
    { r1: 0, c1: 0, r2: 0, c2: 0, count: 1 },
  ];
  assert.deepEqual(solve(5, 5, regions), { satisfiable: false });

  const ok = solve(5, 5, [
    { r1: 4, c1: 4, r2: 4, c2: 4, count: 1 },
    { r1: 4, c1: 4, r2: 4, c2: 4, count: 1 },
    { r1: 4, c1: 4, r2: 4, c2: 4, count: 1 },
  ]);
  assert.equal(ok.satisfiable, true);
  assert.equal(ok.total, 1);
  const expected = new Array(25).fill(0);
  expected[24] = 1;
  assert.deepEqual(ok.grid, expected);
});

test('包含区域计数倒置（A⊆B 但 count(A)>count(B)）判无解', () => {
  const regions = [
    { r1: 0, c1: 0, r2: 4, c2: 4, count: 2 },
    { r1: 0, c1: 0, r2: 2, c2: 2, count: 3 }, // 被全盘包含却计数更大
    { r1: 3, c1: 3, r2: 4, c2: 4, count: 0 },
  ];
  assert.deepEqual(solve(5, 5, regions), { satisfiable: false });
});
