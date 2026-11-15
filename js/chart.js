import { mulberry32 } from './fft.js';

/**
 * 谱面生成器
 * ------------------------------------------------------------------
 * 输入音频分析结果 → 输出三档难度（EASY / NORMAL / HARD）的 4K 谱面。
 *
 * 三条硬规则（来自 osu!mania / StepMania 的通行经验）：
 *   1. 音符必须落在拍网格上。人的耳朵判「准不准」看的是与拍点的关系，
 *      原始 onset 有 ±20ms 抖动，直接排谱会显得「松 / 慢半拍」。
 *   2. **jack（同键连打）只能用在「音乐上完全相同的两个音」**。
 *      随机产生 jack 必然难打 —— 这是自动谱面最容易犯的错。
 *   3. 键位要「有语汇」：等间隔连打走 roll / trill，零散音走自由跳，
 *      重音才给双押。整段随机游走会让人觉得「在瞎拍」。
 */

export const DIFFICULTIES = [
  {
    id: 'easy',
    name: 'EASY',
    tag: '轻松',
    color: '#4ade80',
    gridDiv: 4,
    fillDiv: 2,
    minGap: 0.215,
    npsQuiet: 1.3,
    npsLoud: 3.4,
    maxPerBar: 7,
    allowChord: false,
    allowFill: true,
    fillRate: 0.45,
    holdChance: 0.16,
    specialChance: 0.02,
    maxNps: 3.6,
    levelBase: 1,
    levelScale: 1.15,
    // 手感参数
    jack: 0.09,      // 同键连打权重
    trill: 1.6,
    jump: 0.5,       // 大跳（跨 3 个键）降权，EASY 尽量走相邻
    handBias: 1.35,
    anchor: 0.18,
  },
  {
    id: 'normal',
    name: 'NORMAL',
    tag: '标准',
    color: '#fbbf24',
    gridDiv: 4,
    fillDiv: 2,
    minGap: 0.135,
    npsQuiet: 2.4,
    npsLoud: 6.2,
    maxPerBar: 11,
    allowChord: true,
    chordChance: 0.08,
    allowFill: true,
    fillRate: 0.3,
    holdChance: 0.1,
    specialChance: 0.05,
    maxNps: 6.2,
    levelBase: 4.5,
    levelScale: 0.75,
    jack: 0.09,
    trill: 1.8,
    jump: 0.65,
    handBias: 1.45,
    anchor: 0.22,
  },
  {
    id: 'hard',
    name: 'HARD',
    tag: '狂暴',
    color: '#f472b6',
    gridDiv: 8,
    fillDiv: 4,
    minGap: 0.082,
    npsQuiet: 4.4,
    npsLoud: 9.9,
    maxPerBar: 20,
    allowChord: true,
    chordChance: 0.22,
    allowFill: true,
    fillRate: 0.7,
    holdChance: 0.05,
    specialChance: 0.07,
    maxNps: 11.8,
    levelBase: 8,
    levelScale: 0.62,
    jack: 0.035,     // 高速下同键连打几乎不可接受
    trill: 2.0,
    jump: 0.55,
    handBias: 1.5,
    anchor: 0.26,
  },
];

const LANE_KEYS = [0, 1, 2, 3];

/** 双押组合的舒适度权重：外外 > 外内 > 内内（1-2 食指内收最别扭） */
const CHORD_COMFORT = {
  '0-3': 1.0,
  '0-2': 0.7,
  '1-3': 0.7,
  '1-2': 0.12,
  '0-1': 0.14,
  '2-3': 0.14,
};

function chordKey(a, b) {
  return a < b ? a + '-' + b : b + '-' + a;
}

/** 把距离很近的击打点并成一个音符事件 */
function clusterOnsets(onsets, maxGap = 0.048) {
  const out = [];
  for (const o of onsets) {
    const last = out[out.length - 1];
    if (last && o.t - last.t <= maxGap) {
      const w = last.s + o.s;
      last.t = (last.t * last.s + o.t * o.s) / (w || 1);
      last.s = Math.max(last.s, o.s);
      if (o.s > last.s * 0.9) last.tone = o.tone;
    } else {
      out.push({ t: o.t, s: o.s, tone: o.tone, bands: o.bands });
    }
  }
  return out;
}

/** 每小节的"响度/热闹程度"曲线（0..1），用来决定该小节该多密 */
function barIntensity(analysis, firstBeat, beatDur) {
  const barDur = beatDur * 4;
  const rms = analysis.rms || new Float32Array(0);
  const fd = analysis.frameDur || 0.0232;
  const nBars = Math.max(1, Math.ceil((analysis.duration - firstBeat) / barDur) + 1);
  const raw = new Float32Array(nBars);
  for (let b = 0; b < nBars; b++) {
    const t0 = firstBeat + b * barDur;
    const i0 = Math.max(0, Math.round(t0 / fd));
    const i1 = Math.min(rms.length - 1, Math.round((t0 + barDur) / fd));
    let sum = 0;
    let cnt = 0;
    for (let i = i0; i <= i1; i++) {
      sum += rms[i];
      cnt++;
    }
    raw[b] = cnt ? sum / cnt : 0;
  }
  const sm = new Float32Array(nBars);
  for (let b = 0; b < nBars; b++) {
    const a = raw[Math.max(0, b - 1)];
    const c = raw[Math.min(nBars - 1, b + 1)];
    sm[b] = a * 0.26 + raw[b] * 0.48 + c * 0.26;
  }
  const sorted = Array.from(sm).sort((x, y) => x - y);
  const at = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)))] || 0;
  const lo = at(0.12);
  const hi = at(0.93);
  const den = Math.max(1e-4, hi - lo);
  const out = new Float32Array(nBars);
  for (let b = 0; b < nBars; b++) out[b] = Math.max(0, Math.min(1, (sm[b] - lo) / den));
  return out;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function weightedPick(weights, rng) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return Math.floor(rng() * weights.length);
  let r = rng() * sum;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * 键位编排器
 * 跨小节维护状态：上一个键、上上个键、近期手指使用率、锚点计数，
 * 这样选键时能同时照顾「别连按同一个键」「两手均衡」「别老用某根手指」。
 */
class LanePlanner {
  constructor(rng, cfg, step, beatDur) {
    this.rng = rng;
    this.cfg = cfg;
    this.step = step;
    this.beatDur = beatDur;
    this.lastLane = -1;
    this.prevLane = -1;
    this.recent = [];
    this.left = 0;
    this.right = 0;
    this.lastChord = '';
    this.famIdx = -1;
  }

  /** 单个键的权重：把所有"手感规则"乘在一起 */
  weigh(lane, isStrong) {
    const c = this.cfg;
    let s = 1;

    // 1) 同键连打：只有"音乐上完全相同的两个音"才该出现，
    //    自动排谱判断不了，所以一律重罚（重音也不例外）
    if (lane === this.lastLane) s *= c.jack;

    // 2) 交替（trill）：上上个键就是它，且上一个不是 → 形成 ABAB，最好打
    if (lane === this.prevLane && lane !== this.lastLane) s *= c.trill;

    // 3) 手平衡：近期少用的那只手加权
    const total = this.left + this.right;
    if (total >= 6) {
      const ratio = (lane < 2 ? this.left : this.right) / total;
      if (ratio < 0.4) s *= c.handBias;
      else if (ratio > 0.6) s *= 1 / c.handBias;
    }

    // 4) 锚点：最近 8 个音里这根键用太多次就压一压
    const win = this.recent.slice(-8);
    const same = win.filter((l) => l === lane).length;
    if (same >= 2) s *= Math.max(0.12, 1 - (same - 1) * c.anchor);

    // 5) 移动距离：相邻移动最顺手，大跳降权但保留变化
    if (this.lastLane >= 0) {
      const d = Math.abs(lane - this.lastLane);
      if (d === 3) s *= c.jump;
      else if (d === 2) s *= 0.92;
      else if (d === 1) s *= 1.15;
    }

    return Math.max(0.001, s);
  }

  pick(isStrong) {
    const w = LANE_KEYS.map((l) => this.weigh(l, isStrong));
    return weightedPick(w, this.rng);
  }

  commit(lane) {
    this.prevLane = this.lastLane;
    this.lastLane = lane;
    this.recent.push(lane);
    if (this.recent.length > 24) this.recent.shift();
    if (lane < 2) this.left++;
    else this.right++;
  }

  /** 双押的第二键：按舒适度选，避免连续同型 */
  partnerOf(lane) {
    const w = [0, 0, 0, 0];
    for (const l of LANE_KEYS) {
      if (l === lane) continue;
      const key = chordKey(lane, l);
      let base = CHORD_COMFORT[key] || 0.1;
      if (key === this.lastChord) base *= 0.2;
      w[l] = base;
    }
    return weightedPick(w, this.rng);
  }

  /** —— 等间隔连打的三种标准语汇 —— */
  makeRoll(n) {
    const dir = this.rng() < 0.5 ? 1 : -1;
    let start = Math.floor(this.rng() * 4);
    // 起点别贴着上一个键，避免小节交界处 jack
    if (start === this.lastLane) start = (start + 2) % 4;
    const out = [];
    for (let i = 0; i < n; i++) {
      // 注意 JS 的 % 对负数返回负数，必须再 +4 归一化
      const l = (((start + dir * i) % 4) + 4) % 4;
      out.push(l);
    }
    return out;
  }

  makeTrill(n) {
    // 六种键对按舒适度加权：跨手最优，1-2（两根食指内收）最少用
    const pairs = [
      { p: [0, 3], w: 1.15 },
      { p: [0, 2], w: 1.1 },
      { p: [1, 3], w: 1.1 },
      { p: [1, 2], w: 0.85 },
      { p: [0, 1], w: 0.95 },
      { p: [2, 3], w: 0.95 },
    ];
    const pair = pairs[weightedPick(pairs.map((x) => x.w), this.rng)].p;
    // 从离上一个键更远的那根开始，手感更自然
    let a = pair[0];
    let b = pair[1];
    if (Math.abs(this.lastLane - a) < Math.abs(this.lastLane - b)) [a, b] = [b, a];
    const out = [];
    for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? a : b);
    return out;
  }

  /**
   * 排一个小节。
   * items: [{ t, s }] 已按时间排序；bar 用于决定语汇轮换；eBar 是强度。
   */
  planBar(items, bar, eBar, out, barDur, firstBeat) {
    if (!items.length) return;
    const { rng, cfg, step } = this;

    // 节奏型识别：等间隔且够密 → 用连打语汇；否则自由跳
    const gaps = [];
    for (let i = 1; i < items.length; i++) gaps.push((items[i].t - items[i - 1].t) / step);
    const uniform =
      gaps.length >= 3 && gaps.every((g) => Math.abs(g - gaps[0]) < 0.15) && gaps[0] >= 0.9;
    const dense = uniform && gaps[0] <= 2.15; // 1/8 或更密

    // 每两小节换一次语汇，四小节一个循环，避免整首一个味道
    const fam = ((Math.floor(bar / 2) + (uniform ? 1 : 0)) % 2);
    let seq = null;
    if (dense && cfg.id !== 'easy') {
      if (fam === 0) seq = this.makeRoll(items.length);
      else seq = this.makeTrill(items.length);
    }

    const placed = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rel = (it.t - (firstBeat + bar * barDur)) / this.beatDur; // 0..4
      // 整拍 / 半拍都算重音位（反拍重音很常见），越靠整拍越强
      const isStrong = Math.abs(rel * 2 - Math.round(rel * 2)) < 0.12;

      let lane;
      if (seq) {
        lane = seq[i];
        // 语汇内部也要过一遍手感：万一撞上 jack 就改选
        if (lane === this.lastLane) lane = this.pick(isStrong);
      } else {
        lane = this.pick(isStrong);
      }
      if (!(lane >= 0 && lane < 4)) lane = this.pick(isStrong); // 兜底，绝不让非法轨道漏出去

      placed.push({ t: it.t, lane, s: it.s, tone: it.tone, strong: isStrong });
      this.commit(lane);
    }

    // 双押：只在强拍 + 足够炸的段落出现
    if (cfg.allowChord && eBar > 0.6) {
      const p = Math.min(0.5, (eBar - 0.6) * 1.8 * (cfg.chordChance + 0.16));
      for (const n of placed) {
        if (!n.strong) continue;
        if (rng() > p) continue;
        const partner = this.partnerOf(n.lane);
        if (placed.some((m) => Math.abs(m.t - n.t) < 0.02 && m.lane === partner)) continue;
        this.lastChord = chordKey(n.lane, partner);
        out.push({ t: n.t, lane: n.lane, type: 'tap', s: n.s, tone: n.tone });
        out.push({ t: n.t, lane: partner, type: 'tap', s: n.s, tone: n.tone });
        n.emitted = true;
      }
    }

    for (const n of placed) {
      if (!n.emitted) out.push({ t: n.t, lane: n.lane, type: 'tap', s: n.s, tone: n.tone });
    }
  }
}

export function generateChart(analysis, diff, options = {}) {
  const cfg = typeof diff === 'string' ? DIFFICULTIES.find((d) => d.id === diff) : diff;
  const { beatDur, firstBeat, duration } = analysis;
  const rng = mulberry32(hashString(`${cfg.id}:${Math.round(analysis.bpm * 10)}:${Math.round(duration)}`));
  const strengthAt = (t) => {
    const f = Math.round(t / analysis.frameDur);
    const arr = analysis.onsetStrength;
    if (f < 0 || f >= arr.length) return 0;
    return Math.max(arr[f], arr[Math.max(0, f - 1)] * 0.8);
  };

  const step = beatDur / cfg.gridDiv;
  const slotOf = (t) => Math.round((t - firstBeat) / step);
  const timeOf = (s) => firstBeat + s * step;
  const barDur = beatDur * 4;
  const barOf = (t) => Math.floor((t - firstBeat) / barDur);

  // ---- 1. 事件吸附到拍网格（同一格只留最强的一个）----
  const bySlot = new Map();
  for (const e of clusterOnsets(analysis.onsets)) {
    if (e.t <= 0.8 || e.t >= duration - 0.85) continue;
    const slot = slotOf(e.t);
    const t = timeOf(slot);
    if (Math.abs(t - e.t) > step * 0.55) continue;
    const pos = ((Math.round(((t - firstBeat) / beatDur) * 8) % 32) + 32) % 32;
    const inBeat = pos % 8;
    let bonus = 0;
    if (pos === 0) bonus = 0.3;
    else if (inBeat === 0) bonus = 0.19;
    else if (inBeat === 4) bonus = 0.1;
    else if (inBeat % 2 === 0) bonus = 0.05;
    const cand = { t, slot, s: e.s, tone: e.tone, bands: e.bands, pos, score: e.s + bonus };
    const prev = bySlot.get(slot);
    if (!prev || cand.score > prev.score) bySlot.set(slot, cand);
  }
  let events = [...bySlot.values()].sort((a, b) => a.t - b.t);

  if (cfg.id === 'easy') {
    events = events.filter((e) => {
      const p = e.pos % 8;
      const off = Math.min(p, 8 - p, Math.abs(p - 4));
      return off <= 1 || e.s > 0.5;
    });
  }

  // ---- 2. 局部强度 → 每小节目标密度 ----
  const curve = barIntensity(analysis, firstBeat, beatDur);
  const barCand = new Map();
  for (const e of events) {
    const b = barOf(e.t);
    if (!barCand.has(b)) barCand.set(b, []);
    barCand.get(b).push(e);
  }
  const barEnergy = (b) => {
    const i = Math.max(0, Math.min(curve.length - 1, b));
    const loud = curve[i] || 0;
    const n = (barCand.get(b) || []).length;
    const busy = Math.min(1, n / Math.max(4, barDur * (cfg.npsLoud + 1.2)));
    return Math.max(0, Math.min(1, loud * 0.76 + busy * 0.24));
  };

  const barKeys = [...barCand.keys()].sort((x, y) => x - y);
  const barTarget = new Map();
  const picked = [];
  for (const b of barKeys) {
    const e = barEnergy(b);
    const target = Math.max(
      1,
      Math.min(cfg.maxPerBar, Math.round((cfg.npsQuiet + (cfg.npsLoud - cfg.npsQuiet) * e) * barDur))
    );
    barTarget.set(b, target);
    const list = barCand.get(b).slice().sort((p, q) => q.score - p.score);
    let taken = 0;
    for (const ev of list) {
      if (taken >= target) break;
      let ok = true;
      for (let i = 0; i < picked.length; i++) {
        if (Math.abs(picked[i].t - ev.t) < cfg.minGap) {
          ok = false;
          break;
        }
      }
      if (ok) {
        picked.push(ev);
        taken++;
      }
    }
  }
  picked.sort((a, b) => a.t - b.t);

  // ---- 3. 补音：把每小节填到目标密度（先定时间轴，再排键位）----
  const timeline = picked.map((e) => ({ t: e.t, s: e.s, tone: e.tone, pos: e.pos }));
  const hasAt = (arr, t, tol) => arr.some((n) => Math.abs(n.t - t) < tol);
  if (cfg.allowFill) {
    const fstep = beatDur / cfg.fillDiv;
    const added = [];
    for (const bar of barKeys) {
      const t0 = firstBeat + bar * barDur;
      const eBar = barEnergy(bar);
      const target = barTarget.get(bar) || 4;
      let have = timeline.filter((n) => n.t >= t0 - 0.01 && n.t < t0 + barDur - 0.01).length;
      if (have >= target || eBar < 0.34) continue;

      const slots = [];
      for (let k = 0; k < 4 * cfg.fillDiv; k++) {
        const t = t0 + k * fstep;
        if (t >= t0 + barDur - 0.02) break;
        if (hasAt(timeline, t, fstep * 0.45) || hasAt(added, t, fstep * 0.45)) continue;
        // 补音优先补"本来就有声音"的位置，别凭空插
        const s = strengthAt(t);
        if (s < 0.07) continue;
        slots.push({ t, s, beatInBar: k / cfg.fillDiv });
      }
      slots.sort((p, q) => q.s - p.s);
      const minS = eBar > 0.7 ? 0.09 : 0.18;
      for (const sl of slots) {
        if (have >= target) break;
        if (sl.s < minS) break;
        if (rng() < 0.1) continue;
        added.push({ t: sl.t, s: sl.s, tone: 'hat', pos: null });
        have++;
      }
    }
    timeline.push(...added);
    timeline.sort((a, b) => a.t - b.t);
  }

  // ---- 4. 键位编排：按小节识别节奏型，套用语汇 ----
  const planner = new LanePlanner(rng, cfg, step, beatDur);
  const notes = [];
  const byBar = new Map();
  for (const n of timeline) {
    const b = barOf(n.t);
    if (!byBar.has(b)) byBar.set(b, []);
    byBar.get(b).push(n);
  }
  for (const b of [...byBar.keys()].sort((x, y) => x - y)) {
    planner.planBar(byBar.get(b), b, barEnergy(b), notes, barDur, firstBeat);
  }

  notes.sort((a, b) => a.t - b.t || a.lane - b.lane);

  // ---- 5. NPS 限流（1 秒滑动窗口）----
  const limited = [];
  const win = [];
  for (const n of notes) {
    while (win.length && n.t - win[0].t >= 1) win.shift();
    if (win.length >= cfg.maxNps) {
      if (win.some((m) => Math.abs(m.t - n.t) < 0.04 && m.lane === n.lane)) continue;
      let wi = 0;
      for (let i = 1; i < win.length; i++) if ((win[i].s || 0) < (win[wi].s || 0)) wi = i;
      if ((win[wi].s || 0) < (n.s || 0) * 0.85) {
        const idx = limited.indexOf(win[wi]);
        if (idx >= 0) limited.splice(idx, 1);
        win.splice(wi, 1);
      } else {
        continue;
      }
    }
    win.push(n);
    limited.push(n);
  }

  // ---- 6. 长条：留给"有空隙的强拍"，别跟连打抢位置 ----
  const withHolds = [];
  const sorted = limited.slice().sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const prev = sorted[i - 1];
    const prevSame = prev && prev.lane === n.lane && n.t - prev.t < beatDur * 1.2;
    if (n.type !== 'tap' || prevSame || rng() > cfg.holdChance * 1.1) {
      withHolds.push(n);
      continue;
    }
    // 长条可以跨过别的轨道的音，只要本轨道后面没有更近的音
    const nextSame = sorted.slice(i + 1).find((m) => m.lane === n.lane);
    const limit = nextSame ? nextSame.t - beatDur * 0.28 : n.t + beatDur * 3;
    const dur = Math.min(beatDur * 2.5, limit - n.t);
    // 太短没意义；长条要落在"有声音"的地方
    if (dur > beatDur * 0.75 && analysis.energyAt(n.t + beatDur * 0.5) > 0.3) {
      withHolds.push({ ...n, type: 'hold', dur });
    } else {
      withHolds.push(n);
    }
  }
  const holds = withHolds.filter((n) => n.type === 'hold');
  const final = withHolds.filter((n) => {
    if (n.type === 'hold') return true;
    return !holds.some((h) => h.lane === n.lane && n.t > h.t + 0.02 && n.t < h.t + h.dur + 0.05);
  });

  // ---- 7. 特殊音符（需配合空格，双倍分数）----
  let lastSpecial = -9;
  for (const n of final) {
    if (n.type !== 'tap') continue;
    if (n.t - lastSpecial < beatDur * 6) continue;
    const pos = ((Math.round(((n.t - firstBeat) / beatDur) * 8) % 32) + 32) % 32;
    if (pos % 8 !== 0 && pos % 8 !== 4) continue;
    if (n.s < 0.55) continue;
    if (rng() < cfg.specialChance) {
      n.type = 'special';
      lastSpecial = n.t;
    }
  }

  final.sort((a, b) => a.t - b.t || a.lane - b.lane);

  // ---- 8. 统计与难度定级 ----
  const playable = final.filter((n) => n.t > 0);
  const span = Math.max(1, (playable[playable.length - 1]?.t || 0) - (playable[0]?.t || 0));
  const nps = playable.length / span;
  const level = Math.max(1, Math.min(15, Math.round(cfg.levelBase + nps * cfg.levelScale)));
  const totalWeight = playable.reduce((s, n) => s + (n.type === 'special' ? 2 : n.type === 'hold' ? 1.5 : 1), 0);

  return {
    id: cfg.id,
    name: cfg.name,
    tag: cfg.tag,
    color: cfg.color,
    level,
    bpm: analysis.bpm,
    beatOffset: firstBeat,
    notes: playable,
    noteCount: playable.length,
    nps: Math.round(nps * 100) / 100,
    maxNps: cfg.maxNps,
    totalWeight,
    duration,
    seed: hashString(`${cfg.id}:${Math.round(analysis.bpm * 10)}`),
    ...options,
  };
}

export function generateAll(analysis) {
  return DIFFICULTIES.map((d) => generateChart(analysis, d));
}
