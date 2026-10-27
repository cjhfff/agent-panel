// Agent 统筹面板 v2：Node 服务，可选 PTY 与本地 xterm.js 终端。
// - BMAD 的 sprint-status.yaml 是 Story 状态的唯一来源
// - 面板数据（leader、分配、阶段、运行记录）存在 <项目>/_bmad-output/panel/state.json
// - 每次运行的文件在 <项目>/_bmad-output/panel/runs/<runId>/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.PANEL_CONFIG ? path.resolve(process.env.PANEL_CONFIG) : path.join(HERE, 'panel.config.json');
const AGENTS_FILE = path.join(HERE, 'agents.json');
const UI_CHECK = path.join(HERE, 'tools', 'ui-check.mjs').replace(/\\/g, '/');
const SECRETS_FILE = path.join(HERE, 'secrets.env');
const PORT = Number(process.env.PORT || 4590);
const STATUSES = ['backlog', 'ready-for-dev', 'in-progress', 'review', 'done'];
const STAGES = ['prd', 'architecture', 'epics'];
const BMAD_VERSION = '6.12.4';

// ---------- 小工具 ----------
// agent 在 Windows 上常用 PowerShell 写文件：可能带 BOM，也可能是 UTF-16
const readJson = (f, d) => {
  try {
    const buf = fs.readFileSync(f);
    let txt = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
    txt = txt.replace(/^﻿/, '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    return JSON.parse(txt);
  } catch { return d; }
};
function isBrokenText(value) {
  if (typeof value !== 'string') return false;
  const compact = value.replace(/\s/gu, ''), questions = (compact.match(/\?/g) || []).length;
  return /\?{3,}/.test(value) || (questions > 0 && questions / Array.from(compact).length >= 0.2);
}
function hasBrokenEncoding(value) {
  if (typeof value === 'string') return isBrokenText(value);
  return !!value && typeof value === 'object' && Object.values(value).some(hasBrokenEncoding);
}
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
// Windows PowerShell 5.1 用 BOM 识别 UTF-8；面板读取 Markdown 时不保留 BOM。
const readMd = f => fs.readFileSync(f, 'utf8').replace(/^\uFEFF+/, '');
const writeMd = (f, text) => fs.writeFileSync(f, '\uFEFF' + text.replace(/^\uFEFF+/, ''), 'utf8');
const now = () => new Date().toISOString();
const bmadDate = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const exists = f => { try { fs.accessSync(f); return true; } catch { return false; } };
const isDir = f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } };
// Node 22's VT stripper can leave parts of OSC titles; remove control strings
// first, including an unfinished title in a live status preview.
const stripAnsi = s => stripVTControlCharacters(s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '').replace(/\x1b[P^_X][\s\S]*?(?:\x1b\\|$)/g, ''));
const slug = s => String(s).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

let config = Object.assign({ project: null, recent: [], projectsRoot: path.join(HERE, 'projects'), maxParallel: 1 }, readJson(CONFIG_FILE, {}));
const saveConfig = () => writeJson(CONFIG_FILE, config);
function useProject(dir) {
  config.project = path.resolve(dir);
  config.recent = [config.project, ...config.recent.filter(p => p !== config.project && exists(p))].slice(0, 12);
  saveConfig();
}

// ---------- agent 配置 / 认证与服务商 ----------
const PROVIDERS_FILE = path.join(HERE, 'providers.json');
const AUTH_HOME = process.env.USERPROFILE || process.env.HOME || '';
const BUILTIN_PROVIDERS = [
  ['anthropic', 'Anthropic 官方', 'anthropic', 'https://api.anthropic.com'],
  ['openai', 'OpenAI 官方', 'openai', 'https://api.openai.com/v1'],
  ['gemini', 'Google Gemini', 'gemini', 'https://generativelanguage.googleapis.com'],
  ['xai', 'xAI', 'xai', 'https://api.x.ai/v1'],
  ['deepseek', 'DeepSeek', 'openai', 'https://api.deepseek.com'],
].map(([id, name, type, baseUrl]) => ({ id, name, type, baseUrl, keyEnv: `PROVIDER_${id.toUpperCase()}_KEY`, models: [], modelsAt: null, enabled: true, builtin: true }));
const PROVIDER_TYPES = { claude: ['anthropic'], codex: ['openai'], gemini: ['gemini'], grok: ['openai', 'xai'], deepseek: [] };
function resolveCmd(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return exists(cmd) ? cmd : null;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) { const f = path.join(dir, cmd + ext); if (dir && exists(f) && fs.statSync(f).isFile()) return f; }
  }
  return null;
}
const readAgentsFile = () => readJson(AGENTS_FILE, { agents: [] });
const readProvidersFile = () => readJson(PROVIDERS_FILE, { providers: [] });
// Only inspect the active TOML provider. Other provider tables and project trust remain intact.
function tomlParts(text) {
  const parts = [{ header: '', lines: [] }];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*\[([^\r\n]+)\]\s*(?:#.*)?$/);
    if (m) parts.push({ header: m[1].trim(), lines: [] });
    else parts.at(-1).lines.push(line);
  }
  return parts;
}
function tomlValue(part, key) {
  const line = part?.lines.find(l => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (!line) return '';
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (value.startsWith('"')) { const m = value.match(/^"(?:\\.|[^"\\])*"/); if (m) { try { return JSON.parse(m[0]); } catch {} } }
  return (value.match(/^'([^']*)'/) || [])[1] || '';
}
const tableId = header => header.replace(/\.(?:"([^"\\]+)"|'([^']+)')/g, (_, a, b) => '.' + (a || b));
function legacyHome(a) {
  if (!a.homeConfig || !exists(path.join(HERE, a.homeConfig))) return null;
  const parts = tomlParts(fs.readFileSync(path.join(HERE, a.homeConfig), 'utf8'));
  const grok = a.id === 'grok';
  const active = grok ? tomlValue(parts.find(p => p.header === 'models'), 'default') : tomlValue(parts[0], 'model_provider');
  const section = parts.find(p => tableId(p.header) === `${grok ? 'model' : 'model_providers'}.${active}`);
  if (!section) return null;
  return { baseUrl: tomlValue(section, 'base_url'), envKey: tomlValue(section, 'env_key'), name: tomlValue(section, 'name') || a.name, model: tomlValue(grok ? section : parts[0], 'model') };
}
function homeModel(a) { return legacyHome(a)?.model || ''; }
function homeRelay(a) { return legacyHome(a); }
function ensureAuthData() {
  const first = !exists(PROVIDERS_FILE), file = first ? { providers: BUILTIN_PROVIDERS.map(p => ({ ...p })) } : readProvidersFile();
  const agents = readAgentsFile(); let changed = first, agentChanged = false;
  for (const a of agents.agents || []) {
    if (a.auth) continue;
    const old = legacyHome(a);
    if (old?.baseUrl && old.envKey) {
      let provider = file.providers.find(p => p.baseUrl === old.baseUrl && p.keyEnv === old.envKey);
      if (!provider) {
        const baseId = `legacy-${a.id}`; let id = baseId, n = 2;
        while (file.providers.some(p => p.id === id)) id = `${baseId}-${n++}`;
        provider = { id, name: old.name, type: 'openai', baseUrl: old.baseUrl, keyEnv: old.envKey, models: [], modelsAt: null, enabled: true, builtin: false };
        file.providers.push(provider); changed = true;
      }
      a.auth = { mode: 'provider', provider: provider.id, model: old.model || a.model || '' };
    } else a.auth = { mode: 'official', provider: '', model: a.model || '' };
    agentChanged = true;
  }
  if (changed) writeJson(PROVIDERS_FILE, file);
  if (agentChanged) writeJson(AGENTS_FILE, agents);
}
function authFor(a) {
  if (a.auth) return { mode: a.auth.mode, provider: a.auth.provider || '', model: a.auth.model || '' };
  const old = legacyHome(a), provider = old && readProvidersFile().providers.find(p => p.baseUrl === old.baseUrl && p.keyEnv === old.envKey);
  return { mode: a.homeConfig ? 'provider' : 'official', provider: provider?.id || '', model: a.homeConfig ? old?.model || '' : a.model || '' };
}
function loadAgents() {
  return (readAgentsFile().agents || []).map(a => {
    const resolved = resolveCmd(a.cmd), auth = authFor(a), provider = readProvidersFile().providers.find(p => p.id === auth.provider);
    let authError = '';
    try { validateProvider(a, auth); } catch (e) { authError = e.message; }
    return { ...a, auth, resolved, installed: !!resolved, available: !!resolved && a.enabled !== false && !authError, authError, effectiveModel: auth.model, relay: auth.mode === 'provider' ? provider?.name || '服务商未配置' : '官方账号' };
  });
}
function readEnvFile(name) {
  if (!name) return {};
  const f = path.resolve(HERE, name), out = {};
  if (!exists(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
function providerKey(p) { return readEnvFile('secrets.env')[p.keyEnv] || ''; }
function providerDetail(p) {
  const key = providerKey(p);
  return { id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, keyEnv: p.keyEnv, models: p.models || [], modelsAt: p.modelsAt || null, enabled: p.enabled !== false, builtin: !!p.builtin,
    keySet: !!key, keyMasked: key ? `已设置 · ****${key.slice(-4)}` : null, check: p.check || null };
}
function validateProvider(a, auth) {
  if (!['official', 'provider'].includes(auth.mode)) throw new Error('认证方式无效');
  if (auth.mode === 'official') return null;
  const p = readProvidersFile().providers.find(x => x.id === auth.provider);
  if (!p) throw new Error('服务商不存在');
  if (!(PROVIDER_TYPES[a.id] || []).includes(p.type)) throw new Error(a.id === 'deepseek' ? 'DeepSeek Harness 只支持自身配置' : `${a.name} 不兼容 ${p.type} 协议`);
  if (p.enabled === false) throw new Error('服务商已停用');
  if (['codex', 'grok'].includes(a.id) && !auth.model.trim()) throw new Error('请填写模型');
  return p;
}
function setTomlValues(part, values) {
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^\\s*${key}\\s*=`), line = `${key} = ${typeof value === 'boolean' ? value : JSON.stringify(value)}`;
    const index = part.lines.findIndex(l => re.test(l));
    if (index >= 0) { part.lines[index] = line; part.lines = part.lines.filter((l, i) => i === index || !re.test(l)); }
    else part.lines.unshift(line);
  }
}
function writeProviderConfig(a, p, model) {
  const grok = a.id === 'grok', dir = path.join(HERE, grok ? 'grok-home' : 'codex-home'), f = path.join(dir, 'config.toml');
  const parts = tomlParts(exists(f) ? fs.readFileSync(f, 'utf8') : ''), id = `panel_${p.id.replace(/-/g, '_')}`;
  let selected;
  if (grok) {
    selected = parts.find(x => x.header === 'models');
    if (!selected) { selected = { header: 'models', lines: [] }; parts.push(selected); }
  } else selected = parts[0];
  const old = tomlValue(selected, grok ? 'default' : 'model_provider');
  setTomlValues(selected, grok ? { default: id } : { model, model_provider: id });
  const prefix = grok ? 'model' : 'model_providers';
  const kept = parts.filter(x => ![`${prefix}.${old}`, `${prefix}.${id}`].includes(tableId(x.header)));
  kept.push({ header: `${prefix}.${id}`, lines: Object.entries(grok
    ? { model, name: p.name, base_url: p.baseUrl, api_backend: 'responses', env_key: p.keyEnv }
    : { name: p.name, base_url: p.baseUrl, wire_api: 'responses', env_key: p.keyEnv, requires_openai_auth: false })
    .map(([k, v]) => `${k} = ${typeof v === 'boolean' ? v : JSON.stringify(v)}`) });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, kept.map(x => (x.header ? `[${x.header}]\n` : '') + x.lines.join('\n').trimEnd()).join('\n\n').trim() + '\n', 'utf8');
}
const MANAGED_AUTH_ENV = ['CODEX_HOME', 'GROK_HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_GCA', 'GROK_API_KEY', 'XAI_API_KEY'];
function invocationEnv(a, perm = {}) {
  const sub = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, String(v).replaceAll('{here}', HERE)]));
  const env = { ...process.env, ...sub(a.env), ...sub(perm.env) };
  const managed = new Set([...MANAGED_AUTH_ENV, ...readProvidersFile().providers.map(p => p.keyEnv)].map(k => k.toUpperCase()));
  // Windows environment names are case-insensitive, including inherited names.
  for (const k of Object.keys(env)) if (managed.has(k.toUpperCase())) delete env[k];
  return env;
}
function buildInvocation(a, prompt, cwd) {
  const perm = (a.perm || {})[a.permission || 'max'] || {}, auth = authFor(a), p = validateProvider(a, auth);
  const args = [];
  for (const x of a.args) {
    if (x === '{perm}') args.push(...(perm.args || []));
    else args.push(x.replaceAll('{prompt}', prompt).replaceAll('{cwd}', cwd).replaceAll('{here}', HERE));
  }
  if (a.modelFlag && auth.model) args.push(a.modelFlag, auth.model);
  else if (['codex', 'grok'].includes(a.id) && auth.mode === 'official' && auth.model) args.push('-m', auth.model);
  const env = invocationEnv(a, perm);
  if (p) {
    const key = providerKey(p); if (!key) throw new Error('服务商尚未设置 API Key');
    env[p.keyEnv] = key;
    if (a.id === 'claude') {
      Object.assign(env, { ANTHROPIC_BASE_URL: p.baseUrl, ANTHROPIC_AUTH_TOKEN: key, CLAUDE_CONFIG_DIR: path.join(HERE, 'claude-home') });
      if (auth.model) env.ANTHROPIC_MODEL = auth.model;
      fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
      const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
      if (!exists(settings)) writeJson(settings, {});
    } else if (a.id === 'gemini') Object.assign(env, { GEMINI_API_KEY: key, GOOGLE_GEMINI_BASE_URL: p.baseUrl });
    else if (['codex', 'grok'].includes(a.id)) {
      writeProviderConfig(a, p, auth.model);
      env[a.id === 'codex' ? 'CODEX_HOME' : 'GROK_HOME'] = path.join(HERE, `${a.id}-home`);
    }
  }
  return { exe: a.resolved || resolveCmd(a.cmd), args, env, stream: a.stream || null };
}

// ---------- 项目路径 ----------
const P = root => {
  const panel = path.join(root, '_bmad-output', 'panel');
  return {
    root, panel,
    planning: path.join(root, '_bmad-output', 'planning-artifacts'),
    epics: path.join(root, '_bmad-output', 'planning-artifacts', 'epics.md'),
    sprint: path.join(root, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
    state: path.join(panel, 'state.json'),
    plan: path.join(panel, 'plan.json'),
    workflow: path.join(panel, 'workflow.json'),
    requirement: path.join(panel, 'requirement.md'),
    runs: path.join(panel, 'runs'),
  };
};
const RESULT_NAME = { triage: 'triage.json', plan: 'plan.json', review: 'review.json', implement: 'result.json', stage: 'stage.json', node: 'node.json', nodereview: 'review.json', tick: 'tick.json', task: 'result.json', test: 'result.json', setup: 'result.json' };
const runDir = (p, id) => path.join(p.runs, id);
const runFiles = (p, r) => { const d = runDir(p, r.id); return { dir: d, task: path.join(d, 'task.md'), log: path.join(d, 'run.log'), result: path.join(d, RESULT_NAME[r.kind] || 'result.json') }; };
function readAgentResult(p, run) {
  if (!run) return null;
  const result = readJson(runFiles(p, run).result, null);
  // Keep the original action fields; callers only replace damaged text when displaying it.
  if (hasBrokenEncoding(result)) run.encodingBroken = true;
  return result;
}

// ---------- BMAD 文档解析 ----------
function parseEpics(file) {
  if (!exists(file)) return { epics: [], stories: [] };
  const lines = readMd(file).split(/\r?\n/);
  const epics = [], stories = [];
  let cur = null, inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) { if (cur) cur.body.push(line); continue; }
    let m;
    if ((m = line.match(/^## Epic (\d+)[:：]\s*(.+)$/))) { epics.push({ n: +m[1], title: m[2].trim() }); cur = null; continue; }
    if ((m = line.match(/^### Story (\d+)\.(\d+)[:：]\s*(.+)$/))) { cur = { epic: +m[1], n: +m[2], title: m[3].trim(), body: [] }; stories.push(cur); continue; }
    if (/^#{1,3} /.test(line)) { cur = null; continue; }
    if (cur) cur.body.push(line);
  }
  return { epics, stories: stories.map(s => ({ ...s, body: s.body.join('\n').trim(), needsHuman: /L4|人工/.test(s.body.join('\n')) })) };
}
function readSprint(file) {
  const map = {}; if (!exists(file)) return map;
  let inDev = false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^development_status:/.test(line)) { inDev = true; continue; }
    if (inDev && /^\S/.test(line)) inDev = false;
    const m = inDev && line.match(/^\s+([^:#\s][^:]*):\s*(\S+)/);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  return map;
}
function writeSprintStatus(file, key, status) {
  let txt = fs.readFileSync(file, 'utf8');
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\s+${esc}:\\s*)\\S+`, 'm');
  if (!re.test(txt)) throw new Error(`sprint-status.yaml 里没有 ${key}`);
  txt = txt.replace(re, `$1${status}`).replace(/^last_updated:.*$/m, `last_updated: ${bmadDate()}`);
  fs.writeFileSync(file, txt);
}
function syncEpicStatus(p) {
  const st = readSprint(p.sprint);
  for (const ek of Object.keys(st).filter(k => /^epic-\d+$/.test(k))) {
    const n = ek.split('-')[1];
    const ss = Object.entries(st).filter(([k]) => k.startsWith(`${n}-`) && !k.includes('retrospective')).map(([, v]) => v);
    const want = ss.length && ss.every(v => v === 'done') ? 'done' : ss.some(v => v !== 'backlog') ? 'in-progress' : 'backlog';
    if (st[ek] !== want) writeSprintStatus(p.sprint, ek, want);
  }
}
function setStoryStatus(p, key, status) {
  if (!STATUSES.includes(status)) throw new Error(`非法状态 ${status}`);
  writeSprintStatus(p.sprint, key, status); syncEpicStatus(p);
}
function sprintScript(p) {
  for (const base of ['.claude', '.agents']) { const f = path.join(p.root, base, 'skills', 'bmad-sprint-planning', 'scripts', 'sprint_plan.py'); if (exists(f)) return f; }
  return null;
}
function refreshSprint(p) {
  return new Promise((ok, bad) => {
    const script = sprintScript(p);
    if (!script || !exists(p.epics)) return bad(new Error('缺少 epics.md 或 BMAD sprint 脚本'));
    fs.mkdirSync(path.dirname(p.sprint), { recursive: true });
    execFile('uv', ['run', script, 'generate', '--epic-file', p.epics, '--status-file', p.sprint, '--stories-dir', path.dirname(p.sprint), '--project', path.basename(p.root), '--date', bmadDate()],
      { cwd: p.root, env: { ...process.env, UV_NO_CACHE: '1' } }, (e, out, err) => e ? bad(new Error(err || e.message)) : ok(out));
  });
}

// ---------- 阶段（需求 → PRD → 架构 → Epic） ----------
function* walk(dir, skip = new Set()) {
  if (!isDir(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(f, skip); else yield f;
  }
}
function findStageDoc(p, stage) {
  const list = [...walk(p.planning, new Set(['panel']))];
  const newest = fs_ => fs_.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (stage === 'prd') return newest(list.filter(f => path.basename(f) === 'prd.md' || /prd.*\.md$/i.test(path.basename(f)) && !/validation|review|reconcile|addendum/i.test(f)));
  if (stage === 'architecture') return newest(list.filter(f => path.basename(f) === 'ARCHITECTURE-SPINE.md' || /architecture.*\.md$/i.test(path.basename(f))));
  if (stage === 'epics') return exists(p.epics) ? p.epics : null;
}
function stageInfo(p, st) {
  const out = {};
  for (const s of STAGES) {
    const rec = (st.stages || {})[s] || {};
    const doc = findStageDoc(p, s);
    const running = st.runs.find(r => r.kind === 'stage' && r.stage === s && ['queued', 'running'].includes(r.status));
    let status = rec.status || (doc ? 'approved' : 'todo');
    if (running) status = 'running';
    out[s] = { ...rec, status, doc: doc ? path.relative(p.root, doc).replace(/\\/g, '/') : null, runId: running ? running.id : rec.runId };
  }
  out.requirement = { text: exists(p.requirement) ? readMd(p.requirement) : '' };
  return out;
}

// ---------- 分配方案（key 归一化） ----------
function normalizePlan(p, plan) {
  if (!plan || !Array.isArray(plan.assignments)) return plan;
  const keys = Object.keys(readSprint(p.sprint)).filter(k => /^\d+-\d+-/.test(k));
  const full = k => {
    if (!k) return k;
    const t = String(k).trim().replace(/^story\s*/i, '');
    if (keys.includes(t)) return t;
    const m = t.match(/^(\d+)[.\-_](\d+)/);
    const f = m && keys.find(x => x.startsWith(`${m[1]}-${m[2]}-`));
    return f || t;
  };
  return { ...plan, assignments: plan.assignments.map(a => ({ ...a, key: full(a.key), depends_on: (a.depends_on || []).map(full) })) };
}
const readPlan = p => { const plan = readJson(p.plan, null); return normalizePlan(p, plan && hasBrokenEncoding(plan) ? { ...plan, encodingBroken: true } : plan); };

// ---------- 面板状态 ----------
const loadState = p => {
  const s = readJson(p.state, {});
  return { leader: null, assignments: {}, feedback: {}, runs: [], stages: {}, ...s };
};
const saveState = (p, s) => writeJson(p.state, s);
const skillsBase = p => exists(path.join(p.root, '.claude', 'skills')) ? '.claude/skills' : '.agents/skills';

function snapshot(project = config.project) {
  const agents = loadAgents().map(({ resolved, ...a }) => ({ id: a.id, name: a.name, available: a.available, installed: a.installed, enabled: a.enabled !== false, strengths: a.strengths, permission: a.permission, effectiveModel: a.effectiveModel, relay: a.relay, auth: a.auth, authError: a.authError }));
  if (!project || !exists(project)) return { project: null, recent: config.recent.filter(exists), projectsRoot: config.projectsRoot, agents, maxParallel: config.maxParallel };
  const p = P(project), parsed = parseEpics(p.epics), sprint = readSprint(p.sprint), st = loadState(p);
  const stories = parsed.stories.map(s => {
    const key = Object.keys(sprint).find(k => k.startsWith(`${s.epic}-${s.n}-`)) || `${s.epic}-${s.n}`;
    return { ...s, key, status: sprint[key] || 'backlog', agent: st.assignments[key] || null, feedback: st.feedback[key] || null };
  });
  const docs = [];
  for (const f of walk(p.planning, new Set(['panel']))) if (f.endsWith('.md')) docs.push(path.relative(p.root, f).replace(/\\/g, '/'));
  for (const f of ['AGENTS.md', 'docs/embedded-standards.md']) if (exists(path.join(p.root, f))) docs.unshift(f);
  return {
    project: p.root, projectName: path.basename(p.root), recent: config.recent.filter(exists), projectsRoot: config.projectsRoot,
    bmadInstalled: exists(path.join(p.root, '_bmad')), hasEpics: exists(p.epics), hasSprint: exists(p.sprint), maxParallel: config.maxParallel,
    ...triageSnapshot(p, st), agents, epics: parsed.epics, stories, leader: st.leader, leaderSkills: st.leaderSkills || [], acceptance: st.acceptance || {}, mode: st.mode || 'manual', maxRounds: st.maxRounds || 2, acceptLevel: acceptLevel(st), leaderBoard: (() => { const L = st.leaderBoard || {}; return { notes: L.notes || '', progress: L.progress || null, ask: L.ask || null, finished: L.finished || null, error: L.error || null, ticks: L.ticks || 0, lastTickAt: L.lastTickAt || null, log: (L.log || []).slice(-30).reverse(), answers: L.answers || [] }; })(), autoRounds: st.autoRounds || {}, storySkills: (() => { const out = {}, pl = readPlan(p); for (const x of (pl && pl.assignments) || []) if (x.skills && x.skills.length) out[fullStoryKey(p, x.key)] = [...x.skills]; for (const [k, v] of Object.entries(st.leaderInstr || {})) if (v.skills && v.skills.length) out[k] = [...new Set([...(out[k] || []), ...v.skills])]; return out; })(), storyAutoSkills: Object.fromEntries(Object.entries(st.leaderInstr || {}).map(([k, v]) => [k, v.autoSkills || []])), plan: readPlan(p), stages: stageInfo(p, st),
    runs: st.runs.slice(-80).reverse().map(r => { if (!r.encodingBroken) readAgentResult(p, r); return { ...r, lastLine: live.get(r.id) || r.lastLine, lastOutputAt: lastOut.get(r.id) || null }; }), docs,
  };
}

// ---------- 任务文件（命令行只传一句短指令） ----------
const TEXT_ENCODING_RULE = '- Windows PowerShell 5.1 读写文本文件一律加 `-Encoding UTF8`；中文命令输出先设 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`；管道给原生程序前先设 `$OutputEncoding = [Text.Encoding]::UTF8`。更稳妥：把脚本写成 UTF-8 的 .js / .py 文件再运行，不要用 `内容 | node -` 这种管道方式写含中文的文件。';
const FORBIDDEN = `
## 禁止（违反会被直接取消）
- 不要启动有界面的程序（浏览器窗口、编辑器等），不要模拟桌面键盘鼠标，不要读写系统剪贴板。
- 唯一允许的浏览器用法：面板自带的无头测试工具 node ${UI_CHECK}（后台无窗口、用本机已装的浏览器、自动清理），界面验收就用它。
- 不要下载、安装、解压任何软件或浏览器；只用本机已有的命令行工具（node、git 等）。
- 需要真实浏览器、硬件或人眼确认的验收，写进 manual_checks 交给人，不要自己去做。
- 只改项目目录里的文件。
`;
const roster = agents => agents.map(a => `- ${a.id}（${a.name}）${a.available ? '' : '【不可用，不要分配】'}：${a.strengths}`).join('\n');
const commonRules = p => `- 先读 AGENTS.md 以及它引用的约束文件。
- BMAD skill 在 ${skillsBase(p)}/ 下；按对应 SKILL.md 的 headless 规则执行：不向用户提问，推断处标 [ASSUMPTION]，待定事项列为开放问题。
- 文档语言：中文。` + FORBIDDEN;

function stageTask(p, stage, st, resultPath, feedback) {
  const prev = stageInfo(p, st);
  const fb = feedback ? `\n## 用户对上一版的修改意见（必须逐条处理，在原文件上修改，保持已确认的内容）\n${feedback}\n` : '';
  if (stage === 'prd') return `# 你的角色：产品经理（BMAD bmad-agent-pm / bmad-prd），headless
项目根目录：${p.root}

## 输入
- 需求原文：_bmad-output/panel/requirement.md
${prev.prd.doc ? `- 现有 PRD：${prev.prd.doc}（本次是 Update，在它上面改）` : ''}
${fb}
## 要求
${commonRules(p)}
- 按 ${skillsBase(p)}/bmad-prd/SKILL.md 产出 PRD${prev.prd.doc ? '' : `，写到 _bmad-output/planning-artifacts/prds/prd-${slug(path.basename(p.root))}/prd.md`}。
- 篇幅按项目规模控制；功能需求用 FR-1…FR-N 全局编号并带可测试的验收条件。

## 输出（必须）
把下面格式的 JSON 写入 ${resultPath}（UTF-8，不要 Markdown 包裹）：
{"doc":"PRD 的相对路径","summary":"三句话以内概括","open_questions":["..."],"assumptions":["..."]}
`;
  if (stage === 'architecture') return `# 你的角色：架构师（BMAD bmad-agent-architect / bmad-architecture），headless，Fast path
项目根目录：${p.root}

## 输入
- 已确认的 PRD：${prev.prd.doc}
${prev.architecture.doc ? `- 现有架构文档：${prev.architecture.doc}（本次是 Update，在它上面改）` : ''}
${fb}
## 要求
${commonRules(p)}
- 按 ${skillsBase(p)}/bmad-architecture/SKILL.md 产出 ARCHITECTURE-SPINE.md${prev.architecture.doc ? '' : `，写到 _bmad-output/planning-artifacts/architecture/architecture-${slug(path.basename(p.root))}/ARCHITECTURE-SPINE.md`}。
- 决策写成 AD-1…AD-N（Binds / Prevents / Rule），资源预算、依赖方向、测试方式要明确。
- 如果 skill 自带 lint_spine.py，跑一遍并修到 0 问题。

## 输出（必须）
把下面格式的 JSON 写入 ${resultPath}：
{"doc":"架构文档相对路径","summary":"...","open_questions":["..."],"assumptions":["..."]}
`;
  if (stage === 'epics') return `# 你的角色：Scrum Master（BMAD bmad-create-epics-and-stories），headless
项目根目录：${p.root}

## 输入
- PRD：${prev.prd.doc}
- 架构：${prev.architecture.doc}
${prev.epics.doc ? `- 现有 epics：${prev.epics.doc}（本次是 Update）` : ''}
${fb}
## 要求
${commonRules(p)}
- 按 ${skillsBase(p)}/bmad-create-epics-and-stories/SKILL.md 拆分，写到 _bmad-output/planning-artifacts/epics.md。
- 标题格式必须严格是 \`## Epic N: 标题\` 和 \`### Story N.M: 标题\`（面板和 BMAD sprint 脚本按这个解析）。
- 每个 Story 大小以一个 agent 一次会话能完成为准，写 Given/When/Then 验收标准，并注明对应 FR 和必须遵守的 AD。
- 需要人工（上板、实测、目视）验收的项单列为 “L4 人工：…”。
- 优先拆出能在本机自动测试的纯逻辑 Story。

## 输出（必须）
把下面格式的 JSON 写入 ${resultPath}：
{"doc":"_bmad-output/planning-artifacts/epics.md","summary":"几个 Epic、几个 Story、整体顺序","open_questions":["..."]}
`;
}
function leaderPlanTask(p, snap, resultPath) {
  const skillsBlock = skillsPrompt(p, loadState(p).leaderSkills) + (isAuto(loadState(p)) ? skillCatalog(p) : '');
  const todo = snap.stories.filter(s => s.status !== 'done').map(s => `- ${s.key}｜${s.title}｜当前状态 ${s.status}${s.needsHuman ? '｜含 L4 人工验收' : ''}`).join('\n');
  return `# 你的角色：Leader（统筹、拆解、分配）——你不写实现代码

项目根目录：${p.root}

## 先读这些
- AGENTS.md 以及它引用的约束文件
- _bmad-output/planning-artifacts/ 下的 PRD、架构文档、epics.md
- _bmad-output/implementation-artifacts/sprint-status.yaml

${skillsBlock}
## 团队成员（你可以分配的 agent）
${roster(snap.agents)}

## 任务
1. 对下列每个未完成的 Story，选出最合适的 agent，说明理由，标出依赖和可并行分组（同组可同时做）。
2. 纯逻辑、可在本机测试的交给擅长实现的；架构敏感/安全相关的交给推理强的；含 L4 人工验收的把 needs_human 设为 true。
3. 尽量让不同 agent 分担。

未完成 Story：
${todo || '（无）'}

## 输出（必须）
只把下面格式的 JSON 写入 ${resultPath}（UTF-8，不要 Markdown 包裹）：
{"summary":"一句话总体安排","assignments":[{"key":"<story key 原样>","agent":"<agent id>","reason":"...","depends_on":["<key>"],"group":1,"needs_human":false,"skills":["从技能库里给这个 Story 挑的技能 id，0～3 个，可空"]}]}
不要修改项目里的其他文件。
`;
}
function memberTask(p, story, resultPath) {
  const st0 = loadState(p), plan0 = readPlan(p), asg = plan0 && (plan0.assignments || []).find(x => x.key === story.key);
  const li = (st0.leaderInstr || {})[story.key];
  const extraSkills = skillsPrompt(p, [...((asg && asg.skills) || []), ...((li && li.skills) || [])]) + decisionsBlock(st0) + (li && li.instructions ? `\n## Leader 的具体指令\n${li.instructions}\n${li.writes && li.writes.length ? `预计改动范围：${li.writes.join(', ')}（不要动范围外的文件，避免和别人冲突）\n` : ''}` : '');
  return `# 你的角色：开发（BMAD Dev），由 Leader 分配给你

项目根目录：${p.root}
Story：${story.key} —— ${story.title}

## Story 内容（摘自 epics.md）
${story.body}
${story.feedback ? `\n## 上一轮评审打回意见（必须处理）\n${story.feedback}\n` : ''}${extraSkills}
## 要求
- 先读 AGENTS.md 和它引用的约束文件，硬规则不能违反。
- 参考 ${skillsBase(p)}/bmad-build 与 bmad-agent-dev 的做法：只做这一个 Story；先写测试再写实现。
- 完成标准：AGENTS.md 规定的测试命令全部通过（还没有测试框架就按架构文档搭一个最小的）。
- 不要修改 sprint-status.yaml 和 _bmad-output/panel/ 下的文件（面板负责）。
- 无法在本机验证的项（上板、示波器、真实浏览器等）不要假装验证，写进 manual_checks。
${isUiStory(story) ? `- 这是界面类 Story：完成后用无头界面测试工具实测验收标准（见技能 headless-ui-check）：${UI_TOOL}，步骤文件放 test/acceptance/${story.key}.steps.json。` : ''}
${FORBIDDEN}

## 输出（必须）
完成后把下面格式的 JSON 写入 ${resultPath}（UTF-8，不要 Markdown 包裹）：
{"status":"review 或 blocked","summary":"做了什么","files_changed":["相对路径"],"tests":{"command":"...","passed":true},"manual_checks":["..."],"blocker":"blocked 时说明原因"}
`;
}
function leaderReviewTask(p, story, run, resultPath) {
  const res = readAgentResult(p, run);
  const skillsBlock = skillsPrompt(p, loadState(p).leaderSkills);
  return `# 你的角色：Leader 评审——只读检查，不改代码

项目根目录：${p.root}
Story：${story.key} —— ${story.title}
实现者：${run ? run.agent : '未知'}

${skillsBlock}
## Story 验收标准
${story.body}

## 实现者自报结果
${res ? JSON.stringify(res, null, 2) : '（无）'}

## 面板检测到的变更文件
${run && run.changedFiles ? run.changedFiles.join('\n') : '（无）'}

## 任务
1. 读相关代码和测试，对照验收标准和 AGENTS.md 的硬规则逐条检查。
2. 运行 AGENTS.md 规定的测试命令确认结果。
3. 把下面格式的 JSON 写入 ${resultPath}：
{"verdict":"approve 或 changes","comments":["具体问题或确认点"],"rule_violations":["违反的硬规则，没有就空数组"]}
`;
}

// ---------- 快照与 diff ----------
const SNAP_SKIP = new Set(['.git', 'node_modules', '.claude', '.agents', '_bmad', 'build', 'dist', '.venv', '__pycache__']);
const BIN_EXT = /\.(exe|o|obj|elf|bin|hex|map|a|lib|dll|so|png|jpg|jpeg|gif|pdf|zip|7z|ico)$/i;
function takeSnapshot(root) {
  const out = {};
  for (const f of walk(root, SNAP_SKIP)) {
    const rel = path.relative(root, f).replace(/\\/g, '/');
    if (rel.startsWith('_bmad-output/panel/') || BIN_EXT.test(f) || path.basename(f) === 'sprint-status.yaml') continue;
    const st = fs.statSync(f); if (st.size > 256 * 1024) continue;
    const buf = fs.readFileSync(f); if (buf.subarray(0, 4096).includes(0)) continue;
    out[rel] = buf.toString('utf8');
  }
  return out;
}
function diffSnapshots(before, after) {
  const changed = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[k] !== after[k]) changed.push(k);
  return changed.sort();
}
function unifiedDiff(a, b, ctx = 3) {
  const A = a === undefined ? [] : a.split(/\r?\n/), B = b === undefined ? [] : b.split(/\r?\n/);
  const n = A.length, m = B.length;
  if (n * m > 6e6) return `（文件太大，不做逐行对比：旧 ${n} 行，新 ${m} 行）`;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) ops.push(['-', A[i++]]); else ops.push(['+', B[j++]]); }
  while (i < n) ops.push(['-', A[i++]]); while (j < m) ops.push(['+', B[j++]]);
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, k) => { if (o[0] !== ' ') for (let d = Math.max(0, k - ctx); d <= Math.min(ops.length - 1, k + ctx); d++) keep[d] = 1; });
  const out = []; let gap = false;
  ops.forEach((o, k) => { if (keep[k]) { if (gap) out.push('@@ …'); gap = false; out.push(o[0] + ' ' + o[1]); } else gap = true; });
  return out.join('\n') || '（无差异）';
}

// ---------- 运行与队列 ----------
const running = new Map(); // runId -> child
const live = new Map();    // runId -> 最近一句进度
const tails = new Map();   // runId -> 最近一段输出
const lastOut = new Map(); // runId -> 最后输出时间
// 按 agent 输出里的标记解析当前在干什么：
// Codex：独立一行的 codex（后面是它说的话）/ exec（下一行是命令，再后面是 succeeded/exited 和命令输出）
// Grok / DeepSeek：不换行的叙述，按句子取最后一句完整的话
const parsers = new Map(); // runId -> { buf, mode, expectCmd }
function shortCmd(t) {
  const m = t.match(/-Command\s+(["'])([\s\S]*)\1\s+in\s+\S+\s*$/);
  let c = m ? m[2] : t.replace(/\s+in\s+[A-Za-z]:\\\S*\s*$/, '');
  c = c.replace(/^"?[A-Za-z]:\\[^"]*?powershell\.exe"?\s*/i, '').replace(/\\"/g, '"');
  if (/^-Command\s/.test(c) || /@['"]\s*$/.test(c)) return '运行多行 PowerShell 脚本';
  return c.length > 120 ? c.slice(0, 120) + '…' : c;
}
function feedStatus(runId, text) {
  const p = parsers.get(runId) || { buf: '', mode: null, expectCmd: false };
  // Keep incomplete escape sequences until the next chunk before stripping them.
  p.buf += text;
  const lines = p.buf.split(/\r\n|\r|\n/); p.buf = lines.pop();
  for (const raw of lines) {
    const t = stripAnsi(raw).trim();
    if (!t) continue;
    if (/^-{4,}$|^={4,}$|^(OpenAI Codex|workdir|model|provider|approval|sandbox|reasoning|session id)/i.test(t)) continue; // Codex 启动信息
    if (t === 'codex') { p.mode = 'say'; continue; }
    if (t === 'exec') { p.mode = 'exec'; p.expectCmd = true; continue; }
    if (t === 'user' || t === 'thinking') { p.mode = t; continue; }
    if (t === 'tokens used') { p.mode = 'done'; live.set(runId, '✓ 收尾中'); continue; }
    if (p.expectCmd) { live.set(runId, '▶ ' + shortCmd(t)); p.expectCmd = false; continue; }
    if (p.mode === 'exec') { const m = t.match(/^exited (-?\d+)/); if (m && m[1] !== '0') live.set(runId, '✗ 命令失败（退出码 ' + m[1] + '），正在处理'); continue; }
    if (p.mode === 'say') { live.set(runId, '💬 ' + t.slice(0, 150)); continue; }
    if (p.mode === null && !/^\$ |^\d{4}-\d\d-\d\dT|^warning:|^Reading additional input/.test(t)) {
      const segs = t.split(/(?<=[。！？!?])/).map(x => x.trim()).filter(x => x.length > 3);
      if (segs.length) live.set(runId, '💬 ' + segs[segs.length - 1].slice(0, 150));
    }
  }
  // 不换行的叙述（Grok）：从未完结的缓冲里取最后一句完整的话
  if (p.mode === null && p.buf.length) {
    const done = stripAnsi(p.buf).split(/(?<=[。！？!?])/); done.pop();
    const last = done.map(x => x.trim()).filter(x => x.length > 3).pop();
    if (last) live.set(runId, '💬 ' + last.slice(0, 150));
    if (p.buf.length > 4000) p.buf = p.buf.slice(-2000);
  }
  parsers.set(runId, p);
}
let queue = [];
const sseClients = new Set();
const broadcast = (type, data) => { for (const r of sseClients) r.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
const quoteWin = a => `"${String(a).replace(/"/g, '""')}"`;

function grokTranslator() {
  let buf = '', inText = false;
  const decoder = new StringDecoder('utf8');
  const tools = new Map();
  const parse = (text, final = false) => {
    buf += text;
    const lines = buf.split('\n'); buf = lines.pop();
    if (final && buf) { lines.push(buf); buf = ''; }
    let out = '';
    for (const l of lines) {
      let j; try { j = JSON.parse(l); } catch { if (l.trim()) out += l + '\n'; continue; }
      if (j.type === 'text') { if (!inText) { out += '\ncodex\n'; inText = true; } out += j.data || ''; }
      else if (j.type === 'tool_call') {
        inText = false;
        const ri = j.rawInput || {};
        const target = ri.command || ri.file_path || ri.target_file || ri.path || ri.pattern || ri.query || ri.description || '';
        const name = j.toolName === 'run_terminal_command' ? '' : ({ read_file: '读文件', search_replace: '改文件', write: '写文件', list_dir: '列目录', grep: '搜索', todo_write: '更新待办', spawn_subagent: '派子任务' }[j.toolName] || j.toolName) + ' ';
        tools.set(j.toolCallId, { t0: Date.now(), shown: 0 });
        out += `\nexec\n${name}${String(target).replace(/\n/g, ' ').slice(0, 300)}\n`;
      } else if (j.type === 'tool_call_update') {
        const t = tools.get(j.toolCallId) || { t0: Date.now(), shown: 0 };
        const txt = (j.content || []).map(c => (c.content && c.content.text) || '').join('').replace(/\r/g, '');
        if (j.rawOutput && j.rawOutput.type === 'Bash' && txt.length > t.shown) { out += txt.slice(t.shown); t.shown = txt.length; }
        if (j.status === 'completed' || j.status === 'failed') {
          const code = j.rawOutput && typeof j.rawOutput.exit_code === 'number' ? j.rawOutput.exit_code : (j.status === 'failed' ? 1 : 0);
          out += `\n${code === 0 ? 'succeeded' : 'exited ' + code} in ${Date.now() - t.t0}ms:\n`;
          tools.delete(j.toolCallId);
        } else tools.set(j.toolCallId, t);
      } else if (j.type === 'end') out += `\ntokens used\n${(j.usage && j.usage.total_tokens) || ''}\n`;
    }
    return out;
  };
  const translate = chunk => parse(decoder.write(chunk));
  translate.end = () => parse(decoder.end(), true);
  return translate;
}
let ptyModule = null, ptyLoadError = '';
try { ptyModule = createRequire(import.meta.url)('node-pty'); }
catch (e) { ptyLoadError = e.message; }

function launch({ exe, args, env, stream }, cwd, logFile, onChunk, onExit, label) {
  // Open the log before creating a process so an unwritable directory cannot
  // leave an untracked agent running.
  const fd = fs.openSync(logFile, 'a');
  let child, fallback = process.env.PANEL_NO_PTY === '1' ? 'PANEL_NO_PTY=1' : ptyLoadError;
  try {
    const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
    const command = argv => `"${[exe, ...argv].map(quoteWin).join(' ')}"`;
    const originalArgs = args;
    if (ptyModule && process.env.PANEL_NO_PTY !== '1') {
      // Grok calls its native text format "plain" (the default), not "text".
      // It streams before exit under ConPTY; only the fallback needs NDJSON.
      if (stream === 'grok-ndjson') args = args.filter((arg, i) => arg !== '--output-format' && args[i - 1] !== '--output-format' && !arg.startsWith('--output-format='));
      const ptyEnv = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
      for (const k of Object.keys(ptyEnv)) if (/^(NO_COLOR|FORCE_COLOR)$/i.test(k)) delete ptyEnv[k];
      try {
        child = ptyModule.spawn(batch ? 'cmd.exe' : exe, batch ? `/d /s /c ${command(args)}` : args, {
          name: 'xterm-256color', cols: 120, rows: 32, cwd, env: ptyEnv, useConpty: true,
        });
        child.pty = true;
      } catch (e) { fallback = e.message; }
    }
    if (!child) {
      args = originalArgs;
      const plainEnv = { ...env, NO_COLOR: '1', FORCE_COLOR: '0' };
      child = batch
        ? spawn('cmd.exe', ['/d', '/s', '/c', command(args)], { cwd, env: plainEnv, windowsVerbatimArguments: true, windowsHide: true })
        : spawn(exe, args, { cwd, env: plainEnv, windowsHide: true });
      child.pty = false;
    }
    let logBytes = fs.fstatSync(fd).size, ended = false;
    // Commit whole UTF-8 strings before broadcasting: /api/log is an exact snapshot
    // and the browser can trim any overlapping SSE chunks by these byte offsets.
    const append = text => {
      if (!text || ended) return;
      const offset = logBytes, data = Buffer.from(text, 'utf8');
      fs.writeSync(fd, data); logBytes += data.length;
      if (onChunk) onChunk(text, { pty: child.pty, offset, endOffset: logBytes });
    };
    append(`$ ${label}: ${[path.basename(exe), ...args].join(' ')}\r\n\r\n`);
    if (!child.pty) append(`[PTY fallback] ${fallback || 'PTY unavailable'}\n`);
    const finish = code => {
      if (ended) return;
      append(`\r\n[exit ${code}]\r\n`);
      ended = true; fs.closeSync(fd); onExit(code);
    };
    if (child.pty) {
      child.onData(append);
      child.onExit(({ exitCode }) => finish(exitCode));
      child.on('error', e => {
        append(`\r\n[PTY error] ${e.message}\r\n`);
        killTree(child); finish(1);
      });
    } else {
      const tr = stream === 'grok-ndjson' ? grokTranslator() : null;
      // stdout/stderr have independent UTF-8 boundaries.
      const stdoutDecoder = tr ? null : new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
      child.stdout.on('data', chunk => append(tr ? tr(chunk) : stdoutDecoder.write(chunk)));
      child.stderr.on('data', chunk => append(stderrDecoder.write(chunk)));
      child.stdin.end();
      child.on('error', e => append(`\n[spawn error] ${e.message}\n`));
      child.on('close', code => {
        append(tr ? tr.end() : stdoutDecoder.end()); append(stderrDecoder.end()); finish(code);
      });
    }
    return child;
  } catch (e) {
    if (child) killTree(child);
    try { fs.closeSync(fd); } catch {}
    throw e;
  }
}
function newRunId(kind, who) { return `${new Date().toISOString().replace(/[-:T.Z]/g, '')}-${kind}-${who}-${Math.random().toString(36).slice(2, 6)}`; }
function updateRun(p, id, patch) { const st = loadState(p); const r = st.runs.find(x => x.id === id); if (r) Object.assign(r, patch); saveState(p, st); return r; }

function enqueue({ project = config.project, kind, storyKey = null, stage = null, nodeId = null, agentId, feedback = null, title = null, instructions = null, skills = null, relatedStory = null }) {
  const p = P(project), st = loadState(p), snap = snapshot(project);
  const agent = loadAgents().find(a => a.id === agentId);
  if (!agent) throw new Error(`没有这个 agent：${agentId}`);
  if (!agent.installed) throw new Error(`${agent.name} 未安装（找不到 ${agent.cmd}）`);
  if (agent.enabled === false) throw new Error(`${agent.name} 已在设置里停用`);
  const dup = st.runs.find(r => !r.cancelRequested && ['queued', 'running'].includes(r.status) && ((storyKey && r.storyKey === storyKey) || (stage && r.stage === stage) || (nodeId && r.nodeId === nodeId && r.kind === kind) || (['plan', 'tick', 'triage'].includes(kind) && r.kind === kind)));
  if (dup) throw new Error('这一项已经在跑或在排队');
  const story = storyKey ? snap.stories.find(s => s.key === storyKey) : null;
  if (storyKey && !story) throw new Error(`找不到 Story ${storyKey}`);
  const run = { id: newRunId(kind === 'stage' ? stage : kind === 'node' ? 'node' : kind, agentId), kind, storyKey, stage, nodeId, title, relatedStory, agent: agentId, status: 'queued', pty: false, createdAt: now() };
  if (kind === 'triage') { run.triageInput = st.triagePending.input; st.triagePending.runId = run.id; }
  const f = runFiles(p, run); fs.mkdirSync(f.dir, { recursive: true });
  const lastImpl = storyKey && [...st.runs].reverse().find(r => r.storyKey === storyKey && r.kind === 'implement');
  const task = kind === 'triage' ? triageTask(p, f.result) : kind === 'plan' ? leaderPlanTask(p, snap, f.result)
    : kind === 'review' ? leaderReviewTask(p, story, lastImpl, f.result)
      : kind === 'stage' ? stageTask(p, stage, st, f.result, feedback)
        : kind === 'node' ? nodeTask(p, nodeId, st, f.result, feedback)
          : kind === 'nodereview' ? nodeReviewTask(p, nodeId, st, f.result)
            : kind === 'tick' ? leaderBrief(p, f.result)
              : kind === 'task' ? taskTask(p, title, instructions, skills, f.result, relatedStory)
        : memberTask(p, story, f.result);
  // 所有任务（包括 Leader 简报/评审）都在此写入，统一带上编码规则。
  writeMd(f.task, `${task}\n## 通用规则（文本编码）\n${TEXT_ENCODING_RULE}\n`);
  st.runs.push(run);
  if (kind === 'node') { st.wf = st.wf || { nodes: {} }; st.wf.nodes[nodeId] = { ...(st.wf.nodes[nodeId] || {}), status: 'running', runId: run.id, agent: agentId, feedback: feedback || null }; }
  if (kind === 'stage') st.stages[stage] = { ...(st.stages[stage] || {}), status: 'running', agent: agentId, runId: run.id, feedback: feedback || null };
  saveState(p, st);
  queue.push({ runId: run.id, project: p.root }); broadcast('state', {}); pump();
  return run;
}

function pump() {
  for (;;) {
    const busy = [...running.keys()].filter(id => !/-(tick|triage)-/.test(id)).length;
    const idx = queue.findIndex(q => /-(tick|triage)-/.test(q.runId) || busy < (config.maxParallel || 1));
    if (idx < 0) break;
    const { runId, project } = queue.splice(idx, 1)[0];
    const p = P(project), st = loadState(p), run = st.runs.find(r => r.id === runId);
    if (!run || run.status !== 'queued') continue;
    const agent = loadAgents().find(a => a.id === run.agent);
    const f = runFiles(p, run);
    updateRun(p, runId, { status: 'running', startedAt: now() });
    if (run.kind === 'implement') {
      try { setStoryStatus(p, run.storyKey, 'in-progress'); } catch (e) { console.error(e.message); }
      writeJson(path.join(f.dir, 'before.json'), takeSnapshot(p.root));
    }
    const prompt = `Read the task file ${f.task} and follow it exactly. Write your JSON result to the path it specifies.`;
    const onChunk = (text, meta) => {
      feedStatus(runId, text);
      lastOut.set(runId, now());
      broadcast('log', { runId, text, ...meta, lastLine: live.get(runId), lastOutputAt: lastOut.get(runId) });
    };
    const onExit = code => {
      clearTimeout(triageTimers.get(runId)); triageTimers.delete(runId);
      running.delete(runId);
      const result = readAgentResult(p, run);
      const cur = loadState(p).runs.find(r => r.id === runId) || {};
      const patch = { status: code === 0 && result ? 'finished' : 'failed', exitCode: code, endedAt: now(), hasResult: !!result, encodingBroken: hasBrokenEncoding(result), lastLine: live.get(runId) };
      if (cur.triageTimedOut) { patch.status = 'failed'; patch.error = cur.error; }
      if (run.kind === 'implement') {
        const before = readJson(path.join(f.dir, 'before.json'), {}), after = takeSnapshot(p.root);
        patch.changedFiles = diffSnapshots(before, after);
        writeJson(path.join(f.dir, 'after.json'), Object.fromEntries(patch.changedFiles.filter(k => k in after).map(k => [k, after[k]])));
        writeJson(path.join(f.dir, 'before.json'), Object.fromEntries(patch.changedFiles.filter(k => k in before).map(k => [k, before[k]])));
        const next = result && result.status === 'review' && !cur.cancelRequested ? 'review' : 'ready-for-dev';
        try { setStoryStatus(p, run.storyKey, next); } catch (e) { console.error(e.message); }
      }
      if (run.kind === 'plan' && result) writeJson(p.plan, normalizePlan(p, { ...result, by: run.agent, at: now() }));
      if (run.kind === 'review' && result) patch.verdict = result.verdict;
      if (run.kind === 'stage') {
        const s2 = loadState(p);
        s2.stages[run.stage] = { ...(s2.stages[run.stage] || {}), status: result && code === 0 ? 'review' : 'failed', result: result || null, finishedAt: now() };
        saveState(p, s2);
      }
      let needReview = false;
      if (run.kind === 'node') {
        const s2 = loadState(p), node = (readWorkflow(p).nodes || []).find(n => n.id === run.nodeId) || {};
        const ok = !!result && code === 0 && !cur.cancelRequested;
        s2.wf = s2.wf || { nodes: {} };
        const quickReview = isQuickWorkflow(readWorkflow(p)) && run.nodeId === 'review' && automatic(s2);
        s2.wf.nodes[run.nodeId] = { ...(s2.wf.nodes[run.nodeId] || {}), status: !ok ? 'failed' : quickReview ? 'running' : (node.config || {}).approval ? (isAuto(s2) && s2.leader ? 'running' : 'waiting') : 'done', note: ok && (node.config || {}).approval && isAuto(s2) ? 'Leader 自动评审中' : null, result: result || null, finishedAt: now() };
        if (ok && !quickReview && (node.config || {}).approval && isAuto(s2) && s2.leader) needReview = true;
        saveState(p, s2);
      }
      if (patch.status === 'failed' && !result) patch.error = cur.error || (code === 0 ? 'agent 结束但没写结果文件' : `退出码 ${code}`);
      if (cur.cancelRequested) { patch.status = 'cancelled'; patch.error = '已手动取消'; }
      updateRun(p, runId, patch);
      live.delete(runId); parsers.delete(runId); lastOut.delete(runId);
      if (run.kind === 'triage') {
        finishTriage(p, run, !cur.cancelRequested && code === 0 ? result : null, cur.cancelRequested ? 'cancelled' : 'Leader 分诊失败');
        broadcast('state', {}); pump(); return;
      }
      if (run.kind === 'node' && run.nodeId === 'review' && isQuickWorkflow(readWorkflow(p)) && automatic(loadState(p)) && !cur.cancelRequested) finishQuickReview(p, code === 0 ? result : null);
      if (needReview) { try { enqueue({ project: p.root, kind: 'nodereview', nodeId: run.nodeId, agentId: loadState(p).leader }); } catch (e) { setNode(p, run.nodeId, { status: 'waiting', note: e.message }); } }
      try { autoAfterRun(p, run, cur.cancelRequested ? null : result); } catch (e) { console.error('auto:', e.message); }
      try { if (isLeaderMode(loadState(p))) { if (run.kind === 'tick') applyTick(p, run, cur.cancelRequested ? null : result); else scheduleTick(p, `${KIND_CN[run.kind] || run.kind}完成`); } } catch (e) { console.error('leader:', e.message); }
      try { advanceWorkflow(p); autoDispatch(p); } catch (e) { console.error('workflow:', e.message); }
      broadcast('state', {}); pump();
    };
    try {
      const child = launch(buildInvocation(agent, prompt, p.root), p.root, f.log, onChunk, onExit, agent.name);
      running.set(runId, child);
      updateRun(p, runId, { pty: child.pty });
      if (run.kind === 'triage') triageTimers.set(runId, setTimeout(() => {
        updateRun(p, runId, { error: 'Leader 分诊超时（3 分钟）', triageTimedOut: true });
        finishTriage(p, run, null, 'Leader 分诊超时（3 分钟）');
        killTree(child);
      }, 3 * 60 * 1000));
    } catch (e) {
      updateRun(p, runId, { pty: false, error: e.message });
      onExit(-1);
    }
    broadcast('state', {});
  }
}
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else child.kill('SIGTERM');
}
function activePty(id) {
  const run = loadState(needProject()).runs.find(r => r.id === id), child = running.get(id);
  if (!run || run.status !== 'running' || run.cancelRequested || !child?.pty) throw new Error('这个运行没有正在进行的 PTY');
  return child;
}
function cancel(runId, p = P(config.project)) {
  const st = loadState(p);
  if (st.triagePending?.runId === runId) { delete st.triagePending; if (st.wf) st.wf.running = false; saveState(p, st); }
  queue = queue.filter(q => q.runId !== runId);
  const child = running.get(runId);
  if (child) { updateRun(p, runId, { cancelRequested: true }); killTree(child); }
  else {
    const r = updateRun(p, runId, { status: 'cancelled', endedAt: now() });
    if (r && r.kind === 'stage') { const st = loadState(p); st.stages[r.stage] = { ...(st.stages[r.stage] || {}), status: 'failed' }; saveState(p, st); }
  }
  broadcast('state', {});
}

// ---------- 项目创建 / 接入（安装 BMAD + 模板） ----------
const setupJobs = new Map(); // dir -> {status, log}
function copyTemplate(name, dir, projectName, overwrite) {
  const src = path.join(HERE, 'templates', name);
  for (const f of walk(src)) {
    const rel = path.relative(src, f), dst = path.join(dir, rel);
    if (exists(dst) && !overwrite) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const markdown = /\.md$/i.test(f);
    const txt = (markdown ? readMd(f) : fs.readFileSync(f, 'utf8')).replace(/\{\{PROJECT_NAME\}\}/g, projectName);
    if (markdown) writeMd(dst, txt); else fs.writeFileSync(dst, txt);
  }
}
function setupProject(dir, template, isNew, initial = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(HERE, 'logs', `setup-${Date.now()}.log`);
  const job = { dir, status: 'running', logFile, startedAt: now() };
  setupJobs.set(dir, job); broadcast('setup', { dir, status: 'running' });
  const name = path.basename(dir);
  const tools = 'claude-code,codex,gemini,grok';
  const args = ['-y', `bmad-method@${BMAD_VERSION}`, 'install', '--directory', dir, '--modules', 'bmm', '--tools', tools,
    '--user-name', readJson(CONFIG_FILE, {}).userName || 'User', '--communication-language', 'Chinese', '--document-output-language', 'Chinese', '-y'];
  if (exists(path.join(dir, '_bmad'))) args.splice(3, 0, '--action', 'update');
  const npx = resolveCmd('npx');
  const finish = (ok, msg) => {
    job.status = ok ? 'done' : 'failed'; job.error = msg; job.endedAt = now();
    if (ok) {
      try {
        copyTemplate(template, dir, name, false);
        if (template === 'embedded') {
          fs.mkdirSync(path.join(dir, '_bmad', 'custom'), { recursive: true });
          copyTemplate('embedded/_bmad', path.join(dir, '_bmad'), name, true);
        }
        if (!exists(path.join(dir, '.git'))) execFile('git', ['init', '-q'], { cwd: dir }, () => {});
        fs.mkdirSync(P(dir).panel, { recursive: true });
        useProject(dir);
        const p = P(dir), st = loadState(p);
        if (isNew) { st.mode = ['auto', 'leader'].includes(initial.mode) ? initial.mode : 'manual'; saveState(p, st); ensureLeader(p); }
        if (isNew && String(initial.requirement || '').trim()) {
          writeMd(p.requirement, String(initial.requirement));
          const s2 = loadState(p); s2.wf = { nodes: {}, running: automatic(s2) }; saveState(p, s2);
          requestTriage(p); advanceWorkflow(p);
        }
      } catch (e) { job.status = 'failed'; job.error = e.message; }
    }
    broadcast('setup', { dir, status: job.status, error: job.error }); broadcast('state', {});
  };
  launch({ exe: npx, args, env: { ...process.env, NO_COLOR: '1' } }, dir, logFile, null,
    code => finish(code === 0 && exists(path.join(dir, '_bmad')), code === 0 ? null : `安装失败，退出码 ${code}`), 'BMAD 安装');
  return job;
}

// ---------- 服务商 / agent 设置 / 测试 ----------
function saveProvider(id, patch = {}) {
  const file = readProvidersFile(); let p = file.providers.find(x => x.id === id);
  if (id && !p) throw new Error('服务商不存在');
  const fresh = !p;
  if (fresh) {
    id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    p = { id, name: '', type: 'openai', baseUrl: '', keyEnv: `PROVIDER_${id.replace(/-/g, '_').toUpperCase()}_KEY`, models: [], modelsAt: null, enabled: true, builtin: false };
  }
  const next = { ...p };
  for (const k of ['name', 'type', 'baseUrl']) if (k in patch) next[k] = String(patch[k]).trim();
  if ('enabled' in patch) next.enabled = !!patch.enabled;
  if (!next.name) throw new Error('服务商名称不能为空');
  if (!['anthropic', 'openai', 'gemini', 'xai'].includes(next.type)) throw new Error('服务商类型无效');
  let url; try { url = new URL(next.baseUrl); } catch { throw new Error('Base URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须是无凭据、无查询参数的 HTTP(S) 地址');
  next.baseUrl = next.baseUrl.replace(/\/+$/, '');
  for (const a of readAgentsFile().agents || []) {
    const auth = authFor(a);
    if (auth.mode === 'provider' && auth.provider === id && !(PROVIDER_TYPES[a.id] || []).includes(next.type)) throw new Error(`${a.name} 正在使用此服务商，不能改成不兼容的协议`);
  }
  if (p.type !== next.type || p.baseUrl !== next.baseUrl) { next.models = []; next.modelsAt = null; next.check = null; }
  if (fresh) file.providers.push(next); else Object.assign(p, next);
  writeJson(PROVIDERS_FILE, file); broadcast('state', {});
  return providerDetail(next);
}
function deleteProvider(id) {
  const file = readProvidersFile(), p = file.providers.find(x => x.id === id);
  if (!p) throw new Error('服务商不存在');
  if (p.builtin) throw new Error('内置服务商不能删除');
  const users = readAgentsFile().agents.filter(a => { const auth = authFor(a); return auth.mode === 'provider' && auth.provider === id; });
  if (users.length) throw new Error(`服务商正在被 ${users.map(a => a.name).join('、')} 使用，请先切换认证方式`);
  file.providers = file.providers.filter(x => x.id !== id); writeJson(PROVIDERS_FILE, file);
  return { ok: true };
}
// Shared secret writer. Neither provider configuration nor API responses contain raw keys.
function setSecretEnv(keyEnv, value) {
  value = String(value).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv) || !value || /[\r\n\0]/.test(value)) throw new Error('API Key 无效');
  const backup = path.join(HERE, 'logs', 'auth', 'secrets.env.bak');
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  if (exists(SECRETS_FILE) && !exists(backup)) fs.copyFileSync(SECRETS_FILE, backup);
  const text = exists(SECRETS_FILE) ? fs.readFileSync(SECRETS_FILE, 'utf8') : '';
  const re = new RegExp(`^\\s*${keyEnv}\\s*=`); let replaced = false;
  const lines = text.split(/\r?\n/).filter(line => {
    if (!re.test(line.replace(/^\uFEFF/, ''))) return true;
    if (replaced) return false;
    replaced = true; return true;
  }).map(line => re.test(line.replace(/^\uFEFF/, '')) ? `${keyEnv}=${value}` : line);
  if (!replaced) { if (lines.at(-1) === '') lines.pop(); lines.push(`${keyEnv}=${value}`); }
  fs.writeFileSync(SECRETS_FILE, lines.join('\n').replace(/\n*$/, '') + '\n', 'utf8');
}
function setProviderSecret(id, value) {
  const file = readProvidersFile(), p = file.providers.find(x => x.id === id);
  if (!p) throw new Error('服务商不存在');
  setSecretEnv(p.keyEnv, value); p.check = null;
  writeJson(PROVIDERS_FILE, file); return { ok: true };
}
function setSecret(id, value) {
  const a = loadAgents().find(x => x.id === id);
  if (!a || a.auth.mode !== 'provider') throw new Error('这个 agent 未使用服务商');
  return setProviderSecret(a.auth.provider, value);
}
function safeProviderError(message, key = '') {
  let text = String(message || '服务商请求失败');
  if (key) text = text.split(key).join('[已隐藏]').split(encodeURIComponent(key)).join('[已隐藏]');
  return text.replace(/([?&]key=)[^\s&"']+/gi, '$1[已隐藏]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').slice(0, 350);
}
async function checkProvider(id, cache = false) {
  const p = readProvidersFile().providers.find(x => x.id === id);
  if (!p) throw new Error('服务商不存在');
  const key = providerKey(p), at = now(); let result, models = [];
  try {
    if (!key) throw new Error('尚未设置 API Key');
    if (p.enabled === false) throw new Error('服务商已停用');
    const base = p.baseUrl.replace(/\/+$/, ''), signal = AbortSignal.timeout(15000);
    const target = p.type === 'anthropic' ? base + (base.endsWith('/v1') ? '/models' : '/v1/models') : p.type === 'gemini' ? base + (base.endsWith('/v1beta') ? '/models' : '/v1beta/models') : base + '/models';
    const get = async (url, headers) => {
      const response = await fetch(url, { headers, signal, redirect: 'error' });
      let json; try { json = await response.json(); } catch { throw new Error(`HTTP ${response.status}：响应不是 JSON`); }
      return { response, json };
    };
    let reply;
    if (p.type === 'anthropic') {
      try { reply = await get(target, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }); } catch (e) { if (signal.aborted) throw e; }
      if (!reply?.response.ok || reply.json?.error) reply = await get(target, { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' });
    } else reply = await get(p.type === 'gemini' ? `${target}?key=${encodeURIComponent(key)}` : target, p.type === 'gemini' ? {} : { Authorization: `Bearer ${key}` });
    const { response, json } = reply;
    if (!response.ok || json.error) throw new Error(`HTTP ${response.status}：${json.error?.message || json.message || '认证或模型查询失败'}`);
    const entries = p.type === 'gemini' ? json.models : json.data;
    if (!Array.isArray(entries)) throw new Error('响应缺少模型列表');
    models = [...new Set(entries.map(m => p.type === 'gemini' ? String(m.name || '').replace(/^models\//, '') : m.id).filter(m => typeof m === 'string' && m))].sort();
    result = { ok: true, count: models.length, at };
  } catch (e) {
    result = { ok: false, count: 0, at, error: safeProviderError(['TimeoutError', 'AbortError'].includes(e.name) ? '请求超时（15 秒）' : e.message, key) };
  }
  // Re-read after network IO: never overwrite concurrent edits or revive a deleted provider.
  const file = readProvidersFile(), current = file.providers.find(x => x.id === id);
  if (current && current.baseUrl === p.baseUrl && current.type === p.type && providerKey(current) === key) {
    current.check = result;
    if (cache && result.ok) { current.models = models; current.modelsAt = now(); }
    writeJson(PROVIDERS_FILE, file);
  }
  return result;
}
async function providerModels(id) {
  const result = await checkProvider(id, true);
  if (!result.ok) throw new Error(result.error);
  const p = readProvidersFile().providers.find(x => x.id === id);
  if (!p) throw new Error('服务商已删除');
  return providerDetail(p);
}
function saveAgent(id, patch) {
  const file = readAgentsFile(), a = file.agents.find(x => x.id === id);
  if (!a) throw new Error('没有这个 agent');
  const next = { ...a };
  for (const k of ['enabled', 'strengths', 'permission', 'cmd']) if (k in patch) next[k] = patch[k];
  if ('permission' in patch && !Object.hasOwn(a.perm || {}, patch.permission)) throw new Error('权限档无效');
  next.auth = 'auth' in patch ? { mode: patch.auth?.mode, provider: String(patch.auth?.provider || ''), model: String(patch.auth?.model || '').trim() } : authFor(a);
  if ('model' in patch) next.auth.model = String(patch.model || '').trim();
  if (next.auth.mode === 'official') next.auth.provider = '';
  const p = validateProvider(next, next.auth);
  if (p && ['codex', 'grok'].includes(a.id)) writeProviderConfig(next, p, next.auth.model);
  Object.assign(a, next); writeJson(AGENTS_FILE, file);
  broadcast('state', {});
}
function loginStatus(a) {
  const files = { claude: ['.claude', '.credentials.json'], codex: ['.codex', 'auth.json'], gemini: ['.gemini', 'oauth_creds.json'], grok: ['.grok', 'auth.json'] };
  const hints = { claude: '运行 Claude Code 后输入 /login 完成官方账号登录。', codex: '运行 codex login，按 CLI 提示完成登录。', gemini: '首次运行 gemini 会引导登录；本机未安装，登录命令尚未核实。', grok: '运行 grok login，按 CLI 提示完成登录。', deepseek: '使用 DeepSeek Harness 自身 settings.yaml 配置。' };
  // Provider tests use separate credentials and cannot verify the official account.
  const test = latestAgentTest(a, 'official'), hasCredentials = !!files[a.id] && exists(path.join(AUTH_HOME, ...files[a.id]));
  const status = a.id === 'deepseek' ? 'self' : loginStateFromTest(hasCredentials, test);
  const verification = status === 'expired' ? '登录已失效，请点击「登录」，完成后重新测连通。' : status === 'unverified' ? (test ? '最近一次测连通未通过，尚未验证登录；请重新测连通。' : '凭据文件存在，尚未测连通验证；请点击「测连通」。') : status === 'logged-in' ? '官方账号最近一次测连通通过。' : '';
  return { status, hint: [verification, hints[a.id] || '请使用 CLI 自身登录。'].filter(Boolean).join(' '), command: a.loginCmd || '', canLogin: !!a.loginCmd && !!a.installed, testedAt: test?.finishedAt || null };
}
function authErrorInOutput(output) { return /not\s+logged\s+in|\/login\b|\b401\b|unauthori[sz]ed|\bexpired\b/i.test(String(output || '')); }
function loginStateFromTest(hasCredentials, test) {
  if (!hasCredentials) return 'not-logged-in';
  if (test?.status === 'ok') return 'logged-in';
  if (['failed', 'timeout'].includes(test?.status) && (test.authFailed || authErrorInOutput(test.output))) return 'expired';
  return 'unverified';
}
function loginAgent(id) {
  const a = loadAgents().find(x => x.id === id);
  if (!a?.installed || !a.loginCmd) throw new Error('该 CLI 没有可用的登录命令，请按提示手动登录');
  if (a.auth.mode !== 'official') throw new Error('请先保存为官方账号模式');
  const commands = { claude: { 'claude': [], 'claude auth login': ['auth', 'login'] }, codex: { 'codex login': ['login'] }, gemini: { gemini: [] }, grok: { 'grok login': ['login'] } };
  const args = commands[a.id]?.[a.loginCmd];
  if (!args) throw new Error('登录命令未核实');
  if (process.platform !== 'win32') throw new Error('打开登录控制台仅支持 Windows，请手动运行登录命令');
  const title = `${a.name.replace(/["%&|<>^!\r\n]/g, '')} 登录`;
  const command = `start "${title}" cmd /d /k "${[a.resolved, ...args].map(quoteWin).join(' ')}"`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: HERE, env: invocationEnv(a), detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.on('error', () => {}); child.unref();
  return { ok: true, hint: loginStatus(a).hint };
}
function agentDetail(a) {
  const p = a.auth.mode === 'provider' && readProvidersFile().providers.find(x => x.id === a.auth.provider), detail = p ? providerDetail(p) : null;
  return { id: a.id, name: a.name, cmd: a.cmd, path: a.resolved, installed: a.installed, enabled: a.enabled !== false, strengths: a.strengths,
    permission: a.permission || 'max', permOptions: Object.keys(a.perm || {}), canModel: !!a.modelFlag || ['codex', 'grok'].includes(a.id), model: a.effectiveModel, effectiveModel: a.effectiveModel, modelNote: a.modelNote,
    auth: a.auth, providerTypes: PROVIDER_TYPES[a.id] || [], providerSupported: !!PROVIDER_TYPES[a.id]?.length, providerNote: a.id === 'deepseek' ? 'dsh --help / headless --help 未提供服务商注入参数，使用自身配置。' : '', login: loginStatus(a),
    relay: a.relay, baseUrl: detail?.baseUrl, keyName: detail?.keyEnv, keyMasked: detail?.keyMasked, testScope: agentTestScope(a), test: currentAgentTest(a) };
}
// Alternate PANEL_CONFIG instances keep their test cache beside that config.
const AGENT_TESTS_FILE = path.join(process.env.PANEL_CONFIG ? path.dirname(CONFIG_FILE) : path.join(HERE, 'logs'), 'agent-tests.json');
const tests = new Map(Object.entries(readJson(AGENT_TESTS_FILE, {}).results || {}).filter(([, t]) => ['ok', 'failed', 'timeout'].includes(t?.status)));
const activeAgentTests = new Map();
function agentTestScope(a, mode = a.auth.mode) {
  const auth = a.auth || authFor(a), p = mode === 'provider' && readProvidersFile().providers.find(p => p.id === auth.provider);
  const scope = mode === 'official' ? [a.id, mode] : [a.id, mode, auth.provider, p?.type, p?.baseUrl, auth.model];
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}
function latestAgentTest(a, mode = a.auth.mode) { return tests.get(agentTestScope(a, mode)) || null; }
function currentAgentTest(a) {
  const active = activeAgentTests.get(a.id);
  return active?.scope === agentTestScope(a) ? active : latestAgentTest(a);
}
function broadcastAgentTest(a, t) { broadcast('agenttest', { id: a.id, ...t, login: loginStatus(a) }); }
function testAgent(id) {
  const a = loadAgents().find(x => x.id === id);
  if (!a || !a.installed) throw new Error('agent 未安装');
  const active = activeAgentTests.get(id);
  if (active) {
    if (active.scope !== agentTestScope(a)) throw new Error('该 Agent 正在测试其他认证方式，请等测试结束后再测');
    return active;
  }
  const cwd = path.dirname(AGENT_TESTS_FILE); fs.mkdirSync(cwd, { recursive: true });
  const invocation = buildInvocation(a, 'Reply with exactly one word: OK', cwd);
  const t = { status: 'running', startedAt: Date.now(), output: '', authMode: a.auth.mode, provider: a.auth.provider || '', scope: agentTestScope(a) };
  activeAgentTests.set(id, t); broadcastAgentTest(a, t);
  const logFile = path.join(cwd, `test-${id}.log`); try { fs.unlinkSync(logFile); } catch {}
  const secret = a.auth.mode === 'provider' ? readProvidersFile().providers.find(p => p.id === a.auth.provider) : null, key = secret ? providerKey(secret) : '';
  let timer;
  const finish = code => {
    clearTimeout(timer); t.ms = Date.now() - t.startedAt; t.finishedAt = now(); t.code = code;
    t.authFailed = authErrorInOutput(t.output);
    const reply = t.output.replace(/^\$[^\r\n]*\r?\n/, ''); // launch echoes the prompt, which already contains OK.
    t.status = t.status === 'timeout' ? 'timeout' : code === 0 && !t.authFailed && /\bOK\b/i.test(reply) ? 'ok' : 'failed';
    t.output = safeProviderErrorOutput(t.output, key).slice(-1500);
    activeAgentTests.delete(id); tests.set(t.scope, t);
    try { writeJson(AGENT_TESTS_FILE, { version: 1, results: Object.fromEntries(tests) }); }
    catch { t.persistenceError = '测试结果保存失败，重启后可能丢失，请重新测连通。'; }
    broadcastAgentTest(a, t);
  };
  let child;
  try {
    child = launch(invocation, cwd, logFile, txt => { t.output = safeProviderErrorOutput(t.output + stripAnsi(txt), key); }, finish, a.name);
  } catch (e) { t.output = safeProviderErrorOutput(e.message, key); finish(-1); return t; }
  if (t.status === 'running') timer = setTimeout(() => { t.status = 'timeout'; killTree(child); }, 180000);
  return t;
}
function safeProviderErrorOutput(text, key) { return key ? text.split(key).join('[已隐藏]') : text; }
async function fetchModels(id) {
  const a = loadAgents().find(x => x.id === id);
  if (!a || a.auth.mode !== 'provider') throw new Error('请先选择服务商模式');
  return (await providerModels(a.auth.provider)).models;
}

// ---------- 目录浏览 ----------
function listDirs(dir) {
  if (!dir) {
    if (process.platform === 'win32') return { path: '', parent: null, dirs: 'CDEFGHIJ'.split('').map(d => `${d}:\\`).filter(isDir) };
    dir = '/';
  }
  const abs = path.resolve(dir);
  const dirs = fs.readdirSync(abs, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('$') && !['System Volume Information'].includes(e.name)).map(e => path.join(abs, e.name)).sort();
  const parent = path.dirname(abs) === abs ? '' : path.dirname(abs);
  return { path: abs, parent, dirs, isBmad: exists(path.join(abs, '_bmad')) };
}

// ---------- 技能库 ----------
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const PANEL_SKILLS = path.join(HERE, 'skills');
const readCatalog = () => readJson(path.join(PANEL_SKILLS, '_catalog.json'), { categories: [], skills: {} });
const SKILL_SOURCES = { panel: '精选库', project: '当前项目', 'user-claude': '~/.claude/skills', 'user-agents': '~/.agents/skills', 'user-codex': '~/.codex/skills', plugin: 'Claude 插件' };
function parseSkillMd(file) {
  const t = readMd(file);
  const fm = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const get = k => {
    if (!fm) return '';
    const lines = fm[1].split(/\r?\n/), i = lines.findIndex(l => l.startsWith(k + ':'));
    if (i < 0) return '';
    let v = lines[i].slice(k.length + 1).trim();
    if (/^[>|][-+]?$/.test(v)) { const buf = []; for (const l of lines.slice(i + 1)) { if (/^\s+\S/.test(l)) buf.push(l.trim()); else break; } v = buf.join(' '); }
    return v.replace(/^['"]|['"]$/g, '');
  };
  return { name: get('name'), description: get('description') };
}
const skillDirsIn = root => isDir(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && exists(path.join(root, e.name, 'SKILL.md'))).map(e => path.join(root, e.name)) : [];
function pluginSkillDirs() {
  const out = [];
  (function rec(d, depth) {
    if (depth > 9 || !isDir(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      const f = path.join(d, e.name);
      if (path.basename(d) === 'skills' && exists(path.join(f, 'SKILL.md'))) out.push(f); else rec(f, depth + 1);
    }
  })(path.join(HOME, '.claude', 'plugins'), 0);
  return out;
}
let skillCache = { at: 0, project: null, list: [] };
function scanSkills(projectRoot) {
  if (Date.now() - skillCache.at < 15000 && skillCache.project === projectRoot) return skillCache.list;
  const list = [], seen = new Set(), catalog = readCatalog();
  const add = (source, dir, plugin) => {
    try {
      const m = parseSkillMd(path.join(dir, 'SKILL.md')), name = m.name || path.basename(dir);
      const id = `${source}:${plugin ? plugin + ':' : ''}${name}`;
      if (seen.has(id)) return; seen.add(id);
      const cat = source === 'panel' ? (catalog.skills[path.basename(dir)] || catalog.skills[name] || {}) : {};
      list.push({ id, name, description: m.description, note: cat.note || '', category: cat.category || (source === 'panel' ? '自建' : ''), source, sourceLabel: SKILL_SOURCES[source] + (cat.category ? ` · ${cat.category}` : '') + (plugin ? ` · ${plugin}` : ''), dir, folder: path.basename(dir) });
    } catch {}
  };
  for (const d of skillDirsIn(PANEL_SKILLS)) add('panel', d);
  if (projectRoot) for (const base of ['.claude', '.agents']) for (const d of skillDirsIn(path.join(projectRoot, base, 'skills'))) add('project', d);
  for (const d of skillDirsIn(path.join(HOME, '.claude', 'skills'))) add('user-claude', d);
  for (const d of skillDirsIn(path.join(HOME, '.agents', 'skills'))) add('user-agents', d);
  for (const d of skillDirsIn(path.join(HOME, '.codex', 'skills'))) add('user-codex', d);
  for (const d of pluginSkillDirs()) {
    let up = path.dirname(path.dirname(d));
    if (/^v?\d+\.\d+|^[0-9a-f]{7,}$/.test(path.basename(up))) up = path.dirname(up);
    add('plugin', d, path.basename(up));
  }
  skillCache = { at: Date.now(), project: projectRoot, list };
  return list;
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.git')) copyDir(s, d); } else fs.copyFileSync(s, d);
  }
}
// 把技能装进项目的 .claude/skills 和 .agents/skills，五家 agent 都能原生加载
function installSkill(p, id) {
  const sk = scanSkills(p.root).find(s => s.id === id);
  if (!sk) throw new Error(`找不到技能 ${id}`);
  if (sk.source === 'project') return { ...sk, installedFolder: sk.folder };
  const folder = slug(sk.name);
  for (const base of ['.claude', '.agents']) { const dst = path.join(p.root, base, 'skills', folder); if (!exists(dst)) copyDir(sk.dir, dst); }
  skillCache.at = 0;
  return { ...sk, installedFolder: folder };
}
function skillsPrompt(p, ids) {
  const uniq = [...new Set(ids || [])];
  if (!uniq.length) return '';
  const lines = uniq.map(id => {
    try { const sk = installSkill(p, id); return `- **${sk.name}**：${(sk.description || '').slice(0, 220)}（${skillsBase(p)}/${sk.installedFolder}/SKILL.md）`; }
    catch (e) { return `- ${id}（不可用：${e.message}）`; }
  });
  return `\n## 本任务要用的技能（已装进项目；先读对应 SKILL.md，按其中流程执行）\n${lines.join('\n')}\n`;
}
function importSkill(projectRoot, id) {
  const sk = scanSkills(projectRoot).find(s => s.id === id);
  if (!sk) throw new Error('找不到这个技能');
  const dst = path.join(PANEL_SKILLS, slug(sk.name));
  if (exists(dst)) throw new Error('面板技能库里已有同名技能');
  copyDir(sk.dir, dst); skillCache.at = 0;
}
function createSkill({ name, description, body }) {
  const n = slug(name || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) throw new Error('技能名只能用小写字母、数字和短横线');
  const dir = path.join(PANEL_SKILLS, n);
  if (exists(dir)) throw new Error('面板技能库里已有同名技能');
  fs.mkdirSync(dir, { recursive: true });
  writeMd(path.join(dir, 'SKILL.md'), `---\nname: ${n}\ndescription: ${String(description || '').replace(/\r?\n/g, ' ')}\n---\n\n${body || ''}\n`);
  skillCache.at = 0;
  return `panel:${n}`;
}

// ---------- 工作流（Dify 式画布） ----------
const WF_TEMPLATES = path.join(HERE, 'workflows');
const automatic = st => ['auto', 'leader'].includes(st.mode);
const triageTimers = new Map();
const requirementText = p => exists(p.requirement) ? readMd(p.requirement).trim() : '';
const requirementId = text => createHash('sha256').update(text).digest('hex');
const isQuickWorkflow = g => g.template === 'quick-build' || g.id === 'quick-build';
function workflowStarted(p, st = loadState(p)) {
  // Filling the input is not substantive execution (nodeStates derives start=done).
  const g = readWorkflow(p), states = nodeStates(p, st, g);
  return !!st.wf?.substantiveStartedAt || g.nodes.some(n => n.type !== 'start' && ['done', 'running', 'waiting'].includes(states[n.id]?.status)) ||
    st.runs.some(r => !['tick', 'triage'].includes(r.kind) && (r.startedAt || ['queued', 'running', 'finished'].includes(r.status))) ||
    Object.values(st.stages || {}).some(s => ['running', 'review', 'approved'].includes(s.status));
}
function leaderWarning(st) { return automatic(st) && !st.leader ? '还没选 Leader，流程不会自动推进' : null; }
function ensureLeader(p) {
  const st = loadState(p);
  if (!automatic(st) || st.leader) return st;
  const agents = loadAgents();
  const candidate = ['claude', 'codex', 'grok', 'gemini', 'deepseek'].map(id => agents.find(a => a.id === id)).find(a => a?.available &&
    (a.auth.mode === 'provider' ? !!providerKey(readProvidersFile().providers.find(p => p.id === a.auth.provider)) : loginStatus(a).status === 'logged-in'));
  if (candidate) { st.leader = candidate.id; st.leaderAutoSelection = { at: now(), agent: candidate.id, name: candidate.name }; saveState(p, st); }
  return st;
}
function triageSnapshot(p, st) {
  return { triage: st.triage || null, triagePending: !!st.triagePending, workflowStarted: workflowStarted(p, st), leaderWarning: leaderWarning(st), leaderAutoSelection: st.leaderAutoSelection || null };
}
function triageTask(p, resultPath) {
  return `# 需求分诊（Leader）
只判断流程，不写实现、不做规划、不调用工具探索项目；仅把结果 JSON 写入指定路径。

需求原文：
${requirementText(p)}

模板：
- quick-build：需求 → 一人直接实现 → Leader 评审 → 完成。
- bmad-standard：需求 → PRD → 架构 → 拆分 Story → 开发看板 → 完成。
- proposal-pk：两家各出方案 → Leader 汇总比较。

判断标准（按需求本身，不能因为仓库有 BMAD 就选重流程）：
- small：单文件 / 单页面 / 小工具 / 演示动画 / 脚本，一个人一次能做完 → quick-build。
- medium/large：多模块、要持久化、多页面、需要拆多个 Story → bmad-standard。
- 明确要求“比较方案 / 选型 / 出几版看看” → proposal-pk（优先于规模规则）。
- quick-build 的 agent 从下列可用团队选择；适合实现需求即可，优先当前 Leader。
当前 Leader：${loadState(p).leader || '未选择'}
${roster(loadAgents().filter(a => a.available))}

把 JSON 写入 ${resultPath}（UTF-8，不要 Markdown 包裹）：
{ "size": "small|medium|large", "template": "quick-build|bmad-standard|proposal-pk", "reason": "一句话", "agent": "建议执行实现的 agent id（quick-build 用）" }
`;
}
function localTriage(p, why) {
  const text = requirementText(p), compare = /比较.{0,8}方案|方案.{0,8}(比较|对比|PK)|选型|出.{0,4}(几|多|两|三|[2-9]).{0,3}版|compare.{0,20}(solution|approach)|alternatives/i.test(text);
  const complex = /多模块|持久化|多页面|数据库|登录|登陆|注册|权限|后端|后台|多个\s*stor(?:y|ies)|multi[- ]?(page|module)|persist|database|login|backend/i.test(text);
  const small = /单文件|单页面|一个\s*(?:html|index\.html)|小工具|演示|动画|脚本|single[- ]?(file|page)|script/i.test(text);
  const size = complex || text.length > 600 ? (text.length > 1800 ? 'large' : 'medium') : small || text.length <= 160 ? 'small' : 'medium';
  return { size, template: compare ? 'proposal-pk' : size === 'small' ? 'quick-build' : 'bmad-standard', reason: `${why}；${compare ? '需求明确要求比较方案' : size === 'small' ? '需求简短且可由一人一次完成' : '涉及多个功能或持久化，需要拆分规划'}`, agent: loadState(p).leader || loadAgents().find(a => a.available)?.id || '' };
}
function applyTriageTemplate(p, template) {
  const st = loadState(p);
  if (workflowStarted(p, st)) throw new Error('工作流已开始实质运行，不能自动更换模板');
  const id = template || st.triage?.template;
  if (!['quick-build', 'bmad-standard', 'proposal-pk'].includes(id)) throw new Error('没有这个分诊模板');
  const g = readJson(path.join(WF_TEMPLATES, `${id}.json`), null);
  if (!g) throw new Error('没有这个模板');
  if (id === 'quick-build') {
    const recommended = loadAgents().find(a => a.id === st.triage?.agent && a.available);
    g.nodes.find(n => n.id === 'impl').config.agent = recommended?.id || st.leader || loadAgents().find(a => a.available)?.id || 'codex';
    g.nodes.find(n => n.id === 'review').config.agent = 'leader';
  }
  writeJson(p.workflow, { ...g, template: id });
  st.wf = { nodes: {}, running: !!st.wf?.running, startedAt: st.wf?.startedAt };
  if (st.triage) st.triage.applied = id;
  saveState(p, st); broadcast('workflow', {});
}
function requestTriage(p) {
  let st = loadState(p);
  const text = requirementText(p);
  if (workflowStarted(p, st)) return false;
  if (!text) {
    const old = st.triagePending?.runId;
    if (st.triagePending || st.triage) { delete st.triagePending; delete st.triage; delete st.triageInput; saveState(p, st); if (old) cancel(old, p); }
    return false;
  }
  const input = requirementId(text);
  if (st.triagePending?.input === input) return true;
  if (st.triageInput === input && st.triage) {
    if (automatic(st) && !st.triage.applied) applyTriageTemplate(p);
    return false;
  }
  if (st.triagePending?.runId) {
    const old = st.triagePending.runId;
    delete st.triagePending; saveState(p, st); cancel(old, p);
    st = loadState(p);
  }
  st.triagePending = { input, at: now() }; saveState(p, st);
  if (!st.leader) { finishTriage(p, { triageInput: input }, null, '未选择 Leader'); return false; }
  try { enqueue({ project: p.root, kind: 'triage', agentId: st.leader }); }
  catch (e) { finishTriage(p, { triageInput: input }, null, `Leader 分诊失败：${e.message}`); }
  return !!loadState(p).triagePending;
}
function finishTriage(p, run, result, why) {
  const st = loadState(p), pending = st.triagePending;
  if (!pending || pending.input !== run.triageInput || (run.id && pending.runId !== run.id)) return;
  delete st.triagePending;
  if (why === 'cancelled' || requirementId(requirementText(p)) !== pending.input || workflowStarted(p, st)) { saveState(p, st); return; }
  const valid = result && ['small', 'medium', 'large'].includes(result.size) && ['quick-build', 'bmad-standard', 'proposal-pk'].includes(result.template) && typeof result.reason === 'string' && result.reason.trim() &&
    (result.template === 'proposal-pk' || (result.size === 'small' ? result.template === 'quick-build' : result.template === 'bmad-standard'));
  const picked = valid ? result : localTriage(p, why || 'Leader 分诊结果无效');
  if (!valid && run.id) { const record = st.runs.find(r => r.id === run.id); if (record) { record.status = 'failed'; record.error = why || 'Leader 分诊结果无效'; } }
  st.triage = { at: now(), size: picked.size, template: picked.template, reason: picked.reason.trim().slice(0, 500), by: valid ? 'leader' : 'heuristic', agent: typeof picked.agent === 'string' ? picked.agent : st.leader };
  st.triageInput = pending.input; saveState(p, st);
  if (automatic(st)) applyTriageTemplate(p);
  broadcast('state', {});
  // Defer continuation so save/stop can complete and late triage exits cannot reapply.
  setImmediate(() => { try { advanceWorkflow(p); autoDispatch(p); if (!isQuickWorkflow(readWorkflow(p))) scheduleTick(p, '需求分诊完成'); } catch (e) { console.error('triage:', e.message); } });
}
function finishQuickReview(p, result) {
  const st = loadState(p), rec = st.wf.nodes.review || {};
  if (result?.verdict === 'approve') return setNode(p, 'review', { status: 'done', approvedAt: now(), approvedBy: 'leader', note: null });
  if (result?.verdict !== 'changes') return setNode(p, 'review', { status: 'failed', note: 'Leader 评审没有有效 verdict，请重试评审' });
  const rounds = (rec.rounds || 0) + 1;
  if (rounds > maxRounds(st)) return setNode(p, 'review', { status: 'waiting', note: `Leader 已打回 ${rounds - 1} 轮，仍有问题：${result.feedback || result.summary || ''}`, rounds });
  st.wf.nodes.review = { status: 'idle', rounds, review: result };
  st.wf.nodes.impl = { status: 'idle', rounds, feedback: result.feedback || result.summary || '请修复 Leader 列出的问题' };
  saveState(p, st);
}
function readWorkflow(p) {
  const g = readJson(p.workflow, null);
  if (g && Array.isArray(g.nodes)) return g;
  return readJson(path.join(WF_TEMPLATES, 'bmad-standard.json'), { nodes: [], edges: [] });
}
const listTemplates = () => isDir(WF_TEMPLATES) ? fs.readdirSync(WF_TEMPLATES).filter(f => f.endsWith('.json')).map(f => { const j = readJson(path.join(WF_TEMPLATES, f), {}); return { file: f, name: j.name || f, description: j.description || '' }; }) : [];
const preds = (g, id) => g.edges.filter(e => e.to === id).map(e => e.from);
function descendants(g, id) { const out = new Set(), st = [id]; while (st.length) { const x = st.pop(); for (const e of g.edges) if (e.from === x && !out.has(e.to)) { out.add(e.to); st.push(e.to); } } return [...out]; }
function storyProgress(p) {
  const parsed = parseEpics(p.epics), sprint = readSprint(p.sprint);
  const keys = parsed.stories.map(s => Object.keys(sprint).find(k => k.startsWith(`${s.epic}-${s.n}-`)));
  return { total: keys.length, done: keys.filter(k => k && sprint[k] === 'done').length };
}
function nodeStates(p, st, g) {
  const rec = (st.wf && st.wf.nodes) || {}, out = {};
  const reqFilled = exists(p.requirement) && readMd(p.requirement).trim();
  for (const n of g.nodes) {
    const c = n.config || {}, r = { ...(rec[n.id] || {}) };
    const running = st.runs.find(x => x.nodeId === n.id && ['queued', 'running'].includes(x.status));
    if (running) { r.status = 'running'; r.runId = running.id; r.lastLine = live.get(running.id) || running.lastLine; r.startedAt = running.startedAt; if (running.kind === 'nodereview') r.note = 'Leader 自动评审中'; }
    // 兼容旧版“阶段”记录：待确认 / 失败的阶段映射到对应节点
    const legacy = !r.status && n.type === 'agent' && c.preset && st.stages && st.stages[c.preset];
    if (legacy && ['review', 'failed'].includes(legacy.status)) { r.status = legacy.status === 'review' ? 'waiting' : 'failed'; r.result = legacy.result; r.agent = legacy.agent; }
    if (!r.status) {
      if (n.type === 'agent' && c.preset && findStageDoc(p, c.preset)) { r.status = 'done'; r.derived = true; }
      else if (n.type === 'start' && reqFilled) { r.status = 'done'; r.derived = true; }
      else r.status = 'idle';
    }
    if (n.type === 'agent' && c.preset) { const d = findStageDoc(p, c.preset); r.doc = d ? path.relative(p.root, d).replace(/\\/g, '/') : null; }
    else if (r.result && r.result.doc) r.doc = r.result.doc;
    if (n.type === 'dev') {
      r.progress = storyProgress(p);
      const planRun = st.runs.find(x => x.kind === 'plan' && ['queued', 'running'].includes(x.status));
      if (planRun) { r.lastLine = live.get(planRun.id) || 'Leader 正在分配…'; r.startedAt = planRun.startedAt; }
      if (r.status === 'running' && r.progress.total && r.progress.done === r.progress.total) r.status = 'done';
    }
    out[n.id] = r;
  }
  return out;
}
function setNode(p, id, patch) { const st = loadState(p); st.wf = st.wf || { nodes: {} }; st.wf.nodes = st.wf.nodes || {}; st.wf.nodes[id] = { ...(st.wf.nodes[id] || {}), ...patch }; saveState(p, st); }
const isLeaderRef = a => !a || a === 'leader';
function startNode(p, n, feedback) {
  const st = loadState(p), c = n.config || {};
  if (n.type !== 'start') { st.wf = st.wf || { nodes: {} }; st.wf.substantiveStartedAt ||= now(); saveState(p, st); }
  feedback ||= st.wf?.nodes?.[n.id]?.feedback;
  if (n.type === 'start') {
    if (!(exists(p.requirement) && readMd(p.requirement).trim())) return setNode(p, n.id, { status: 'waiting', note: '先在这个节点里填写需求' });
    return setNode(p, n.id, { status: 'done', finishedAt: now(), note: null });
  }
  if (n.type === 'end') return setNode(p, n.id, { status: 'done', finishedAt: now() });
  if (n.type === 'human') return setNode(p, n.id, automatic(st) ? { status: 'done', note: '自动模式：已跳过人工确认', finishedAt: now() } : { status: 'waiting' });
  if (n.type === 'dev') {
    setNode(p, n.id, { status: 'running', startedAt: now() });
    if (c.autoPlan !== false && !isLeaderMode(st) && !exists(p.plan) && st.leader && exists(p.epics)) { try { enqueue({ project: p.root, kind: 'plan', agentId: st.leader }); } catch {} }
    setTimeout(() => { try { autoDispatch(p); } catch (e) { console.error(e.message); } }, 0);
    return;
  }
  if (n.type === 'agent') {
    const who = isLeaderRef(c.agent) ? st.leader : c.agent;
    if (!who) return setNode(p, n.id, { status: 'failed', note: '没有选 agent，也没有设 leader' });
    try { enqueue({ project: p.root, kind: 'node', nodeId: n.id, agentId: who, feedback }); }
    catch (e) { setNode(p, n.id, { status: 'failed', note: e.message }); }
  }
}
function advanceWorkflow(p) {
  for (let round = 0; round < 30; round++) {
    let st = loadState(p);
    if (!st.wf || !st.wf.running) return;
    if (leaderWarning(st) || requestTriage(p)) return;
    st = loadState(p);
    const g = readWorkflow(p), ns = nodeStates(p, st, g);
    if (g.nodes.length && g.nodes.every(n => ns[n.id].status === 'done')) {
      // requestTriage may have just replaced the graph; always commit fresh state.
      const done = loadState(p); done.wf.running = false; done.wf.finishedAt = now();
      if (isLeaderMode(done) && isQuickWorkflow(g)) { done.leaderBoard = { ...(done.leaderBoard || {}), finished: { at: now(), summary: ns.review?.result?.summary || '快速实现已完成，Leader 评审通过。' }, progress: { is_done: true, making_progress: true, is_looping: false, reason: '快速实现及 Leader 评审已完成' } }; }
      saveState(p, done); broadcast('state', {}); return;
    }
    const ready = g.nodes.filter(n => ns[n.id].status === 'idle' && preds(g, n.id).every(id => ns[id] && ns[id].status === 'done'));
    if (!ready.length) return;
    for (const n of ready) startNode(p, n);
    broadcast('state', {});
  }
}
function nodeTask(p, nodeId, st, resultPath, feedback) {
  const g = readWorkflow(p), n = g.nodes.find(x => x.id === nodeId);
  if (!n) throw new Error('节点不存在');
  const c = n.config || {};
  const skillsBlock = skillsPrompt(p, [...(c.skills || []), ...(isLeaderRef(c.agent) ? (st.leaderSkills || []) : [])]);
  const extra = c.prompt ? `\n## 这个节点的额外要求\n${c.prompt}\n` : '';
  const autoExtra = isAuto(st) ? skillCatalog(p) : '';
  if (c.preset) return stageTask(p, c.preset, st, resultPath, feedback) + skillsBlock + decisionsBlock(st) + extra + autoExtra;
  const ns = nodeStates(p, st, g);
  const ups = preds(g, nodeId).map(id => { const u = g.nodes.find(x => x.id === id), r = ns[id] || {}; return `  - ${u ? u.title : id}${r.doc ? `：文档 ${r.doc}` : ''}${r.result && r.result.summary ? `；摘要：${r.result.summary}` : ''}`; }).join('\n');
  return `# 节点任务：${n.title}

项目根目录：${p.root}

## 输入
- 需求原文：_bmad-output/panel/requirement.md
${ups ? `- 上游节点产出：\n${ups}` : ''}
${feedback ? `\n## 用户对上一版的修改意见（必须逐条处理）\n${feedback}\n` : ''}
## 要求
${commonRules(p)}
${skillsBlock}
${decisionsBlock(st)}${autoExtra}
## 指令
${c.prompt || '（未填写具体指令：根据上游产出，完成本节点标题所描述的工作）'}
${isQuickWorkflow(g) ? `界面验证使用无头工具（不打开窗口）：${UI_TOOL}` : ''}
${c.outputDoc ? `\n产出文档写到：${c.outputDoc}\n` : ''}
## 输出（必须）
把下面格式的 JSON 写入 ${resultPath}（UTF-8，不要 Markdown 包裹）：
${isQuickWorkflow(g) && nodeId === 'review' ? '{"verdict":"approve 或 changes","feedback":"changes 时逐条写清需要修复的问题","doc":"","summary":"三句话以内","open_questions":[]}' : '{"doc":"产出文档相对路径（没有就留空）","summary":"三句话以内","open_questions":["..."]}'}
`;
}
function wfSnapshot(p) {
  const st = loadState(p), g = readWorkflow(p);
  return { ...triageSnapshot(p, st), graph: g, states: nodeStates(p, st, g), running: !!(st.wf && st.wf.running), templates: listTemplates(), requirement: exists(p.requirement) ? readMd(p.requirement) : '' };
}

// ---------- 自动模式（Leader 自动评审、自动选技能、自动派发） ----------
const isAuto = st => st.mode === 'auto';
const maxRounds = st => st.maxRounds || 2;
function skillCatalog(p) {
  const list = scanSkills(p.root).filter(s => s.source === 'panel' || s.source === 'project');
  return `\n## 技能库目录（自动模式：从中挑和本任务相关的技能，先读对应 SKILL.md 再按其流程做；结果 JSON 里加 "skills_used":["技能 id"]）\n` +
    list.map(s => `- ${s.id}｜${s.note || (s.description || '').replace(/\s+/g, ' ').slice(0, 140)}｜${path.join(s.dir, 'SKILL.md')}`).join('\n') + '\n';
}
function decisionsBlock(st) {
  const ds = Object.values((st.wf && st.wf.nodes) || {}).flatMap(n => n.decisions || []);
  return ds.length ? `\n## 已确认的决定（Leader 评审时拍板，必须遵守）\n${ds.map((d, i) => `${i + 1}. ${d}`).join('\n')}\n` : '';
}
function nodeReviewTask(p, nodeId, st, resultPath) {
  const g = readWorkflow(p), n = g.nodes.find(x => x.id === nodeId), r = ((st.wf || {}).nodes || {})[nodeId] || {};
  const doc = (r.result && r.result.doc) || (n.config && n.config.preset && findStageDoc(p, n.config.preset) && path.relative(p.root, findStageDoc(p, n.config.preset)));
  return `# 你的角色：Leader 评审（自动模式）——判断「${n.title}」的产出能不能进入下一步；只读，不改任何文件

项目根目录：${p.root}

## 输入
- 需求原文：_bmad-output/panel/requirement.md
- 本节点产出文档：${doc || '（见下方结果）'}
- 节点额外要求：${(n.config && n.config.prompt) || '（无）'}
- 执行者自报结果：
${JSON.stringify(r.result || {}, null, 2)}
${decisionsBlock(st)}
## 任务
1. 读产出文档，对照需求和上游文档检查：是否完整、是否和需求冲突、下一步能不能直接用。
2. 执行者列出的开放问题，你按需求的精神逐条拍板，写进 decisions（每条一句话，具体可执行）。
3. 只有会让下一步做错的问题才判 changes；措辞、格式类小问题不要打回。

## 输出（必须）
把下面格式的 JSON 写入 ${resultPath}（UTF-8，不要 Markdown 包裹）：
{"verdict":"approve 或 changes","feedback":"changes 时写给执行者的修改意见","decisions":["对开放问题的决定"],"comments":["评审要点"]}
`;
}
function autoAfterRun(p, run, result) {
  const st = loadState(p);
  if (run.kind === 'nodereview') {
    const g = readWorkflow(p), n = g.nodes.find(x => x.id === run.nodeId);
    if (!n) return;
    const rec = (st.wf && st.wf.nodes && st.wf.nodes[run.nodeId]) || {};
    if (!result) return setNode(p, n.id, { status: 'waiting', note: 'Leader 自动评审没出结果，等你确认' });
    if (result.verdict === 'approve') {
      setNode(p, n.id, { status: 'done', approvedAt: now(), approvedBy: 'leader', decisions: result.decisions || [], review: result, note: null, stale: false });
      const s2 = loadState(p);
      for (const d of descendants(g, n.id)) if (s2.wf.nodes[d] && s2.wf.nodes[d].status === 'done') s2.wf.nodes[d].stale = true;
      saveState(p, s2);
      if ((n.config || {}).preset === 'epics') refreshSprint(p).then(() => { advanceWorkflow(p); autoDispatch(p); broadcast('state', {}); }).catch(e => console.error(e.message));
      return;
    }
    const rounds = (rec.rounds || 0) + 1;
    if (rounds > maxRounds(st)) return setNode(p, n.id, { status: 'waiting', review: result, note: `Leader 已打回 ${rounds - 1} 轮仍未通过，等你决定` });
    setNode(p, n.id, { rounds, review: result, decisions: result.decisions || [], status: 'idle' });
    startNode(p, n, [result.feedback, ...(result.decisions || []).map(d => '决定：' + d)].filter(Boolean).join('\n'));
    return;
  }
  if (!isAuto(st)) return;
  if (run.kind === 'plan' && result) {
    result = normalizePlan(p, result);
    const avail = new Set(loadAgents().filter(a => a.available).map(a => a.id));
    for (const a of result.assignments || []) st.assignments[a.key] = avail.has(a.agent) ? a.agent : st.leader;
    saveState(p, st);
  }
  if (run.kind === 'review' && run.storyKey && result) {
    st.autoRounds = st.autoRounds || {};
    if (result.verdict === 'approve') { delete st.feedback[run.storyKey]; saveState(p, st); try { setStoryStatus(p, run.storyKey, 'done'); } catch (e) { console.error(e.message); } }
    else {
      const n = (st.autoRounds[run.storyKey] || 0) + 1; st.autoRounds[run.storyKey] = n;
      if (n <= maxRounds(st)) { st.feedback[run.storyKey] = [...(result.comments || []), ...(result.rule_violations || [])].join('\n') || 'Leader 评审未通过'; saveState(p, st); try { setStoryStatus(p, run.storyKey, 'ready-for-dev'); } catch (e) { console.error(e.message); } }
      else saveState(p, st); // 超过轮数：留在“待审核”等人
    }
  }
  if (run.kind === 'implement' && run.storyKey && !result) {
    st.autoRounds = st.autoRounds || {}; st.autoRounds[run.storyKey] = (st.autoRounds[run.storyKey] || 0) + 1; saveState(p, st);
  }
}
function autoDispatch(p) {
  const st = loadState(p);
  if (!isAuto(st) || !st.leader) return;
  const g = readWorkflow(p), ns = nodeStates(p, st, g), dev = g.nodes.find(n => n.type === 'dev');
  if (!dev || ns[dev.id].status !== 'running' || !exists(p.epics) || !exists(p.sprint)) return;
  const plan = readPlan(p);
  if (!plan) { if (!st.runs.some(r => r.kind === 'plan' && ['queued', 'running'].includes(r.status))) { try { enqueue({ project: p.root, kind: 'plan', agentId: st.leader }); } catch (e) { console.error(e.message); } } return; }
  const snap = snapshot(p.root), active = new Set(st.runs.filter(r => ['queued', 'running'].includes(r.status)).map(r => r.storyKey));
  const statusOf = k => (snap.stories.find(s => s.key === k) || {}).status;
  for (const s of snap.stories) {
    if (active.has(s.key)) continue;
    const rounds = (st.autoRounds || {})[s.key] || 0;
    if (rounds > maxRounds(st)) continue;
    if (['backlog', 'ready-for-dev'].includes(s.status)) {
      const a = (plan.assignments || []).find(x => x.key === s.key);
      if ((a && a.depends_on || []).some(k => statusOf(k) !== 'done')) continue; // 对不上号的依赖也算没完成，宁可等
      const agent = st.assignments[s.key] || st.leader;
      if (!st.assignments[s.key]) { const s2 = loadState(p); s2.assignments[s.key] = agent; saveState(p, s2); }
      try { enqueue({ project: p.root, kind: 'implement', storyKey: s.key, agentId: agent }); active.add(s.key); } catch (e) { console.error(e.message); }
    } else if (s.status === 'review') {
      const lastImpl = [...st.runs].reverse().find(r => r.storyKey === s.key && r.kind === 'implement');
      const lastRev = [...st.runs].reverse().find(r => r.storyKey === s.key && r.kind === 'review');
      if (!lastRev || (lastImpl && lastRev.createdAt < lastImpl.createdAt)) { try { enqueue({ project: p.root, kind: 'review', storyKey: s.key, agentId: st.leader }); active.add(s.key); } catch (e) { console.error(e.message); } }
    }
  }
}
function resumeAutomaticNodes(p) {
  const st = loadState(p);
  if (!automatic(st) || !st.leader) return;
  const g = readWorkflow(p), ns = nodeStates(p, st, g);
  for (const n of g.nodes) {
    if (ns[n.id].status !== 'waiting') continue;
    if (n.type === 'human') setNode(p, n.id, { status: 'done', note: '自动模式：已跳过人工确认', finishedAt: now() });
    else if (isQuickWorkflow(g) && n.id === 'review') {
      if (['approve', 'changes'].includes(ns[n.id].result?.verdict)) finishQuickReview(p, ns[n.id].result);
      else setNode(p, n.id, { status: 'idle', note: null });
    } else if (n.type === 'agent' && isAuto(st)) {
      try { enqueue({ project: p.root, kind: 'nodereview', nodeId: n.id, agentId: st.leader }); } catch (e) { console.error(e.message); }
    }
  }
}
function setMode(p, mode, rounds) {
  let st = loadState(p);
  if (mode) st.mode = ['auto', 'leader'].includes(mode) ? mode : 'manual';
  if (st.mode === 'leader') { st.wf = st.wf || { nodes: {} }; st.wf.running = true; st.leaderBoard = { ...(st.leaderBoard || {}), error: null, idleTicks: 0, finished: null }; }
  if (rounds) st.maxRounds = Math.max(1, Math.min(5, +rounds));
  saveState(p, st);
  if (mode && automatic(st)) st = ensureLeader(p);
  if (mode && automatic(st)) resumeAutomaticNodes(p);
  if (isLeaderMode(st)) { advanceWorkflow(p); scheduleTick(p, '切换到 Leader 统筹'); return; }
  if (isAuto(st)) {
    advanceWorkflow(p); autoDispatch(p);
  }
}

// ---------- Leader 统筹模式 ----------
// 参考 Magentic-One 的 Orchestrator：Task Ledger（全局笔记：事实、计划、风险）+ Progress Ledger（每轮判断是否完成、
// 是否在兜圈子、下一步谁做什么）；以及 LangGraph supervisor：成员做完都回到 Leader，由 Leader 决定下一步。
const isLeaderMode = st => st.mode === 'leader';
const KIND_CN = { triage: '需求分诊', plan: '分配', implement: '执行 Story', review: '评审', node: '工作流节点', nodereview: '节点评审', task: '临时任务', stage: '阶段', tick: 'Leader 唤醒' };
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const resultOf = (p, r) => readAgentResult(p, r);
function fullStoryKey(p, k) {
  if (!k) return k;
  const keys = Object.keys(readSprint(p.sprint)).filter(x => /^\d+-\d+-/.test(x));
  const t = String(k).trim().replace(/^story\s*/i, '');
  if (keys.includes(t)) return t;
  const m = t.match(/^(\d+)[.\-_](\d+)/);
  return (m && keys.find(x => x.startsWith(`${m[1]}-${m[2]}-`))) || t;
}
const UI_TOOL = `node ${UI_CHECK} --root <项目目录> --steps <步骤.json> --out <结果.json>`;
const isUiStory = st => /界面|UI|按钮|工具栏|网格|显示|样式|格式|列宽|键盘|焦点|选区|标签|对话框|页面|交互|拖动|点击|输入框|公式栏/.test((st.title || '') + (st.body || ''));
function recommendSkills(p, story) {
  const have = new Set(scanSkills(p.root).map(x => x.id)), text = (story.title || '') + (story.body || ''), out = [];
  if (isUiStory(story)) out.push('panel:headless-ui-check', 'panel:frontend-design', 'panel:ui-design-system', 'panel:a11y-audit');
  if (/公式|引擎|解析|求值|计算|依赖|算法|模型|协议|状态机/.test(text)) out.push('panel:test-driven-development', 'panel:systematic-debugging');
  if (/导入|导出|保存|存储|CSV|JSON|文件|序列化|恢复/.test(text)) out.push('panel:test-driven-development', 'project:bmad-review');
  if (/安全|权限|登录|密钥|认证|加密/.test(text)) out.push('panel:security-best-practices');
  if (/Docker|容器|部署|nginx|监控|告警|日志|故障|运维|数据库|PostgreSQL|SQL/i.test(text)) out.push('panel:docker-development', 'panel:postgres-pro', 'panel:monitoring-expert');
  if (exists(path.join(p.root, 'docs', 'embedded-standards.md')) || /固件|MCU|单片机|STM32|ESP32|RTOS|FreeRTOS|中断|外设|驱动|GPIO|UART|SPI|I2C|ADC|PWM|定时器|低功耗|寄存器|HAL|Bootloader/i.test(text)) out.push('panel:embedded-systems');
  if (/选型|传感器|开发板|IoT|物联网|MQTT|BLE|蓝牙|WiFi|LoRa/i.test(text)) out.push('panel:embedded-iot-mentor');
  if (/C\+\+|cpp|模板元|RAII|智能指针/i.test(text)) out.push('panel:cpp-pro');
  if (/测试策略|测试用例|测试架构|覆盖率|mock|桩|单元测试|集成测试|端到端|e2e|回归测试|测试框架|自动化测试/i.test(text)) out.push('panel:test-master');
  if (/性能|卡顿|变慢|很慢|太慢|慢查询|内存占用|泄漏|延迟|吞吐|性能优化|优化性能|提速/i.test(text)) out.push('panel:performance-profiler');
  if (/文档|使用说明|说明文档|README|使用指南|注释|API 文档|快速上手/i.test(text)) out.push('panel:code-documenter');
  if (/发布说明|发版|版本号|版本发布|更新日志|changelog|release notes|语义化版本|semver/i.test(text)) out.push('panel:changelog-generator');
  out.push('project:bmad-build', 'panel:verification-before-completion');
  let selected = [...new Set(out)].filter(id => have.has(id));
  if (selected.length > 6) {
    // 先为实际存在的两个保底技能预留槽位；过滤缺失项后再截断，避免浪费名额。
    const required = ['project:bmad-build', 'panel:verification-before-completion'].filter(id => have.has(id));
    // 超限时：嵌入式（系统 > IoT > C++）> 界面（沿用原顺序）> 其他（原匹配顺序）。
    // 系统技能排第一，确保嵌入式项目的每个 Story（包括界面 Story）都保留它。
    const priority = ['panel:embedded-systems', 'panel:embedded-iot-mentor', 'panel:cpp-pro', 'panel:headless-ui-check', 'panel:frontend-design', 'panel:ui-design-system', 'panel:a11y-audit'];
    const ranked = [...priority.filter(id => selected.includes(id)), ...selected.filter(id => !priority.includes(id) && !required.includes(id))];
    selected = [...ranked.slice(0, 6 - required.length), ...required];
  }
  return selected.filter(id => have.has(id));
}
const ACCEPT_SKILLS = ['panel:review-agent', 'panel:verification-before-completion', 'project:bmad-qa-generate-e2e-tests', 'panel:headless-ui-check'];
function crossCheckDone(p, st, key) {
  const lastImpl = [...st.runs].reverse().find(r => r.storyKey === key && r.kind === 'implement' && r.status === 'finished');
  if (!lastImpl) return { ok: false, why: '还没有成功的实现' };
  const qa = [...st.runs].reverse().find(r => r.kind === 'task' && r.relatedStory === key && /^交叉验收/.test(r.title || '') && r.status === 'finished' && r.createdAt > lastImpl.createdAt);
  if (!qa) return { ok: false, why: '最近一次实现之后还没有完成的交叉验收（临时任务，标题以“交叉验收”开头，story 填这个 Story）' };
  const avail = loadAgents().filter(a => a.available).length;
  if (avail > 1 && qa.agent === lastImpl.agent) return { ok: false, why: `交叉验收必须由实现者（${lastImpl.agent}）以外的 agent 做` };
  return { ok: true, qa };
}
const ACCEPT_LEVELS = { fast: '快速', standard: '标准', strict: '严格' };
const acceptLevel = st => ACCEPT_LEVELS[st.acceptLevel] ? st.acceptLevel : 'fast'; // 老板要好看好用，默认不较真
function acceptRules(level) {
  const noRepeat = '   · 交叉验收通过后、代码没再改过（最近一次实现早于交叉验收）就不要再派交叉验收，不做“证据刷新”这类重复劳动。';
  if (level === 'fast') return `1. 验收档位：快速（老板要的是好看好用，不用较真）。
   a. 只看两点：能用——复跑一次 node --test，主要操作走得通；好看好用——界面统一清爽、常用操作顺手、提示清楚。两点都过就标 done，evidence 一两句即可。
   b. 不派交叉验收，不逐条取证；只有测试失败、主要功能用不了、或界面明显难看难用才打回。
   c. 界面类 Story 鼓励带 panel:ui-design-system、panel:frontend-design 做视觉打磨。`;
  if (level === 'strict') return `1. 验收档位：严格（面板会强制检查）。
   a. Story 进入 review 后，先派「交叉验收」临时任务：title 以“交叉验收”开头，story 填该 Story，agent 必须不是实现者；skills 至少带 project:bmad-qa-generate-e2e-tests、panel:review-agent，界面类再带 panel:headless-ui-check。只加测试不改产品代码，逐条报告验收标准通过与否。
   b. 交叉验收回来后，你自己复跑 node --test 和对应的 ui-check 步骤文件，确认结果属实。
   c. 标 done 时 evidence 逐条覆盖该 Story 的每一条验收标准；界面行为必须是 ui-check 实测；任何一条不通过就打回原负责人，失败步骤写进 feedback。
${noRepeat}`;
  return `1. 验收档位：标准（由你亲自验收，面板会检查证据）。
   a. Story 进入 review 后，你自己验收：读改动、复跑 node --test；界面类必须跑 ui-check（优先用实现者留下的 test/acceptance/<key>.steps.json，缺了就自己写一份）。
   b. 标 done 时 evidence 逐条覆盖该 Story 的验收标准且全部通过；界面行为必须有 ui-check 实测，只读代码不算。
   c. 交叉验收不强制：只有你拿不准（改动大、涉及安全或数据、或实现者是同一个 agent 反复失败）时才派，派了就按交叉验收规则写。
${noRepeat}`;
}
function leaderBrief(p, resultPath) {
  const st = loadState(p), snap = snapshot(p.root), g = readWorkflow(p), ns = nodeStates(p, st, g), L = st.leaderBoard || {};
  const lastTick = [...st.runs].reverse().find(r => r.kind === 'tick' && r.hasResult), lastResult = readAgentResult(p, lastTick);
  const encodingReminder = L.encodingBroken || hasBrokenEncoding({ notes: L.notes, summary: L.finished?.summary }) || hasBrokenEncoding(lastResult)
    ? '上一轮你写的 notes / summary 编码损坏成了问号，请用 UTF-8 文件方式重写' : '';
  const since = L.lastTickAt || '1970';
  const req = exists(p.requirement) ? readMd(p.requirement) : '';
  const nodes = g.nodes.map(n => { const s = ns[n.id]; return `- ${n.id}｜${n.title}｜${n.type}${n.config && n.config.preset ? '/' + n.config.preset : ''}｜${s.status}${s.doc ? '｜文档 ' + s.doc : ''}${s.result && s.result.open_questions && s.result.open_questions.length ? `｜执行者列了 ${s.result.open_questions.length} 个开放问题` : ''}`; }).join('\n');
  const stories = snap.stories.map(s => {
    const impl = [...st.runs].reverse().find(r => r.storyKey === s.key && r.kind === 'implement'), res = resultOf(p, impl);
    const a = snap.plan && (snap.plan.assignments || []).find(x => x.key === s.key);
    const tries = st.runs.filter(r => r.storyKey === s.key && r.kind === 'implement' && ['finished', 'failed'].includes(r.status)).length;
    const cc = s.status === 'review' ? crossCheckDone(p, st, s.key) : null;
    return `- ${s.key}｜${s.title}｜${s.status}｜负责人 ${s.agent || '未分配'}｜${isUiStory(s) ? '界面类' : '非界面'}｜推荐技能 ${recommendSkills(p, s).join(',')}${cc ? '｜交叉验收：' + (cc.ok ? '已完成（' + cc.qa.agent + '）' : '未完成') : ''}｜已执行 ${tries} 次${a && a.depends_on && a.depends_on.length ? '｜建议依赖 ' + a.depends_on.map(k => k.split('-').slice(0, 2).join('.')).join(',') : ''}${impl ? `｜最近执行 ${impl.status}` : ''}${res ? `｜结果：${clip(res.summary, 160)}；测试${res.tests ? (res.tests.passed ? '通过' : '未通过') : '未报'}` : ''}${s.feedback ? '｜打回意见：' + clip(s.feedback, 160) : ''}`;
  }).join('\n');
  const active = st.runs.filter(r => !['tick', 'triage'].includes(r.kind) && ['queued', 'running'].includes(r.status));
  const agents = snap.agents.map(a => `- ${a.id}（${a.name}）｜${a.available ? '可用' : '不可用，不要派'}｜进行中 ${active.filter(r => r.agent === a.id).length}｜${a.strengths}`).join('\n');
  const fresh = st.runs.filter(r => r.kind !== 'tick' && r.endedAt && r.endedAt > since).map(r => {
    const res = resultOf(p, r);
    return `### ${KIND_CN[r.kind] || r.kind}｜${r.agent}｜${r.storyKey || r.nodeId || r.title || ''}｜${r.status}${r.error ? '｜' + r.error : ''}
${res ? clip(JSON.stringify(res), 1500) : '（没有结果文件）'}${r.changedFiles && r.changedFiles.length ? `\n改动文件：${r.changedFiles.slice(0, 30).join(', ')}` : ''}`;
  }).join('\n\n');
  const answers = (L.answers || []).map(a => `- 问：${a.q}\n  答：${a.a}`).join('\n');
  const recent = (L.log || []).slice(-6).map(t => `- ${t.at.slice(11, 16)} ${t.actions.map(x => `${x.type}${x.story ? ':' + x.story.split('-').slice(0, 2).join('.') : x.node ? ':' + x.node : x.title ? ':' + x.title : ''}${x.outcome && x.outcome !== 'ok' ? '（' + x.outcome + '）' : ''}`).join('、') || '（无动作）'}`).join('\n');
  return `# 你是这个项目的 Leader（主管）。你统筹全局：看清现状，决定下一步谁做什么。你自己不写实现代码。

## 你和老板的关系
老板是**客户**，不是测试员。质量由你和团队负责：验收、复验、回归都由你安排完成，不要把测试工作推给老板。
只有这些情况才 ask_human：需求本身有歧义或互相冲突、要在范围 / 时间 / 体验之间做取舍、需要老板提供的信息（账号、素材、偏好）。一次只问一个问题，给出 2～3 个选项和你的推荐。

项目根目录：${p.root}
这是第 ${(L.ticks || 0) + 1} 次唤醒你。

## 目标（需求原文）
${clip(req, 4000) || '（还没有需求）'}

## 你的全局笔记（上一轮你自己写的：已知事实、计划、风险）
${encodingReminder ? `提示：${encodingReminder}\n` : ''}
${L.notes || '（第一次唤醒：先建立笔记）'}

## 规划节点（工作流）
${nodes || '（无）'}

## Story 看板（状态以 sprint-status.yaml 为准）
${stories || '（还没有 Story：拆分节点通过后才有）'}

## 团队
${agents}
同时最多运行 ${config.maxParallel} 个任务（不含你自己）。

## 正在运行
${active.map(r => `- ${KIND_CN[r.kind] || r.kind}｜${r.agent}｜${r.storyKey || r.nodeId || r.title || ''}｜${r.status}`).join('\n') || '（无）'}

## 自上次唤醒以来完成的任务（逐个验收）
${fresh || '（无）'}

## 老板的回答
${answers || '（无）'}
${decisionsBlock(st)}
## 你最近几轮的动作
${recent || '（无）'}
${skillsPrompt(p, [...new Set([...(st.leaderSkills || []), ...ACCEPT_SKILLS])])}${skillCatalog(p)}
## 你能做的动作（actions 数组里的元素）
- {"type":"approve_node","node":"<节点 id>"}：规划节点“waiting（待确认）”时，读过文档觉得能用就通过，会自动进入下一个节点
- {"type":"rerun_node","node":"<节点 id>","feedback":"..."}：规划节点产出有问题，带意见重做
- {"type":"dispatch","agent":"<agent id>","story":"<完整 story key>","instructions":"给执行者的具体指令","skills":["技能 id"],"writes":["预计改动的文件或目录"]}：派 Story
- {"type":"dispatch","agent":"<agent id>","title":"临时任务标题","story":"相关 story key（可空）","instructions":"...","skills":[],"writes":[]}：派临时任务（整合、补文档等）；带了 title 就是临时任务
- {"type":"set_status","story":"<key>","status":"done 或 ready-for-dev","feedback":"打回时写具体问题","evidence":[{"criterion":"验收标准原文","method":"ui-check | node-test | code-read","detail":"测试名 / 步骤文件和步骤 / 读了哪段代码","pass":true}]}：验收 Story。标 done 时 evidence 必须覆盖每一条验收标准且全部 pass，否则面板拒绝
- {"type":"ask_human","question":"..."}：只有必须老板拍板的事才问，会暂停等回答
- {"type":"finish","summary":"写给客户的交付说明"}：所有 Story 都 done、需求满足时宣布结束。summary 用客户能看懂的话写：怎么打开和使用、实现了哪些需求、已知限制；需要客户亲自确认的事最多 3 条，只列自动化确实验证不了的（例如和真 Excel 之间的剪贴板往返）

## 规则
${acceptRules(acceptLevel(st))}
2. 方案里的依赖是当初的保守估计，你可以读代码判断实际依赖：接口已稳定、改动文件不重叠的 Story 可以并行派。正在运行的不要重复派；同时运行的任务 writes 不能重叠（派活时必须写 writes）。
3. 有空闲 agent、有可做的事就派满（不超过并发上限）；按特长分配，别让一个人包揽。
4. 同一个 Story 执行超过 3 次还不行，就换人、拆成临时任务，或 ask_human。
5. 判断有没有在兜圈子（同样的失败反复出现、没有进展），有就换思路，并写进笔记。
6. 严格按上面的实际工作流推进；只有图中包含 PRD / 架构 / 拆分节点时才走 BMAD，不能自行增加这些步骤。没有开发看板的工作流无需 Story；所有节点完成即可交付。规划节点的开放问题由你拍板，把决定写进 approve_node 前的笔记里。不要重复派发已经由图调度的节点任务。
7. 没有可做的事、只需等正在运行的任务时，actions 给空数组即可。
8. 不要派需要打开浏览器窗口、操作桌面、读写系统剪贴板、安装软件的任务。界面实测一律用 ui-check 无头工具（这是允许的，不冲突），能自动测的都要测。实在测不了的（真实系统剪贴板、和真 Excel 往返、下载对话框）才留给客户，最多 3 条，写在 finish 的 summary 里。
9. 派 Story 时，该 Story 的“推荐技能”会由面板自动带上，skills 里不用重复写；只写推荐之外你认为这次还需要的技能（技能库里挑，可空）。
10. 修复类问题优先打回给原负责人：先 set_status 为 ready-for-dev 并写清 feedback，再 dispatch 同一个 story 给原负责人。原负责人失败 3 次以上才换人或开临时任务。
11. 结果为 blocked 的 Story 也要处理：看清阻塞原因，打回原负责人或拆小。
12. 临时任务必须带 "story" 字段注明属于哪个 Story（无关则留空），看板会显示。

## 输出（必须）
把下面格式的 JSON 写入 ${resultPath}（UTF-8，不要 Markdown 包裹）：
{"notes":"更新后的全局笔记（300 字内：已完成、进行中、风险、下一步）","progress":{"is_done":false,"is_looping":false,"making_progress":true,"reason":"一句话"},"actions":[]}
`;
}
function taskTask(p, title, instructions, skills, resultPath, relatedStory) {
  const st = loadState(p);
  const story = relatedStory ? parseEpics(p.epics).stories.find(x => relatedStory.startsWith(`${x.epic}-${x.n}-`)) : null;
  const qa = /^交叉验收/.test(title || '');
  const qaBlock = !qa ? '' : `
## 交叉验收规则
- 你是验收方，不是实现方：只加测试、不改产品代码（src/ 等实现文件一律不动）。
- 逐条对照下面的验收标准写测试：核心逻辑写进 node --test 能跑的测试；界面行为写 test/acceptance/${relatedStory}.steps.json，用无头界面测试工具实测（用法见技能 headless-ui-check）：
  ${UI_TOOL}
- 报告里每条标准一行：标准 | 方法 | 测试名或步骤 | 通过/不通过 | 不通过时的实际表现。
- 结果 JSON 额外加 "criteria":[{"criterion":"...","method":"ui-check|node-test|code-read","detail":"...","pass":true}]。
${story ? `\n## 这个 Story 的验收标准（epics.md 原文）\n${story.title}\n${story.body}\n` : ''}`;
  return `# 临时任务：${title}（Leader 派给你）

项目根目录：${p.root}

## 指令
${instructions || '（见标题）'}
${qaBlock}
${skillsPrompt(p, [...(skills || []), ...(qa ? ACCEPT_SKILLS : [])])}${decisionsBlock(st)}
## 要求
- 先读 AGENTS.md 以及它引用的约束文件。
- 不要修改 sprint-status.yaml 和 _bmad-output/panel/ 下的文件。
${FORBIDDEN}
## 输出（必须）
完成后把下面格式的 JSON 写入 ${resultPath}（UTF-8，不要 Markdown 包裹）：
{"summary":"做了什么","files_changed":["相对路径"],"tests":{"command":"...","passed":true},"manual_checks":["需要人工确认的项"]}
`;
}
function scheduleTick(p, why) {
  const st = loadState(p);
  if (!isLeaderMode(st) || !st.leader) return;
  if (!st.wf?.running || !requirementText(p) || st.triagePending || requestTriage(p) || isQuickWorkflow(readWorkflow(p))) return;
  const L = st.leaderBoard = st.leaderBoard || {};
  if (L.finished || (L.ask && !L.ask.answered) || L.error) return;
  if (st.runs.some(r => r.kind === 'tick' && ['queued', 'running'].includes(r.status))) { L.pending = true; saveState(p, st); return; }
  if ((L.ticks || 0) >= 300) { L.error = 'Leader 唤醒次数达到上限 300，已暂停'; saveState(p, st); return; }
  saveState(p, st);
  try { enqueue({ project: p.root, kind: 'tick', agentId: st.leader, title: why || '' }); } catch (e) { console.error('tick:', e.message); }
}
function approveNodeCore(p, id) {
  const g = readWorkflow(p), n = g.nodes.find(x => x.id === id);
  if (!n) throw new Error('节点不存在');
  setNode(p, id, { status: 'done', approvedAt: now(), approvedBy: 'leader', note: null });
  const st = loadState(p);
  for (const d of descendants(g, id)) if (st.wf.nodes[d] && st.wf.nodes[d].status === 'done') st.wf.nodes[d].stale = true;
  if (st.wf.nodes[id]) st.wf.nodes[id].stale = false;
  saveState(p, st);
  const after = () => { advanceWorkflow(p); broadcast('state', {}); };
  if ((n.config || {}).preset === 'epics') refreshSprint(p).then(after).catch(e => { console.error(e.message); after(); }); else after();
}
function applyTick(p, run, result) {
  const st = loadState(p), L = st.leaderBoard = st.leaderBoard || {};
  L.ticks = (L.ticks || 0) + 1;
  L.lastTickAt = run.startedAt || run.createdAt; // 唤醒期间完成的任务留到下一轮
  const pend = L.pending; L.pending = false;
  if (!result) {
    L.fails = (L.fails || 0) + 1;
    if (L.fails >= 3) L.error = 'Leader 连续 3 轮没给出结果，已暂停';
    saveState(p, st);
    if (L.fails < 3) scheduleTick(p, '上一轮没有结果，重试');
    return;
  }
  L.fails = 0; L.notes = result.notes || L.notes; L.progress = result.progress || null;
  L.encodingBroken = hasBrokenEncoding(result) || isBrokenText(L.notes);
  saveState(p, st);
  const log = { at: now(), run: run.id, progress: result.progress || null, actions: [] };
  for (const a0 of Array.isArray(result.actions) ? result.actions : []) {
    const a = { ...a0 }; let outcome = 'ok';
    try {
      if (a.story) a.story = fullStoryKey(p, a.story);
      if (a.type === 'dispatch') {
        if (a.story && !a.title) {
          if (readSprint(p.sprint)[a.story] === 'done') throw new Error('Story 已完成');
          // 系统推荐的技能自动并进 Leader 选的（按去掉 project:/panel: 前缀后的名字去重），记下哪些是补进来的
          const story = parseEpics(p.epics).stories.find(x => a.story.startsWith(`${x.epic}-${x.n}-`)) || {};
          const bare = id => String(id).replace(/^[\w-]+:/, ''), chosen = Array.isArray(a.skills) ? a.skills : [];
          a.autoSkills = recommendSkills(p, story).filter(id => !chosen.some(c => bare(c) === bare(id)));
          a.skills = [...chosen, ...a.autoSkills];
          const s2 = loadState(p);
          s2.assignments[a.story] = a.agent;
          s2.leaderInstr = s2.leaderInstr || {}; s2.leaderInstr[a.story] = { instructions: a.instructions || '', skills: a.skills || [], autoSkills: a.autoSkills || [], writes: a.writes || [] };
          saveState(p, s2);
          enqueue({ project: p.root, kind: 'implement', storyKey: a.story, agentId: a.agent });
        } else enqueue({ project: p.root, kind: 'task', agentId: a.agent, title: a.title || '临时任务', instructions: a.instructions || '', skills: a.skills || [], relatedStory: a.story || null });
      } else if (a.type === 'set_status') {
        if (a.status === 'done') {
          const s0 = loadState(p), ev = Array.isArray(a.evidence) ? a.evidence : [];
          const lvl = acceptLevel(s0);
          if (!ev.length && lvl !== 'fast') throw new Error('没有逐条验收证据（evidence），未标完成');
          const bad = ev.filter(e => e.pass !== true);
          if (bad.length) throw new Error(`有 ${bad.length} 条证据未通过，不能标完成`);
          const story = parseEpics(p.epics).stories.find(x => a.story.startsWith(`${x.epic}-${x.n}-`)) || {};
          if (lvl !== 'fast' && isUiStory(story) && !ev.some(e => /ui-check/i.test(e.method || ''))) throw new Error('界面类 Story 必须有 ui-check 实测证据');
          const cc = crossCheckDone(p, s0, a.story);
          if (lvl === 'strict' && !cc.ok) throw new Error(cc.why + '，未标完成');
          s0.acceptance = s0.acceptance || {}; s0.acceptance[a.story] = { evidence: ev, at: now(), level: lvl, qa: cc.ok ? cc.qa.id : null, qaAgent: cc.ok ? cc.qa.agent : 'leader' };
          saveState(p, s0);
        }
        const s2 = loadState(p);
        if (a.status === 'done') delete s2.feedback[a.story]; else if (a.feedback) s2.feedback[a.story] = a.feedback;
        saveState(p, s2);
        setStoryStatus(p, a.story, a.status === 'done' ? 'done' : 'ready-for-dev');
      } else if (a.type === 'approve_node') approveNodeCore(p, a.node);
      else if (a.type === 'rerun_node') {
        const n = readWorkflow(p).nodes.find(x => x.id === a.node);
        if (!n) throw new Error('没有这个节点');
        setNode(p, n.id, { status: 'idle' }); startNode(p, n, a.feedback || null);
      } else if (a.type === 'ask_human') { const s2 = loadState(p); s2.leaderBoard.ask = { q: a.question, at: now(), answered: false }; saveState(p, s2); }
      else if (a.type === 'finish') {
        const s2 = loadState(p), g = readWorkflow(p), ns = nodeStates(p, s2, g);
        if (g.nodes.some(n => ns[n.id]?.status !== 'done') || s2.runs.some(r => !['tick', 'triage'].includes(r.kind) && ['queued', 'running'].includes(r.status))) throw new Error('工作流尚未全部完成，不能提前交付');
        s2.leaderBoard.finished = { at: now(), summary: a.summary || '' }; if (s2.wf) s2.wf.running = false; saveState(p, s2);
      }
      else outcome = '未知动作';
    } catch (e) { outcome = '失败：' + e.message; }
    log.actions.push({ ...a, outcome });
  }
  const s3 = loadState(p), L3 = s3.leaderBoard;
  L3.log = [...(L3.log || []), log].slice(-80);
  const activeNow = s3.runs.some(r => !['tick', 'triage'].includes(r.kind) && ['queued', 'running'].includes(r.status));
  if (activeNow || log.actions.length) L3.idleTicks = 0;
  saveState(p, s3);
  if (pend) return scheduleTick(p, '唤醒期间有新事件');
  if (!activeNow && !L3.finished && !(L3.ask && !L3.ask.answered)) {
    L3.idleTicks = (L3.idleTicks || 0) + 1;
    if (L3.idleTicks > 2) L3.error = 'Leader 连续几轮没有推进，已暂停，等你看一下';
    saveState(p, s3);
    if (L3.idleTicks <= 2) scheduleTick(p, '没有任务在跑，请推进');
  }
}

// ---------- Story 流程（时间线：实现 → 交叉验收 → 打回 / 返工 → 完成） ----------
function storyTimeline(p) {
  const st = loadState(p), parsed = parseEpics(p.epics), sprint = readSprint(p.sprint), L = st.leaderBoard || {};
  const acts = (L.log || []).flatMap(g => (g.actions || []).map(a => ({ ...a, at: g.at })));
  const brief = r => readAgentResult(p, r);
  return parsed.stories.map(s => {
    const key = Object.keys(sprint).find(k => k.startsWith(`${s.epic}-${s.n}-`)) || `${s.epic}-${s.n}`;
    const ev = [];
    for (const r of st.runs) {
      if (r.status === 'cancelled') continue;
      const base = { t: r.startedAt || r.createdAt, end: r.endedAt || null, agent: r.agent, status: r.status, run: r.id };
      if (r.storyKey === key && r.kind === 'implement') { const res = brief(r); ev.push({ ...base, type: 'impl', note: res ? clip(res.summary, 160) : (r.error || ''), blocked: !!(res && res.status === 'blocked'), live: live.get(r.id) || null }); }
      else if (r.storyKey === key && r.kind === 'review') ev.push({ ...base, type: 'review', verdict: r.verdict || null });
      else if (r.kind === 'task' && r.relatedStory === key) {
        const res = brief(r), crit = res && Array.isArray(res.criteria) ? res.criteria : null;
        ev.push({ ...base, type: /^交叉验收/.test(r.title || '') ? 'qa' : 'task', title: r.title, note: res ? clip(res.summary, 160) : (r.error || ''), pass: crit ? crit.filter(c => c.pass).length : null, total: crit ? crit.length : null, live: live.get(r.id) || null });
      }
    }
    for (const a of acts) if (a.type === 'set_status' && a.story === key) {
      if (a.status === 'done') ev.push({ t: a.at, type: a.outcome === 'ok' ? 'accept' : 'denied', note: a.outcome === 'ok' ? '' : a.outcome, evidence: (a.evidence || []).length });
      else ev.push({ t: a.at, type: 'reject', note: a.feedback || '' });
    }
    ev.sort((x, y) => String(x.t).localeCompare(String(y.t)));
    const reworks = ev.filter(e => e.type === 'reject' || (e.type === 'review' && e.verdict === 'changes')).length;
    return { key, epic: s.epic, n: s.n, title: s.title, status: sprint[key] || 'backlog', agent: st.assignments[key] || null, reworks, events: ev };
  });
}

// ---------- HTTP ----------
const body = req => new Promise((ok, bad) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } }); });
const send = (res, code, v, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(v) : v); };
const needProject = () => { if (!config.project || !exists(config.project)) throw new Error('先新建或打开一个项目'); return P(config.project); };

const routes = {
  // ---- 技能库 ----
  'GET /api/skills': () => scanSkills(config.project && exists(config.project) ? config.project : null).map(({ dir, ...s }) => ({ ...s, path: dir })),
  'GET /api/skills/content': ({ id }) => { const sk = scanSkills(config.project).find(s => s.id === id); if (!sk) throw new Error('找不到这个技能'); return { ...sk, content: readMd(path.join(sk.dir, 'SKILL.md')), files: [...walk(sk.dir)].map(f => path.relative(sk.dir, f).replace(/\\/g, '/')).slice(0, 50) }; },
  'POST /api/skills/install': ({ id }) => { const sk = installSkill(needProject(), id); return { ok: true, folder: sk.installedFolder }; },
  'POST /api/skills/import': ({ id }) => { importSkill(config.project, id); return { ok: true }; },
  'POST /api/skills/create': b => ({ id: createSkill(b) }),
  'POST /api/skills/save': ({ id, content }) => {
    const sk = scanSkills(config.project).find(s => s.id === id);
    if (!sk || sk.source !== 'panel') throw new Error('只有面板技能库里的技能能在这里编辑');
    writeMd(path.join(sk.dir, 'SKILL.md'), content); skillCache.at = 0; return { ok: true };
  },
  // ---- 工作流 ----
  'GET /api/workflow': () => wfSnapshot(needProject()),
  'GET /api/timeline': () => storyTimeline(needProject()),
  'POST /api/workflow/save': ({ graph }) => {
    const p = needProject();
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('工作流格式不对');
    const ids = new Set(graph.nodes.map(n => n.id));
    if (ids.size !== graph.nodes.length) throw new Error('节点 id 重复');
    graph.edges = graph.edges.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    writeJson(p.workflow, graph); broadcast('workflow', {}); return { ok: true };
  },
  'POST /api/workflow/template': ({ file }) => {
    const p = needProject();
    if (workflowStarted(p) || loadState(p).triagePending) throw new Error('工作流已开始或正在分诊，不能更换模板');
    const t = readJson(path.join(WF_TEMPLATES, path.basename(file || '')), null);
    if (!t) throw new Error('没有这个模板');
    writeJson(p.workflow, { ...t, template: path.basename(file, '.json') });
    const st = loadState(p); st.wf = { nodes: {}, running: false }; saveState(p, st);
    broadcast('state', {}); return wfSnapshot(p);
  },
  'POST /api/triage/apply': ({ template }) => { const p = needProject(); if (loadState(p).triagePending) throw new Error('正在分诊，请稍候'); applyTriageTemplate(p, template); broadcast('state', {}); return wfSnapshot(p); },
  'POST /api/workflow/run': () => { const p = needProject(); ensureLeader(p); const st = loadState(p); st.wf = st.wf || { nodes: {} }; st.wf.running = true; st.wf.startedAt = now(); saveState(p, st); requestTriage(p); advanceWorkflow(p); autoDispatch(p); scheduleTick(p, '运行工作流'); broadcast('state', {}); return wfSnapshot(p); },
  'POST /api/leader/tick': () => { const p = needProject(), st = loadState(p); st.leaderBoard = { ...(st.leaderBoard || {}), error: null, idleTicks: 0, fails: 0 }; saveState(p, st); scheduleTick(p, '老板手动唤醒'); return snapshot(); },
  'POST /api/leader/answer': ({ text }) => {
    const p = needProject(), st = loadState(p), L = st.leaderBoard || {};
    if (!L.ask || L.ask.answered) throw new Error('Leader 现在没有在等回答');
    L.answers = [...(L.answers || []), { q: L.ask.q, a: String(text || '').trim(), at: now() }];
    L.ask.answered = true; st.leaderBoard = L; saveState(p, st);
    scheduleTick(p, '老板回答了问题'); return snapshot();
  },
  'POST /api/leader/note': ({ text }) => {
    const p = needProject(), st = loadState(p), L = st.leaderBoard = st.leaderBoard || {};
    const t = String(text || '').trim(); if (!t) throw new Error('内容不能为空');
    L.answers = [...(L.answers || []), { q: '（老板主动说明）', a: t, at: now() }];
    saveState(p, st); scheduleTick(p, '老板留言'); return snapshot();
  },
  'POST /api/leader/resume': () => { const p = needProject(), st = loadState(p); st.leaderBoard = { ...(st.leaderBoard || {}), finished: null, error: null, idleTicks: 0, fails: 0 }; st.wf = st.wf || { nodes: {} }; st.wf.running = true; saveState(p, st); scheduleTick(p, '继续'); return snapshot(); },
  'POST /api/mode': ({ mode, maxRounds, acceptLevel: lv }) => { const p = needProject(); if (lv) { const st = loadState(p); if (!ACCEPT_LEVELS[lv]) throw new Error('未知验收档位'); st.acceptLevel = lv; saveState(p, st); } if (mode || maxRounds) setMode(p, mode, maxRounds); broadcast('state', {}); return snapshot(); },
  'POST /api/workflow/stop': () => { const p = needProject(), st = loadState(p); if (st.wf) st.wf.running = false; saveState(p, st); broadcast('state', {}); return wfSnapshot(p); },
  'POST /api/node/run': ({ id, feedback }) => {
    const p = needProject(), n = readWorkflow(p).nodes.find(x => x.id === id);
    if (!n) throw new Error('节点不存在');
    setNode(p, id, { status: 'idle', note: null });
    startNode(p, n, feedback || null); broadcast('state', {}); return wfSnapshot(p);
  },
  'POST /api/node/approve': async ({ id }) => {
    const p = needProject(), g = readWorkflow(p), n = g.nodes.find(x => x.id === id);
    if (!n) throw new Error('节点不存在');
    setNode(p, id, { status: 'done', approvedAt: now(), note: null });
    // 已完成的下游节点标记“上游已更新”
    const st = loadState(p);
    for (const d of descendants(g, id)) if (st.wf.nodes[d] && st.wf.nodes[d].status === 'done') st.wf.nodes[d].stale = true;
    if (st.wf.nodes[id]) st.wf.nodes[id].stale = false;
    saveState(p, st);
    if ((n.config || {}).preset === 'epics') await refreshSprint(p).catch(e => console.error(e.message));
    advanceWorkflow(p); broadcast('state', {}); return wfSnapshot(p);
  },
  'POST /api/node/reset': ({ id }) => { const p = needProject(), st = loadState(p); if (st.wf && st.wf.nodes) delete st.wf.nodes[id]; saveState(p, st); broadcast('state', {}); return wfSnapshot(p); },
  'GET /api/state': () => snapshot(),
  'POST /api/project/open': ({ project }) => {
    if (!project || !isDir(project)) throw new Error('目录不存在');
    if (!exists(path.join(project, '_bmad'))) return { needsSetup: true, path: path.resolve(project) };
    useProject(project); return snapshot();
  },
  'POST /api/project/create': ({ name, parent, template, requirement, mode }) => {
    if (!name) throw new Error('项目名不能为空');
    const dir = path.join(parent || config.projectsRoot, slug(name));
    if (exists(dir) && fs.readdirSync(dir).length) throw new Error(`目录已存在且不为空：${dir}`);
    return setupProject(dir, template === 'generic' ? 'generic' : 'embedded', true, { requirement, mode });
  },
  'POST /api/project/setup': ({ path: dir, template }) => { if (!isDir(dir)) throw new Error('目录不存在'); return setupProject(path.resolve(dir), template === 'generic' ? 'generic' : 'embedded', false); },
  'GET /api/setup': ({ dir }) => { const j = setupJobs.get(dir); if (!j) return { status: 'none' }; return { ...j, log: exists(j.logFile) ? stripAnsi(fs.readFileSync(j.logFile, 'utf8')).slice(-4000) : '' }; },
  'GET /api/fs': ({ path: dir }) => listDirs(dir),
  'POST /api/settings': ({ maxParallel, projectsRoot }) => {
    if (maxParallel) config.maxParallel = Math.max(1, Math.min(5, +maxParallel));
    if (projectsRoot) config.projectsRoot = projectsRoot;
    saveConfig(); pump(); return snapshot();
  },
  'POST /api/leader': ({ agent, skills }) => {
    const p = needProject(), st = loadState(p);
    if (agent !== undefined) { if (agent && !loadAgents().some(a => a.id === agent)) throw new Error('没有这个 Leader'); st.leader = agent || null; }
    if (Array.isArray(skills)) st.leaderSkills = skills; saveState(p, st);
    if (st.leader && st.wf?.running && automatic(st)) { resumeAutomaticNodes(p); advanceWorkflow(p); autoDispatch(p); scheduleTick(p, '已选择 Leader'); }
    broadcast('state', {}); return snapshot();
  },
  'POST /api/requirement': ({ text }) => {
    const p = needProject(); fs.mkdirSync(p.panel, { recursive: true }); writeMd(p.requirement, text || '');
    const st = loadState(p);
    if (!workflowStarted(p, st)) {
      st.wf = st.wf || { nodes: {} }; st.wf.nodes ||= {};
      for (const n of readWorkflow(p).nodes.filter(n => n.type === 'start')) delete st.wf.nodes[n.id];
      if (automatic(st)) st.wf.running = true;
      saveState(p, st); requestTriage(p); advanceWorkflow(p);
    }
    broadcast('state', {}); return snapshot();
  },
  'POST /api/stage/run': ({ stage, agent, feedback }) => {
    const p = needProject(), st = loadState(p);
    if (!STAGES.includes(stage)) throw new Error('未知阶段');
    const info = stageInfo(p, st), idx = STAGES.indexOf(stage);
    if (stage === 'prd' && !info.requirement.text.trim() && !info.prd.doc) throw new Error('先写需求');
    if (idx > 0 && info[STAGES[idx - 1]].status !== 'approved') throw new Error('上一阶段还没通过');
    const who = agent || st.leader; if (!who) throw new Error('先选 leader 或指定 agent');
    return enqueue({ kind: 'stage', stage, agentId: who, feedback });
  },
  'POST /api/stage/approve': async ({ stage }) => {
    const p = needProject(), st = loadState(p);
    st.stages[stage] = { ...(st.stages[stage] || {}), status: 'approved', approvedAt: now() };
    // 后面的阶段要基于新版本重做
    for (const s of STAGES.slice(STAGES.indexOf(stage) + 1)) if (st.stages[s] && st.stages[s].status === 'approved') st.stages[s].status = 'stale';
    saveState(p, st);
    if (stage === 'epics') await refreshSprint(p);
    return snapshot();
  },
  'POST /api/assign': ({ key, agent }) => { const p = needProject(), st = loadState(p); if (isAuto(st) || isLeaderMode(st)) throw new Error('自动 / Leader 统筹模式下由 Leader 分配；要手动改，先切回手动模式'); if (agent) st.assignments[key] = agent; else delete st.assignments[key]; saveState(p, st); return snapshot(); },
  'POST /api/plan/apply': () => {
    const p = needProject(), st = loadState(p);
    if (isAuto(st)) throw new Error('自动模式下会自动采纳');
    const plan = readPlan(p);
    if (!plan) throw new Error('还没有 leader 分配方案');
    for (const a of plan.assignments || []) st.assignments[a.key] = a.agent;
    saveState(p, st); return snapshot();
  },
  'POST /api/plan': () => { const st = loadState(needProject()); if (!st.leader) throw new Error('先选 leader'); return enqueue({ kind: 'plan', agentId: st.leader }); },
  'POST /api/run': ({ key }) => { const st = loadState(needProject()); if (isAuto(st) || isLeaderMode(st)) throw new Error('自动 / Leader 统筹模式下由 Leader 派发；要手动派发，先切回手动模式'); const a = st.assignments[key]; if (!a) throw new Error('这个 Story 还没分配 agent'); return enqueue({ kind: 'implement', storyKey: key, agentId: a }); },
  'POST /api/review': ({ key }) => { const st = loadState(needProject()); if (!st.leader) throw new Error('先选 leader'); return enqueue({ kind: 'review', storyKey: key, agentId: st.leader }); },
  'POST /api/status': ({ key, status, feedback }) => {
    const p = needProject(), st = loadState(p);
    if (feedback !== undefined) { if (feedback) st.feedback[key] = feedback; else delete st.feedback[key]; }
    if (status === 'done') delete st.feedback[key];
    saveState(p, st); setStoryStatus(p, key, status); advanceWorkflow(p); autoDispatch(p); return snapshot();
  },
  'POST /api/cancel': ({ runId }) => { cancel(runId); return { ok: true }; },
  'POST /api/pty/resize': ({ id, cols, rows }) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 2 || rows > 300) throw new Error('终端尺寸必须为整数（列 2–500，行 2–300）');
    activePty(id).resize(cols, rows); return { ok: true };
  },
  'POST /api/pty/input': ({ id, data }) => {
    if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 16384) throw new Error('输入必须为不超过 16 KiB 的文本');
    activePty(id).write(data); return { ok: true };
  },
  'POST /api/sprint/refresh': async () => { await refreshSprint(needProject()); return snapshot(); },
  'GET /api/providers': () => readProvidersFile().providers.map(providerDetail),
  'POST /api/providers/save': ({ id, patch }) => saveProvider(id, patch || {}),
  'POST /api/providers/delete': ({ id }) => deleteProvider(id),
  'POST /api/providers/secret': ({ id, value }) => setProviderSecret(id, value),
  'POST /api/providers/check': ({ id }) => checkProvider(id),
  'POST /api/providers/models': ({ id }) => providerModels(id),
  'GET /api/agents/login-status': ({ id }) => { const a = loadAgents().find(x => x.id === id); if (!a) throw new Error('没有这个 agent'); return loginStatus(a); },
  'POST /api/agents/login': ({ id }) => loginAgent(id),
  'GET /api/agents': () => loadAgents().map(agentDetail),
  'POST /api/agents/save': ({ id, patch }) => { saveAgent(id, patch || {}); return loadAgents().map(agentDetail); },
  'POST /api/agents/secret': ({ id, value }) => { if (!value) throw new Error('key 不能为空'); setSecret(id, value); return { ok: true }; },
  'POST /api/agents/test': ({ id }) => testAgent(id),
  'GET /api/agents/models': ({ id }) => fetchModels(id),
  'GET /api/log': ({ id }) => {
    const p = needProject(), r = loadState(p).runs.find(x => x.id === id);
    if (!r) throw new Error('没有这个运行');
    const f = runFiles(p, r);
    const log = exists(f.log) ? fs.readFileSync(f.log, 'utf8') : '';
    const result = readAgentResult(p, r);
    return { log, logBytes: Buffer.byteLength(log, 'utf8'), task: exists(f.task) ? readMd(f.task) : '', result, run: r };
  },
  'GET /api/diff': ({ id, file }) => {
    const p = needProject(), r = loadState(p).runs.find(x => x.id === id);
    if (!r) throw new Error('没有这个运行');
    const d = runDir(p, r.id), before = readJson(path.join(d, 'before.json'), {}), after = readJson(path.join(d, 'after.json'), {});
    return { file, diff: unifiedDiff(before[file], after[file]), isNew: !(file in before), isDeleted: !(file in after) };
  },
  'GET /api/doc': ({ path: rel }) => {
    const root = needProject().root, f = path.resolve(root, rel || '');
    if (!f.startsWith(path.resolve(root) + path.sep)) throw new Error('路径越界');
    return { text: readMd(f) };
  },
};

ensureAuthData();

// Fixed allowlist: no arbitrary access to node_modules or third-party CDN.
const TERM_ASSETS = {
  '/vendor/xterm/xterm.js': ['@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
  '/vendor/xterm/xterm.css': ['@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
  '/vendor/xterm/addon-fit.js': ['@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (TERM_ASSETS[url.pathname]) {
      if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'method not allowed' });
      const [rel, type] = TERM_ASSETS[url.pathname];
      let file;
      try { file = createRequire(import.meta.url).resolve(rel); } catch { return send(res, 404, { error: '请先运行 npm install 安装终端资源' }); }
      return send(res, 200, req.method === 'HEAD' ? '' : fs.readFileSync(file), type);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(HERE, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
    }
    const h = routes[`${req.method} ${url.pathname}`];
    if (!h) return send(res, 404, { error: 'not found' });
    const args = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
    send(res, 200, await h(args));
  } catch (e) { send(res, 400, { error: e.message }); }
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用（面板可能已经在运行）` : e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  if (config.project && exists(config.project)) {
    const p = P(config.project), st = loadState(p);
    let dirty = false;
    for (const r of st.runs) if (['queued', 'running'].includes(r.status)) { r.status = 'failed'; r.error = '面板重启，运行中断'; dirty = true; }
    if (st.triagePending) {
      const interrupted = st.runs.find(r => r.id === st.triagePending.runId);
      if (interrupted) { interrupted.status = 'failed'; interrupted.error = '面板重启，分诊中断；已使用本地判断'; }
      st.triage = { at: now(), ...localTriage(p, '面板重启，Leader 分诊中断'), by: 'heuristic' }; st.triageInput = st.triagePending.input;
      delete st.triagePending; dirty = true;
    }
    for (const s of Object.values(st.stages || {})) if (s.status === 'running') { s.status = 'failed'; dirty = true; }
    const g = readWorkflow(p);
    for (const [id, s] of Object.entries((st.wf && st.wf.nodes) || {})) {
      const n = g.nodes.find(x => x.id === id);
      if (s.status === 'running' && n && n.type === 'agent') { s.status = 'failed'; s.note = '面板重启，运行中断'; dirty = true; }
    }
    if (dirty) saveState(p, st);
    if (st.triage && automatic(st) && !st.triage.applied && !workflowStarted(p, st)) applyTriageTemplate(p);
    // 重启后：Leader 模式接着统筹，规则自动模式接着派发
    setTimeout(() => { try { if (isLeaderMode(loadState(p))) scheduleTick(p, '面板重启后继续'); else { advanceWorkflow(p); autoDispatch(p); } } catch (e) { console.error(e.message); } }, 1500);
  }
  console.log(`Agent 统筹面板：http://127.0.0.1:${PORT}  项目：${config.project || '（未选择）'}`);
});
