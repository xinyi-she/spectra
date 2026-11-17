/**
 * 基频检测精度测试
 * ------------------------------------------------------------------
 * 合成一段"已知音高"的旋律（含泛音、低音贝斯、起音噪声），
 * 逐音检测并统计误差（音分）。同时看可信度能否把鼓点和旋律分开。
 */
import { yinPitch, downsample, isolateMelody, hzToSemi } from '../js/pitch.js';

const SR = 48000;
const NOTE_DUR = 0.4;

// A 小调五声音阶，跨两个八度
const MELODY = [220, 261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 440, 349.23, 293.66, 261.63];

function synth(withDrums) {
  const total = Math.ceil((MELODY.length * NOTE_DUR + 0.6) * SR);
  const buf = new Float32Array(total);
  for (let i = 0; i < MELODY.length; i++) {
    const f0 = MELODY[i];
    const start = Math.round((0.3 + i * NOTE_DUR) * SR);
    const len = Math.round(NOTE_DUR * 0.95 * SR);
    for (let j = 0; j < len && start + j < total; j++) {
      const t = j / SR;
      const env = Math.min(1, t / 0.008) * Math.exp(-t * 3.2);
      // 基频 + 三四次泛音（钢琴/人声的典型频谱）
      const v =
        Math.sin(2 * Math.PI * f0 * t) * 1.0 +
        Math.sin(2 * Math.PI * f0 * 2 * t) * 0.45 +
        Math.sin(2 * Math.PI * f0 * 3 * t) * 0.22 +
        Math.sin(2 * Math.PI * f0 * 5 * t) * 0.1;
      buf[start + j] += v * env * 0.24;
    }
    // 低音贝斯：每音一个 110Hz / 82Hz 的短音，考验抗低频干扰
    const bassF = i % 2 === 0 ? 110 : 82.41;
    for (let j = 0; j < Math.round(0.25 * SR) && start + j < total; j++) {
      const t = j / SR;
      buf[start + j] += Math.sin(2 * Math.PI * bassF * t) * Math.exp(-t * 6) * 0.2;
    }
    if (withDrums) {
      // 起音处 3ms 白噪声 + 低频冲击：模拟底鼓/军鼓的打击瞬态
      const nlen = Math.round(0.05 * SR);
      for (let j = 0; j < nlen && start + j < total; j++) {
        const t = j / SR;
        if (t < 0.003) buf[start + j] += (Math.random() * 2 - 1) * 0.25;
        buf[start + j] += Math.sin(2 * Math.PI * 62 * t) * Math.exp(-t * 40) * 0.5;
      }
    }
  }
  return buf;
}

function runCase(withDrums) {
  const raw = synth(withDrums);
  const ds = downsample(raw, SR, 12000);
  const sig = isolateMelody(ds.data, ds.rate); // 和 analyzer 的处理链保持一致
  const win = Math.round(0.058 * ds.rate);
  const lead = Math.round(0.016 * ds.rate);
  const errs = [];
  let detected = 0;
  for (let i = 0; i < MELODY.length; i++) {
    const t = 0.3 + i * NOTE_DUR;
    const start = Math.round(t * ds.rate) + lead;
    const r = yinPitch(sig, start, win, ds.rate, 90, 1100);
    if (!r.hz) continue;
    detected++;
    const cents = Math.abs(r.semi - hzToSemi(MELODY[i])) * 100;
    errs.push({ i, want: MELODY[i], got: Math.round(r.hz), cents: Math.round(cents), clarity: +r.clarity.toFixed(2) });
  }
  const cents = errs.map((e) => e.cents).sort((a, b) => a - b);
  const median = cents[Math.floor(cents.length / 2)];
  const within = (limit) => errs.filter((e) => e.cents <= limit).length;
  return {
    withDrums,
    detected,
    total: MELODY.length,
    medianCents: median,
    p90: cents[Math.floor(cents.length * 0.9)],
    within25: within(25),
    within50: within(50),
    rows: errs.slice(0, 6),
  };
}

// 纯噪声段：可信度应该很低（用来确认阈值能挡住打击乐）
{
  const n = new Float32Array(SR);
  for (let i = 0; i < n.length; i++) n[i] = (Math.random() * 2 - 1) * 0.3;
  const ds = downsample(n, SR, 12000);
  const sig = isolateMelody(ds.data, ds.rate);
  const r = yinPitch(sig, 1000, Math.round(0.058 * ds.rate), ds.rate, 90, 1100);
  console.log('白噪声可信度:', r.clarity.toFixed(3), '（应 < 0.5）');
}

for (const drums of [false, true]) {
  const r = runCase(drums);
  console.log(
    (drums ? '[含鼓+贝斯]' : '[纯旋律]  ') +
      ` 检出 ${r.detected}/${r.total}  中位误差 ${r.medianCents} 音分  p90 ${r.p90}  ` +
      `≤25音分 ${r.within25}  ≤50音分 ${r.within50}`
  );
  for (const e of r.rows) {
    console.log(
      `   #${e.i} 期望 ${e.want.toFixed(1)}Hz 得到 ${e.got}Hz  误差 ${e.cents} 音分  可信度 ${e.clarity}`
    );
  }
}
