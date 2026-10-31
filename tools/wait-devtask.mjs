#!/usr/bin/env node
// 每 15 秒查询面板任务，连接中断时重试；0=完成，1=其他终态或请求错误，2=超时/用法错误，3=疑似卡住且启用 --exit-on-stall。
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const usage = `用法：node tools/wait-devtask.mjs <id> [--timeout-min 240] [--url <面板地址>] [--exit-on-stall]
面板地址默认 http://127.0.0.1:4590，也可通过 PANEL_URL 设置。
检测到疑似卡住时默认警告并继续等待；--exit-on-stall 以退出码 3 结束等待。`;
const terminal = new Set(['finished', 'failed', 'cancelled', 'interrupted']);
const known = new Set(['queued', 'running', ...terminal]);
const timestamp = value => typeof value === 'number' ? value : Date.parse(value);

async function main() {
  let args;
  try {
    args = parseArgs({ options: { 'timeout-min': { type: 'string' }, url: { type: 'string' }, 'exit-on-stall': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: true });
  } catch (error) { console.error(`wait-devtask: ${error.message}`); process.exitCode = 2; return; }
  const { values, positionals } = args;
  if (values.help) { console.log(usage); return; }
  const timeoutMinutes = values['timeout-min'] === undefined ? 240 : Number(values['timeout-min']);
  if (positionals.length !== 1 || !positionals[0].trim() || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes * 60_000 > Number.MAX_SAFE_INTEGER) {
    console.error(`wait-devtask: 需要一个任务 id，--timeout-min 须为正数\n${usage}`); process.exitCode = 2; return;
  }
  let url;
  try { url = new URL(values.url ?? process.env.PANEL_URL ?? 'http://127.0.0.1:4590'); }
  catch { console.error('wait-devtask: 面板地址不是有效 URL'); process.exitCode = 2; return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    console.error('wait-devtask: 面板地址须为 http(s) URL，且不能包含凭据、查询参数或片段'); process.exitCode = 2; return;
  }
  url.pathname = url.pathname.replace(/\/?$/, '/') + 'api/devtask';
  url.searchParams.set('id', positionals[0]);
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let lastStallReason = null;
  while (Date.now() < deadline) {
    let response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(15_000, deadline - Date.now())))) }); }
    catch { console.error('wait-devtask: 暂时无法连接面板，将重试'); }
    if (response) {
      if (response.status >= 500) {
        console.error(`wait-devtask: 面板暂时不可用（HTTP ${response.status}），将重试`);
      } else {
        let task;
        try { task = await response.json(); }
        catch { throw new Error(`面板返回了非 JSON 响应（HTTP ${response.status}）`); }
        if (!response.ok) throw new Error(`查询失败（HTTP ${response.status}）：${typeof task?.error === 'string' ? task.error : '请求被拒绝'}`);
        if (!known.has(task?.status)) throw new Error('面板响应中的任务状态无效');
        if (terminal.has(task.status)) {
          const start = timestamp(task.startedAt), end = timestamp(task.endedAt);
          const duration = Number.isFinite(start) && Number.isFinite(end) ? `${Math.max(0, (end - start) / 1000).toFixed(1)} 秒` : '未开始';
          console.log(`status: ${task.status}\nexitCode: ${task.exitCode ?? 'null'}\nduration: ${duration}\nlastMessage:\n${String(task.lastMessage ?? '').slice(0, 2000)}`);
          process.exitCode = task.status === 'finished' ? 0 : 1; return;
        }
        if (task.stalled === true) {
          const reason = typeof task.stalledReason === 'string' && task.stalledReason.trim() ? task.stalledReason.trim() : '疑似卡住（面板未提供原因）';
          if (reason !== lastStallReason) console.error(`wait-devtask: 警告：${reason}`);
          lastStallReason = reason;
          if (values['exit-on-stall']) { process.exitCode = 3; return; }
        } else {
          lastStallReason = null;
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(15_000, remaining));
  }
  console.error(`wait-devtask: 等待超时（${timeoutMinutes} 分钟）`); process.exitCode = 2;
}

main().catch(error => { console.error(`wait-devtask: ${error.message}`); process.exitCode = 1; });
