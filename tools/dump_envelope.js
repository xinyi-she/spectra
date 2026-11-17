/**
 * 把每首官方曲的 onset 包络 dump 到 tools/_envelope.json
 *
 * 为什么要 dump：调 BPM 判据（先验权重、打分项、窗口长度）如果每次都走
 * 「跑一遍 54 首 → 生成谱面 → 汇总」要 3~5 分钟；把包络存下来之后，
 * `node tools/tempo_lab.mjs` 在 Node 里扫参数只要几秒。
 *
 * 用法（需要本地服务 + tools/_sbaudio 已下好）：
 *   node tools/cdp.mjs eval http://127.0.0.1:8777/tools/selftest.html tools/dump_envelope.js  *     | grep '^\[{' > tools/_envelope.json
 */
(async () => {
  const SR = 48000;
  const { analyzeAudio } = await import('../js/analyzer.js');
  const ids = JSON.parse(await (await fetch('./_ids.json')).text());
  const out = [];
  for (const id of ids) {
    let map, buf;
    try {
      map = await (await fetch('./_sbmaps/' + id + '.json')).json();
      buf = await (await fetch('./_sbaudio/' + id + '.mp3')).arrayBuffer();
    } catch { continue; }
    const ctx = new OfflineAudioContext(1, 1024, SR);
    let audio;
    try { audio = await ctx.decodeAudioData(buf.slice(0)); } catch { continue; }
    const a = analyzeAudio([Float32Array.from(audio.getChannelData(0))], SR);
    // 4 位小数足够（包络本身是 0..~10 的量级），体积可控
    const os = Array.from(a.onsetStrength, (v) => Math.round(v * 1e4) / 1e4);
    out.push({ id, trueBpm: map.bpm, ourBpm: a.bpm, frameDur: a.frameDur, dur: audio.duration, os });
  }
  return JSON.stringify(out);
})()
