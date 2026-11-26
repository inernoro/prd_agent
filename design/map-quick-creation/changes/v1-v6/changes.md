# 版本差异：V1 → V6

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 6：`A-41` 直接粘贴正文：一次粘贴 300 字以上的长文自动作为一份稿件附件，输入框只留给要求；`A-42` 上传 Markdown / TXT 稿件或图片：读出文字的可直接生成，空文件或不支持的格式显示原因；`A-43` 风格库按 Lemo-Opuscar 的分类：15 类 99 种，可按类别筛选、按名字或类别搜索；选中风格显示样片海报、样片名与时长、一句话说明和来源署名；`A-44` 输入框里的风格按钮就地弹出选择面板（搜索 + 类别 + 列表），选中后面板关闭，按钮与右栏风格库同步；面板底部可去右栏看大图；`A-45` 「视频 / 网页」在输入框里切换，风格与产出相互独立：切换产出不改风格，切换风格不改产出；`A-46` 风格来源与授权写清：风格说明（STYLE.md，CC BY-NC 4.0）只按编号引用、界面与源码差异不含原文；样片海报署名「Lemo-Opuscar by Lemomo (LemoLab)」并注明 CC BY 4.0
- 删除 0：无
- 改写 25：`A-11`（rule、expected）；`A-12`（interaction）；`A-13`（rule、expected）；`A-14`（rule、expected）；`A-15`（interaction）；`A-16`（rule、expected）；`A-17`（interaction）；`A-18`（rule、expected、interaction）；`A-19`（interaction）；`A-20`（interaction）；`A-22`（rule、expected）；`A-23`（interaction）；`A-24`（interaction）；`A-25`（interaction）；`A-26`（rule、expected、interaction）；`A-27`（interaction）；`A-28`（expected）；`A-29`（interaction）；`A-30`（interaction）；`A-31`（rule、expected）；`A-32`（interaction）；`A-33`（interaction）；`A-35`（rule、expected）；`A-39`（rule、expected、interaction）；`A-40`（interaction）

## 二、画面

- 新增 1：`style-picker` 输入框里就地换风格（15 类 99 种）
- 删除 0：无
- 改动 1：`phone-preview`（entryActions）

## 三、文件

- 新增 108：自检 1（checks/handoff-local.json）；源码 103（src/added/pages/quick-creation-agent/Conversation.tsx、src/added/pages/quick-creation-agent/StyleLibrary.tsx、src/assets/demo-film.webm、src/opuscar/catalog.json、src/opuscar/posters/archive-lighttable.webp、src/opuscar/posters/art-deco.webp…）；工具 3（tools/handoff-local.mjs、tools/import-opuscar.py、tools/make-demo-film.mjs）；文档 1（设计文档/验收计划.md）
- 删除 0：无
- 改动 28：自检 1（checks/result.json）；其他 3（design.json、prototype.json、versions.json）；原型 1（dist/index.html）；源码 12（src/added/pages/quick-creation-agent/AttachmentTray.tsx、src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/ResultPanel.tsx、src/added/pages/quick-creation-agent/RunProgress.tsx、src/added/pages/quick-creation-agent/TemplateFrames.tsx、src/added/pages/quick-creation-agent/WorksList.tsx…）；工具 6（tools/export-demo-data.mjs、tools/interact-check.mjs、tools/manifest-src.mjs、tools/prototype-build.prd-admin.patch、tools/self-check.mjs、tools/walkthrough.json）；文档 5（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff、设计文档/演示数据.json）

源码差异在 `source.diff`：115 个文件。

## 四、自检

- V1：41/41
- V6：47/47

## 五、稿件属性

- prototypeVersion：1 → 6
