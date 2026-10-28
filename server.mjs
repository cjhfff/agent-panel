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
// Alternate instances never share saved workflows, schedules or devtasks with production.
const INSTANCE_DATA = process.env.PANEL_CONFIG ? path.dirname(CONFIG_FILE) : HERE;
const SAVED_WORKFLOWS = path.join(INSTANCE_DATA, 'workflows', 'saved');
const SCHEDULES_FILE = path.join(INSTANCE_DATA, 'schedules.json');
const DEVTASKS_DIR = path.join(INSTANCE_DATA, 'logs', 'devtasks');
const DEVTASKS_STATE = path.join(DEVTASKS_DIR, 'state.json');
const SCHEDULER_TEST = process.env.PANEL_SCHEDULER_TEST === '1' && !!process.env.PANEL_CONFIG && Number(process.env.PORT || 4590) !== 4590;
const RUNFIX_TEST = (process.env.PANEL_RUNFIX_TEST === '1' || SCHEDULER_TEST) && !!process.env.PANEL_CONFIG && Number(process.env.PORT || 4590) !== 4590;
const runfixAgentFixtures = new Map();
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

let config = Object.assign({ project: null, recent: [], projectsRoot: path.join(HERE, 'projects'), maxParallel: 1, maxDevtasks: 2, devtaskRoots: null }, readJson(CONFIG_FILE, {}));
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
    const fixture = RUNFIX_TEST && runfixAgentFixtures.get(a.id), installed = fixture ? fixture.status !== 'missing' : !!resolved, enabled = fixture ? fixture.status !== 'disabled' : a.enabled !== false;
    return { ...a, auth, resolved, installed, enabled, available: installed && enabled && (fixture ? true : !authError), authError: fixture ? '' : authError, effectiveModel: auth.model, relay: auth.mode === 'provider' ? provider?.name || '服务商未配置' : '官方账号' };
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
function providerKey(p) { return p ? readEnvFile('secrets.env')[p.keyEnv] || '' : ''; }
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
function writeProviderConfig(a, p, model, dir = path.join(HERE, `${a.id}-home`)) {
  const grok = a.id === 'grok', f = path.join(dir, 'config.toml');
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
function buildInvocation(a, prompt, cwd, { authDir } = {}) {
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
      Object.assign(env, { ANTHROPIC_BASE_URL: p.baseUrl, ANTHROPIC_AUTH_TOKEN: key, CLAUDE_CONFIG_DIR: authDir || path.join(HERE, 'claude-home') });
      if (auth.model) env.ANTHROPIC_MODEL = auth.model;
      fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
      const settings = path.join(env.CLAUDE_CONFIG_DIR, 'settings.json');
      if (!exists(settings)) writeJson(settings, {});
    } else if (a.id === 'gemini') Object.assign(env, { GEMINI_API_KEY: key, GOOGLE_GEMINI_BASE_URL: p.baseUrl });
    else if (['codex', 'grok'].includes(a.id)) {
      const dir = authDir || path.join(HERE, `${a.id}-home`);
      if (authDir) {
        fs.mkdirSync(dir, { recursive: true });
        const baseline = path.join(HERE, `${a.id}-home`, 'config.toml');
        if (exists(baseline) && !exists(path.join(dir, 'config.toml'))) fs.copyFileSync(baseline, path.join(dir, 'config.toml'));
      }
      writeProviderConfig(a, p, auth.model, dir);
      env[a.id === 'codex' ? 'CODEX_HOME' : 'GROK_HOME'] = dir;
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
const readPlan = p => { if (loadState(p).planInvalidated) return null; const plan = readJson(p.plan, null); return normalizePlan(p, plan && hasBrokenEncoding(plan) ? { ...plan, encodingBroken: true } : plan); };

// ---------- 面板状态 ----------
const loadState = p => {
  const s = readJson(p.state, {});
  const st = { leader: null, assignments: {}, feedback: {}, runs: [], stages: {}, orchestration: 'template', components: [], ...s };
  reconcileWorkflowState(p, st);
  return st;
};
const saveState = (p, s) => writeJson(p.state, s);
const skillsBase = p => exists(path.join(p.root, '.claude', 'skills')) ? '.claude/skills' : '.agents/skills';

function snapshot(project = config.project) {
  const agents = loadAgents().map(({ resolved, ...a }) => ({ id: a.id, name: a.name, available: a.available, availability: agentAvailability(a), installed: a.installed, enabled: a.enabled !== false, strengths: a.strengths, permission: a.permission, effectiveModel: a.effectiveModel, relay: a.relay, auth: a.auth, authError: a.authError }));
  if (!project || !exists(project)) return { project: null, recent: config.recent.filter(exists), projectsRoot: config.projectsRoot, agents, maxParallel: config.maxParallel, scheduleRunningCount: scheduleRunningCount(), ...devtaskSnapshot() };
  const p = P(project), parsed = parseEpics(p.epics), sprint = readSprint(p.sprint), st = loadState(p);
  const stories = parsed.stories.map(s => {
    const key = Object.keys(sprint).find(k => k.startsWith(`${s.epic}-${s.n}-`)) || `${s.epic}-${s.n}`;
    return { ...s, key, status: sprint[key] || 'backlog', agent: st.assignments[key] || null, feedback: st.feedback[key] || null };
  });
  const docs = [];
  for (const f of walk(p.planning, new Set(['panel']))) if (f.endsWith('.md')) docs.push(path.relative(p.root, f).replace(/\\/g, '/'));
  for (const f of ['AGENTS.md', 'docs/embedded-standards.md']) if (exists(path.join(p.root, f))) docs.unshift(f);
  return {
    project: p.root, projectName: path.basename(p.root), recent: config.recent.filter(exists), projectsRoot: config.projectsRoot, scheduleRunningCount: scheduleRunningCount(), ...devtaskSnapshot(),
    bmadInstalled: exists(path.join(p.root, '_bmad')), hasEpics: exists(p.epics), hasSprint: exists(p.sprint), maxParallel: config.maxParallel,
    orchestration: st.orchestration, fixedRecipe: !!st.fixedRecipe, components: componentCalls(p, st), componentCalls: componentCalls(p, st), requirementChanged: st.requirementChanged || null, runNotice: st.runNotice || null,
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

function enqueue({ project = config.project, kind, storyKey = null, stage = null, nodeId = null, agentId, feedback = null, title = null, instructions = null, skills = null, relatedStory = null, callId = null, variant = null, bootstrap = false }) {
  const p = P(project), st = loadState(p), snap = snapshot(project);
  if (st.requirementChanged) throw new Error('需求已修改，请先选择用新需求新建项目或在本项目重跑');
  if (kind !== 'triage') { rememberWorkflowRequirement(p, st); st.wf.substantiveStartedAt ||= now(); }
  const agent = loadAgents().find(a => a.id === agentId);
  if (!agent) throw new Error(`没有这个 agent：${agentId}`);
  if (!agent.installed) throw new Error(`${agent.name} 未安装（找不到 ${agent.cmd}）`);
  if (agent.enabled === false) throw new Error(`${agent.name} 已在设置里停用`);
  const availability = agentAvailability(agent);
  if (agentId === st.leader && !availability.available && availability.status !== 'unverified') throw new Error(`当前 Leader（${agent.name}）${availability.label}，流程不会推进`);
  const dup = st.runs.find(r => !r.cancelRequested && ['queued', 'running'].includes(r.status) && ((storyKey && r.storyKey === storyKey) || (stage && r.stage === stage) || (nodeId && r.nodeId === nodeId && r.kind === kind) || (['plan', 'tick', 'triage'].includes(kind) && r.kind === kind)));
  if (dup) throw new Error('这一项已经在跑或在排队');
  const story = storyKey ? snap.stories.find(s => s.key === storyKey) : null;
  if (storyKey && !story) throw new Error(`找不到 Story ${storyKey}`);
  const run = { id: newRunId(kind === 'stage' ? stage : kind === 'node' ? 'node' : kind, agentId), kind, storyKey, stage, nodeId, title, relatedStory, agent: agentId, status: 'queued', pty: false, createdAt: now(), ...(bootstrap ? { bootstrap: true } : {}) };
  if (kind === 'component') {
    const c = st.components.find(x => x.id === callId); if (!c) throw new Error('组件调用不存在');
    Object.assign(run, { callId, component: c.component, variant, bootstrap, model: bootstrap ? null : agent.effectiveModel, title: `${componentDef(c.component).name} · ${callId}${bootstrap ? ' · 准备 BMAD 技能' : variant ? ' · ' + variant : ''}` });
    if (!bootstrap) { const allocation = mergeComponentSkills(p, c, agentId, st); Object.assign(c, allocation); Object.assign(run, allocation); }
    c.runId = run.id; c.runIds ||= []; c.runIds.push(run.id);
  }
  if (kind === 'triage') { run.triageInput = st.triagePending.input; st.triagePending.runId = run.id; }
  const f = runFiles(p, run); fs.mkdirSync(f.dir, { recursive: true });
  const lastImpl = storyKey && [...st.runs].reverse().find(r => r.storyKey === storyKey && r.kind === 'implement');
  const task = bootstrap ? `# 按需准备 BMAD 技能\n项目根目录：${p.root}\n组件或固定模板首次缺少所需技能时安装 BMAD ${BMAD_VERSION}，由面板执行，不占用额外流程节点。` : kind === 'component' ? componentTask(p, callId, f.result, agentId, variant) : kind === 'triage' ? triageTask(p, f.result) : kind === 'plan' ? leaderPlanTask(p, snap, f.result)
    : kind === 'review' ? leaderReviewTask(p, story, lastImpl, f.result)
      : kind === 'stage' ? stageTask(p, stage, st, f.result, feedback)
        : kind === 'node' ? nodeTask(p, nodeId, st, f.result, feedback)
          : kind === 'nodereview' ? nodeReviewTask(p, nodeId, st, f.result)
            : kind === 'tick' ? leaderBrief(p, f.result)
              : kind === 'task' ? taskTask(p, title, instructions, skills, f.result, relatedStory)
        : memberTask(p, story, f.result);
  // 所有任务（包括 Leader 简报/评审）都在此写入，统一带上编码规则。
  writeMd(f.task, `${requirementRevisionPrompt(st)}${task}\n## 通用规则（文本编码）\n${TEXT_ENCODING_RULE}\n`);
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
    if (run.kind === 'component') { const s2 = loadState(p), c = s2.components.find(x => x.id === run.callId); if (c) { c.status = 'running'; c.startedAt ||= now(); saveState(p, s2); } }
    if (run.kind === 'implement') {
      try { setStoryStatus(p, run.storyKey, 'in-progress'); } catch (e) { console.error(e.message); }
      writeJson(path.join(f.dir, 'before.json'), takeSnapshot(p.root));
    }
    const prompt = `Read the task file ${f.task} and follow it exactly. Write your JSON result to the path it specifies.`;
    let leaderOutput = '';
    const leaderRun = run.agent === st.leader && ['tick', 'triage', 'plan', 'review', 'nodereview'].includes(run.kind);
    const onChunk = (text, meta) => {
      if (leaderRun) leaderOutput = (leaderOutput + stripAnsi(text)).slice(-12000);
      feedStatus(runId, text);
      lastOut.set(runId, now());
      broadcast('log', { runId, text, ...meta, lastLine: live.get(runId), lastOutputAt: lastOut.get(runId) });
    };
    const onExit = code => {
      clearTimeout(triageTimers.get(runId)); triageTimers.delete(runId);
      running.delete(runId);
      if (run.bootstrap) {
        skillCache.at = 0; const c = loadState(p).components.find(x => x.id === run.callId), node = run.kind === 'node' && readWorkflow(p).nodes.find(n => n.id === run.nodeId);
        const missing = node ? missingPresetSkills(p, node) : c ? missingComponentSkills(p, c) : ['没有找到待准备的组件 / 节点'];
        writeJson(f.result, { summary: code === 0 && !missing.length ? 'BMAD 技能已就绪' : 'BMAD 技能准备失败，请检查安装日志及网络；没有继续生成伪完整文档', artifacts: [], pass: code === 0 && !missing.length, findings: missing });
      }
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
      if (run.kind === 'plan' && result) { writeJson(p.plan, normalizePlan(p, { ...result, by: run.agent, at: now() })); const s2 = loadState(p); delete s2.planInvalidated; saveState(p, s2); }
      if (run.kind === 'review' && result) patch.verdict = result.verdict;
      if (run.kind === 'stage') {
        const s2 = loadState(p);
        s2.stages[run.stage] = { ...(s2.stages[run.stage] || {}), status: result && code === 0 ? 'review' : 'failed', result: result || null, finishedAt: now() };
        saveState(p, s2);
      }
      let needReview = false;
      if (run.kind === 'node' && !run.bootstrap) {
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
      if (leaderRun && !cur.cancelRequested && (code !== 0 || !result) && authErrorInOutput(leaderOutput + '\n' + (cur.error || ''))) {
        patch.status = 'failed'; patch.authFailed = true; patch.error = `Leader（${agent.name}）没登录，没法工作`;
        recordLeaderAuthFailure(agent, leaderOutput);
        const authState = loadState(p); authState.leaderBoard ||= {}; authState.leaderBoard.error = patch.error; authState.leaderBoard.authBlockedAgent = agent.id; authState.leaderBoard.authBlockedError = patch.error; authState.leaderBoard.pending = false; saveState(p, authState);
      }
      updateRun(p, runId, patch);
      if (run.kind === 'node' && run.bootstrap) {
        const ok = !cur.cancelRequested && code === 0 && result?.pass;
        setNode(p, run.nodeId, ok ? { status: 'idle', note: null, result: null } : { status: 'failed', note: result?.summary || 'BMAD 技能准备失败' });
        live.delete(runId); parsers.delete(runId); lastOut.delete(runId);
        if (ok) { try { advanceWorkflow(p); autoDispatch(p); } catch (e) { setNode(p, run.nodeId, { status: 'failed', note: e.message }); } }
        broadcast('state', {}); pump(); return;
      }
      if (run.kind === 'component') finishComponentRun(p, run, result, patch);
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
      const child = launch(runfixInvocation(agent) || (run.bootstrap ? bmadInvocation(p.root) : buildInvocation(agent, prompt, p.root, process.env.PANEL_CONFIG ? { authDir: path.join(f.dir, 'auth') } : {})), p.root, f.log, onChunk, onExit, run.bootstrap ? 'BMAD 技能准备' : agent.name);
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
  const devtask = devtaskData.runs.find(r => r.id === id);
  if (devtask) {
    const child = devtaskRunning.get(id);
    if (devtask.status !== 'running' || devtask.cancelRequested || !child?.pty) throw new Error('这个运行没有正在进行的 PTY');
    return child;
  }
  const run = loadState(needProject()).runs.find(r => r.id === id), child = running.get(id);
  if (!run || run.status !== 'running' || run.cancelRequested || !child?.pty) throw new Error('这个运行没有正在进行的 PTY');
  return child;
}
function cancel(runId, p = P(config.project), withinComponent = false) {
  const st = loadState(p);
  const rec = st.runs.find(r => r.id === runId);
  if (rec?.kind === 'component' && !withinComponent) return cancelComponentCall(p, rec.callId, '已手动取消');
  if (st.triagePending?.runId === runId) { delete st.triagePending; if (st.wf) st.wf.running = false; saveState(p, st); }
  queue = queue.filter(q => q.runId !== runId);
  const child = running.get(runId);
  if (child) { updateRun(p, runId, { cancelRequested: true }); killTree(child); }
  else {
    const r = updateRun(p, runId, { status: 'cancelled', endedAt: now() });
    if (r?.kind === 'component') { const s2 = loadState(p), c = s2.components.find(x => x.id === r.callId); if (c && !['done', 'failed', 'cancelled'].includes(c.status)) { c.status = 'cancelled'; c.endedAt = now(); c.error = '已取消'; saveState(p, s2); } }
    if (r && r.kind === 'stage') { const st = loadState(p); st.stages[r.stage] = { ...(st.stages[r.stage] || {}), status: 'failed' }; saveState(p, st); }
  }
  broadcast('state', {});
}

// ---------- 面板任务：独立于项目、工作流和定时任务的运行队列 ----------
const devtaskData = readJson(DEVTASKS_STATE, { version: 1, runs: [] });
if (!Array.isArray(devtaskData.runs)) devtaskData.runs = [];
const devtaskRunning = new Map();
const devtaskPersistTimers = new Map();
function persistDevtasks() {
  fs.mkdirSync(DEVTASKS_DIR, { recursive: true });
  const tmp = DEVTASKS_STATE + '.tmp';
  writeJson(tmp, devtaskData); fs.renameSync(tmp, DEVTASKS_STATE);
}
function devtaskFiles(run) {
  const dir = path.join(DEVTASKS_DIR, run.id);
  return { dir, task: path.join(dir, 'task.md'), log: path.join(dir, 'run.log'), last: path.join(dir, 'last.md'), auth: path.join(dir, 'auth') };
}
function devtaskMessage(run) {
  const file = devtaskFiles(run).last;
  if (!exists(file)) return '';
  // Reading just the prefix also bounds API work for unexpectedly large replies.
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(16008), n = fs.readSync(fd, buf, 0, buf.length, 0); return readTextPrefix(buf.subarray(0, n), 4000); }
  finally { fs.closeSync(fd); }
}
function readTextPrefix(buf, count) { return new StringDecoder('utf8').write(buf).replace(/^\uFEFF+/, '').slice(0, count); }
function publicDevtask(run) {
  return { ...run, lastLine: live.get(run.id) || run.lastLine || '', lastOutputAt: lastOut.get(run.id) || run.lastOutputAt || null, lastMessage: devtaskMessage(run) };
}
function getDevtask(id) {
  const run = devtaskData.runs.find(r => r.id === id);
  if (!run) throw new Error('没有这个面板任务');
  return run;
}
const devtaskRunningCount = () => devtaskData.runs.filter(r => r.status === 'running').length;
const listDevtasks = () => devtaskData.runs.slice(-50).reverse().map(publicDevtask);
function devtaskSnapshot() {
  const recent = devtaskData.runs.slice(-50), ids = new Set(recent.map(r => r.id));
  return { devtasks: [...devtaskData.runs.filter(r => !ids.has(r.id) && ['queued', 'running'].includes(r.status)), ...recent].reverse().map(publicDevtask), devtaskRunningCount: devtaskRunningCount() };
}
function devtaskEvent(phase, run) { broadcast('devtask', { phase, run: publicDevtask(run), runningCount: devtaskRunningCount() }); }
function devtaskCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) throw new Error('cwd 必须是已存在的目录');
  const resolved = path.resolve(HERE, cwd);
  if (!isDir(resolved)) throw new Error('cwd 目录不存在');
  const actual = fs.realpathSync(resolved);
  const roots = config.devtaskRoots ?? [HERE, config.projectsRoot];
  if (!Array.isArray(roots) || !roots.every(r => typeof r === 'string' && r.trim())) throw new Error('devtaskRoots 配置必须是目录数组');
  const allowed = roots.some(root => {
    const candidate = path.resolve(HERE, root);
    if (!isDir(candidate)) return false;
    const rel = path.relative(fs.realpathSync(candidate), actual);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  });
  if (!allowed) throw new Error('cwd 不在允许的 devtaskRoots 根目录内');
  return actual;
}
function enqueueDevtask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('参数必须是对象');
  const fields = new Set(['title', 'agent', 'cwd', 'prompt', 'effort', 'model']);
  if (Object.keys(input).some(k => !fields.has(k))) throw new Error('只接受 title、agent、cwd、prompt、effort、model，不接受命令行参数');
  const { title, agent: agentId, prompt, effort, model } = input;
  if (typeof title !== 'string' || !title.trim() || title.length > 240 || /[\x00-\x1f]/.test(title)) throw new Error('title 必须是 1–240 字的单行标题');
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 1024 * 1024 || prompt.includes('\0')) throw new Error('prompt 必须是非空文本（最多 1 MiB）');
  const agent = loadAgents().find(a => a.id === agentId);
  if (!agent || !agent.installed || agent.enabled === false) throw new Error('agent 必须是已安装、已启用的 agent id');
  if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'ultra'].includes(effort)) throw new Error('effort 仅支持 low / medium / high / xhigh / ultra');
  if (model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model))) throw new Error('model 必须是有效模型名称（最多 200 字）');
  if (model !== undefined && !agent.modelFlag && !['codex', 'grok'].includes(agentId)) throw new Error('这个 agent 没有配置 modelFlag，无法覆盖模型');
  validateProvider(agent, { ...agent.auth, ...(model !== undefined ? { model } : {}) });
  const cwd = devtaskCwd(input.cwd);
  const run = { id: newRunId('devtask', agentId), kind: 'devtask', title: title.trim(), agent: agentId, model: model ?? agent.effectiveModel ?? '', modelOverride: model !== undefined, effort: effort ?? null, cwd, status: 'queued', pty: false, createdAt: now(), startedAt: null, endedAt: null, exitCode: null, lastLine: '' };
  if (effort !== undefined && agentId !== 'codex') { run.effortIgnored = true; run.notes = ['effort 仅适用于 Codex，本次已忽略']; }
  const f = devtaskFiles(run); fs.mkdirSync(f.dir, { recursive: true });
  const replyInstruction = agentId === 'codex' ? '' : `\n\n## 面板最终回复\n完成后请将最终回复同时写入 ${f.last}（UTF-8 文本），供面板的回复按钮读取。该文件是本任务的交付产物，允许写入；其余改动遵循上面的任务范围。\n`;
  writeMd(f.task, prompt + replyInstruction);
  devtaskData.runs.push(run);
  try { persistDevtasks(); } catch (e) { devtaskData.runs.pop(); throw e; }
  devtaskEvent('queued', run);
  setImmediate(pumpDevtasks);
  return publicDevtask(run);
}
function pumpDevtasks() {
  const limit = Number.isInteger(config.maxDevtasks) && config.maxDevtasks > 0 ? config.maxDevtasks : 2;
  while (devtaskRunning.size < limit) {
    const run = devtaskData.runs.find(r => r.status === 'queued');
    if (!run) break;
    const f = devtaskFiles(run);
    let completed = false;
    const onChunk = (text, meta) => {
      feedStatus(run.id, text); lastOut.set(run.id, now());
      const lines = stripAnsi(text).split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
      run.lastLine = live.get(run.id) || lines.at(-1)?.slice(0, 300) || run.lastLine;
      run.lastOutputAt = lastOut.get(run.id);
      broadcast('log', { runId: run.id, text, ...meta, lastLine: run.lastLine, lastOutputAt: run.lastOutputAt });
      if (!devtaskPersistTimers.has(run.id)) devtaskPersistTimers.set(run.id, setTimeout(() => { devtaskPersistTimers.delete(run.id); persistDevtasks(); }, 1000));
    };
    const onExit = code => {
      if (completed) return;
      completed = true;
      clearTimeout(devtaskPersistTimers.get(run.id)); devtaskPersistTimers.delete(run.id);
      devtaskRunning.delete(run.id);
      Object.assign(run, { status: run.cancelRequested ? 'cancelled' : code === 0 ? 'finished' : 'failed', exitCode: code, endedAt: now(), lastLine: live.get(run.id) || run.lastLine });
      if (run.status === 'failed') run.error ||= `退出码 ${code}`;
      live.delete(run.id); parsers.delete(run.id); lastOut.delete(run.id);
      persistDevtasks(); devtaskEvent('finished', run); setImmediate(pumpDevtasks);
    };
    try {
      const cwd = devtaskCwd(run.cwd), agent = loadAgents().find(a => a.id === run.agent);
      if (!agent?.installed || agent.enabled === false) throw new Error('Agent 已停用或不可用');
      const selected = { ...agent, auth: { ...agent.auth, model: run.model } };
      const invocation = buildInvocation(selected, `读 ${f.task} 按要求完成任务`, cwd, { authDir: f.auth });
      if (run.agent === 'codex') {
        if (run.effort) invocation.args.push('-c', `model_reasoning_effort="${run.effort}"`);
        invocation.args.push('-o', f.last);
      }
      Object.assign(run, { status: 'running', startedAt: now() }); persistDevtasks();
      const child = launch(invocation, cwd, f.log, onChunk, onExit, agent.name);
      devtaskRunning.set(run.id, child); run.pty = child.pty;
      persistDevtasks(); devtaskEvent('started', run);
    } catch (e) { const child = devtaskRunning.get(run.id); if (child) killTree(child); run.error = e.message; run.lastLine = e.message; onExit(-1); }
  }
}
function cancelDevtask(id) {
  const run = getDevtask(id);
  if (!['queued', 'running'].includes(run.status)) return publicDevtask(run);
  run.cancelRequested = true;
  const child = devtaskRunning.get(id);
  if (child) { persistDevtasks(); killTree(child); devtaskEvent('cancelling', run); }
  else { Object.assign(run, { status: 'cancelled', endedAt: now() }); persistDevtasks(); devtaskEvent('cancelled', run); setImmediate(pumpDevtasks); }
  return publicDevtask(run);
}
function recoverDevtasks() {
  let changed = false;
  for (const run of devtaskData.runs) if (run.status === 'running') {
    Object.assign(run, { status: 'interrupted', endedAt: now(), error: '面板重启，运行中断' }); changed = true;
  }
  if (changed) persistDevtasks();
  setImmediate(pumpDevtasks);
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
function bmadInvocation(dir) {
  const args = ['-y', `bmad-method@${BMAD_VERSION}`, 'install', '--directory', dir, '--modules', 'bmm', '--tools', 'claude-code,codex,gemini,grok', '--user-name', readJson(CONFIG_FILE, {}).userName || 'User', '--communication-language', 'Chinese', '--document-output-language', 'Chinese', '-y'];
  if (exists(path.join(dir, '_bmad'))) args.splice(3, 0, '--action', 'update');
  return { exe: resolveCmd('npx'), args, env: { ...process.env, NO_COLOR: '1' } };
}
function setupProject(dir, template, isNew, initial = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(HERE, 'logs', `setup-${Date.now()}.log`);
  const job = { dir, status: 'running', logFile, startedAt: now() };
  setupJobs.set(dir, job); broadcast('setup', { dir, status: 'running' });
  const name = path.basename(dir);
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
  launch(bmadInvocation(dir), dir, logFile, null,
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
  const fixture = RUNFIX_TEST && runfixAgentFixtures.get(a.id);
  const status = fixture ? (runtimeAuthFailures.has(agentTestScope(a, 'official')) ? 'expired' : ({ available: 'logged-in', expired: 'expired', unverified: 'unverified', missing: 'not-logged-in', disabled: 'unverified' })[fixture.status]) : a.id === 'deepseek' ? 'self' : loginStateFromTest(hasCredentials, test);
  const verification = status === 'expired' ? '登录已失效，请点击「登录」，完成后重新测连通。' : status === 'unverified' ? (test ? '最近一次测连通未通过，尚未验证登录；请重新测连通。' : '凭据文件存在，尚未测连通验证；请点击「测连通」。') : status === 'logged-in' ? '官方账号最近一次测连通通过。' : '';
  return { status, hint: [verification, hints[a.id] || '请使用 CLI 自身登录。'].filter(Boolean).join(' '), command: a.loginCmd || '', canLogin: !!a.loginCmd && !!a.installed, testedAt: test?.finishedAt || null };
}
function authErrorInOutput(output) { return /not\s+logged\s+in|\/login\b|\b401\b|unauthori[sz]ed|\bexpired\b/i.test(String(output || '')); }
function loginStateFromTest(hasCredentials, test) {
  if (['failed', 'timeout'].includes(test?.status) && (test.authFailed || authErrorInOutput(test.output))) return 'expired';
  if (!hasCredentials) return 'not-logged-in';
  if (test?.status === 'ok') return 'logged-in';
  return 'unverified';
}
function agentAvailability(a) {
  const result = status => ({ status, label: ({ available: '可用', expired: '登录已失效', unverified: '未验证', missing: '未安装', disabled: '停用' })[status], available: status === 'available' });
  if (!a) return result('missing');
  const fixture = RUNFIX_TEST && runfixAgentFixtures.get(a.id);
  if (fixture) return result(runtimeAuthFailures.has(agentTestScope(a)) ? 'expired' : fixture.status);
  if (a.enabled === false) return result('disabled');
  if (!a.installed) return result('missing');
  if (a.auth.mode === 'provider') {
    const provider = readProvidersFile().providers.find(p => p.id === a.auth.provider);
    if (provider?.enabled === false) return result('disabled');
    if (a.authError || !providerKey(provider)) return result('expired');
    const test = latestAgentTest(a);
    return result(test?.authFailed || (['failed', 'timeout'].includes(test?.status) && authErrorInOutput(test.output)) ? 'expired' : 'available');
  }
  const login = loginStatus(a);
  return result(login.status === 'logged-in' ? 'available' : ['expired', 'not-logged-in'].includes(login.status) ? 'expired' : 'unverified');
}
function recordLeaderAuthFailure(a, output) {
  if (!a) return;
  const scope = agentTestScope(a), provider = a.auth.mode === 'provider' && readProvidersFile().providers.find(p => p.id === a.auth.provider);
  const test = { status: 'failed', authFailed: true, authMode: a.auth.mode, scope, finishedAt: now(), output: safeProviderErrorOutput(stripAnsi(String(output || '')), providerKey(provider)).slice(-1500) };
  // Runtime failures invalidate current availability without rewriting saved tests or credentials.
  runtimeAuthFailures.set(scope, test); broadcastAgentTest(a, test);
}
function runfixInvocation(a) {
  const fixture = RUNFIX_TEST && runfixAgentFixtures.get(a.id);
  if (!fixture) return null;
  const script = fixture.execution === 'auth-failure' ? "console.error('Not logged in · Please run /login'); process.exit(1);" : "console.log('Runfix fixture is waiting.'); setInterval(() => {}, 1000);";
  return { exe: process.execPath, args: ['-e', script], env: { ...process.env }, stream: null };
}
function setRunfixAgentFixture({ id, status = 'available', execution = 'hold', reset = false }) {
  if (!RUNFIX_TEST) throw new Error('Agent 测试钩子仅在隔离测试实例启用');
  const agent = loadAgents().find(a => a.id === id);
  if (!agent) throw new Error('没有这个 agent');
  if (reset) { runfixAgentFixtures.delete(id); runtimeAuthFailures.delete(agentTestScope(agent)); }
  else {
    if (!['available', 'expired', 'unverified', 'missing', 'disabled'].includes(status)) throw new Error('测试状态无效');
    if (!['hold', 'auth-failure'].includes(execution)) throw new Error('测试执行方式无效');
    runtimeAuthFailures.delete(agentTestScope(agent)); runfixAgentFixtures.set(id, { status, execution });
  }
  broadcast('state', {}); return loadAgents().map(agentDetail);
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
  return { id: a.id, name: a.name, cmd: a.cmd, path: a.resolved, installed: a.installed, enabled: a.enabled !== false, availability: agentAvailability(a), strengths: a.strengths,
    permission: a.permission || 'max', permOptions: Object.keys(a.perm || {}), canModel: !!a.modelFlag || ['codex', 'grok'].includes(a.id), model: a.effectiveModel, effectiveModel: a.effectiveModel, modelNote: a.modelNote,
    auth: a.auth, providerTypes: PROVIDER_TYPES[a.id] || [], providerSupported: !!PROVIDER_TYPES[a.id]?.length, providerNote: a.id === 'deepseek' ? 'dsh --help / headless --help 未提供服务商注入参数，使用自身配置。' : '', login: loginStatus(a),
    relay: a.relay, baseUrl: detail?.baseUrl, keyName: detail?.keyEnv, keyMasked: detail?.keyMasked, testScope: agentTestScope(a), test: currentAgentTest(a) };
}
// Alternate PANEL_CONFIG instances keep their test cache beside that config.
const AGENT_TESTS_FILE = path.join(process.env.PANEL_CONFIG ? path.dirname(CONFIG_FILE) : path.join(HERE, 'logs'), 'agent-tests.json');
const tests = new Map(Object.entries(readJson(AGENT_TESTS_FILE, {}).results || {}).filter(([, t]) => ['ok', 'failed', 'timeout'].includes(t?.status)));
const activeAgentTests = new Map();
const runtimeAuthFailures = new Map();
function agentTestScope(a, mode = a.auth.mode) {
  const auth = a.auth || authFor(a), p = mode === 'provider' && readProvidersFile().providers.find(p => p.id === auth.provider);
  const scope = mode === 'official' ? [a.id, mode] : [a.id, mode, auth.provider, p?.type, p?.baseUrl, auth.model];
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}
function latestAgentTest(a, mode = a.auth.mode) { const scope = agentTestScope(a, mode); return runtimeAuthFailures.get(scope) || tests.get(scope) || null; }
function currentAgentTest(a) {
  const active = activeAgentTests.get(a.id);
  return active?.scope === agentTestScope(a) ? active : latestAgentTest(a);
}
function broadcastAgentTest(a, t) { broadcast('agenttest', { id: a.id, ...t, login: loginStatus(a), availability: agentAvailability(a) }); }
function testAgent(id) {
  const a = loadAgents().find(x => x.id === id);
  if (!a || !a.installed) throw new Error('agent 未安装');
  const active = activeAgentTests.get(id);
  if (active) {
    if (active.scope !== agentTestScope(a)) throw new Error('该 Agent 正在测试其他认证方式，请等测试结束后再测');
    return active;
  }
  const cwd = path.dirname(AGENT_TESTS_FILE); fs.mkdirSync(cwd, { recursive: true });
  const invocation = runfixInvocation(a) || buildInvocation(a, 'Reply with exactly one word: OK', cwd);
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
    activeAgentTests.delete(id); runtimeAuthFailures.delete(t.scope); tests.set(t.scope, t);
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

// ---------- 组件化编排：组件提供能力，流程由 Leader 决定 ----------
const COMPONENTS = [
  { id: 'clarify', name: '澄清', desc: '向老板提问，等待回答后继续', inputs: { questions: '问题列表' }, output: { summary: '老板的回答' }, executor: 'human', defaultRole: 'leader', defaultEstimateMs: 60000 },
  { id: 'spec', name: '需求', desc: '按需要整理需求要点或完整 PRD', inputs: { goal: '目标、范围和待确认事项' }, output: { artifacts: '需求文档相对路径' }, executor: 'agent', defaultRole: 'leader', depthOptions: ['brief', 'full'], skills: { full: ['bmad-prd'] }, defaultEstimateMs: 180000 },
  { id: 'design', name: '方案', desc: '关键技术决策或完整架构', inputs: { goal: '要解决的技术问题' }, output: { artifacts: '技术方案相对路径' }, executor: 'agent', defaultRole: 'leader', depthOptions: ['brief', 'full'], skills: { full: ['bmad-architecture'] }, defaultEstimateMs: 180000 },
  { id: 'split', name: '拆分', desc: '按用户价值拆成任务 JSON 列表', inputs: { max: '最多任务数（可省略）', goal: '拆分范围' }, output: { tasks: '[{id,title,goal,acceptance,agent,depends_on}]' }, executor: 'agent', defaultRole: 'leader', defaultEstimateMs: 120000 },
  { id: 'implement', name: '实现', desc: '编写可用的产品代码', inputs: { instructions: '实现指令', skills: '技能 id 列表', writes: '允许修改的相对路径/目录/通配符', task_id: '可选，split 的任务 id', target: '稳定的目标标识（用于失败护栏）' }, output: { artifacts: '代码和验证产出路径', summary: '实现结果' }, executor: 'agent', defaultRole: 'worker', defaultEstimateMs: 480000 },
  { id: 'test', name: '自测', desc: '测试功能；界面可用 tools/ui-check.mjs 无头实测', inputs: { focus: '关注点/验收要点', target: '测试目标' }, output: { pass: '是否通过', findings: '问题列表', artifacts: '测试证据路径' }, executor: 'agent', defaultRole: 'worker', defaultEstimateMs: 180000 },
  { id: 'review', name: '评审', desc: '由另一个 agent 阅读代码和结果找问题', inputs: { focus: '关注点', target: '实现调用 id 或任务标识' }, output: { pass: '是否通过', findings: '问题列表' }, executor: 'agent', defaultRole: 'reviewer', defaultEstimateMs: 180000 },
  { id: 'crosscheck', name: '交叉验收', desc: '由非实现者逐条验收', inputs: { acceptance: '逐条验收要点', target: '实现调用 id 或任务标识' }, output: { pass: '是否通过', findings: '逐条验收结果', artifacts: '验收证据路径' }, executor: 'agent', defaultRole: 'reviewer', defaultEstimateMs: 240000 },
  { id: 'compare', name: '方案对比', desc: '两个不同 agent 各出方案，再由 Leader 合并', inputs: { agents: '两个不同的可用 agent id', goal: '比较目标与标准' }, output: { summary: 'Leader 合并结论', artifacts: '两版方案与合并方案路径' }, executor: 'agent', defaultRole: 'leader', defaultEstimateMs: 360000 },
  { id: 'fix', name: '修复', desc: '按问题列表修改实现并验证', inputs: { findings: '问题列表', instructions: '修改指令', writes: '允许修改的相对路径/目录/通配符', target: '修复目标' }, output: { summary: '修复结果', artifacts: '修改和测试路径', pass: '是否已修好' }, executor: 'agent', defaultRole: 'worker', defaultEstimateMs: 240000 },
  { id: 'doc', name: '文档', desc: '编写用户需要的使用说明或 README', inputs: { goal: '文档目标和读者', writes: '文档改动范围' }, output: { artifacts: '说明文档路径' }, executor: 'agent', defaultRole: 'worker', defaultEstimateMs: 120000 },
  { id: 'deliver', name: '交付', desc: '汇总交付说明并宣布完成（finish 的等价动作）', inputs: { summary: '如何打开使用、已实现内容和已知限制', artifacts: '交付文件相对路径' }, output: { summary: '交付说明', artifacts: '交付文件' }, executor: 'panel', defaultRole: 'leader', defaultEstimateMs: 1000 },
];
const isComponents = st => st.orchestration === 'components';
const componentDef = id => COMPONENTS.find(c => c.id === id);
const COMPONENT_PRINCIPLES = '流程深浅你自己按需求判断。简单的东西直接实现 + 快速自查就交付；只有真的需要时才写需求文档、方案、拆分、交叉验收。不要为流程而流程：不派同步文档、核对就绪、准备报告这类不产出用户价值的活。老板看重“好看好用”。拿不准需求时用 clarify 问一次，别猜大方向。';
let componentHistoryCache = { at: 0, key: '', value: [] };
function componentCatalog(p) {
  const roots = new Set([config.project, ...(config.recent || []), p?.root].filter(Boolean));
  if (isDir(config.projectsRoot)) for (const e of fs.readdirSync(config.projectsRoot, { withFileTypes: true })) if (e.isDirectory()) roots.add(path.join(config.projectsRoot, e.name));
  const key = [...roots].sort().join('|');
  if (componentHistoryCache.key === key && Date.now() - componentHistoryCache.at < 10000) return componentHistoryCache.value;
  const samples = Object.fromEntries(COMPONENTS.map(c => [c.id, []]));
  for (const root of roots) {
    const q = P(root), st = loadState(q), callRuns = new Set((st.components || []).flatMap(c => c.runIds || [c.runId]).filter(Boolean));
    for (const c of st.components || []) {
      const ms = Date.parse(c.endedAt) - Date.parse(c.startedAt || c.createdAt);
      if (samples[c.component] && Number.isFinite(ms) && ms >= 0) samples[c.component].push(ms);
    }
    const graph = readJson(q.workflow, {});
    for (const r of st.runs) {
      if (callRuns.has(r.id)) continue;
      const preset = (graph.nodes || []).find(n => n.id === r.nodeId)?.config?.preset;
      const id = r.component || ({ prd: 'spec', architecture: 'design', epics: 'split' })[r.stage || preset] || ({ implement: 'implement', review: 'review', test: 'test' })[r.kind];
      const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt);
      if (samples[id] && Number.isFinite(ms) && ms >= 0) samples[id].push(ms);
    }
  }
  const value = COMPONENTS.map(c => ({ ...c, count: samples[c.id].length, avgMs: samples[c.id].length ? Math.round(samples[c.id].reduce((a, b) => a + b, 0) / samples[c.id].length) : c.defaultEstimateMs, estimated: !samples[c.id].length }));
  componentHistoryCache = { at: Date.now(), key, value }; return value;
}
function componentCalls(p, st = loadState(p)) {
  return (st.components || []).map(c => {
    const runs = (c.runIds || [c.runId]).map(id => st.runs.find(r => r.id === id)).filter(Boolean), active = runs.find(r => ['running', 'queued'].includes(r.status));
    return { ...c, name: componentDef(c.component)?.name || c.component, status: active?.status || c.status, runId: active?.id || c.runId, runs: runs.map(r => ({ id: r.id, agent: r.agent, model: r.model, status: r.status, variant: r.variant })), lastLine: active ? live.get(active.id) || active.lastLine : null };
  });
}
function componentGraph(p, st = loadState(p)) {
  const calls = componentCalls(p, st), levels = new Map([['start', 0]]), rows = new Map(), nodes = [{ id: 'start', type: 'start', title: '需求', x: 70, y: 90, config: {} }], edges = [];
  for (const c of calls) {
    const deps = c.depends_on?.length ? c.depends_on : ['start'], level = 1 + Math.max(...deps.map(id => levels.get(id) || 0)), row = rows.get(level) || 0;
    levels.set(c.id, level); rows.set(level, row + 1);
    nodes.push({ id: c.id, type: 'component', title: c.name, x: 70 + level * 310, y: 90 + row * 180, config: { component: c.component, callId: c.id, agent: c.agent, model: c.model, why: c.why, depth: c.depth, leaderTick: c.leaderTick, leaderRunId: c.leaderRunId, leaderWhy: c.leaderWhy, skills: c.skills || [], componentSkills: c.componentSkills || [], autoSkills: c.autoSkills || [], leaderSkills: c.leaderSkills || [], effectiveSkills: c.effectiveSkills || [] } });
    for (const from of deps) edges.push({ from, to: c.id });
  }
  if (st.leaderBoard?.finished) {
    const leaves = calls.filter(c => !calls.some(x => x.depends_on?.includes(c.id))).map(c => c.id);
    nodes.push({ id: 'end', type: 'end', title: '完成', x: 70 + (1 + Math.max(0, ...levels.values())) * 310, y: 90, config: {} });
    for (const from of leaves.length ? leaves : ['start']) edges.push({ from, to: 'end' });
  }
  return { name: '组件化编排 · 实况图', nodes, edges };
}
function componentStates(p, st) {
  return { start: { status: requirementText(p) ? 'done' : 'idle' }, ...Object.fromEntries(componentCalls(p, st).map(c => [c.id, { ...c, finishedAt: c.endedAt }])), ...(st.leaderBoard?.finished ? { end: { status: 'done' } } : {}) };
}
const componentResultValid = r => !!r && typeof r === 'object' && !Array.isArray(r) && typeof r.summary === 'string' && Array.isArray(r.artifacts) && r.artifacts.every(f => typeof f === 'string' && !path.win32.isAbsolute(f) && !path.posix.isAbsolute(f) && !f.split(/[\\/]/).includes('..')) && (r.pass === undefined || typeof r.pass === 'boolean') && ['findings', 'tasks', 'open_questions'].every(k => r[k] === undefined || Array.isArray(r[k]));
function componentAsk(p, q, guard = null) {
  const st = loadState(p); st.leaderBoard ||= {}; st.leaderBoard.ask = { q, at: now(), answered: false, guard }; saveState(p, st);
}
function componentTarget(c) { return String(c.inputs?.target || c.inputs?.task_id || c.inputs?.goal || c.inputs?.title || JSON.stringify(c.inputs?.writes || []) || 'project').trim().toLowerCase(); }
function componentFailureGuard(p, call) {
  const st = loadState(p), prior = st.components.filter(c => c.component === call.component && componentTarget(c) === componentTarget(call) && ['done', 'failed'].includes(c.status)).slice(-2);
  if (prior.length === 2 && prior.every(c => c.status === 'failed')) componentAsk(p, `组件“${componentDef(call.component).name}”对目标“${componentTarget(call)}”已连续失败 2 次：${call.error || call.result?.summary || '结果未通过'}。请说明下一步如何处理。`, 'failures');
}
function selectComponentAgent(st, c, a) {
  const available = loadAgents().filter(x => x.available), requested = a.agent || a.inputs?.agent;
  let who = requested === 'leader' ? st.leader : requested;
  const targetIds = new Set([...(a.depends_on || []), a.inputs?.target].filter(Boolean));
  for (const id of targetIds) for (const dep of st.components.find(x => x.id === id)?.depends_on || []) targetIds.add(dep);
  const implementers = new Set(st.components.filter(x => ['implement', 'fix'].includes(x.component) && (targetIds.has(x.id) || (a.inputs?.target && componentTarget(x) === String(a.inputs.target).toLowerCase()))).map(x => x.agent));
  if (!targetIds.size && ['review', 'crosscheck'].includes(c.id)) for (const x of st.components.filter(x => ['implement', 'fix'].includes(x.component))) implementers.add(x.agent);
  if (!who) who = c.defaultRole === 'reviewer' ? available.find(x => !implementers.has(x.id))?.id : st.leader || available[0]?.id;
  if (!available.some(x => x.id === who)) throw new Error(`执行 agent 不可用：${who || '未选择'}`);
  if (c.defaultRole === 'reviewer' && implementers.has(who)) throw new Error('评审/交叉验收必须由非实现者执行，请选另一个 agent');
  return who;
}
function addComponentCall(p, a, { defer = false, leaderTick = null, leaderRunId = null, leaderWhy = '' } = {}) {
  const st = loadState(p), def = componentDef(a.component);
  if (!isComponents(st)) throw new Error('当前不是组件编排模式');
  if (!def) throw new Error('未知组件');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(a.id || '') || ['start', 'end'].includes(a.id)) throw new Error('调用 id 必须是项目内唯一的字母数字/下划线/短横线（不能用 start/end）');
  if (st.components.some(c => c.id === a.id)) throw new Error('调用 id 已使用，重做请换新 id');
  if (st.leaderBoard?.ask && !st.leaderBoard.ask.answered) throw new Error('正在等待老板回答');
  if (st.leaderBoard?.finished) throw new Error('项目已交付，请先继续做');
  if (st.components.length >= (st.componentCallLimit || 80)) { componentAsk(p, `本项目已调用 ${st.components.length} 个组件，达到调用上限，已暂停。是否继续增加调用额度？`, 'limit'); throw new Error('组件调用达到上限，等待老板决定'); }
  if (!a.inputs || typeof a.inputs !== 'object' || Array.isArray(a.inputs)) throw new Error('inputs 必须是对象');
  const depends_on = a.depends_on || [];
  if (!Array.isArray(depends_on) || depends_on.some(id => id !== 'start' && !st.components.some(c => c.id === id))) throw new Error('depends_on 必须引用已声明的调用 id');
  if (a.depth && (!def.depthOptions || !def.depthOptions.includes(a.depth)) && a.depth !== 'brief') throw new Error('此组件不支持指定深度');
  if (a.inputs.writes !== undefined && (!Array.isArray(a.inputs.writes) || a.inputs.writes.some(f => typeof f !== 'string' || path.win32.isAbsolute(f) || path.posix.isAbsolute(f) || f.split(/[\\/]/).includes('..')))) throw new Error('writes 必须是项目内相对路径数组');
  if ([a.skills, a.inputs.skills].some(ids => ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())))) throw new Error('skills 必须是非空字符串数组');
  if (def.id === 'split' && a.inputs.max !== undefined && (!Number.isInteger(a.inputs.max) || a.inputs.max < 1)) throw new Error('max 必须是正整数');
  const agent = def.executor === 'agent' ? selectComponentAgent(st, def, a) : st.leader;
  if (def.id === 'compare' && (!Array.isArray(a.inputs.agents) || a.inputs.agents.length !== 2 || new Set(a.inputs.agents).size !== 2 || a.inputs.agents.some(id => !loadAgents().some(x => x.id === id && x.available)))) throw new Error('方案对比需要两个不同且可用的 agent');
  if (def.id === 'clarify' && (!Array.isArray(a.inputs.questions) || !a.inputs.questions.length || a.inputs.questions.some(q => typeof q !== 'string' || !q.trim()))) throw new Error('澄清需要非空问题列表');
  if (def.id === 'deliver' && (typeof a.inputs.summary !== 'string' || !a.inputs.summary.trim())) throw new Error('交付需要 summary');
  if (def.id === 'deliver' && !componentResultValid({ summary: a.inputs.summary, artifacts: a.inputs.artifacts || [] })) throw new Error('交付 artifacts 必须是项目内相对路径数组');
  const call = { id: a.id, component: def.id, name: def.name, agent, model: loadAgents().find(x => x.id === agent)?.effectiveModel || '', depth: a.depth || (def.depthOptions ? 'brief' : null), inputs: a.inputs, requestedSkills: [...(a.skills || []), ...(a.inputs.skills || [])], depends_on: [...new Set(depends_on)], why: String(a.why || leaderWhy || '手动调用组件'), leaderTick, leaderRunId, leaderWhy: String(leaderWhy || a.why || '手动调用组件'), status: 'pending', createdAt: now(), runIds: [] };
  Object.assign(call, mergeComponentSkills(p, call, agent, st));
  st.components.push(call); st.wf ||= { nodes: {} }; st.wf.substantiveStartedAt ||= now(); if (!defer && st.mode === 'manual') st.wf.running = true; saveState(p, st);
  if (!defer) advanceComponents(p, true);
  broadcast('state', {}); return call;
}
const componentWrites = c => [...(c.inputs.writes || (['implement', 'fix', 'doc', 'spec', 'design', 'compare'].includes(c.component) ? ['**'] : [])), ...(['spec', 'design'].includes(c.component) && c.depth === 'full' ? ['_bmad/', '.agents/', '.claude/'] : [])];
function missingComponentSkills(p, c) { return (componentDef(c.component).skills?.[c.depth] || []).filter(name => !scanSkills(p.root).some(s => s.name === name)); }
function componentWritesOverlap(a, b) {
  const base = f => String(f).replace(/\\/g, '/').toLowerCase().replace(/[*?[].*$/, '').replace(/\/+$/, '');
  return componentWrites(a).some(x => componentWrites(b).some(y => { const u = base(x), v = base(y); return !u || !v || u === v || u.startsWith(v + '/') || v.startsWith(u + '/') || (/[*?[]/.test(x + y) && (u.startsWith(v) || v.startsWith(u))); }));
}
function cancelComponentCall(p, id, why) {
  const st = loadState(p), c = st.components.find(x => x.id === id);
  if (!c || ['done', 'failed', 'cancelled'].includes(c.status)) throw new Error('只能取消尚未完成的调用');
  c.status = 'cancelled'; c.endedAt = now(); c.error = why || '已取消';
  if (st.leaderBoard?.ask?.callId === id) delete st.leaderBoard.ask;
  saveState(p, st); for (const runId of c.runIds || []) { const r = loadState(p).runs.find(x => x.id === runId); if (r && ['queued', 'running'].includes(r.status)) cancel(runId, p, true); }
  setImmediate(() => { advanceComponents(p); scheduleTick(p, '组件已取消'); broadcast('state', {}); });
}
function advanceComponents(p, force = false) {
  let st = loadState(p);
  if (st.requirementChanged) return;
  if ((!isComponents(st) && !st.fixedRecipe) || (!force && !st.wf?.running) || st.leaderBoard?.error || (st.leaderBoard?.ask && !st.leaderBoard.ask.answered) || st.leaderBoard?.finished) return;
  rememberWorkflowRequirement(p, st); saveState(p, st);
  for (const pending of st.components.filter(c => c.status === 'pending')) {
    st = loadState(p); const c = st.components.find(x => x.id === pending.id);
    if (st.leaderBoard?.ask && !st.leaderBoard.ask.answered) break;
    if (c.depends_on.some(id => id !== 'start' && st.components.find(x => x.id === id)?.status !== 'done')) continue;
    if (st.components.some(x => x.id !== c.id && (['queued', 'running'].includes(x.status) || st.runs.some(r => r.callId === x.id && ['queued', 'running'].includes(r.status))) && componentWritesOverlap(c, x))) continue;
    const def = componentDef(c.component); c.startedAt = now();
    if (def.executor === 'human') {
      c.status = 'waiting'; st.leaderBoard ||= {}; st.leaderBoard.ask = { q: c.inputs.questions.join('\n'), at: now(), answered: false, callId: c.id }; saveState(p, st); break;
    }
    if (def.executor === 'panel') {
      if (st.fixedRecipe) {
        c.status = 'done'; c.endedAt = now(); c.result = { summary: st.components.filter(x => x.id !== c.id && x.result?.summary).map(x => x.result.summary).at(-1) || '本次固定工作流已完成。', artifacts: [] }; saveState(p, st); continue;
      }
      if (st.components.some(x => x.id !== c.id && ['pending', 'queued', 'running', 'waiting'].includes(x.status))) continue;
      if (st.runs.some(r => r.kind !== 'tick' && ['queued', 'running'].includes(r.status))) continue;
      c.status = 'done'; c.endedAt = now(); c.result = { summary: c.inputs.summary, artifacts: c.inputs.artifacts || [] };
      st.leaderBoard ||= {}; st.leaderBoard.finished = { at: now(), summary: c.result.summary }; st.wf.running = false; st.wf.finishedAt = now(); saveState(p, st); break;
    }
    c.status = 'queued'; saveState(p, st);
    try {
      if (c.component === 'compare') for (const [i, agentId] of c.inputs.agents.entries()) enqueue({ project: p.root, kind: 'component', callId: c.id, agentId, variant: `方案${i + 1}` });
      else enqueue({ project: p.root, kind: 'component', callId: c.id, agentId: c.agent, bootstrap: !!missingComponentSkills(p, c).length });
    } catch (e) {
      const s2 = loadState(p), c2 = s2.components.find(x => x.id === c.id); c2.status = 'failed'; c2.error = e.message; c2.endedAt = now(); saveState(p, s2); componentFailureGuard(p, c2);
    }
  }
  st = loadState(p);
  if (st.fixedRecipe && st.wf?.running && st.components.every(c => c.status === 'done')) {
    st.wf.running = false; st.wf.finishedAt = now(); st.leaderBoard ||= {};
    st.leaderBoard.finished = { at: now(), summary: st.components.filter(c => c.result?.summary).at(-1)?.result.summary || '本次固定工作流已完成。' }; saveState(p, st); broadcast('state', {});
  } else if (st.fixedRecipe && st.wf?.running && !st.components.some(c => ['queued', 'running'].includes(c.status)) && st.components.some(c => ['failed', 'cancelled'].includes(c.status))) {
    const failed = st.components.find(c => ['failed', 'cancelled'].includes(c.status));
    st.wf.running = false; st.wf.finishedAt = now(); st.leaderBoard ||= {}; st.leaderBoard.ask = null; st.leaderBoard.error = `固定工作流停止：${failed.name || failed.component}（${failed.id}）${failed.error || '执行未成功'}`;
    for (const c of st.components) if (['pending', 'waiting'].includes(c.status)) { c.status = 'cancelled'; c.error = '固定工作流有失败调用，未继续执行'; c.endedAt = now(); }
    saveState(p, st); broadcast('state', {});
  }
}
const COMPONENT_TASKS = {
  spec: 'brief：只写十几行需求要点和验收要点。full：使用 BMAD PRD 技能生成完整 PRD。',
  design: 'brief：只写几条关键技术决策。full：使用 BMAD 架构技能生成完整架构。',
  split: '只拆有用户价值的任务，遵守 inputs.max；tasks 必须输出 [{id,title,goal,acceptance:[验收要点],agent,depends_on:[任务id]}]。不要派同步文档、核对就绪、准备报告之类流程杂活。',
  implement: '按指令实现可运行的产品。自己完成与改动相称的快速检查。注意界面好看好用。',
  test: '验证关注点，报告实际命令和证据；界面使用下面的 ui-check 工具。pass 明确表示测试是否通过，不修产品代码。',
  review: '独立读实现代码和现有验证结果，找实际问题。不要修改产品代码；pass 表示是否可通过，findings 描述位置、原因和影响。',
  crosscheck: '逐条验收，报告每条验收要点的方法、结果和证据。你是非实现者，不改产品代码；pass 表示是否全部通过。',
  compare: '独立提出一版方案，说明取舍和适用条件。不要写产品代码。将方案写在独立文件中，不覆盖另一人的方案。',
  fix: '逐条处理 findings，修改后做针对性的验证；说明哪些已修复、哪些仍待处理。',
  doc: '只写用户需要的使用说明或 README，内容与实际实现一致。',
};
function mergeComponentSkills(p, c, agentId, st = loadState(p)) {
  if (['human', 'panel'].includes(componentDef(c.component)?.executor)) return { skills: [], componentSkills: [], autoSkills: [], leaderSkills: [], effectiveSkills: [] };
  const have = scanSkills(p.root), bare = id => have.find(s => s.id === id)?.name || String(id).split(':').at(-1);
  const resolve = id => have.find(s => s.id === id)?.id || have.find(s => s.name === bare(id))?.id || id;
  const groups = {
    skills: c.requestedSkills || [...(c.skills || []), ...(c.inputs?.skills || [])],
    componentSkills: (componentDef(c.component)?.skills?.[c.depth] || []).map(name => have.find(s => s.name === name)?.id || `project:${name}`),
    autoSkills: recommendSkills(p, `${requirementText(p)}\n${c.why || ''}\n${JSON.stringify(c.inputs || {})}`),
    leaderSkills: agentId === st.leader ? st.leaderSkills || [] : [],
  };
  const seen = new Set(), entries = [];
  for (const [source, ids] of Object.entries(groups)) for (const id of ids) {
    if (typeof id !== 'string' || !id.trim()) continue;
    const resolved = resolve(id), name = bare(resolved);
    if (seen.has(name)) continue;
    seen.add(name); entries.push({ id: resolved, source });
  }
  // 保底技能预留槽位；Leader 额外技能、组件默认、自动推荐、Leader 默认依次填余下名额。
  const requiredNames = new Set(['bmad-build', 'verification-before-completion']);
  const required = entries.filter(s => requiredNames.has(bare(s.id)));
  const selected = entries.length > 6 ? [...entries.filter(s => !requiredNames.has(bare(s.id))).slice(0, 6 - required.length), ...required] : entries;
  return { ...Object.fromEntries(Object.keys(groups).map(source => [source, selected.filter(s => s.source === source).map(s => s.id)])), effectiveSkills: selected.map(s => s.id) };
}
function componentTask(p, callId, resultPath, agentId, variant) {
  const st = loadState(p), c = st.components.find(x => x.id === callId), def = componentDef(c.component);
  const chosen = mergeComponentSkills(p, c, agentId, st).effectiveSkills;
  const deps = st.components.filter(x => c.depends_on.includes(x.id)).map(x => ({ id: x.id, component: x.component, result: x.result }));
  const variants = variant === '合并' ? st.runs.filter(r => (c.runIds || []).includes(r.id) && r.variant !== '合并').map(r => ({ agent: r.agent, result: readAgentResult(p, r) })) : null;
  return `# 组件任务：${def.name}${variant ? ' · ' + variant : ''}
项目根目录：${p.root}
调用 id：${c.id}；执行 agent：${agentId}；深度：${c.depth || '按任务需要'}
调用原因：${c.why}

## 老板需求原文
${requirementText(p)}
## 指令与输入
${JSON.stringify(c.inputs, null, 2)}
${variants ? `你是 Leader。比较下面两份独立方案，合并成可执行结论并说明取舍。\n${JSON.stringify(variants, null, 2)}` : COMPONENT_TASKS[c.component]}
${c.component === 'compare' && !variants ? `本方案产出文件使用 ${c.id}-${agentId} 前缀，避免与另一位重叠。` : ''}
## 依赖的结果
${JSON.stringify(deps, null, 2)}
## 老板留言和全局笔记
${JSON.stringify(st.leaderBoard?.answers || [])}
${st.leaderBoard?.notes || ''}
## 改动范围
${JSON.stringify(componentWrites(c))}（空数组：不改产品实现，可保存本组件的测试/报告产出）
${skillsPrompt(p, chosen)}
## 公共约束
${commonRules(p)}
- 组件任务自主执行，不等待老板批准计划；大方向不明确时在 open_questions 写清楚，交给 Leader 调用澄清组件。
- 不改 sprint-status.yaml，不改 _bmad-output/panel/ 中的调度文件；只允许写下面指定的结果 JSON。
- UI 无头测试：node ${UI_CHECK} --root <项目根目录> --steps <步骤.json> --out <结果.json> --shot <截图.png>
## 统一结果（必须）
把 JSON 写到 ${resultPath}（UTF-8，无 Markdown 包裹）：
{"summary":"实际完成情况和验证结果","artifacts":["项目内相对路径"],"findings":[],"tasks":[],"pass":true,"open_questions":[]}
可省略 findings/tasks/pass/open_questions；summary 和 artifacts 必须保留。编码损坏或结构不合法会被判失败。
`;
}
function finishComponentRun(p, run, result, patch) {
  const st = loadState(p), c = st.components.find(x => x.id === run.callId); if (!c) return;
  if (['failed', 'cancelled'].includes(c.status)) return;
  if (patch.status === 'cancelled') { c.status = 'cancelled'; c.endedAt = now(); c.error = '已取消'; saveState(p, st); return; }
  const ok = patch.status === 'finished' && componentResultValid(result) && !hasBrokenEncoding(result) && result.pass !== false;
  if (run.bootstrap && ok) {
    if (!st.wf?.running) { c.status = 'pending'; c.startedAt = null; saveState(p, st); return; }
    try { enqueue({ project: p.root, kind: 'component', callId: c.id, agentId: c.agent }); return; } catch (e) { patch.error = e.message; }
  }
  if (c.component === 'compare') {
    const runs = st.runs.filter(r => (c.runIds || []).includes(r.id));
    if (runs.some(r => ['queued', 'running'].includes(r.status))) return;
    if (runs.length < 2) return;
    if (run.variant !== '合并' && runs.every(r => r.status === 'finished' && componentResultValid(readAgentResult(p, r)) && readAgentResult(p, r).pass !== false && !hasBrokenEncoding(readAgentResult(p, r)))) {
      saveState(p, st);
      try { enqueue({ project: p.root, kind: 'component', callId: c.id, agentId: st.leader, variant: '合并' }); return; } catch (e) { patch.error = e.message; }
    } else if (run.variant !== '合并') patch.error = '至少一份对比方案失败';
  }
  const success = ok && !patch.error;
  c.status = success ? 'done' : 'failed'; c.endedAt = now(); c.result = result || null;
  c.error = success ? null : patch.error || (hasBrokenEncoding(result) ? '组件结果编码损坏' : result?.pass === false ? '组件结果未通过（pass=false）' : '组件结果 JSON 不符合统一格式');
  if (c.component === 'split' && success && (!Array.isArray(result.tasks) || (c.inputs.max && result.tasks.length > c.inputs.max) || result.tasks.some(t => !t || typeof t.title !== 'string' || typeof t.goal !== 'string' || !Array.isArray(t.acceptance) || !Array.isArray(t.depends_on) || typeof t.agent !== 'string'))) { c.status = 'failed'; c.error = '拆分结果 tasks 缺少标题、目标、验收要点、建议 agent、依赖，或超出 max'; }
  saveState(p, st); componentHistoryCache.at = 0; if (c.status === 'failed') componentFailureGuard(p, c);
}
function componentLeaderBrief(p, resultPath) {
  const st = loadState(p), L = st.leaderBoard || {}, calls = componentCalls(p, st), agents = loadAgents().filter(a => a.available);
  return `# Leader 组件编排简报
项目根目录：${p.root}
你是完全自主的 Leader，边做边决定下一步，无需先向老板确认计划。只编排和判断，不亲自写产品代码。
## 需求原文
${requirementText(p)}
## 老板留言与回答
${JSON.stringify(L.answers || [], null, 2)}
## 原则
${COMPONENT_PRINCIPLES}
## 参考配方（仅供参考）
${savedReferenceBrief(st)}
- 小需求：implement → test → deliver。
- 中等：spec(brief) → split → 多个 implement 并行 → review → fix → deliver。
- 大：spec(full) → design(full) → split → 按实际需要实现、测试、验收 → deliver。
## 可调用组件（耗时是事实数据/无历史时为估计，不是规则）
${JSON.stringify(componentCatalog(p), null, 2)}
推荐技能会自动带上，你只需要写额外需要的（call 的 skills 或 inputs.skills，可省略）；组件按深度自带的技能也会自动装载。
## 已调用时间线（包含 why、状态、耗时、产出、问题）
${JSON.stringify(calls.map(c => ({ ...c, elapsedMs: Date.parse(c.endedAt || now()) - Date.parse(c.startedAt || c.createdAt) })), null, 2)}
## 正在运行/排队
${JSON.stringify(calls.filter(c => ['running', 'queued', 'pending'].includes(c.status)).map(c => ({ id: c.id, component: c.component, agent: c.agent, status: c.status, lastLine: c.lastLine })))}
## 全局笔记
${L.notes || '（无）'}
## 可用 agent 与模型、特长
${agents.map(a => `- ${a.id}｜${a.effectiveModel || '默认模型'}｜${a.strengths}`).join('\n')}
并发上限：${config.maxParallel || 1}（Leader 唤醒不占名额）；已调用 ${calls.length}/${st.componentCallLimit || 80}。
## 动作
- {"type":"call","id":"c7","component":"implement","agent":"codex","depth":"brief","inputs":{"instructions":"具体指令","writes":["index.html"],"target":"稳定目标名"},"depends_on":["c3"],"why":"一句话"}
- 一轮可多个 call，先声明依赖，再声明引用它的调用。无依赖且改动范围不重叠时并行。id 项目内唯一，重做再 call 新 id。依赖只在成功后启动；失败后改用新的成功调用作为依赖，别让旧 pending 调用永久等待（必要时用 cancel_call）。
- split 后的 implement/fix 请在 inputs.task_id 填对应 tasks[].id，供任务看板关联状态。
- {"type":"cancel_call","id":"c7","why":"已被新调用取代"}：取消尚未完成的调用。
- {"type":"ask_human","question":"只有真拿不准的大方向才问"} 是 clarify 快捷方式。
- {"type":"finish","summary":"交付说明：如何打开使用、实现了什么、已知限制"} 是 deliver 快捷方式。
- deliver / finish 在所有调用停止后交付；已有失败不强制重做，由你判断是否影响需求。不要 approve_node / rerun_node / set_status / dispatch，不使用 Story 或 sprint-status，也没有验收档位。
- 评审/交叉验收使用不同于目标实现者的 agent；方案对比 inputs.agents 为两个不同可用 agent，面板自动执行两版并让 Leader 合并。
- test 可与实现使用同一 agent；界面测试工具：node ${UI_CHECK} --root <项目> --steps <步骤.json> --out <结果.json>。
- 没有可做的事、只等正在运行的组件时 actions=[]。失败和编码损坏要读清原因；同组件同目标连续失败两次会问老板；调用总数到上限会暂停问老板。
${FORBIDDEN}
## 输出
把 JSON 写入 ${resultPath}（UTF-8，无 Markdown 包裹）：
{"notes":"更新全局笔记：事实、风险和下一步","progress":{"is_done":false,"is_looping":false,"making_progress":true,"reason":"一句话"},"actions":[]}
`;
}
function applyComponentTick(p, run, result) {
  let st = loadState(p), L = st.leaderBoard ||= {}; L.ticks = (L.ticks || 0) + 1; L.lastTickAt = run.startedAt || run.createdAt;
  if (!st.wf?.running) { L.pending = false; saveState(p, st); return; }
  const pending = L.pending; L.pending = false;
  const allowed = new Set(['call', 'ask_human', 'finish', 'cancel_call']);
  const valid = result && !hasBrokenEncoding(result) && typeof result.notes === 'string' && result.progress && typeof result.progress === 'object' && ['is_done', 'is_looping', 'making_progress'].every(k => typeof result.progress[k] === 'boolean') && typeof result.progress.reason === 'string' && Array.isArray(result.actions) && result.actions.every(a => a && allowed.has(a.type));
  if (!valid) {
    L.fails = (L.fails || 0) + 1; if (L.fails >= 3) L.error = 'Leader 连续 3 轮动作 JSON 不合法或编码损坏，已暂停';
    saveState(p, st); if (!L.error) scheduleTick(p, '上一轮动作 JSON 不合法，请修正'); return;
  }
  L.notes = result.notes; L.progress = result.progress; saveState(p, st);
  const log = { at: now(), run: run.id, tick: L.ticks, progress: result.progress, actions: [] }; let progress = false, invalid = false;
  const decision = { defer: true, leaderTick: L.ticks, leaderRunId: run.id, leaderWhy: result.progress.reason };
  for (const raw of result.actions) {
    const a = { ...raw }; let outcome = 'ok';
    try {
      if (a.type === 'call') addComponentCall(p, a, decision);
      else if (a.type === 'cancel_call') cancelComponentCall(p, a.id, a.why || 'Leader 取消');
      else if (a.type === 'ask_human') addComponentCall(p, { id: `ask-${run.id}`, component: 'clarify', inputs: { questions: [a.question] }, why: 'Leader 请求澄清' }, decision);
      else if (a.type === 'finish') addComponentCall(p, { id: `deliver-${run.id}`, component: 'deliver', inputs: { summary: a.summary || '' }, depends_on: loadState(p).components.filter(c => c.status === 'done').map(c => c.id), why: '需求已满足，交付给老板' }, decision);
      progress = true;
    } catch (e) { outcome = '失败：' + e.message; invalid = true; }
    log.actions.push({ ...a, outcome });
  }
  st = loadState(p); L = st.leaderBoard; L.log = [...(L.log || []), log].slice(-80); L.fails = invalid ? (L.fails || 0) + 1 : 0;
  if (L.fails >= 3) L.error = 'Leader 连续 3 轮动作无效，已暂停';
  const active = st.components.some(c => ['queued', 'running'].includes(c.status));
  L.idleTicks = progress || active ? 0 : (L.idleTicks || 0) + 1;
  if (L.idleTicks > 2) L.error = 'Leader 连续几轮没有推进，已暂停，等你看一下';
  saveState(p, st); advanceComponents(p);
  const after = loadState(p), waitingOnly = after.components.some(c => c.status === 'pending') && !after.components.some(c => ['queued', 'running'].includes(c.status));
  if (pending || invalid || waitingOnly || (!active && !after.leaderBoard.finished && !after.leaderBoard.error)) scheduleTick(p, invalid ? '动作无效，请修正' : waitingOnly ? '依赖未满足，请处理阻塞调用' : '继续推进');
}

// ---------- 工作流（Dify 式画布） ----------
const WF_TEMPLATES = path.join(HERE, 'workflows');
const automatic = st => ['auto', 'leader'].includes(st.mode);
const triageTimers = new Map();
const requirementText = p => exists(p.requirement) ? readMd(p.requirement).trim() : '';
const requirementId = text => createHash('sha256').update(text).digest('hex');
function rememberWorkflowRequirement(p, st) {
  st.wf ||= { nodes: {} };
  if (st.wf.requirementHash) return;
  st.wf.requirementText = requirementText(p);
  st.wf.requirementHash = requirementId(st.wf.requirementText);
}
// Migrate legacy rounds before the requirement can be overwritten. Persist repairs
// here as well as in the engine so the saved state and every view agree.
function reconcileWorkflowState(p, st) {
  const wf = st.wf;
  if (!wf) return;
  let dirty = false;
  const records = Object.entries(wf.nodes || {});
  const started = wf.startedAt || wf.substantiveStartedAt || wf.finishedAt || st.leaderBoard?.finished || st.components.length ||
    records.some(([id, r]) => id !== 'start' && ['running', 'waiting', 'done'].includes(r.status)) ||
    st.runs.some(r => r.kind !== 'triage' && (r.startedAt || ['queued', 'running', 'finished'].includes(r.status)));
  if (!wf.requirementHash && started) { rememberWorkflowRequirement(p, st); dirty = true; }
  if (wf.requirementHash) {
    const text = requirementText(p), hash = requirementId(text);
    if (hash !== wf.requirementHash && st.requirementChanged?.newHash !== hash) {
      st.requirementChanged = { oldHash: wf.requirementHash, newHash: hash, at: now(), oldRequirement: wf.requirementText || '', newRequirement: text };
      wf.running = false; st.runNotice = { code: 'requirement-changed', message: '需求已修改，现有产出基于旧需求' }; dirty = true;
    } else if (hash === wf.requirementHash && st.requirementChanged) {
      delete st.requirementChanged;
      if (st.runNotice?.code === 'requirement-changed') delete st.runNotice;
      dirty = true;
    }
  }
  if (st.orchestration !== 'components' && records.some(([, r]) => r.status === 'running') &&
      !st.runs.some(r => ['queued', 'running'].includes(r.status))) {
    const g = readJson(p.workflow, null) || readJson(path.join(WF_TEMPLATES, 'bmad-standard.json'), { nodes: [] });
    const progress = storyProgress(p);
    if (progress.total && progress.done === progress.total) for (const n of g.nodes.filter(n => n.type === 'dev')) {
      if (wf.nodes?.[n.id]?.status === 'running') {
        wf.nodes[n.id] = { ...wf.nodes[n.id], status: 'done', finishedAt: wf.nodes[n.id].finishedAt || wf.finishedAt || now(), note: null };
        dirty = true;
      }
    }
  }
  if (dirty) writeJson(p.state, st);
}
function requirementRevisionPrompt(st) {
  const change = st.requirementRevision;
  if (!change) return '';
  return `## 需求已变更：旧 → 新\n旧需求：\n${change.oldRequirement || '（旧轮次需求未记录）'}\n\n新需求：\n${change.newRequirement}\n\n这是按新需求重跑的轮次。现有 PRD、架构、Story、代码和交付记录可能基于旧需求；保留的旧文件仅供参考，必须按新需求改写，不能把旧产出或旧 Story 的完成状态当作本轮已完成。\n\n`;
}
const isQuickWorkflow = g => g.template === 'quick-build' || g.id === 'quick-build';
function workflowStarted(p, st = loadState(p)) {
  if (isComponents(st)) return !!st.wf?.substantiveStartedAt || !!st.wf?.startedAt || !!st.components.length || st.runs.some(r => r.kind === 'tick');
  // Filling the input is not substantive execution (nodeStates derives start=done).
  const g = readWorkflow(p), states = nodeStates(p, st, g);
  return !!st.wf?.finishedAt || !!st.wf?.substantiveStartedAt || g.nodes.some(n => n.type !== 'start' && ['done', 'running', 'waiting'].includes(states[n.id]?.status)) ||
    st.runs.some(r => !['tick', 'triage'].includes(r.kind) && (r.startedAt || ['queued', 'running', 'finished'].includes(r.status))) ||
    Object.values(st.stages || {}).some(s => ['running', 'review', 'approved'].includes(s.status));
}
const LEADER_PRIORITY = ['claude', 'codex', 'grok', 'gemini', 'deepseek'];
function availableLeader(agents = loadAgents()) { return LEADER_PRIORITY.map(id => agents.find(a => a.id === id)).find(a => a && agentAvailability(a).available); }
function leaderHealth(p, st = p ? loadState(p) : {}) {
  const agents = loadAgents(), agent = agents.find(a => a.id === st.leader), availability = agentAvailability(agent);
  const replacement = !availability.available && availableLeader(agents);
  return { id: st.leader || null, name: agent?.name || st.leader || '未选择', ...availability, ...(!st.leader ? { label: '未选择' } : {}), ...(replacement && replacement.id !== st.leader ? { replacement: { id: replacement.id, name: replacement.name } } : {}) };
}
function leaderWarning(st, p) {
  if (!st.leader) return automatic(st) ? '还没选 Leader，流程不会自动推进' : null;
  const health = leaderHealth(p, st);
  return !health.available && health.status !== 'unverified' ? `当前 Leader（${health.name}）${health.label}，流程不会推进` : null;
}
function ensureLeader(p) {
  const st = loadState(p);
  if (!automatic(st) || st.leader) return st;
  const candidate = availableLeader();
  if (candidate) { st.leader = candidate.id; st.leaderAutoSelection = { at: now(), agent: candidate.id, name: candidate.name }; saveState(p, st); }
  return st;
}
function triageSnapshot(p, st) {
  return { triage: isComponents(st) ? null : st.triage || null, triagePending: !isComponents(st) && !!st.triagePending, workflowStarted: workflowStarted(p, st), leaderHealth: leaderHealth(p, st), leaderWarning: leaderWarning(st, p), leaderAutoSelection: st.leaderAutoSelection || null };
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
  if (isComponents(st)) throw new Error('组件模式不使用分诊模板');
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
  st.wf = { ...st.wf, nodes: {}, running: !!st.wf?.running };
  if (st.triage) st.triage.applied = id;
  saveState(p, st); broadcast('workflow', {});
}
function requestTriage(p) {
  let st = loadState(p);
  if (isComponents(st) || st.workflowSelection) return false;
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
  const st = loadState(p); if (isComponents(st)) return componentGraph(p, st);
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
  if (isComponents(st)) return componentStates(p, st);
  if (st.fixedRecipe) { const states = componentStates(p, st); return Object.fromEntries(g.nodes.map(n => [n.id, states[n.id] || { status: 'idle' }])); }
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
function setNode(p, id, patch) { const st = loadState(p); st.wf = st.wf || { nodes: {} }; st.wf.nodes = st.wf.nodes || {}; st.wf.nodes[id] = { ...(st.wf.nodes[id] || {}), ...patch }; if (!st.requirementChanged) delete st.runNotice; saveState(p, st); }
const isLeaderRef = a => !a || a === 'leader';
function missingPresetSkills(p, n) {
  const name = { prd: 'bmad-prd', architecture: 'bmad-architecture', epics: 'bmad-create-epics-and-stories' }[n.config?.preset];
  return name && !exists(path.join(p.root, skillsBase(p), name, 'SKILL.md')) ? [name] : [];
}
function startNode(p, n, feedback) {
  const st = loadState(p), c = n.config || {};
  if (st.requirementChanged) return;
  rememberWorkflowRequirement(p, st); saveState(p, st);
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
    try { enqueue({ project: p.root, kind: 'node', nodeId: n.id, agentId: who, feedback, bootstrap: !!missingPresetSkills(p, n).length }); }
    catch (e) { setNode(p, n.id, { status: 'failed', note: e.message }); }
  }
}
function advanceWorkflow(p) {
  if (isComponents(loadState(p)) || loadState(p).fixedRecipe) return advanceComponents(p);
  for (let round = 0; round < 30; round++) {
    let st = loadState(p);
    if (!st.wf || !st.wf.running || st.requirementChanged) return;
    if (leaderWarning(st) || requestTriage(p)) return;
    st = loadState(p);
    const g = readWorkflow(p), ns = nodeStates(p, st, g);
    if (g.nodes.length && g.nodes.every(n => ns[n.id].status === 'done')) {
      // requestTriage may have just replaced the graph; always commit fresh state.
      const done = loadState(p); done.wf.running = false; done.wf.finishedAt = now();
      for (const n of g.nodes.filter(n => n.type === 'dev' && ns[n.id]?.status === 'done')) done.wf.nodes[n.id] = { ...done.wf.nodes[n.id], status: 'done', finishedAt: done.wf.nodes[n.id]?.finishedAt || done.wf.finishedAt, note: null };
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
  return { ...triageSnapshot(p, st), requirementChanged: st.requirementChanged || null, runNotice: st.runNotice || null, orchestration: st.orchestration, fixedRecipe: !!st.fixedRecipe, components: componentCatalog(p), calls: componentCalls(p, st), graph: g, states: nodeStates(p, st, g), running: !!(st.wf && st.wf.running), templates: listTemplates(), requirement: exists(p.requirement) ? readMd(p.requirement) : '' };
}
function workflowRunNotice(p, st) {
  const notice = (code, message, nodeIds = []) => ({ code, message, nodeIds });
  if (st.requirementChanged) return notice('requirement-changed', '需求已修改，现有产出基于旧需求');
  const g = readWorkflow(p), ns = nodeStates(p, st, g);
  if (st.leaderBoard?.finished || ((isComponents(st) || st.fixedRecipe) ? st.components.length && st.components.every(c => c.status === 'done') : g.nodes.length && g.nodes.every(n => ns[n.id]?.status === 'done'))) return notice('all-complete', '所有步骤都已完成');
  const waiting = g.nodes.filter(n => ns[n.id]?.status === 'waiting');
  const ready = g.nodes.filter(n => ns[n.id]?.status === 'idle' && preds(g, n.id).every(id => ns[id]?.status === 'done'));
  const active = st.runs.some(r => ['queued', 'running'].includes(r.status));
  if (st.leaderBoard?.ask && !st.leaderBoard.ask.answered) return notice('waiting-confirmation', 'Leader 在等你确认，请先回答问题', st.leaderBoard.ask.callId ? [st.leaderBoard.ask.callId] : []);
  if (!active && waiting.length && !ready.length) return notice('waiting-confirmation', `${waiting.map(n => n.title || n.id).join('、')} 节点在等你确认`, waiting.map(n => n.id));
  const warning = leaderWarning(st, p);
  if (warning) return notice(st.leader ? 'leader-unavailable' : 'no-leader', warning);
  if (!st.leader && g.nodes.some(n => ['agent', 'dev'].includes(n.type) && ns[n.id]?.status !== 'done' && (n.type === 'dev' || isLeaderRef(n.config?.agent)))) return notice('no-leader', '没有 Leader，流程不会推进');
  if (st.leaderBoard?.error) return notice('blocked', st.leaderBoard.error);
  if (!requirementText(p)) return notice('waiting-confirmation', '请先填写需求，再运行工作流', g.nodes.filter(n => n.type === 'start').map(n => n.id));
  if (isComponents(st) && !st.fixedRecipe) return null; // The Leader can choose the next component.
  if (st.fixedRecipe) {
    if (active || st.components.some(c => c.status === 'pending' && c.depends_on.every(id => id === 'start' || st.components.find(x => x.id === id)?.status === 'done'))) return null;
  } else if (active || ready.length) return null;
  const failed = g.nodes.filter(n => ['failed', 'cancelled'].includes(ns[n.id]?.status));
  if (failed.length) return notice('blocked', `${failed.map(n => n.title || n.id).join('、')} 节点失败或已取消，后续步骤被阻塞，请重跑`, failed.map(n => n.id));
  if (g.nodes.some(n => n.type === 'dev' && ns[n.id]?.status === 'running')) {
    if (automatic(st) && st.leader) return null;
    return notice('blocked', '开发看板等待派发 Story，请打开看板分配并运行任务', g.nodes.filter(n => n.type === 'dev').map(n => n.id));
  }
  return notice('blocked', '没有可以开始的步骤，请检查节点依赖或重跑');
}
function runWorkflow(p, why = '运行工作流') {
  ensureLeader(p);
  let st = loadState(p), notice = workflowRunNotice(p, st);
  if (notice) {
    st.runNotice = notice;
    st.wf ||= { nodes: {} };
    if (!st.runs.some(r => ['queued', 'running'].includes(r.status))) st.wf.running = false;
    saveState(p, st); broadcast('state', {}); return wfSnapshot(p);
  }
  st.wf ||= { nodes: {} }; st.wf.running = true; st.wf.startedAt ||= now();
  rememberWorkflowRequirement(p, st); delete st.runNotice; saveState(p, st);
  requestTriage(p); advanceWorkflow(p); autoDispatch(p); scheduleTick(p, why);
  st = loadState(p); notice = workflowRunNotice(p, st);
  if (notice) { st.runNotice = notice; saveState(p, st); }
  broadcast('state', {}); return wfSnapshot(p);
}
async function rerunWorkflow(p) {
  let st = loadState(p);
  // Stop dispatch first, then wait for cancelled processes to finish their state updates.
  st.wf ||= { nodes: {} }; st.wf.running = false; saveState(p, st);
  for (const r of st.runs.filter(r => ['queued', 'running'].includes(r.status))) cancel(r.id, p);
  const deadline = Date.now() + 10000;
  while (projectHasActiveRuns(p) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (projectHasActiveRuns(p)) throw new Error('旧任务还在停止，请稍后再点“在本项目重跑”');
  st = loadState(p);
  const text = requirementText(p), change = st.requirementChanged || { oldHash: st.wf.requirementHash, oldRequirement: st.wf.requirementText || text, newHash: requirementId(text), newRequirement: text, at: now() };
  const graph = readWorkflow(p), archive = path.join(p.panel, 'workflow-rounds', newRunId('rerun', 'panel'));
  fs.mkdirSync(archive, { recursive: true });
  writeJson(path.join(archive, 'runtime.json'), st);
  for (const [file, name] of [[p.plan, 'plan.json'], [p.sprint, 'sprint-status.yaml']]) if (exists(file)) fs.copyFileSync(file, path.join(archive, name));
  st.requirementRevision = { ...change, newRequirement: text, at: now() };
  delete st.requirementChanged; delete st.runNotice; delete st.triagePending;
  st.wf = { nodes: {}, running: false, startedAt: now(), substantiveStartedAt: now(), requirementHash: requirementId(text), requirementText: text };
  st.leaderBoard = { answers: st.leaderBoard?.answers || [], notes: '', finished: null, error: null, fails: 0, idleTicks: 0, ticks: 0, ask: null, pending: false };
  if (isComponents(st)) {
    st.componentArchive = [...(st.componentArchive || []), ...st.components]; st.components = []; st.mode = 'leader';
  } else if (st.fixedRecipe) {
    st.components = st.components.map(c => ({ ...c, status: 'pending', runId: null, runIds: [], result: null, error: null, startedAt: null, endedAt: null, createdAt: now() }));
  } else {
    st.wf.nodes = Object.fromEntries(graph.nodes.map(n => [n.id, n.type === 'start' ? { status: text ? 'done' : 'idle' } : { status: 'idle', stale: true, note: '上游已更新', feedback: '需求已变更，请按新需求改写旧文档和实现。' }]));
    st.stages = {}; st.assignments = {}; st.feedback = {}; st.autoRounds = {}; st.leaderInstr = {}; st.acceptance = {}; st.planInvalidated = true;
    if (exists(p.sprint)) for (const key of Object.keys(readSprint(p.sprint)).filter(k => /^\d+-\d+-|^epic-\d+$/.test(k))) writeSprintStatus(p.sprint, key, 'backlog');
  }
  saveState(p, st); return runWorkflow(p, '需求已变更：按新需求重新开始');
}
function newProjectFromRequirement(p, name) {
  const text = requirementText(p);
  if (!text) throw new Error('先填写新需求');
  const base = slug(String(name || Array.from(text).slice(0, 24).join('')).trim());
  let chosen = base, suffix = 2;
  while (exists(path.join(config.projectsRoot, chosen))) chosen = `${base}-${suffix++}`;
  const created = routes['POST /api/project/create']({ name: chosen, parent: config.projectsRoot, template: 'generic', requirement: text, mode: 'leader', orchestration: 'components' });
  const next = P(created.dir); runWorkflow(next, '用新需求新建项目并开始');
  return { ...created, project: created.dir };
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
  if (!st.wf?.running || st.requirementChanged || leaderWarning(st, p)) return;
  if (isComponents(st) || st.fixedRecipe) return;
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
  if (st.requirementChanged) return;
  if (isComponents(st) || st.fixedRecipe) return advanceComponents(p);
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
  if (mode) { st.mode = ['auto', 'leader'].includes(mode) ? mode : 'manual'; if (!st.requirementChanged) delete st.runNotice; }
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
const isLeaderMode = st => st.mode === 'leader' || (isComponents(st) && st.mode === 'auto');
const KIND_CN = { component: '组件', triage: '需求分诊', plan: '分配', implement: '执行 Story', review: '评审', node: '工作流节点', nodereview: '节点评审', task: '临时任务', stage: '阶段', tick: 'Leader 唤醒' };
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
function recommendSkills(p, input) {
  // 旧调用仍可传 {title, body}；组件可直接传需求、why 与 inputs 拼成的任意文本。
  const text = typeof input === 'string' ? input : (input?.title || '') + (input?.body || '');
  const have = new Set(scanSkills(p.root).map(x => x.id)), out = [];
  if (isUiStory({ title: text })) out.push('panel:headless-ui-check', 'panel:frontend-design', 'panel:ui-design-system', 'panel:a11y-audit');
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
  if (isComponents(loadState(p))) return componentLeaderBrief(p, resultPath);
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
function templateDecisionReasons(p, st = loadState(p)) {
  if (isComponents(st)) return ['组件编排由 Leader 决定下一步'];
  const g = readWorkflow(p), ns = nodeStates(p, st, g), L = st.leaderBoard || {}, reasons = [];
  const since = L.lastTickAt || st.wf?.startedAt || '1970';
  for (const n of g.nodes) {
    if (ns[n.id]?.status === 'waiting') reasons.push(`节点 ${n.id} 待确认`);
    if (['failed', 'cancelled'].includes(ns[n.id]?.status)) reasons.push(`节点 ${n.id} 失败待处理`);
  }
  const active = st.runs.filter(r => ['queued', 'running'].includes(r.status));
  const dev = g.nodes.find(n => n.type === 'dev' && ns[n.id]?.status === 'running');
  if (dev) {
    const sprint = readSprint(p.sprint), plan = readPlan(p);
    for (const [key, status] of Object.entries(sprint).filter(([key]) => /^\d+-\d+-/.test(key))) {
      if (active.some(r => r.storyKey === key || r.relatedStory === key)) continue;
      const assignment = plan?.assignments?.find(a => fullStoryKey(p, a.key) === key);
      if (['backlog', 'ready-for-dev'].includes(status) && !(assignment?.depends_on || []).some(dep => sprint[fullStoryKey(p, dep)] !== 'done')) reasons.push(`Story ${key} 待派发`);
      else if (status === 'review') reasons.push(`Story ${key} 待验收`);
    }
  }
  if ((L.answers || []).some(a => a.at > since)) reasons.push('老板有新留言或回答');
  if (L.fails > 0 && L.fails < 3) reasons.push('上一轮 Leader 未给出结果，需要重试');
  const fresh = r => r.endedAt > since && (!st.wf?.startedAt || (r.createdAt || r.startedAt || r.endedAt) >= st.wf.startedAt);
  if (st.runs.some(r => !['tick', 'triage'].includes(r.kind) && ['failed', 'cancelled'].includes(r.status) && fresh(r))) reasons.push('任务失败待处理');
  if (st.runs.some(r => ['plan', 'review', 'task'].includes(r.kind) && r.status === 'finished' && fresh(r))) reasons.push('新的分配或验收结果待处理');
  // 需求重跑期间保留的旧 Story 不会触发；等第一个规划节点真正产出后再判断。
  const firstPlanning = g.nodes.find(n => n.type === 'agent');
  if (firstPlanning && ns[firstPlanning.id]?.finishedAt > since && ['done', 'waiting'].includes(ns[firstPlanning.id]?.status)) reasons.push(`首个规划节点 ${firstPlanning.id} 已完成`);
  const work = g.nodes.filter(n => !['start', 'end', 'human'].includes(n.type));
  if (!active.some(r => !['tick', 'triage'].includes(r.kind)) && work.length && work.every(n => ns[n.id]?.status === 'done')) reasons.push('工作流完成待交付');
  return reasons;
}
function scheduleTick(p, why) {
  const st = loadState(p);
  if (st.requirementChanged) return;
  if (st.fixedRecipe) return;
  if (!isLeaderMode(st) || !st.leader) return;
  const warning = leaderWarning(st, p);
  if (warning) { st.leaderBoard ||= {}; st.leaderBoard.error = warning; st.leaderBoard.authBlockedAgent = st.leader; st.leaderBoard.authBlockedError = warning; st.leaderBoard.pending = false; saveState(p, st); return; }
  if (!st.wf?.running || !requirementText(p) || (!isComponents(st) && (st.triagePending || requestTriage(p) || isQuickWorkflow(readWorkflow(p))))) return;
  const L = st.leaderBoard = st.leaderBoard || {};
  if (L.finished || (L.ask && !L.ask.answered) || L.error) return;
  // 模板自行推进可执行节点；只有产出、Story、留言或失败需要判断时才叫 Leader。
  if (!isComponents(st) && !templateDecisionReasons(p, st).length) return;
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
  const authFailure = loadState(p).runs.find(r => r.id === run.id);
  if (authFailure?.authFailed) {
    const st = loadState(p); st.leaderBoard ||= {}; st.leaderBoard.error = authFailure.error; st.leaderBoard.pending = false;
    st.leaderBoard.ticks = (st.leaderBoard.ticks || 0) + 1; st.leaderBoard.lastTickAt = run.startedAt || run.createdAt; saveState(p, st); return;
  }
  if (isComponents(loadState(p))) return applyComponentTick(p, run, result);
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
  const log = { at: now(), run: run.id, tick: L.ticks, progress: result.progress || null, actions: [] };
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

// ---------- 可复用工作流（只保存定义，不保存运行状态或认证） ----------
const PRIVATE_FIELD = /^(?:key|env|proxy|headers?|result|results|status|runIds?|createdAt|startedAt|endedAt|finishedAt|model)$|api[_-]?key|secret|token|password|authorization|cookie|credentials?/i;
function portableValue(value, projectRoot = null) {
  const secrets = Object.values(readEnvFile('secrets.env')).filter(v => typeof v === 'string' && v.length >= 8);
  function clean(v) {
    if (typeof v === 'string') {
      let text = v;
      for (const secret of secrets) text = text.split(secret).join('[已移除密钥]');
      if (projectRoot) for (const root of [projectRoot, projectRoot.replace(/\\/g, '/'), projectRoot.replace(/\//g, '\\')]) text = text.split(root + path.sep).join('').split(root + '/').join('').split(root + '\\').join('').split(root).join('.');
      return text.replace(/\b(?:(?:sk|sess)-[A-Za-z0-9_-]{8,}|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}|AIza[A-Za-z0-9_-]{20,})/g, '[已移除密钥]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已移除密钥]')
        .replace(/\b(key|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\s*[:=]\s*["']?[^\s,"'};]+/gi, '$1=[已移除密钥]')
        .replace(/[A-Za-z]:[\\/][^\s\n"'<>|，。；）)\]}]+/g, m => path.win32.basename(m.replace(/\//g, '\\')) || '.')
        .replace(/\\\\[^\s\n"'<>|，。；）)\]}]+/g, m => path.win32.basename(m) || '.')
        .replace(/(^|[\s"'=:(])\/(?!\/)[^\s\n"'<>，。；）)\]}]+/g, (match, prefix) => prefix + (path.posix.basename(match.slice(prefix.length)) || '[项目相对路径]'))
        .replace(/(^|[\s"'=:(])\\(?!\\)[^\s\n"'<>，。；）)\]}]+/g, (match, prefix) => prefix + (path.win32.basename(match.slice(prefix.length)) || '[项目相对路径]'));
    }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !PRIVATE_FIELD.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k)).map(([k, x]) => [k, clean(x)]));
    return v;
  }
  return clean(value);
}
function cleanGraph(graph, projectRoot = null) {
  if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length || graph.nodes.length > 300 || !Array.isArray(graph.edges)) throw new Error('工作流需要非空 nodes 和 edges 数组（最多 300 个节点）');
  const g = { name: String(graph.name || ''), ...(typeof graph.id === 'string' ? { id: graph.id } : {}), ...(typeof graph.template === 'string' ? { template: graph.template } : {}), nodes: graph.nodes.map(n => ({ id: n.id, type: n.type, title: String(n.title || n.id), x: Number(n.x) || 0, y: Number(n.y) || 0, config: portableValue(n.config || {}, projectRoot) })), edges: graph.edges.map(e => ({ from: e.from, to: e.to })) };
  const ids = new Set(g.nodes.map(n => n.id));
  if (ids.size !== g.nodes.length || g.nodes.some(n => typeof n.id !== 'string' || !/^[\w-]{1,80}$/.test(n.id) || !['start', 'end', 'agent', 'human', 'dev'].includes(n.type))) throw new Error('节点 id 或节点类型不合法');
  if (g.edges.some(e => !ids.has(e.from) || !ids.has(e.to) || e.from === e.to)) throw new Error('连线必须引用不同的有效节点');
  const seen = new Set(), open = new Set();
  function visit(id) { if (open.has(id)) throw new Error('工作流不能有循环依赖'); if (seen.has(id)) return; open.add(id); for (const e of g.edges.filter(e => e.from === id)) visit(e.to); open.delete(id); seen.add(id); }
  for (const id of ids) visit(id);
  return portableValue(g, projectRoot);
}
function cleanRecipe(recipe, projectRoot = null) {
  const source = Array.isArray(recipe) ? recipe : recipe?.calls;
  if (!Array.isArray(source) || !source.length || source.length > 300) throw new Error('配方需要非空 calls 数组（最多 300 个调用）');
  const ids = new Set(['start']);
  const calls = source.map(c => {
    if (!componentDef(c.component) || !/^[\w-]{1,64}$/.test(c.id || '') || ids.has(c.id) || c.id === 'end') throw new Error('配方组件或调用 id 不合法');
    const deps = c.depends_on || [];
    if (!Array.isArray(deps) || deps.some(id => !ids.has(id))) throw new Error('配方依赖必须引用前面已声明的调用');
    ids.add(c.id);
    const call = portableValue({ id: c.id, component: c.component, depth: c.depth || null, agent: c.agent || 'leader', depends_on: deps, why: String(c.why || ''), inputs: c.component === 'deliver' ? {} : c.inputs || {} }, projectRoot);
    if (!call.inputs || typeof call.inputs !== 'object' || Array.isArray(call.inputs) || typeof call.agent !== 'string') throw new Error('配方 inputs 必须是对象，agent 必须是 id');
    const def = componentDef(c.component);
    if (call.depth && call.depth !== 'brief' && !def.depthOptions?.includes(call.depth)) throw new Error('配方组件的深度不合法');
    if (c.component === 'clarify' && (!Array.isArray(call.inputs.questions) || !call.inputs.questions.length || call.inputs.questions.some(q => typeof q !== 'string' || !q.trim()))) throw new Error('澄清配方需要非空 questions 数组');
    if (c.component === 'compare' && (!Array.isArray(call.inputs.agents) || call.inputs.agents.length !== 2 || new Set(call.inputs.agents).size !== 2 || call.inputs.agents.some(a => typeof a !== 'string'))) throw new Error('方案对比配方需要两个不同 agent');
    if (call.inputs.writes !== undefined && (!Array.isArray(call.inputs.writes) || call.inputs.writes.some(f => typeof f !== 'string' || path.win32.isAbsolute(f) || path.posix.isAbsolute(f) || f.split(/[\\/]/).includes('..')))) throw new Error('配方 writes 必须是项目相对路径数组');
    if (call.inputs.skills !== undefined && (!Array.isArray(call.inputs.skills) || call.inputs.skills.some(s => typeof s !== 'string'))) throw new Error('配方 skills 必须是字符串数组');
    return call;
  });
  return { calls };
}
function savedFile(id) {
  if (typeof id !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,99}$/u.test(id)) throw new Error('工作流 id 不合法');
  return path.join(SAVED_WORKFLOWS, `${id}.json`);
}
function normalizeSaved(input, projectRoot = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工作流 JSON 格式不对');
  const name = portableValue(String(input.name || '').trim(), projectRoot).slice(0, 120);
  if (!name) throw new Error('工作流名称不能为空');
  if (!['template', 'recipe'].includes(input.kind)) throw new Error('kind 必须是 template 或 recipe');
  const meta = { name, desc: portableValue(String(input.desc || ''), projectRoot).slice(0, 500), fit: portableValue(String(input.fit || ''), projectRoot).slice(0, 1000), kind: input.kind, createdAt: now(), from: portableValue(String(input.from || '导入文件'), projectRoot).slice(0, 120) };
  return { ...meta, ...(input.kind === 'recipe' ? { recipe: cleanRecipe(input.recipe, projectRoot) } : { graph: cleanGraph(input.graph, projectRoot) }) };
}
function listSavedWorkflows() {
  if (!isDir(SAVED_WORKFLOWS)) return [];
  return fs.readdirSync(SAVED_WORKFLOWS).filter(f => f.endsWith('.json')).flatMap(f => { const w = readJson(path.join(SAVED_WORKFLOWS, f), null); return w && ['template', 'recipe'].includes(w.kind) ? [{ ...w, id: path.basename(f, '.json') }] : []; }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
function getSavedWorkflow(id) { const w = readJson(savedFile(id), null); if (!w) throw new Error('没有这个保存的工作流'); return { ...w, id }; }
function storeSavedWorkflow(input, projectRoot = null) {
  const w = normalizeSaved(input, projectRoot), id = `${w.name.replace(/[^\p{L}\p{N}_-]/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workflow'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  writeJson(savedFile(id), w); broadcast('workflow', {}); return { ...w, id };
}
function savedReferenceBrief(st) {
  const w = st.workflowReference;
  return w ? `老板保存过的流程：${w.name}${w.desc ? '；' + w.desc : ''}。仅供参考，按本次需求调整。\n${JSON.stringify(w.kind === 'recipe' ? w.recipe : w.graph, null, 2)}\n` : '';
}
function recipeGraph(w) {
  const calls = w.recipe.calls, nodes = [{ id: 'start', type: 'start', title: '本次需求', x: 70, y: 90, config: {} }], edges = [], levels = new Map([['start', 0]]), rows = new Map();
  for (const c of calls) {
    const deps = c.depends_on.length ? c.depends_on : ['start'], level = 1 + Math.max(...deps.map(id => levels.get(id) || 0)), row = rows.get(level) || 0; rows.set(level, row + 1); levels.set(c.id, level);
    nodes.push({ id: c.id, type: 'component', title: componentDef(c.component).name, x: 70 + level * 310, y: 90 + row * 180, config: { component: c.component, depth: c.depth, agent: c.agent, why: c.why, inputs: c.inputs } });
    for (const from of deps) edges.push({ from, to: c.id });
  }
  nodes.push({ id: 'end', type: 'end', title: '完成', x: 70 + (Math.max(...levels.values()) + 1) * 310, y: 90, config: {} });
  for (const c of calls.filter(c => !calls.some(x => x.depends_on.includes(c.id)))) edges.push({ from: c.id, to: 'end' });
  return { name: w.name, nodes, edges, savedWorkflow: w.id };
}
function projectHasActiveRuns(p) { return loadState(p).runs.some(r => ['running', 'queued'].includes(r.status)); }
function beginTemplateRound(p, st, graph) {
  // A new requirement must not inherit "done" Stories or a previous dispatch plan.
  // Keep their original files and runtime metadata together for historical review.
  const hasDev = graph.nodes.some(n => n.type === 'dev'), hasEpics = graph.nodes.some(n => n.config?.preset === 'epics');
  if (!hasDev && !graph.nodes.some(n => n.config?.preset)) return;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, dir = path.join(p.panel, 'workflow-rounds', id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, name] of [[p.plan, 'plan.json'], [p.sprint, 'sprint-status.yaml']]) if (exists(file)) fs.copyFileSync(file, path.join(dir, name));
  writeJson(path.join(dir, 'runtime.json'), { at: now(), assignments: st.assignments || {}, feedback: st.feedback || {}, autoRounds: st.autoRounds || {}, leaderInstr: st.leaderInstr || {}, acceptance: st.acceptance || {}, stages: st.stages || {}, wf: st.wf || null });
  if (exists(p.plan)) fs.unlinkSync(p.plan);
  if (exists(p.sprint)) {
    if (hasEpics) fs.unlinkSync(p.sprint); // The epics node generates this round's status file.
    else if (hasDev) for (const key of Object.keys(readSprint(p.sprint)).filter(k => /^\d+-\d+-|^epic-\d+$/.test(k))) writeSprintStatus(p.sprint, key, 'backlog');
  }
  st.assignments = {}; st.feedback = {}; st.autoRounds = {}; st.leaderInstr = {}; st.acceptance = {}; st.stages = {};
  st.templateRound = { id, startedAt: now(), archive: path.relative(p.root, dir).replace(/\\/g, '/') };
}
function applySavedWorkflow(p, id, usage = 'reference') {
  if (!['reference', 'fixed'].includes(usage)) throw new Error('用法必须是 reference 或 fixed');
  if (projectHasActiveRuns(p)) throw new Error('项目有运行中的任务，请先完成或停止');
  const w = getSavedWorkflow(id), st = loadState(p);
  st.workflowSelection = { type: 'saved', id, usage }; delete st.fixedRecipe;
  if (st.components.length) st.componentArchive = [...(st.componentArchive || []), ...st.components].slice(-500);
  st.components = []; st.leaderBoard = { answers: st.leaderBoard?.answers || [], notes: '' }; st.wf = { nodes: {}, running: false };
  delete st.triage; delete st.triageInput; delete st.triagePending;
  if (usage === 'reference') { st.orchestration = 'components'; st.mode = 'leader'; st.workflowReference = w; }
  else {
    st.orchestration = 'template'; st.mode = 'auto'; delete st.workflowReference;
    if (w.kind === 'template') beginTemplateRound(p, st, w.graph);
    writeJson(p.workflow, w.kind === 'recipe' ? recipeGraph(w) : { ...w.graph, savedWorkflow: id });
    if (w.kind === 'template') st.wf.nodes = Object.fromEntries(w.graph.nodes.map(n => [n.id, { status: 'idle' }]));
    if (w.kind === 'recipe') {
      st.fixedRecipe = true;
      st.components = w.recipe.calls.map(c => ({ ...structuredClone(c), name: componentDef(c.component).name, agent: c.agent === 'leader' ? st.leader : c.agent, status: 'pending', createdAt: now(), runIds: [] }));
    }
  }
  saveState(p, st); ensureLeader(p);
  if (st.fixedRecipe) { const fresh = loadState(p); for (const c of fresh.components) c.agent ||= fresh.leader; saveState(p, fresh); }
  broadcast('workflow', {}); broadcast('state', {}); return wfSnapshot(p);
}

// ---------- 进程内调度：Asia/Shanghai，五段 cron，不补跑关闭期间的任务 ----------
const SCHEDULE_ZONE = 'Asia/Shanghai', MINUTE = 60000, DAY = 86400000, ZONE_OFFSET = 8 * 3600000;
let schedulerClock = SCHEDULER_TEST && process.env.PANEL_FAKE_NOW ? Date.parse(process.env.PANEL_FAKE_NOW) : null;
const schedulerNow = () => schedulerClock ?? Date.now();
const scheduleData = readJson(SCHEDULES_FILE, { version: 1, tasks: [], lastCheckAt: null });
if (!Array.isArray(scheduleData.tasks)) scheduleData.tasks = [];
const persistSchedules = () => writeJson(SCHEDULES_FILE, scheduleData);
const scheduleRunningCount = () => scheduleData.tasks.filter(t => t.running).length;
function cronField(text, min, max, sunday = false) {
  const values = new Set();
  for (const part of text.split(',')) {
    if (!part || !/^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/.test(part)) throw new Error(`cron 字段不合法：${text}`);
    const [base, stepText] = part.split('/'), step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1) throw new Error('cron 步长超出范围');
    let first = min, last = max;
    if (base !== '*') { const range = base.split('-').map(Number); first = range[0]; last = range.length > 1 ? range[1] : stepText ? max : first; }
    if (first < min || last > max || first > last) throw new Error(`cron 数值超出 ${min}–${max}`);
    for (let value = first; value <= last; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return { values: [...values].sort((a, b) => a - b), any: text.startsWith('*') };
}
function parseCron(expression) {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron 必须是 5 段：分 时 日 月 周');
  return fields.map((f, i) => cronField(f, [0, 0, 1, 1, 0][i], [59, 23, 31, 12, 7][i], i === 4));
}
function cronDayMatches(parsed, d) {
  if (!parsed[3].values.includes(d.getUTCMonth() + 1)) return false;
  const dom = parsed[2].values.includes(d.getUTCDate()), dow = parsed[4].values.includes(d.getUTCDay());
  return parsed[2].any ? dow : parsed[4].any ? dom : dom || dow;
}
function cronRange(expression, after, until = null) {
  const c = parseCron(expression), local = new Date(after + ZONE_OFFSET), firstDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()), limit = until === null ? firstDay + DAY * 366 * 8 : until + ZONE_OFFSET;
  let count = 0, last = null;
  for (let day = firstDay; day <= limit; day += DAY) {
    const d = new Date(day); if (!cronDayMatches(c, d)) continue;
    for (const hour of c[1].values) for (const minute of c[0].values) {
      const at = day + hour * 3600000 + minute * MINUTE - ZONE_OFFSET;
      if (at <= after || (until !== null && at > until)) continue;
      if (until === null) return at;
      count++; last = at;
    }
  }
  if (until === null) throw new Error('cron 在未来 8 年内没有运行时间');
  return { count, last };
}
function normalizeSchedule(raw, anchor = schedulerNow()) {
  if (!raw || !['daily', 'weekly', 'interval', 'cron'].includes(raw.type)) throw new Error('请选择有效的运行频率');
  if (raw.type === 'interval') { const hours = Number(raw.hours); if (!Number.isFinite(hours) || hours <= 0 || hours > 8760 || !Number.isInteger(hours * 3600000)) throw new Error('间隔小时必须大于 0，且不超过 8760'); return { type: 'interval', hours, anchorAt: new Date(Number.isFinite(Date.parse(raw.anchorAt)) ? Date.parse(raw.anchorAt) : anchor).toISOString() }; }
  if (raw.type === 'cron') { const cron = String(raw.cron || '').trim(); parseCron(cron); cronRange(cron, anchor); return { type: 'cron', cron }; }
  const time = String(raw.time || ''); if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('时间应为 HH:MM（00:00–23:59）');
  if (raw.type === 'weekly') { const weekday = Number(raw.weekday); if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('星期应为 0–6（0 是星期日）'); return { type: 'weekly', time, weekday }; }
  return { type: 'daily', time };
}
function scheduleCron(s) { const [hour, minute] = s.time.split(':').map(Number); return `${minute} ${hour} * * ${s.type === 'weekly' ? s.weekday : '*'}`; }
function nextOccurrence(s, after) {
  if (s.type !== 'interval') return cronRange(s.type === 'cron' ? s.cron : scheduleCron(s), after);
  const anchor = Date.parse(s.anchorAt), interval = s.hours * 3600000;
  return anchor + Math.max(1, Math.floor((after - anchor) / interval) + 1) * interval;
}
function dueOccurrences(s, next, until) {
  if (next > until) return { count: 0, last: null };
  if (s.type === 'interval') { const count = Math.floor((until - next) / (s.hours * 3600000)) + 1; return { count, last: next + (count - 1) * s.hours * 3600000 }; }
  return cronRange(s.type === 'cron' ? s.cron : scheduleCron(s), next - 1, until);
}
function scheduleSnapshot() { return { tasks: scheduleData.tasks, runningCount: scheduleRunningCount(), now: new Date(schedulerNow()).toISOString(), timezone: SCHEDULE_ZONE, templates: listTemplates(), savedWorkflows: listSavedWorkflows(), recent: (config.recent || []).filter(exists), projectsRoot: config.projectsRoot }; }
function getSchedule(id) { const t = scheduleData.tasks.find(t => t.id === id); if (!t) throw new Error('没有这个定时任务'); return t; }
function normalizeWorkflowChoice(raw = {}) {
  if (!raw.type || raw.type === 'components') return { type: 'components' };
  if (raw.type === 'saved') { getSavedWorkflow(raw.id); if (raw.usage && !['reference', 'fixed'].includes(raw.usage)) throw new Error('保存工作流的用法不正确'); return { type: 'saved', id: raw.id, usage: raw.usage || 'reference' }; }
  if (raw.type === 'template') { const file = path.basename(String(raw.file || '')); if (!listTemplates().some(t => t.file === file)) throw new Error('没有这个内置模板'); return { type: 'template', file }; }
  throw new Error('编排方式不正确');
}
function saveSchedule(raw) {
  const old = raw.id ? getSchedule(raw.id) : null, name = String(raw.name || '').trim(); if (!name || name.length > 120) throw new Error('任务名称不能为空，最多 120 字');
  if (!String(raw.input || '').trim()) throw new Error('需求 / 指令不能为空');
  const target = raw.target || {}; if (!['new', 'existing'].includes(target.type)) throw new Error('请选择固定项目或每次新建项目');
  if (target.type === 'existing' && (!target.project || !isDir(target.project))) throw new Error('固定项目目录不存在');
  const schedule = normalizeSchedule({ ...raw.schedule, anchorAt: old?.schedule?.type === 'interval' && Number(raw.schedule?.hours) === old.schedule.hours ? old.schedule.anchorAt : undefined });
  const t = { ...(old || { id: `schedule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, createdAt: new Date(schedulerNow()).toISOString(), lastRun: null, history: [], missedCount: 0, lastMissedAt: null, running: null }), name, enabled: raw.enabled !== false, schedule, target: target.type === 'existing' ? { type: 'existing', project: path.resolve(target.project) } : { type: 'new' }, input: String(raw.input).trim(), workflow: normalizeWorkflowChoice(raw.workflow), updatedAt: now() };
  t.nextRun = t.enabled ? new Date(nextOccurrence(schedule, schedulerNow())).toISOString() : null;
  if (old) Object.assign(old, t); else scheduleData.tasks.push(t);
  scheduleData.lastCheckAt = new Date(schedulerNow()).toISOString(); persistSchedules(); broadcast('schedule', { phase: 'updated', runningCount: scheduleRunningCount() }); return t;
}
function scheduleEvent(t, phase, item) { broadcast('schedule', { phase, name: t.name, taskId: t.id, runningCount: scheduleRunningCount(), result: item?.result, project: item?.project }); broadcast('state', {}); }
function addScheduleHistory(t, item) {
  const active = (t.history || []).find(h => h.id === t.running);
  t.history = [...(t.history || []), item].slice(-100);
  if (active && !t.history.includes(active)) t.history.unshift(active);
  t.lastRun = item; return item;
}
function initializeScheduleProject(t) {
  let dir = t.target.project;
  if (t.target.type === 'new') {
    const d = new Date(schedulerNow() + ZONE_OFFSET), pad = n => String(n).padStart(2, '0');
    const base = `${slug(t.name).replace(/^\.+|\.+$/g, '').slice(0, 80) || '定时任务'}-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
    dir = path.resolve(config.projectsRoot, base); let suffix = 2; while (exists(dir)) dir = path.resolve(config.projectsRoot, `${base}-${suffix++}`);
    const p = P(dir); fs.mkdirSync(p.panel, { recursive: true }); copyTemplate('generic', dir, t.name, false);
    const agentFile = path.join(dir, 'AGENTS.md');
    if (exists(agentFile)) writeMd(agentFile, readMd(agentFile).replace(/（BMAD 工作流）/g, '（组件化编排）').split(/\r?\n/).filter(line => !/BMAD skill|BMAD 脚本|规划文档：|测试命令：由架构文档/.test(line)).join('\n') + '\n流程按本次所选编排执行，文档和代码只放在项目内。\n');
    writeMd(p.requirement, t.input); const st = loadState(p); st.orchestration = 'components'; st.mode = 'leader'; saveState(p, st);
  }
  if (!isDir(dir)) throw new Error('目标项目目录不存在');
  const p = P(path.resolve(dir));
  if (projectHasActiveRuns(p) || (loadState(p).wf?.running && !loadState(p).leaderBoard?.finished)) throw new Error('跳过：目标项目还有未完成的工作');
  if (t.target.type === 'existing') {
    fs.mkdirSync(p.panel, { recursive: true });
    const before = requirementText(p); writeMd(p.requirement, `${before}${before ? '\n\n' : ''}## 定时任务新需求（${new Date(schedulerNow()).toISOString()}）\n${t.input}\n`);
  }
  const st = loadState(p);
  if (t.workflow.type === 'template') beginTemplateRound(p, st, readJson(path.join(WF_TEMPLATES, t.workflow.file), null));
  st.mode = 'leader'; st.leaderBoard = { ...(st.leaderBoard || {}), finished: null, error: null, fails: 0, idleTicks: 0, pending: false, ticks: 0, ask: null, answers: [...(st.leaderBoard?.answers || []), { q: '（老板留言 / 定时任务新需求）', a: t.input, at: now() }] }; st.wf = { nodes: {}, running: false }; saveState(p, st); ensureLeader(p);
  if (t.workflow.type === 'saved') applySavedWorkflow(p, t.workflow.id, t.workflow.usage);
  else {
    const fresh = loadState(p); delete fresh.fixedRecipe; delete fresh.workflowReference; delete fresh.triage; delete fresh.triageInput; delete fresh.triagePending;
    if (fresh.components.length) fresh.componentArchive = [...(fresh.componentArchive || []), ...fresh.components].slice(-500);
    fresh.components = []; fresh.workflowSelection = t.workflow;
    if (t.workflow.type === 'template') { fresh.orchestration = 'template'; fresh.mode = 'auto'; const graph = readJson(path.join(WF_TEMPLATES, t.workflow.file), null); writeJson(p.workflow, graph); fresh.wf.nodes = Object.fromEntries(graph.nodes.map(n => [n.id, { status: 'idle' }])); }
    else { fresh.orchestration = 'components'; fresh.mode = 'leader'; }
    saveState(p, fresh);
  }
  return p;
}
function runSchedule(t, trigger = 'manual', scheduledAt = null) {
  const item = { id: `history-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, startedAt: now(), endedAt: null, durationMs: null, status: 'running', result: '运行中', project: null, summary: '', scheduledAt, trigger };
  if (t.running) { Object.assign(item, { endedAt: now(), durationMs: 0, status: 'skipped', result: '跳过：上次未完成' }); addScheduleHistory(t, item); persistSchedules(); scheduleEvent(t, 'skipped', item); return item; }
  addScheduleHistory(t, item); t.running = item.id; persistSchedules();
  try {
    const p = initializeScheduleProject(t); item.project = p.root; const st = loadState(p);
    if (!st.leader) throw new Error('没有可用 Leader，请配置项目 Leader 或登录可用 agent');
    st.wf ||= { nodes: {} }; st.wf.running = true; st.wf.startedAt = now(); saveState(p, st); persistSchedules(); scheduleEvent(t, 'started', item);
    advanceWorkflow(p); autoDispatch(p); scheduleTick(p, `定时任务：${t.name}`); settleSchedules();
  } catch (e) { Object.assign(item, { endedAt: now(), durationMs: Date.now() - Date.parse(item.startedAt), status: e.message.startsWith('跳过：') ? 'skipped' : 'failed', result: e.message }); t.running = null; persistSchedules(); scheduleEvent(t, 'finished', item); }
  return item;
}
function settleSchedules() {
  let changed = false;
  for (const t of scheduleData.tasks.filter(t => t.running)) {
    const item = t.history.find(h => h.id === t.running); if (!item?.project) continue;
    const p = P(item.project), st = loadState(p), active = st.runs.some(r => ['queued', 'running'].includes(r.status));
    if (active) continue;
    let status, result;
    if (st.leaderBoard?.error) { status = 'failed'; result = st.leaderBoard.error; }
    else if (st.leaderBoard?.finished || (!st.wf?.running && st.wf?.finishedAt)) { status = 'success'; result = '完成'; }
    else if (st.fixedRecipe && st.components.some(c => c.status === 'failed')) { status = 'failed'; result = st.components.find(c => c.status === 'failed').error || '组件执行失败'; }
    else if (!isComponents(st) && !st.fixedRecipe && Object.values(st.wf?.nodes || {}).some(n => n.status === 'failed')) { status = 'failed'; result = '工作流节点执行失败'; }
    else if (!st.wf?.running) { status = 'failed'; result = '工作流已停止'; }
    else continue; // Human clarification and queued dependencies keep the task busy.
    const latestNode = Object.values(st.wf?.nodes || {}).filter(n => n.result?.summary).at(-1)?.result?.summary;
    const lastRun = [...st.runs].reverse().find(r => r.status === 'finished' && r.kind !== 'tick');
    const summary = st.leaderBoard?.finished?.summary || latestNode || (lastRun && readAgentResult(p, lastRun)?.summary) || '';
    Object.assign(item, { status, result, endedAt: now(), durationMs: Math.max(0, Date.now() - Date.parse(item.startedAt)), summary: String(summary).split(/\r?\n/).find(Boolean) || '' });
    t.running = null; t.lastRun = item; changed = true; scheduleEvent(t, 'finished', item);
  }
  if (changed) persistSchedules();
}
function schedulerCheck({ restart = false } = {}) {
  const at = schedulerNow(); settleSchedules();
  for (const t of scheduleData.tasks) {
    if (!t.enabled) continue;
    if (!t.nextRun) { t.nextRun = new Date(nextOccurrence(t.schedule, at)).toISOString(); continue; }
    const due = dueOccurrences(t.schedule, Date.parse(t.nextRun), at); if (!due.count) continue;
    t.nextRun = new Date(nextOccurrence(t.schedule, at)).toISOString();
    if (restart) { t.missedCount = (t.missedCount || 0) + due.count; t.lastMissedAt = new Date(due.last).toISOString(); }
    else runSchedule(t, 'schedule', new Date(due.last).toISOString());
  }
  scheduleData.lastCheckAt = new Date(at).toISOString();
  if (scheduleData.tasks.length || exists(SCHEDULES_FILE)) persistSchedules();
  return scheduleSnapshot();
}
function recoverScheduledRuns() {
  for (const t of scheduleData.tasks) {
    if (!t.running) continue;
    const item = t.history?.find(h => h.id === t.running);
    if (item) {
      Object.assign(item, { status: 'interrupted', result: '面板重启，运行中断', endedAt: now(), durationMs: Math.max(0, Date.now() - Date.parse(item.startedAt)) });
      if (item.project && isDir(item.project)) {
        const p = P(item.project), st = loadState(p); st.wf ||= { nodes: {} }; st.wf.running = false;
        for (const r of st.runs) if (['queued', 'running'].includes(r.status)) { r.status = 'failed'; r.error = '面板重启，运行中断'; r.endedAt = now(); }
        for (const c of st.components) if (['queued', 'running', 'pending', 'waiting'].includes(c.status)) { c.status = 'failed'; c.error = '面板重启，定时工作流中断'; c.endedAt = now(); }
        for (const n of Object.values(st.wf.nodes || {})) if (n.status === 'running') { n.status = 'failed'; n.note = '面板重启，运行中断'; }
        st.leaderBoard ||= {}; st.leaderBoard.pending = false; st.leaderBoard.error = '面板重启，定时任务未补跑'; saveState(p, st);
      }
    }
    t.running = null;
  }
  schedulerCheck({ restart: true });
}

// ---------- HTTP ----------
const body = req => new Promise((ok, bad) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } }); });
const send = (res, code, v, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(v) : v); };
const needProject = () => { if (!config.project || !exists(config.project)) throw new Error('先新建或打开一个项目'); return P(config.project); };

const routes = {
  'POST /api/devtask': input => enqueueDevtask(input),
  'GET /api/devtask': ({ id }) => publicDevtask(getDevtask(id)),
  'GET /api/devtask/reply': ({ id }) => { const f = devtaskFiles(getDevtask(id)).last; return { text: exists(f) ? readMd(f) : '' }; },
  'GET /api/devtasks': () => listDevtasks(),
  'POST /api/devtask/cancel': ({ id }) => cancelDevtask(id),
  'GET /api/workflows/saved': () => listSavedWorkflows(),
  'GET /api/workflows/templates': () => listTemplates(),
  'POST /api/workflows/saved/save': ({ name, desc, fit }) => {
    const p = needProject(), st = loadState(p);
    return storeSavedWorkflow({ name, desc, fit, kind: isComponents(st) || st.fixedRecipe ? 'recipe' : 'template', from: path.basename(p.root), ...(isComponents(st) || st.fixedRecipe ? { recipe: { calls: st.components } } : { graph: readWorkflow(p) }) }, p.root);
  },
  'POST /api/workflows/saved/import': ({ workflow }) => storeSavedWorkflow(workflow),
  'GET /api/workflows/saved/export': ({ id }) => { const w = getSavedWorkflow(id); return { ...normalizeSaved(w), createdAt: w.createdAt }; },
  'POST /api/workflows/saved/rename': ({ id, name, desc, fit }) => {
    const old = getSavedWorkflow(id), w = normalizeSaved({ ...old, name, ...(desc !== undefined ? { desc } : {}), ...(fit !== undefined ? { fit } : {}) }); w.createdAt = old.createdAt;
    writeJson(savedFile(id), w); broadcast('workflow', {}); return { ...w, id };
  },
  'POST /api/workflows/saved/delete': ({ id }) => { getSavedWorkflow(id); fs.unlinkSync(savedFile(id)); broadcast('workflow', {}); return { ok: true }; },
  'POST /api/workflows/saved/apply': ({ id, usage }) => applySavedWorkflow(needProject(), id, usage),
  'GET /api/schedules': () => { settleSchedules(); return scheduleSnapshot(); },
  'POST /api/schedules/save': a => saveSchedule(a),
  'POST /api/schedules/delete': ({ id }) => { const t = getSchedule(id); if (t.running) throw new Error('任务正在执行，请等结束后删除'); scheduleData.tasks = scheduleData.tasks.filter(t => t.id !== id); persistSchedules(); broadcast('schedule', { phase: 'updated', runningCount: scheduleRunningCount() }); return { ok: true }; },
  'POST /api/schedules/run': ({ id }) => runSchedule(getSchedule(id)),
  'POST /api/schedules/preview': ({ schedule, after }) => { const base = after === undefined ? schedulerNow() : Date.parse(after); if (!Number.isFinite(base)) throw new Error('预览起始时间不合法'); const s = normalizeSchedule(schedule, base), times = []; let at = base; for (let i = 0; i < 3; i++) { at = nextOccurrence(s, at); times.push(new Date(at).toISOString()); } return { times, timezone: SCHEDULE_ZONE }; },
  'POST /api/test/scheduler': ({ now: fakeNow, restart = false }) => { if (!SCHEDULER_TEST) throw new Error('测试时钟仅在隔离测试实例启用'); if (fakeNow !== undefined) { const at = Date.parse(fakeNow); if (!Number.isFinite(at)) throw new Error('测试时间不合法'); schedulerClock = at; } return schedulerCheck({ restart: !!restart }); },
  'POST /api/test/agents': input => setRunfixAgentFixture(input),
  'GET /api/components': () => componentCatalog(config.project ? P(config.project) : null),
  'GET /api/components/artifact': ({ path: rel }) => {
    const p = needProject(), st = loadState(p); if (!isComponents(st) && !st.fixedRecipe) throw new Error('当前不是组件编排或固定配方模式');
    const root = fs.realpathSync(p.root), f = fs.realpathSync(path.resolve(root, rel || '')), relative = path.relative(root, f);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('路径越界');
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' })[path.extname(f).toLowerCase()];
    return mime ? { mime, data: fs.readFileSync(f).toString('base64') } : { text: readMd(f) };
  },
  'POST /api/components/call': a => { const p = needProject(); addComponentCall(p, { ...a, id: a.id || `c-${Date.now()}` }); return wfSnapshot(p); },
  'POST /api/orchestration': ({ orchestration }) => {
    const p = needProject(), st = loadState(p);
    if (!['components', 'template'].includes(orchestration)) throw new Error('未知编排模式');
    if (workflowStarted(p, st) || st.triagePending) throw new Error('工作流已开始，不能切换编排模式');
    st.orchestration = orchestration; st.wf = { nodes: {}, running: false }; saveState(p, st); broadcast('state', {}); return wfSnapshot(p);
  },
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
    if (isComponents(loadState(p))) throw new Error('组件实况图由调用记录自动生成');
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('工作流格式不对');
    const ids = new Set(graph.nodes.map(n => n.id));
    if (ids.size !== graph.nodes.length) throw new Error('节点 id 重复');
    graph.edges = graph.edges.filter(e => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    writeJson(p.workflow, graph); broadcast('workflow', {}); return { ok: true };
  },
  'POST /api/workflow/template': ({ file }) => {
    const p = needProject();
    if (isComponents(loadState(p))) throw new Error('请先切回模板编排');
    if (workflowStarted(p) || loadState(p).triagePending) throw new Error('工作流已开始或正在分诊，不能更换模板');
    const t = readJson(path.join(WF_TEMPLATES, path.basename(file || '')), null);
    if (!t) throw new Error('没有这个模板');
    writeJson(p.workflow, { ...t, template: path.basename(file, '.json') });
    const st = loadState(p); st.wf = { nodes: {}, running: false }; saveState(p, st);
    broadcast('state', {}); return wfSnapshot(p);
  },
  'POST /api/triage/apply': ({ template }) => { const p = needProject(); if (loadState(p).triagePending) throw new Error('正在分诊，请稍候'); applyTriageTemplate(p, template); broadcast('state', {}); return wfSnapshot(p); },
  'POST /api/workflow/run': () => runWorkflow(needProject()),
  'POST /api/workflow/requirement-action': ({ action, name }) => {
    const p = needProject();
    if (action === 'rerun') return rerunWorkflow(p);
    if (action === 'new-project') return newProjectFromRequirement(p, name);
    throw new Error('请选择用新需求新建项目或在本项目重跑');
  },
  'POST /api/leader/tick': () => { const p = needProject(), st = loadState(p); st.leaderBoard = { ...(st.leaderBoard || {}), error: null, idleTicks: 0, fails: 0 }; saveState(p, st); scheduleTick(p, '老板手动唤醒'); return snapshot(); },
  'POST /api/leader/answer': ({ text }) => {
    const p = needProject(), st = loadState(p), L = st.leaderBoard || {};
    if (!L.ask || L.ask.answered) throw new Error('Leader 现在没有在等回答');
    if (!String(text || '').trim()) throw new Error('回答不能为空');
    L.answers = [...(L.answers || []), { q: L.ask.q, a: String(text || '').trim(), at: now() }];
    L.ask.answered = true;
    if (L.ask.guard === 'limit' && /^(继续|同意|可以|好|是|yes|ok|continue)/i.test(String(text).trim())) st.componentCallLimit = (st.componentCallLimit || 80) + 80;
    if (L.ask.callId) { const c = st.components.find(x => x.id === L.ask.callId); if (c) { c.status = 'done'; c.endedAt = now(); c.result = { summary: String(text).trim(), artifacts: [] }; } }
    st.leaderBoard = L; if (!st.requirementChanged) delete st.runNotice; saveState(p, st);
    advanceComponents(p, st.mode === 'manual'); scheduleTick(p, '老板回答了问题'); return snapshot();
  },
  'POST /api/leader/note': ({ text }) => {
    const p = needProject(), st = loadState(p), L = st.leaderBoard = st.leaderBoard || {};
    const t = String(text || '').trim(); if (!t) throw new Error('内容不能为空');
    L.answers = [...(L.answers || []), { q: '（老板主动说明）', a: t, at: now() }];
    saveState(p, st); scheduleTick(p, '老板留言'); return snapshot();
  },
  'POST /api/leader/resume': () => { const p = needProject(), st = loadState(p); st.leaderBoard = { ...(st.leaderBoard || {}), finished: null, error: null, idleTicks: 0, fails: 0 }; st.wf = st.wf || { nodes: {} }; st.wf.running = true; if (!st.requirementChanged) delete st.runNotice; saveState(p, st); scheduleTick(p, '继续'); return snapshot(); },
  'POST /api/mode': ({ mode, maxRounds, acceptLevel: lv }) => { const p = needProject(); if (lv) { const st = loadState(p); if (!ACCEPT_LEVELS[lv]) throw new Error('未知验收档位'); st.acceptLevel = lv; saveState(p, st); } if (mode || maxRounds) setMode(p, mode, maxRounds); broadcast('state', {}); return snapshot(); },
  'POST /api/workflow/stop': () => { const p = needProject(), st = loadState(p); if (st.wf) st.wf.running = false; saveState(p, st); broadcast('state', {}); return wfSnapshot(p); },
  'POST /api/node/run': ({ id, feedback }) => {
    const p = needProject();
    if (isComponents(loadState(p))) { const st = loadState(p), c = st.components.find(x => x.id === id); if (!c || c.status !== 'pending') throw new Error('重做请添加一次新的组件调用'); advanceComponents(p, true); return wfSnapshot(p); }
    const n = readWorkflow(p).nodes.find(x => x.id === id);
    if (!n) throw new Error('节点不存在');
    setNode(p, id, { status: 'idle', note: null });
    startNode(p, n, feedback || null); broadcast('state', {}); return wfSnapshot(p);
  },
  'POST /api/node/approve': async ({ id }) => {
    const p = needProject(); if (isComponents(loadState(p))) throw new Error('组件模式不使用节点审批');
    const g = readWorkflow(p), n = g.nodes.find(x => x.id === id);
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
  'POST /api/node/reset': ({ id }) => { const p = needProject(), st = loadState(p); if (isComponents(st)) throw new Error('重做请添加一次新的组件调用'); if (st.wf && st.wf.nodes) delete st.wf.nodes[id]; saveState(p, st); broadcast('state', {}); return wfSnapshot(p); },
  'GET /api/state': () => snapshot(),
  'POST /api/project/open': ({ project }) => {
    if (!project || !isDir(project)) throw new Error('目录不存在');
    const p = P(project), st = loadState(p);
    if (!exists(path.join(project, '_bmad')) && !isComponents(st) && !st.workflowSelection) return { needsSetup: true, path: path.resolve(project) };
    useProject(project); return snapshot();
  },
  'POST /api/project/create': ({ name, parent, template, requirement, mode, orchestration }) => {
    if (!name) throw new Error('项目名不能为空');
    const dir = path.join(parent || config.projectsRoot, slug(name));
    if (exists(dir) && fs.readdirSync(dir).length) throw new Error(`目录已存在且不为空：${dir}`);
    if (orchestration !== 'template') {
      const p = P(dir); fs.mkdirSync(p.panel, { recursive: true });
      copyTemplate(template === 'generic' ? 'generic' : 'embedded', dir, name, false);
      const agentFile = path.join(dir, 'AGENTS.md');
      if (exists(agentFile)) writeMd(agentFile, readMd(agentFile).replace(/（BMAD 工作流）/g, '（组件化编排）').replace(/，BMAD 工作流/g, '，组件化编排').split(/\r?\n/).filter(line => !/BMAD skill|BMAD 脚本|规划文档：|测试命令：由架构文档/.test(line)).join('\n') + '\n\n流程由 Leader 按需求选择组件，不要求先写 PRD、架构或 Story。按实际项目选择测试工具，文档和代码放在项目目录内。\n');
      const st = loadState(p); st.orchestration = 'components'; st.mode = ['leader', 'auto'].includes(mode) ? mode : 'manual'; st.wf = { nodes: {}, running: automatic(st) }; saveState(p, st);
      if (String(requirement || '').trim()) writeMd(p.requirement, String(requirement));
      useProject(dir); ensureLeader(p); scheduleTick(p, '新项目开始'); broadcast('state', {});
      return { dir, path: dir, status: 'done', orchestration: 'components' };
    }
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
    if (agent !== undefined && !st.requirementChanged) delete st.runNotice;
    if (agent !== undefined) {
      if (agent && !loadAgents().some(a => a.id === agent)) throw new Error('没有这个 Leader');
      const changed = st.leader !== (agent || null); st.leader = agent || null;
      if (changed && st.leaderBoard?.authBlockedAgent) {
        if (st.leaderBoard.error === st.leaderBoard.authBlockedError) { st.leaderBoard.error = null; st.leaderBoard.pending = false; st.leaderBoard.fails = 0; }
        delete st.leaderBoard.authBlockedAgent; delete st.leaderBoard.authBlockedError;
      }
    }
    if (Array.isArray(skills)) st.leaderSkills = skills; saveState(p, st);
    if (st.leader && st.wf?.running && automatic(st)) { resumeAutomaticNodes(p); advanceWorkflow(p); autoDispatch(p); scheduleTick(p, '已选择 Leader'); }
    broadcast('state', {}); return snapshot();
  },
  'POST /api/requirement': ({ text }) => {
    const p = needProject(), before = loadState(p), previous = requirementText(p);
    const started = !!before.wf?.requirementHash || workflowStarted(p, before);
    if (started) { rememberWorkflowRequirement(p, before); saveState(p, before); }
    fs.mkdirSync(p.panel, { recursive: true }); writeMd(p.requirement, String(text || ''));
    const st = loadState(p);
    if (!started && !workflowStarted(p, st)) {
      st.wf = st.wf || { nodes: {} }; st.wf.nodes ||= {};
      for (const n of readWorkflow(p).nodes.filter(n => n.type === 'start')) delete st.wf.nodes[n.id];
      if (automatic(st)) st.wf.running = true;
      saveState(p, st); requestTriage(p); advanceWorkflow(p);
    }
    if (previous !== requirementText(p) && !st.requirementChanged) scheduleTick(p, '需求已更新');
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
    const devtask = devtaskData.runs.find(r => r.id === id);
    if (devtask) {
      const f = devtaskFiles(devtask), log = exists(f.log) ? fs.readFileSync(f.log, 'utf8') : '';
      return { log, logBytes: Buffer.byteLength(log, 'utf8'), task: readMd(f.task), result: devtaskMessage(devtask) || null, run: publicDevtask(devtask) };
    }
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

if (!RUNFIX_TEST) ensureAuthData();

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
  recoverDevtasks();
  recoverScheduledRuns();
  const schedulerTimer = setInterval(() => { try { schedulerCheck(); } catch (e) { console.error('scheduler:', e.message); } }, 30000); schedulerTimer.unref();
  const settleTimer = setInterval(() => { try { settleSchedules(); } catch (e) { console.error('schedule completion:', e.message); } }, 1000); settleTimer.unref();
  if (config.project && exists(config.project)) {
    const p = P(config.project), st = loadState(p);
    let dirty = false;
    for (const r of st.runs) if (['queued', 'running'].includes(r.status)) { r.status = 'failed'; r.error = '面板重启，运行中断'; r.endedAt = now(); dirty = true; }
    for (const c of st.components) if (['queued', 'running'].includes(c.status)) { c.status = 'failed'; c.error = '面板重启，运行中断；重做请调用新组件'; c.endedAt = now(); dirty = true; }
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
