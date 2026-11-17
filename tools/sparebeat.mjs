/**
 * Sparebeat 谱面解析（供蒸馏 / 对比脚本共用）
 * ------------------------------------------------------------------
 * 格式来自游戏前端 `map` 解析函数：
 *   一行 = 一小节，用 `,` 切成 16 格（三连音模式下 24 格）；
 *   **一格内可以有多个字符 = 和弦**（"12" = 第 1、3 轨同时）。
 *
 *   1-4   NORMAL（第 1~4 轨）      5-8   ATTACK（要配合空格）
 *   a-d   LONG_START               e-h   LONG_END
 *   ( )   进入 / 退出三连音模式（每小节 24 格）
 *   [ ]   BIND_START / END        对象行 {bpm} / {speed} / {barLine}
 */
/**
 * 官方谱的时钟比音频瞬态**晚约 35ms**。
 *
 * 三种独立方法在 54 首官方曲上量过（详见 docs/DESIGN.md）：
 *   - 官方音符到最近「检测 onset」的有符号距离：中位 +37.8ms
 *     （只取音符 60% 以上都落在 onset 上的 16 首，中位 +34.8ms）
 *   - 官方音符到「波形上升沿」的距离：中位 +29ms
 *   - 让「音符处能量」最高的整体平移：−40~−70ms（按 21ms 帧量化后与上面一致）
 * 我们自己的检测 onset 到波形上升沿是 −0.7ms，所以不是检测器偏早。
 *
 * 这个常数只把两个文件对齐到同一时钟，**不改谱面本身**：默认不加，
 * 只有拿谱面和音频对比时（batch-eval）才传 `alignAudio: true`。
 */
export const CHART_LAG_MS = 35;

export function parseSparebeat(data, diff, { alignAudio = false } = {}) {
  const rows = data && data.map && data.map[diff];
  if (!rows) return null;
  let bpm = data.bpm;
  const lag = alignAudio ? CHART_LAG_MS : 0;
  let t = (data.startTime || 0) - lag; // 毫秒
  const notes = [];
  const open = [null, null, null, null];
  let triplet = false;
  let bpmChanges = 0;

  for (const row of rows) {
    if (row && typeof row === 'object') {
      if (row.bpm) {
        if (Math.abs(row.bpm - bpm) > 1e-6) bpmChanges++;
        bpm = row.bpm;
      }
      continue; // speed / barLine 不影响时间轴
    }
    if (typeof row !== 'string') continue;
    const barMs = (60000 / bpm) * 4;
    for (const cell of row.split(',')) {
      const unit = triplet ? barMs / 24 : barMs / 16;
      for (const c of cell) {
        if ('12345678'.includes(c)) {
          const L = '1234'.includes(c) ? '1234'.indexOf(c) : '5678'.indexOf(c);
          notes.push({ t, lane: L, hold: false, dur: 0, attack: c >= '5' });
        } else if ('abcd'.includes(c)) {
          const L = 'abcd'.indexOf(c);
          if (open[L] !== null) notes.push({ t: open[L], lane: L, hold: true, dur: t - open[L] });
          open[L] = t;
        } else if ('efgh'.includes(c)) {
          const L = 'efgh'.indexOf(c);
          if (open[L] !== null) {
            notes.push({ t: open[L], lane: L, hold: true, dur: Math.max(unit, t - open[L]) });
            open[L] = null;
          }
        } else if (c === '(') triplet = true;
        else if (c === ')') triplet = false;
      }
      t += unit;
    }
  }
  for (let L = 0; L < 4; L++) {
    if (open[L] !== null) notes.push({ t: open[L], lane: L, hold: true, dur: 60000 / bpm });
  }

  const out = notes.map((n) => ({
    t: n.t / 1000,
    lane: n.lane,
    hold: n.hold,
    dur: n.dur / 1000,
    attack: n.attack,
  }));
  out.sort((a, b) => a.t - b.t || a.lane - b.lane);
  return {
    notes: out,
    bpm: data.bpm,
    bpmChanges,
    beat: 60 / data.bpm,
    offset: ((data.startTime || 0) - lag) / 1000,
    lagMs: lag,
    hasTriplet: rows.some((r) => typeof r === 'string' && /[()]/.test(r)),
  };
}
