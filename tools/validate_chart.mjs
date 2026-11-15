import fs from 'node:fs';
import { analyzeAudio } from '../js/analyzer.js';
import { generateAll } from '../js/chart.js';

/** 结构校验：网格对齐 / 重复音 / 长条重叠 / 密度上限 */
function validate(chart, a) {
  const step = a.beatDur / 8;
  let offGrid = 0;
  let p90 = 0;
  const offs = [];
  for (const n of chart.notes) {
    const k = Math.round((n.t - chart.beatOffset) / step);
    const d = Math.abs(n.t - (chart.beatOffset + k * step)) * 1000;
    offs.push(d);
    if (d > 3) offGrid++;
  }
  offs.sort((x, y) => x - y);
  p90 = offs[Math.floor(offs.length * 0.9)] || 0;

  const seen = new Set();
  let dup = 0;
  for (const n of chart.notes) {
    const k = n.t.toFixed(3) + ':' + n.lane;
    if (seen.has(k)) dup++;
    seen.add(k);
  }

  const holds = chart.notes.filter((n) => n.type === 'hold');
  let overlap = 0;
  for (const h of holds) {
    if (chart.notes.some((x) => x !== h && x.lane === h.lane && x.t > h.t + 0.01 && x.t < h.t + h.dur)) overlap++;
  }

  let badLane = 0;
  for (const n of chart.notes) if (!(n.lane >= 0 && n.lane < 4)) badLane++;

  // 1 秒窗口最大音符数
  let max1 = 0;
  const t = chart.notes.map((n) => n.t);
  for (let i = 0; i < t.length; i++) {
    let k = 0;
    for (let j = i; j < t.length && t[j] - t[i] < 1; j++) k++;
    if (k > max1) max1 = k;
  }

  return {
    notes: chart.noteCount,
    lv: chart.level,
    nps: chart.nps,
    offGrid,
    p90: +p90.toFixed(2),
    dup,
    overlap,
    badLane,
    holds: holds.length,
    max1,
    cap: chart.maxNps,
  };
}

for (const f of process.argv.slice(2)) {
  const raw = fs.readFileSync(f);
  const n = raw.length / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = raw.readInt16LE(i * 2) / 32768;
  const a = analyzeAudio([pcm], 48000);
  console.log('\n== ' + f + '  BPM ' + a.bpm + '  ' + a.duration.toFixed(0) + 's');
  for (const c of generateAll(a)) {
    const r = validate(c, a);
    const bad = [];
    if (r.dup) bad.push('重复音 ' + r.dup);
    if (r.overlap) bad.push('长条重叠 ' + r.overlap);
    if (r.badLane) bad.push('非法轨道 ' + r.badLane);
    if (r.offGrid) bad.push('偏离网格 ' + r.offGrid);
    if (r.max1 > Math.ceil(r.cap)) bad.push('超密度上限 ' + r.max1 + '>' + Math.ceil(r.cap));
    console.log(
      '  ' + c.name.padEnd(7) + 'Lv' + String(r.lv).padEnd(3) +
      'notes=' + String(r.notes).padEnd(5) +
      'nps=' + String(r.nps).padEnd(5) +
      'p90=' + String(r.p90).padStart(5) + 'ms  ' +
      'max1s=' + String(r.max1).padStart(3) + '/' + r.cap +
      '  holds=' + String(r.holds).padStart(3) +
      (bad.length ? '   ❌ ' + bad.join(', ') : '   ✓')
    );
  }
}
