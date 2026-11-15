import { analyzeAudio } from './analyzer.js';
import { generateAll } from './chart.js';

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  try {
    const t0 = performance.now();
    const analysis = analyzeAudio(samples, sampleRate);
    const t1 = performance.now();
    const charts = generateAll(analysis);
    const t2 = performance.now();
    // 方法无法结构化克隆，去掉后再发回主线程。
    // 注意：必须把分析结果里的**所有函数**都列出来。漏一个就会 DataCloneError，
    // 整个结果发不回去 —— 表现为"分析 8ms、0 个音符、BPM 也不对"。
    const { energyAt, beatAt, pitchRel, ...plain } = analysis;
    void energyAt;
    void beatAt;
    void pitchRel;
    self.postMessage({
      ok: true,
      analysis: plain,
      charts,
      ms: { analysis: Math.round(t1 - t0), charts: Math.round(t2 - t1) },
    });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
};
