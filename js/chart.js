import { mulberry32 } from './fft.js';
import { PRIORS, CHORD_SLOT_WEIGHT } from './chart-priors.js';

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
    // 音高完全相同的重复音 → 允许真 jack 的概率。低难度尽量不出现。
    pitchJackChance: 0.1,
  },
  {
    id: 'normal',
    name: 'NORMAL',
    tag: '标准',
    color: '#fbbf24',
    gridDiv: 4,
    fillDiv: 2,
    minGap: 0.135,
    npsQuiet: 1.9,
    npsLoud: 4.6,
    maxPerBar: 11,
    allowChord: true,
    // 目标双押率（按位置权重缩放后约等于"音群中双押以上的比例"）
    chordBase: 0.17,
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
    pitchJackChance: 0.45,
  },
  {
    id: 'hard',
    name: 'HARD',
    tag: '狂暴',
    color: '#f472b6',
    gridDiv: 4,
    fillDiv: 4,
    minGap: 0.082,
    npsQuiet: 3.2,
    npsLoud: 7.0,
    maxPerBar: 20,
    allowChord: true,
    chordBase: 0.33,
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
    pitchJackChance: 0.9,
  },
];

const LANE_KEYS = [0, 1, 2, 3];

/**
 * 音高可信度门槛：低于这个值的 onset 当作"没有明确音高"（鼓、噪声、齿音），
 * 交给常规加权选择，不参与旋律走向。0.6 是实测的分界点 ——
 * 再低会把军鼓的余响当成旋律，再高则漏掉太多人声。
 */
const PITCH_USE_CLARITY = 0.6;

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

/** 把距离很近的击打点并成一个音符事件（音高取其中可信度最高的那个） */
function clusterOnsets(onsets, maxGap = 0.048) {
  const out = [];
  for (const o of onsets) {
    const last = out[out.length - 1];
    if (last && o.t - last.t <= maxGap) {
      const w = last.s + o.s;
      last.t = (last.t * last.s + o.t * o.s) / (w || 1);
      last.s = Math.max(last.s, o.s);
      if (o.s > last.s * 0.9) last.tone = o.tone;
      // 音高单独判：以"可信度"为准，而不是响度 ——
      // 一个安静的钢琴音比一记响亮的军鼓更值得当旋律
      if ((o.clarity || 0) > (last.clarity || 0)) {
        last.semi = o.semi;
        last.clarity = o.clarity;
        last.hz = o.hz;
        last.stable = o.stable;
      }
    } else {
      out.push({
        t: o.t,
        s: o.s,
        tone: o.tone,
        bands: o.bands,
        semi: o.semi,
        clarity: o.clarity,
        hz: o.hz,
        stable: o.stable,
      });
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
  constructor(rng, cfg, step, beatDur, pitchRel = () => 0) {
    this.rng = rng;
    this.cfg = cfg;
    this.step = step;
    this.beatDur = beatDur;
    this.pitchRel = pitchRel;
    this.lastLane = -1;
    this.prevLane = -1;
    this.recent = [];
    this.left = 0;
    this.right = 0;
    this.laneUse = [0, 0, 0, 0];
    this.lastChord = '';
    this.famIdx = -1;
    // 旋律状态
    this.lastSemi = NaN;
    this.pitchLanePrev = -1;
    this.pitchRun = 0;
    // 诊断计数（pitchOffered=有音高可建议，pitchUsed=真的被采纳）
    this.pitchOffered = 0;
    this.pitchUsed = 0;
    this.pitchRejected = 0;
    this.srcMap = 0;
    this.srcSeq = 0;
    this.srcPick = 0;
    this.srcJackGuard = 0;
  }

  /** 单个键的权重：把所有"手感规则"乘在一起 */
  weigh(lane, isStrong, rel = 0) {
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

    // 6) 音高：高的往外侧（0 / 3），低的往内侧（1 / 2）。
    //    这是"谱面是音乐的可视化"最直接的一条 —— 旋律上行时键位往外扩。
    if (Math.abs(rel) > 0.4) {
      const outer = lane === 0 || lane === 3;
      if (rel > 0) s *= outer ? 1.55 : 0.66;
      else s *= outer ? 0.66 : 1.55;
    }

    return Math.max(0.001, s);
  }

  pick(isStrong, rel = 0) {
    const w = LANE_KEYS.map((l) => this.weigh(l, isStrong, rel));
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
  makeRoll(n, theme, vary, dirOverride = 0) {
    // 方向优先级：音高趋势 > 乐句主题。旋律整体上行时，连打就该往上走 ——
    // 这既保留了 roll 的语汇感，又不至于把一条上行的旋律打成锯齿。
    const dir = dirOverride || (vary ? -theme.dir : theme.dir);
    // 起点同样跟着方向：上行从左起、下行从右起，避免一上来就顶到边界
    let start = theme.start;
    if (dirOverride > 0 && start > 1) start = 0;
    if (dirOverride < 0 && start < 2) start = 3;
    const out = [];
    for (let i = 0; i < n; i++) {
      // 注意 JS 的 % 对负数返回负数，必须再 +4 归一化
      const l = (((start + dir * i) % 4) + 4) % 4;
      out.push(l);
    }
    return out;
  }

  /** 一段连打的音高趋势：上行 +1 / 下行 -1 / 平 0（按前后三分之一的均值差判断） */
  pitchTrend(items) {
    const pts = [];
    for (const it of items) {
      if (it.stable && isFinite(it.semi) && (it.clarity || 0) >= PITCH_USE_CLARITY) pts.push(it.semi);
    }
    if (pts.length < 4) return 0;
    const k = Math.max(1, Math.floor(pts.length / 3));
    const head = pts.slice(0, k);
    const tail = pts.slice(-k);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const d = avg(tail) - avg(head);
    if (d > 1.5) return 1;
    if (d < -1.5) return -1;
    return 0;
  }

  makeTrill(n, theme, vary) {
    let [a, b] = theme.pair;
    if (vary) [a, b] = [b, a]; // 后半句反过来，形成"呼应"而不是复制
    const out = [];
    for (let i = 0; i < n; i++) out.push(i % 2 === 0 ? a : b);
    return out;
  }

  /**
   * 旋律走向 → 键位走向。返回建议键位（不保证被采用）。
   *
   * 三条依据：
   *  - 音高上升 → 键位右移；下降 → 左移（幅度按音程大小给 1~2 格）
   *  - 音高几乎不变（<0.45 半音）→ 允许**真 jack**。这是唯一合理的 jack 来源：
   *    音乐上确实是同一个音重复，两个音就该落在同一个键上。但最多连两个。
   *  - 撞到边界就反弹，避免整段堆在最右 / 最左
   *
   * 每次调用都会更新内部状态（即使建议没被采用），否则下一次的"音高差"会算错。
   */
  pitchLane(semi, real = true) {
    this.repeatOK = false;
    if (!isFinite(semi)) return -1;
    const prev = this.lastSemi;
    this.lastSemi = semi;

    if (!isFinite(prev)) {
      this.pitchRun = 0;
      const p = this.placeByHeight(semi);
      if (p >= 0) this.pitchLanePrev = p;
      return p;
    }

    const d = semi - prev;
    if (Math.abs(d) < 0.45) {
      // 同一个音：可以真 jack，但必须是**实测**的重复音（插值出来的不算），
      // 而且只连两个。否则整段同音高的补音会连成一片 jack。
      if (!real || this.pitchRun >= 1) return -1;
      // 真重复也不一定非要写成 jack：按难度给概率，EASY 基本避开，
      // HARD 大方保留（这是唯一"讲道理"的 jack 来源）
      if (this.rng() > (this.cfg.pitchJackChance ?? 0.5)) return -1;
      this.pitchRun++;
      this.repeatOK = true; // 只有这条路径允许"下一个音仍落在同一键"
      return this.pitchLanePrev;
    }

    this.pitchRun = 0;
    const base = this.pitchLanePrev >= 0 ? this.pitchLanePrev : this.lastLane;
    if (base < 0) return -1;
    const dir = d > 0 ? 1 : -1;
    const mag = Math.abs(d) > 4.5 ? 2 : 1; // 大音程走两格
    // 越过边界时**环绕**而不是反弹：4K 里 3→0 本来就被读作"继续上行"
    // （roll 就是这么走的）。反弹会把方向反过来，旋律一上行键位反而左移。
    const t = (((base + dir * mag) % 4) + 4) % 4;
    this.pitchLanePrev = t;
    return t;
  }

  /** 绝对音高：高的落到外侧（0 / 3），低的落在内侧（1 / 2） */
  placeByHeight(semi) {
    const rel = this.pitchRel(semi);
    if (rel > 0.4) return this.rng() < 0.5 ? 0 : 3;
    if (rel < -0.4) return this.rng() < 0.5 ? 1 : 2;
    return -1;
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

    const vary = barInPhrase >= 2;
    let seq = null;
    // 这一小节有多少音带可信音高？够多就让旋律自己决定走向 ——
    // 音高步进本身就是 ±1 的 roll 形态，既好听也符合连打的手感。
    let pitchNotes = 0;
    for (const it of items) if (it.stable && isFinite(it.semi)) pitchNotes++;
    const pitchy = pitchNotes / items.length >= 0.6;

    if (dense && cfg.id !== 'easy' && theme && theme.kind !== 'free' && !pitchy) {
      // 旋律趋势优先于主题方向：上行的连打往上走，下行的往下走
      const trend = this.pitchTrend(items);
      // trill 只覆盖两根键，连续用会让整段堆在中间两根键上。
      // 所以让它隔小节出现，其余小节用 roll 把四根键都走到。
      const useTrill = theme.kind === 'trill' ? barInPhrase % 2 === 1 : barInPhrase % 4 === 3;
      seq = useTrill
        ? this.makeTrill(items.length, theme, vary)
        : this.makeRoll(items.length, theme, vary, trend);
    }

    const placed = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const rel = (it.t - barStart) / this.beatDur; // 0..4
      // 整拍 / 半拍都算重音位（反拍重音很常见）
      const isStrong = Math.abs(rel * 2 - Math.round(rel * 2)) < 0.12;

      // 旋律：先算"按音高走向该去哪个键"，再决定采不采用
      const hasPitch = !!it.stable && isFinite(it.semi) && (it.clarity || 0) >= PITCH_USE_CLARITY;
      const prel = hasPitch ? this.pitchRel(it.semi) : 0;
      const suggestion = hasPitch ? this.pitchLane(it.semi, !it.interp) : -1;
      if (suggestion >= 0) this.pitchOffered++;
      const pitchJack = hasPitch && suggestion >= 0 && this.repeatOK;

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

        // 位置对上了，还要看音高对不对得上。
        // 段落复用表是"按位置照抄"，如果这一段音乐其实是新的（音高走向不同），
        // 照抄出来的键位就与旋律无关了。所以音高差太多就不抄，交给旋律走向。
        if (lane >= 0) {
          let srcRel = null;
          let bestD2 = Infinity;
          for (const m of this.laneMap) {
            const d = Math.abs(m.bar - barRel) * 0.8 + Math.abs(m.rel - relInBar) * 1.6;
            if (d < bestD2) {
              bestD2 = d;
              srcRel = m.prel;
            }
          }
          if (hasPitch && srcRel != null && isFinite(srcRel)) {
            if (Math.abs(prel - srcRel) > 0.3) lane = -1;
          }
        }

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
      if (lane < 0 && suggestion >= 0) {
        // 旋律建议也要过手平衡：别让一段旋律把一只手压死
        const total = this.left + this.right;
        const ratio = total >= 10 ? (suggestion < 2 ? this.left : this.right) / total : 0.5;
        if (ratio < 0.7) lane = suggestion;
        else this.pitchRejected++;
      }
      if (lane < 0) { lane = this.pick(isStrong, prel); this.srcPick++; }
      else if (lane === suggestion) this.srcPitch = (this.srcPitch || 0) + 1;
      else if (seq && lane === seq[i]) this.srcSeq++;
      else this.srcMap++;
      // 语汇内部也要过一遍手感：万一撞上 jack 就改选。
      // 唯一的例外是"音高完全相同"——那是音乐上真正的重复音，jack 是对的。
      if (lane === this.lastLane && !pitchJack) { lane = this.pick(isStrong, prel); this.srcJackGuard++; }
      if (!(lane >= 0 && lane < 4)) lane = this.pick(isStrong, prel); // 兜底，绝不让非法轨道漏出去

      if (suggestion >= 0 && lane === suggestion) this.pitchUsed++;
      placed.push({ t: it.t, lane, s: it.s, tone: it.tone, strong: isStrong, semi: it.semi });
      this.commit(lane);
    }

    // 双押：位置由**真实谱面统计**决定。
    // 蒸馏结果：双押以上占 40%；其中 49% 落在正拍、28% 半拍、10% 在 3/4 拍。
    // 也就是说重音该压在正拍和半拍上 —— 按这个权重撒，才会有"顿"的感觉；
    // 均匀撒满或者只在强拍撒一点，都会显得平。
    if (cfg.allowChord && eBar > 0.32) {
      const base = cfg.chordBase * (0.35 + 1.15 * eBar);
      const cm = this.chordMask;
      for (const n of placed) {
        const relBeat = (n.t - barStart) / this.beatDur; // 0..4
        const slot = ((Math.round((relBeat % 1) * 16) % 16) + 16) % 16;
        // 动机槽位上的音按权重加成；不在动机上的只有很小的机会，
        // 这样"重音位置"每小节都是一样的，玩家能跟着点头。
        // 动机槽位上的双押接近"确定"（0.9），其余位置几乎不出（0.06）：
        // 这样重音图案在短语内是重复的，玩家能跟着点头；随机撒就没有重音感。
        // 没有动机的小节（只靠补音撑起来的）不能当成"全是重音位"，
        // 否则会把整小节塞满双押。兜底只认 0 / 8 两个正拍。
        const onMotif = cm ? !!cm[slot] : slot % 8 === 0;
        const p = onMotif ? 0.92 : 0.02;
        if (rng() > p) continue;
        const partner = this.partnerOf(n.lane);
        if (placed.some((m) => Math.abs(m.t - n.t) < 0.02 && m.lane === partner)) continue;
        this.lastChord = chordKey(n.lane, partner);
        out.push({ t: n.t, lane: n.lane, type: 'tap', s: n.s, tone: n.tone, semi: n.semi });
        out.push({ t: n.t, lane: partner, type: 'tap', s: n.s, tone: n.tone, semi: n.semi });
        n.emitted = true;
      }
    }

    for (const n of placed) {
      if (!n.emitted) out.push({ t: n.t, lane: n.lane, type: 'tap', s: n.s, tone: n.tone, semi: n.semi });
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
    const cand = {
      t,
      slot,
      s: e.s,
      tone: e.tone,
      bands: e.bands,
      pos,
      score: e.s + bonus,
      semi: e.semi,
      clarity: e.clarity,
      stable: e.stable,
    };
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
  // 注意这里只算目标，**先不选音** —— 选音要等动机（barMask）生成之后，
  // 否则动机只能影响补音，主音符仍是一盘散沙。
  const PHRASE_SHAPE = [0.9, 0.96, 1.02, 1.1];
  for (const b of barKeys) {
    const e = barEnergy(b);
    let target = Math.round((cfg.npsQuiet + (cfg.npsLoud - cfg.npsQuiet) * e) * barDur);
    target = Math.round(target * PHRASE_SHAPE[((b % 4) + 4) % 4]);
    if (e < 0.16) target = Math.min(target, 2); // 极安静就留白
    target = Math.max(1, Math.min(cfg.maxPerBar, target));
    barTarget.set(b, target);
  }

  // ---- 3.4 节奏动机 ----
  // 蒸馏结果：真实谱面里 39% 的相邻小节节奏型**完全一致**。
  // 而"每小节按能量重新填满"会让每个小节的节奏型都不一样，听起来像机器在数拍。
  //
  // 做法：四小节一个短语，抽一条 16 分槽位的节奏型（按真实位置频率加权），
  // 短语内复用它，最后一小节翻转两个槽位做变化。这样既有记忆点又不呆板。
  const barMask = new Map();
  // 双押也要有动机：真实谱面里重音是"每小节同一位置都加重"，
  // 而不是每小节随机挑几个音加倍 —— 后者听起来就是噪音。
  const barChordMask = new Map();
  {
    const P = 4;
    const barLo = Math.min(...barKeys);
    const barHi = Math.max(...barKeys);
    for (let s0 = barLo; s0 <= barHi; s0 += P) {
      const group = [];
      for (let k = 0; k < P; k++) if (barTarget.has(s0 + k)) group.push(s0 + k);
      if (!group.length) continue;

      // 关键：节奏型不是随机抽的，而是**从音频里取短语共识** ——
      // 把 4 个小节对应槽位的击打强度平均，最强的那几格就是这个短语的节奏骨架。
      // 这样动机既贴合音乐，又天然在短语内重复（音乐本身就是重复的）。
      const slotStrength = new Float32Array(16);
      for (let i = 0; i < 16; i++) {
        let sum = 0;
        for (const b of group) sum += strengthAt(firstBeat + b * barDur + (i / 16) * barDur);
        slotStrength[i] = sum / group.length;
      }
      const order = [...Array(16).keys()].sort(
        (x, y) =>
          slotStrength[y] * (0.7 + PRIORS.phase[y]) - slotStrength[x] * (0.7 + PRIORS.phase[x])
      );

      const peak = Math.max(...group.map((b) => barTarget.get(b) || 0));
      // 目标数的是"音符"，双押会被算两次；这里换算成"音群数"再定槽位数，
      // 否则一条 16 格的节奏骨架上会被塞进远超骨架的音符，动机就没了。
      const groups = Math.round(peak / (1 + 0.5 * (cfg.allowChord ? cfg.chordBase : 0)));
      const K = Math.max(3, Math.min(16, groups));
      const mask = new Uint8Array(16);
      for (let c = 0; c < K; c++) mask[order[c]] = 1;

      // 双押槽位：**必须从音符骨架里挑**，否则会出现"有音就双押"。
      // 取骨架的 1/3 左右作为重音位，优先正拍/半拍（真实重音的 77% 在这两处）。
      const maskSlots = [];
      for (let i = 0; i < 16; i++) if (mask[i]) maskSlots.push(i);
      const chordOrder = maskSlots.slice().sort(
        (x, y) =>
          slotStrength[y] * CHORD_SLOT_WEIGHT[y] - slotStrength[x] * CHORD_SLOT_WEIGHT[x]
      );
      const k2 = Math.max(1, Math.min(4, Math.round(maskSlots.length * 0.18)));
      const chordMask = new Uint8Array(16);
      for (let c = 0; c < k2 && c < chordOrder.length; c++) chordMask[chordOrder[c]] = 1;

      group.forEach((b, k) => {
        if (k === group.length - 1 && group.length > 2) {
          // 末小节：翻转两个槽位，做"变奏收尾"
          const m2 = Uint8Array.from(mask);
          for (let f = 0; f < 2; f++) {
            const i = Math.floor(rng() * 16);
            m2[i] = m2[i] ? 0 : 1;
          }
          barMask.set(b, m2);
          barChordMask.set(b, chordMask);
        } else {
          barMask.set(b, mask);
          barChordMask.set(b, chordMask);
        }
      });
    }
  }

  // ---- 3.5 选音：按"强度 + 动机槽位"排序，而不是只看强度 ----
  // 真实谱面是先有节奏型再挑声音；只看强度的话，音符会均匀铺满每一格。
  for (const b of barKeys) {
    const target = barTarget.get(b) || 1;
    const t0 = firstBeat + b * barDur;
    const mask = barMask.get(b);
    const list = barCand
      .get(b)
      .map((ev) => {
        const slot = Math.min(15, Math.max(0, Math.round(((ev.t - t0) / barDur) * 16) % 16));
        return { ev, slot, onMask: !!(mask && mask[slot]), score: ev.score };
      })
      .sort((p, q) => q.score - p.score);
    let maskCount = 0;
    if (mask) for (let i = 0; i < 16; i++) maskCount += mask[i];
    let taken = 0;
    const take = (cand) => {
      const ev = cand.ev;
      for (let i = picked.length - 1; i >= 0 && picked.length - i <= 6; i--) {
        if (Math.abs(picked[i].t - ev.t) < cfg.minGap) return false;
      }
      picked.push(ev);
      taken++;
      return true;
    };
    // 骨架就是节奏：把骨架上的音**全部**收下（不再按 target 截断），
    // 这样每一小节的节奏型一致，玩家才能跟着点头。
    // target 只用来决定骨架有几格，不再直接决定音符数。
    for (const cand of list) {
      if (!cand.onMask) continue;
      take(cand);
    }
    // 骨架在这几格完全没声音（很少见）时兜底，防止整小节空白
    if (taken === 0) {
      for (const cand of list) {
        if (taken >= Math.min(target, 4)) break;
        take(cand);
      }
    }
  }
  picked.sort((a, b) => a.t - b.t);

  // ---- 3. 补音：把每小节填到目标密度（先定时间轴，再排键位）----
  const timeline = picked.map((e) => ({
    t: e.t,
    s: e.s,
    tone: e.tone,
    pos: e.pos,
    semi: e.semi,
    clarity: e.clarity,
    stable: e.stable,
  }));
  const hasAt = (arr, t, tol) => arr.some((n) => Math.abs(n.t - t) < tol);
  if (cfg.allowFill) {
    const added = [];
    for (const bar of barKeys) {
      const t0 = firstBeat + bar * barDur;
      const mask = barMask.get(bar);
      if (!mask) continue;
      const slots = [];
      for (let i = 0; i < 16; i++) {
        if (!mask[i]) continue;
        const t = t0 + (i / 16) * barDur;
        if (t >= t0 + barDur - 0.02) break;
        const tol = (barDur / 16) * 0.35;
        if (hasAt(timeline, t, tol) || hasAt(added, t, tol)) continue;
        // 骨架上的格子只要"有一点声音"就补上 —— 谱师写谱也是这么做的：
        // 踩镲很轻也要写，因为节奏骨架比响度更重要。
        const s = strengthAt(t);
        if (s < 0.035) continue;
        slots.push({ t, s });
      }
      // 骨架就是密度的上限：不再额外往骨架外撒音
      slots.sort((p, q) => q.s - p.s);
      for (const sl of slots) added.push({ t: sl.t, s: sl.s, tone: 'hat', pos: null });
    }
    timeline.push(...added);
    timeline.sort((a, b) => a.t - b.t);
  }

  // ---- 3.5 补音的音高：按前后可信音高插值（当作经过音）----
  // 不这么做，连打里"有音高的音"和"补出来的音"会交替出现，
  // 旋律线就被切成一段一段，HARD 这类补音很多的难度尤其明显。
  {
    const anchors = timeline.filter((n) => n.stable && isFinite(n.semi)).sort((a, b) => a.t - b.t);
    if (anchors.length > 4) {
      let ai = 0;
      for (const n of timeline) {
        if (n.stable && isFinite(n.semi)) continue;
        while (ai + 1 < anchors.length && anchors[ai + 1].t < n.t) ai++;
        const prev = anchors[ai];
        const next = anchors[ai + 1];
        const before = prev && prev.t <= n.t + 1e-6;
        const after = next && next.t >= n.t - 1e-6;
        if (before && after && next.t - prev.t < beatDur * 2.6 && next.t > prev.t) {
          const k = (n.t - prev.t) / (next.t - prev.t);
          n.semi = prev.semi + (next.semi - prev.semi) * k;
          n.stable = true;
          n.interp = true;
          n.clarity = 0.7; // 插值音高同样可信，否则会被 clarity 门槛挡掉
        } else if (before && n.t - prev.t < beatDur * 0.9) {
          n.semi = prev.semi;
          n.stable = true;
          n.interp = true;
          n.clarity = 0.7;
        } else if (after && next.t - n.t < beatDur * 0.9) {
          n.semi = next.semi;
          n.stable = true;
          n.interp = true;
          n.clarity = 0.7;
        }
      }
    }
  }

  // ---- 4. 键位编排：按乐句主题套语汇 ----
  const planner = new LanePlanner(rng, cfg, step, beatDur, analysis.pitchRel || (() => 0));
  const notes = [];
  const byBar = new Map();
  for (const n of timeline) {
    const b = barOf(n.t);
    if (!byBar.has(b)) byBar.set(b, []);
    byBar.get(b).push(n);
  }
  const allBars = [...byBar.keys()].sort((x, y) => x - y);
  const barSet = new Set(allBars);

  // ---- 3.9 段落重复检测：用音级指纹，而不是"能量档位" ----
  // 之前只按能量分档，结果把"能量相近但音乐完全不同"的两段当成一段照抄，
  // 实测同档位段落的音高差有 5~9 个半音 —— 抄了也是错的。
  // 现在比的是每小节的音级分布（chroma）：真正的副歌重复会高度吻合。
  const segRepeat = new Map();
  {
    const chromaOf = new Map();
    for (const bar of allBars) {
      const v = new Float32Array(12);
      let cnt = 0;
      for (const n of byBar.get(bar)) {
        if (!isFinite(n.semi)) continue;
        const pc = ((Math.round(n.semi) % 12) + 12) % 12;
        v[pc] += 1;
        cnt++;
      }
      if (cnt >= 2) {
        for (let i = 0; i < 12; i++) v[i] /= cnt;
        chromaOf.set(bar, v);
      }
    }
    const cos = (a, b) => {
      let d = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < 12; i++) {
        d += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return !na || !nb ? 0 : d / Math.sqrt(na * nb);
    };
    for (let i = 1; i < struct.segs.length; i++) {
      const A = struct.segs[i];
      let best = -1;
      let bestS = -1;
      for (let j = 0; j < i; j++) {
        const B = struct.segs[j];
        if (B.tier !== A.tier) continue;
        const len = Math.min(A.len, B.len);
        if (len < 4) continue;
        let sum = 0;
        let cnt = 0;
        for (let k = 0; k < len; k++) {
          const ca = chromaOf.get(A.start + k);
          const cb = chromaOf.get(B.start + k);
          if (!ca || !cb) continue;
          sum += cos(ca, cb);
          cnt++;
        }
        if (cnt >= len * 0.6 && sum / cnt > bestS) {
          bestS = sum / cnt;
          best = j;
        }
      }
      // 阈值 0.93：宁可漏判（各写各的），也不能把不相关的段落凑一对
      if (best >= 0 && bestS > 0.93) segRepeat.set(i, best);
    }
  }

  // 每个"首次出现"的段落留一份键位表，真正的重复段落照抄它。
  // 音级指纹没命中时退回"同档位复用"（老逻辑），但照抄时仍然要过音高闸门，
  // 所以"能量相近但音乐不同"的段落不会被硬抄。
  const segLaneMaps = new Map();
  const tierLaneMaps = new Map();

  for (let si = 0; si < struct.segs.length; si++) {
    const sg = struct.segs[si];
    const srcIdx = segRepeat.has(si) ? segRepeat.get(si) : -1;
    const laneMap =
      srcIdx >= 0
        ? segLaneMaps.get(srcIdx) || null
        : sg.tier > 0
          ? tierLaneMaps.get(sg.tier) || null
          : null;
    const segStart = firstBeat + sg.start * barDur;
    const segDur = sg.len * barDur;
    const startIdx = notes.length;
    planner.setTheme(sg.theme, laneMap);

    for (let k = 0; k < sg.len; k++) {
      const b = sg.start + k;
      if (!barSet.has(b)) continue;
      planner.chordMask = barChordMask.get(b) || null;
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

    if (sg.tier > 0 && !laneMap && notes.length > startIdx && !tierLaneMaps.has(sg.tier)) {
      const map = [];
      for (let i = startIdx; i < notes.length; i++) {
        const barIdx = (notes[i].t - segStart) / barDur;
        map.push({
          bar: barIdx,
          rel: barIdx - Math.floor(barIdx),
          lane: notes[i].lane,
          prel: isFinite(notes[i].semi) ? analysis.pitchRel(notes[i].semi) : null,
        });
      }
      tierLaneMaps.set(sg.tier, map);
    }

    if (!laneMap && notes.length > startIdx) {
      const map = [];
      for (let i = startIdx; i < notes.length; i++) {
        const barIdx = (notes[i].t - segStart) / barDur;
        map.push({
          bar: barIdx,
          rel: barIdx - Math.floor(barIdx), // 小节内 0..1
          lane: notes[i].lane,
          // 记下当时的相对音高，供后续段落判断"是不是同一段音乐"
          prel: isFinite(notes[i].semi) ? analysis.pitchRel(notes[i].semi) : null,
        });
      }
      segLaneMaps.set(si, map);
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
    structure: {
      segments: struct.segs.map((x) => ({ tier: x.tier, start: x.start, len: x.len })),
      repeats: [...segRepeat.entries()],
    },
    pitchStats: {
      offered: planner.pitchOffered,
      used: planner.pitchUsed,
      rejected: planner.pitchRejected,
      srcPitch: planner.srcPitch || 0,
      srcSeq: planner.srcSeq,
      srcMap: planner.srcMap,
      srcPick: planner.srcPick,
      srcJackGuard: planner.srcJackGuard,
    },
    ...options,
  };
}

export function generateAll(analysis) {
  return DIFFICULTIES.map((d) => generateChart(analysis, d));
}
