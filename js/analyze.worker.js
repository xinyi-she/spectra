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
    // 方法无法结构化克隆，去掉后再发回主线程
    const { energyAt, beatAt, ...plain } = analysis;
    void energyAt;
    void beatAt;
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
