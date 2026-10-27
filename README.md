# Agent 统筹面板

一个本地运行的多 agent 协作面板：选一个 agent 当 **Leader**，由它拆解需求、把任务派给其他 agent、验收结果、决定返工，你只在需要拍板的时候介入。流程基于 [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)（需求 → PRD → 架构 → Story → 开发），画布是 Dify 风格的节点编排。

支持 **Claude Code、Codex、Gemini CLI、Grok CLI、DeepSeek Harness**，都是以无头模式调用它们真实的命令行。

- 轻量本地服务：`server.mjs` + `index.html`，用 npm 安装终端依赖
- Windows ConPTY 运行真实 CLI，网页用本地 xterm.js 渲染颜色、光标和进度条；终端默认禁止输入，可按标签开启
- Leader 统筹模式：参考 Magentic-One 的 Orchestrator，维护全局笔记和进度判断，自己派活、验收、打回、提问、宣布完成
- 技能库：给 Leader 和每个节点挂技能，运行前自动装进项目的 `.claude/skills` / `.agents/skills`
- 派活时 Leader 选的技能 + 系统按 Story 内容推荐的技能自动合并，看板和决策记录里能看到每个任务带了哪些（实线 = Leader 选的，虚线 = 系统补的）
- 无头界面验收工具：用本机已装的 Edge / Chrome 跑 `--headless`，通过 CDP 实测页面，不开窗口

> ⚠️ 默认给 agent **最高权限**（无审批、无沙箱），只适合测试机或虚拟机。可在设置里切到“标准”档。

## 快速开始

要求：Windows 10/11、Node.js 22+，以及你要用的 agent CLI（至少装一个）。

```bash
git clone https://github.com/cjhfff/agent-panel.git
cd agent-panel
npm install
copy secrets.example.env secrets.env
start.cmd
```

浏览器会打开 <http://127.0.0.1:4590>。在 **设置** 里检查每家 agent 是否检测到、点“测连通”。

PTY 依赖安装或加载失败时，面板会自动退回纯文本模式，仍可运行任务和查看日志。xterm.js 的脚本与样式由本地服务提供，不使用 CDN。

| 操作 | 方式 |
| --- | --- |
| 启动 / 停止 / 重启 | `start.cmd` / `stop.cmd` / `restart.cmd` |
| 换端口 | 环境变量 `PORT` |

### 配置 agent

`agents.json` 里是每家的调用方式。`cmd` 写命令名（走 PATH）或完整路径，`perm` 下是“最高 / 标准”两档参数。

### 认证与服务商

打开 **设置 → 服务商**，可配置 Anthropic、OpenAI、Google Gemini、xAI、DeepSeek 的内置预设，也可添加自定义服务商。填写 Base URL 和 API Key 后点「检查」或「获取模型」。内置预设可编辑，不能删除；被 Agent 使用中的服务商也不能删除。

在 **设置 → Agent** 为每家选择认证方式：

- **官方账号**：使用 CLI 自己的账号与配置。Codex / Grok 使用用户默认配置目录。登录按钮会按用户操作打开一个可见终端；Claude 运行 `claude` 后输入 `/login`，Codex 使用 `codex login`，Grok 使用 `grok login`。未核实登录命令的 CLI 只显示提示，可在自己的终端完成登录后刷新状态。
- **服务商**：选择兼容的服务商和模型。Claude 仅支持 Anthropic 类型，Codex 支持 OpenAI 类型，Gemini 支持 Gemini 类型，Grok 支持 OpenAI / xAI 类型。模型可从服务商缓存列表选择，也可手填。DeepSeek Harness 使用自身配置，当前不支持面板注入服务商。

服务商模式中，Claude / Codex / Grok 分别使用面板隔离目录 `claude-home/`、`codex-home/`、`grok-home/`；切换不会修改用户目录。Claude 使用 `ANTHROPIC_AUTH_TOKEN`，并移除继承的 `ANTHROPIC_API_KEY`，避免认证冲突。Codex / Grok 更新模型配置时保留项目等其他配置段。

`providers.json` 只保存服务商元数据和模型缓存；API Key 保存到被 Git 忽略的 `secrets.env`，接口与页面只显示是否已设置和末四位。`agents.json` 的 `auth` 字段保存 `mode`、`provider`、`model`。官方账号状态只检查凭据文件是否存在，不读取内容；文件存在不代表凭据仍有效。

公开导出只带恢复为官方地址的内置服务商预设、空模型缓存和空 key，所有 Agent 默认使用官方账号。`claude-home/settings.json` 是空配置模板，其余隔离运行数据不进入导出。

## 页面

| 页面 | 做什么 |
| --- | --- |
| **工作流** | 画布：拖节点、连线、选模板、运行。可切到“Story 流程”看每个 Story 的返工轨迹 |
| **Leader** | Leader 的全局笔记、每轮决策（可展开简报和输出）、向你提的问题、“跟 Leader 说”留言框 |
| **看板** | Story 看板：分配、派发、diff、评审、通过 / 打回 |
| **技能库** | 面板精选库 + 当前项目 + 本机各处的技能，可新建、安装、设为 Leader 技能 |
| **运行记录** | 每次运行的任务、日志、结果 |
| **设置** | 服务商配置、认证方式、启用、权限档、模型、并发数、连通测试 |

左下角的 **CREW** 指示灯一家一盏：呼吸发光 = 正在干活，绿点 = 空闲，灰 = 停用 / 未安装，虚线框 = 当前 Leader。

## 三种模式

| 模式 | 谁推进 |
| --- | --- |
| 手动 | 你确认每个节点、派发和验收每个 Story |
| 规则自动 | 面板按依赖派发，每个产出单独起一次 Leader 评审，最多打回 N 轮 |
| **Leader 统筹** | 每有任务完成就唤醒 Leader 一次，它读全局简报后决定：验收 / 打回、派活（指定 agent、技能、改动范围）、推进规划节点、向你提问、宣布完成 |

验收档位（Leader 页）：**快速**（看能用、好看好用）/ **标准**（要证据，界面类要无头实测）/ **严格**（再加非实现者交叉验收）。

Leader 连续几轮没进展、连续失败或唤醒次数到上限会自动暂停，等你点“继续”。

## 安全约束

每个任务都会附上禁止项：不开有界面的程序、不模拟键鼠、不碰剪贴板、不下载安装软件、只改项目目录。需要真人确认的验收写进 `manual_checks` 交给你。

## 目录

| 路径 | 内容 |
| --- | --- |
| `server.mjs` / `index.html` | 后端 / 前端 |
| `agents.json` | 各家调用方式、权限档、模型参数 |
| `providers.json` | 服务商元数据与模型缓存，不含 API Key |
| `claude-home/`、`codex-home/`、`grok-home/` | 服务商模式的隔离配置 |
| `skills/` | 面板精选技能库（`_catalog.json` 记分类和许可证） |
| `workflows/` | 工作流模板：BMAD 标准流程、快速实现 + 评审、方案 PK |
| `templates/` | 新项目模板（通用 / 嵌入式） |
| `tools/ui-check.mjs` | 无头界面验收工具 |
| `tools/fetch-remote-skills.mjs`、`review-remote-skills.mjs` | 从 GitHub 拉候选技能并做静态审查（只读，不执行） |
| `<项目>/_bmad-output/panel/` | 每个项目的画布、状态、运行记录 |

## 许可证

面板代码 MIT。`skills/` 下每个技能保留各自的许可证（见技能目录里的 LICENSE 文件和 `skills/_catalog.json`）。
