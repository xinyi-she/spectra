/**
 * 从 Sparebeat 官方谱面里提炼「小节节奏词汇表」
 * ==================================================================
 * 思路来自 Time-based Chart Partitioning（AIIDE'25）与 TaikoNation：
 * 人类谱师不是每个音都独立"跟 onset"，而是在用一小批固定的小节节奏型
 * （pattern）拼歌。自动谱面之所以显得散，是因为它每小节都重新从头算一遍。
 *
 * 这里只统计「16 格里哪些格有音」（不分轨道），也就是节奏型本身。
 * 输出 js/patterns.js，供生成器在运行时按密度挑选最贴合音频的词汇。
 *
 *   node tools/build_patterns.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const DIR = path.join(ROOT, '_sbmaps');

const NOTE = '12345678';
const HEAD = 'abcd';

// 每个节奏型还要记住：哪些格通常写成双押（同一格里 ≥2 个音符）。
// 双押位置必须由节奏型本身决定 —— 按每小节的音量重算，同一个型这节在第 0 格加倍、
// 下节在第 8 格加倍，节奏型字符串就变了，动机（motivation）也就没了。
const buckets = { easy: new Map(), normal: new Map(), hard: new Map() };
// 相邻小节的"节奏型搭配"（一阶马尔可夫）。人类写谱不是每小节独立挑型，
// 而是成句：1.1.1.1. → 1...1... → 1.1.1.1. 这种语序比单个型更能说明"像人写的"。
const bigrams = { easy: new Map(), normal: new Map(), hard: new Map() };

for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  } catch {
    continue;
  }
  for (const diff of ['easy', 'normal', 'hard']) {
    const rows = (data.map && data.map[diff]) || [];
    const seq = [];
    for (const row of rows) {
      if (typeof row !== 'string') continue;
      if (row.includes('(') || row.includes(')') || row.includes('[') || row.includes(']')) continue;
      const cells = row.split(',');
      if (cells.length !== 16) continue;
      const mask = new Array(16).fill('0');
      const chord = new Array(16).fill(0);
      let cnt = 0;
      for (let i = 0; i < 16; i++) {
        let on = 0;
        for (const ch of cells[i]) if (NOTE.includes(ch) || HEAD.includes(ch)) on++;
        if (on > 0) {
          mask[i] = '1';
          cnt++;
          if (on >= 2) chord[i] = 1;
        }
      }
      if (cnt < 1) {
        seq.push('-');
        continue; // 完全空的小节，不进词汇表，但会打断 bigram 链
      }
      const key = mask.join('');
      if (!buckets[diff].has(key)) buckets[diff].set(key, { w: 0, chord: new Array(16).fill(0) });
      const rec = buckets[diff].get(key);
      rec.w++;
      for (let i = 0; i < 16; i++) rec.chord[i] += chord[i];
      seq.push(key);
    }
  }
}

// 统计 bigram（跳过空小节，空小节视为断句）
for (const diff of ['easy', 'normal', 'hard']) {
  bigrams[diff] = new Map();
}
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  } catch {
    continue;
  }
  for (const diff of ['easy', 'normal', 'hard']) {
    const rows = (data.map && data.map[diff]) || [];
    let prev = null;
    for (const row of rows) {
      if (typeof row !== 'string' || row.includes('(') || row.includes('[')) {
        prev = null;
        continue;
      }
      const cells = row.split(',');
      if (cells.length !== 16) {
        prev = null;
        continue;
      }
      let key = '';
      let cnt = 0;
      for (let i = 0; i < 16; i++) {
        let on = 0;
        for (const ch of cells[i]) if (NOTE.includes(ch) || HEAD.includes(ch)) on++;
        key += on > 0 ? '1' : '0';
        if (on > 0) cnt++;
      }
      if (cnt < 1) {
        prev = null;
        continue;
      }
      if (prev) {
        const m = bigrams[diff];
        if (!m.has(prev)) m.set(prev, new Map());
        const t = m.get(prev);
        t.set(key, (t.get(key) || 0) + 1);
      }
      prev = key;
    }
  }
}

const result = {};
const bigramOut = {};
for (const diff of ['easy', 'normal', 'hard']) {
  const arr = [...buckets[diff].entries()].sort((a, b) => b[1].w - a[1].w);
  const total = arr.reduce((s, [, v]) => s + v.w, 0);
  let acc = 0;
  const keep = [];
  for (const [mask, rec] of arr) {
    acc += rec.w;
    // c：每格"写成双押"的比例，十分位（0-9）。生成时用它决定双押位置。
    const c = rec.chord.map((v) => String(Math.min(9, Math.round((v / rec.w) * 9)))).join('');
    keep.push({ m: mask, n: mask.split('').filter((ch) => ch === '1').length, w: rec.w, c });
    if (acc / total >= 0.72) break;
  }
  result[diff] = keep;
  // 只保留词汇表内部的转移，避免文件里塞一堆用不上的型
  const keepSet = new Set(keep.map((p) => p.m));
  const trans = {};
  for (const [from, m] of bigrams[diff]) {
    if (!keepSet.has(from)) continue;
    const arr = [...m.entries()]
      .filter(([to]) => keepSet.has(to))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    if (arr.length) trans[from] = Object.fromEntries(arr);
  }
  bigramOut[diff] = trans;
  console.log(
    `${diff.padEnd(6)} 小节 ${String(total).padStart(6)}  不同型 ${String(arr.length).padStart(5)}  ` +
      `保留 ${String(keep.length).padStart(3)} 型覆盖 ${((acc / total) * 100).toFixed(0)}%`
  );
  console.log(
    '  top10: ' +
      arr
        .slice(0, 10)
        .map(([m, rec]) => `${m.replace(/0/g, '.')}(${((rec.w / total) * 100).toFixed(1)}%)`)
        .join(' ')
  );
}

const out = `// 由 tools/build_patterns.mjs 生成，勿手改。
// 数据来源：Sparebeat 官方谱面（54 首 / 162 张谱）的小节节奏型频次统计。
// 格式：m = 16 格是否落音（'1' 有音 / '0' 空），n = 该小节音符数，w = 出现次数，
//       c = 16 格"写成双押"的比例（十分位 0-9）。
export const PATTERNS = ${JSON.stringify(result)};

// 相邻小节的节奏型搭配：TRANS[diff][当前型][下一型] = 出现次数
export const TRANS = ${JSON.stringify(bigramOut)};
`;
fs.writeFileSync(path.join(ROOT, '..', 'js', 'patterns.js'), out);
console.log('\n写出 js/patterns.js');
