import { mulberry32 } from './fft.js';

/**
 * 谱面生成器
 * ------------------------------------------------------------------
 * 输入音频分析结果 → 输出三档难度（EASY / NORMAL / HARD）的 4K 谱面。
 *
 * 关键点：**所有音符都吸附到拍网格上**。
 *   人的耳朵判「准不准」看的是音符与拍点的关系，而不是与某个瞬态的关系。
 *   原始 onset 相对拍点有 ±20ms 的抖动，直接拿来排谱会让人觉得「松 / 慢半拍」，
 *   所以先按 1/4（EASY/NORMAL）或 1/8（HARD）拍吸附，再做选音与编排。
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
  },
];

const MOTIFS = {
  1: [[1], [2], [0], [3]],
  2: [
    [0, 3],
    [1, 2],
    [0, 2],
    [3, 1],
    [2, 3],
    [1, 0],
  ],
  3: [
    [0, 1, 2],
    [3, 2, 1],
    [0, 2, 3],
    [1, 0, 3],
    [2, 1, 0],
    [1, 2, 3],
  ],
  4: [
    [0, 1, 2, 3],
    [3, 2, 1, 0],
    [0, 3, 1, 2],
    [1, 0, 2, 3],
    [0, 2, 1, 3],
    [2, 1, 3, 0],
  ],
  5: [
    [0, 1, 2, 3, 2],
    [1, 0, 2, 3, 1],
    [0, 1, 0, 2, 3],
    [3, 2, 3, 1, 0],
    [2, 1, 0, 2, 3],
  ],
  6: [
    [0, 1, 0, 2, 1, 3],
    [0, 1, 2, 1, 0, 2],
    [1, 0, 1, 2, 3, 2],
    [3, 2, 3, 1, 0, 1],
    [0, 1, 2, 3, 2, 1],
  ],
  7: [
    [0, 1, 0, 1, 2, 3, 2],
    [0, 1, 2, 3, 0, 1, 2],
    [1, 0, 1, 0, 2, 3, 2],
    [3, 2, 3, 2, 1, 0, 1],
  ],
  8: [
    [0, 1, 2, 3, 3, 2, 1, 0],
    [0, 1, 0, 1, 2, 3, 2, 3],
    [0, 1, 2, 1, 0, 1, 2, 3],
    [3, 2, 1, 2, 3, 2, 1, 0],
  ],
};

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickMotif(count, rng, prevLast) {
  const table = MOTIFS[Math.min(8, Math.max(1, count))] || MOTIFS[8];
  let best = table[Math.floor(rng() * table.length)];
  for (let tries = 0; tries < 4; tries++) {
    const cand = table[Math.floor(rng() * table.length)];
    if (cand[0] !== prevLast) {
      best = cand;
      break;
    }
  }
  if (count <= 8) return best.slice();
  const out = [];
  const zig = [0, 1, 2, 3, 3, 2, 1, 0];
  for (let i = 0; i < count; i++) out.push(zig[i % 8]);
  return out;
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
  // 相邻小节平滑，避免逐小节抖动
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

  // ---- 1. 事件吸附到拍网格（同一格只留最强的一个）----
  const bySlot = new Map();
  for (const e of clusterOnsets(analysis.onsets)) {
    if (e.t <= 0.8 || e.t >= duration - 0.85) continue;
    const slot = slotOf(e.t);
    const t = timeOf(slot);
    if (Math.abs(t - e.t) > step * 0.55) continue;
    // 位置（以 1/8 槽为单位，一小节 32 槽）
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

  // EASY：明显不在拍/半拍上的弱音不要
  if (cfg.id === 'easy') {
    events = events.filter((e) => {
      const p = e.pos % 8;
      const off = Math.min(p, 8 - p, Math.abs(p - 4));
      return off <= 1 || e.s > 0.5;
    });
  }

  // ---- 2. 局部强度 → 每小节目标密度（高潮更密、主歌留白）----
  const curve = barIntensity(analysis, firstBeat, beatDur);
  const barOf = (t) => Math.floor((t - firstBeat) / barDur);
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

  const chosen = [];
  const barTarget = new Map();
  for (const b of [...barCand.keys()].sort((x, y) => x - y)) {
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
      for (let i = 0; i < chosen.length; i++) {
        if (Math.abs(chosen[i].t - ev.t) < cfg.minGap) {
          ok = false;
          break;
        }
      }
      if (ok) {
        chosen.push(ev);
        taken++;
      }
    }
  }
  chosen.sort((a, b) => a.t - b.t);

  // ---- 3. 按小节分配键位 ----
  const notes = [];
  let prevLast = -1;
  const bars = new Map();
  for (const e of chosen) {
    const b = barOf(e.t);
    if (!bars.has(b)) bars.set(b, []);
    bars.get(b).push(e);
  }
  const barKeys = [...bars.keys()].sort((a, b) => a - b);

  for (const bar of barKeys) {
    const list = bars.get(bar).sort((a, b) => a.t - b.t);
    const eBar = barEnergy(bar);
    let lanes = pickMotif(list.length, rng, prevLast);

    for (let i = 0; i < list.length; i++) {
      notes.push({ t: list[i].t, lane: lanes[i], type: 'tap', s: list[i].s, tone: list[i].tone });
    }

    // 高潮段：随机补双押，密度和"炸"的感觉都上来了
    if (cfg.allowChord && eBar > 0.62) {
      const p = Math.min(0.55, (eBar - 0.62) * 2.1 * (cfg.chordChance + 0.2));
      for (let i = 0; i < list.length; i++) {
        if (rng() > p) continue;
        const l = lanes[i];
        const partner = l === 0 ? 3 : l === 3 ? 0 : l === 1 ? 2 : 1;
        if (notes.some((x) => Math.abs(x.t - list[i].t) < 0.02 && x.lane === partner)) continue;
        notes.push({ t: list[i].t, lane: partner, type: 'tap', s: list[i].s, tone: list[i].tone });
      }
    }

    prevLast = lanes[lanes.length - 1];
  }

  // ---- 4. 密度补全：把每小节填到该响度对应的目标密度 ----
  if (cfg.allowFill) {
    const fstep = beatDur / cfg.fillDiv;
    const added = [];
    for (const bar of barKeys) {
      const t0 = firstBeat + bar * barDur;
      const eBar = barEnergy(bar);
      const target = barTarget.get(bar) || 4;
      let have = notes.filter((n) => n.t >= t0 - 0.01 && n.t < t0 + barDur - 0.01).length;
      if (have >= target) continue;
      if (eBar < 0.34) continue;

      // 空槽优先补：按该位置的击打强度排序
      const slots = [];
      for (let k = 0; k < 4 * cfg.fillDiv; k++) {
        const t = t0 + k * fstep;
        if (t >= t0 + barDur - 0.02) break;
        if (notes.some((n) => Math.abs(n.t - t) < fstep * 0.45)) continue;
        if (added.some((n) => Math.abs(n.t - t) < fstep * 0.45)) continue;
        slots.push({ t, s: strengthAt(t) });
      }
      slots.sort((p, q) => q.s - p.s);
      const minS = eBar > 0.7 ? 0.08 : 0.17;
      for (const sl of slots) {
        if (have >= target) break;
        if (sl.s < minS) break;
        if (rng() < 0.12) continue;
        added.push({ t: sl.t, lane: -1, type: 'tap', s: sl.s, tone: 'hat' });
        have++;
      }
    }
    for (const f of added) {
      const prev = [...notes].filter((n) => n.t < f.t).pop();
      const l = prev ? (prev.lane + (rng() < 0.5 ? 1 : 3)) % 4 : 1;
      if (notes.some((n) => Math.abs(n.t - f.t) < 0.02 && n.lane === l)) continue;
      notes.push({ ...f, lane: l });
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

  // ---- 6. 长条 ----
  const withHolds = [];
  for (let i = 0; i < limited.length; i++) {
    const n = limited[i];
    const next = limited[i + 1];
    if (
      n.type === 'tap' &&
      rng() < cfg.holdChance &&
      next &&
      next.t - n.t > beatDur * 0.9 &&
      analysis.energyAt(n.t + beatDur * 0.6) > 0.5
    ) {
      const dur = Math.min(beatDur * 2, next.t - n.t - beatDur * 0.3);
      if (dur > beatDur * 0.5) {
        withHolds.push({ ...n, type: 'hold', dur });
        continue;
      }
    }
    withHolds.push(n);
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
    if (pos % 8 !== 0 && pos % 8 !== 4) continue; // 只放整拍 / 半拍
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
