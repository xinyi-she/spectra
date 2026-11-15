/**
 * 4K 下落式音游引擎
 * 判定：JUST(±48ms 满分) / RUSH(偏早 半分) / COOL(偏晚 半分) / MISS
 * 特殊音符需同时按空格（分数 ×2），长条按松手时机判定
 */

const LANES = 4;
const W_JUST = 0.048;
const W_HIT = 0.145;
const W_HOLD_RELEASE = 0.1;
const W_HOLD_BREAK = 0.3;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export class RhythmGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.notes = [];
    this.running = false;
    this.paused = false;
    this.finished = false;
    this.particles = [];
    this.rings = [];
    this.judgeText = null;
    this.laneFlash = [0, 0, 0, 0];
    this.lanePressed = [false, false, false, false];
    this.raf = 0;
    this.lastTs = 0;
    this.onStats = null;
    this.onFinish = null;
    this.timeOffset = 0;
    this.auto = false;
    this.mirror = false;
    this.bindMode = false;
    this.countdownValue = null;
    this._resize = () => this.layout();
    window.addEventListener('resize', this._resize);
  }

  init(cfg) {
    this.audio = cfg.audio;
    this.chart = cfg.chart;
    this.timeOffset = (cfg.offsetMs || 0) / 1000;
    this.auto = !!cfg.auto;
    this.mirror = !!cfg.mirror;
    this.bindMode = !!cfg.bind;
    this.clockMode = cfg.clock || 'audio';
    this.speed = cfg.speed || 1.2;
    this.onStats = cfg.onStats || (() => {});
    this.onFinish = cfg.onFinish || (() => {});
    this.onCombo = cfg.onCombo || null;
    this.onCountdown = cfg.onCountdown || null;
    this.songMeta = cfg.songMeta || {};
    this.keys = cfg.keys || ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];

    this.theme = this.readTheme();
    this.travelTime = 1.75 / this.speed;

    this.notes = this.chart.notes.map((n) => ({
      ...n,
      lane: this.mirror ? 3 - n.lane : n.lane,
      state: 'idle', // idle | holding | done
      judged: null,
    }));
    this.laneNotes = [[], [], [], []];
    for (const n of this.notes) this.laneNotes[n.lane].push(n);
    this.laneCursor = [0, 0, 0, 0];

    this.unit = 1000000 / (this.chart.totalWeight || 1);
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.stats = { just: 0, rush: 0, cool: 0, miss: 0 };
    this.missCursor = 0;
    this.judgedCount = 0;
    this.weightJudged = 0;
    this.weightTotal = this.chart.totalWeight || 1;

    this.firstNote = this.notes[0] ? this.notes[0].t : 0;
    this.lastNoteEnd = this.notes.reduce((m, n) => Math.max(m, n.t + (n.dur || 0)), 0);
    this.layout();
    return this;
  }

  readTheme() {
    const cs = getComputedStyle(document.body);
    const get = (v, fb) => (cs.getPropertyValue(v).trim() || fb);
    const a1 = get('--a1', '#a78bfa');
    const a2 = get('--a2', '#f472b6');
    const a3 = get('--a3', '#fbbf24');
    return { a1, a2, a3, lane: [a1, a2, a2, a1] };
  }

  layout() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || window.innerWidth;
    const h = c.clientHeight || window.innerHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w;
    this.H = h;
    this.fieldW = clamp(w * 0.44, Math.min(300, w * 0.86), 520);
    this.laneW = this.fieldW / LANES;
    this.fieldX = (w - this.fieldW) / 2;
    this.judgeY = h - Math.max(148, Math.min(196, h * 0.205));
    this.noteSize = Math.min(26, this.laneW * 0.46);
    this.noteW = Math.min(118, this.laneW * 0.76);
    this.noteH = clamp(this.laneW * 0.16, 13, 22);
    this.padTop = this.judgeY + 18;
    this.padH = clamp(h * 0.07, 44, 60);
  }

  start(fromSec) {
    this.running = true;
    this.paused = false;
    this.finished = false;
    // 开场缓冲：至少有 LEAD_IN 秒让玩家看清键位、听完 3-2-1。
    // 之前是 `Math.max(0, firstNote - 3.0)`，凡是第一颗音在 3 秒内的曲子
    // 都会被压成 0 —— 一开播就直接开打，完全没有准备时间。
    const LEAD_IN = 3.4;
    let from;
    let delay = 0;
    if (fromSec != null) {
      from = Math.max(0, fromSec);
    } else if (this.firstNote >= LEAD_IN) {
      from = this.firstNote - LEAD_IN;
    } else {
      // 曲子一上来就有音：先静音等 LEAD_IN 秒（谱面时间从负数开始走）
      from = 0;
      delay = LEAD_IN - this.firstNote;
    }
    // 从中途开始时不把开头音符算作 MISS
    this.missCursor = 0;
    while (this.missCursor < this.notes.length && this.notes[this.missCursor].t < from) this.missCursor++;
    if (this.clockMode === 'perf') {
      this.perfT0 = performance.now();
      this.perfStart = from - delay;
    } else {
      this.audio.play(from, delay);
    }
    this.lastTs = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  pause() {
    if (!this.running || this.finished) return;
    this.paused = true;
    if (this.clockMode === 'perf') this._pausedAt = this.now();
    else this.audio.pause();
  }

  resume() {
    if (!this.running || this.finished) return;
    this.paused = false;
    if (this.clockMode === 'perf') {
      this.perfT0 = performance.now();
      this.perfStart = this._pausedAt != null ? this._pausedAt : this.perfStart;
    } else {
      this.audio.play(this.audio.offset);
    }
    this.lastTs = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  destroy() {
    this.running = false;
    this.paused = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._resize);
    this.audio.stop();
  }

  setSpeed(v) {
    this.speed = v;
    this.travelTime = 1.75 / v;
  }

  now() {
    if (this.clockMode === 'perf') {
      return this.perfStart + (performance.now() - this.perfT0) / 1000 + this.timeOffset;
    }
    return this.audio.position + this.timeOffset;
  }

  loop(ts) {
    if (!this.running || this.paused || this.finished) return;
    const dt = Math.min(0.05, (ts - this.lastTs) / 1000);
    this.lastTs = ts;
    const now = this.now();
    this.update(now, dt);
    this.render(now, dt);
    if (!this.finished) this.raf = requestAnimationFrame((t) => this.loop(t));
  }

  /* ---------------- 判定 ---------------- */
  update(now, dt) {
    // 漏掉
    while (this.missCursor < this.notes.length && this.notes[this.missCursor].t < now - W_HIT) {
      const n = this.notes[this.missCursor];
      if (n.state === 'idle') this.judge(n, 'MISS', 0);
      this.missCursor++;
    }
    // 自动演示
    if (this.auto) {
      for (let i = 0; i < this.notes.length; i++) {
        const n = this.notes[i];
        if (n.t > now + 0.02) break;
        if (n.state === 'idle' && n.t <= now + 0.02 && n.t > now - 0.14) {
          this.spaceDown = true;
          this.hitNote(n, now - n.t);
          this.spaceDown = false;
          if (n.type === 'hold') n.autoHold = true;
        }
      }
    }
    // 长条：一直按住到尾巴就自动满分
    for (const n of this.notes) {
      if (n.state !== 'holding') continue;
      if (now > n.t + n.dur + 0.04) {
        this.judge(n, 'JUST', now - (n.t + n.dur));
      }
    }
    // 碎屑动效
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 620 * dt;
      p.vx *= 0.985;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].life -= dt;
      if (this.rings[i].life <= 0) this.rings.splice(i, 1);
    }
    for (let i = 0; i < 4; i++) this.laneFlash[i] = Math.max(0, this.laneFlash[i] - dt * 3.4);
    if (this.judgeText) {
      this.judgeText.life -= dt;
      if (this.judgeText.life <= 0) this.judgeText = null;
    }

    // 倒计时（最多数到 3，别因为缓冲长一点就冒出个"4"）
    const remain = this.firstNote - now;
    if (remain > 0.35 && remain <= 3.4) {
      const v = Math.min(3, Math.ceil(remain));
      if (v !== this.countdownValue) {
        this.countdownValue = v;
        this.showCountdown(String(v));
      }
    } else if (this.countdownValue !== null && remain <= 0.35) {
      this.countdownValue = null;
      this.showCountdown('GO');
    }

    // 结束
    if (now > this.lastNoteEnd + 2.0 || (!this.audio.playing && now > this.lastNoteEnd + 0.4)) {
      this.finish();
    }
  }

  showCountdown(text) {
    if (this.onCountdown) this.onCountdown(text);
  }

  judge(n, type, err) {
    if (n.state === 'done') return;
    n.state = 'done';
    n.judged = type;
    const special = n.type === 'special';
    const weight = special ? (n.bound ? 2 : 1) : n.type === 'hold' ? 1.5 : 1;
    let gain = 0;
    if (type === 'JUST') gain = 1;
    else if (type === 'RUSH' || type === 'COOL') gain = 0.5;
    else gain = 0;
    this.score += this.unit * weight * gain;

    if (type === 'MISS') {
      this.stats.miss++;
      this.combo = 0;
      this.judgeText = { text: 'MISS', life: 0.55, max: 0.55, color: '#fb7185', lane: n.lane };
      this.onStats(this.snapshot());
    } else {
      this.stats[type.toLowerCase()]++;
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.judgedCount++;
      this.weightJudged += weight * gain;
      this.spawnHit(n.lane, type, special);
      this.audio.hit(special ? 'special' : 'tap');
      this.onStats(this.snapshot());
      if (this.onCombo) this.onCombo(this.combo);
    }
    void err;
  }

  snapshot() {
    const judged = this.stats.just + this.stats.rush + this.stats.cool + this.stats.miss;
    const acc = judged
      ? (this.stats.just + (this.stats.rush + this.stats.cool) * 0.5) / judged
      : 1;
    return {
      score: Math.round(this.score),
      combo: this.combo,
      maxCombo: this.maxCombo,
      acc,
      stats: { ...this.stats },
      progress: clamp((this.now() - 0) / (this.audio.duration || 1), 0, 1),
    };
  }

  spawnHit(lane, type, special) {
    const x = this.fieldX + this.laneW * (lane + 0.5);
    const y = this.judgeY;
    const color = type === 'JUST' ? this.theme.a3 : this.theme.lane[lane];
    const n = special ? 16 : 9;
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
      const sp = 90 + Math.random() * 260;
      this.particles.push({
        x: x + (Math.random() - 0.5) * this.noteSize * 0.6,
        y: y + (Math.random() - 0.5) * 8,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: 0.35 + Math.random() * 0.35,
        max: 0.7,
        size: 1.4 + Math.random() * 2.6,
        color,
      });
    }
    this.rings.push({ x, y, r: 6, life: 0.42, max: 0.42, color, lane });
    this.laneFlash[lane] = 1;
    this.judgeText = {
      text: type,
      life: 0.42,
      max: 0.42,
      color: type === 'JUST' ? '#a5f3fc' : type === 'RUSH' ? '#fcd34d' : '#c4b5fd',
      lane,
    };
  }

  hitNote(n, err) {
    if (n.type === 'hold') {
      const ad = Math.abs(err);
      if (ad > W_HIT) return;
      n.state = 'holding';
      this.laneFlash[n.lane] = 0.8;
      this.audio.hit('tap');
      this.rings.push({
        x: this.fieldX + this.laneW * (n.lane + 0.5),
        y: this.judgeY,
        r: 4,
        life: 0.3,
        max: 0.3,
        color: this.theme.lane[n.lane],
      });
      return;
    }
    if (n.type === 'special') {
      n.bound = !!(this.spaceDown || performance.now() - (this.lastSpaceTime || -1e9) < 130);
    }
    if (Math.abs(err) <= W_JUST) this.judge(n, 'JUST', err);
    else if (err < 0) this.judge(n, 'RUSH', err);
    else this.judge(n, 'COOL', err);
  }

  releaseHold(lane, now) {
    for (let i = this.laneNotes[lane].length - 1; i >= 0; i--) {
      const n = this.laneNotes[lane][i];
      if (n.state !== 'holding') continue;
      const err = now - (n.t + n.dur);
      if (now < n.t + n.dur - W_HOLD_BREAK) {
        this.judge(n, 'MISS', err);
      } else if (Math.abs(err) <= W_HOLD_RELEASE) {
        this.judge(n, 'JUST', err);
      } else if (err < 0) {
        this.judge(n, 'RUSH', err);
      } else {
        this.judge(n, 'COOL', err);
      }
      break;
    }
  }

  /* ---------------- 输入 ---------------- */
  pressLane(lane) {
    if (!this.running || this.paused || this.finished) return;
    const idx = lane;
    this.lanePressed[idx] = true;
    this.laneFlash[idx] = 1;
    const now = this.now();
    const arr = this.laneNotes[idx];
    let i = this.laneCursor[idx];
    while (i < arr.length && arr[i].state !== 'idle') i++;
    this.laneCursor[idx] = i;
    let best = null;
    let bestErr = 1e9;
    for (; i < arr.length; i++) {
      const n = arr[i];
      if (n.state !== 'idle') continue;
      if (n.t - now > W_HIT) break;
      const err = now - n.t;
      if (Math.abs(err) > W_HIT) continue;
      if (Math.abs(err) < Math.abs(bestErr)) {
        best = n;
        bestErr = err;
      }
    }
    if (!best) {
      if (this.bindMode) this.bindZoneMiss(idx);
      return;
    }
    this.hitNote(best, bestErr);
  }

  releaseLane(lane) {
    const idx = lane;
    this.lanePressed[idx] = false;
    if (!this.running || this.paused || this.finished) return;
    this.releaseHold(idx, this.now());
  }

  bindZoneMiss(lane) {
    this.stats.miss++;
    this.combo = 0;
    this.score = Math.max(0, this.score - this.unit * 0.5);
    this.judgeText = { text: 'MISS', life: 0.45, max: 0.45, color: '#fb7185', lane };
    this.laneFlash[lane] = 0.7;
    this.onStats(this.snapshot());
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.audio.stop();
    const s = this.snapshot();
    const realAcc = this.stats.just + this.stats.rush + this.stats.cool + this.stats.miss;
    this.onFinish({
      score: Math.round(this.score),
      maxCombo: this.maxCombo,
      acc: realAcc ? (this.stats.just + (this.stats.rush + this.stats.cool) * 0.5) / realAcc : 0,
      stats: { ...this.stats },
      noteCount: this.notes.length,
      chart: this.chart,
      ...s,
    });
  }

  /* ---------------- 渲染 ---------------- */
  render(now, dt) {
    const ctx = this.ctx;
    const { W, H } = this;
    ctx.clearRect(0, 0, W, H);
    this.drawBackground(now);
    this.drawField(now);
    this.drawNotes(now);
    this.drawJudgeLine(now);
    this.drawKeyPads();
    this.drawEffects(dt);
    this.drawJudgeText();
    void dt;
  }

  drawBackground(now) {
    const ctx = this.ctx;
    const { W, H } = this;
    ctx.fillStyle = '#050410';
    ctx.fillRect(0, 0, W, H);

    const t = now * 0.35;
    const blobs = [
      { x: W * (0.3 + Math.sin(t * 0.7) * 0.06), y: H * 0.18, r: Math.max(W, H) * 0.5, c: this.theme.a1, a: 0.16 },
      { x: W * (0.74 + Math.cos(t * 0.55) * 0.05), y: H * 0.72, r: Math.max(W, H) * 0.42, c: this.theme.a2, a: 0.12 },
      { x: W * 0.5, y: H * 1.02, r: Math.max(W, H) * 0.5, c: this.theme.a3, a: 0.06 },
    ];
    ctx.globalCompositeOperation = 'lighter';
    for (const b of blobs) {
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
      g.addColorStop(0, hexA(b.c, b.a));
      g.addColorStop(1, hexA(b.c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';

    // 实时频谱（背景底部）
    const spec = this.audio.spectrum();
    const live = spec && this.audio.playing;
    const bars = 56;
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      let v;
      if (live) {
        const idx = Math.floor(Math.pow(i / bars, 1.5) * (spec.length * 0.7));
        v = spec[idx] / 255;
      } else {
        // 没有音频（自动演示/静音）时用节拍驱动的装饰波形
        v = Math.abs(Math.sin(i * 0.63 + now * 2.2)) * 0.5 + Math.abs(Math.sin(i * 0.21 - now * 1.1)) * 0.35;
        v *= 0.55 + 0.45 * Math.abs(Math.sin(now * 3.1));
      }
      const bh = Math.pow(v, 1.6) * H * 0.3;
      const alpha = 0.05 + v * 0.16;
      const g = ctx.createLinearGradient(0, H - bh, 0, H);
      g.addColorStop(0, hexA(this.theme.a2, alpha));
      g.addColorStop(1, hexA(this.theme.a1, 0));
      ctx.fillStyle = g;
      ctx.fillRect(i * bw + bw * 0.2, H - bh, bw * 0.6, bh);
    }

    // 漂浮尘埃
    if (!this.dust) {
      this.dust = Array.from({ length: 46 }, () => ({
        x: Math.random(),
        y: Math.random(),
        s: 0.4 + Math.random() * 1.6,
        sp: 0.008 + Math.random() * 0.026,
        a: 0.06 + Math.random() * 0.2,
      }));
    }
    for (const d of this.dust) {
      d.y -= d.sp * 0.016;
      if (d.y < -0.02) {
        d.y = 1.02;
        d.x = Math.random();
      }
      ctx.fillStyle = hexA('#ffffff', d.a);
      ctx.beginPath();
      ctx.arc(d.x * W, d.y * H, d.s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawField(now) {
    const ctx = this.ctx;
    const { fieldX: fx, fieldW: fw, laneW: lw, H } = this;
    const top = -10;

    const g = ctx.createLinearGradient(0, top, 0, H);
    g.addColorStop(0, 'rgba(8,6,18,0.1)');
    g.addColorStop(0.55, 'rgba(9,7,20,0.5)');
    g.addColorStop(1, 'rgba(12,9,26,0.86)');
    ctx.fillStyle = g;
    ctx.fillRect(fx, top, fw, H - top);

    // 每条轨道的色调
    for (let i = 0; i < LANES; i++) {
      const x = fx + lw * i;
      const lg = ctx.createLinearGradient(0, 0, 0, this.judgeY);
      lg.addColorStop(0, hexA(this.theme.lane[i], 0.005));
      lg.addColorStop(0.75, hexA(this.theme.lane[i], 0.03));
      lg.addColorStop(1, hexA(this.theme.lane[i], 0.07));
      ctx.fillStyle = lg;
      ctx.fillRect(x, 0, lw, this.judgeY);
    }

    // 拍点网格线
    const beatDur = 60 / this.chart.bpm;
    const startBeat = Math.floor((now - 0.4 - this.chart.beatOffset) / beatDur);
    const endBeat = Math.ceil((now + this.travelTime) / beatDur);
    for (let b = startBeat; b <= endBeat; b++) {
      const bt = this.chart.beatOffset + b * beatDur;
      const y = this.judgeY * (1 - (bt - now) / this.travelTime);
      if (y < -20 || y > this.judgeY) continue;
      const strong = b % 4 === 0;
      ctx.strokeStyle = hexA(this.theme.a1, strong ? 0.13 : 0.05);
      ctx.lineWidth = strong ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(fx, y);
      ctx.lineTo(fx + fw, y);
      ctx.stroke();
    }

    // 轨道分隔
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    for (let i = 1; i < LANES; i++) {
      const x = fx + lw * i;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, this.judgeY);
      ctx.stroke();
    }
    // 外框
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(fx + 0.5, top + 0.5, fw - 1, this.judgeY - top);
  }

  drawNotes(now) {
    const ctx = this.ctx;
    const { fieldX: fx, laneW: lw, judgeY, noteSize: size, travelTime } = this;
    const tMax = now + travelTime;
    const tMin = now - 0.2;

    for (const n of this.notes) {
      if (n.t > tMax) break;
      if (n.state === 'done') continue;
      const y = judgeY * (1 - (n.t - now) / travelTime);
      const x = fx + lw * (n.lane + 0.5);
      if (y < -size * 3) continue;

      // 顶部淡入，避免音符在屏幕边缘硬生生被切断
      const fade = Math.min(1, Math.max(0, (y - 8) / 86));
      ctx.globalAlpha = fade;
      if (n.type === 'hold') {
        const endT = n.t + n.dur;
        const yTail = judgeY * (1 - (endT - now) / travelTime);
        if (endT < tMin) continue;
        this.drawHold(x, y, yTail, n, now);
        ctx.globalAlpha = 1;
        continue;
      }
      if (n.type === 'special') this.drawSpecial(x, y, n);
      else this.drawTap(x, y, n);
      ctx.globalAlpha = 1;
    }
  }

  rrect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  /** 横向长条音符（Sparebeat 风格）：不会挡住判定线 */
  drawBar(x, y, n, scale = 1) {
    const ctx = this.ctx;
    const special = n.type === 'special';
    const w = this.noteW * scale;
    const h = this.noteH * scale;
    const color = this.theme.lane[n.lane];
    const rad = Math.min(9, h / 2);

    // 外发光
    ctx.fillStyle = hexA(color, special ? 0.24 : 0.14);
    this.rrect(x - w / 2 - 4, y - h / 2 - 4, w + 8, h + 8, rad + 3);
    ctx.fill();

    // 主体
    const g = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.34, color);
    g.addColorStop(1, hexA(color, 0.68));
    ctx.fillStyle = g;
    this.rrect(x - w / 2, y - h / 2, w, h, rad);
    ctx.fill();

    // 上沿高光
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    this.rrect(x - w / 2 + 5, y - h / 2 + 2, Math.max(4, w - 10), 2.4, 1.2);
    ctx.fill();

    // 描边
    ctx.strokeStyle = special ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = special ? 2.2 : 1.1;
    this.rrect(x - w / 2, y - h / 2, w, h, rad);
    ctx.stroke();

    if (special) {
      const r = Math.min(h * 0.34, 6.5);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI / 4) * i - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * 0.4;
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  drawTap(x, y, n) {
    this.drawBar(x, y, n);
  }

  drawSpecial(x, y, n) {
    this.drawBar(x, y, n);
  }

  drawHold(x, y, yTail, n) {
    const ctx = this.ctx;
    const color = this.theme.lane[n.lane];
    const headY = n.state === 'holding' ? this.judgeY : y;
    const top = Math.min(headY, yTail);
    const h = Math.abs(headY - yTail);
    const bw = this.noteW * 0.3;

    if (h > 2) {
      const g = ctx.createLinearGradient(0, top, 0, top + h);
      g.addColorStop(0, hexA(color, 0.22));
      g.addColorStop(1, hexA(color, 0.86));
      ctx.fillStyle = g;
      this.rrect(x - bw / 2, top, bw, h, bw / 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(x - bw * 0.15, top + 5, bw * 0.3, Math.max(0, h - 10));
      ctx.strokeStyle = hexA('#ffffff', 0.26);
      ctx.lineWidth = 1;
      this.rrect(x - bw / 2, top, bw, h, bw / 2);
      ctx.stroke();
    }

    // 尾端压条
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    this.rrect(x - this.noteW * 0.21, yTail - 3, this.noteW * 0.42, 6, 3);
    ctx.fill();

    if (n.state !== 'holding') this.drawBar(x, y, n);
  }

  drawJudgeLine(now) {
    const ctx = this.ctx;
    const { fieldX: fx, fieldW: fw, judgeY, laneW: lw } = this;
    // 判定线跟着拍点轻微呼吸，给玩家一个可见的节拍参照
    const beatDur = 60 / this.chart.bpm;
    const beatPos = (now - this.chart.beatOffset) / beatDur;
    const beatFrac = beatPos - Math.floor(beatPos);
    const pulse = 0.72 + 0.28 * Math.pow(1 - beatFrac, 3);

    // 判定带（上方渐隐）
    const band = ctx.createLinearGradient(0, judgeY - 30, 0, judgeY + 26);
    band.addColorStop(0, hexA('#ffffff', 0));
    band.addColorStop(0.6, hexA(this.theme.a1, 0.08));
    band.addColorStop(1, hexA('#ffffff', 0.22));
    ctx.fillStyle = band;
    ctx.fillRect(fx, judgeY - 30, fw, 56);

    // 深色底衬，拉开对比
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(fx, judgeY - 4.5, fw, 9);

    // 主线：彩色描边 + 白色核心
    ctx.fillStyle = hexA(this.theme.a1, 0.9 * pulse);
    ctx.fillRect(fx, judgeY - 3, fw, 6);
    ctx.fillStyle = 'rgba(255,255,255,0.98)';
    ctx.fillRect(fx, judgeY - 1.4, fw, 2.8);

    // 每轨中点刻度
    for (let i = 0; i < LANES; i++) {
      const x = fx + lw * (i + 0.5);
      ctx.fillStyle = hexA('#ffffff', 0.75);
      ctx.fillRect(x - lw * 0.16, judgeY - 1, lw * 0.32, 2);
    }

    // 线下落影
    const sh = ctx.createLinearGradient(0, judgeY + 4, 0, judgeY + 22);
    sh.addColorStop(0, hexA(this.theme.a1, 0.16));
    sh.addColorStop(1, hexA(this.theme.a1, 0));
    ctx.fillStyle = sh;
    ctx.fillRect(fx, judgeY + 4, fw, 18);
  }

  drawKeyPads() {
    const ctx = this.ctx;
    const { fieldX: fx, laneW: lw, padTop, padH } = this;
    const labels = ['D', 'F', 'J', 'K'];
    for (let i = 0; i < LANES; i++) {
      const x = fx + lw * i + 4;
      const w = lw - 8;
      const on = this.lanePressed[i];
      const fl = this.laneFlash[i];
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, padTop, w, padH, 10);
      else ctx.rect(x, padTop, w, padH);
      ctx.fillStyle = on ? hexA(this.theme.lane[i], 0.5) : hexA(this.theme.lane[i], 0.1 + fl * 0.3);
      ctx.fill();
      ctx.strokeStyle = on ? hexA('#ffffff', 0.85) : hexA(this.theme.lane[i], 0.35 + fl * 0.4);
      ctx.lineWidth = on ? 1.8 : 1;
      ctx.stroke();

      ctx.fillStyle = on ? '#ffffff' : hexA('#ffffff', 0.55);
      ctx.font = `600 ${Math.round(Math.min(15, lw * 0.26))}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(labels[i], x + w / 2, padTop + padH / 2);
    }
  }

  drawEffects(dt) {
    const ctx = this.ctx;
    // 轨道闪光
    for (let i = 0; i < LANES; i++) {
      const f = this.laneFlash[i];
      if (f <= 0.01) continue;
      const x = this.fieldX + this.laneW * i;
      const g = ctx.createLinearGradient(0, this.judgeY - 220, 0, this.judgeY);
      g.addColorStop(0, hexA(this.theme.lane[i], 0));
      g.addColorStop(1, hexA(this.theme.lane[i], 0.22 * f));
      ctx.fillStyle = g;
      ctx.fillRect(x, this.judgeY - 220, this.laneW, 220);
    }
    // 粒子
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.fillStyle = hexA(p.color, a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + a * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    // 光环
    for (const r of this.rings) {
      const k = 1 - r.life / r.max;
      const rad = r.r + k * this.noteSize * 2.4;
      ctx.strokeStyle = hexA(r.color, (1 - k) * 0.8);
      ctx.lineWidth = 3 * (1 - k) + 0.6;
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    void dt;
  }

  drawJudgeText() {
    const jt = this.judgeText;
    if (!jt) return;
    const ctx = this.ctx;
    const k = 1 - jt.life / jt.max;
    const x = this.fieldX + this.laneW * (jt.lane + 0.5);
    const y = this.judgeY - 78 - k * 28;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - k * 1.35);
    ctx.fillStyle = jt.color;
    ctx.font = `700 ${jt.text === 'MISS' ? 22 : 27}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(jt.text, x, y);
    ctx.restore();
  }
}
