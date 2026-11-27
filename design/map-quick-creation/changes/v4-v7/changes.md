# 版本差异：V4 → V7

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 12：`A-43` 风格库按 Lemo-Opuscar 的分类：15 类 99 种，可按类别筛选、按名字或类别搜索；选中风格显示样片海报、样片名与时长、一句话说明和来源署名；`A-44` 输入框里的风格按钮就地弹出选择面板（搜索 + 类别 + 列表），选中后面板关闭，按钮与右栏风格库同步；面板底部可去右栏看大图；`A-45` 「视频 / 网页」在输入框里切换，风格与产出相互独立：切换产出不改风格，切换风格不改产出；`A-46` 风格说明（STYLE.md，已取得使用授权）由服务端在生成时交给智能体，界面只显示风格名、样片与一句话说明，不展示风格说明全文；样片海报署名「Lemo-Opuscar by Lemomo (LemoLab)」；`A-47` 右栏是「选择与资产」：新建时页签为「风格 / 产物」，任务中为「本次 / 产物」；产物页签只列已生成的视频与网页，上方是选中产物的大图、风格、作者、时间与发布状态，下方按「我的 / 团队」和视频、网页浏览；`A-48` 从产物复用：「用这个风格」把风格带回输入框（任务中则新建并带上风格），「打开」回到原任务，已发布的可去网页托管；当前正在用的风格不重复带回；`A-49` 对话起稿：不知道选什么时可以直接说想做什么；快速创作每次只问一个它还拿不准的问题，并给几个可以直接点的回答；回复逐字出现，顶部显示这次用的模型；`A-50` 创作简报：开工条件一眼可见，必填三项（做成什么、讲什么、风格）与建议两项（给谁看、时长），聊到哪一条勾哪一条；判定由服务端结构化给出，前端不从聊天文字里猜；`A-51` 推荐风格：按目的与感觉推荐 3 个风格，每个带样片海报与一句为什么适合；点「用这个」或说「第二个」都能选定，输入框的风格按钮与右栏同步；`A-52` 准备好了：必填条件都齐了，助手复述简报并给主按钮「开始生成（约 30–60 分钟）」；直接说「可以开始了」效果一样；条件不够时说明还缺什么，不硬开始；`A-53` 开工前先看分镜脚本：每幕一句画面、一句旁白，确认后正式排队；不想看可以一键跳过；想改直接在对话里说；`A-54` 没有稿件也能只靠对话出片：讲什么来自对话，文案由快速创作按对话先写；任务里写明内容来自对话
- 删除 0：无
- 改写 12：`A-11`（rule、expected）；`A-13`（rule、expected）；`A-14`（rule、expected）；`A-16`（rule、expected）；`A-18`（rule、expected）；`A-20`（rule、expected）；`A-21`（rule、expected）；`A-22`（rule、expected）；`A-28`（expected）；`A-31`（rule、expected）；`A-35`（rule、expected）；`A-39`（rule、expected）

## 二、画面

- 新增 9：`assets` 右栏产物：回看我生成过的视频与网页；`assets-team` 右栏产物 · 团队：同事用其他风格做的成品；`chat-ready` 对话起稿：条件齐了，准备好了；`chat-recommend` 对话起稿：按「科技感」推荐 3 个风格；`chat-script` 对话起稿：开工前确认分镜脚本；`chat-start` 对话起稿：不知道选什么，直接说想做宣传片；`phone-assets` 手机 · 预览页签里的产物；`phone-chat` 手机 · 对话起稿与推荐风格；`style-picker` 输入框里就地换风格（15 类 99 种）
- 删除 0：无
- 改动 1：`phone-preview`（entryActions）

## 三、文件

- 新增 107：源码 105（src/added/pages/quick-creation-agent/AssetLibrary.tsx、src/added/pages/quick-creation-agent/BriefChat.tsx、src/added/pages/quick-creation-agent/Conversation.tsx、src/added/pages/quick-creation-agent/StyleLibrary.tsx、src/briefEngine.ts、src/opuscar/catalog.json…）；工具 1（tools/import-opuscar.py）；文档 1（设计文档/验收计划.md）
- 删除 0：无
- 改动 27：自检 2（checks/handoff-local.json、checks/result.json）；其他 3（design.json、prototype.json、versions.json）；原型 1（dist/index.html）；源码 11（src/added/pages/quick-creation-agent/AttachmentTray.tsx、src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/ResultPanel.tsx、src/added/pages/quick-creation-agent/RunProgress.tsx、src/added/pages/quick-creation-agent/TemplateFrames.tsx、src/added/pages/quick-creation-agent/WorksList.tsx…）；工具 5（tools/export-demo-data.mjs、tools/handoff-local.mjs、tools/manifest-src.mjs、tools/self-check.mjs、tools/walkthrough.json）；文档 5（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff、设计文档/演示数据.json）

源码有 116 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V4：43/43
- V7：55/55

## 五、稿件属性

- prototypeVersion：4 → 7

源码差异没有附在包里（116 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v4 --to v7`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
