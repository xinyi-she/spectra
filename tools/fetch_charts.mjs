/**
 * 下载 4K mania 谱面文本（.osu），只做统计用
 * 并发 4，失败重试 2 次；已存在则跳过，可断点续传。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const OUT = path.join(ROOT, '_charts');
const UA = 'spectra-chart-research/1.0 (offline pattern statistics)';
fs.mkdirSync(OUT, { recursive: true });

const picked = JSON.parse(fs.readFileSync(path.join(ROOT, '_picked.json'), 'utf8'));
console.log('目标', picked.length, '个');

const todo = picked.filter((c) => {
  const f = path.join(OUT, `${c.id}.osu`);
  return !(fs.existsSync(f) && fs.statSync(f).size > 2000);
});
console.log('待下载', todo.length, '个（已存', picked.length - todo.length, '）');

let ok = 0;
let fail = 0;
let cursor = 0;

async function one(c) {
  const f = path.join(OUT, `${c.id}.osu`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      const r = await fetch(`https://osu.direct/api/osu/${c.id}`, {
        headers: { 'User-Agent': UA },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      if (!text.startsWith('osu file format')) throw new Error('不是谱面');
      fs.writeFileSync(f, text);
      ok++;
      if (ok % 20 === 0) console.log(`  进度 ${ok}/${todo.length}`);
      return;
    } catch (e) {
      if (attempt === 2) {
        fail++;
        console.log(`  [fail] ${c.id} ${c.version}: ${e.message}`);
      } else {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
}

async function worker() {
  while (cursor < todo.length) {
    const c = todo[cursor++];
    await one(c);
    await new Promise((r) => setTimeout(r, 120));
  }
}

await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`完成：${ok} 成功，${fail} 失败`);
