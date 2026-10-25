# Agent 统筹面板

一个本地运行的多 agent 协作面板：选一个 agent 当 **Leader**，由它拆解需求、把任务派给其他 agent、验收结果、决定返工，你只在需要拍板的时候介入。流程基于 [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD)（需求 → PRD → 架构 → Story → 开发），画布是 Dify 风格的节点编排。

支持 **Claude Code、Codex、Gemini CLI、Grok CLI、DeepSeek Harness**，都是以无头模式调用它们真实的命令行。

- 零依赖：一个 `server.mjs`（Node 22 内置模块）+ 一个 `index.html`
- 网页里直接看每个 agent 的实时命令行输出
- Leader 统筹模式：参考 Magentic-One 的 Orchestrator，维护全局笔记和进度判断，自己派活、验收、打回、提问、宣布完成
- 技能库：给 Leader 和每个节点挂技能，运行前自动装进项目的 `.claude/skills` / `.agents/skills`
- 无头界面验收工具：用本机已装的 Edge / Chrome 跑 `--headless`，通过 CDP 实测页面，不开窗口

> ⚠️ 默认给 agent **最高权限**（无审批、无沙箱），只适合测试机或虚拟机。可在设置里切到“标准”档。

## 快速开始

要求：Windows 10/11、Node.js 22+，以及你要用的 agent CLI（至少装一个）。

```bash
git clone https://github.com/cjhfff/agent-panel.git
cd agent-panel
copy secrets.example.env secrets.env
start.cmd
```

浏览器会打开 <http://127.0.0.1:4590>。在 **设置** 里检查每家 agent 是否检测到、点“测连通”。

| 操作 | 方式 |
| --- | --- |
| 启动 / 停止 / 重启 | `start.cmd` / `stop.cmd` / `restart.cmd` |
| 换端口 | 环境变量 `PORT` |

### 配置 agent

`agents.json` 里是每家的调用方式。`cmd` 写命令名（走 PATH）或完整路径，`perm` 下是“最高 / 标准”两档参数。

Codex 和 Grok 默认用面板自己的配置目录（`codex-home/`、`grok-home/`），和你日常的配置隔离。要走 OpenAI 兼容中转站：

1. 改 `codex-home/config.toml`、`grok-home/config.toml` 里的 `base_url` 和 `model`
2. 在 `secrets.env` 里填 `RELAY_CODEX_KEY`、`RELAY_GROK_KEY`

不用中转站的话，把 `agents.json` 里对应 agent 的 `env`、`envFile`、`homeConfig` 删掉，它就用自己的默认登录。

## 页面

| 页面 | 做什么 |
| --- | --- |
| **工作流** | 画布：拖节点、连线、选模板、运行。可切到“Story 流程”看每个 Story 的返工轨迹 |
| **Leader** | Leader 的全局笔记、每轮决策（可展开简报和输出）、向你提的问题、“跟 Leader 说”留言框 |
| **看板** | Story 看板：分配、派发、diff、评审、通过 / 打回 |
| **技能库** | 面板精选库 + 当前项目 + 本机各处的技能，可新建、安装、设为 Leader 技能 |
| **运行记录** | 每次运行的任务、日志、结果 |
| **设置** | 启用、权限档、模型、key、并发数、连通测试 |

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
| `codex-home/`、`grok-home/` | 面板专用的 Codex / Grok 配置 |
| `skills/` | 面板精选技能库（`_catalog.json` 记分类和许可证） |
| `workflows/` | 工作流模板：BMAD 标准流程、快速实现 + 评审、方案 PK |
| `templates/` | 新项目模板（通用 / 嵌入式） |
| `tools/ui-check.mjs` | 无头界面验收工具 |
| `tools/fetch-remote-skills.mjs`、`review-remote-skills.mjs` | 从 GitHub 拉候选技能并做静态审查（只读，不执行） |
| `<项目>/_bmad-output/panel/` | 每个项目的画布、状态、运行记录 |

## 许可证

面板代码 MIT。`skills/` 下每个技能保留各自的许可证（见技能目录里的 LICENSE 文件和 `skills/_catalog.json`）。
