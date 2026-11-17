/**
 * tempo-octave 判据实验台（纯 Node，几秒出结果）
 *
 *   node tools/tempo_lab.mjs            # 用默认参数扫一遍
 *   node tools/tempo_lab.mjs --sweep    # 扫先验中心 / σ / 小节项权重
 *
 * 依赖 tools/_envelope.json（`tools/dump_envelope.js` 导出）和 `tools/_ids.json` 里的曲目。
 * 判据本身在 js/analyzer.js 第 5 节，这里只做"换参数、看命中率"，不改产品代码。
 */
import fs from 'node:fs';

const SONGS = JSON.parse(fs.readFileSync('tools/_envelope.json', 'utf8'));
const STEP = 0.25;
const BPM_MIN = 70;
const BPM_MAX = 230;
const LAG_SEC = 2.0;

const records = SONGS.map((s) => {
  const os = s.os;
  const fd = s.frameDur;
  const maxLag = Math.min(os.length - 4, Math.round(LAG_SEC / fd));
  const ac = new Float64Array(maxLag + 2);
  const pre = new Float64Array(os.length + 1);
  for (let i = 0; i < os.length; i++) pre[i + 1] = pre[i] + os[i] * os[i];
  for (let l = 1; l <= maxLag; l++) {
    let t = 0;
    const m = os.length - l;
    for (let i = 0; i < m; i++) t += os[i] * os[i + l];
    const e1 = pre[m];
    const e2 = pre[os.length] - pre[l];
    ac[l] = t / Math.sqrt((e1 * e2) || 1);
  }
  const acAt = (lagSec) => {
    const L = Math.max(1, Math.min(maxLag, lagSec / fd));
    const i0 = Math.floor(L);
    const fr = L - i0;
    return (ac[i0] || 0) * (1 - fr) + (ac[Math.min(maxLag, i0 + 1)] || 0) * fr;
  };
  return { id: s.id, trueBpm: s.trueBpm, acAt, maxLagSec: maxLag * fd };
});

const baseline = (acAt, bd) => {
  let sum = 0;
  let n = 0;
  for (let k = -40; k <= 40; k += 4) {
    if (Math.abs(k) < 6) continue;
    sum += acAt(bd * (1 + k / 100));
    n++;
  }
  return sum / n;
};
const salience = (acAt, bd) => acAt(bd) - baseline(acAt, bd);

const evaluate = ({ wBar = 0.5, center = 165, sigma = 0.55 } = {}) => {
  let ok = 0;
  const miss = [];
  for (const r of records) {
    let bestBpm = 0;
    let bestV = -1e9;
    for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm += STEP) {
      const bd = 60 / bpm;
      let v = salience(r.acAt, bd);
      if (4 * bd <= r.maxLagSec) v += wBar * salience(r.acAt, 4 * bd);
      v *= 0.55 + 0.45 * Math.exp(-0.5 * Math.pow(Math.log2(bpm / center) / sigma, 2));
      if (v > bestV) {
        bestV = v;
        bestBpm = bpm;
      }
    }
    while (bestBpm < 70) bestBpm *= 2;
    while (bestBpm > 230) bestBpm /= 2;
    const q = bestBpm / r.trueBpm;
    if (Math.abs(q - 1) <= 0.02) ok++;
    else miss.push(`${r.trueBpm}→${bestBpm}`);
  }
  return { ok, n: records.length, miss };
};

const show = (label, r) =>
  console.log(`${label.padEnd(34)} ${String(r.ok + '/' + r.n).padStart(6)}   ${r.miss.join('  ')}`);

if (process.argv.includes('--sweep')) {
  for (const center of [150, 165, 180]) {
    for (const sigma of [0.45, 0.55, 0.7]) {
      show(`center=${center} sigma=${sigma}`, evaluate({ center, sigma }));
    }
  }
  for (const wBar of [0.3, 0.5, 0.8]) show(`wBar=${wBar}`, evaluate({ wBar }));
} else {
  show('默认（wBar .5 / 165 / .55）', evaluate());
}
