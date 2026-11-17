/**
 * 音高检测的实测诊断
 * ------------------------------------------------------------------
 * 关心三件事：
 *  1. 覆盖率 —— 多少 onset 有可用音高（太低说明检测失败，谱面等于没变化）
 *  2. 音高分布 —— 是否落在合理的人声/主奏区间，有没有系统性偏移
 *  3. 旋律跟随度 —— 相邻两个有音高的音，音高变化方向与键位变化方向的一致率
 */
import fs from 'node:fs';
import { analyzeAudio } from '../js/analyzer.js';
import { generateChart, DIFFICULTIES } from '../js/chart.js';
import { semiToHz } from '../js/pitch.js';

function load(path) {
  const b = fs.readFileSync(path);
  const n = b.length / 2;
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = b.readInt16LE(i * 2) / 32768;
  return pcm;
}

for (const path of process.argv.slice(2)) {
  const pcm = load(path);
  const t0 = Date.now();
  const a = analyzeAudio([pcm], 48000);
  const ms = Date.now() - t0;

  const pitched = a.onsets.filter((o) => (o.clarity || 0) >= 0.5 && isFinite(o.semi));
  const semis = pitched.map((o) => o.semi).sort((x, y) => x - y);
  const q = (p) => semis[Math.max(0, Math.min(semis.length - 1, Math.round((semis.length - 1) * p)))];
  const hist = new Array(12).fill(0);
  for (const s of semis) hist[((Math.round(s) % 12) + 12) % 12]++;
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  console.log('\n== ' + path + '  ' + (a.duration).toFixed(0) + 's  BPM ' + a.bpm + '  分析 ' + ms + 'ms');
  console.log(
    '  覆盖率 ' + (a.pitch.coverage * 100).toFixed(1) + '%  (' + pitched.length + '/' + a.onsets.length + ')'
  );
  if (semis.length) {
    console.log(
      '  音域 ' + semiToHz(q(0.1)).toFixed(0) + '–' + semiToHz(q(0.9)).toFixed(0) + ' Hz' +
      '  中位 ' + semiToHz(a.pitch.median).toFixed(0) + 'Hz (' + names[((Math.round(a.pitch.median) % 12) + 12) % 12] + ')'
    );
    const top = hist.map((v, i) => [names[i], v]).sort((x, y) => y[1] - x[1]).slice(0, 4);
    console.log('  最常见音级 ' + top.map(([n, v]) => n + ' ' + ((v / semis.length) * 100).toFixed(0) + '%').join('  '));
  }

  for (const diff of [DIFFICULTIES[1], DIFFICULTIES[2]]) {
    const c = generateChart(a, diff);
    const withPitch = c.notes.filter((n) => isFinite(n.semi));
    // 旋律跟随度：只看"两个相邻音都有音高且间隔 < 1 拍"的情况
    let follow = 0;
    let cnt = 0;
    const sorted = c.notes.filter((n) => isFinite(n.semi)).sort((x, y) => x.t - y.t);
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1];
      const n = sorted[i];
      if (n.t - p.t > a.beatDur) continue;
      if (Math.abs(n.semi - p.semi) < 0.45) continue;
      const pd = Math.sign(n.semi - p.semi);
      // roll 跨轨回绕（3→0）在听觉上仍是"上行"，按回绕方向归一化
      let raw = n.lane - p.lane;
      if (raw === 3) raw = -1;
      if (raw === -3) raw = 1;
      const ld = Math.sign(raw);
      if (ld === 0) continue;
      cnt++;
      if (pd === ld) follow++;
    }
    console.log(
      '  ' + c.name + ' Lv' + c.level + '  ' + c.noteCount + ' 音符' +
      '  带音高 ' + ((withPitch.length / c.noteCount) * 100).toFixed(0) + '%' +
      '  旋律跟随 ' + (cnt ? ((follow / cnt) * 100).toFixed(0) + '%' : 'n/a') + ' (' + cnt + ')'
    );
  }
}
