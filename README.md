# Agent 统筹面板

一个本地运行的多 agent 协作面板：选一个 agent 当 **Leader**，由它拆解需求、把任务派给其他 agent、验收结果、决定返工，你只在需要拍板的时候介入。新项目默认采用组件化编排，由 Leader 按需求决定流程深浅；也可使用基于 [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) 的模板流程（需求 → PRD → 架构 → Story → 开发）。

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
| **工作流** | 组件模式显示调用实况图；模板模式可拖节点、连线、选模板，也可切到“Story 流程”看返工轨迹 |
| **Leader** | Leader 的全局笔记、每轮决策（可展开简报和输出）、向你提的问题、“跟 Leader 说”留言框 |
| **看板** | 组件模式显示任务及调用状态；模板模式提供 Story 的分配、派发、diff、评审、通过 / 打回 |
| **技能库** | 面板精选库 + 当前项目 + 本机各处的技能，可新建、安装、设为 Leader 技能 |
| **运行记录** | 每次运行的任务、日志、结果 |
| **定时任务** | 按时间在指定项目追加需求或新建项目，查看运行历史 |
| **设置** | 服务商配置、认证方式、启用、权限档、模型、并发数、连通测试 |

左下角的 **CREW** 指示灯一家一盏：呼吸发光 = 正在干活，绿点 = 空闲，灰 = 停用 / 未安装，虚线框 = 当前 Leader。

## 三种模式

| 模式 | 模板编排 | 组件编排 |
| --- | --- | --- |
| 手动 | 你确认每个节点、派发和验收每个 Story | 你从组件库添加并运行组件，面板按已声明的依赖推进 |
| 规则自动 | 面板按依赖派发，每个产出单独起一次 Leader 评审，最多打回 N 轮 | 由 Leader 自主选择和调用组件，与 Leader 统筹使用同一套编排逻辑 |
| **Leader 统筹** | Leader 读全局简报后派活、验收、打回、推进规划节点、向你提问和宣布完成 | 组件完成后唤醒 Leader，由它决定下一步调用、澄清或交付 |

模板编排的验收档位（Leader 页）：**快速**（看能用、好看好用）/ **标准**（要证据，界面类要无头实测）/ **严格**（再加非实现者交叉验收）。组件编排隐藏此选项，由 Leader 根据需求和留言决定验证深度。

Leader 连续几轮没进展、连续失败或唤醒次数到上限会自动暂停，等你点“继续”。

## 组件化编排

新项目默认使用 **组件编排**。Leader 读需求原文、你的留言、已有产出和可用 agent，边做边挑组件，无需先批准一套计划。简单需求可以直接实现、自测、交付；需要时再补需求、方案、拆分或独立验收。你可以随时在 Leader 页留言说明“快点”“要稳”等偏好；方向拿不准时，Leader 会用“澄清”组件向你提问。

| 组件 | 用途 / 参数 |
| --- | --- |
| 澄清 `clarify` | 向你提出问题，使用现有待答问题界面 |
| 需求 `spec` | `brief` 要点需求 / `full` 完整 PRD |
| 方案 `design` | `brief` 关键决策 / `full` 完整架构 |
| 拆分 `split` | 输出含目标、验收要点、建议 agent 和依赖的任务清单，`max` 限定数量 |
| 实现 `implement` | 指定 agent、指令、技能与改动范围 `writes` |
| 自测 `test` | 按关注点运行测试或无头界面实测 |
| 评审 `review` | 由另一位 agent 检查代码和结果 |
| 交叉验收 `crosscheck` | 由非实现者逐条检查验收要点 |
| 方案对比 `compare` | 两位 agent 各出方案，由 Leader 汇总取舍 |
| 修复 `fix` | 按问题列表修改 |
| 文档 `doc` | 编写使用说明、README 等 |
| 交付 `deliver` | 汇总交付说明并宣布完成 |

Leader 通过 `call` 动作调用组件，调用 ID 在项目内唯一，`depends_on` 引用前面的调用。无依赖的调用可在并发上限内并行；每个调用完成后再次唤醒 Leader。

```json
{"type":"call","id":"c2","component":"implement","agent":"codex","depth":"brief","inputs":{"instructions":"实现当前时间页面","writes":["index.html"]},"depends_on":[],"why":"需求清楚，直接实现即可"}
```

组件返回统一的结果：`summary`、产出路径 `artifacts`，以及按需提供的 `findings`、`tasks`、`pass` 和 `open_questions`。Leader 简报也会列出组件的历史平均耗时与次数；没有历史时显示估计，供它权衡工作量。常见流程仅供参考：小需求 `implement → test → deliver`；中等需求 `spec(brief) → split → 并行 implement → review → fix → deliver`；大需求按需增加 `spec(full)`、`design(full)` 和交叉验收。首次调用 `full` 需求或方案时，若项目缺少 BMAD 技能，面板会按需准备；准备失败会保留日志，并将组件标为失败。

工作流画布显示**实况图**：从需求开始，每次调用生成一个节点，按依赖从左到右排布，交付后接结束节点。节点显示调用理由、agent / 模型、状态和耗时；点开可查看输入、结果摘要、产出文件、问题和执行终端。组件模式不要求先生成 BMAD 文档或 Story 看板。

在工作流尚未开始时，可通过工作流栏的编排选项切回 **模板编排**，再选择 BMAD 或其他模板。已有项目保持模板模式，原有画布和推进方式继续使用。组件模式的护栏包括：单项目最多 80 次调用；同一组件对同一目标连续失败两次时暂停并向你提问，避免无休止重试。

## 保存与复用工作流

在工作流栏点 **保存为工作流**，填写名称、一句话说明和可选的适用需求。模板项目保存当前画布的节点、连线和配置；组件项目保存 Leader 实际调用的组件、深度、执行 agent、依赖与理由，不保存运行状态和结果。

模板下拉框按“内置模板 / 我保存的”分组。应用保存的流程时，默认 **作为参考**：切到组件编排，将配方放进 Leader 简报，由 Leader 按本次需求调整。选择 **固定执行** 则切到模板编排，按图执行，适合固定的重复流程。管理窗口支持重命名、确认后删除、导出 JSON 和从文件选择器导入 JSON。

固定执行会保留原流程的具体输入；引用的文件需要由前面的节点生成，或已存在于目标项目。包含临时修复、一次性测试文件名的流程更适合作为参考。固定节点失败会明确结束并显示原因，不会自动改编流程。

保存文件位于 `workflows/saved/<安全文件名>.json`，包含 `name`、`desc`、`fit`、`kind`（`template` / `recipe`）、`createdAt`、`from` 和 `graph` / `recipe`。保存和导入会清理凭据及私有绝对路径。该目录的用户文件不进入 Git 或公开导出，公开副本只带 `.gitkeep`。

## 定时任务

左侧 **定时任务** 页面可以新建、编辑、启停、立即运行、预览接下来三次时间及查看历史。支持每天、每周、每 N 小时和五段 cron（分、时、日、月、星期），不依赖系统计划任务。时间按本机时区显示和计算；本机使用中国标准时间时为 UTC+8。

目标可选固定项目或每次新建项目。固定项目将指令作为老板的新需求交给该项目的 Leader；新建项目放在 `projectsRoot` 的 `<名称>-<YYYYMMDD-HHmm>` 目录下。没有 Leader 时沿用自动选择规则。编排可选组件自主编排、内置模板，或保存工作流的参考 / 固定用法。

调度器在面板进程内每 30 秒检查一次。同一条任务上次未完成时跳过，并记入历史；面板关闭期间错过的时间不补跑，只累计错过次数和最近一次错过时间。历史保留最近 100 条，记录开始时间、耗时、结果、项目链接和交付总结第一行。启动和结束有 toast，顶栏与 CREW 附近显示正在运行的任务数。

定时任务显式传递目标项目给运行队列、Leader 唤醒和工作流推进，后台执行不会切换当前打开的项目。各项目共享设置中的并发上限；需要人工回答的流程会保持未完成，后续同条定时触发会跳过。面板必须保持运行，关闭面板会中断调度。

模板重复执行时，旧计划、Story 状态与本轮运行配置先归档到项目的 `_bmad-output/panel/workflow-rounds/`，再为新一轮重建，避免旧的“已完成”状态跳过本次需求；原文档和运行记录保留。完整 BMAD 模板缺少项目技能时会按需在该项目内准备。

任务存储在根目录 `schedules.json`，已加入 Git 忽略且不进入公开导出。使用 `PANEL_CONFIG` 启动隔离实例时，任务与保存工作流写在该配置文件的同级目录下，便于测试和清理。

## 面板任务（外部派活）

外部助手可通过面板启动独立开发任务，由面板托管进程。任务集中显示在 **运行记录 → 面板任务**，支持查看终端、最终回复和取消；运行时顶栏显示数量，CREW 对应 agent 的灯显示忙。任务使用单独的队列，通过配置 `maxDevtasks` 限制并发，默认同时运行 2 个。

```bash
node tools/devtask.mjs --title "开发小任务" --agent codex --cwd ./projects/demo --effort low --prompt-file ./task.md
node tools/wait-devtask.mjs <上一步输出的id> --timeout-min 240
```

派活工具成功时只打印 id，支持 `--model` 覆盖本次模型；两种工具默认连接 `http://127.0.0.1:4590`，可通过 `--url http://127.0.0.1:4599` 或环境变量 `PANEL_URL` 指定实例。等待工具每 15 秒查询一次，连接失败会重试，结束时打印状态、退出码、耗时和最终回复前 2000 字；工具退出码为 0（finished）、1（其他终态或请求错误）、2（等待超时或参数错误）。

接口为 `POST /api/devtask`（`{title, agent, cwd, prompt, effort?, model?}`）、`GET /api/devtask?id=<id>`、`GET /api/devtasks`（最近 50 条）及 `POST /api/devtask/cancel`（`{id}`）。状态接口的 `lastMessage` 最多 4000 字；回复弹窗使用 `GET /api/devtask/reply?id=<id>` 读取完整回复。仅能调用已安装且启用的 agent，不能传任意命令；工作目录必须已存在且位于配置 `devtaskRoots` 内，默认允许面板目录及 `projectsRoot`（显式数组将替换默认根目录）。Codex 的 effort 支持 low / medium / high / xhigh / ultra；其他 agent 忽略 effort 并在运行记录注明。

任务文件保存在 `logs/devtasks/<id>/`：`task.md` 为带 UTF-8 BOM 的任务说明，`run.log` 为终端输出，`last.md` 为最终回复。Codex 通过 CLI 自动保存；其他 agent 的任务书会要求写入该文件，未生成时仍可查看终端。服务商模式使用该任务自己的 `auth/` 配置目录，不改已有的隔离认证目录或默认模型。`logs/devtasks/state.json` 保存状态；面板重启时，尚在运行的任务标为 interrupted，排队任务继续执行。使用 `PANEL_CONFIG` 时，存储根目录为该配置文件同级的 `logs/devtasks/`。面板进程需保持运行，外部助手的会话重启不影响已派发的任务。

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
| `workflows/saved/` | 用户保存的画布或组件配方，公开导出只保留 `.gitkeep` |
| `schedules.json` | 本地定时任务及历史，不进入 Git 或公开导出 |
| `templates/` | 新项目模板（通用 / 嵌入式） |
| `tools/ui-check.mjs` | 无头界面验收工具 |
| `tools/devtask.mjs`、`tools/wait-devtask.mjs` | 从命令行派发面板任务 / 等待结果 |
| `logs/devtasks/` | 面板任务状态、任务说明、终端日志和最终回复，不进入 Git 或公开导出 |
| `tools/fetch-remote-skills.mjs`、`review-remote-skills.mjs` | 从 GitHub 拉候选技能并做静态审查（只读，不执行） |
| `<项目>/_bmad-output/panel/` | 每个项目的画布、状态、运行记录 |

## 许可证

面板代码 MIT。`skills/` 下每个技能保留各自的许可证（见技能目录里的 LICENSE 文件和 `skills/_catalog.json`）。
