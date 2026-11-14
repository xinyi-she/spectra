import { AudioEngine } from './audio.js';
import { analyzeAudio } from './analyzer.js';
import { generateAll, DIFFICULTIES } from './chart.js';
import { RhythmGame } from './game.js';

/* ============================ 设置 ============================ */
const DEFAULT_SETTINGS = {
  theme: 'sunset',
  keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  music: 0.9,
  sfx: 0.6,
  speed: 1.6,
  offset: 0,
  bind: false,
};

const THEMES = [
  { id: 'sunset', name: '日落', colors: ['#a78bfa', '#f472b6'] },
  { id: 'ocean', name: '海洋', colors: ['#38bdf8', '#22d3ee'] },
  { id: 'forest', name: '森林', colors: ['#34d399', '#a3e635'] },
  { id: 'snow', name: '雪原', colors: ['#dbeafe', '#93c5fd'] },
];

const KEY_LABELS = {
  KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F', KeyG: 'G',
  KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L', KeyM: 'M', KeyN: 'N',
  KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R', KeyS: 'S', KeyT: 'T', KeyU: 'U',
  KeyV: 'V', KeyW: 'W', KeyX: 'X', KeyY: 'Y', KeyZ: 'Z',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
  Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0',
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem('spectra.settings') || '{}');
    return { ...DEFAULT_SETTINGS, ...raw, keys: raw.keys && raw.keys.length === 4 ? raw.keys : [...DEFAULT_SETTINGS.keys] };
  } catch {
    return { ...DEFAULT_SETTINGS, keys: [...DEFAULT_SETTINGS.keys] };
  }
}

const settings = loadSettings();
const audio = new AudioEngine();
audio.setMusicVolume(settings.music);
audio.setSfxVolume(settings.sfx);

const $ = (id) => document.getElementById(id);
const state = {
  view: 'home',
  buffer: null,
  analysis: null,
  charts: null,
  song: null,
  selected: null,
  game: null,
  lastDiff: 'normal',
  analyzeMs: 0,
};

/* ============================ 通用 UI ============================ */
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const el = $(`screen-${name}`);
  if (el) el.classList.add('active');
  state.view = name;
  document.body.style.overflow = name === 'play' ? 'hidden' : '';
  if (name !== 'play' && state.game) {
    // 离开游玩界面时确保音频停止
    state.game.destroy();
    state.game = null;
  }
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ============================ 主题 & 设置面板 ============================ */
function applyTheme(id) {
  document.body.dataset.theme = id;
}

function buildSettingsUI() {
  const list = $('theme-list');
  list.innerHTML = '';
  THEMES.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'theme-swatch' + (settings.theme === t.id ? ' sel' : '');
    b.title = t.name;
    b.innerHTML = `<span style="background:linear-gradient(135deg,${t.colors[0]},${t.colors[1]})"></span>`;
    b.onclick = () => {
      settings.theme = t.id;
      applyTheme(t.id);
      persist();
      list.querySelectorAll('.theme-swatch').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    };
    list.appendChild(b);
  });

  renderKeymap();
  $('set-music').value = Math.round(settings.music * 100);
  $('set-music-v').textContent = Math.round(settings.music * 100);
  $('set-sfx').value = Math.round(settings.sfx * 100);
  $('set-sfx-v').textContent = Math.round(settings.sfx * 100);
  $('set-bind').dataset.on = String(!!settings.bind);
}

function renderKeymap() {
  const box = $('keymap');
  box.innerHTML = '';
  settings.keys.forEach((code, i) => {
    const b = document.createElement('button');
    b.className = 'key-btn';
    b.textContent = KEY_LABELS[code] || code.replace('Key', '');
    b.dataset.lane = i;
    b.onclick = () => {
      box.querySelectorAll('.key-btn').forEach((x) => x.classList.remove('listening'));
      b.classList.add('listening');
      b.textContent = '按键…';
      const handler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.code !== 'Escape') {
          settings.keys[i] = e.code;
          persist();
          renderKeymap();
          updateKeycaps();
        } else {
          renderKeymap();
        }
        window.removeEventListener('keydown', handler, true);
      };
      window.addEventListener('keydown', handler, true);
    };
    box.appendChild(b);
  });
  updateKeycaps();
}

function updateKeycaps() {
  for (let i = 0; i < 4; i++) {
    const el = document.querySelector(`[data-keycap="${i}"]`);
    if (el) el.textContent = KEY_LABELS[settings.keys[i]] || '?';
  }
}

function persist() {
  localStorage.setItem('spectra.settings', JSON.stringify(settings));
}

function openModal(id) {
  $(id).classList.add('on');
}
function closeModal(id) {
  $(id).classList.remove('on');
}

/* ============================ 音频载入 & 分析 ============================ */
function placeholderCover(title) {
  const letter = (title || '?').trim().charAt(0).toUpperCase();
  const c1 = getComputedStyle(document.body).getPropertyValue('--a1').trim() || '#a78bfa';
  const c2 = getComputedStyle(document.body).getPropertyValue('--a2').trim() || '#f472b6';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="640" height="400" fill="#0b0918"/>
    <rect width="640" height="400" fill="url(#g)" opacity="0.32"/>
    <g stroke="#ffffff" stroke-opacity="0.08">
      ${Array.from({ length: 16 }, (_, i) => `<line x1="${i * 40}" y1="0" x2="${i * 40}" y2="400"/>`).join('')}
    </g>
    <text x="320" y="252" font-size="180" font-family="Segoe UI, sans-serif" font-weight="700"
      fill="#ffffff" fill-opacity="0.9" text-anchor="middle">${letter}</text>
  </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function loadAudioBuffer(arrayBuffer, song) {
  $('analyze-overlay').classList.add('on');
  setAnalyze(6, '解码音频…', song.title);
  const bars = $('an-bars');
  if (!bars.childElementCount) {
    for (let i = 0; i < 26; i++) {
      const b = document.createElement('i');
      b.style.animationDelay = `${(i % 13) * 0.07}s`;
      b.style.height = `${20 + ((i * 37) % 60)}%`;
      bars.appendChild(b);
    }
  }
  await nextFrame();

  try {
    const buffer = await audio.decode(arrayBuffer.slice(0));
    state.buffer = buffer;
    setAnalyze(20, '听辨节拍与鼓点…', `${buffer.duration.toFixed(1)} 秒 · ${buffer.sampleRate} Hz`);
    await nextFrame();

    const result = await runAnalysis(buffer, setAnalyze);
    state.analysis = result.analysis;
    state.charts = result.charts;
    state.analyzeMs = result.ms.analysis;
    state.cache = { key: song.key, buffer, analysis: result.analysis, charts: result.charts, ms: result.ms.analysis };
    // 把分析结果回填到曲库卡片
    const levels = result.charts.map((c) => c.level);
    song.bpm = result.analysis.bpm;
    song.levels = levels;
    SONG_META[song.key] = { bpm: result.analysis.bpm, levels };
    updateLibraryMeta(song.key, result.analysis.bpm, levels);
    renderLibrary();

    setAnalyze(100, '完成', `BPM ${result.analysis.bpm} · 分析耗时 ${result.ms.analysis} ms`);
    await new Promise((r) => setTimeout(r, 300));
    $('analyze-overlay').classList.remove('on');
    showReady();
  } catch (err) {
    console.error(err);
    $('analyze-overlay').classList.remove('on');
    toast('这个文件解码失败了，换一个音频试试');
  }
}

/** 单声道混合（用于丢进 worker） */
function mixdown(buffer) {
  const len = buffer.length;
  const n = buffer.numberOfChannels;
  if (n === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(len);
  const chans = [];
  for (let c = 0; c < n; c++) chans.push(buffer.getChannelData(c));
  for (const ch of chans) for (let i = 0; i < len; i++) out[i] += ch[i];
  const g = 1 / n;
  for (let i = 0; i < len; i++) out[i] *= g;
  return out;
}

const STEPS = ['听辨节拍与鼓点…', '切分鼓点…', '估算 BPM…', '编排三档难度…'];

/** 优先在 Worker 里分析（不卡界面），失败则退回主线程 */
function runAnalysis(buffer, onProgress) {
  return new Promise((resolve, reject) => {
    const mono = mixdown(buffer);
    let done = false;
    let fake = 22;
    let si = 0;
    const timer = setInterval(() => {
      si = Math.min(STEPS.length - 1, Math.floor((fake - 22) / 17));
      fake = Math.min(89, fake + 1.2 + Math.random() * 2.2);
      onProgress(fake, STEPS[si]);
    }, 190);

    const finish = (fn, payload) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      fn(payload);
    };

    const inline = () => {
      try {
        const t0 = performance.now();
        const analysis = analyzeAudio(mono, buffer.sampleRate);
        const charts = generateAll(analysis);
        const ms = { analysis: Math.round(performance.now() - t0), charts: 0 };
        const { energyAt, beatAt, ...plain } = analysis;
        void energyAt;
        void beatAt;
        finish(resolve, { analysis: plain, charts, ms });
      } catch (err) {
        finish(reject, err);
      }
    };

    let worker;
    try {
      worker = new Worker('./js/analyze.worker.js', { type: 'module' });
    } catch {
      inline();
      return;
    }
    worker.onmessage = (e) => {
      const d = e.data;
      worker.terminate();
      if (d && d.ok) finish(resolve, d);
      else inline();
    };
    worker.onerror = () => {
      worker.terminate();
      inline();
    };
    worker.postMessage({ samples: mono, sampleRate: buffer.sampleRate }, [mono.buffer]);
  });
}

function setAnalyze(pct, step, meta) {
  $('an-fill').style.width = `${Math.max(4, Math.min(100, pct))}%`;
  if (step) $('an-step').textContent = step;
  if (meta != null) $('an-meta').textContent = meta;
}

/** 同一首歌第二次进入时直接用缓存，不用重新分析 */
function restoreCache() {
  const c = state.cache;
  state.buffer = c.buffer;
  state.analysis = c.analysis;
  state.charts = c.charts;
  state.analyzeMs = c.ms;
  showReady();
}

/* ============================ 曲库 / 记录 数据 ============================ */
const LIBRARY_SEED = [
  {
    key: 'demo-spectra',
    title: 'Spectra Loop',
    artist: '程序合成 · CC0',
    cover: 'assets/demo/spectra-demo.jpg',
    audio: 'assets/demo/spectra-demo.mp3',
    source: '内置示例 · 128 BPM',
    builtin: true,
    bpm: 128,
    levels: [4, 8, 12],
  },
  {
    key: 'demo-tenfold',
    title: '十重告别',
    artist: '雨狸 / DELA_P / 崩坏Sovietsy',
    cover: 'assets/demo/cover.jpg',
    audio: 'assets/demo/tenfold.mp3',
    source: 'B站 · BV1k3S7BkEag',
    bvid: 'BV1k3S7BkEag',
    builtin: true,
    bpm: 130,
    levels: [4, 7, 12],
  },
  {
    key: 'demo-worldexec',
    title: 'world.execute(me)',
    artist: 'Mili / 西西弗斯的风车',
    cover: 'assets/demo/worldexec-cover.jpg',
    audio: 'assets/demo/worldexec.mp3',
    source: 'B站 · BV1xCai6aE9g',
    bvid: 'BV1xCai6aE9g',
    builtin: true,
    bpm: 130,
    levels: [4, 7, 13],
  },
];
const LIB_KEY = 'spectra.biliSongs';
const REC_KEY = 'spectra.records';

const SONG_META = {}; // key -> { bpm, levels }，本次会话内缓存

const rankClass = (rank) => {
  if (rank === 'SSS' || rank === 'SS' || rank === 'S') return 'rk-top';
  if (rank === 'AAA' || rank === 'AA' || rank === 'A') return 'rk-high';
  if (rank === 'B+' || rank === 'B') return 'rk-mid';
  return 'rk-low';
};
const DIFF_SHORT = { easy: 'EZ', normal: 'NM', hard: 'HD' };

function getLibrary() {
  let extra = [];
  let override = {};
  try {
    extra = JSON.parse(localStorage.getItem(LIB_KEY) || '[]');
    override = JSON.parse(localStorage.getItem('spectra.audioOverride') || '{}');
  } catch {
    extra = [];
  }
  const seen = new Set();
  return [...LIBRARY_SEED, ...extra]
    .filter((s) => {
      if (seen.has(s.key)) return false;
      seen.add(s.key);
      return true;
    })
    .map((s) => (override[s.key] ? { ...s, audio: override[s.key] } : s));
}

/** 记住某首歌实际可用的音频地址（仓库里没带音频时用得到） */
function setAudioOverride(key, audio, cover) {
  try {
    const ov = JSON.parse(localStorage.getItem('spectra.audioOverride') || '{}');
    ov[key] = audio;
    localStorage.setItem('spectra.audioOverride', JSON.stringify(ov));
    if (cover) {
      const c = JSON.parse(localStorage.getItem('spectra.coverOverride') || '{}');
      c[key] = cover;
      localStorage.setItem('spectra.coverOverride', JSON.stringify(c));
    }
  } catch {
    /* 忽略 */
  }
}

function addToLibrary(song) {
  if (LIBRARY_SEED.some((s) => s.key === song.key)) return;
  const extra = getLibrary().filter((s) => !s.builtin && s.key !== song.key);
  extra.unshift({
    key: song.key,
    title: song.title,
    artist: song.artist,
    cover: song.cover,
    audio: song.audio,
    source: song.source,
    bvid: song.bvid,
    addedAt: Date.now(),
  });
  localStorage.setItem(LIB_KEY, JSON.stringify(extra.slice(0, 12)));
}

function updateLibraryMeta(key, bpm, levels) {
  try {
    const extra = JSON.parse(localStorage.getItem(LIB_KEY) || '[]');
    let hit = false;
    for (const s of extra) {
      if (s.key === key) {
        s.bpm = bpm;
        s.levels = levels;
        hit = true;
      }
    }
    if (hit) localStorage.setItem(LIB_KEY, JSON.stringify(extra));
  } catch {
    /* 忽略 */
  }
}

function removeFromLibrary(key) {
  const extra = getLibrary().filter((s) => !s.builtin && s.key !== key);
  localStorage.setItem(LIB_KEY, JSON.stringify(extra));
}

function getRecords() {
  try {
    return JSON.parse(localStorage.getItem(REC_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeRecord(song, chart, res) {
  const all = getRecords();
  const rec = all[song.key] || { key: song.key, plays: 0, best: {} };
  rec.title = song.title;
  rec.artist = song.artist;
  rec.cover = song.cover;
  rec.plays = (rec.plays || 0) + 1;
  rec.last = Date.now();
  const prev = rec.best[chart.id];
  const better = !prev || res.score > prev.score;
  if (better) {
    rec.best[chart.id] = {
      score: res.score,
      rank: rankOf(res.score)[0],
      acc: res.acc,
      maxCombo: res.maxCombo,
      level: chart.level,
      at: Date.now(),
    };
  }
  all[song.key] = rec;
  localStorage.setItem(REC_KEY, JSON.stringify(all));
  return { prev, better };
}

/* ============================ 载入 ============================ */
async function loadSong(song) {
  if (!song) return;
  if (state.view === 'ready') return;
  state.song = song;
  if (state.cache && state.cache.key === song.key) {
    restoreCache();
    return;
  }
  try {
    $('analyze-overlay').classList.add('on');
    setAnalyze(3, '读取音频…', song.title);
    const res = await fetch(song.audio);
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status);
      e.status = res.status;
      throw e;
    }
    const buf = await res.arrayBuffer();
    setAudioOverride(song.key, song.audio, song.cover);
    await loadAudioBuffer(buf, song);
  } catch (err) {
    console.error(err);
    $('analyze-overlay').classList.remove('on');
    // 仓库里没带版权音频时：按 bvid 让本地服务抓一次
    if (err.status === 404 && song.bvid && !staticMode) {
      toast('本地没有这首的音轨，正在从 B 站补抓…');
      setBiliBusy(false, '正在补抓音轨：' + song.title);
      await resolveBili(song.bvid);
      return;
    }
    toast(
      isNetworkError(err)
        ? '连不上本地服务：请确认 python tools/serve.py 8777 还在运行'
        : '音频加载失败（' + (err.message || '未知错误') + '）'
    );
  }
}

async function loadFile(file) {
  if (!file) return;
  if (!/^audio\//.test(file.type) && !/\.(mp3|wav|m4a|ogg|flac|aac|opus|webm)$/i.test(file.name)) {
    toast('请选择音频文件（MP3 / WAV / M4A / OGG / FLAC）');
    return;
  }
  if (file.size > 60 * 1024 * 1024) {
    toast('文件太大了（>60MB），建议压缩后再试');
    return;
  }
  const title = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').slice(0, 48);
  const song = {
    key: 'file-' + file.name + '-' + file.size,
    title: title || '未命名音频',
    artist: '本地文件 · ' + (file.size / 1048576).toFixed(1) + ' MB',
    cover: placeholderCover(title),
    source: '本地上传',
  };
  state.song = song;
  if (state.cache && state.cache.key === song.key) {
    restoreCache();
    return;
  }
  $('analyze-overlay').classList.add('on');
  setAnalyze(4, '读取文件…', file.name);
  await nextFrame();
  const buf = await file.arrayBuffer();
  await loadAudioBuffer(buf, song);
}

/* ============================ B 站链接解析 ============================ */
let apiOK = null;
let staticMode = false;
const missingAudio = new Set();
const OFFLINE_TIP = '本地服务未连接：请在 beatforge 目录运行 python tools/serve.py 8777（B站提取依赖它）';

async function checkApi() {
  const dot = $('api-dot');
  let ok = false;
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) {
      const d = await r.json();
      ok = !!d.ok;
    }
  } catch {
    ok = false;
  }
  apiOK = ok;
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  // 部署在 GitHub Pages 之类的静态环境：没有 /api，属于正常情况而不是故障
  staticMode = new URLSearchParams(location.search).has('static') || (!ok && !isLocal);

  if (staticMode) {
    applyStaticMode();
    pruneLibrary();
  } else if (!ok) {
    if (dot) dot.classList.add('off');
    if ($('bili-tip').textContent.indexOf('本地服务未连接') < 0) {
      $('bili-tip').textContent = OFFLINE_TIP;
      $('bili-tip').classList.add('err');
    }
  } else if (dot) {
    dot.classList.remove('off');
  }
  return ok;
}

/** 静态部署：把 B 站输入换成说明，曲库里没有音轨的条目自动隐藏 */
function applyStaticMode() {
  const box = $('bili-box');
  if (box && !box.dataset.adapted) {
    box.dataset.adapted = '1';
    box.innerHTML =
      '<div class="bili-head"><span class="bili-badge">静态版</span><span>B 站提取需要本地服务</span></div>' +
      '<div class="bili-tip" id="bili-tip">这个版本部署在 GitHub Pages 上，只能使用内置曲和本地上传。' +
      '想粘贴 B 站链接，把仓库 clone 下来运行 <b>python tools/serve.py 8777</b>。</div>';
  }
}

async function pruneLibrary() {
  const lib = getLibrary();
  const flags = await Promise.all(
    lib.map(async (s) => {
      try {
        const r = await fetch(s.audio, { method: 'HEAD' });
        return r.ok;
      } catch {
        return false;
      }
    })
  );
  lib.forEach((s, i) => {
    if (!flags[i]) missingAudio.add(s.key);
  });
  renderLibrary();
}

function isNetworkError(err) {
  return err && (err.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed/i.test(String(err.message)));
}

function setBiliBusy(busy, text, isErr) {
  const btn = $('bili-go');
  const tip = $('bili-tip');
  if (!btn || !tip) return;
  btn.disabled = busy;
  btn.textContent = busy ? '解析中' : '提取';
  if (text) {
    tip.textContent = text;
    tip.classList.toggle('err', !!isErr);
  } else {
    tip.textContent = '支持完整链接 / BV 号 / b23.tv 短链，音轨会缓存到本地';
    tip.classList.remove('err');
  }
}

async function resolveBili(raw) {
  const url = (raw || '').trim();
  if (!url) {
    toast('先粘贴一个 B 站链接');
    return;
  }
  if (!/bilibili\.com|b23\.tv|^BV[0-9A-Za-z]{10}$/i.test(url)) {
    setBiliBusy(false, '看起来不是 B 站链接，需要 bilibili.com/video/BV… 或 BV 号', true);
    return;
  }
  if (apiOK === false) await checkApi();
  if (apiOK === false) {
    $('bili-tip').textContent = OFFLINE_TIP;
    $('bili-tip').classList.add('err');
    toast('本地服务未连接，B站提取不可用');
    return;
  }
  setBiliBusy(true, '正在解析视频并下载音轨，首次约需几秒…');
  try {
    const res = await fetch('/api/bili/resolve?url=' + encodeURIComponent(url));
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('B 站接口不可用，请用 tools/serve.py 启动服务');
    }
    if (!data.ok) throw new Error(data.error || '解析失败');
    const cleanTitle = String(data.title || data.bvid).replace(/^【[^】]{1,8}】\s*/, '').slice(0, 60);
    const exist = getLibrary().find((s) => s.bvid === data.bvid);
    const song = exist
      ? { ...exist, audio: data.audio || exist.audio, cover: data.cover || exist.cover }
      : {
      key: 'bili-' + data.bvid,
      title: cleanTitle,
      artist: data.owner || 'B站视频',
      cover: data.cover || placeholderCover(cleanTitle),
      audio: data.audio,
      source: 'B站 · ' + data.bvid,
      bvid: data.bvid,
    };
    if (!exist) addToLibrary(song);
    $('bili-url').value = '';
    setBiliBusy(false, (data.cached ? '已在缓存中：' : '提取完成：') + song.title);
    renderLibrary();
    await loadSong(song);
  } catch (err) {
    console.error(err);
    const msg = isNetworkError(err) ? OFFLINE_TIP : String(err.message || err);
    if (isNetworkError(err)) apiOK = false;
    setBiliBusy(false, msg, true);
    toast(isNetworkError(err) ? '连不上本地服务' : '提取失败：' + msg);
  }
}

/* ============================ 曲库 / 记录渲染 ============================ */
function bestOfSong(key) {
  const rec = getRecords()[key];
  if (!rec || !rec.best) return null;
  const ids = ['hard', 'normal', 'easy'].filter((id) => rec.best[id]);
  if (!ids.length) return null;
  ids.sort((a, b) => rec.best[b].score - rec.best[a].score);
  return { id: ids[0], ...rec.best[ids[0]] };
}

function renderLibrary() {
  const grid = $('song-grid');
  if (!grid) return;
  const lib = getLibrary().filter((s) => !missingAudio.has(s.key));
  $('lib-count').textContent = lib.length + ' 首';
  grid.innerHTML = lib
    .map((s) => {
      const best = bestOfSong(s.key);
      const info = SONG_META[s.key] || s;
      const meta = [];
      if (info.bpm) meta.push('BPM ' + info.bpm);
      if (info.levels) meta.push('Lv ' + info.levels.join(' / '));
      if (!info.bpm) meta.push(s.builtin ? '内置' : 'B站');
      const rank = best
        ? '<span class="st-rank ' + rankClass(best.rank) + '">' + DIFF_SHORT[best.id] + ' ' + best.rank + '</span>'
        : '';
      const del = s.builtin
        ? ''
        : '<button class="st-del" data-del="' + s.key + '" title="从曲库移除">✕</button>';
      return (
        '<button class="song-tile" data-key="' + s.key + '">' +
        '<div class="st-cover">' +
        '<img src="' + s.cover + '" alt="">' +
        rank +
        del +
        '<span class="st-play"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 5.5v13l11-6.5-11-6.5Z" fill="currentColor"/></svg></span>' +
        '</div>' +
        '<div class="st-body">' +
        '<div class="st-title">' + escapeHtml(s.title) + '</div>' +
        '<div class="st-artist">' + escapeHtml(s.artist || '') + '</div>' +
        '<div class="st-meta">' + meta.map((m) => '<span>' + escapeHtml(m) + '</span>').join('') + '</div>' +
        '</div></button>'
      );
    })
    .join('') +
    (staticMode ? '' : '<button class="song-tile add" data-add="1">' +
    '<span class="add-plus">+</span>' +
    '<span class="add-label">粘贴 B 站链接</span>' +
    '<span class="add-sub">自动提取音轨并生成谱面</span>' +
    '</button>');
  // 封面缺失（仓库里没带图）时用渐变占位
  grid.querySelectorAll('.st-cover img').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const tile = img.closest('.song-tile');
        const song = getLibrary().find((x) => x.key === tile.dataset.key);
        img.src = placeholderCover(song ? song.title : '?');
      },
      { once: true }
    );
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderRecords() {
  const box = $('record-list');
  if (!box) return;
  const all = Object.values(getRecords()).sort((a, b) => (b.last || 0) - (a.last || 0));
  if (!all.length) {
    box.innerHTML =
      '<div class="record-empty">还没有记录。<br>选一首歌打一局，成绩、评级和最大连击都会留在这里。</div>';
    return;
  }
  box.innerHTML = all
    .slice(0, 8)
    .map((r) => {
      const chips = ['easy', 'normal', 'hard']
        .map((id) => {
          const b = r.best && r.best[id];
          if (!b) return '<span class="rec-chip empty"><i>' + DIFF_SHORT[id] + '</i><b>—</b></span>';
          return (
            '<span class="rec-chip"><i>' + DIFF_SHORT[id] + '</i><b class="' + rankClass(b.rank) + '">' + b.rank +
            '</b><em>' + b.score.toLocaleString('en-US') + '</em></span>'
          );
        })
        .join('');
      const when = r.last ? new Date(r.last) : null;
      const whenStr = when
        ? when.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) +
          ' ' +
          when.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : '';
      return (
        '<div class="rec-row">' +
        '<img class="rec-cover" src="' + (r.cover || placeholderCover(r.title)) + '" alt="">' +
        '<div class="rec-main"><div class="rec-title">' + escapeHtml(r.title) + '</div>' +
        '<div class="rec-sub">' + (r.plays || 1) + ' 次游玩' + (whenStr ? ' · 最近 ' + whenStr : '') + '</div></div>' +
        '<div class="rec-bests">' + chips + '</div></div>'
      );
    })
    .join('');
}

/* ============================ 准备页 ============================ */
function showReady() {
  const s = state.song;
  const a = state.analysis;
  if (!s || !state.charts) return;

  $('ready-cover').src = s.cover || placeholderCover(s.title);
  $('ready-title').textContent = s.title;
  $('ready-artist').textContent = s.artist;
  $('ready-source').textContent = s.source;
  $('ready-blur').style.backgroundImage = `url("${s.cover || placeholderCover(s.title)}")`;

  const totalNotes = state.charts.reduce((m, c) => Math.max(m, c.noteCount), 0);
  $('ready-meta').innerHTML = [
    `<span>BPM <b>${a.bpm}</b></span>`,
    `<span>时长 <b>${fmtTime(a.duration)}</b></span>`,
    `<span>最多 <b>${totalNotes}</b> 音符</span>`,
    `<span>分析 <b>${state.analyzeMs} ms</b></span>`,
  ].join('');

  const list = $('diff-list');
  list.innerHTML = '';
  state.charts.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'diff-card';
    b.style.setProperty('--dc', c.color);
    b.dataset.id = c.id;
    b.innerHTML = `
      <div class="dc-lv">${c.level}</div>
      <div class="dc-main">
        <div class="dc-name">${c.name} · ${c.tag}</div>
        <div class="dc-sub">${c.noteCount} 音符 · ${c.nps} NPS · 最高 ${c.maxNps}/秒</div>
      </div>
      <div class="dc-chk">✓</div>`;
    b.onclick = () => selectDiff(c.id);
    list.appendChild(b);
  });

  $('opt-speed').value = settings.speed;
  $('val-speed').textContent = Number(settings.speed).toFixed(2) + '×';
  $('opt-offset').value = settings.offset;
  $('val-offset').textContent = settings.offset + ' ms';
  $('opt-bind').dataset.on = String(!!settings.bind);

  const defaultDiff = state.charts.find((c) => c.id === state.lastDiff) ? state.lastDiff : 'normal';
  selectDiff(defaultDiff);

  showScreen('ready');

  if (state.pendingAuto) {
    const want = state.pendingAuto === 'true' ? 'normal' : state.pendingAuto;
    selectDiff(state.charts.some((c) => c.id === want) ? want : 'normal');
    $('opt-auto').dataset.on = 'true';
    state.pendingAuto = null;
    if (state.sim) {
      state.seekTo = Number(state.sim) || 30;
      setTimeout(startGame, 260);
    }
  }
}

function selectDiff(id) {
  const c = state.charts.find((x) => x.id === id);
  if (!c) return;
  state.selected = c;
  state.lastDiff = id;
  document.querySelectorAll('.diff-card').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
  $('start-sub').textContent = `${c.name} · Lv.${c.level} · ${c.noteCount} 音符`;
}

/* ============================ 游玩 ============================ */
function startGame() {
  const chart = state.selected;
  if (!chart || !state.buffer) return;

  if (state.game) state.game.destroy();
  const game = new RhythmGame($('game-canvas'));
  state.game = game;
  const seek = state.seekTo;
  state.seekTo = null;

  game.init({
    audio,
    chart,
    songMeta: state.song,
    speed: settings.speed,
    offsetMs: settings.offset,
    bind: settings.bind,
    mirror: $('opt-mirror').dataset.on === 'true',
    auto: $('opt-auto').dataset.on === 'true',
    clock: state.sim ? 'perf' : 'audio',
    keys: settings.keys,
    onStats: updateHud,
    onCombo: (combo) => {
      const el = $('hud-combo');
      el.textContent = combo;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
      $('combo-display').classList.toggle('on', combo >= 3);
      $('hud-combo-txt').textContent = `COMBO ${combo}`;
    },
    onCountdown: (text) => {
      const el = $('countdown');
      el.innerHTML = `<span>${text}</span>`;
      el.classList.add('on');
      if (text === 'GO') setTimeout(() => el.classList.remove('on'), 520);
    },
    onFinish: finishGame,
  });

  $('hud-title').textContent = state.song.title;
  $('hud-diff').textContent = `${chart.name} · Lv.${chart.level} · BPM ${chart.bpm}`;
  $('hud-info').textContent = `SPEED ${Number(settings.speed).toFixed(2)}× · OFFSET ${settings.offset}ms`;
  $('hud-score').textContent = '0000000';
  $('hud-acc').textContent = '100.00%';
  $('hud-combo').textContent = '0';
  $('hud-just').textContent = '0';
  $('hud-rush').textContent = '0';
  $('hud-cool').textContent = '0';
  $('hud-miss').textContent = '0';
  $('hud-time').textContent = '0:00 / ' + fmtTime(audio.duration);
  $('combo-display').classList.remove('on');
  $('hud-progress').style.width = '0%';
  $('pause-overlay').classList.remove('on');
  $('countdown').classList.remove('on');

  showScreen('play');
  // 尺寸需要在切屏后再量一次
  requestAnimationFrame(() => {
    game.layout();
    game.start(seek != null ? seek : undefined);
    setTimeout(() => $('play-tip').style.opacity = '0', 5200);
  });
  $('play-tip').style.opacity = '1';
}

function updateHud(s) {
  $('hud-score').textContent = String(s.score).padStart(7, '0');
  $('hud-acc').textContent = (s.acc * 100).toFixed(2) + '%';
  if (s.combo < 3) $('combo-display').classList.remove('on');
  $('hud-progress').style.width = (s.progress * 100).toFixed(2) + '%';
  const st = s.stats;
  $('hud-just').textContent = st.just;
  $('hud-rush').textContent = st.rush;
  $('hud-cool').textContent = st.cool;
  $('hud-miss').textContent = st.miss;
  const dur = audio.duration || 1;
  $('hud-time').textContent = `${fmtTime(s.progress * dur)} / ${fmtTime(dur)}`;
}

const RANKS = [
  [1000000, 'SSS', 'PERFECT'],
  [950000, 'SS', 'EXCELLENT'],
  [900000, 'S', 'GREAT'],
  [800000, 'AAA', 'CLEAR'],
  [750000, 'AA', 'CLEAR'],
  [700000, 'A', 'CLEAR'],
  [650000, 'B+', 'CLEAR'],
  [600000, 'B', 'FAILED'],
  [500000, 'C', 'FAILED'],
  [0, 'D', 'FAILED'],
];

function rankOf(score) {
  for (const [th, letter, label] of RANKS) if (score >= th) return [letter, label];
  return ['D', 'FAILED'];
}

function finishGame(res) {
  const chart = res.chart;
  const score = res.score;
  const [letter, label] = rankOf(score);

  $('res-rank').textContent = letter;
  $('res-rank-caption').textContent = label;
  $('res-title').textContent = state.song.title;
  $('res-diff').textContent = `${chart.name} · Lv.${chart.level} · ${chart.bpm} BPM`;
  $('res-score').textContent = score.toLocaleString('en-US');
  $('res-acc').textContent = (res.acc * 100).toFixed(2) + '%';
  $('res-combo').textContent = res.maxCombo;
  $('res-notes').textContent = res.noteCount;
  $('res-level').textContent = 'Lv.' + chart.level;
  $('res-just').textContent = res.stats.just;
  $('res-rush').textContent = res.stats.rush;
  $('res-cool').textContent = res.stats.cool;
  $('res-miss').textContent = res.stats.miss;

  const rec = writeRecord(state.song, chart, { score, acc: res.acc, maxCombo: res.maxCombo });
  $('res-newrecord').classList.toggle('on', rec.better && !!rec.prev && score > 100000);
  $('result-blur').style.backgroundImage = `url("${state.song.cover || placeholderCover(state.song.title)}")`;
  renderLibrary();
  renderRecords();

  showScreen('result');

  const ring = $('rank-ring');
  const target = Math.max(4, Math.min(100, (score / 1000000) * 100));
  const t0 = performance.now();
  const step = (t) => {
    const k2 = Math.min(1, (t - t0) / 900);
    const eased = 1 - Math.pow(1 - k2, 3);
    ring.style.setProperty('--p', (target * eased).toFixed(2));
    if (k2 < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ============================ 暂停 ============================ */
function togglePause(force) {
  const g = state.game;
  if (!g || !g.running || g.finished) return;
  const shouldPause = force != null ? force : !g.paused;
  if (shouldPause) {
    g.pause();
    const s = g.snapshot();
    $('pause-stats').innerHTML =
      `SCORE ${String(s.score).padStart(7, '0')}<br>ACC ${(s.acc * 100).toFixed(2)}% · MAX COMBO ${s.maxCombo}`;
    $('pause-overlay').classList.add('on');
  } else {
    $('pause-overlay').classList.remove('on');
    g.resume();
  }
}

/* ============================ 输入 ============================ */
window.addEventListener('keydown', (e) => {
  const g = state.game;
  if (state.view === 'play' && g && g.running) {
    if (e.code === 'Escape') {
      e.preventDefault();
      togglePause();
      return;
    }
    if (e.code === 'Minus' || e.code === 'Equal') {
      if (settings.keys.includes(e.code)) {
        /* 被玩家绑成击打键就跳过 */
      } else {
        e.preventDefault();
        if (e.repeat) return;
        settings.speed = Math.round(clamp(settings.speed + (e.code === 'Equal' ? 0.05 : -0.05), 0.8, 3) * 100) / 100;
        persist();
        g.setSpeed(settings.speed);
        $('hud-info').textContent = `SPEED ${settings.speed.toFixed(2)}× · OFFSET ${settings.offset}ms`;
        toast(`下落速度 ${settings.speed.toFixed(2)}×（不影响音乐）`);
        return;
      }
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (e.repeat) return;
      g.spaceDown = true;
      g.lastSpaceTime = performance.now();
      return;
    }
    const lane = settings.keys.indexOf(e.code);
    if (lane >= 0) {
      e.preventDefault();
      if (e.repeat) return;
      g.pressLane(lane);
    }
  }
});

window.addEventListener('keyup', (e) => {
  const g = state.game;
  if (state.view === 'play' && g) {
    if (e.code === 'Space') {
      g.spaceDown = false;
      return;
    }
    const lane = settings.keys.indexOf(e.code);
    if (lane >= 0) g.releaseLane(lane);
  }
});

/* 触屏：点击轨道即击打 */
function bindTouch() {
  const canvas = $('game-canvas');
  const pointers = new Map();
  const laneFromEvent = (e) => {
    const g = state.game;
    if (!g) return -1;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const lane = Math.floor((x - g.fieldX) / g.laneW);
    if (lane < 0 || lane > 3) return -1;
    return lane;
  };
  canvas.addEventListener('pointerdown', (e) => {
    const g = state.game;
    if (!g || !g.running || g.paused) return;
    const lane = laneFromEvent(e);
    if (lane < 0) return;
    e.preventDefault();
    pointers.set(e.pointerId, lane);
    g.pressLane(lane);
  });
  const up = (e) => {
    const g = state.game;
    const lane = pointers.get(e.pointerId);
    if (g && lane != null) g.releaseLane(lane);
    pointers.delete(e.pointerId);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', up);
}

/* ============================ 事件绑定 ============================ */
function bindEvents() {
  // 曲库卡片（事件委托）
  $('song-grid').addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) {
      const box = $('bili-url');
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      box.focus();
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const key = del.dataset.del;
      removeFromLibrary(key);
      if (state.cache && state.cache.key === key) state.cache = null;
      renderLibrary();
      toast('已从曲库移除');
      return;
    }
    const tile = e.target.closest('.song-tile');
    if (!tile) return;
    const song = getLibrary().find((s) => s.key === tile.dataset.key);
    if (song) loadSong(song);
  });

  // B 站链接
  $('bili-go').addEventListener('click', () => resolveBili($('bili-url').value));
  $('bili-url').addEventListener('keydown', (e) => {
    if (e.code === 'Enter') {
      e.preventDefault();
      resolveBili(e.target.value);
    }
  });

  $('btn-clear-records').addEventListener('click', () => {
    if (!Object.keys(getRecords()).length) {
      toast('还没有记录可清空');
      return;
    }
    localStorage.removeItem(REC_KEY);
    renderRecords();
    renderLibrary();
    toast('记录已清空');
  });

  $('dropzone').addEventListener('click', () => $('file-input').click());
  $('dropzone').addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Space') {
      e.preventDefault();
      $('file-input').click();
    }
  });
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
    e.target.value = '';
  });

  // 拖拽
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('drag-veil').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drag-veil').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drag-veil').classList.remove('on');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  $('btn-ready-back').onclick = () => showScreen('home');
  $('btn-start').onclick = startGame;

  $('opt-speed').oninput = (e) => {
    settings.speed = Number(e.target.value);
    $('val-speed').textContent = settings.speed.toFixed(2) + '×';
    persist();
  };
  $('opt-offset').oninput = (e) => {
    settings.offset = Number(e.target.value);
    $('val-offset').textContent = settings.offset + ' ms';
    persist();
  };
  const toggle = (el, key, onChange) => {
    el.onclick = () => {
      const on = el.dataset.on !== 'true';
      el.dataset.on = String(on);
      if (key) {
        settings[key] = on;
        persist();
      }
      if (onChange) onChange(on);
    };
  };
  toggle($('opt-mirror'));
  toggle($('opt-bind'), 'bind');
  toggle($('opt-auto'));

  $('btn-pause').onclick = () => togglePause(true);
  $('btn-resume').onclick = () => togglePause(false);
  $('btn-restart').onclick = () => {
    $('pause-overlay').classList.remove('on');
    startGame();
  };
  $('btn-quit').onclick = () => {
    $('pause-overlay').classList.remove('on');
    if (state.game) {
      state.game.destroy();
      state.game = null;
    }
    showReady();
  };

  $('btn-retry').onclick = () => startGame();
  $('btn-change').onclick = () => showReady();
  $('btn-home').onclick = () => showScreen('home');
  $('brand-home').onclick = (e) => {
    e.preventDefault();
    if (state.view === 'play') return;
    showScreen('home');
  };

  $('btn-settings').onclick = () => openModal('settings-modal');
  $('settings-close').onclick = () => closeModal('settings-modal');
  $('btn-help').onclick = () => openModal('help-modal');
  $('help-close').onclick = () => closeModal('help-modal');
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.remove('on');
    });
  });

  $('set-music').oninput = (e) => {
    settings.music = Number(e.target.value) / 100;
    audio.setMusicVolume(settings.music);
    $('set-music-v').textContent = e.target.value;
    persist();
  };
  $('set-sfx').oninput = (e) => {
    settings.sfx = Number(e.target.value) / 100;
    audio.setSfxVolume(settings.sfx);
    $('set-sfx-v').textContent = e.target.value;
    persist();
  };
  $('set-bind').onclick = (e) => {
    const on = e.currentTarget.dataset.on !== 'true';
    e.currentTarget.dataset.on = String(on);
    settings.bind = on;
    $('opt-bind').dataset.on = String(on);
    persist();
  };

  bindTouch();
}

/* ============================ 启动 ============================ */
function boot() {
  applyTheme(settings.theme);
  buildSettingsUI();
  renderLibrary();
  renderRecords();
  bindEvents();
  const params = new URLSearchParams(location.search);
  state.sim = params.get('sim');
  if (params.has('autoplay')) {
    const v = params.get('autoplay');
    state.pendingAuto = v && v !== '1' ? v : 'normal';
  }
  checkApi();
  if (params.has('bili')) {
    resolveBili(params.get('bili'));
  } else if (params.has('song')) {
    const s = getLibrary().find((x) => x.key === params.get('song'));
    if (s) loadSong(s);
  } else if (params.has('demo') || state.pendingAuto) {
    loadSong(getLibrary()[0]);
  }
  window.SPECTRA = {
    state,
    settings,
    getLibrary,
    loadSong,
    loadFile,
    resolveBili,
    startGame,
    audio,
    renderLibrary,
    renderRecords,
  };
}

boot();
