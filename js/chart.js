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
 * 乐句主题 = 一个短句的"说法"：走 roll 还是 trill、从哪个键起、往哪个方向。
 * 同一段音乐重复出现时复用它，玩家才能"学会"这一句。
 */
function makeTheme(rng) {
  // 只用"跨手"键对：0-1 / 2-3 是同手 trill，一整段都由一只手打，
  // 既累又会把整段音符堆到一侧（4K 里属于特殊技巧，不该自动谱默认用）。
  // 四对等权，刚好让每根键出现频率一致。
  const pairs = [
    { p: [0, 3], w: 1 },
    { p: [0, 2], w: 1 },
    { p: [1, 3], w: 1 },
    { p: [1, 2], w: 1 },
  ];
  const r = rng();
  return {
    kind: r < 0.42 ? 'roll' : r < 0.8 ? 'trill' : 'free',
    dir: rng() < 0.5 ? 1 : -1,
    start: Math.floor(rng() * 4),
    pair: pairs[weightedPick(pairs.map((x) => x.w), rng)].p,
  };
}

/**
 * 段落规划：4 小节一个乐句，乐句之间按"能量 / 音符密度 / 上升趋势"比相似度，
 * 足够像就判定为「同一段音乐的重复」，复用同一个主题。
 *
 * 这是"一致性"的来源 —— 副歌重复两次，配置也重复，玩家能预判下一拍。
 * 阈值故意压得比较严（0.5σ）：宁可漏判，也不能把不相关的段落强行配对。
 */
function planPhrases(barEnergy, rng) {
  const nBars = barEnergy.length;
  // 按能量分三档：安静 / 正常 / 高潮。档位决定了"这一段该长什么样"。
  const tierOf = (e) => (e > 0.62 ? 2 : e > 0.34 ? 1 : 0);

  // 连续同档的小节 = 一个段落
  const segs = [];
  for (let b = 0; b < nBars; b++) {
    const t = tierOf(barEnergy[b]);
    const last = segs[segs.length - 1];
    if (last && last.tier === t) last.len++;
    else segs.push({ tier: t, start: b, len: 1 });
  }
  // 太短的段落并到前一段，避免 1 小节的档位抖动把结构打碎
  const merged = [];
  for (const sg of segs) {
    const prev = merged[merged.length - 1];
    if (prev && sg.len < 2) {
      prev.len += sg.len;
    } else {
      merged.push({ ...sg });
    }
  }

  // 每个档位两套主题（主 / 副），同一档位的不同段落交替使用，
  // 既保证"同类段落风格一致"，又不会整首一个味道。
  const pools = [
    [makeTheme(rng), makeTheme(rng)],
    [makeTheme(rng), makeTheme(rng)],
    [makeTheme(rng), makeTheme(rng)],
  ];
  const used = [0, 0, 0];
  for (const sg of merged) {
    sg.theme = pools[sg.tier][used[sg.tier] % 2];
    used[sg.tier]++;
  }
  return { segs: merged, nBars };
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
    this.laneUse = [0, 0, 0, 0];
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
    this.laneUse[lane]++;
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
  makeRoll(n, theme, vary) {
    // 方向 / 起始键完全由乐句主题决定 —— 不能再因为"上一个音是什么"而改起点，
    // 否则同一段音乐重复出现时会走成两条不同的线（一致性就没了）。
    // 交界处的 jack 由调用方那个单点检查处理。
    const dir = vary ? -theme.dir : theme.dir;
    const start = theme.start;
    const out = [];
    for (let i = 0; i < n; i++) {
      // 注意 JS 的 % 对负数返回负数，必须再 +4 归一化
      const l = (((start + dir * i) % 4) + 4) % 4;
      out.push(l);
    }
    return out;
  }

  makeTrill(n, theme, vary) {
    let [a, b] = theme.pair;
    if (vary) [a, b] = [b, a]; // 后半句反过来，形成"呼应"而不是复制
    const out = [];
    for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? a : b);
    return out;
  }

  /**
   * 换一个乐句主题。
   * laneMap 只有"复用的乐句"才有：它是第一次出现时每个音符的
   * {相对位置, 键位}，复用句按位置查表就能得到几乎相同的配置。
   */
  setTheme(theme, laneMap) {
    this.theme = theme;
    this.laneMap = laneMap || null;
  }

  /**
   * 排一个小节。
   * barInPhrase: 0..3，句内位置决定"主题"还是"变体"
   * theme: 本乐句的主题（roll 方向 / 起始键 / trill 键对）
   */
  planBar(items, barInPhrase, eBar, out, barDur, barStart, phraseStart, phraseDur) {
    if (!items.length) return;
    const { rng, cfg, step, theme } = this;

    // 节奏型识别：等间隔且够密 → 用连打语汇；否则自由跳
    const gaps = [];
    for (let i = 1; i < items.length; i++) gaps.push((items[i].t - items[i - 1].t) / step);
    const uniform =
      gaps.length >= 3 && gaps.every((g) => Math.abs(g - gaps[0]) < 0.15) && gaps[0] >= 0.9;
    const dense = uniform && gaps[0] <= 2.15; // 1/8 或更密

    // 句内前两小节走"主题"，后两小节走"变体"：既一致又不机械
    const vary = barInPhrase >= 2;
    let seq = null;
    if (dense && cfg.id !== 'easy' && theme && theme.kind !== 'free') {
      // trill 只覆盖两根键，连续用会让整段堆在中间两根键上。
      // 所以让它隔小节出现，其余小节用 roll 把四根键都走到。
      const useTrill = theme.kind === 'trill' ? barInPhrase % 2 === 1 : barInPhrase % 4 === 3;
      seq = useTrill
        ? this.makeTrill(items.length, theme, vary)
        : this.makeRoll(items.length, theme, vary);
    }

    const placed = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rel = (it.t - barStart) / this.beatDur; // 0..4
      // 整拍 / 半拍都算重音位（反拍重音很常见）
      const isStrong = Math.abs(rel * 2 - Math.round(rel * 2)) < 0.12;

      let lane = -1;
      if (this.laneMap) {
        // 复用段落：按「段内第几小节 + 小节内位置」查第一次出现时的键位。
        // 不能用整段的相对位置 —— 段落长度不一样（8 小节 vs 21 小节），
        // 归一化后步长不同，永远对不上。
        const barRel = (barStart - phraseStart) / barDur;
        const relInBar = (it.t - barStart) / barDur; // 0..1
        let bestD = Infinity;
        for (const m of this.laneMap) {
          const d = Math.abs(m.bar - barRel) * 0.8 + Math.abs(m.rel - relInBar) * 1.6;
          if (d < bestD) {
            bestD = d;
            lane = m.lane;
          }
        }
        if (bestD > 0.3) lane = -1; // 对不上就交回自由选择

        // 照抄也要管手感：查表结果如果让某一手严重过载、或变成"锚点"，
        // 就交回加权选择。否则一致性会把之前调好的平衡全毁了。
        if (lane >= 0) {
          const total = this.left + this.right;
          if (total > 8) {
            const ratio = (lane < 2 ? this.left : this.right) / total;
            if (ratio > 0.62) lane = -1;
          }
          const same = this.recent.slice(-8).filter((l) => l === lane).length;
          if (same >= 3) lane = -1;
          // 单键过载闸门：照抄会让整段锚在同样的几根键上，
          // 一旦某键占比超过 29% 就不抄了，交回加权选择把它摊平。
          if (lane >= 0 && total > 40) {
            if (this.laneUse[lane] / total > 0.29) lane = -1;
          }
        }
      }
      if (lane < 0 && seq) lane = seq[i];
      if (lane < 0) lane = this.pick(isStrong);
      // 语汇内部也要过一遍手感：万一撞上 jack 就改选
      if (lane === this.lastLane) lane = this.pick(isStrong);
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
  // 先做段落规划：密度和键位都要依赖"哪些乐句是音乐上重复的"
  const struct = planPhrases(curve, rng);
  const barTarget = new Map();
  const picked = [];

  // 密度：按小节能量插值，句内轻微推进（不盖过音乐本身的起伏）
  const PHRASE_SHAPE = [0.9, 0.96, 1.02, 1.1];
  for (const b of barKeys) {
    const e = barEnergy(b);
    let target = Math.round((cfg.npsQuiet + (cfg.npsLoud - cfg.npsQuiet) * e) * barDur);
    target = Math.round(target * PHRASE_SHAPE[((b % 4) + 4) % 4]);
    if (e < 0.16) target = Math.min(target, 2); // 极安静就留白
    target = Math.max(1, Math.min(cfg.maxPerBar, target));
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
        // 这里不再随机跳过：同一段音乐重复出现时，音符数必须一样，
        // 否则 pattern 再怎么复用也对不上（这是"一致性"的前提）
        added.push({ t: sl.t, s: sl.s, tone: 'hat', pos: null });
        have++;
      }
    }
    timeline.push(...added);
    timeline.sort((a, b) => a.t - b.t);
  }

  // ---- 4. 键位编排：按乐句主题套语汇 ----
  const planner = new LanePlanner(rng, cfg, step, beatDur);
  const notes = [];
  const byBar = new Map();
  for (const n of timeline) {
    const b = barOf(n.t);
    if (!byBar.has(b)) byBar.set(b, []);
    byBar.get(b).push(n);
  }
  const allBars = [...byBar.keys()].sort((x, y) => x - y);
  const barSet = new Set(allBars);
  // 每个档位只保留第一段的键位表，后续同档位的段落照着它排 ——
  // 这就是"副歌不管出现几次，配置都是同一套"的实现方式。
  const tierLaneMaps = new Map();

  for (const sg of struct.segs) {
    const laneMap = sg.tier > 0 ? tierLaneMaps.get(sg.tier) : null;
    const segStart = firstBeat + sg.start * barDur;
    const segDur = sg.len * barDur;
    const startIdx = notes.length;
    planner.setTheme(sg.theme, laneMap);

    for (let k = 0; k < sg.len; k++) {
      const b = sg.start + k;
      if (!barSet.has(b)) continue;
      planner.planBar(
        byBar.get(b),
        k * 2 >= sg.len ? 2 : 0, // 段内后半走变体，避免整段一模一样
        barEnergy(b),
        notes,
        barDur,
        firstBeat + b * barDur,
        segStart,
        segDur
      );
    }

    if (sg.tier > 0 && !laneMap && notes.length > startIdx) {
      const map = [];
      for (let i = startIdx; i < notes.length; i++) {
        const barIdx = (notes[i].t - segStart) / barDur;
        map.push({
          bar: barIdx,
          rel: barIdx - Math.floor(barIdx), // 小节内 0..1
          lane: notes[i].lane,
        });
      }
      tierLaneMaps.set(sg.tier, map);
    }
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
    // 结构信息（诊断用）：乐句数、其中多少句复用了别的乐句的主题
    structure: { segments: struct.segs.map((x) => ({ tier: x.tier, start: x.start, len: x.len })) },
    ...options,
  };
}

export function generateAll(analysis) {
  return DIFFICULTIES.map((d) => generateChart(analysis, d));
}
