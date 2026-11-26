# 版本差异：V3 → V5

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 0：无
- 删除 0：无
- 改写 8：`A-11`（rule、expected）；`A-14`（rule、expected）；`A-16`（rule、expected）；`A-18`（rule、expected）；`A-22`（rule、expected）；`A-28`（expected）；`A-31`（rule、expected）；`A-35`（rule、expected）

## 二、画面

- 新增 0：无
- 删除 0：无
- 改动 1：`phone-preview`（entryActions）

## 三、文件

- 新增 1：源码 1（src/added/pages/quick-creation-agent/Conversation.tsx）
- 删除 0：无
- 改动 18：自检 1（checks/result.json）；其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 6（src/added/pages/quick-creation-agent/AttachmentTray.tsx、src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/ResultPanel.tsx、src/added/pages/quick-creation-agent/RunProgress.tsx、src/added/pages/quick-creation-agent/TemplateFrames.tsx、src/added/pages/quick-creation-agent/quickCreation.css）；工具 4（tools/handoff-local.mjs、tools/manifest-src.mjs、tools/self-check.mjs、tools/walkthrough.json）；文档 4（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff）

源码有 7 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V3：43/43
- V5：43/43

## 五、稿件属性

- prototypeVersion：3 → 5

源码差异没有附在包里（7 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v3 --to v5`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
