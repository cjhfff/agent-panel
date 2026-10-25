// Agent 统筹面板 v2：零依赖 Node 服务。
// - BMAD 的 sprint-status.yaml 是 Story 状态的唯一来源
// - 面板数据（leader、分配、阶段、运行记录）存在 <项目>/_bmad-output/panel/state.json
// - 每次运行的文件在 <项目>/_bmad-output/panel/runs/<runId>/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, 'panel.config.json');
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
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const now = () => new Date().toISOString();
const bmadDate = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const exists = f => { try { fs.accessSync(f); return true; } catch { return false; } };
const isDir = f => { try { return fs.statSync(f).isDirectory(); } catch { return false; } };
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const slug = s => String(s).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

let config = Object.assign({ project: null, recent: [], projectsRoot: path.join(HERE, 'projects'), maxParallel: 1 }, readJson(CONFIG_FILE, {}));
const saveConfig = () => writeJson(CONFIG_FILE, config);
function useProject(dir) {
  config.project = path.resolve(dir);
  config.recent = [config.project, ...config.recent.filter(p => p !== config.project && exists(p))].slice(0, 12);
  saveConfig();
}

// ---------- agent 配置 ----------
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
function homeModel(a) {
  if (!a.homeConfig) return null;
  const f = path.join(HERE, a.homeConfig);
  if (!exists(f)) return null;
  const m = fs.readFileSync(f, 'utf8').match(/^model\s*=\s*"([^"]*)"/m);
  return m ? m[1] : null;
}
function loadAgents() {
  return (readAgentsFile().agents || []).map(a => {
    const resolved = resolveCmd(a.cmd);
    return { ...a, resolved, installed: !!resolved, available: !!resolved && a.enabled !== false, effectiveModel: a.homeConfig ? homeModel(a) : (a.model || '') };
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
function homeRelay(a) {
  if (!a.homeConfig) return null;
  const f = path.join(HERE, a.homeConfig);
  if (!exists(f)) return null;
  const t = fs.readFileSync(f, 'utf8');
  return { baseUrl: (t.match(/^base_url\s*=\s*"([^"]+)"/m) || [])[1], envKey: (t.match(/^env_key\s*=\s*"([^"]+)"/m) || [])[1] };
}
function buildInvocation(a, prompt, cwd) {
  const perm = (a.perm || {})[a.permission || 'max'] || {};
  const args = [];
  for (const x of a.args) {
    if (x === '{perm}') args.push(...(perm.args || []));
    else args.push(x.replace('{prompt}', prompt).replace('{cwd}', cwd).replace('{here}', HERE));
  }
  if (a.modelFlag && a.model) args.push(a.modelFlag, a.model);
  const sub = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, String(v).replace('{here}', HERE)]));
  const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...sub(a.env), ...sub(perm.env), ...readEnvFile(a.envFile) };
  return { exe: a.resolved, args, env, stream: a.stream || null };
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
const RESULT_NAME = { plan: 'plan.json', review: 'review.json', implement: 'result.json', stage: 'stage.json', node: 'node.json', nodereview: 'review.json', tick: 'tick.json', task: 'result.json', test: 'result.json', setup: 'result.json' };
const runDir = (p, id) => path.join(p.runs, id);
const runFiles = (p, r) => { const d = runDir(p, r.id); return { dir: d, task: path.join(d, 'task.md'), log: path.join(d, 'run.log'), result: path.join(d, RESULT_NAME[r.kind] || 'result.json') }; };

// ---------- BMAD 文档解析 ----------
function parseEpics(file) {
  if (!exists(file)) return { epics: [], stories: [] };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
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
  out.requirement = { text: exists(p.requirement) ? fs.readFileSync(p.requirement, 'utf8') : '' };
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
const readPlan = p => normalizePlan(p, readJson(p.plan, null));

// ---------- 面板状态 ----------
const loadState = p => {
  const s = readJson(p.state, {});
  return { leader: null, assignments: {}, feedback: {}, runs: [], stages: {}, ...s };
};
const saveState = (p, s) => writeJson(p.state, s);
const skillsBase = p => exists(path.join(p.root, '.claude', 'skills')) ? '.claude/skills' : '.agents/skills';

function snapshot() {
  const agents = loadAgents().map(({ resolved, ...a }) => ({ id: a.id, name: a.name, available: a.available, installed: a.installed, enabled: a.enabled !== false, strengths: a.strengths, permission: a.permission, effectiveModel: a.effectiveModel, relay: a.relay }));
  if (!config.project || !exists(config.project)) return { project: null, recent: config.recent.filter(exists), projectsRoot: config.projectsRoot, agents, maxParallel: config.maxParallel };
  const p = P(config.project), parsed = parseEpics(p.epics), sprint = readSprint(p.sprint), st = loadState(p);
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
    agents, epics: parsed.epics, stories, leader: st.leader, leaderSkills: st.leaderSkills || [], acceptance: st.acceptance || {}, mode: st.mode || 'manual', maxRounds: st.maxRounds || 2, acceptLevel: acceptLevel(st), leaderBoard: (() => { const L = st.leaderBoard || {}; return { notes: L.notes || '', progress: L.progress || null, ask: L.ask || null, finished: L.finished || null, error: L.error || null, ticks: L.ticks || 0, lastTickAt: L.lastTickAt || null, log: (L.log || []).slice(-30).reverse(), answers: L.answers || [] }; })(), autoRounds: st.autoRounds || {}, plan: readPlan(p), stages: stageInfo(p, st),
    runs: st.runs.slice(-80).reverse().map(r => ({ ...r, lastLine: live.get(r.id) || r.lastLine, lastOutputAt: lastOut.get(r.id) || null })), docs,
  };
}

// ---------- 任务文件（命令行只传一句短指令） ----------
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
  const res = run && readJson(runFiles(p, run).result, null);
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
  p.buf += stripAnsi(text).replace(/\r/g, '');
  const lines = p.buf.split('\n'); p.buf = lines.pop();
  for (const raw of lines) {
    const t = raw.trim();
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
    const done = p.buf.split(/(?<=[。！？!?])/); done.pop();
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
  const tools = new Map();
  return chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n'); buf = lines.pop();
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
}
function launch({ exe, args, env, stream }, cwd, logFile, onChunk, onExit, label) {
  let child;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    child = spawn('cmd.exe', ['/d', '/s', '/c', `"${[exe, ...args].map(quoteWin).join(' ')}"`], { cwd, env, windowsVerbatimArguments: true, windowsHide: true });
  } else {
    child = spawn(exe, args, { cwd, env, windowsHide: true });
  }
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  out.write(`$ ${label}: ${[path.basename(exe), ...args].join(' ')}\n\n`);
  const pipe = chunk => { out.write(chunk); onChunk && onChunk(chunk.toString()); };
  const tr = stream === 'grok-ndjson' ? grokTranslator() : null;
  child.stdout.on('data', tr ? chunk => { const t = tr(chunk); if (t) pipe(Buffer.from(t)); } : pipe);
  child.stderr.on('data', pipe);
  child.stdin.end();
  child.on('error', e => { out.write(`\n[spawn error] ${e.message}\n`); });
  child.on('close', code => { out.end(`\n[exit ${code}]\n`); onExit(code); });
  return child;
}
function newRunId(kind, who) { return `${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${kind}-${who}`; }
function updateRun(p, id, patch) { const st = loadState(p); const r = st.runs.find(x => x.id === id); if (r) Object.assign(r, patch); saveState(p, st); return r; }

function enqueue({ kind, storyKey = null, stage = null, nodeId = null, agentId, feedback = null, title = null, instructions = null, skills = null, relatedStory = null }) {
  const p = P(config.project), st = loadState(p), snap = snapshot();
  const agent = loadAgents().find(a => a.id === agentId);
  if (!agent) throw new Error(`没有这个 agent：${agentId}`);
  if (!agent.installed) throw new Error(`${agent.name} 未安装（找不到 ${agent.cmd}）`);
  if (agent.enabled === false) throw new Error(`${agent.name} 已在设置里停用`);
  const dup = st.runs.find(r => ['queued', 'running'].includes(r.status) && ((storyKey && r.storyKey === storyKey) || (stage && r.stage === stage) || (nodeId && r.nodeId === nodeId && r.kind === kind) || (kind === 'plan' && r.kind === 'plan') || (kind === 'tick' && r.kind === 'tick')));
  if (dup) throw new Error('这一项已经在跑或在排队');
  const story = storyKey ? snap.stories.find(s => s.key === storyKey) : null;
  if (storyKey && !story) throw new Error(`找不到 Story ${storyKey}`);
  const run = { id: newRunId(kind === 'stage' ? stage : kind === 'node' ? 'node' : kind, agentId), kind, storyKey, stage, nodeId, title, relatedStory, agent: agentId, status: 'queued', createdAt: now() };
  const f = runFiles(p, run); fs.mkdirSync(f.dir, { recursive: true });
  const lastImpl = storyKey && [...st.runs].reverse().find(r => r.storyKey === storyKey && r.kind === 'implement');
  const task = kind === 'plan' ? leaderPlanTask(p, snap, f.result)
    : kind === 'review' ? leaderReviewTask(p, story, lastImpl, f.result)
      : kind === 'stage' ? stageTask(p, stage, st, f.result, feedback)
        : kind === 'node' ? nodeTask(p, nodeId, st, f.result, feedback)
          : kind === 'nodereview' ? nodeReviewTask(p, nodeId, st, f.result)
            : kind === 'tick' ? leaderBrief(p, f.result)
              : kind === 'task' ? taskTask(p, title, instructions, skills, f.result, relatedStory)
        : memberTask(p, story, f.result);
  fs.writeFileSync(f.task, task);
  st.runs.push(run);
  if (kind === 'node') { st.wf = st.wf || { nodes: {} }; st.wf.nodes[nodeId] = { ...(st.wf.nodes[nodeId] || {}), status: 'running', runId: run.id, agent: agentId, feedback: feedback || null }; }
  if (kind === 'stage') st.stages[stage] = { ...(st.stages[stage] || {}), status: 'running', agent: agentId, runId: run.id, feedback: feedback || null };
  saveState(p, st);
  queue.push({ runId: run.id, project: p.root }); broadcast('state', {}); pump();
  return run;
}

function pump() {
  for (;;) {
    const busy = [...running.keys()].filter(id => !String(id).includes('-tick-')).length;
    const idx = queue.findIndex(q => String(q.runId).includes('-tick-') || busy < (config.maxParallel || 1));
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
    const onChunk = text => {
      feedStatus(runId, text);
      lastOut.set(runId, now());
      broadcast('log', { runId, text, lastLine: live.get(runId), lastOutputAt: lastOut.get(runId) });
    };
    const onExit = code => {
      running.delete(runId);
      const result = readJson(f.result, null);
      const cur = loadState(p).runs.find(r => r.id === runId) || {};
      const patch = { status: code === 0 && result ? 'finished' : 'failed', exitCode: code, endedAt: now(), hasResult: !!result, lastLine: live.get(runId) };
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
        s2.wf.nodes[run.nodeId] = { ...(s2.wf.nodes[run.nodeId] || {}), status: !ok ? 'failed' : (node.config || {}).approval ? (isAuto(s2) && s2.leader ? 'running' : 'waiting') : 'done', note: ok && (node.config || {}).approval && isAuto(s2) ? 'Leader 自动评审中' : null, result: result || null, finishedAt: now() };
        if (ok && (node.config || {}).approval && isAuto(s2) && s2.leader) needReview = true;
        saveState(p, s2);
      }
      if (patch.status === 'failed' && !result) patch.error = code === 0 ? 'agent 结束但没写结果文件' : `退出码 ${code}`;
      if (cur.cancelRequested) { patch.status = 'cancelled'; patch.error = '已手动取消'; }
      updateRun(p, runId, patch);
      live.delete(runId); parsers.delete(runId); lastOut.delete(runId);
      if (needReview) { try { enqueue({ kind: 'nodereview', nodeId: run.nodeId, agentId: loadState(p).leader }); } catch (e) { setNode(p, run.nodeId, { status: 'waiting', note: e.message }); } }
      try { autoAfterRun(p, run, cur.cancelRequested ? null : result); } catch (e) { console.error('auto:', e.message); }
      try { if (isLeaderMode(loadState(p))) { if (run.kind === 'tick') applyTick(p, run, cur.cancelRequested ? null : result); else scheduleTick(p, `${KIND_CN[run.kind] || run.kind}完成`); } } catch (e) { console.error('leader:', e.message); }
      try { advanceWorkflow(p); autoDispatch(p); } catch (e) { console.error('workflow:', e.message); }
      broadcast('state', {}); pump();
    };
    running.set(runId, launch(buildInvocation(agent, prompt, p.root), p.root, f.log, onChunk, onExit, agent.name));
    broadcast('state', {});
  }
}
function killTree(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
  else child.kill('SIGTERM');
}
function cancel(runId) {
  const p = P(config.project);
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
    let txt = fs.readFileSync(f, 'utf8').replace(/\{\{PROJECT_NAME\}\}/g, projectName);
    fs.writeFileSync(dst, txt);
  }
}
function setupProject(dir, template, isNew) {
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
      } catch (e) { job.status = 'failed'; job.error = e.message; }
    }
    broadcast('setup', { dir, status: job.status, error: job.error }); broadcast('state', {});
  };
  launch({ exe: npx, args, env: { ...process.env, NO_COLOR: '1' } }, dir, logFile, null,
    code => finish(code === 0 && exists(path.join(dir, '_bmad')), code === 0 ? null : `安装失败，退出码 ${code}`), 'BMAD 安装');
  return job;
}

// ---------- agent 设置 / 测试 ----------
function saveAgent(id, patch) {
  const file = readAgentsFile(), a = file.agents.find(x => x.id === id);
  if (!a) throw new Error('没有这个 agent');
  for (const k of ['enabled', 'strengths', 'permission', 'cmd']) if (k in patch) a[k] = patch[k];
  if ('model' in patch) {
    if (a.homeConfig) {
      const f = path.join(HERE, a.homeConfig);
      const t = fs.readFileSync(f, 'utf8');
      if (!/^model\s*=/m.test(t)) throw new Error('配置文件里没有 model 行');
      fs.writeFileSync(f, t.replace(/^model\s*=\s*"[^"]*"/m, `model = "${String(patch.model).replace(/"/g, '')}"`));
    } else if (a.modelFlag) a.model = patch.model;
    else throw new Error('这个 agent 不能在面板里改模型');
  }
  writeJson(AGENTS_FILE, file);
}
function setSecret(id, value) {
  const a = loadAgents().find(x => x.id === id);
  const relay = a && homeRelay(a);
  if (!relay || !relay.envKey) throw new Error('这个 agent 不走中转站 key');
  const lines = exists(SECRETS_FILE) ? fs.readFileSync(SECRETS_FILE, 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith(relay.envKey + '=')) : [];
  lines.push(`${relay.envKey}=${String(value).trim()}`);
  fs.writeFileSync(SECRETS_FILE, lines.join('\n') + '\n');
}
function agentDetail(a) {
  const relay = homeRelay(a), secrets = readEnvFile(a.envFile);
  const key = relay && relay.envKey ? secrets[relay.envKey] : null;
  return {
    id: a.id, name: a.name, cmd: a.cmd, path: a.resolved, installed: a.installed, enabled: a.enabled !== false, strengths: a.strengths,
    permission: a.permission || 'max', permOptions: Object.keys(a.perm || {}), canModel: !!(a.homeConfig || a.modelFlag), model: a.effectiveModel, modelNote: a.modelNote,
    relay: a.relay, baseUrl: relay && relay.baseUrl, keyName: relay && relay.envKey, keyMasked: key ? `${key.slice(0, 5)}…${key.slice(-4)}` : null,
  };
}
const tests = new Map(); // agentId -> {status, ms, output}
function testAgent(id) {
  const a = loadAgents().find(x => x.id === id);
  if (!a || !a.installed) throw new Error('agent 未安装');
  if (tests.get(id)?.status === 'running') return tests.get(id);
  const t = { status: 'running', startedAt: Date.now(), output: '' };
  tests.set(id, t); broadcast('agenttest', { id, ...t });
  const cwd = path.join(HERE, 'logs'); fs.mkdirSync(cwd, { recursive: true });
  const logFile = path.join(cwd, `test-${id}.log`); try { fs.unlinkSync(logFile); } catch {}
  const child = launch(buildInvocation(a, 'Reply with exactly one word: OK', cwd), cwd, logFile, txt => { t.output += stripAnsi(txt); },
    code => { clearTimeout(timer); t.ms = Date.now() - t.startedAt; t.code = code; t.status = code === 0 && /\bOK\b/i.test(t.output) ? 'ok' : (t.status === 'timeout' ? 'timeout' : 'failed'); t.output = t.output.slice(-1500); broadcast('agenttest', { id, ...t }); }, a.name);
  const timer = setTimeout(() => { t.status = 'timeout'; killTree(child); }, 180000);
  return t;
}
function fetchModels(id) {
  const a = loadAgents().find(x => x.id === id), relay = a && homeRelay(a);
  if (!relay || !relay.baseUrl) throw new Error('这个 agent 没有中转站配置');
  const key = readEnvFile(a.envFile)[relay.envKey];
  return fetch(relay.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${key}` } })
    .then(r => r.json()).then(j => (j.data || []).map(m => m.id));
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
  const t = fs.readFileSync(file, 'utf8');
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
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${n}\ndescription: ${String(description || '').replace(/\r?\n/g, ' ')}\n---\n\n${body || ''}\n`);
  skillCache.at = 0;
  return `panel:${n}`;
}

// ---------- 工作流（Dify 式画布） ----------
const WF_TEMPLATES = path.join(HERE, 'workflows');
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
  const reqFilled = exists(p.requirement) && fs.readFileSync(p.requirement, 'utf8').trim();
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
  if (n.type === 'start') {
    if (!(exists(p.requirement) && fs.readFileSync(p.requirement, 'utf8').trim())) return setNode(p, n.id, { status: 'waiting', note: '先在这个节点里填写需求' });
    return setNode(p, n.id, { status: 'done', finishedAt: now(), note: null });
  }
  if (n.type === 'end') return setNode(p, n.id, { status: 'done', finishedAt: now() });
  if (n.type === 'human') return setNode(p, n.id, isAuto(st) ? { status: 'done', note: '自动模式：已跳过人工确认', finishedAt: now() } : { status: 'waiting' });
  if (n.type === 'dev') {
    setNode(p, n.id, { status: 'running', startedAt: now() });
    if (c.autoPlan !== false && !isLeaderMode(st) && !exists(p.plan) && st.leader && exists(p.epics)) { try { enqueue({ kind: 'plan', agentId: st.leader }); } catch {} }
    setTimeout(() => { try { autoDispatch(p); } catch (e) { console.error(e.message); } }, 0);
    return;
  }
  if (n.type === 'agent') {
    const who = isLeaderRef(c.agent) ? st.leader : c.agent;
    if (!who) return setNode(p, n.id, { status: 'failed', note: '没有选 agent，也没有设 leader' });
    try { enqueue({ kind: 'node', nodeId: n.id, agentId: who, feedback }); }
    catch (e) { setNode(p, n.id, { status: 'failed', note: e.message }); }
  }
}
function advanceWorkflow(p) {
  for (let round = 0; round < 30; round++) {
    const st = loadState(p);
    if (!st.wf || !st.wf.running) return;
    const g = readWorkflow(p), ns = nodeStates(p, st, g);
    if (g.nodes.length && g.nodes.every(n => ns[n.id].status === 'done')) { st.wf.running = false; st.wf.finishedAt = now(); saveState(p, st); broadcast('state', {}); return; }
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
${c.outputDoc ? `\n产出文档写到：${c.outputDoc}\n` : ''}
## 输出（必须）
把下面格式的 JSON 写入 ${resultPath}（UTF-8，不要 Markdown 包裹）：
{"doc":"产出文档相对路径（没有就留空）","summary":"三句话以内","open_questions":["..."]}
`;
}
function wfSnapshot(p) {
  const st = loadState(p), g = readWorkflow(p);
  return { graph: g, states: nodeStates(p, st, g), running: !!(st.wf && st.wf.running), templates: listTemplates(), requirement: exists(p.requirement) ? fs.readFileSync(p.requirement, 'utf8') : '' };
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
  if (!plan) { if (!st.runs.some(r => r.kind === 'plan' && ['queued', 'running'].includes(r.status))) { try { enqueue({ kind: 'plan', agentId: st.leader }); } catch (e) { console.error(e.message); } } return; }
  const snap = snapshot(), active = new Set(st.runs.filter(r => ['queued', 'running'].includes(r.status)).map(r => r.storyKey));
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
      try { enqueue({ kind: 'implement', storyKey: s.key, agentId: agent }); active.add(s.key); } catch (e) { console.error(e.message); }
    } else if (s.status === 'review') {
      const lastImpl = [...st.runs].reverse().find(r => r.storyKey === s.key && r.kind === 'implement');
      const lastRev = [...st.runs].reverse().find(r => r.storyKey === s.key && r.kind === 'review');
      if (!lastRev || (lastImpl && lastRev.createdAt < lastImpl.createdAt)) { try { enqueue({ kind: 'review', storyKey: s.key, agentId: st.leader }); active.add(s.key); } catch (e) { console.error(e.message); } }
    }
  }
}
function setMode(p, mode, rounds) {
  const st = loadState(p);
  if (mode) st.mode = ['auto', 'leader'].includes(mode) ? mode : 'manual';
  if (st.mode === 'leader') { st.wf = st.wf || { nodes: {} }; st.wf.running = true; st.leaderBoard = { ...(st.leaderBoard || {}), error: null, idleTicks: 0, finished: null }; }
  if (rounds) st.maxRounds = Math.max(1, Math.min(5, +rounds));
  saveState(p, st);
  if (isLeaderMode(st)) { advanceWorkflow(p); scheduleTick(p, '切换到 Leader 统筹'); return; }
  if (isAuto(st)) {
    // 切到自动：正在等确认的节点交给 Leader 评审，人工确认节点直接放行
    const g = readWorkflow(p), ns = nodeStates(p, st, g);
    for (const n of g.nodes) {
      if (ns[n.id].status !== 'waiting') continue;
      if (n.type === 'human') setNode(p, n.id, { status: 'done', note: '自动模式：已跳过人工确认', finishedAt: now() });
      if (n.type === 'agent' && st.leader) { try { enqueue({ kind: 'nodereview', nodeId: n.id, agentId: st.leader }); } catch (e) { console.error(e.message); } }
    }
    advanceWorkflow(p); autoDispatch(p);
  }
}

// ---------- Leader 统筹模式 ----------
// 参考 Magentic-One 的 Orchestrator：Task Ledger（全局笔记：事实、计划、风险）+ Progress Ledger（每轮判断是否完成、
// 是否在兜圈子、下一步谁做什么）；以及 LangGraph supervisor：成员做完都回到 Leader，由 Leader 决定下一步。
const isLeaderMode = st => st.mode === 'leader';
const KIND_CN = { plan: '分配', implement: '执行 Story', review: '评审', node: '规划节点', nodereview: '节点评审', task: '临时任务', stage: '阶段', tick: 'Leader 唤醒' };
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const resultOf = (p, r) => r ? readJson(runFiles(p, r).result, null) : null;
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
  out.push('project:bmad-build', 'panel:verification-before-completion');
  return [...new Set(out)].filter(id => have.has(id));
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
  const st = loadState(p), snap = snapshot(), g = readWorkflow(p), ns = nodeStates(p, st, g), L = st.leaderBoard || {};
  const since = L.lastTickAt || '1970';
  const req = exists(p.requirement) ? fs.readFileSync(p.requirement, 'utf8') : '';
  const nodes = g.nodes.map(n => { const s = ns[n.id]; return `- ${n.id}｜${n.title}｜${n.type}${n.config && n.config.preset ? '/' + n.config.preset : ''}｜${s.status}${s.doc ? '｜文档 ' + s.doc : ''}${s.result && s.result.open_questions && s.result.open_questions.length ? `｜执行者列了 ${s.result.open_questions.length} 个开放问题` : ''}`; }).join('\n');
  const stories = snap.stories.map(s => {
    const impl = [...st.runs].reverse().find(r => r.storyKey === s.key && r.kind === 'implement'), res = resultOf(p, impl);
    const a = snap.plan && (snap.plan.assignments || []).find(x => x.key === s.key);
    const tries = st.runs.filter(r => r.storyKey === s.key && r.kind === 'implement' && ['finished', 'failed'].includes(r.status)).length;
    const cc = s.status === 'review' ? crossCheckDone(p, st, s.key) : null;
    return `- ${s.key}｜${s.title}｜${s.status}｜负责人 ${s.agent || '未分配'}｜${isUiStory(s) ? '界面类' : '非界面'}｜推荐技能 ${recommendSkills(p, s).join(',')}${cc ? '｜交叉验收：' + (cc.ok ? '已完成（' + cc.qa.agent + '）' : '未完成') : ''}｜已执行 ${tries} 次${a && a.depends_on && a.depends_on.length ? '｜建议依赖 ' + a.depends_on.map(k => k.split('-').slice(0, 2).join('.')).join(',') : ''}${impl ? `｜最近执行 ${impl.status}` : ''}${res ? `｜结果：${clip(res.summary, 160)}；测试${res.tests ? (res.tests.passed ? '通过' : '未通过') : '未报'}` : ''}${s.feedback ? '｜打回意见：' + clip(s.feedback, 160) : ''}`;
  }).join('\n');
  const active = st.runs.filter(r => r.kind !== 'tick' && ['queued', 'running'].includes(r.status));
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
6. 规划按顺序推进：需求 → PRD → 架构 → 拆分；拆分通过后才有 Story。规划节点的开放问题由你拍板，把决定写进 approve_node 前的笔记里。
7. 没有可做的事、只需等正在运行的任务时，actions 给空数组即可。
8. 不要派需要打开浏览器窗口、操作桌面、读写系统剪贴板、安装软件的任务。界面实测一律用 ui-check 无头工具（这是允许的，不冲突），能自动测的都要测。实在测不了的（真实系统剪贴板、和真 Excel 往返、下载对话框）才留给客户，最多 3 条，写在 finish 的 summary 里。
9. 派活时 skills 从该 Story 的“推荐技能”里挑，界面类 Story 必须带 panel:headless-ui-check 让实现者自测。
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
  const L = st.leaderBoard = st.leaderBoard || {};
  if (L.finished || (L.ask && !L.ask.answered) || L.error) return;
  if (st.runs.some(r => r.kind === 'tick' && ['queued', 'running'].includes(r.status))) { L.pending = true; saveState(p, st); return; }
  if ((L.ticks || 0) >= 300) { L.error = 'Leader 唤醒次数达到上限 300，已暂停'; saveState(p, st); return; }
  saveState(p, st);
  try { enqueue({ kind: 'tick', agentId: st.leader, title: why || '' }); } catch (e) { console.error('tick:', e.message); }
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
  saveState(p, st);
  const log = { at: now(), run: run.id, progress: result.progress || null, actions: [] };
  for (const a0 of Array.isArray(result.actions) ? result.actions : []) {
    const a = { ...a0 }; let outcome = 'ok';
    try {
      if (a.story) a.story = fullStoryKey(p, a.story);
      if (a.type === 'dispatch') {
        if (a.story && !a.title) {
          if (readSprint(p.sprint)[a.story] === 'done') throw new Error('Story 已完成');
          const s2 = loadState(p);
          s2.assignments[a.story] = a.agent;
          s2.leaderInstr = s2.leaderInstr || {}; s2.leaderInstr[a.story] = { instructions: a.instructions || '', skills: a.skills || [], writes: a.writes || [] };
          saveState(p, s2);
          enqueue({ kind: 'implement', storyKey: a.story, agentId: a.agent });
        } else enqueue({ kind: 'task', agentId: a.agent, title: a.title || '临时任务', instructions: a.instructions || '', skills: a.skills || [], relatedStory: a.story || null });
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
      else if (a.type === 'finish') { const s2 = loadState(p); s2.leaderBoard.finished = { at: now(), summary: a.summary || '' }; if (s2.wf) s2.wf.running = false; saveState(p, s2); }
      else outcome = '未知动作';
    } catch (e) { outcome = '失败：' + e.message; }
    log.actions.push({ ...a, outcome });
  }
  const s3 = loadState(p), L3 = s3.leaderBoard;
  L3.log = [...(L3.log || []), log].slice(-80);
  const activeNow = s3.runs.some(r => r.kind !== 'tick' && ['queued', 'running'].includes(r.status));
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
  const brief = (r) => { const res = readJson(runFiles(p, r).result, null); return res; };
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
  'GET /api/skills/content': ({ id }) => { const sk = scanSkills(config.project).find(s => s.id === id); if (!sk) throw new Error('找不到这个技能'); return { ...sk, content: fs.readFileSync(path.join(sk.dir, 'SKILL.md'), 'utf8'), files: [...walk(sk.dir)].map(f => path.relative(sk.dir, f).replace(/\\/g, '/')).slice(0, 50) }; },
  'POST /api/skills/install': ({ id }) => { const sk = installSkill(needProject(), id); return { ok: true, folder: sk.installedFolder }; },
  'POST /api/skills/import': ({ id }) => { importSkill(config.project, id); return { ok: true }; },
  'POST /api/skills/create': b => ({ id: createSkill(b) }),
  'POST /api/skills/save': ({ id, content }) => {
    const sk = scanSkills(config.project).find(s => s.id === id);
    if (!sk || sk.source !== 'panel') throw new Error('只有面板技能库里的技能能在这里编辑');
    fs.writeFileSync(path.join(sk.dir, 'SKILL.md'), content); skillCache.at = 0; return { ok: true };
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
    const p = needProject(), t = readJson(path.join(WF_TEMPLATES, path.basename(file || '')), null);
    if (!t) throw new Error('没有这个模板');
    writeJson(p.workflow, { name: t.name, nodes: t.nodes, edges: t.edges });
    const st = loadState(p); st.wf = { nodes: {}, running: false }; saveState(p, st);
    broadcast('state', {}); return wfSnapshot(p);
  },
  'POST /api/workflow/run': () => { const p = needProject(), st = loadState(p); st.wf = st.wf || { nodes: {} }; st.wf.running = true; st.wf.startedAt = now(); saveState(p, st); advanceWorkflow(p); autoDispatch(p); broadcast('state', {}); return wfSnapshot(p); },
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
  'POST /api/project/create': ({ name, parent, template }) => {
    if (!name) throw new Error('项目名不能为空');
    const dir = path.join(parent || config.projectsRoot, slug(name));
    if (exists(dir) && fs.readdirSync(dir).length) throw new Error(`目录已存在且不为空：${dir}`);
    return setupProject(dir, template === 'generic' ? 'generic' : 'embedded', true);
  },
  'POST /api/project/setup': ({ path: dir, template }) => { if (!isDir(dir)) throw new Error('目录不存在'); return setupProject(path.resolve(dir), template === 'generic' ? 'generic' : 'embedded', false); },
  'GET /api/setup': ({ dir }) => { const j = setupJobs.get(dir); if (!j) return { status: 'none' }; return { ...j, log: exists(j.logFile) ? stripAnsi(fs.readFileSync(j.logFile, 'utf8')).slice(-4000) : '' }; },
  'GET /api/fs': ({ path: dir }) => listDirs(dir),
  'POST /api/settings': ({ maxParallel, projectsRoot }) => {
    if (maxParallel) config.maxParallel = Math.max(1, Math.min(5, +maxParallel));
    if (projectsRoot) config.projectsRoot = projectsRoot;
    saveConfig(); pump(); return snapshot();
  },
  'POST /api/leader': ({ agent, skills }) => { const p = needProject(), st = loadState(p); if (agent !== undefined) st.leader = agent || null; if (Array.isArray(skills)) st.leaderSkills = skills; saveState(p, st); return snapshot(); },
  'POST /api/requirement': ({ text }) => { const p = needProject(); fs.mkdirSync(p.panel, { recursive: true }); fs.writeFileSync(p.requirement, text || ''); return snapshot(); },
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
  'POST /api/sprint/refresh': async () => { await refreshSprint(needProject()); return snapshot(); },
  'GET /api/agents': () => loadAgents().map(agentDetail).map(d => ({ ...d, test: tests.get(d.id) || null })),
  'POST /api/agents/save': ({ id, patch }) => { saveAgent(id, patch || {}); return loadAgents().map(agentDetail); },
  'POST /api/agents/secret': ({ id, value }) => { if (!value) throw new Error('key 不能为空'); setSecret(id, value); return { ok: true }; },
  'POST /api/agents/test': ({ id }) => testAgent(id),
  'GET /api/agents/models': ({ id }) => fetchModels(id),
  'GET /api/log': ({ id }) => {
    const p = needProject(), r = loadState(p).runs.find(x => x.id === id);
    if (!r) throw new Error('没有这个运行');
    const f = runFiles(p, r);
    return { log: exists(f.log) ? stripAnsi(fs.readFileSync(f.log, 'utf8')) : '', task: exists(f.task) ? fs.readFileSync(f.task, 'utf8') : '', result: readJson(f.result, null), run: r };
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
    return { text: fs.readFileSync(f, 'utf8') };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
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
    for (const s of Object.values(st.stages || {})) if (s.status === 'running') { s.status = 'failed'; dirty = true; }
    const g = readWorkflow(p);
    for (const [id, s] of Object.entries((st.wf && st.wf.nodes) || {})) {
      const n = g.nodes.find(x => x.id === id);
      if (s.status === 'running' && n && n.type === 'agent') { s.status = 'failed'; s.note = '面板重启，运行中断'; dirty = true; }
    }
    if (dirty) saveState(p, st);
    // 重启后：Leader 模式接着统筹，规则自动模式接着派发
    setTimeout(() => { try { if (isLeaderMode(loadState(p))) scheduleTick(p, '面板重启后继续'); else { advanceWorkflow(p); autoDispatch(p); } } catch (e) { console.error(e.message); } }, 1500);
  }
  console.log(`Agent 统筹面板：http://127.0.0.1:${PORT}  项目：${config.project || '（未选择）'}`);
});
