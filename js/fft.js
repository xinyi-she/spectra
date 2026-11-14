/**
 * 轻量 FFT：radix-2 迭代实现，预计算旋转因子与位反转表。
 * 用于音频频谱分析（谱面生成）。
 */
export class FFT {
  constructor(size) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be power of 2');
    this.size = size;
    this.levels = Math.round(Math.log2(size));

    const half = size >> 1;
    this.cos = new Float32Array(half);
    this.sin = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }

    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < this.levels; j++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  /** 原地复数 FFT */
  transform(re, im) {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const cos = this.cos;
    const sin = this.sin;
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < halfLen; j++, k += step) {
          const c = cos[k];
          const s = -sin[k];
          const a = i + j;
          const b = a + halfLen;
          const xr = re[b] * c - im[b] * s;
          const xi = re[b] * s + im[b] * c;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  /** 实数输入 → 幅度谱（只算前 n/2 个 bin） */
  magnitude(samples, offset, window, out) {
    const n = this.size;
    const re = this._re || (this._re = new Float32Array(n));
    const im = this._im || (this._im = new Float32Array(n));
    for (let i = 0; i < n; i++) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    this.transform(re, im);
    const bins = n >> 1;
    for (let i = 0; i < bins; i++) {
      out[i] = Math.hypot(re[i], im[i]);
    }
    return out;
  }
}

/** 汉宁窗 */
export function hann(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return w;
}

/** 可复现随机数（mulberry32） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
