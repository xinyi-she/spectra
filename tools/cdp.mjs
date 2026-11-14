/**
 * 极简 CDP 驱动：用本机 Edge/Chrome 加载页面、执行 JS、抓控制台、截图。
 * 用法：
 *   node tools/cdp.mjs nav <url>                     只导航并打印控制台
 *   node tools/cdp.mjs eval <url> <file.js>          在页面里执行文件内容
 *   node tools/cdp.mjs shot <url> <out.png> [waitMs] [jsFile]
 *   node tools/cdp.mjs script <url> <scenario.mjs>   自定义场景（页面里执行）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const PROFILE = path.resolve('tools/edge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* not ready */
    }
    await sleep(200);
  }
  throw new Error('CDP endpoint not ready');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.errors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || [])
          .map((a) => (a.value !== undefined ? a.value : a.description || a.type))
          .join(' ');
        this.logs.push(`[${msg.params.type}] ${text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(d.exception ? d.exception.description : d.text);
      }
      if (msg.method === 'Log.entryAdded') {
        this.logs.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('EVAL: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

const [, , mode, url, arg3, arg4, arg5] = process.argv;

const proc = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1440,900',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let cdp;
try {
  const page = await waitForEndpoint();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url });
  await sleep(600);

  if (mode === 'nav') {
    await sleep(Number(arg3) || 3000);
  } else if (mode === 'eval') {
    const code = fs.readFileSync(arg3, 'utf8');
    const v = await cdp.evaluate(code);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  } else if (mode === 'shot') {
    const out = arg3;
    const wait = Number(arg4) || 1500;
    await sleep(wait);
    if (arg5) {
      const code = fs.readFileSync(arg5, 'utf8');
      const v = await cdp.evaluate(code);
      if (v != null) console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    }
    await cdp.shot(out);
    console.log('saved ' + out);
  }
} catch (e) {
  console.error('DRIVER ERROR', e.message);
} finally {
  if (cdp) {
    if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));
    if (cdp.errors.length) console.log('--- page errors ---\n' + cdp.errors.join('\n'));
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  await sleep(300);
  process.exit(0);
}
