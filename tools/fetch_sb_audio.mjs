/**
 * 下载 Sparebeat 官方曲目的音频（仅本地分析用，不入库）
 * 并发 4，带重试；已存在且 >1MB 就跳过。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const OUT = path.join(ROOT, '_sbaudio');
fs.mkdirSync(OUT, { recursive: true });

const ids = fs
  .readdirSync(path.join(ROOT, '_sbmaps'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''));

const todo = ids.filter((id) => {
  const f = path.join(OUT, id + '.mp3');
  return !(fs.existsSync(f) && fs.statSync(f).size > 1_000_000);
});
console.log(`共 ${ids.length} 首，待下载 ${todo.length}`);

let ok = 0;
let fail = 0;
let cursor = 0;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) spectra-local-analysis';

async function one(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 120000);
      const r = await fetch(`https://sparebeat.com/play/${id}/music`, {
        headers: { 'User-Agent': UA, Referer: `https://sparebeat.com/play/${id}/` },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200_000) throw new Error('太小 ' + buf.length);
      const tmp = path.join(OUT, id + '.part');
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(OUT, id + '.mp3'));
      ok++;
      if (ok % 5 === 0) console.log(`  已下 ${ok}/${todo.length}（${id} ${(buf.length / 1048576).toFixed(1)}MB）`);
      return;
    } catch (e) {
      if (attempt === 2) {
        fail++;
        console.log(`  [fail] ${id}: ${e.message}`);
      } else await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function worker() {
  while (cursor < todo.length) await one(todo[cursor++]);
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`完成：${ok} 成功，${fail} 失败`);
const all = fs.readdirSync(OUT).filter((f) => f.endsWith('.mp3'));
fs.writeFileSync(
  path.join(ROOT, '_ids.json'),
  JSON.stringify(all.map((f) => f.replace('.mp3', '')).filter((id) => ids.includes(id)))
);
console.log(`音频 ${all.length} 个，_ids.json 已更新`);
