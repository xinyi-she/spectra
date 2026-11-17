/**
 * 汇总批量评测结果（tools/_batch.json → 终端 + tools/batch_report.md）
 *
 * 核心问题：**只听谱面，能还原多少音乐？**
 *   f1       —— 小节内 16 格里，谱面击打位与"音频能量≥本小节峰值 50%"的格子有多重合
 *   barCorr  —— 同一小节里 16 维能量向量与谱面 0/1 向量的相关系数（逐小节平均）
 *   lift     —— 音符时刻的击打强度 ÷ 全曲平均
 *   shift0   —— 小节内最优循环平移为 0 的比例（谱面小节线和音乐对不对得上）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const raw = fs.readFileSync(path.join(ROOT, '_batch.json'), 'utf8');
const data = JSON.parse(raw.slice(raw.indexOf('{')));
const rows = data.rows;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const med = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.round((s.length - 1) / 2)];
};
const F = (v, d = 3) => (v == null ? '—' : v.toFixed(d));

const group = (src, diff) => rows.filter((r) => r.src === src && r.diff === diff);
const diffs = ['easy', 'normal', 'hard'];

console.log(`样本：${new Set(rows.map((r) => r.id)).size} 首曲，${rows.length} 张谱\n`);
console.log('来源      难度    谱数   f1     人声%  只踩镲%   lift   最优lift  小节线对齐  偏移中位');
const summary = {};
for (const src of ['sb', 'ours']) {
  for (const d of diffs) {
    const g = group(src, d);
    if (!g.length) continue;
    summary[src + '-' + d] = {
      n: g.length,
      f1: mean(g.map((r) => r.f1)),
      onVoice: mean(g.map((r) => r.onVoice || 0)),
      onHat: mean(g.map((r) => r.onHat || 0)),
      barCorr: mean(g.map((r) => r.barCorr)),
      lift: mean(g.map((r) => r.lift)),
      liftBest: mean(g.map((r) => r.liftBest)),
      shift0: mean(g.map((r) => r.shift0)),
      shiftMs: med(g.map((r) => r.bestShiftMs)),
    };
    const s = summary[src + '-' + d];
    console.log(
      `${(src === 'sb' ? 'Sparebeat' : '本作').padEnd(9)}${d.padEnd(7)}${String(s.n).padStart(4)}  ` +
        `${F(s.f1).padStart(6)}  ${(s.onVoice * 100).toFixed(0).padStart(5)}%  ${(s.onHat * 100).toFixed(1).padStart(6)}%  ${F(s.lift, 2).padStart(5)}  ` +
        `${F(s.liftBest, 2).padStart(6)}  ${(s.shift0 * 100).toFixed(0).padStart(8)}%  ${String(s.shiftMs).padStart(6)}ms`
    );
  }
}

// 同曲对拍
console.log('\n同曲对比（官方谱 − 本作，正数=官方更贴音乐）');
for (const d of diffs) {
  const by = new Map();
  for (const r of rows) {
    if (r.diff !== d) continue;
    if (!by.has(r.id)) by.set(r.id, {});
    by.get(r.id)[r.src] = r;
  }
  const pairs = [...by.values()].filter((p) => p.sb && p.ours);
  if (!pairs.length) continue;
  const dF1 = pairs.map((p) => p.sb.f1 - p.ours.f1);
  const dLift = pairs.map((p) => p.sb.lift - p.ours.lift);
  const win = dF1.filter((v) => v < 0).length;
  console.log(
    `  ${d.padEnd(7)} n=${String(pairs.length).padStart(3)}  Δf1 ${F(mean(dF1), 3).padStart(7)}  Δlift ${F(mean(dLift), 2).padStart(6)}  本作更好的曲目 ${win}`
  );
}

// BPM 检测
const ours = rows.filter((r) => r.src === 'ours');
const byId = new Map();
for (const r of ours) if (!byId.has(r.id)) byId.set(r.id, r);
const ratios = [...byId.values()].map((r) => r.bpmRatio);
const okRate = ratios.filter((v) => Math.abs(v - 1) <= 0.02).length / ratios.length;
const half = ratios.filter((v) => Math.abs(v - 0.5) <= 0.04 || Math.abs(v - 2) <= 0.08).length;
const third = ratios.filter((v) => Math.abs(v - 2 / 3) <= 0.05 || Math.abs(v - 1.5) <= 0.08).length;
console.log(
  `\nBPM 检测：与官方 BPM 相差 ≤2% 的 ${(okRate * 100).toFixed(0)}%  倍数错(${half}/${ratios.length})  1.5 倍族错(${third}/${ratios.length})`
);

// 最差的本作曲目
const worst = [...byId.values()].sort((a, b) => a.lift - b.lift).slice(0, 8);
console.log('\n本作 lift 最低的曲目（越接近 1 越像"瞎按"）');
for (const w of worst) console.log(`  ${w.id.padEnd(22)} BPM ${String(w.bpm).padStart(6)} (×${F(w.bpmRatio, 3)})  lift ${F(w.lift, 2)}  f1 ${F(w.f1)}`);

const md = [
  '# 只听谱面，能还原多少音乐？',
  '',
  `样本：${new Set(rows.map((r) => r.id)).size} 首 Sparebeat 官方曲目，官方谱与自动谱各 3 档。`,
  '',
  '| 来源 | 难度 | 谱数 | f1 | 人声% | 只踩镲% | lift | 最优 lift | 小节线对齐 | 偏移中位 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...['sb', 'ours'].flatMap((src) =>
    diffs
      .filter((d) => summary[src + '-' + d])
      .map((d) => {
        const s = summary[src + '-' + d];
        return `| ${src === 'sb' ? 'Sparebeat' : '本作'} | ${d} | ${s.n} | ${F(s.f1)} | ${(s.onVoice * 100).toFixed(0)}% | ${(s.onHat * 100).toFixed(1)}% | ${F(s.lift, 2)} | ${F(s.liftBest, 2)} | ${(s.shift0 * 100).toFixed(0)}% | ${s.shiftMs}ms |`;
      })
  ),
  '',
  '## 怎么读',
  '',
  '- **f1**：小节内 16 个十六分格里，谱面「有音」的格子 vs 音频能量达到本小节峰值 50% 的格子，重合度的 F1。',
  '- **小节相关**：同一小节里 16 维音频能量向量与谱面 0/1 向量的皮尔逊相关（逐小节平均）。',
  '- **lift**：音符时刻的击打强度 ÷ 全曲平均。接近 1 = 音符落在随便哪都一样的位置。',
  '- **最优 lift / 偏移中位**：允许整体平移 ±250ms 后能达到的最高 lift，以及使 lift 最高的偏移量。',
  '  偏移中位接近 0 且最优 lift 与 lift 差得不多 → 时间轴是准的。',
  '- **小节线对齐**：小节内 16 格循环平移里，让相关最高的平移量恰好为 0 的比例。',
  '',
  `BPM 检测：与官方 BPM 相差 ≤2% 的 ${(okRate * 100).toFixed(0)}%，倍数错 ${half}/${ratios.length}，1.5 倍族错 ${third}/${ratios.length}。`,
].join('\n');
fs.writeFileSync(path.join(ROOT, 'batch_report.md'), md);
console.log('\n已写出 tools/batch_report.md');
