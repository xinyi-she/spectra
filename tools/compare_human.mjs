/**
 * 人类谱面 vs 自动谱面：同一把尺子量
 * ==================================================================
 * 输入：
 *   tools/_charts/*.osu      真实 osu!mania 4K 谱面（只读，不入库）
 *   tools/_gen_charts.json   本站生成的谱面（tools/holdstats.html?dump=1 导出）
 *
 * 输出：终端表格 + tools/compare_report.md
 *
 * 统计口径：真实谱面取**每张谱面指标的分布**（中位数 / 四分位），
 * 而不是把所有音符池化 —— 否则长条型谱面会污染"普通谱面"的结论。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chartMetrics, holdMetrics } from '../js/metrics.js';
import { parseSparebeat } from './sparebeat.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const DIR = path.join(ROOT, '_charts');

function parse(text) {
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
    if (section === 'General' || section === 'Metadata' || section === 'Difficulty') {
      const i = s.indexOf(':');
      if (i > 0) meta[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    } else if (section === 'TimingPoints') {
      const p = s.split(',');
      timing.push({ t: +p[0], beat: +p[1], un: p[6] === undefined ? 1 : +p[6] });
    } else if (section === 'HitObjects') {
      const p = s.split(',');
      const type = +p[3];
      const hold = (type & 128) !== 0;
      objs.push({ x: +p[0], t: +p[2] / 1000, hold, end: hold && p[5] ? +p[5].split(':')[0] / 1000 : 0 });
    }
  }
  return { meta, timing, objs };
}

const stars = new Map();
try {
  for (const p of JSON.parse(fs.readFileSync(path.join(ROOT, '_picked.json'), 'utf8'))) {
    stars.set(String(p.id), p.star);
  }
} catch {}

const real = [];
for (const f of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
  if (!f.endsWith('.osu')) continue;
  const { meta, timing, objs } = parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (meta.Mode !== '3' || +(meta.CircleSize || 0) !== 4) continue;
  const un = timing.filter((p) => p.un === 1 && p.beat > 0);
  if (un.length !== 1 || objs.length < 120) continue;
  const beat = un[0].beat / 1000;
  const offset = un[0].t / 1000;
  const notes = objs.map((o) => ({
    t: o.t,
    col: Math.min(3, Math.max(0, Math.floor((o.x * 4) / 512))),
    hold: o.hold,
    dur: o.hold ? Math.max(0, o.end - o.t) : 0,
  }));
  const cm = chartMetrics(notes, beat, offset);
  const hm = holdMetrics(notes, beat, offset);
  const span = (notes[notes.length - 1].t - notes[0].t) || 1;
  real.push({ id: f.replace('.osu', ''), star: stars.get(f.replace('.osu', '')) ?? null, beat, cm, hm, nps: notes.length / span });
}

const med = (arr, k) => {
  if (!arr.length) return 0;
  const s = arr.map((r) => (typeof k === 'function' ? k(r) : r[k])).sort((a, b) => a - b);
  return s[Math.round((s.length - 1) * 0.5)];
};

// ---- Sparebeat 官方谱面（同一把尺子） ----
const SB_DIR = path.join(ROOT, '_sbmaps');
const sb = [];
if (fs.existsSync(SB_DIR)) {
  for (const f of fs.readdirSync(SB_DIR)) {
    if (!f.endsWith('.json')) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(SB_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    for (const diff of ['easy', 'normal', 'hard']) {
      const p = parseSparebeat(data, diff);
      if (!p || p.notes.length < 50) continue;
      const span = p.notes[p.notes.length - 1].t - p.notes[0].t || 1;
      sb.push({
        diff,
        level: (data.level || {})[diff] ?? null,
        nps: p.notes.length / span,
        cm: chartMetrics(p.notes, p.beat, p.offset),
        hm: holdMetrics(p.notes, p.beat, p.offset),
      });
    }
  }
}

const gen = JSON.parse(fs.readFileSync(path.join(ROOT, '_gen_charts.json'), 'utf8'));
const mine = gen.charts.map((c) => {
  const notes = c.notes.map((n) => ({ t: n.t, col: n.lane, hold: n.type === 'hold', dur: n.dur || 0 }));
  const span = (c.notes[c.notes.length - 1].t - c.notes[0].t) || 1;
  return {
    name: `${c.name} Lv${c.level}`,
    cm: chartMetrics(notes, gen.beatDur, c.beatOffset),
    hm: holdMetrics(notes, gen.beatDur, c.beatOffset),
    nps: c.notes.length / span,
  };
});

const mixed = real.filter((r) => r.hm.holdShare >= 0.01 && r.hm.holdShare <= 0.15);
const P = (v) => (v * 100).toFixed(1);
const F = (v) => v.toFixed(2);

const COLS = [
  ['歌曲', () => ''],
  ['NPS', (r) => F(r.nps)],
  ['1/4拍', (r) => P(r.cm.quarter)],
  ['1/8拍', (r) => P(r.cm.eighth)],
  ['1/16拍', (r) => P(r.cm.sixteenth)],
  ['更长', (r) => P(r.cm.longer)],
  ['四分位', (r) => P(r.cm.onBeat)],
  ['正拍音', (r) => P(r.cm.downbeat)],
  ['双押', (r) => P(r.cm.chord)],
  ['jack', (r) => P(r.cm.jack)],
  ['动机', (r) => P(r.cm.motif)],
  ['相似', (r) => P(r.cm.motifSim)],
  ['密度CV', (r) => F(r.cm.barCV)],
  ['同手串', (r) => F(r.cm.handRunP50)],
  ['长条', (r) => P(r.hm.holdShare)],
  ['长p50', (r) => F(r.hm.lenP50)],
  ['连条', (r) => P(r.hm.chainShare)],
  ['即按', (r) => P(r.hm.tailTight)],
  ['条小节', (r) => P(r.hm.holdCoverage)],
];

const rows = [];
for (const [label, diff] of [['Sparebeat easy', 'easy'], ['Sparebeat normal', 'normal'], ['Sparebeat hard', 'hard']]) {
  const list = sb.filter((r) => r.diff === diff);
  if (list.length >= 3) rows.push([`${label} (${list.length})`, null, list]);
}
rows.push(['osu!mania·全部 (' + real.length + '张)', null, real]);
const tiers = [
  ['≤3★', (s) => s !== null && s < 3],
  ['osu 3~4.2★', (s) => s !== null && s >= 3 && s < 4.2],
  ['osu 4.2~5.2★', (s) => s !== null && s >= 4.2 && s < 5.2],
  ['osu 5.2★+', (s) => s !== null && s >= 5.2],
];
for (const [label, pred] of tiers) {
  const list = real.filter((r) => pred(r.star));
  if (list.length >= 3) rows.push([`${label} (${list.length}张)`, null, list]);
}
rows.push(['osu·混合长条 (' + mixed.length + '张)', null, mixed]);
for (const m of mine) rows.push(['本作 ' + m.name, m, null]);

const head = COLS.map((c) => c[0]);
const lines = [];
lines.push('| ' + head.join(' | ') + ' |');
lines.push('|' + head.map(() => '---').join('|') + '|');
console.log('\n' + head.map((h) => h.padStart(9)).join(''));
for (const [label, single, list] of rows) {
  const cells = COLS.map(([, get], i) => {
    if (i === 0) return label;
    if (single) return get(single);
    return med(list, (r) => Number(get(r)));
  });
  console.log(cells.map((c, i) => (i === 0 ? c.padEnd(24) : String(c).padStart(9))).join(''));
  lines.push('| ' + cells.join(' | ') + ' |');
}

const md = [
  '# 人类谱面 vs 自动谱面',
  '',
  `Sparebeat 样本：${sb.length} 张官方谱面（三档难度）。`,
  `osu!mania 样本：${real.length} 张 4K 谱面（单 BPM、≥120 音符）。`,
  `自动样本：${gen.song}（${gen.bpm.toFixed(1)} BPM）的三档难度。`,
  '',
  '表内均为**每张谱面指标的中位数**。',
  '',
  ...lines,
  '',
  '## 怎么读',
  '',
  '- **1/4拍 / 1/8拍 / 1/16拍 / 更长**：相邻音群的时值构成。人写谱以 1/4 拍（十六分网格上的四分位）为主，但留大量空隙。',
  '- **正拍**：音群落在 1/4 拍整点上的比例，重音感的来源。',
  '- **双押**：一次两个键以上的音群占比。',
  '- **jack**：单音→单音且同键、间距 ≤1/4 拍的比例。',
  '- **动机**：相邻小节节奏型完全相同的比例。',
  '- **密度CV**：每小节音符数的变异系数，衡量段落起伏（越大起伏越明显）。',
  '- **同手串**：同一只手连续击打的最长串（中位数）。4K 里超过 6 连开始累。',
  '- **长条 / 长p50 / 连条 / 即按**：长条占比、长度中位数（拍）、与前一个长条头间隔 <2 拍的比例、尾巴后 0.35 拍内还有同轨音的比例。',
  '',
  '> 「连条」和「即按」这两列是这次改动的核心：人类谱面在 osu!mania 里允许密集连续长条（松手只扣分），',
  '> 本作松手早于尾巴 0.3 拍直接 MISS，同样的密度手感完全不同，所以这两列我们是**故意低于人类**的。',
].join('\n');

fs.writeFileSync(path.join(ROOT, 'compare_report.md'), md);
console.log('\n已写出 tools/compare_report.md');
