#!/usr/bin/env node
// 派发由面板托管的开发任务；成功时 stdout 只打印任务 id，方便后续等待。
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const usage = `用法：node tools/devtask.mjs --title "任务标题" --agent codex --cwd <目录> --prompt-file <任务.md> [--effort low|medium|high|xhigh|ultra] [--model <模型>] [--url <面板地址>]
面板地址默认 http://127.0.0.1:4590，也可通过 PANEL_URL 设置。`;

async function main() {
  const { values } = parseArgs({ options: {
    title: { type: 'string' }, agent: { type: 'string' }, cwd: { type: 'string' },
    'prompt-file': { type: 'string' }, effort: { type: 'string' }, model: { type: 'string' },
    url: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  }, strict: true, allowPositionals: false });
  if (values.help) { console.log(usage); return; }
  for (const key of ['title', 'agent', 'cwd', 'prompt-file']) {
    if (!values[key]?.trim()) throw new Error(`缺少 --${key}；使用 --help 查看用法`);
  }
  if (values.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'ultra'].includes(values.effort)) {
    throw new Error('--effort 必须是 low / medium / high / xhigh / ultra');
  }
  if (values.model !== undefined && !values.model.trim()) throw new Error('--model 不能为空');
  let base;
  try { base = new URL(values.url ?? process.env.PANEL_URL ?? 'http://127.0.0.1:4590'); }
  catch { throw new Error('面板地址不是有效 URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('面板地址须为 http(s) URL，且不能包含凭据、查询参数或片段');
  }
  base.pathname = base.pathname.replace(/\/?$/, '/') + 'api/devtask';
  const prompt = (await fs.readFile(values['prompt-file'], 'utf8')).replace(/^\uFEFF/, '');
  if (!prompt.trim()) throw new Error('任务说明文件不能为空');
  const body = { title: values.title, agent: values.agent, cwd: path.resolve(values.cwd), prompt,
    ...(values.effort !== undefined ? { effort: values.effort } : {}),
    ...(values.model !== undefined ? { model: values.model } : {}),
  };
  let response;
  try { response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error('无法连接面板或请求超时，请检查面板地址和服务状态'); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`面板返回了非 JSON 响应（HTTP ${response.status}）`); }
  if (!response.ok) throw new Error(`派活失败（HTTP ${response.status}）：${typeof result?.error === 'string' ? result.error : '请求被拒绝'}`);
  if (typeof result?.id !== 'string' || !result.id) throw new Error('面板响应缺少任务 id');
  console.log(result.id);
}

main().catch(error => { console.error(`devtask: ${error.message}`); process.exitCode = 1; });
