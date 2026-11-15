/**
 * Sparebeat 谱面蒸馏
 * ==================================================================
 * 用 js/metrics.js 里那套和自动谱面**完全一样**的尺子量 Sparebeat 官方谱面。
 * 解析细节见 tools/sparebeat.mjs。
 *
 * 输出：tools/_sparebeat_priors.json + 终端报告
 */
import fs from 'node:fs';
import path from 'node:path';
import { chartMetrics, holdMetrics } from '../js/metrics.js';
import { parseSparebeat } from './sparebeat.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const DIR = path.join(ROOT, '_sbmaps');

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const rows = [];
for (const f of files) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  } catch {
    continue;
  }
  if (!data.map) continue;
  for (const diff of ['easy', 'normal', 'hard']) {
    const p = parseSparebeat(data, diff);
    if (!p || p.notes.length < 50) continue;
    const span = p.notes[p.notes.length - 1].t - p.notes[0].t || 1;
    rows.push({
      id: data.id || f.replace('.json', ''),
      title: data.title,
      level: (data.level || {})[diff] ?? null,
      diff,
      bpm: p.bpm,
      beat: p.beat,
      offset: p.offset,
      bpmChanges: p.bpmChanges,
      nps: p.notes.length / span,
      notes: p.notes,
      cm: chartMetrics(p.notes, p.beat, p.offset),
      hm: holdMetrics(p.notes, p.beat, p.offset),
    });
  }
}

const med = (list, get) => {
  if (!list.length) return 0;
  const s = list.map(get).sort((a, b) => a - b);
  return s[Math.round((s.length - 1) * 0.5)];
};
const P = (v) => (v * 100).toFixed(1);
const F = (v) => v.toFixed(2);

console.log(`Sparebeat：${files.length} 首，${rows.length} 张谱面\n`);
console.log('难度  张数  等级中位   音符    NPS   1/4拍   1/8拍  更长   正拍   双押   attack  长条   长p50  连条  即按');
for (const diff of ['easy', 'normal', 'hard']) {
  const list = rows.filter((r) => r.diff === diff);
  const g = (k) => med(list, (r) => r.cm[k]);
  const gh = (k) => med(list, (r) => r.hm[k]);
  console.log(
    `${diff.padEnd(7)}${String(list.length).padStart(4)}  ` +
      `${String(med(list, (r) => r.level ?? 0)).padStart(6)}  ` +
      `${String(med(list, (r) => r.notes.length)).padStart(6)}  ` +
      `${F(med(list, (r) => r.nps)).padStart(5)}  ` +
      `${P(g('quarter')).padStart(6)}  ${P(g('eighth')).padStart(6)}  ${P(g('longer')).padStart(5)}  ` +
      `${P(g('onBeat')).padStart(5)}  ${P(g('chord')).padStart(5)}  ` +
      `${P(med(list, (r) => r.notes.filter((n) => n.attack).length / r.notes.length)).padStart(6)}  ` +
      `${P(gh('holdShare')).padStart(5)}  ${F(gh('lenP50')).padStart(5)}  ${P(gh('chainShare')).padStart(5)}  ${P(gh('tailTight')).padStart(5)}`
  );
}

// 长条结构：是否"成段"出现
console.log('\n== 长条在小节上的分布（hard）');
const hard = rows.filter((r) => r.diff === 'hard');
const cov = [];
const streak = [];
for (const r of hard) {
  const barDur = r.beat * 4;
  const set = new Set();
  for (const n of r.notes) if (n.hold) set.add(Math.floor((n.t - r.offset) / barDur));
  const total = Math.round((r.notes[r.notes.length - 1].t - r.notes[0].t) / barDur) || 1;
  cov.push(set.size / total);
  const keys = [...set].sort((a, b) => a - b);
  let best = 0;
  let cur = 0;
  let prev = null;
  for (const b of keys) {
    cur = prev !== null && b === prev + 1 ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = b;
  }
  streak.push(best);
}
console.log(`  含长条的小节占比 中位 ${P(med(cov, (x) => x))}`);
console.log(`  最长连续含长条小节 中位 ${med(streak, (x) => x)}`);

// 有长条的谱面 vs 没有
const withHold = hard.filter((r) => r.hm.holds > 0);
console.log(`  含长条的 hard 谱面 ${withHold.length}/${hard.length}`);

// 长条长度分布（全部 hard 谱面池化）
const lens = [];
const gaps = [];
for (const r of withHold) {
  const hs = r.notes.filter((n) => n.hold).sort((a, b) => a.t - b.t);
  for (const h of hs) lens.push(h.dur / r.beat);
  for (let i = 1; i < hs.length; i++) gaps.push((hs[i].t - hs[i - 1].t) / r.beat);
}
const q = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.round((arr.length - 1) * p)] : 0);
console.log(`\n== 长条长度（拍）p10 ${F(q(lens, 0.1))} p25 ${F(q(lens, 0.25))} p50 ${F(q(lens, 0.5))} p75 ${F(q(lens, 0.75))} p90 ${F(q(lens, 0.9))}`);
console.log(`   长度 <1 拍 ${P(lens.filter((x) => x < 1).length / lens.length)}  <2 拍 ${P(lens.filter((x) => x < 2).length / lens.length)}`);
console.log(`   长条头间隔 <1 拍 ${P(gaps.filter((x) => x < 1).length / Math.max(1, gaps.length))}  p50 ${F(q(gaps, 0.5))}`);
console.log(`   同一时刻两个长条 ${P(withHold.reduce((s, r) => s + r.hm.chordHold, 0) / Math.max(1, withHold.reduce((s, r) => s + r.hm.holds, 0)))}`);

const out = {
  source: `sparebeat.com · ${files.length} songs · ${rows.length} charts`,
  byDiff: ['easy', 'normal', 'hard'].map((diff) => {
    const list = rows.filter((r) => r.diff === diff);
    return {
      diff,
      charts: list.length,
      levelP50: med(list, (r) => r.level ?? 0),
      notesP50: med(list, (r) => r.notes.length),
      npsP50: +med(list, (r) => r.nps).toFixed(2),
      quarter: +med(list, (r) => r.cm.quarter).toFixed(3),
      eighth: +med(list, (r) => r.cm.eighth).toFixed(3),
      longer: +med(list, (r) => r.cm.longer).toFixed(3),
      onBeat: +med(list, (r) => r.cm.onBeat).toFixed(3),
      chord: +med(list, (r) => r.cm.chord).toFixed(3),
      holdShare: +med(list, (r) => r.hm.holdShare).toFixed(3),
      holdLenP50: +med(list, (r) => r.hm.lenP50).toFixed(2),
      tailTight: +med(list, (r) => r.hm.tailTight).toFixed(3),
      barCV: +med(list, (r) => r.cm.barCV).toFixed(3),
      motif: +med(list, (r) => r.cm.motif).toFixed(3),
      motifSim: +med(list, (r) => r.cm.motifSim).toFixed(3),
    };
  }),
  holdLenBeats: {
    p10: +q(lens, 0.1).toFixed(2),
    p25: +q(lens, 0.25).toFixed(2),
    p50: +q(lens, 0.5).toFixed(2),
    p75: +q(lens, 0.75).toFixed(2),
    p90: +q(lens, 0.9).toFixed(2),
    under2: +(lens.filter((x) => x < 2).length / lens.length).toFixed(3),
  },
  holdBarCoverage: +med(cov, (x) => x).toFixed(3),
  holdStreakBars: med(streak, (x) => x),
  chartsWithHold: withHold.length,
};
fs.writeFileSync(path.join(ROOT, '_sparebeat_priors.json'), JSON.stringify(out, null, 1));
console.log('\n已写出 tools/_sparebeat_priors.json');
