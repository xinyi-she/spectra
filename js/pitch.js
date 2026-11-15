/**
 * 基频（音高）检测
 * ------------------------------------------------------------------
 * 用 YIN 算法：比 HPS / 自相关在复音混合里更稳，而且自带"可信度"
 * （aperiodicity），可以直接拿来判断"这个音到底有没有明确音高"——
 * 鼓点、噪声、齿音是无周期的，可信度会很低，正好把旋律和打击乐分开。
 *
 * 流程：抗混叠降采样到 ~12kHz → 逐 onset 取一个 60ms 窗（跳过起音瞬态）
 *      → 差分函数 → CMNDF → 第一个低于阈值的谷 → 抛物线插值精修。
 */

/** 音名 → 半音数（以 A4 = 69 为基准，和 MIDI 一致） */
export function hzToSemi(hz) {
  return 12 * Math.log2(hz / 440) + 69;
}

export function semiToHz(semi) {
  return 440 * Math.pow(2, (semi - 69) / 12);
}

/**
 * 抗混叠降采样：先做 factor 点滑动平均（简陋但有效的低通），再抽取。
 * @returns {{ data: Float32Array, rate: number, factor: number }}
 */
export function downsample(input, sampleRate, targetRate) {
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  if (factor === 1) return { data: input, rate: sampleRate, factor: 1 };

  const len = Math.floor(input.length / factor);
  const out = new Float32Array(len);
  const inv = 1 / factor;
  for (let i = 0; i < len; i++) {
    let sum = 0;
    const base = i * factor;
    for (let k = 0; k < factor; k++) sum += input[base + k];
    out[i] = sum * inv;
  }
  return { data: out, rate: sampleRate / factor, factor };
}

/**
 * 二阶高通（RBJ biquad）。级联两次 ≈ 24dB/oct，能把贝斯压到听不见。
 * 之前用"减去滑动平均"的土办法只有 -3dB 左右，YIN 照样锁在低音线上。
 */
export function highpassBiquad(input, rate, cutoffHz, q = 0.7071) {
  const w0 = (2 * Math.PI * cutoffHz) / rate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 + cosw) / 2 / a0;
  const b1 = -(1 + cosw) / a0;
  const b2 = (1 + cosw) / 2 / a0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  return biquad(input, b0, b1, b2, a1, a2);
}

/** 二阶低通（RBJ biquad） */
export function lowpassBiquad(input, rate, cutoffHz, q = 0.7071) {
  const w0 = (2 * Math.PI * cutoffHz) / rate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0;
  const b1 = (1 - cosw) / a0;
  const b2 = (1 - cosw) / 2 / a0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  return biquad(input, b0, b1, b2, a1, a2);
}

function biquad(input, b0, b1, b2, a1, a2) {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/**
 * 旋律频带提取：高通 170Hz ×2 + 低通 1600Hz。
 *
 * 为什么必须滤波：YIN 找的是"周期"，而 110Hz 与 220Hz 的共同周期是 110Hz，
 * 两个音同时存在时它会算出一个"低八度"的答案。把贝斯滤掉，
 * 剩下的是真正的旋律线。
 */
export function isolateMelody(buf, rate) {
  return lowpassBiquad(highpassBiquad(highpassBiquad(buf, rate, 170), rate, 170), rate, 1600);
}

/**
 * YIN 基频估计。
 *
 * @param {Float32Array} buf   已降采样的波形
 * @param {number} offset      窗口起点（采样点）
 * @param {number} win         窗口长度（采样点），需 > tauMax*1.8
 * @param {number} sampleRate  降采样后的采样率
 * @param {number} minHz       搜索下界（默认 65Hz，男低音 / 贝斯）
 * @param {number} maxHz       搜索上界（默认 1200Hz，覆盖大部分人声与主奏）
 * @returns {{ hz: number, clarity: number, semi: number }}
 */
export function yinPitch(buf, offset, win, sampleRate, minHz = 65, maxHz = 1200) {
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.floor(sampleRate / minHz), Math.floor(win * 0.55));
  const W = win - tauMax;
  if (W < 64 || tauMax <= tauMin) return { hz: 0, clarity: 0, semi: NaN };

  // 1) 差分函数
  const d = new Float32Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    const base = offset + tau;
    for (let j = 0; j < W; j++) {
      const diff = buf[offset + j] - buf[base + j];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // 2) 累积均值归一化差分（CMNDF）——消除能量随 tau 增长的偏差
  const cm = new Float32Array(tauMax + 2);
  let running = 0;
  cm[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cm[tau] = running > 1e-12 ? (d[tau] * tau) / running : 1;
  }

  // 3) 找第一个低于阈值的局部极小
  const THR = 0.14;
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cm[tau] >= THR) continue;
    while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
    best = tau;
    break;
  }
  // 全部高于阈值 → 无周期（打击乐 / 噪声），退回全局最小但可信度会很低
  if (best < 0) {
    let m = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cm[tau] < m) {
        m = cm[tau];
        best = tau;
      }
    }
    if (best < 0) return { hz: 0, clarity: 0, semi: NaN };
  }

  // 4) 这里**不做**"八度校正"：YIN 的规则是"取第一个足够低的谷"，
  //    因为任何周期的整数倍（2T、3T）同样是合法周期，越往后越容易落到
  //    低八度 / 低十二度上。曾经加过"如果 2 倍周期也合格就取 2 倍"，
  //    实测把整段旋律压低了八度，已删除。

  // 5) 抛物线插值，把整数 tau 修到亚采样精度（低频段尤其重要）
  const y0 = cm[best - 1];
  const y1 = cm[best];
  const y2 = cm[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const delta = Math.abs(denom) > 1e-9 ? (0.5 * (y0 - y2)) / denom : 0;
  const tau = best + Math.max(-0.5, Math.min(0.5, delta));

  const hz = sampleRate / tau;
  if (!isFinite(hz) || hz < minHz * 0.9 || hz > maxHz * 1.1) {
    return { hz: 0, clarity: 0, semi: NaN };
  }
  return { hz, clarity: Math.max(0, 1 - y1), semi: hzToSemi(hz) };
}
