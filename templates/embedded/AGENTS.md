# 项目说明（所有 AI 编码工具共用：Claude Code / Codex / Gemini CLI / Grok / DeepSeek Harness）

{{PROJECT_NAME}}（嵌入式项目，BMAD 工作流）。

- 开工前必读 `docs/embedded-standards.md`（硬规则违反即不合格；按真实平台修改该文件）
- 宿主单元测试：`make -C test`，全绿才算完成（还没有时由第一个开发 Story 搭建）
- 规划文档：`_bmad-output/planning-artifacts/`（PRD、架构、epics）
- BMAD skill：`.agents/skills/`（Codex/Gemini/Grok/DeepSeek Harness）与 `.claude/skills/`（Claude Code），内容相同
- BMAD 脚本依赖 `uv`；不知道下一步做什么，调用 `bmad-help`
