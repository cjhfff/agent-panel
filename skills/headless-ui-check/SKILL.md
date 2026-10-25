---
name: headless-ui-check
description: 网页界面验收：用本机已安装的 Edge/Chrome 无头模式（不开窗口、不装软件）按步骤点击、输入、按键，并断言页面状态，输出逐步结果和截图。验收任何带界面的 Story、复现界面 bug、给界面功能补回归测试时使用。
---

# 无头界面验收（headless-ui-check）

只读代码或用假 DOM 跑单元测试，**不能证明界面能用**：按钮点了没反应、焦点被抢、刷新后数据没了，这些只有真浏览器里操作才测得出。本技能用面板自带的工具在后台无头浏览器里做真实操作。

## 工具

```bash
node <面板目录>/tools/ui-check.mjs --root <项目目录> [--page index.html] --steps <步骤文件.json> --out <结果.json> [--shot <截图.png>]
```

- 自动起一个本地静态服务，用本机 Edge/Chrome `--headless` 打开页面，跑完自动关闭并清理临时配置。
- 退出码：0 全部通过；1 有步骤失败或页面有控制台报错；2 工具本身出错。
- **不要**改用有界面的浏览器、不要自己下载浏览器或 Playwright、不要测系统剪贴板。

## 步骤文件格式（JSON 数组）

| 步骤 | 例子 |
| --- | --- |
| 点击 / 双击 | `{"do":"click","selector":"#c-0-0"}`、`{"do":"dblclick","selector":"..."}` |
| 键入文字 | `{"do":"type","text":"=SUM(A1:A2)"}` |
| 按键（可带修饰键） | `{"do":"key","key":"Enter"}`、`{"do":"key","key":"z","mods":["ctrl"]}`；支持 Enter Tab Escape Delete Backspace F2 方向键 Home End 和字母数字 |
| 断言 | `{"do":"expect","js":"document.querySelector('#c-2-0').textContent","equals":"60","note":"SUM 公式"}`；也可用 `contains`、`matches`（正则字符串）、`truthy` |
| 执行脚本 | `{"do":"eval","js":"localStorage.clear()"}` |
| 等待 / 刷新 / 截图 | `{"do":"wait","ms":300}`、`{"do":"reload"}`、`{"do":"shot","path":"x.png"}` |

每个 `expect` 都写 `note`，说明它对应哪条验收标准。

## 验收流程

1. 读 Story 的验收标准（epics.md），**每条标准至少写一个 expect**；先用 `{"do":"eval","js":"localStorage.clear()"}` 和 `{"do":"reload"}` 从干净状态开始。
2. 步骤文件放在 `test/acceptance/<story key>.steps.json`，以后可以反复跑做回归。
3. 运行工具，读结果 JSON：每个失败步骤写清楚“做了什么 → 期望什么 → 实际得到什么”。
4. 页面有控制台报错（`consoleErrors`）也算不通过。
5. 剪贴板类功能：不要按 Ctrl+C/V 碰系统剪贴板，改用 `eval` 派发页面内的 `paste` 事件，或直接调用代码接口验证。

## 报告格式

每条验收标准一行：`标准 | 方法（ui-check / node --test / 读代码）| 具体步骤或测试名 | 结果`。只读代码得出的结论要明确标注“未实测”。
