/**
 * 长条（LN）蒸馏：人类到底怎么放长条
 * ==================================================================
 * 之前的蒸馏只留了一个 holdRatio = 4.5%，其余全凭手感写 —— 结果就是
 * 「连续长条」这种反人类产物：一个接一个，中间不给呼吸，
 * 尾巴还紧贴下一个音。
 *
 * 这里把长条的结构性指标全部量出来。注意两个坑：
 *
 *  1. osu!mania 里存在大量**「用长条冒充单点」**的谱面（LN 时长 <1/4 拍），
 *     如果直接池化，会把「长条长度」压到 0.5 拍，学出来的东西全是错的。
 *     所以先按长条占比把谱面分成 rice / mixed / ln 三类，只从 mixed 学。
 *  2. 跨谱面池化会让「第 0 小节」被反复累加，所以每小节统计必须按谱面分开。
 *
 * 输出：tools/_hold_priors.json（只含聚合量）
 */
import fs from 'node:fs';
import path from 'node:path';
import { holdMetrics } from '../js/metrics.js';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const DIR = path.join(ROOT, '_charts');

if (!fs.existsSync(DIR)) {
  console.error('缺少语料目录 tools/_charts —— 先跑 fetch_charts.py');
  process.exit(1);
}

const stars = new Map();
try {
  for (const p of JSON.parse(fs.readFileSync(path.join(ROOT, '_picked.json'), 'utf8'))) {
    stars.set(String(p.id), p.star);
  }
} catch {
  /* 无 _picked.json 就全样本统计 */
}

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
      timing.push({ time: +p[0], beat: +p[1], un: p[6] === undefined ? 1 : +p[6] });
    } else if (section === 'HitObjects') {
      const p = s.split(',');
      const type = +p[3];
      const hold = (type & 128) !== 0;
      objects.push({
        x: +p[0],
        t: +p[2] / 1000,
        hold,
        end: hold && p[5] ? +p[5].split(':')[0] / 1000 : 0,
      });
    }
  }
  return { meta, timing, objects };
}

const P = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const pct = (v) => (v * 100).toFixed(1) + '%';

const rows = [];
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.osu')) continue;
  const { meta, timing, objects } = parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (meta.Mode !== '3' || +(meta.CircleSize || 0) !== 4) continue;
  const un = timing.filter((p) => p.un === 1 && p.beat > 0);
  if (un.length !== 1) continue; // 变速谱：拍长不唯一，指标会歪
  if (objects.length < 120) continue;
  const beat = un[0].beat / 1000;
  const offset = un[0].time / 1000;
  const notes = objects.map((o) => ({
    t: o.t,
    col: Math.min(3, Math.max(0, Math.floor((o.x * 4) / 512))),
    hold: o.hold,
    dur: o.hold ? Math.max(0, o.end - o.t) : 0,
  }));
  rows.push({
    id: f.replace('.osu', ''),
    star: stars.get(f.replace('.osu', '')) ?? null,
    beat,
    notes,
    m: holdMetrics(notes, beat, offset),
  });
}

const say = (cls, list) => {
  const gets = (k) => list.map((r) => r.m[k]);
  console.log(
    `  ${cls.padEnd(6)} ${String(list.length).padStart(3)} 张  ` +
      `占比 ${pct(avg(gets('holdShare'))).padStart(6)}  ` +
      `长度p50 ${P(gets('lenP50'), 0.5).toFixed(2)} 拍  ` +
      `链间距<2拍 ${pct(avg(gets('chainShare'))).padStart(6)}  ` +
      `最长链 ${P(gets('maxChain'), 0.5)}  ` +
      `松手即按 ${pct(avg(gets('tailTight'))).padStart(6)}  ` +
      `尾离网 ${pct(avg(gets('tailOffGrid'))).padStart(6)}  ` +
      `小节p50 ${P(gets('perBarP50'), 0.5)}  连小节 ${P(gets('maxBars'), 0.5)}`
  );
};

const withHold = rows.filter((r) => r.m.holds > 0);
const rice = rows.filter((r) => r.m.holdShare < 0.01);
const mixed = rows.filter((r) => r.m.holdShare >= 0.01 && r.m.holdShare <= 0.15);
const ln = rows.filter((r) => r.m.holdShare > 0.15);

console.log(`样本：${rows.length} 张 4K 谱面，${rows.reduce((s, r) => s + r.m.notes, 0).toLocaleString()} 音符\n`);
console.log('== 按长条占比分类（每类取"每张谱面指标的均值/中位数"，避免个别谱面拉偏）');
say('rice', rice);
say('mixed', mixed);
say('ln', ln);
say('有长条', withHold);

// ---- 从 mixed 里取先验：这才是我们要模仿的手感 ----
const src = mixed.length >= 10 ? mixed : withHold;
const beatsAll = src.map((r) => r.beat);

// 长条长度（只统计 ≥0.5 拍，屏蔽"用长条冒充单点"的写法）
const lens = [];
const headGaps = [];
const tailGaps = [];
let tight = 0;
let offGrid = 0;
let chord = 0;
let heads = 0;
let riceUnder = 0;
const perBarVals = [];
let barAll = 0;
let barWithHold = 0;

for (const r of src) {
  const holds = r.notes.filter((n) => n.hold).sort((a, b) => a.t - b.t);
  const byCol = [[], [], [], []];
  for (const n of r.notes) byCol[n.col].push(n);
  for (const a of byCol) a.sort((x, y) => x.t - y.t);

  const bars = new Map();
  for (const h of holds) {
    if (h.dur / r.beat >= 0.5) lens.push(h.dur / r.beat);
    const b = Math.floor(h.t / (r.beat * 4));
    bars.set(b, (bars.get(b) || 0) + 1);
    const tb = (h.t + h.dur) / r.beat;
    if (Math.abs(tb - Math.round(tb * 4) / 4) > 1 / 16) offGrid++;
    heads++;
    const arr = byCol[h.col];
    const next = arr[arr.indexOf(h) + 1];
    if (next) {
      const g = (next.t - (h.t + h.dur)) / r.beat;
      if (next.t >= h.t + h.dur - 0.001) tailGaps.push(g);
      if (g < 0.35) tight++;
    }
    if (r.notes.some((n) => n.col !== h.col && n.t > h.t + 0.02 && n.t < h.t + h.dur - 0.02)) riceUnder++;
  }
  for (let i = 1; i < holds.length; i++) headGaps.push((holds[i].t - holds[i - 1].t) / r.beat);

  const seen = new Set();
  for (const h of holds) {
    const k = Math.round(h.t * 100);
    if (seen.has(k)) chord++;
    else seen.add(k);
  }

  const barDur = r.beat * 4;
  const span = (r.notes[r.notes.length - 1].t - r.notes[0].t) / barDur;
  for (let i = 0; i < Math.round(span); i++) {
    const v = bars.get(i) || 0;
    perBarVals.push(v);
    barAll++;
    if (v) barWithHold++;
  }
}

console.log('\n== 从 mixed 类蒸馏（每拍长度、长条头间隔都以拍为单位）');
console.log(
  `  长条长度 p10 ${P(lens, 0.1).toFixed(2)}  p25 ${P(lens, 0.25).toFixed(2)}  p50 ${P(lens, 0.5).toFixed(2)}  p90 ${P(lens, 0.9).toFixed(2)}`
);
console.log(
  `  长度 <1 拍 ${pct(lens.filter((x) => x < 1).length / lens.length)}   <1.5 拍 ${pct(lens.filter((x) => x < 1.5).length / lens.length)}   ≥2 拍 ${pct(lens.filter((x) => x >= 2).length / lens.length)}`
);
console.log(
  `  长条头间隔 <1 拍 ${pct(headGaps.filter((x) => x < 1).length / Math.max(1, headGaps.length))}   <2 拍 ${pct(headGaps.filter((x) => x < 2).length / Math.max(1, headGaps.length))}   p50 ${P(headGaps, 0.5).toFixed(2)} 拍`
);
console.log(`  尾巴后同轨间隔 <0.5 拍 ${pct(tight / heads)}   p50 ${P(tailGaps, 0.5).toFixed(2)} 拍`);
console.log(`  尾巴不在 1/4 网格 ${pct(offGrid / heads)}   同时长条 ${pct(chord / heads)}   期间别的轨有音 ${pct(riceUnder / heads)}`);
console.log(`  每小节长条数 p50 ${P(perBarVals, 0.5)} p90 ${P(perBarVals, 0.9)}  有长条的小节 ${pct(barWithHold / barAll)}`);

// 星级分档（在 mixed 内）
const tierOf = (s) => (s === null ? '?' : s < 3 ? '1~3' : s < 4.2 ? '3~4.2' : s < 5.2 ? '4.2~5.2' : '5.2+');
const tiers = new Map();
for (const r of src) {
  const t = tierOf(r.star);
  if (!tiers.has(t)) tiers.set(t, []);
  tiers.get(t).push(r);
}
console.log('\n== mixed 内按星级');
for (const [t, list] of [...tiers.entries()].sort()) {
  console.log(`  ${t.padEnd(7)} ${String(list.length).padStart(3)} 张  长条占比 ${pct(avg(list.map((r) => r.m.holdShare)))}  长度p50 ${P(list.map((r) => r.m.lenP50), 0.5).toFixed(2)}`);
}

const out = {
  source: `osu!mania 4K · ${rows.length} charts · mixed-LN subset ${src.length}`,
  classes: { rice: rice.length, mixed: mixed.length, ln: ln.length },
  holdShare: +avg(src.map((r) => r.m.holdShare)).toFixed(4),
  lenBeats: {
    p10: +P(lens, 0.1).toFixed(2),
    p25: +P(lens, 0.25).toFixed(2),
    p50: +P(lens, 0.5).toFixed(2),
    p90: +P(lens, 0.9).toFixed(2),
    under1: +(lens.filter((x) => x < 1).length / lens.length).toFixed(3),
  },
  headGapBeats: {
    under1: +(headGaps.filter((x) => x < 1).length / Math.max(1, headGaps.length)).toFixed(3),
    under2: +(headGaps.filter((x) => x < 2).length / Math.max(1, headGaps.length)).toFixed(3),
    p50: +P(headGaps, 0.5).toFixed(2),
  },
  tailTight: +(tight / heads).toFixed(3),
  tailGapP50: +P(tailGaps, 0.5).toFixed(2),
  tailOffGrid: +(offGrid / heads).toFixed(3),
  chordHold: +(chord / heads).toFixed(3),
  riceUnderHold: +(riceUnder / heads).toFixed(3),
  perBar: { p50: P(perBarVals, 0.5), p90: P(perBarVals, 0.9) },
  barCoverage: +(barWithHold / barAll).toFixed(3),
  avgBeat: +avg(beatsAll).toFixed(3),
};
fs.writeFileSync(path.join(ROOT, '_hold_priors.json'), JSON.stringify(out, null, 1));
console.log('\n已写出 tools/_hold_priors.json');
