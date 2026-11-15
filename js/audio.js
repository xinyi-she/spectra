/** 音频引擎：解码 / 播放 / 精确时钟 / 频谱 / 打击音合成 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.startCtxTime = 0;
    this.offset = 0;
    this.playing = false;
    this.musicVolume = 0.9;
    this.sfxVolume = 0.6;
    this.latency = 0;
    this._noise = null;
  }

  async init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.musicVolume;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.82;
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this.sfxVolume * 0.5;
      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.sfxGain.connect(this.ctx.destination);
      this.latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  async decode(arrayBuffer) {
    await this.init();
    const buf = await this.ctx.decodeAudioData(arrayBuffer);
    this.buffer = buf;
    return buf;
  }

  setMusicVolume(v) {
    this.musicVolume = v;
    if (this.master) this.master.gain.value = v;
  }

  setSfxVolume(v) {
    this.sfxVolume = v;
    if (this.sfxGain) this.sfxGain.gain.value = v * 0.5;
  }

  /**
   * 播放。
   * @param {number} from  从音频的第几秒开始
   * @param {number} delay 延迟多少秒再出声。开场 lead-in 用：先让玩家看谱 + 倒计时，
   *                       音乐后进；这期间 position 会是负数，正好对应"演出时间 0 之前"。
   */
  play(from = 0, delay = 0) {
    if (!this.buffer) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.master);
    const at = Math.max(0, Math.min(from, this.buffer.duration - 0.05));
    const when = this.ctx.currentTime + Math.max(0, delay);
    src.start(when, at);
    this.source = src;
    this.startCtxTime = when;
    this.offset = at;
    this.playing = true;
    src.onended = () => {
      if (this.source === src) {
        this.playing = false;
        this.offset = this.buffer.duration;
      }
    };
  }

  stopSource() {
    if (this.source) {
      try {
        this.source.stop();
      } catch (e) {
        /* already stopped */
      }
      this.source = null;
    }
  }

  pause() {
    this.offset = Math.max(0, this.position);
    this.playing = false;
    this.stopSource();
  }

  stop() {
    this.stopSource();
    this.playing = false;
    this.offset = 0;
  }

  get position() {
    if (!this.ctx || !this.buffer) return 0;
    const t = this.playing ? this.offset + (this.ctx.currentTime - this.startCtxTime - this.latency) : this.offset;
    // 不截断下界：delay 期间是负数，代表"开场前"，游戏时间要靠它对齐
    return Math.min(this.buffer.duration, t);
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  spectrum() {
    if (!this.analyser) return null;
    const arr = this._spec || (this._spec = new Uint8Array(this.analyser.frequencyBinCount));
    this.analyser.getByteFrequencyData(arr);
    return arr;
  }

  /** 打击音：短促合成音，不依赖音频素材 */
  hit(kind = 'tap') {
    if (!this.ctx || this.ctx.state !== 'running' || this.sfxVolume <= 0) return;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.connect(this.sfxGain);
    const vol = kind === 'special' ? 0.5 : 0.34;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const f0 = kind === 'special' ? 1560 : 1180;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.07);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.1);

    // 一点点噪声增强"打击感"
    if (!this._noise) {
      const len = Math.floor(this.ctx.sampleRate * 0.05);
      const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      this._noise = b;
    }
    const n = this.ctx.createBufferSource();
    n.buffer = this._noise;
    const ng = this.ctx.createGain();
    ng.gain.value = kind === 'special' ? 0.32 : 0.18;
    n.connect(ng).connect(this.sfxGain);
    n.start(t);
  }
}
