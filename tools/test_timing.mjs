import { analyzeAudio } from '../js/analyzer.js';

/** 合成已知时间的鼓点，测量 onset 时间戳的系统性偏差 */
function makeTrack(sr, dur, interval, kind) {
  const n = Math.round(sr * dur);
  const x = new Float32Array(n);
  const truth = [];
  for (let t = 0.5; t < dur - 0.2; t += interval) {
    truth.push(t);
    const i0 = Math.round(t * sr);
    const len = Math.round(0.12 * sr);
    for (let k = 0; k < len && i0 + k < n; k++) {
      const tau = k / sr;
      if (kind === 'click') {
        const env = Math.exp(-tau / 0.006);
        x[i0 + k] += ((Math.random() * 2 - 1) * 0.5 + Math.sin(2 * Math.PI * 1000 * tau) * 0.5) * env;
      } else if (kind === 'kick') {
        const env = Math.exp(-tau / 0.05);
        const f = 120 * Math.exp(-tau / 0.02) + 45;
        x[i0 + k] += Math.sin(2 * Math.PI * f * tau) * env * 0.9;
        x[i0 + k] += (Math.random() * 2 - 1) * Math.exp(-tau / 0.004) * 0.25;
      } else {
        // snare-ish：噪声 + 180Hz 体
        const env = Math.exp(-tau / 0.07);
        x[i0 + k] += (Math.random() * 2 - 1) * env * 0.6 + Math.sin(2 * Math.PI * 185 * tau) * env * 0.3;
      }
    }
  }
  // 一点底噪，避免纯静音
  for (let i = 0; i < n; i++) x[i] += (Math.random() * 2 - 1) * 0.0005;
  return { x, truth };
}

const sr = 48000;
for (const kind of ['click', 'kick', 'snare']) {
  const { x, truth } = makeTrack(sr, 10, 0.25, kind);
  const a = analyzeAudio([x], sr);
  const errs = [];
  for (const t of truth) {
    let best = null;
    for (const o of a.onsets) {
      if (Math.abs(o.t - t) > 0.12) continue;
      if (!best || Math.abs(o.t - t) < Math.abs(best.t - t)) best = o;
    }
    if (best) errs.push(best.t - t);
  }
  errs.sort((p, q) => p - q);
  const n = errs.length;
  const mean = errs.reduce((s, v) => s + v, 0) / n;
  const med = errs[Math.floor(n / 2)];
  console.log(
    `${kind.padEnd(6)} found ${n}/${truth.length}  mean ${(mean * 1000).toFixed(1)}ms  median ${(med * 1000).toFixed(1)}ms  ` +
      `p10 ${(errs[Math.floor(n * 0.1)] * 1000).toFixed(1)}  p90 ${(errs[Math.floor(n * 0.9)] * 1000).toFixed(1)}  bpm ${a.bpm}`
  );
}
