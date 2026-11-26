# 版本差异：V3 → V6

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 6：`A-43` 风格库按 Lemo-Opuscar 的分类：15 类 99 种，可按类别筛选、按名字或类别搜索；选中风格显示样片海报、样片名与时长、一句话说明和来源署名；`A-44` 输入框里的风格按钮就地弹出选择面板（搜索 + 类别 + 列表），选中后面板关闭，按钮与右栏风格库同步；面板底部可去右栏看大图；`A-45` 「视频 / 网页」在输入框里切换，风格与产出相互独立：切换产出不改风格，切换风格不改产出；`A-46` 风格说明（STYLE.md，已取得使用授权）由服务端在生成时交给智能体，界面只显示风格名、样片与一句话说明，不展示风格说明全文；样片海报署名「Lemo-Opuscar by Lemomo (LemoLab)」；`A-47` 右栏是「选择与资产」：新建时页签为「风格 / 产物」，任务中为「本次 / 产物」；产物页签只列已生成的视频与网页，上方是选中产物的大图、风格、作者、时间与发布状态，下方按「我的 / 团队」和视频、网页浏览；`A-48` 从产物复用：「用这个风格」把风格带回输入框（任务中则新建并带上风格），「打开」回到原任务，已发布的可去网页托管；当前正在用的风格不重复带回
- 删除 0：无
- 改写 12：`A-11`（rule、expected）；`A-13`（rule、expected）；`A-14`（rule、expected）；`A-16`（rule、expected）；`A-18`（rule、expected）；`A-20`（rule、expected）；`A-21`（rule、expected）；`A-22`（rule、expected）；`A-28`（expected）；`A-31`（rule、expected）；`A-35`（rule、expected）；`A-39`（rule、expected）

## 二、画面

- 新增 4：`assets` 右栏产物：回看我生成过的视频与网页；`assets-team` 右栏产物 · 团队：同事用其他风格做的成品；`phone-assets` 手机 · 预览页签里的产物；`style-picker` 输入框里就地换风格（15 类 99 种）
- 删除 0：无
- 改动 1：`phone-preview`（entryActions）

## 三、文件

- 新增 105：源码 103（src/added/pages/quick-creation-agent/AssetLibrary.tsx、src/added/pages/quick-creation-agent/Conversation.tsx、src/added/pages/quick-creation-agent/StyleLibrary.tsx、src/opuscar/catalog.json、src/opuscar/posters/archive-lighttable.webp、src/opuscar/posters/art-deco.webp…）；工具 1（tools/import-opuscar.py）；文档 1（设计文档/验收计划.md）
- 删除 0：无
- 改动 27：自检 2（checks/handoff-local.json、checks/result.json）；其他 3（design.json、prototype.json、versions.json）；原型 1（dist/index.html）；源码 11（src/added/pages/quick-creation-agent/AttachmentTray.tsx、src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/ResultPanel.tsx、src/added/pages/quick-creation-agent/RunProgress.tsx、src/added/pages/quick-creation-agent/TemplateFrames.tsx、src/added/pages/quick-creation-agent/WorksList.tsx…）；工具 5（tools/export-demo-data.mjs、tools/handoff-local.mjs、tools/manifest-src.mjs、tools/self-check.mjs、tools/walkthrough.json）；文档 5（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff、设计文档/演示数据.json）

源码有 114 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V3：43/43
- V6：49/49

## 五、稿件属性

- prototypeVersion：3 → 6

源码差异没有附在包里（114 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v3 --to v6`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
