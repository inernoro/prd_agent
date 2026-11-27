# 版本差异：V6 → V7

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 6：`A-49` 对话起稿：不知道选什么时可以直接说想做什么；快速创作每次只问一个它还拿不准的问题，并给几个可以直接点的回答；回复逐字出现，顶部显示这次用的模型；`A-50` 创作简报：开工条件一眼可见，必填三项（做成什么、讲什么、风格）与建议两项（给谁看、时长），聊到哪一条勾哪一条；判定由服务端结构化给出，前端不从聊天文字里猜；`A-51` 推荐风格：按目的与感觉推荐 3 个风格，每个带样片海报与一句为什么适合；点「用这个」或说「第二个」都能选定，输入框的风格按钮与右栏同步；`A-52` 准备好了：必填条件都齐了，助手复述简报并给主按钮「开始生成（约 30–60 分钟）」；直接说「可以开始了」效果一样；条件不够时说明还缺什么，不硬开始；`A-53` 开工前先看分镜脚本：每幕一句画面、一句旁白，确认后正式排队；不想看可以一键跳过；想改直接在对话里说；`A-54` 没有稿件也能只靠对话出片：讲什么来自对话，文案由快速创作按对话先写；任务里写明内容来自对话
- 删除 0：无
- 改写 0：无

## 二、画面

- 新增 5：`chat-ready` 对话起稿：条件齐了，准备好了；`chat-recommend` 对话起稿：按「科技感」推荐 3 个风格；`chat-script` 对话起稿：开工前确认分镜脚本；`chat-start` 对话起稿：不知道选什么，直接说想做宣传片；`phone-chat` 手机 · 对话起稿与推荐风格
- 删除 0：无
- 改动 0：无

## 三、文件

- 新增 2：源码 2（src/added/pages/quick-creation-agent/BriefChat.tsx、src/briefEngine.ts）
- 删除 0：无
- 改动 17：自检 2（checks/handoff-local.json、checks/result.json）；其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 4（src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/types.ts、src/added/services/real/quickCreation.ts、src/env.ts）；工具 3（tools/handoff-local.mjs、tools/manifest-src.mjs、tools/walkthrough.json）；文档 5（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff、设计文档/验收计划.md）

源码有 6 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V6：49/49
- V7：55/55

## 五、稿件属性

- prototypeVersion：6 → 7

源码差异没有附在包里（6 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v6 --to v7`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
