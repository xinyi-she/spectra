import { FFT, hann } from './fft.js';
import { downsample, isolateMelody, yinPitch } from './pitch.js';

/**
 * 音频分析引擎
 * ------------------------------------------------------------------
 * 1. 单声道混合 + 短时傅里叶变换（STFT）
 * 2. 五个频段的「谱通量」→ 击打强度曲线（onset strength）
 * 3. 自适应阈值峰值拾取 → 音符候选点（带频段特征）
 * 4. 自相关 + 谐波梳状评分 → BPM / 拍点相位
 * 5. 能量包络 → 段落强度（用于谱面情绪起伏）
 */

const BANDS = [
  { name: 'bass', lo: 25, hi: 140 },
  { name: 'low', lo: 140, hi: 450 },
  { name: 'mid', lo: 450, hi: 1400 },
  { name: 'high', lo: 1400, hi: 4500 },
  { name: 'air', lo: 4500, hi: 14000 },
];

const BAND_WEIGHT = [1.0, 1.45, 1.2, 1.0, 0.5];

function percentile(arr, p) {
  const a = Float32Array.from(arr);
  a.sort();
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
  return a[idx];
}

/**
 * @param {Float32Array[]|Float32Array} channelData
 * @param {number} sampleRate
 * @param {(p:number, label:string)=>void} [onProgress]
 */
export function analyzeAudio(channelData, sampleRate, onProgress = () => {}) {
  const isArray = Array.isArray(channelData);
  const channels = isArray ? channelData : [channelData];
  const total = channels[0].length;

  // ---- 1. 单声道 ----
  onProgress(0.05, '混合声道');
  let mono;
  if (channels.length === 1) {
    mono = channels[0];
  } else {
    mono = new Float32Array(total);
    const inv = 1 / channels.length;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      for (let i = 0; i < total; i++) mono[i] += ch[i] * inv;
    }
  }

  // ---- 2. STFT ----
  let frameLen = 1024;
  while (frameLen < sampleRate * 0.032) frameLen <<= 1;
  const hop = Math.max(128, Math.round(sampleRate * 0.0232));
  const frameDur = hop / sampleRate;
  const frames = Math.max(1, Math.floor((total - frameLen) / hop));
  const bins = frameLen >> 1;
  const binHz = sampleRate / frameLen;

  // 频段 → bin 区间
  const bandBins = BANDS.map((b) => ({
    lo: Math.max(1, Math.floor(b.lo / binHz)),
    hi: Math.min(bins - 1, Math.ceil(b.hi / binHz)),
    name: b.name,
  }));

  onProgress(0.12, '计算频谱');
  const fft = new FFT(frameLen);
  const win = hann(frameLen);
  const spec = new Float32Array(bins);
  const prev = new Float32Array(bins);

  // 每频段通量 + 能量
  const flux = BANDS.map(() => new Float32Array(frames));
  const energy = BANDS.map(() => new Float32Array(frames));

  for (let f = 0; f < frames; f++) {
    fft.magnitude(mono, f * hop, win, spec);
    for (let b = 0; b < BANDS.length; b++) {
      const { lo, hi } = bandBins[b];
      let fl = 0;
      let en = 0;
      for (let i = lo; i <= hi; i++) {
        const v = Math.log1p(spec[i] * 4);
        const d = v - prev[i];
        if (d > 0) fl += d;
        en += v;
        prev[i] = v;
      }
      flux[b][f] = fl / (hi - lo + 1);
      energy[b][f] = en / (hi - lo + 1);
    }
    if ((f & 255) === 0) onProgress(0.12 + 0.5 * (f / frames), '计算频谱');
  }

  // 频段内归一化（避免低频独占）
  for (let b = 0; b < BANDS.length; b++) {
    const scale = percentile(flux[b], 0.97) || 1;
    for (let f = 0; f < frames; f++) flux[b][f] /= scale;
  }

  // ---- 3. onset 强度曲线 ----
  let os = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let v = 0;
    for (let b = 0; b < BANDS.length; b++) v += flux[b][f] * BAND_WEIGHT[b];
    os[f] = v;
  }
  // 3 点平滑 + 按 p98 归一化
  const sm = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = os[Math.max(0, f - 1)];
    const b = os[f];
    const c = os[Math.min(frames - 1, f + 1)];
    sm[f] = a * 0.25 + b * 0.5 + c * 0.25;
  }
  const osScale = percentile(sm, 0.98) || 1;
  for (let f = 0; f < frames; f++) sm[f] = Math.min(1.6, sm[f] / osScale);
  os = sm;

  // ---- 4. 峰值拾取 ----
  onProgress(0.68, '提取击打点');
  const w = Math.round(0.5 / frameDur);
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + os[f];

  const peakFrames = [];
  const offsetSec = frameLen / 2 / sampleRate;
  for (let f = 2; f < frames - 2; f++) {
    const a = Math.max(0, f - w);
    const b = Math.min(frames, f + w + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    const thr = mean * 1.18 + 0.012;
    const v = os[f];
    if (v < thr) continue;
    if (v < os[f - 1] || v < os[f + 1]) continue;
    if (v < os[f - 2] || v < os[f + 2]) continue;
    peakFrames.push(f);
  }
  // 合并过近的峰
  const minGapFrames = Math.max(2, Math.round(0.055 / frameDur));
  const onsets = [];
  for (const f of peakFrames) {
    const last = onsets[onsets.length - 1];
    if (last && f - last.f < minGapFrames) {
      if (os[f] > last.s) {
        last.f = f;
        last.s = os[f];
        last.t = f * frameDur + offsetSec;
      }
    } else {
      onsets.push({ f, s: os[f], t: f * frameDur + offsetSec });
    }
  }
  // 频段特征
  for (const o of onsets) {
    const bands = [];
    for (let b = 0; b < BANDS.length; b++) bands.push(flux[b][o.f] || 0);
    o.bands = bands;
    o.tone = bands[4] > bands[0] * 1.15 ? 'hat' : bands[2] + bands[3] > bands[0] * 1.1 ? 'snare' : 'kick';
  }

  // ---- 4.5 基频检测（旋律走向用）----
  // 只在 onset 之后取窗：起音瞬态没有稳定周期，会污染估计。
  onProgress(0.72, '分析音高');
  const CLARITY_MIN = 0.5;
  const ds = downsample(mono, sampleRate, 12000);
  const pRate = ds.rate;
  // 滤掉贝斯：不这么做，YIN 会锁在"低八度"（110Hz 与 220Hz 的共同周期是 110Hz）
  const pSig = isolateMelody(ds.data, pRate);
  const pWin = Math.round(0.058 * pRate); // ~58ms，够看清 90Hz 的五个周期
  const pLead = Math.round(0.016 * pRate); // 跳过起音瞬态
  const pLen = pSig.length;
  // 长音检查用的第二个取样点：起音后 110ms。人声/主奏会在这里继续唱同一个音，
  // 鼓和镲不会 —— 这是判断"这一下是不是有人在唱"最便宜的证据。
  const pTail = Math.round(0.11 * pRate);
  const semis = [];
  for (const o of onsets) {
    const start = Math.round(o.t * pRate) + pLead;
    if (start + pWin >= pLen) {
      o.hz = 0;
      o.clarity = 0;
      o.semi = NaN;
      o.sustain = false;
      continue;
    }
    const r = yinPitch(pSig, start, pWin, pRate, 90, 1100);
    o.hz = r.hz;
    o.clarity = r.clarity;
    o.semi = r.semi;
    if (r.clarity >= CLARITY_MIN && isFinite(r.semi)) semis.push(r.semi);
    o.sustain = false;
    const tail = start + pTail + pWin;
    if (tail < pLen) {
      const r2 = yinPitch(pSig, start + pTail, pWin, pRate, 90, 1100);
      if (r.clarity >= 0.45 && isFinite(r.semi) && r2.clarity >= 0.45 && isFinite(r2.semi) &&
          Math.abs(r2.semi - r.semi) <= 1.5) {
        o.sustain = true;
      }
      // 起音窗被瞬态污染时换"晚一点"的窗兜底：这是人声/主奏最容易被漏掉的一类
      // （辅音、鼓点叠在上面，前 58ms 根本没有稳定周期）。补回来的音高照样能用，
      // 而且它必然是"延续着的声音"，所以直接算长音。
      if (r.clarity < 0.45 && r2.clarity >= 0.5 && isFinite(r2.semi)) {
        o.hz = r2.hz;
        o.semi = r2.semi;
        o.clarity = r2.clarity * 0.9;
        o.sustain = true;
        if (o.clarity >= CLARITY_MIN) semis.push(o.semi);
      }
    }
  }

  // 音高分布：中位数 + 10~90 分位跨度，谱面用它把"绝对音高"换成"相对高低"
  let pitchMedian = NaN;
  let pitchLo = NaN;
  let pitchHi = NaN;
  if (semis.length >= 8) {
    const sortedSemi = semis.slice().sort((a, b) => a - b);
    const q = (p) => sortedSemi[Math.max(0, Math.min(sortedSemi.length - 1, Math.round((sortedSemi.length - 1) * p)))];
    pitchMedian = q(0.5);
    pitchLo = q(0.1);
    pitchHi = q(0.9);
  }
  /** 相对音高：-1（低）..0（中位）..+1（高） */
  const pitchRelAt = (semi) => {
    if (!isFinite(semi) || !isFinite(pitchMedian)) return 0;
    const span = Math.max(1.5, (pitchHi - pitchLo) / 2 || 1);
    return Math.max(-1, Math.min(1, (semi - pitchMedian) / span));
  };

  // ---- 4.6 音高稳定性闸门 ----
  // 复音混音里 YIN 会在贝斯 / 人声 / 吉他之间来回跳 —— 实测相邻两个音的
  // 音高差常在 7~11 个半音之间，那是"换了声部"，不是旋律在走。
  // 所以只保留"附近还有音高相近的音"的检测结果：旋律线是连续的，
  // 孤立的跳变一律当成不可信，交回节奏驱动的编排。
  const STABLE_WIN = 0.42; // 秒
  const STABLE_TOL = 3; // 半音
  const idxWin = Math.max(1, Math.round(STABLE_WIN / frameDur));
  let stableCount = 0;
  for (let i = 0; i < onsets.length; i++) {
    const o = onsets[i];
    if (!isFinite(o.semi) || (o.clarity || 0) < CLARITY_MIN) {
      o.stable = false;
      continue;
    }
    let support = 0;
    const lo = Math.max(0, i - idxWin);
    const hi = Math.min(onsets.length - 1, i + idxWin);
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      const p = onsets[j];
      if (!isFinite(p.semi) || (p.clarity || 0) < CLARITY_MIN) continue;
      if (Math.abs(p.semi - o.semi) <= STABLE_TOL) support++;
    }
    o.stable = support >= 1;
    if (o.stable) stableCount++;
  }

  // ---- 4.7 音高轨中值滤波 ----
  // 单点跳变（偶尔锁到另一个声部）会把旋律线打成锯齿，也会让"同一段音乐
  // 出现两次"的谱面不一致。3 点中值只削掉孤立的尖峰，真实的大跳会保留。
  {
    const idxs = [];
    for (let i = 0; i < onsets.length; i++) if (onsets[i].stable) idxs.push(i);
    const src = idxs.map((i) => onsets[i].semi);
    for (let k = 1; k < idxs.length - 1; k++) {
      const a = src[k - 1];
      const b = src[k];
      const c = src[k + 1];
      const med = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
      // 只在"自己是孤立尖峰"时替换（与两侧都差得多）
      if (Math.abs(med - b) < 9 && Math.abs(a - b) > 2 && Math.abs(c - b) > 2) {
        onsets[idxs[k]].semi = med;
      }
    }
  }

  // ---- 5. BPM：tempo-octave 搜索 ----
  onProgress(0.8, '估算 BPM');
  // 从 2 帧起就要算：tempogram 的局部基线会采样到 0.17s 这种短 lag，
  // 低 lag 留 0 会把快速度的基线压低、让打分系统性偏向快的那一层（实测 BPM 偏大 1.5 倍）
  const lagMin = 2;
  // 2.0s：小节项要算 4 拍的自相关，70 BPM 时 4 拍就是 3.4s，够不到的那几档就跳过小节项
  const lagMax = Math.min(frames >> 1, Math.round(2.0 / frameDur));
  const ac = new Float64Array(lagMax + 2);
  // 归一化用的能量前缀和
  const epre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) epre[i + 1] = epre[i] + os[i] * os[i];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sum = 0;
    const n = frames - lag;
    for (let i = 0; i < n; i++) sum += os[i] * os[i + lag];
    const e1 = epre[n];
    const e2 = epre[frames] - epre[lag];
    // 归一化互相关（余弦）：不除以能量的话，数值高低取决于整首响度，
    // 拿它比不同长度的 lag 等于用两把尺子
    ac[lag] = sum / Math.sqrt(e1 * e2 || 1);
  }
  const acAt = (lag) => {
    const L = Math.max(1, Math.min(lagMax, lag));
    const i0 = Math.floor(L);
    const fr = L - i0;
    const a = ac[i0] || 0;
    const b = ac[Math.min(lagMax, i0 + 1)] || 0;
    return a * (1 - fr) + b * fr;
  };

  // 局部基线：±40%（去掉自身 ±6%）的平均自相关。
  // 短 lag 天生比长 lag 更相关（包络平滑），不减掉的话会系统性偏向快的那一层。
  const levelBase = (bd) => {
    let sum = 0;
    let n = 0;
    for (let k = -40; k <= 40; k += 4) {
      if (Math.abs(k) < 6) continue;
      sum += acAt((bd * (1 + k / 100)) / frameDur);
      n++;
    }
    return sum / Math.max(1, n);
  };
  const salience = (bd) => acAt(bd / frameDur) - levelBase(bd);

  /**
   * 候选拍长的可信度。
   *
   * 拍点自相关之外**还要看小节（4 拍）周期**：谱面是按 4/4 小节写的，
   * 光看拍点的话"半速"读法（每两拍当一拍）和小节线都自洽，分不开。
   * 实测加上小节项之后 54 首里多对 20 首。
   *
   * 再乘一个很宽的节拍先验打破八度平手：人耳一般把 100~190 当拍，
   * 官方 54 首的 BPM 中位 165、范围 76~222。先验只占 45% 权重，
   * 证据明显更强的那一层照样能赢（76 BPM 那首就保住了自己）。
   */
  const tempoPrior = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 165) / 0.55, 2));
  const scoreTempo = (bpm) => {
    const bd = 60 / bpm;
    let s = salience(bd);
    if (bd * 4 <= lagMax * frameDur) s += 0.5 * salience(bd * 4);
    return s * (0.55 + 0.45 * tempoPrior(bpm));
  };

  let bestBpm = 120;
  let bestScore = -1e9;
  for (let bpm = 70; bpm <= 230; bpm += 0.25) {
    const s = scoreTempo(bpm);
    if (s > bestScore) {
      bestScore = s;
      bestBpm = bpm;
    }
  }
  while (bestBpm < 70) bestBpm *= 2;
  while (bestBpm > 230) bestBpm /= 2;

  // ---- 5.5 相位相干精修 BPM（关键：整首歌不能漂拍）----
  const coherence = (bpm) => {
    const w = (2 * Math.PI) / (60 / bpm);
    let re = 0;
    let im = 0;
    let sum = 0;
    for (const o of onsets) {
      const wt = o.s * o.s;
      re += wt * Math.cos(w * o.t);
      im += wt * Math.sin(w * o.t);
      sum += wt;
    }
    if (!sum) return { c: 0, ph: 0 };
    return { c: Math.hypot(re, im) / sum, ph: Math.atan2(im, re) };
  };

  let refined = bestBpm;
  let bestC = -1;
  let bestPh = 0;
  for (let cand = bestBpm * 0.955; cand <= bestBpm * 1.045; cand += 0.02) {
    const r = coherence(cand);
    if (r.c > bestC) {
      bestC = r.c;
      refined = cand;
      bestPh = r.ph;
    }
  }
  // 大多数曲子是整数 BPM，靠近整数就吸附
  if (Math.abs(refined - Math.round(refined)) < 0.14) refined = Math.round(refined);
  if (Math.abs(refined * 2 - Math.round(refined * 2)) < 0.1) refined = Math.round(refined * 2) / 2;

  let bpm = Math.round(refined * 10) / 10;
  let beatDur = 60 / bpm;

  // ---- 6. 拍点相位：以相干相位为起点，全拍搜索最优 ----
  const ph0 = (bestPh / ((2 * Math.PI) / beatDur) + beatDur * 4) % beatDur;
  const scorePhase = (p) => {
    let s = 0;
    for (let k = 0; ; k++) {
      const idx = Math.round((p + k * beatDur) / frameDur);
      if (idx >= frames) break;
      s += os[idx];
    }
    return s;
  };
  let firstBeat = ph0;
  let bestS = -1;
  for (let p = 0; p < beatDur - 1e-6; p += 0.005) {
    const s = scorePhase(p);
    if (s > bestS) {
      bestS = s;
      firstBeat = p;
    }
  }

  // ---- 6.5 最小二乘拟合拍网格：消除残余 BPM 误差造成的整曲漂移 ----
  for (let iter = 0; iter < 4; iter++) {
    let cnt = 0;
    let sk = 0;
    let st = 0;
    let skk = 0;
    let skt = 0;
    for (const o of onsets) {
      const k = Math.round((o.t - firstBeat) / beatDur);
      const resid = o.t - (firstBeat + k * beatDur);
      if (Math.abs(resid) > beatDur * 0.16) continue;
      cnt++;
      sk += k;
      st += o.t;
      skk += k * k;
      skt += k * o.t;
    }
    const denom = cnt * skk - sk * sk;
    if (cnt < 12 || Math.abs(denom) < 1e-9) break;
    const b = (cnt * skt - sk * st) / denom;
    const a = (st - b * sk) / cnt;
    if (!isFinite(b) || b <= 0 || Math.abs(b - beatDur) > beatDur * 0.03) break;
    beatDur = b;
    firstBeat = a;
  }
  firstBeat = ((firstBeat % beatDur) + beatDur) % beatDur;
  bpm = Math.round((60 / beatDur) * 100) / 100;

  // ---- 7. 段落能量 ----
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let v = 0;
    for (let b = 0; b < BANDS.length; b++) v += energy[b][f] * (b === 0 ? 0.2 : 1);
    rms[f] = v;
  }
  const rmsMax = percentile(rms, 0.95) || 1;
  for (let f = 0; f < frames; f++) rms[f] = Math.min(1.5, rms[f] / rmsMax);

  onProgress(0.9, '整理节拍');

  return {
    duration: total / sampleRate,
    sampleRate,
    frameDur,
    frames,
    bpm,
    beatDur,
    firstBeat,
    onsetStrength: os,
    rms,
    energy: { bass: energy[0], low: energy[1], mid: energy[2], high: energy[3], air: energy[4] },
    onsets,
    pitch: {
      median: pitchMedian,
      lo: pitchLo,
      hi: pitchHi,
      clarityMin: CLARITY_MIN,
      pitchedCount: semis.length,
      stableCount,
      coverage: onsets.length ? semis.length / onsets.length : 0,
      stableCoverage: onsets.length ? stableCount / onsets.length : 0,
    },
    /** 某个 onset 的相对音高 -1..1（低→高）；无音高时返回 0 */
    pitchRel: pitchRelAt,
    stats: {
      onsetCount: onsets.length,
      bpm,
      pitched: semis.length,
    },
    energyAt(t) {
      const f = Math.round(t / frameDur);
      return rms[Math.max(0, Math.min(frames - 1, f))];
    },
    beatAt(t) {
      return (t - firstBeat) / beatDur;
    },
  };
}
