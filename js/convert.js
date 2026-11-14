/* =========================================================
   SPECTRA · B站转 MP3
   ========================================================= */
const $ = (id) => document.getElementById(id);
const HIST_KEY = 'spectra.convert.history';
const MAX_HISTORY = 40;

const els = {
  input: $('cv-input'),
  go: $('cv-go'),
  paste: $('cv-paste'),
  clear: $('cv-clear'),
  hint: $('cv-hint'),
  bar: $('cv-bar'),
  fill: $('cv-fill'),
  progressText: $('cv-progress-text'),
  list: $('cv-list'),
  empty: $('cv-empty'),
  bulk: $('cv-bulk'),
  summary: $('cv-summary'),
  all: $('cv-all'),
};

let apiOK = null;
let items = [];
let busy = false;

/* ---------------- 小工具 ---------------- */
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function fileName(d) {
  const raw = d.owner ? d.title + ' - ' + d.owner : d.title || d.bvid;
  const clean = String(raw)
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return (clean || d.bvid || 'audio') + '.' + (d.format || 'mp3');
}

function setHint(text, cls) {
  els.hint.textContent = text;
  els.hint.classList.remove('err', 'ok');
  if (cls) els.hint.classList.add(cls);
}

/* ---------------- 主题跟随主站 ---------------- */
(function applyTheme() {
  try {
    const s = JSON.parse(localStorage.getItem('spectra.settings') || '{}');
    if (s.theme) document.body.dataset.theme = s.theme;
  } catch {
    /* 忽略 */
  }
})();

/* ---------------- 历史 ---------------- */
function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    const done = items
      .filter((it) => it.state === 'done' && it.data)
      .slice(-MAX_HISTORY)
      .map((it) => ({ url: it.url, ...it.data, at: Date.now() }));
    const prev = loadHistory().filter((h) => !done.some((d) => d.bvid === h.bvid));
    localStorage.setItem(HIST_KEY, JSON.stringify([...done, ...prev].slice(0, MAX_HISTORY)));
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 服务检测 ---------------- */
function setHintHTML(html, cls) {
  els.hint.innerHTML = html;
  els.hint.classList.remove('err', 'ok');
  if (cls) els.hint.classList.add(cls);
}

const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);

async function checkApi() {
  let ok = false;
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (r.ok) ok = !!(await r.json()).ok;
  } catch {
    ok = false;
  }
  apiOK = ok;
  if (!ok) {
    els.go.disabled = true;
    if (isLocalHost) {
      // 本地但连不上：服务没起来
      setHintHTML(
        '本地服务没启动：双击 <b>启动.bat</b>，或在这个目录运行 <code>python tools/serve.py 8777</code>',
        'err'
      );
    } else {
      // 打开了线上版本：B 站解析不可能在这里工作
      setHintHTML(
        '你现在打开的是线上版本（' +
          esc(location.hostname) +
          '），B 站解析必须在本地跑。' +
          '<a href="http://127.0.0.1:8777/convert.html">点我打开本地页面 →</a>',
        'err'
      );
    }
  }
  return ok;
}

/* ---------------- 渲染 ---------------- */
function metaLine(it) {
  const d = it.data || {};
  const parts = [];
  if (d.owner) parts.push(esc(d.owner));
  if (d.duration) parts.push(fmtTime(d.duration));
  if (it.state === 'done') {
    if (d.size) parts.push('<span class="size">' + fmtSize(d.size) + '</span>');
    parts.push((d.format || 'mp3').toUpperCase() + ' 192kbps');
  }
  if (it.state === 'error') {
    parts.push('<span class="err">' + esc(it.error || '解析失败') + '</span>');
  }
  if (it.state === 'loading') parts.push('正在下载音轨并转码，首次约几秒…');
  if (it.state === 'wait') parts.push(esc(shortUrl(it.url)));
  return parts.join('<span class="dot">·</span>');
}

function shortUrl(u) {
  return String(u || '').replace(/^https?:\/\//, '').slice(0, 46);
}

function itemHtml(it, i) {
  const d = it.data || {};
  const cover = d.cover
    ? '<img src="' + esc(d.cover) + '" alt="" loading="lazy">'
    : '<span class="ph">' + (d.bvid ? esc(d.bvid.slice(0, 6)) : 'BV') + '</span>';

  const title = d.title ? esc(d.title) : esc(shortUrl(it.url));

  let tag = '<span class="cv-tag wait">等待</span>';
  let actions = '';
  if (it.state === 'loading') {
    tag = '<span class="cv-tag loading">解析中</span>';
    actions = '<div class="cv-spin"></div>';
  } else if (it.state === 'done') {
    tag = d.cached
      ? '<span class="cv-tag cached">本地缓存</span>'
      : '<span class="cv-tag done">已转换</span>';
    actions =
      '<button class="cv-dl" data-act="dl" data-i="' + i + '">下载 ' + (d.format || 'mp3').toUpperCase() + '</button>' +
      (d.bvid ? '<button class="cv-play" data-act="play" data-i="' + i + '">打音游</button>' : '');
  } else if (it.state === 'error') {
    tag = '<span class="cv-tag error">失败</span>';
    actions = '<button class="cv-play" data-act="retry" data-i="' + i + '">重试</button>';
  }

  return (
    '<article class="cv-item" data-state="' + it.state + '">' +
    '<div class="cv-cover">' + cover + '</div>' +
    '<div class="cv-info">' +
    '<div class="cv-title">' + title + '</div>' +
    '<div class="cv-meta">' + metaLine(it) + '</div>' +
    '</div>' +
    '<div class="cv-actions">' + tag + actions + '</div>' +
    '</article>'
  );
}

function render() {
  els.list.innerHTML = items.map(itemHtml).join('');
  els.empty.hidden = items.length > 0;

  const done = items.filter((it) => it.state === 'done').length;
  const err = items.filter((it) => it.state === 'error').length;

  if (items.length) {
    els.bulk.hidden = done === 0;
    els.summary.textContent =
      '共 ' + items.length + ' 个任务 · 成功 ' + done + (err ? ' · 失败 ' + err : '');
    els.all.disabled = done < 2;
  } else {
    els.bulk.hidden = true;
  }
}

function updateProgress(done, total) {
  if (!total) {
    els.bar.hidden = true;
    return;
  }
  els.bar.hidden = false;
  els.fill.style.width = (done / total) * 100 + '%';
  els.progressText.textContent = done + ' / ' + total;
}

/* ---------------- 核心流程 ---------------- */
function splitUrls(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text).split(/[\s,，、]+/)) {
    const u = raw.trim();
    if (!u) continue;
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

async function resolveOne(it) {
  const r = await fetch('/api/bili/resolve?url=' + encodeURIComponent(it.url), { cache: 'no-store' });
  let d;
  try {
    d = await r.json();
  } catch {
    throw new Error('服务返回了非 JSON 内容（HTTP ' + r.status + '）');
  }
  if (!d.ok) throw new Error(d.error || '解析失败');
  return d;
}

async function run(explicitUrls) {
  if (busy) return;
  const urls = explicitUrls && explicitUrls.length ? explicitUrls : splitUrls(els.input.value);
  if (!urls.length) {
    setHint('先粘贴至少一个链接', 'err');
    els.input.focus();
    return;
  }

  if (apiOK === null && !(await checkApi())) return;
  if (apiOK === false) {
    await checkApi();
    return;
  }

  // 新链接入列；已在列表里的不重复添加（重试也走这里，靠 state 区分）
  for (const u of urls) {
    if (!items.some((it) => it.url === u)) {
      items.push({ url: u, state: 'wait', data: null, error: '' });
    }
  }

  const queue = items.filter((it) => it.state === 'wait');
  if (!queue.length) {
    setHint('已经在列表里了，直接点卡片上的「下载」即可', '');
    return;
  }

  busy = true;
  els.go.disabled = true;
  els.input.value = '';
  setHint('正在处理…');

  const total = queue.length;
  let done = 0;
  updateProgress(0, total);
  render();

  for (const it of queue) {
    it.state = 'loading';
    render();
    try {
      it.data = await resolveOne(it);
      it.state = 'done';
    } catch (e) {
      it.state = 'error';
      it.error = String(e.message || e);
    }
    done++;
    updateProgress(done, total);
    render();
  }

  saveHistory();
  busy = false;
  els.go.disabled = false;

  const okCount = queue.filter((it) => it.state === 'done').length;
  const failCount = total - okCount;
  setHint(
    failCount ? '完成 ' + okCount + ' 个，失败 ' + failCount + ' 个' : '完成 ' + okCount + ' 个，可以下载了',
    failCount ? 'err' : 'ok'
  );
}

/* ---------------- 下载 ---------------- */
async function download(i, btn) {
  const it = items[i];
  if (!it || !it.data) return;
  const d = it.data;
  const label = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '准备中…';
  }
  try {
    const r = await fetch(d.audio, { cache: 'no-cache' });
    if (!r.ok) {
      throw new Error(
        r.status === 404 ? '缓存文件不在了，点「重试」重新转换一次' : '下载失败（HTTP ' + r.status + '）'
      );
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName(d);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (btn) {
      btn.textContent = '已下载';
      setTimeout(() => {
        btn.textContent = label;
        btn.disabled = false;
      }, 1500);
    }
  } catch (e) {
    // 缓存文件被清理：把这条退回可重试状态，重新转换一次就好
    if (/缓存文件不在/.test(String(e.message || ''))) {
      it.state = 'error';
      it.error = '缓存已失效，点「重试」重新转换';
      render();
    }
    setHint(String(e.message || e), 'err');
    if (btn) {
      btn.textContent = '重试';
      btn.disabled = false;
      setTimeout(() => {
        btn.textContent = label;
      }, 1800);
    }
  }
}

async function downloadAll() {
  const idxs = items.map((it, i) => (it.state === 'done' ? i : -1)).filter((i) => i >= 0);
  if (!idxs.length) return;
  els.all.disabled = true;
  setHint('正在依次下载 ' + idxs.length + ' 个文件…');
  for (const i of idxs) {
    const btn = els.list.querySelector('[data-act="dl"][data-i="' + i + '"]');
    await download(i, btn);
    await sleep(700);
  }
  els.all.disabled = false;
  setHint('全部下载完成', 'ok');
}

/* ---------------- 事件 ---------------- */
els.go.addEventListener('click', run);

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  }
});

els.input.addEventListener('input', () => {
  if (els.hint.classList.contains('err') && apiOK !== false) setHint('支持完整链接 / BV 号 / b23.tv 短链');
});

els.paste.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      setHint('剪贴板是空的', 'err');
      return;
    }
    els.input.value = els.input.value ? els.input.value + '\n' + text : text;
    setHint('已粘贴，共 ' + splitUrls(els.input.value).length + ' 个链接', 'ok');
  } catch {
    setHint('浏览器不允许读取剪贴板，请手动粘贴（Ctrl+V）', 'err');
  }
});

els.clear.addEventListener('click', () => {
  els.input.value = '';
  items = [];
  render();
  updateProgress(0, 0);
  setHint('支持完整链接 / BV 号 / b23.tv 短链');
  els.input.focus();
});

els.list.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const i = Number(btn.dataset.i);
  const act = btn.dataset.act;
  if (act === 'dl') download(i, btn);
  else if (act === 'play') {
    const d = items[i] && items[i].data;
    if (d && d.bvid) location.href = './?bili=' + encodeURIComponent(d.bvid);
  } else if (act === 'retry') {
    const it = items[i];
    if (!it) return;
    it.state = 'wait';
    it.error = '';
    render();
    run([it.url]);
  }
});

els.all.addEventListener('click', downloadAll);

/* ---------------- 启动 ---------------- */
(function boot() {
  const hist = loadHistory();
  if (hist.length) {
    items = hist.map((h) => ({ url: h.url || h.bvid, state: 'done', data: h, error: '' }));
    render();
    setHint('已载入 ' + hist.length + ' 条历史记录，可直接重新下载');
  }
  render();
  checkApi();
})();
