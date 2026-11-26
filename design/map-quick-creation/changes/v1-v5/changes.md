# 版本差异：V1 → V5

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 2：`A-41` 直接粘贴正文：一次粘贴 300 字以上的长文自动作为一份稿件附件，输入框只留给要求；`A-42` 上传 Markdown / TXT 稿件或图片：读出文字的可直接生成，空文件或不支持的格式显示原因
- 删除 0：无
- 改写 24：`A-11`（rule、expected）；`A-12`（interaction）；`A-14`（rule、expected）；`A-15`（interaction）；`A-16`（rule、expected）；`A-17`（interaction）；`A-18`（rule、expected、interaction）；`A-19`（interaction）；`A-20`（interaction）；`A-22`（rule、expected）；`A-23`（interaction）；`A-24`（interaction）；`A-25`（interaction）；`A-26`（rule、expected、interaction）；`A-27`（interaction）；`A-28`（expected）；`A-29`（interaction）；`A-30`（interaction）；`A-31`（rule、expected）；`A-32`（interaction）；`A-33`（interaction）；`A-35`（rule、expected）；`A-39`（interaction）；`A-40`（interaction）

## 二、画面

- 新增 0：无
- 删除 0：无
- 改动 1：`phone-preview`（entryActions）

## 三、文件

- 新增 5：自检 1（checks/handoff-local.json）；源码 2（src/added/pages/quick-creation-agent/Conversation.tsx、src/assets/demo-film.webm）；工具 2（tools/handoff-local.mjs、tools/make-demo-film.mjs）
- 删除 0：无
- 改动 24：自检 1（checks/result.json）；其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 11（src/added/pages/quick-creation-agent/AttachmentTray.tsx、src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/ResultPanel.tsx、src/added/pages/quick-creation-agent/RunProgress.tsx、src/added/pages/quick-creation-agent/TemplateFrames.tsx、src/added/pages/quick-creation-agent/WorksList.tsx…）；工具 5（tools/interact-check.mjs、tools/manifest-src.mjs、tools/prototype-build.prd-admin.patch、tools/self-check.mjs、tools/walkthrough.json）；文档 4（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff）

源码差异在 `source.diff`：13 个文件。

## 四、自检

- V1：41/41
- V5：43/43

## 五、稿件属性

- prototypeVersion：1 → 5
