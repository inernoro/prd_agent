# 版本差异：V7 → V8

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 0：无
- 删除 0：无
- 改写 1：`A-35`（rule、expected）

## 二、画面

- 新增 2：`phone-plus` 手机 · 输入框左下的「+」：上传与知识库；`phone-style` 手机 · 「视频 · 风格」按钮：产出切换在面板顶部
- 删除 0：无
- 改动 1：`phone-compose`（entryActions）

## 三、文件

- 新增 0：无
- 删除 0：无
- 改动 15：自检 1（checks/result.json）；其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 4（src/added/pages/quick-creation-agent/BriefChat.tsx、src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/StyleLibrary.tsx、src/added/pages/quick-creation-agent/quickCreation.css）；工具 2（tools/manifest-src.mjs、tools/walkthrough.json）；文档 5（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff、设计文档/验收计划.md）

源码有 4 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V7：55/55
- V8：55/55

源码差异没有附在包里（4 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v7 --to v8`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
