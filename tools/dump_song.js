/**
 * 把一首歌的分析结果 + 生成谱面 dump 成 JSON，供 Node 端做逐小节的"节奏感"诊断
 *
 *   node tools/cdp.mjs eval http://127.0.0.1:8777/tools/selftest.html tools/dump_song.js \
 *     | grep '^{"url' > tools/_song.json
 *
 * 默认 dump 内置的 world.execute(me)；要看别的曲子加 `?song=`：
 *   ...selftest.html?song=../assets/demo/tenfold.mp3
 *
 * 输出里带每个起音的音高/可信度/频段，以及三档谱面的音符，够算：
 * 音符落在起音上的比例、落在人声上的比例、只落在踩镲上的比例、逐小节节奏型对照。
 */
(async () => {
  const SR = 48000;
  const { analyzeAudio } = await import('../js/analyzer.js');
  const { generateAll } = await import('../js/chart.js');

  const url = new URLSearchParams(location.search).get('song') || '../assets/demo/worldexec.mp3';
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1024, SR);
  const audio = await ctx.decodeAudioData(buf.slice(0));
  const a = analyzeAudio([Float32Array.from(audio.getChannelData(0))], SR);
  const charts = generateAll(a);

  return JSON.stringify({
    url,
    dur: audio.duration,
    bpm: a.bpm,
    beatDur: a.beatDur,
    firstBeat: a.firstBeat,
    onsets: a.onsets.map((o) => ({
      t: Math.round(o.t * 1000) / 1000,
      s: Math.round(o.s * 1000) / 1000,
      b: o.bands.map((v) => Math.round(v * 100) / 100),
      tone: o.tone,
      semi: o.semi != null ? Math.round(o.semi * 10) / 10 : null,
      clar: o.clarity != null ? Math.round(o.clarity * 100) / 100 : null,
      stable: !!o.stable,
    })),
    charts: charts.map((c) => ({
      name: c.name,
      level: c.level,
      notes: c.notes.map((n) => ({
        t: Math.round(n.t * 1000) / 1000,
        lane: n.lane,
        type: n.type,
        dur: n.dur ? Math.round(n.dur * 1000) / 1000 : 0,
      })),
    })),
  });
})()
