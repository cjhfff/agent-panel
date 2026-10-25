#!/usr/bin/env node
// 无头界面测试：用本机已安装的 Edge / Chrome（--headless，不开窗口、不装任何东西）按脚本操作网页并检查结果。
// 用法：
//   node <面板目录>/tools/ui-check.mjs --root <项目目录> [--page index.html] --steps <steps.json> [--out <result.json>] [--shot <截图.png>]
//   node <面板目录>/tools/ui-check.mjs --url http://127.0.0.1:8080/ --steps <steps.json>
// steps.json 是数组，每步一个对象：
//   {"do":"click","selector":"#c-0-0"}                       点击元素中心
//   {"do":"dblclick","selector":"#c-0-0"}
//   {"do":"type","text":"=SUM(A1:A2)"}                        逐字键入（会触发 keydown/keypress/input）
//   {"do":"key","key":"Enter"} / {"do":"key","key":"z","mods":["ctrl"]}   Enter Tab Escape Delete Backspace F2 ArrowUp/Down/Left/Right Home End，字母数字
//   {"do":"expect","js":"document.querySelector('#c-2-0').textContent","equals":"60"}   也可用 contains / matches(正则字符串) / truthy:true
//   {"do":"eval","js":"localStorage.clear()"}
//   {"do":"wait","ms":300}
//   {"do":"reload"}
//   {"do":"shot","path":"after.png"}
// 输出 JSON：{"pass":true/false,"steps":[...每步结果],"consoleErrors":[...],"screenshot":"..."}，退出码 0=全过 1=有失败 2=工具出错
// 注意：不要测系统剪贴板（headless 下不可靠也不应碰），复制粘贴请用页面内 paste 事件或直接调用代码接口验证。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const fail = (msg, code = 2) => { console.error('ui-check: ' + msg); process.exit(code); };
if (!args.steps) fail('缺少 --steps <steps.json>');
const steps = JSON.parse(fs.readFileSync(args.steps, 'utf8').replace(/^\uFEFF/, ''));
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const exe = BROWSERS.find(f => fs.existsSync(f));
if (!exe) fail('本机没找到已安装的 Edge / Chrome（本工具不会下载浏览器）');

// 静态文件服务
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
async function serve(root) {
  root = path.resolve(root);
  const srv = http.createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
    const f = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
    fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(b); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return srv;
}

const KEYS = { Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], F2: [113, 'F2'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], ' ': [32, 'Space', ' '] };
const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

let srv, child, tmp, ws;
async function main() {
  let url = args.url;
  if (!url) { if (!args.root) fail('需要 --root 或 --url'); srv = await serve(args.root); url = `http://127.0.0.1:${srv.address().port}/${args.page || ''}`; }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-'));
  child = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    `--user-data-dir=${tmp}`, '--remote-debugging-port=0', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let port;
  for (let i = 0; i < 100 && !port; i++) { await sleep(100); try { port = fs.readFileSync(path.join(tmp, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {} }
  if (!port) throw new Error('浏览器没有启动调试端口');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0; const pending = new Map(), consoleErrors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { ok, bad } = pending.get(m.id); pending.delete(m.id); m.error ? bad(new Error(m.error.message)) : ok(m.result); }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description) || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text);
  };
  const send = (method, params = {}) => new Promise((ok, bad) => { const i = ++id; pending.set(i, { ok, bad }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async js => { const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text); return r.result.value; };
  const load = async () => { await sleep(150); for (let i = 0; i < 100; i++) { if (await evaluate('document.readyState').catch(() => '') === 'complete') return; await sleep(100); } };
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
  await send('Page.navigate', { url }); await load(); await sleep(300);
  const center = async sel => { const r = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`); if (!r) throw new Error('找不到元素 ' + sel); return r; };
  const mouse = async (sel, count) => { const { x, y } = await center(sel); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); for (let c = 1; c <= count; c++) { await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: c }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: c }); } };
  const key = async (k, mods = []) => {
    const m = mods.reduce((a, x) => a | (MODS[x] || 0), 0);
    let [vk, code, text] = KEYS[k] || [];
    if (!vk) { const ch = k.length === 1 ? k : ''; vk = ch.toUpperCase().charCodeAt(0); code = /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /\d/.test(ch) ? 'Digit' + ch : ''; text = m & 2 || m & 4 ? '' : ch; }
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: m, text: text || undefined, unmodifiedText: text || undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: m });
  };
  const results = []; let shot = null;
  for (const [i, st] of steps.entries()) {
    const r = { i, do: st.do, note: st.note || '', ok: true };
    try {
      if (st.do === 'click') await mouse(st.selector, 1);
      else if (st.do === 'dblclick') await mouse(st.selector, 2);
      else if (st.do === 'type') { for (const ch of String(st.text)) { if (KEYS[ch]) await key(ch); else await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }), await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); } }
      else if (st.do === 'key') await key(st.key, st.mods || []);
      else if (st.do === 'wait') await sleep(st.ms || 300);
      else if (st.do === 'reload') { await send('Page.reload'); await load(); await sleep(300); }
      else if (st.do === 'eval') r.got = await evaluate(st.js);
      else if (st.do === 'expect') {
        const got = await evaluate(st.js); r.got = got;
        if ('equals' in st) r.ok = String(got) === String(st.equals);
        else if ('contains' in st) r.ok = String(got).includes(st.contains);
        else if ('matches' in st) r.ok = new RegExp(st.matches).test(String(got));
        else if ('truthy' in st) r.ok = !!got === !!st.truthy;
        if (!r.ok) r.expected = st.equals ?? st.contains ?? st.matches ?? st.truthy;
      } else if (st.do === 'shot') { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(st.path, Buffer.from(s.data, 'base64')); r.got = st.path; }
      else throw new Error('未知步骤 ' + st.do);
      if (st.do !== 'expect' && st.do !== 'wait') await sleep(st.after ?? 60);
    } catch (e) { r.ok = false; r.error = e.message; }
    results.push(r);
  }
  if (args.shot) { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(args.shot, Buffer.from(s.data, 'base64')); shot = args.shot; }
  const out = { pass: results.every(r => r.ok) && consoleErrors.length === 0, url, browser: path.basename(exe), steps: results, consoleErrors, screenshot: shot };
  const json = JSON.stringify(out, null, 2);
  if (args.out) fs.writeFileSync(args.out, json);
  console.log(json);
  return out.pass ? 0 : 1;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function cleanup() {
  try { ws && ws.close(); } catch {}
  try { srv && srv.close(); } catch {}
  if (child && child.exitCode === null) {
    const gone = new Promise(r => child.once('exit', r));
    // 浏览器会拉起一串子进程，要整棵进程树一起结束
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else try { child.kill(); } catch {}
    await Promise.race([gone, sleep(3000)]);
    await sleep(500);
  }
  // 浏览器子进程可能还占着临时配置目录，重试几次再删
  for (let i = 0; i < 10 && tmp && fs.existsSync(tmp); i++) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { await sleep(300); } }
}
main().then(async code => { await cleanup(); process.exit(code); }, async e => { console.error('ui-check 出错：' + e.message); await cleanup(); process.exit(2); });
