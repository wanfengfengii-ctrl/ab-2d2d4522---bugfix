'use strict';

(function () {
  const MIN_REGIONS = 3;
  const MAX_REGIONS = 12;

  const rowsSelect = document.getElementById('rows-select');
  const colsSelect = document.getElementById('cols-select');
  const regionsTbody = document.getElementById('regions-tbody');
  const addRegionBtn = document.getElementById('add-region-btn');
  const submitBtn = document.getElementById('submit-btn');
  const inputError = document.getElementById('input-error');
  const resultPanel = document.getElementById('result-panel');
  const conclusionEl = document.getElementById('conclusion');
  const resultGridWrap = document.getElementById('result-grid-wrap');
  const resultGrid = document.getElementById('result-grid');
  const regionResultTbody = document.getElementById('region-result-tbody');

  // 每次输入修改都必须作废旧结论；版本号用于使途中响应失效。
  let resultVersion = 0;
  function clearResult() {
    resultVersion += 1;
    resultPanel.hidden = true;
    conclusionEl.textContent = '';
    conclusionEl.className = 'conclusion';
    resultGrid.innerHTML = '';
    regionResultTbody.innerHTML = '';
  }

  function showInputError(msg) {
    if (msg) {
      inputError.textContent = msg;
      inputError.hidden = false;
    } else {
      inputError.textContent = '';
      inputError.hidden = true;
    }
  }

  function gridDims() {
    return { rows: Number(rowsSelect.value), cols: Number(colsSelect.value) };
  }

  function makeNumberInput(value, min, max, onChange) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(value);
    input.addEventListener('input', () => {
      clearResult();
      showInputError('');
      input.classList.remove('invalid');
      if (onChange) onChange(input);
    });
    return input;
  }

  function addRegionRow(region) {
    const { rows, cols } = gridDims();
    const tr = document.createElement('tr');

    const idxTd = document.createElement('td');
    idxTd.className = 'region-index';

    const r1Input = makeNumberInput(region.r1, 1, rows, (el) => clampPair(el, r2Input));
    const c1Input = makeNumberInput(region.c1, 1, cols, (el) => clampPair(el, c2Input));
    const r2Input = makeNumberInput(region.r2, 1, rows, (el) => clampPair(r1Input, el));
    const c2Input = makeNumberInput(region.c2, 1, cols, (el) => clampPair(c1Input, el));
    const countInput = makeNumberInput(region.count, 0, rows * cols, null);

    function clampPair(startEl, endEl) {
      // 仅作提示性校正：保证 起始 <= 结束，具体合法性提交时统一校验。
      const s = Number(startEl.value);
      const e = Number(endEl.value);
      if (Number.isInteger(s) && Number.isInteger(e) && s > e) endEl.value = String(s);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '删除';
    removeBtn.addEventListener('click', () => {
      if (regionsTbody.rows.length <= MIN_REGIONS) return;
      tr.remove();
      refreshRegionRows();
      clearResult();
      showInputError('');
    });

    [idxTd, r1Input, c1Input, r2Input, c2Input, countInput].forEach((el) => {
      const td = el.tagName === 'TD' ? el : document.createElement('td');
      if (td !== el) td.appendChild(el);
      tr.appendChild(td);
    });
    const btnTd = document.createElement('td');
    btnTd.appendChild(removeBtn);
    tr.appendChild(btnTd);

    tr._inputs = { r1: r1Input, c1: c1Input, r2: r2Input, c2: c2Input, count: countInput, removeBtn };
    regionsTbody.appendChild(tr);
    refreshRegionRows();
  }

  function refreshRegionRows() {
    const rows = Array.from(regionsTbody.rows);
    rows.forEach((tr, i) => {
      tr.querySelector('.region-index').textContent = String(i + 1);
      tr._inputs.removeBtn.disabled = rows.length <= MIN_REGIONS;
    });
    addRegionBtn.disabled = rows.length >= MAX_REGIONS;
  }

  function clampRegionsToGrid() {
    const { rows, cols } = gridDims();
    Array.from(regionsTbody.rows).forEach((tr) => {
      const { r1, c1, r2, c2, count } = tr._inputs;
      [r1, r2].forEach((el) => { el.max = String(rows); if (Number(el.value) > rows) el.value = String(rows); });
      [c1, c2].forEach((el) => { el.max = String(cols); if (Number(el.value) > cols) el.value = String(cols); });
      if (Number(r2.value) < Number(r1.value)) r2.value = r1.value;
      if (Number(c2.value) < Number(c1.value)) c2.value = c1.value;
      const area = (Number(r2.value) - Number(r1.value) + 1) * (Number(c2.value) - Number(c1.value) + 1);
      count.max = String(area);
      if (Number(count.value) > area) count.value = String(area);
    });
  }

  function collectPayload() {
    const { rows, cols } = gridDims();
    const regions = [];
    const rowsList = Array.from(regionsTbody.rows);
    for (let i = 0; i < rowsList.length; i += 1) {
      const { r1, c1, r2, c2, count } = rowsList[i]._inputs;
      const vals = { r1, c1, r2, c2, count };
      const nums = {};
      for (const [key, el] of Object.entries(vals)) {
        const v = Number(el.value);
        if (el.value.trim() === '' || !Number.isInteger(v)) {
          el.classList.add('invalid');
          return { error: `第 ${i + 1} 次检测存在空白或非整数输入` };
        }
        nums[key] = v;
      }
      if (nums.r1 < 1 || nums.r1 > rows || nums.r2 < nums.r1 || nums.r2 > rows) {
        r1.classList.add('invalid');
        r2.classList.add('invalid');
        return { error: `第 ${i + 1} 次检测的行范围须在 1 至 ${rows} 之间且起始不大于结束` };
      }
      if (nums.c1 < 1 || nums.c1 > cols || nums.c2 < nums.c1 || nums.c2 > cols) {
        c1.classList.add('invalid');
        c2.classList.add('invalid');
        return { error: `第 ${i + 1} 次检测的列范围须在 1 至 ${cols} 之间且起始不大于结束` };
      }
      const area = (nums.r2 - nums.r1 + 1) * (nums.c2 - nums.c1 + 1);
      if (nums.count < 0 || nums.count > area) {
        count.classList.add('invalid');
        return { error: `第 ${i + 1} 次检测的空鼓数须在 0 至 ${area} 之间` };
      }
      regions.push({
        r1: nums.r1 - 1,
        c1: nums.c1 - 1,
        r2: nums.r2 - 1,
        c2: nums.c2 - 1,
        count: nums.count,
      });
    }
    if (regions.length < MIN_REGIONS || regions.length > MAX_REGIONS) {
      return { error: `检测区域数量须在 ${MIN_REGIONS} 至 ${MAX_REGIONS} 之间` };
    }
    return { payload: { rows, cols, regions } };
  }

  function showConclusion(kind, text) {
    conclusionEl.className = `conclusion ${kind}`;
    conclusionEl.textContent = text;
  }

  function renderSolution(data) {
    showConclusion(
      'ok',
      `反演成功：与全部 ${data.regions.length} 次检测记录精确一致，共 ${data.totalHollow} 块空鼓砖`
      + '（已按“空鼓总数最少、状态序列字典序最小”选取唯一方案）。'
    );
    resultGridWrap.hidden = false;

    resultGrid.style.gridTemplateColumns = `repeat(${data.cols}, 56px)`;
    data.grid.forEach((rowArr) => {
      rowArr.forEach((cell) => {
        const div = document.createElement('div');
        div.className = `tile ${cell === 1 ? 'hollow' : 'sound'}`;
        div.textContent = cell === 1 ? '空鼓' : '完好';
        resultGrid.appendChild(div);
      });
    });

    data.regions.forEach((reg, i) => {
      const tr = document.createElement('tr');
      const range = `第 ${reg.r1 + 1}–${reg.r2 + 1} 行，第 ${reg.c1 + 1}–${reg.c2 + 1} 列`;
      const consistent = reg.actual === reg.expected;
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${range}</td>
        <td>${reg.expected}</td>
        <td>${reg.actual}</td>
        <td class="${consistent ? 'consistency-ok' : 'consistency-bad'}">${consistent ? '✓ 一致' : '✗ 不一致'}</td>`;
      tr.addEventListener('mouseenter', () => highlightRegion(reg, true));
      tr.addEventListener('mouseleave', () => highlightRegion(reg, false));
      regionResultTbody.appendChild(tr);
    });
  }

  function highlightRegion(reg, on) {
    const tiles = resultGrid.children;
    for (let r = reg.r1; r <= reg.r2; r += 1) {
      for (let c = reg.c1; c <= reg.c2; c += 1) {
        const tile = tiles[r * Number(colsSelect.value) + c];
        if (tile) tile.classList.toggle('region-highlight', on);
      }
    }
  }

  function showFailure(kind, text) {
    // 无解或服务端拒绝：仅展示结论，不展示任何旧网格与旧核对表。
    showConclusion(kind, text);
    resultGridWrap.hidden = true;
  }

  async function submit() {
    showInputError('');
    const { payload, error } = collectPayload();
    if (error) {
      showInputError(error);
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '反演中…';
    clearResult(); // 提交期间不保留旧结论
    const version = resultVersion;
    try {
      const res = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (version !== resultVersion) return; // 等待期间输入已修改，丢弃该响应
      resultPanel.hidden = false;
      resultGrid.innerHTML = '';
      regionResultTbody.innerHTML = '';
      if (res.ok && data && data.status === 'ok') {
        renderSolution(data);
      } else if (res.ok && data && data.status === 'unsatisfiable') {
        showFailure('bad', data.message || '无法满足全部记录：不存在同时符合所有检测结果的饰砖状态。');
      } else {
        const msg = data && data.message ? data.message : `服务端拒绝（HTTP ${res.status}）`;
        showFailure('bad', `提交被服务端拒绝：${msg}`);
      }
    } catch (err) {
      if (version !== resultVersion) return;
      resultPanel.hidden = false;
      resultGrid.innerHTML = '';
      regionResultTbody.innerHTML = '';
      showFailure('bad', `无法连接服务端，旧结论已作废（${err.message}）`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '提交反演';
    }
  }

  // ---- 事件绑定 ----
  rowsSelect.addEventListener('change', () => { clampRegionsToGrid(); clearResult(); showInputError(''); });
  colsSelect.addEventListener('change', () => { clampRegionsToGrid(); clearResult(); showInputError(''); });
  addRegionBtn.addEventListener('click', () => {
    if (regionsTbody.rows.length >= MAX_REGIONS) return;
    const { rows, cols } = gridDims();
    addRegionRow({ r1: 1, c1: 1, r2: rows, c2: cols, count: 0 });
    clearResult();
    showInputError('');
  });
  submitBtn.addEventListener('click', submit);

  // ---- 初始示例数据（4x4，一组可满足的检测记录）----
  [
    { r1: 1, c1: 1, r2: 4, c2: 4, count: 4 },
    { r1: 1, c1: 1, r2: 2, c2: 4, count: 2 },
    { r1: 1, c1: 1, r2: 4, c2: 2, count: 2 },
  ].forEach(addRegionRow);
})();
