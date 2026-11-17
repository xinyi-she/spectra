import fs from 'node:fs';
import { analyzeAudio } from '../js/analyzer.js';
import { generateAll } from '../js/chart.js';

/** 谱面形态学诊断：4K 谱面的手感主要由这些指标决定 */
function analyzePatterns(chart, beatDur) {
  const notes = chart.notes.slice().sort((a, b) => a.t - b.t || a.lane - b.lane);
  const step = beatDur / 8; // 1/8 拍

  // 按时间分组（同刻 = 和弦）
  const groups = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.t - n.t) < 0.02) g.lanes.push(n.lane);
    else groups.push({ t: n.t, lanes: [n.lane] });
  }

  let jack = 0;      // 同键连打（相邻两音同 lane 且快速）
  let trill = 0;     // 两键交替
  const moveDist = [0, 0, 0, 0];
  const laneUse = [0, 0, 0, 0];
  let left = 0, right = 0;
  let sameHand = 0, crossHand = 0;

  for (let i = 1; i < groups.length; i++) {
    const a = groups[i - 1], b = groups[i];
    const dt = b.t - a.t;
    if (a.lanes.length === 1 && b.lanes.length === 1) {
      const d = Math.abs(b.lanes[0] - a.lanes[0]);
      // 只有"快速连续"才算 jack：间隔超过 0.6 拍的同键重复，手感上完全不算
      const quick = dt < beatDur * 0.6;
      if (quick) {
        moveDist[d]++;
        if (d === 0) jack++;
      }
      const aL = a.lanes[0] < 2, bL = b.lanes[0] < 2;
      if (aL === bL) sameHand++; else crossHand++;
    }
    // trill：连续 4 个单音呈 ABAB 且等间隔
    if (i >= 3) {
      const p2 = groups[i - 3], p1 = groups[i - 2], p0 = groups[i - 1];
      if (
        p2.lanes.length === 1 && p1.lanes.length === 1 && p0.lanes.length === 1 && b.lanes.length === 1 &&
        p2.lanes[0] === b.lanes[0] && p1.lanes[0] === p0.lanes[0] &&
        p2.lanes[0] !== p1.lanes[0] &&
        Math.abs((p1.t - p2.t) - (b.t - p0.t)) < step * 0.6
      ) trill++;
    }
    // 和弦跨手
    if (b.lanes.length >= 2) {
      const hasL = b.lanes.some((l) => l < 2);
      const hasR = b.lanes.some((l) => l >= 2);
      if (hasL && hasR) crossHand++;
    }
  }

  for (const n of notes) {
    laneUse[n.lane]++;
    if (n.lane < 2) left++; else right++;
  }

  // pattern 重复度：4 音窗口
  const windows = new Map();
  for (let i = 0; i + 3 < notes.length; i++) {
    const w = notes.slice(i, i + 4);
    const sig = w.map((n) => n.lane).join('');
    windows.set(sig, (windows.get(sig) || 0) + 1);
  }
  const top = [...windows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // 同 lane 连续出现 3 次以上（真的很卡手）
  let tripleJack = 0;
  for (let i = 2; i < notes.length; i++) {
    if (notes[i].lane === notes[i - 1].lane && notes[i].lane === notes[i - 2].lane) {
      if (notes[i].t - notes[i - 2].t < beatDur * 1.2) tripleJack++;
    }
  }

  const chords = groups.filter((g) => g.lanes.length >= 2).length;
  const chordDist = {};
  for (const g of groups) if (g.lanes.length >= 2) {
    const k = g.lanes.slice().sort().join('-');
    chordDist[k] = (chordDist[k] || 0) + 1;
  }
  const adjacentChords = Object.entries(chordDist)
    .filter(([k]) => k === '0-1' || k === '2-3' || k === '1-2' || k === '0-2' || k === '1-3')
    .reduce((s, [, v]) => s + v, 0);

  // 间隔分布（决定"有没有节奏层次"）
  const gaps = { '1/16': 0, '1/8': 0, '1/4': 0, '1/2+': 0 };
  for (let i = 1; i < groups.length; i++) {
    const r = (groups[i].t - groups[i - 1].t) / beatDur;
    if (r < 0.19) gaps['1/16']++;
    else if (r < 0.38) gaps['1/8']++;
    else if (r < 0.75) gaps['1/4']++;
    else gaps['1/2+']++;
  }

  const total = groups.length;
  const single = groups.filter((g) => g.lanes.length === 1).length;
  return {
    notes: chart.noteCount,
    groups: total,
    chords,
    chordPct: +(chords / total * 100).toFixed(1),
    adjacentChordPct: chords ? +(adjacentChords / chords * 100).toFixed(1) : 0,
    chordDist,
    jackPct: single ? +(jack / Math.max(1, single) * 100).toFixed(1) : 0,
    tripleJack,
    trillPct: single ? +(trill / single * 100).toFixed(1) : 0,
    moveDist: moveDist.map((v) => {
      const s = moveDist.reduce((a, b) => a + b, 0);
      return s ? +(v / s * 100).toFixed(1) : 0;
    }),
    laneBalance: laneUse.map((v) => +(v / notes.length * 100).toFixed(1)),
    handBalance: [+(left / notes.length * 100).toFixed(1), +(right / notes.length * 100).toFixed(1)],
    sameHandPct: sameHand + crossHand ? +(sameHand / (sameHand + crossHand) * 100).toFixed(1) : 0,
    topPatterns: top,
    gaps,
    holds: chart.notes.filter((n) => n.type === 'hold').length,
    specials: chart.notes.filter((n) => n.type === 'special').length,
  };
}

const files = process.argv.slice(2);
for (const f of files) {
  const raw = fs.readFileSync(f);
  const n = raw.length / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = raw.readInt16LE(i * 2) / 32768;
  const a = analyzeAudio([pcm], 48000);
  console.log('\n===== ' + f + '  BPM ' + a.bpm + '  ' + a.duration.toFixed(0) + 's');
  for (const c of generateAll(a)) {
    const r = analyzePatterns(c, a.beatDur);
    console.log('\n-- ' + c.name + ' Lv' + c.level + '  notes=' + c.noteCount + '  nps=' + c.nps);
    console.log('  和弦 ' + r.chords + ' (' + r.chordPct + '%)  相邻双押 ' + r.adjacentChordPct + '%  ' + JSON.stringify(r.chordDist));
    console.log('  同键连打 ' + r.jackPct + '%   三连同上 ' + r.tripleJack + '  交替 ' + r.trillPct + '%');
    console.log('  移动距离 0/1/2/3 = ' + r.moveDist.join(' / ') + '%   同手连接 ' + r.sameHandPct + '%');
    console.log('  四键占比 ' + r.laneBalance.join(' / ') + '%   左右手 ' + r.handBalance.join(' / ') + '%');
    console.log('  间隔 1/16:' + r.gaps['1/16'] + ' 1/8:' + r.gaps['1/8'] + ' 1/4:' + r.gaps['1/4'] + ' 1/2+:' + r.gaps['1/2+']);
    console.log('  高频四音型 ' + r.topPatterns.map(([k, v]) => k + '×' + v).join('  '));
    console.log('  长条 ' + r.holds + '  特殊 ' + r.specials);
  }
}
