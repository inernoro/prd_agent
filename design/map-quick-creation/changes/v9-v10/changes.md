# 版本差异：V9 → V10

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 0：无
- 删除 0：无
- 改写 13：`A-05`（expected）；`A-11`（rule、expected）；`A-12`（rule、expected）；`A-16`（rule、expected）；`A-19`（rule、expected）；`A-21`（rule、expected）；`A-35`（rule、expected）；`A-39`（rule、expected）；`A-43`（rule、expected）；`A-44`（rule、expected）；`A-45`（rule）；`A-47`（rule、expected）；`A-48`（rule、expected）

## 二、画面

- 新增 0：无
- 删除 0：无
- 改动 6：`assets`（name、entryActions）；`assets-team`（name、entryActions）；`compose-web`（entryActions）；`duration-picker`（name、entryActions）；`phone-assets`（name、entryActions）；`phone-style`（name、entryActions）

## 三、文件

- 新增 1：源码 1（src/added/pages/quick-creation-agent/Landing.tsx）
- 删除 0：无
- 改动 20：自检 2（checks/handoff-local.json、checks/result.json）；其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 8（src/added/pages/quick-creation-agent/BriefChat.tsx、src/added/pages/quick-creation-agent/BrowserExport.tsx、src/added/pages/quick-creation-agent/Conversation.tsx、src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/ResultPanel.tsx、src/added/pages/quick-creation-agent/RunProgress.tsx…）；工具 3（tools/manifest-src.mjs、tools/self-check.mjs、tools/walkthrough.json）；文档 4（交付说明.md、思路.md、设计文档/源码差异.diff、设计文档/验收计划.md）

源码有 9 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V9：60/60
- V10：60/60

源码差异没有附在包里（9 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v9 --to v10`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
