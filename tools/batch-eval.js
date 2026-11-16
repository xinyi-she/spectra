// 批量评测：Sparebeat 官方谱 vs 我们生成的谱，同一首歌、同一把尺子
// 由 tools/cdp.mjs eval 执行，返回 JSON 字符串
(async () => {
  const ids = await (await fetch('./_ids.json')).json();
  const SR = 48000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];
  const fails = [];

  const { analyzeAudio } = await import('../js/analyzer.js');
  const { generateAll } = await import('../js/chart.js');
  const { parseSparebeat } = await import('./sparebeat.mjs');

  const corr = (a, b) => {
    const n = Math.min(a.length, b.length);
    if (n < 3) return 0;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let sa = 0, sb = 0, sab = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      sa += x * x; sb += y * y; sab += x * y;
    }
    return sa > 1e-9 && sb > 1e-9 ? sab / Math.sqrt(sa * sb) : 0;
  };

  /**
   * 核心：只看谱面，能还原多少音乐？
   * 按小节把 16 个十六分格的"音频能量向量"和"谱面击打向量"对齐比较：
   *   - 能量 ≥ 该小节峰值 50% 的格 = 音乐的重音位
   *   - 谱面有音的格 = 谱面的击打位
   *   - F1 / 相关系数 / 最优平移量
   */
  /**
   * 只看谱面，能还原多少音乐？
   * 按小节把 16 个十六分格的「音频能量向量」和「谱面击打向量」对齐比较。
   * dt = 整体时间偏移（毫秒）。谱面和音频之间的恒定错位不该算谱面的错，
   * 玩家有 offset 设置，所以另外再算一遍"对齐到最佳偏移"之后的结果。
   */
  function evaluate(notes, beat, offset, onset, frameDur, dtMs = 0) {
    if (!notes.length) return null;
    const barDur = beat * 4;
    const slotDur = barDur / 16;
    const frames = onset.length;
    const dt = dtMs / 1000;
    const shifted = notes.map((n) => ({ t: n.t + dt }));
    const t0Song = shifted[0].t;
    const t1Song = shifted[shifted.length - 1].t;

    let f1sum = 0, corrSum = 0, bars = 0, wsum = 0;
    let shiftVotes = 0, shiftCount = 0;

    const energyOf = (b, shift) => {
      const e = new Float32Array(16);
      for (let i = 0; i < 16; i++) {
        const a = b * barDur + ((i + shift + 16) % 16) * slotDur + offset;
        const f0 = Math.max(0, Math.floor(a / frameDur));
        const f1 = Math.min(frames - 1, Math.floor((a + slotDur) / frameDur));
        let m = 0;
        for (let f = f0; f <= f1; f++) if (onset[f] > m) m = onset[f];
        e[i] = m;
      }
      return e;
    };
    const hitsOf = (b) => {
      const h = new Float32Array(16);
      for (const n of shifted) {
        const bar = Math.floor((n.t - offset) / barDur);
        if (bar !== b) continue;
        const slot = Math.min(15, Math.floor((n.t - offset - bar * barDur) / slotDur));
        h[slot] = 1;
      }
      return h;
    };

    const bStart = Math.floor((t0Song - offset) / barDur);
    const bEnd = Math.floor((t1Song - offset) / barDur);
    for (let b = bStart; b <= bEnd; b++) {
      const h = hitsOf(b);
      const nh = h.reduce((s2, v) => s2 + v, 0);
      if (nh < 2) continue;
      bars++;
      const e = energyOf(b, 0);
      const peak = Math.max(...e);
      if (peak <= 1e-6) continue;
      const strong = Array.from(e, (v) => (v >= peak * 0.5 ? 1 : 0));
      const ns = strong.reduce((s2, v) => s2 + v, 0);
      let both = 0;
      for (let i = 0; i < 16; i++) if (h[i] && strong[i]) both++;
      const P = both / nh;
      const R = ns ? both / ns : 0;
      f1sum += (P + R > 0 ? (2 * P * R) / (P + R) : 0) * nh;
      wsum += nh;
      corrSum += corr(e, h);

      let best = -2, bestS = 0;
      for (let s2 = 0; s2 < 16; s2++) {
        const c = corr(energyOf(b, s2), h);
        if (c > best) { best = c; bestS = s2; }
      }
      shiftCount++;
      if (bestS === 0) shiftVotes++;
    }

    let atNotes = 0, cnt = 0;
    for (const n of shifted) {
      const f = Math.round(n.t / frameDur);
      if (f < 0 || f >= frames) continue;
      let m = 0;
      for (let k = -1; k <= 1; k++) m = Math.max(m, onset[Math.max(0, Math.min(frames - 1, f + k))]);
      atNotes += m;
      cnt++;
    }
    const meanO = onset.reduce((s2, v) => s2 + v, 0) / frames;

    return {
      notes: notes.length,
      bars,
      f1: wsum ? f1sum / wsum : 0,
      barCorr: bars ? corrSum / bars : 0,
      lift: cnt ? atNotes / cnt / Math.max(1e-6, meanO) : 0,
      shift0: shiftCount ? shiftVotes / shiftCount : 0,
    };
  }

  /** 在 ±250ms 内扫出让 lift 最高的整体偏移 */
  function bestOffset(notes, onset, frameDur) {
    const frames = onset.length;
    const meanO = onset.reduce((s2, v) => s2 + v, 0) / frames;
    let bestDt = 0, bestLift = 0;
    for (let ms = -250; ms <= 250; ms += 10) {
      let acc = 0, cnt = 0;
      for (const n of notes) {
        const f = Math.round((n.t + ms / 1000) / frameDur);
        if (f < 0 || f >= frames) continue;
        let m = 0;
        for (let k = -1; k <= 1; k++) m = Math.max(m, onset[Math.max(0, Math.min(frames - 1, f + k))]);
        acc += m; cnt++;
      }
      const v = cnt ? acc / cnt / Math.max(1e-6, meanO) : 0;
      if (v > bestLift) { bestLift = v; bestDt = ms; }
    }
    return { dt: bestDt, lift: bestLift };
  }

  /** 0 偏移 + 最佳偏移 两套指标 */
  function evalBoth(notes, beat, offset, a) {
    const m0 = evaluate(notes, beat, offset, a.onsetStrength, a.frameDur, 0);
    if (!m0) return null;
    const bo = bestOffset(notes, a.onsetStrength, a.frameDur);
    const m1 = evaluate(notes, beat, offset, a.onsetStrength, a.frameDur, bo.dt);
    return {
      ...m0,
      f1Best: m1.f1,
      barCorrBest: m1.barCorr,
      liftBest: bo.lift,
      bestShiftMs: bo.dt,
      shift0Best: m1.shift0,
    };
  }

  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    try {
      const [mapRes, audioRes] = await Promise.all([
        fetch('./_sbmaps/' + id + '.json'),
        fetch('./_sbaudio/' + id + '.mp3'),
      ]);
      if (!mapRes.ok || !audioRes.ok) throw new Error('fetch ' + mapRes.status + '/' + audioRes.status);
      const data = await mapRes.json();
      const buf = await audioRes.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1024, SR);
      const audio = await ctx.decodeAudioData(buf.slice(0));
      const pcm = audio.getChannelData(0);
      const a = analyzeAudio([Float32Array.from(pcm)], SR);

      // 官方谱
      for (const diff of ['easy', 'normal', 'hard']) {
        const p = parseSparebeat(data, diff);
        if (!p || p.notes.length < 50) continue;
        const m = evalBoth(p.notes, p.beat, p.offset, a);
        if (m) rows.push({ id, diff, src: 'sb', bpm: data.bpm, bpmRatio: +(a.bpm / data.bpm).toFixed(3), ...m });
      }
      // 我们生成的
      const ours = generateAll(a);
      ours.forEach((c, i) => {
        const notes = c.notes.map((n) => ({ t: n.t, lane: n.lane }));
        const m = evalBoth(notes, a.beatDur, c.beatOffset, a);
        const diff = ['easy', 'normal', 'hard'][i];
        if (m) rows.push({ id, diff, src: 'ours', bpm: +a.bpm.toFixed(1), bpmRatio: +(a.bpm / data.bpm).toFixed(3), ...m });
      });
      await sleep(0);
    } catch (e) {
      fails.push(id + ': ' + e.message);
    }
  }
  return JSON.stringify({ rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v]))), fails });
})()
