/**
 * 用同一套统计标准，对比"真实谱面"与"自动生成谱面"
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeAudio } from '../js/analyzer.js';
import { generateAll } from '../js/chart.js';
import { PRIORS } from '../js/chart-priors.js';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** 统计一段音符序列（t 秒、col 0..3） */
export function stats(notes, beat, offset) {
  const groups = [];
  const sorted = notes.slice().sort((a, b) => a.t - b.t || a.col - b.col);
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.t - n.t) < 0.001) g.cols.push(n.col);
    else groups.push({ t: n.t, cols: [n.col] });
  }
  const ioi = new Map();
  const phase = new Array(16).fill(0);
  const chordSize = [0, 0, 0, 0, 0];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const beats = (g.t - offset) / beat;
    const slot = Math.min(15, Math.max(0, Math.round((((beats % 1) + 1) % 1) * 16) % 16));
    phase[slot]++;
    chordSize[Math.min(4, g.cols.length)]++;
    if (i > 0) {
      const u = Math.round(((g.t - groups[i - 1].t) / beat) * 16);
      if (u > 0 && u <= 32) ioi.set(u, (ioi.get(u) || 0) + 1);
    }
  }
  // 每小节音符数
  const barDur = beat * 4;
  const bars = new Map();
  for (const n of sorted) {
    const b = Math.floor((n.t - offset) / barDur);
    bars.set(b, (bars.get(b) || 0) + 1);
  }
  const counts = [...bars.values()].sort((a, b) => a - b);
  const q = (p) => counts[Math.round((counts.length - 1) * p)] || 0;

  // 动机重复
  // 节奏型字符串：0 空 / 1 单音 / 2 双押以上 —— 重音也是节奏的一部分
  const rhythmOf = (b) => {
    const arr = new Array(16).fill(0);
    const cnt = new Array(16).fill(0);
    for (const n of sorted) {
      const bb = Math.floor((n.t - offset) / barDur);
      if (bb !== b) continue;
      const pos = Math.round(((n.t - offset) / barDur - bb) * 16) % 16;
      cnt[pos]++;
    }
    for (let i = 0; i < 16; i++) arr[i] = cnt[i] === 0 ? 0 : cnt[i] > 1 ? 2 : 1;
    return arr.join('');
  };
  let same = 0;
  let tot = 0;
  const minB = Math.min(...bars.keys());
  const maxB = Math.max(...bars.keys());
  for (let b = minB; b < maxB; b++) {
    if (!bars.has(b) || !bars.has(b + 1)) continue;
    tot++;
    if (rhythmOf(b) === rhythmOf(b + 1)) same++;
  }

  const ioiTot = [...ioi.values()].reduce((a, b) => a + b, 0) || 1;
  const share = (u) => ((ioi.get(u) || 0) / ioiTot) * 100;
  const groupTot = chordSize.slice(1).reduce((a, b) => a + b, 0) || 1;
  return {
    notes: notes.length,
    quarter: share(4),
    eighth: share(2),
    sixteenth: share(1),
    dotted: share(3),
    phase0: (phase[0] / groupTot) * 100,
    phaseOn: ((phase[0] + phase[4] + phase[8] + phase[12]) / groupTot) * 100,
    chord: ((chordSize[2] + chordSize[3] + chordSize[4]) / groupTot) * 100,
    motif: (same / Math.max(1, tot)) * 100,
    barP50: q(0.5),
    barP90: q(0.9),
  };
}

// ---- 真实谱面（读已下载的 .osu） ----
function parseOsu(text) {
  const lines = text.split(/\r?\n/);
  let section = '';
  const meta = {};
  const timing = [];
  const objs = [];
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      section = s.slice(1, -1);
      continue;
    }
    if (!s || s.startsWith('//')) continue;
    if (section === 'Difficulty' || section === 'General') {
      const i = s.indexOf(':');
      if (i > 0) meta[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    } else if (section === 'TimingPoints') {
      const p = s.split(',');
      timing.push({ t: +p[0], beat: +p[1], un: p[6] === undefined ? 1 : +p[6] });
    } else if (section === 'HitObjects') {
      const p = s.split(',');
      objs.push({ x: +p[0], t: +p[2] });
    }
  }
  const un = timing.filter((p) => p.un === 1 && p.beat > 0);
  if (meta.Mode !== '3' || +meta.CircleSize !== 4 || un.length !== 1) return null;
  return {
    beat: un[0].beat / 1000,
    offset: un[0].t / 1000,
    notes: objs.map((o) => ({ t: o.t / 1000, col: Math.min(3, Math.floor((o.x * 4) / 512)) })),
  };
}

const realAgg = { quarter: 0, eighth: 0, sixteenth: 0, dotted: 0, phase0: 0, phaseOn: 0, chord: 0, motif: 0, barP50: 0, barP90: 0, n: 0 };
const dir = path.join(ROOT, '_charts');
// 语料目录不在时（没跑 fetch_charts）直接用蒸馏好的常量兜底
const hasCorpus = fs.existsSync(dir);
for (const f of hasCorpus ? fs.readdirSync(dir) : []) {
  if (!f.endsWith('.osu')) continue;
  const c = parseOsu(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!c || c.notes.length < 200) continue;
  const s = stats(c.notes, c.beat, c.offset);
  for (const k of ['quarter', 'eighth', 'sixteenth', 'dotted', 'phase0', 'phaseOn', 'chord', 'motif', 'barP50', 'barP90']) {
    realAgg[k] += s[k];
  }
  realAgg.n++;
}
const real = {};
if (hasCorpus && realAgg.n > 0) {
  for (const k of Object.keys(realAgg)) real[k] = k === 'n' ? realAgg.n : realAgg[k] / realAgg.n;
} else {
  // 数值来自 js/chart-priors.js 的蒸馏结果（160 张谱面 / 479,479 音符）
  Object.assign(real, {
    notes: 0,
    quarter: PRIORS.ioi.quarter * 100,
    eighth: PRIORS.ioi.eighth * 100,
    sixteenth: PRIORS.ioi.sixteenth * 100,
    dotted: PRIORS.ioi.dotted * 100,
    phase0: PRIORS.phase[0] * 100,
    phaseOn: (PRIORS.phase[0] + PRIORS.phase[4] + PRIORS.phase[8] + PRIORS.phase[12]) * 100,
    chord: (PRIORS.chordSize[1] + PRIORS.chordSize[2] + PRIORS.chordSize[3]) * 100,
    motif: 20.0, // 重音计入后的实测值（见 README）
    barP50: PRIORS.perBar.p50,
    barP90: PRIORS.perBar.p90,
  });
}

// ---- 自动生成 ----
const raw = fs.readFileSync(process.argv[2]);
const n = raw.length / 2;
const pcm = new Float32Array(n);
for (let i = 0; i < n; i++) pcm[i] = raw.readInt16LE(i * 2) / 32768;
const a = analyzeAudio([pcm], 48000);
const charts = generateAll(a);

const rows = [
  ['真实 4K 谱面', real],
  ...charts.map((c) => [
    '自动 ' + c.name + ' Lv' + c.level,
    stats(c.notes.map((x) => ({ t: x.t, col: x.lane })), a.beatDur, a.firstBeat),
  ]),
];

const fmt = (v) => v.toFixed(1).padStart(5);
console.log('\n谱面          音符  1/4拍  1/8拍  1/16拍  附点   正拍   四正拍位  双押+   动机   小节p50  p90');
for (const [name, s] of rows) {
  console.log(
    name.padEnd(13) +
      String(s.notes).padStart(6) +
      fmt(s.quarter) + fmt(s.eighth) + fmt(s.sixteenth) + fmt(s.dotted) +
      fmt(s.phase0) + fmt(s.phaseOn) + fmt(s.chord) + fmt(s.motif) +
      fmt(s.barP50) + fmt(s.barP90)
  );
}
