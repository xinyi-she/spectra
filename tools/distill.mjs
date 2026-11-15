/**
 * 谱面蒸馏：从真实 4K 谱面里统计节奏与键位规律
 * ------------------------------------------------------------------
 * 只输出**聚合统计量**（分布、转移概率），不含任何原谱内容。
 *
 * 关心的问题：
 *  1. 人类写谱时用哪些时值？（1/4、1/8、1/16、三连？）
 *  2. 音符落在拍内什么位置？（正拍 / 半拍 / 反拍 / 十六分）
 *  3. 双押出现在什么位置？多大的双押？
 *  4. 相邻三个音的键位转移概率（键位"语汇"）
 *  5. 一小节的节奏型有多容易被重复（动机感）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const DIR = path.join(ROOT, '_charts');

function parse(text) {
  const lines = text.split(/\r?\n/);
  let section = '';
  const meta = {};
  const timing = [];
  const objects = [];
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      section = s.slice(1, -1);
      continue;
    }
    if (!s || s.startsWith('//')) continue;
    if (section === 'General' || section === 'Metadata' || section === 'Difficulty') {
      const i = s.indexOf(':');
      if (i > 0) meta[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    } else if (section === 'TimingPoints') {
      const p = s.split(',');
      timing.push({ time: +p[0], beat: +p[1], uninherited: p[6] === undefined ? 1 : +p[6] });
    } else if (section === 'HitObjects') {
      const p = s.split(',');
      const x = +p[0];
      const t = +p[2];
      const type = +p[3];
      objects.push({ x, t, hold: (type & 128) !== 0, end: p[5] && p[5].includes(':') ? +p[5].split(':')[0] : 0 });
    }
  }
  return { meta, timing, objects };
}

const charts = [];
let skipped = 0;
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.osu')) continue;
  const { meta, timing, objects } = parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const keys = +(meta.CircleSize || 0);
  if (meta.Mode !== '3' || keys !== 4) {
    skipped++;
    continue;
  }
  const un = timing.filter((p) => p.uninherited === 1 && p.beat > 0);
  if (un.length !== 1) {
    skipped++; // 变速谱不参与统计（影响一致性，样本里占少数）
    continue;
  }
  if (objects.length < 120) {
    skipped++;
    continue;
  }
  const beat = un[0].beat;
  const offset = un[0].time / 1000;
  charts.push({
    id: f.replace('.osu', ''),
    bpm: 60000 / beat,
    offset,
    beat: beat / 1000,
    notes: objects.map((o) => ({
      t: o.t / 1000,
      col: Math.min(3, Math.max(0, Math.floor((o.x * 4) / 512))),
      hold: o.hold,
    })),
  });
}

console.log(`解析 ${charts.length} 张 4K 谱（跳过 ${skipped}）`);
const totalNotes = charts.reduce((s, c) => s + c.notes.length, 0);
console.log(`总音符 ${totalNotes.toLocaleString()}，平均 BPM ${Math.round(charts.reduce((s, c) => s + c.bpm, 0) / charts.length)}`);

// ---------------- 统计容器 ----------------
const ioiBuckets = new Map(); // 以 1/16 拍为单位
const phaseHist = new Array(16).fill(0); // 拍内 16 分位置
const chordBySize = [0, 0, 0, 0, 0];
const chordPhase = new Array(16).fill(0);
const allPhase = new Array(16).fill(0);
const laneUse = [0, 0, 0, 0];
const trigram = new Map(); // "a,b" -> [c]
const jackAt = { fast: 0, fastTotal: 0, slow: 0, slowTotal: 0 };
const perBarCounts = [];
const motifRepeat = { same: 0, total: 0 };
const holdRatio = { holds: 0, total: 0 };
const gapHist = [];

function bump(map, k, v = 1) {
  map.set(k, (map.get(k) || 0) + v);
}

for (const c of charts) {
  const notes = c.notes;
  // 分组：同时刻的音 = 一个和弦
  const groups = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.t - n.t) < 0.001) g.cols.push(n.col);
    else groups.push({ t: n.t, cols: [n.col] });
  }

  for (const n of notes) {
    laneUse[n.col]++;
    holdRatio.total++;
    if (n.hold) holdRatio.holds++;
  }

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const beats = (g.t - c.offset) / c.beat;
    const phase = ((beats % 1) + 1) % 1;
    const slot = Math.min(15, Math.round(phase * 16) % 16);
    allPhase[slot]++;
    if (g.cols.length > 1) chordPhase[slot]++;
    chordBySize[Math.min(4, g.cols.length)]++;

    if (i > 0) {
      const prev = groups[i - 1];
      const dtBeats = (g.t - prev.t) / c.beat;
      const unit = Math.round(dtBeats * 16); // 以 1/16 拍为单位（4 = 1/4 拍）
      // 不要截断：只统计 ≤1/4 拍的间隔会把长间隔从分母里剔掉，比例被整体抬高
      if (unit > 0 && unit <= 64) bump(ioiBuckets, unit);
      gapHist.push(dtBeats);

      // jack：单音 -> 单音，且间距在 1/4 拍内
      if (g.cols.length === 1 && prev.cols.length === 1) {
        const same = g.cols[0] === prev.cols[0];
        if (dtBeats <= 0.26) {
          jackAt.fastTotal++;
          if (same) jackAt.fast++;
        } else {
          jackAt.slowTotal++;
          if (same) jackAt.slow++;
        }
      }
    }

    // 键位三元组：只统计单音组
    if (g.cols.length === 1 && i >= 2 && groups[i - 1].cols.length === 1 && groups[i - 2].cols.length === 1) {
      const k = `${groups[i - 2].cols[0]},${groups[i - 1].cols[0]}`;
      if (!trigram.has(k)) trigram.set(k, [0, 0, 0, 0]);
      trigram.get(k)[g.cols[0]]++;
    }
  }

  // 每小节音符数（4/4）
  const barDur = c.beat * 4;
  const firstBar = Math.floor(c.offset / barDur);
  const bars = new Map();
  for (const n of notes) {
    const b = Math.floor((n.t - c.offset) / barDur);
    bars.set(b, (bars.get(b) || 0) + 1);
  }
  for (const [, v] of bars) perBarCounts.push(v);

  // 动机重复：相邻两小节的 16 分节奏串是否一致
  const rhythmOf = (b) => {
    const arr = new Array(16).fill(0);
    for (const n of notes) {
      const bb = Math.floor((n.t - c.offset) / barDur);
      if (bb !== b) continue;
      const pos = Math.round(((n.t - c.offset) / barDur - bb) * 16) % 16;
      arr[pos] = 1;
    }
    return arr.join('');
  };
  const maxBar = Math.max(...bars.keys());
  for (let b = firstBar; b + 1 <= maxBar; b++) {
    if (!bars.has(b) || !bars.has(b + 1)) continue;
    motifRepeat.total++;
    if (rhythmOf(b) === rhythmOf(b + 1)) motifRepeat.same++;
  }
}

// ---------------- 输出 ----------------
const sum = (a) => a.reduce((x, y) => x + y, 0);
const norm = (a) => {
  const s = sum(a) || 1;
  return a.map((v) => +(v / s).toFixed(4));
};

const ioiSorted = [...ioiBuckets.entries()].sort((a, b) => b[1] - a[1]);
const ioiTotal = sum([...ioiBuckets.values()]);
console.log('\n== 相邻音符时值分布（按 1/16 拍为单位）');
for (const [u, n] of ioiSorted.slice(0, 10)) {
  const label = u === 16 ? '1 拍' : u === 8 ? '1/2 拍' : u === 4 ? '1/4 拍' : u === 2 ? '1/8 拍' : u === 12 ? '3/4 拍' : u === 6 ? '3/8 拍' : u === 1 ? '1/16 拍' : u === 3 ? '3/16 拍' : u + '/16 拍';
  console.log(`  ${label.padEnd(9)} ${((n / ioiTotal) * 100).toFixed(1)}%`);
}

console.log('\n== 拍内位置分布（16 分格，0 = 正拍）');
console.log('  ' + norm(allPhase).map((v, i) => `${i}:${(v * 100).toFixed(0)}%`).join(' '));

console.log('\n== 和弦');
const chordTotal = sum(chordBySize);
console.log(`  单音 ${((chordBySize[1] / chordTotal) * 100).toFixed(1)}%  双押 ${((chordBySize[2] / chordTotal) * 100).toFixed(1)}%  三押 ${((chordBySize[3] / chordTotal) * 100).toFixed(1)}%  四押 ${((chordBySize[4] / chordTotal) * 100).toFixed(2)}%`);
console.log('  双押以上在各位置的占比：' + norm(chordPhase).map((v, i) => `${i}:${(v * 100).toFixed(0)}%`).join(' '));

console.log('\n== 键位分布 ' + norm(laneUse).map((v) => (v * 100).toFixed(1) + '%').join(' / '));
console.log(`== jack（同键连打）  快(<1/4拍) ${((jackAt.fast / jackAt.fastTotal) * 100).toFixed(1)}%   慢 ${((jackAt.slow / jackAt.slowTotal) * 100).toFixed(1)}%`);
console.log(`== 长条占音符 ${((holdRatio.holds / holdRatio.total) * 100).toFixed(1)}%`);
console.log(`== 相邻小节节奏型完全相同 ${((motifRepeat.same / motifRepeat.total) * 100).toFixed(1)}%`);

const pb = perBarCounts.slice().sort((a, b) => a - b);
const q = (p) => pb[Math.round((pb.length - 1) * p)];
console.log(`== 每小节音符数  p10 ${q(0.1)}  p50 ${q(0.5)}  p90 ${q(0.9)}  p99 ${q(0.99)}`);

// 最常见的键位转移
const triSorted = [...trigram.entries()]
  .map(([k, v]) => ({ k, v, n: sum(v) }))
  .sort((a, b) => b.n - a.n);
console.log('\n== 最常见键位三元组（前 12）');
for (const t of triSorted.slice(0, 12)) {
  const top = t.v.map((x, i) => [i, x]).sort((a, b) => b[1] - a[1])[0];
  console.log(`  ${t.k} -> 常见 ${top[0]}  (${t.n} 次, ${((top[1] / t.n) * 100).toFixed(0)}%)`);
}

// 保存供谱面生成使用
const priors = {
  source: `osu!mania 4K, ${charts.length} charts, ${totalNotes} notes`,
  ioi: ioiSorted.slice(0, 8).map(([u, n]) => ({ unit: u, w: +(n / ioiTotal).toFixed(4) })),
  phase: norm(allPhase),
  chordPhase: norm(chordPhase),
  chordSize: [1, 2, 3, 4].map((i) => +(chordBySize[i] / chordTotal).toFixed(4)),
  laneUse: norm(laneUse),
  jackFast: +(jackAt.fast / jackAt.fastTotal).toFixed(4),
  jackSlow: +(jackAt.slow / jackAt.slowTotal).toFixed(4),
  holdRatio: +(holdRatio.holds / holdRatio.total).toFixed(4),
  motifRepeat: +(motifRepeat.same / motifRepeat.total).toFixed(4),
  perBar: { p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99) },
  trigram: triSorted.slice(0, 48).map((t) => ({ prev: t.k, next: norm(t.v) })),
};
fs.writeFileSync(path.join(ROOT, '_priors.json'), JSON.stringify(priors, null, 1));
console.log('\n已写出 tools/_priors.json');
