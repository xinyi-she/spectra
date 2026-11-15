import fs from 'node:fs';
import { analyzeAudio } from '../js/analyzer.js';
import { generateChart, DIFFICULTIES } from '../js/chart.js';

const b = fs.readFileSync(process.argv[2]);
const n = b.length / 2;
const pcm = new Float32Array(n);
for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(i * 2) / 32768;
const a = analyzeAudio([pcm], 48000);

for (const diffIdx of [1, 2]) {
  const c = generateChart(a, DIFFICULTIES[diffIdx]);
  const barDur = a.beatDur * 4;
  const segs = c.structure.segments;

  // 每小节键位序列
  const bars = new Map();
  for (const nt of c.notes) {
    const k = Math.floor((nt.t - c.beatOffset) / barDur);
    if (!bars.has(k)) bars.set(k, []);
    bars.get(k).push(nt);
  }
  const barNotes = (k) => (bars.get(k) || []).slice().sort((x, y) => x.t - y.t);
  const sig = (k) => barNotes(k).map((x) => x.lane);

  /** 按"小节内相对时间"对齐后比较键位，避免两边音符数不同导致逐位错位 */
  function alignedSim(ka, kb) {
    const A = barNotes(ka);
    const B = barNotes(kb);
    if (!A.length || !B.length) return A.length === B.length ? 1 : 0;
    const t0a = A[0].t;
    const t0b = B[0].t;
    let hit = 0;
    let cnt = 0;
    for (const b of B) {
      const rb = b.t - t0b;
      let best = null;
      let bestD = Infinity;
      for (const a of A) {
        const d = Math.abs(a.t - t0a - rb);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      if (best && bestD < barDur * 0.12) {
        cnt++;
        if (best.lane === b.lane) hit++;
      }
    }
    return cnt ? hit / cnt : 0;
  }

  console.log('\n=== ' + process.argv[2] + '  ' + c.name + ' Lv' + c.level + '  notes=' + c.noteCount);
  console.log('段落结构:');
  console.log('  ' + segs.map((s) => '[' + '·'.repeat(1) + (s.tier === 2 ? 'HIGH' : s.tier === 1 ? 'mid' : 'low') + ' ' + s.start + '~' + (s.start + s.len - 1) + ']').join(' '));

  // 同档位段落之间的相似率
  const tiers = [0, 1, 2];
  for (const t of tiers) {
    const same = segs.filter((s) => s.tier === t);
    if (same.length < 2) continue;
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < same.length; i++) {
      for (let j = i + 1; j < same.length; j++) {
        const A = same[i];
        const B = same[j];
        const len = Math.min(A.len, B.len);
        for (let k = 0; k < len; k++) {
          sum += alignedSim(A.start + k, B.start + k);
          cnt++;
        }
      }
    }
    if (cnt) {
      const name = t === 2 ? '高潮段' : t === 1 ? '主歌段' : '安静段';
      console.log('  同档位（' + name + '）× ' + (same.length - 1) + ' 对  谱面相似率 ' + (sum / cnt * 100).toFixed(1) + '%');
    }
  }

  // 段落内的对手指稳定度：段内每小节是否都走同类 pattern
  console.log('  每小节音符数: ' + segs.map((s) => Array.from({ length: s.len }, (_, k) => (bars.get(s.start + k) || []).length).join(',')).join(' | '));
}
