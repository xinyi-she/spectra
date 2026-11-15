/**
 * 谱面度量：用**同一把尺子**量真实谱面和自动生成的谱面
 * ------------------------------------------------------------------
 * 之所以单独抽出这个文件，是因为"我们和人类差多少"必须两边算同一个东西：
 *   - tools/distill_holds.mjs  读 osu!mania 的 .osu（Node）
 *   - tools/holdstats.html     读本站生成的谱面（浏览器）
 * 两边都 import 这里，统计口径才不会各算各的。
 *
 * 输入统一成：{ t, col, hold, dur }（秒 / 0..3 / 是否长条 / 长条时长）
 * 自动谱面的 { lane, type:'hold', dur } 由 normalizeNotes 转过来。
 */

export function normalizeNotes(notes) {
  return notes.map((n) => {
    const hold = n.hold !== undefined ? !!n.hold : n.type === 'hold';
    const dur = hold ? (n.dur !== undefined ? n.dur : (n.end || 0) - n.t) : 0;
    return { t: n.t, col: n.col !== undefined ? n.col : n.lane, hold, dur };
  });
}

/** 把音符按"同一时刻"并成组（和弦） */
function groupByTime(notes, tol = 0.001) {
  const sorted = notes.slice().sort((a, b) => a.t - b.t || a.col - b.col);
  const groups = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g.t - n.t) < tol) {
      g.cols.push(n.col);
      g.notes.push(n);
    } else {
      groups.push({ t: n.t, cols: [n.col], notes: [n] });
    }
  }
  return groups;
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
};

/**
 * 节奏 + 可玩性指标（不含长条，长条见 holdMetrics）。
 *
 * 每一项都对应"人和自动谱差异最大"的地方：
 *   ioi*        时值构成 —— 自动谱容易写成均匀的十六分音墙
 *   onBeat      正拍 / 半拍命中率 —— 重音感
 *   chord       双押以上占比 —— 太高压不住，太低没劲
 *   jack        同键连打 —— 自动谱最容易滥用的东西
 *   motif       相邻小节节奏型相同比例 —— 动机感
 *   barCV       每小节音符数的变异系数 —— 段落起伏（自动谱常全程一样密）
 *   handRun     同手连续击打的最长串（中位数）—— 4K 里超过 6 连就很累
 *   altRun      左右手交替率
 */
export function chartMetrics(notes, beat, offset = 0) {
  const ns = normalizeNotes(notes);
  const groups = groupByTime(ns);
  const ioi = new Map();
  let onBeat = 0;
  let chord = 0;
  let jack = 0;
  let jackBase = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const beats = (g.t - offset) / beat;
    const slot = Math.min(15, Math.max(0, Math.round((((beats % 1) + 1) % 1) * 16) % 16));
    if (slot % 4 === 0) onBeat++;
    if (g.cols.length > 1) chord++;
    if (i > 0) {
      const u = Math.round(((g.t - groups[i - 1].t) / beat) * 16);
      if (u > 0 && u <= 64) ioi.set(u, (ioi.get(u) || 0) + 1);
      if (g.cols.length === 1 && groups[i - 1].cols.length === 1) {
        jackBase++;
        if (g.cols[0] === groups[i - 1].cols[0] && u <= 4) jack++;
      }
    }
  }

  // 小节密度与起伏
  const barDur = beat * 4;
  const bars = new Map();
  for (const n of ns) {
    const b = Math.floor((n.t - offset) / barDur);
    bars.set(b, (bars.get(b) || 0) + 1);
  }
  const counts = [...bars.values()];
  const mean = counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length);
  const std = Math.sqrt(counts.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, counts.length));

  // 动机：相邻小节节奏型（0/1/2）是否一致
  const rhythmOf = (b) => {
    const arr = new Array(16).fill(0);
    for (const n of ns) {
      const bb = Math.floor((n.t - offset) / barDur);
      if (bb !== b) continue;
      const pos = Math.round(((n.t - offset) / barDur - bb) * 16) % 16;
      arr[pos] = Math.min(2, arr[pos] + 1);
    }
    return arr.join('');
  };
  const keyBars = [...bars.keys()].sort((a, b) => a - b);
  // 每小节正拍（slot 0）是否有音 —— 人写谱几乎每小节都会踩这个点
  let downbeat = 0;
  for (const b of keyBars) {
    const t0 = offset + b * barDur;
    if (ns.some((n) => Math.abs(n.t - t0) < barDur / 32)) downbeat++;
  }
  let same = 0;
  let tot = 0;
  let simSum = 0;
  for (let i = 1; i < keyBars.length; i++) {
    if (keyBars[i] !== keyBars[i - 1] + 1) continue;
    tot++;
    const A = rhythmOf(keyBars[i]);
    const B = rhythmOf(keyBars[i - 1]);
    if (A === B) same++;
    // 软一点的相似度：槽位集合的 Jaccard —— 完全相同的比例对自动谱太苛刻
    let inter = 0;
    let uni = 0;
    for (let k = 0; k < 16; k++) {
      const a = +A[k];
      const b = +B[k];
      if (a || b) uni++;
      if (a && b) inter++;
    }
    simSum += uni ? inter / uni : 1;
  }

  // 同手串长：单音组按手（0-1 左手 / 2-3 右手）
  const hands = groups.filter((g) => g.cols.length === 1).map((g) => (g.cols[0] < 2 ? 0 : 1));
  let run = 1;
  const runs = [];
  let switches = 0;
  for (let i = 1; i < hands.length; i++) {
    if (hands[i] === hands[i - 1]) run++;
    else {
      runs.push(run);
      switches++;
      run = 1;
    }
  }
  if (hands.length) runs.push(run);
  runs.sort((a, b) => a - b);

  const ioiTot = [...ioi.values()].reduce((a, b) => a + b, 0) || 1;
  const share = (u) => (ioi.get(u) || 0) / ioiTot;
  const g = groups.length || 1;
  return {
    notes: ns.length,
    groups: groups.length,
    nps: 0, // 由调用方按 span 补
    quarter: share(4),
    eighth: share(2),
    sixteenth: share(1),
    dotted: share(3),
    longer: 1 - share(4) - share(2) - share(1) - share(3),
    onBeat: onBeat / g,
    chord: chord / g,
    jack: jackBase ? jack / jackBase : 0,
    motif: tot ? same / tot : 0,
    motifSim: tot ? simSum / tot : 0,
    downbeat: keyBars.length ? downbeat / keyBars.length : 0,
    barCV: mean ? std / mean : 0,
    handRunP50: runs[Math.round((runs.length - 1) * 0.5)] || 0,
    handRunP90: runs[Math.round((runs.length - 1) * 0.9)] || 0,
    altRate: hands.length > 1 ? switches / (hands.length - 1) : 0,
  };
}

/**
 * 长条（LN）相关的全部指标。
 *
 * 每一项都对着一个"人写谱会注意、自动谱会忽略"的点：
 *   holdShare   长条占音符的比例 —— 自动谱最常见的错是**太多**
 *   lenP*       长条长度（拍）—— 太短（<1 拍）读起来像"卡了一下"
 *   chainShare  与前一个长条头相距 <2 拍的占比 —— "连续长条"，本作之前的毛病
 *   tailTight   长条尾巴紧接着同轨音符（<0.35 拍）—— 松手即按，最容易失手
 *   maxChain    最长的一条"连续长条"链（相邻头间距 <2 拍）
 *   tailOffGrid 尾巴不在 1/4 拍网格上的比例 —— 人类谱面尾巴一定是吸附过的
 *   perBar*     每小节长条数 —— 人类谱面长条是"点缀"，不是"节奏主体"
 *   maxBars     连续多少小节都有长条
 *   chordHold   同时按两个以上长条的占比
 */
export function holdMetrics(notes, beat, offset = 0) {
  const ns = normalizeNotes(notes);
  const holds = ns.filter((n) => n.hold);
  const total = ns.length || 1;

  const lens = holds.map((h) => h.dur / beat).filter((x) => x > 0);
  const heads = holds.slice().sort((a, b) => a.t - b.t);

  // 连续长条：两个长条头之间不到 2 拍
  let chain = 0;
  let maxChain = 0;
  let run = 1;
  for (let i = 1; i < heads.length; i++) {
    const gap = (heads[i].t - heads[i - 1].t) / beat;
    if (gap < 2) {
      chain++;
      run++;
      maxChain = Math.max(maxChain, run);
    } else {
      run = 1;
    }
  }
  maxChain = Math.max(maxChain, heads.length ? 1 : 0);

  // 松手→立刻按：同轨下一个音落在尾巴后 0.35 拍内
  const byCol = [[], [], [], []];
  for (const n of ns) byCol[n.col].push(n);
  for (const arr of byCol) arr.sort((a, b) => a.t - b.t);
  let tailTight = 0;
  for (const h of holds) {
    const arr = byCol[h.col];
    const i = arr.indexOf(h);
    const next = arr[i + 1];
    if (next && (next.t - (h.t + h.dur)) / beat < 0.35) tailTight++;
  }

  // 尾巴网格：1/4 拍（0.25）为单位的偏差。必须减去谱面的音频偏移，
  // 否则连"完全吸附"的谱面也会被判成离线（偏差 45% 都是这么来的）。
  let tailOffGrid = 0;
  for (const h of holds) {
    const b = (h.t + h.dur - offset) / beat;
    const d = Math.abs(b - Math.round(b * 4) / 4);
    if (d > 1 / 16) tailOffGrid++;
  }

  // 每小节长条数
  const barDur = beat * 4;
  const perBar = new Map();
  for (const h of heads) {
    const b = Math.floor((h.t - offset) / barDur);
    perBar.set(b, (perBar.get(b) || 0) + 1);
  }
  const barVals = [...perBar.values()];
  const barKeys = [...perBar.keys()].sort((a, b) => a - b);
  let maxBars = 0;
  let streak = 0;
  let prev = null;
  for (const b of barKeys) {
    streak = prev !== null && b === prev + 1 ? streak + 1 : 1;
    maxBars = Math.max(maxBars, streak);
    prev = b;
  }

  // 同时长条 / 长条重叠（同轨）
  const groups = groupByTime(ns);
  let chordHold = 0;
  for (const g of groups) {
    if (g.notes.filter((n) => n.hold).length > 1) chordHold++;
  }
  let overlap = 0;
  for (const h of holds) {
    for (const o of byCol[h.col]) {
      if (o === h) continue;
      if (o.t > h.t + 0.02 && o.t < h.t + h.dur - 0.02) overlap++;
    }
  }

  // 含长条的小节占比 —— 人类谱面长条是"局部现象"，不是每小节都有
  const allBars = new Set();
  for (const nn of ns) allBars.add(Math.floor((nn.t - offset) / barDur));
  const holdCoverage = allBars.size ? perBar.size / allBars.size : 0;

  return {
    notes: ns.length,
    holds: holds.length,
    holdCoverage,
    holdShare: holds.length / total,
    lenP10: pct(lens, 0.1),
    lenP50: pct(lens, 0.5),
    lenP90: pct(lens, 0.9),
    chainShare: heads.length > 1 ? chain / (heads.length - 1) : 0,
    maxChain,
    tailTight: holds.length ? tailTight / holds.length : 0,
    tailOffGrid: holds.length ? tailOffGrid / holds.length : 0,
    perBarP50: pct(barVals, 0.5),
    perBarP90: pct(barVals, 0.9),
    maxBars,
    chordHold,
    overlap,
  };
}
