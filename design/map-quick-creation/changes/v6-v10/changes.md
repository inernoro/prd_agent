# 版本差异：V6 → V10

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 11：`A-49` 对话起稿：不知道选什么时可以直接说想做什么；快速创作每次只问一个它还拿不准的问题，并给几个可以直接点的回答；回复逐字出现，顶部显示这次用的模型；`A-50` 创作简报：开工条件一眼可见，必填三项（做成什么、讲什么、风格）与建议两项（给谁看、时长），聊到哪一条勾哪一条；判定由服务端结构化给出，前端不从聊天文字里猜；`A-51` 推荐风格：按目的与感觉推荐 3 个风格，每个带样片海报与一句为什么适合；点「用这个」或说「第二个」都能选定，输入框的风格按钮与右栏同步；`A-52` 准备好了：必填条件都齐了，助手复述简报并给主按钮「开始生成（约 30–60 分钟）」；直接说「可以开始了」效果一样；条件不够时说明还缺什么，不硬开始；`A-53` 开工前先看分镜脚本：每幕一句画面、一句旁白，确认后正式排队；不想看可以一键跳过；想改直接在对话里说；`A-54` 没有稿件也能只靠对话出片：讲什么来自对话，文案由快速创作按对话先写；任务里写明内容来自对话；`A-55` 开工前就知道成片多长，也能自己定：时长和风格收在输入框里同一个按钮上（按钮写「约 3 分钟 · 视觉笔记」），面板顶部是时长，默认自动并直接写出估算值；可选约 1 / 3 / 5 / 10 分钟；面板写明依据（稿件字数、全文照念多长）、幕数和预计生成耗时；估算由服务端给出，前端不自己算；`A-56` 分镜脚本按目标时长写：每幕写秒数，顶部写合计与目标；「短一点 / 长一点」在 1–10 分钟的档位间重写这版脚本；对话里说「5 分钟」「长一点」同样生效；培训、教程类先问一次想要多长；服务端校验脚本总时长落在目标的 ±15%，不够就补写；`A-57` 服务器不渲染视频：成片是能播放的网页（画面代码 + 配音），播放与导出都在用户浏览器里；完成卡写实际时长与目标；「导出 MP4 文件」显示帧数进度、已用与还需时间、保持前台的提醒，可取消，完成后可下载；发布到网页托管发布的是能播放的网页（约几 MB），不传视频文件；`A-58` 浏览器不能本机合成时（没有 WebCodecs，或 H.264 与 VP9 都编不了）说明原因并给两条路：换电脑上的 Chrome / Edge / Safari 打开这一页，或请服务器代为导出（排队，作为兜底）；`A-59` 先试看再做完：3 分钟及以上默认先只做片头和第 1 幕（带配音），约占整片一成的时间；做好后在右边播放，满意就从断点接着做完（试看的两幕沿用），不满意回去换风格或改要求；等确认时任务暂停、不占排队名额；时长与风格面板和分镜脚本卡都能开关
- 删除 0：无
- 改写 13：`A-05`（expected）；`A-11`（rule、expected）；`A-12`（rule、expected）；`A-16`（rule、expected）；`A-19`（rule、expected）；`A-21`（rule、expected）；`A-35`（rule、expected）；`A-39`（rule、expected）；`A-43`（rule、expected）；`A-44`（rule、expected）；`A-45`（rule）；`A-47`（rule、expected）；`A-48`（rule、expected）

## 二、画面

- 新增 12：`chat-ready` 对话起稿：条件齐了，准备好了；`chat-recommend` 对话起稿：按「科技感」推荐 3 个风格；`chat-script` 对话起稿：开工前确认分镜脚本；`chat-start` 对话起稿：不知道选什么，直接说想做宣传片；`duration-picker` 开工前定时长：「做成什么」按钮的面板里，自动写出估算值，可选 1 / 3 / 5 / 10 分钟；`export-done` 成片导出完成，可下载；`export-progress` 成片在浏览器里导出：帧数进度与还需时间；`export-unsupported` 浏览器不能本机合成：换浏览器或请服务器导出；`phone-chat` 手机 · 对话起稿与推荐风格；`phone-plus` 手机 · 输入框左下的「+」：上传与知识库；`phone-style` 手机 · 「做成什么」按钮：产出、时长与先试看；`trial-ready` 试看好了：先看片头和第 1 幕，满意再做完
- 删除 0：无
- 改动 5：`assets`（name、entryActions）；`assets-team`（name、entryActions）；`compose-web`（entryActions）；`phone-assets`（name、entryActions）；`phone-compose`（entryActions）

## 三、文件

- 新增 8：源码 7（src/added/pages/quick-creation-agent/BriefChat.tsx、src/added/pages/quick-creation-agent/BrowserExport.tsx、src/added/pages/quick-creation-agent/Duration.tsx、src/added/pages/quick-creation-agent/Landing.tsx、src/added/pages/quick-creation-agent/browserExport.ts、src/briefEngine.ts…）；文档 1（设计文档/成片时长与浏览器渲染.md）
- 删除 0：无
- 改动 25：自检 2（checks/handoff-local.json、checks/result.json）；其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 10（src/added/pages/quick-creation-agent/Conversation.tsx、src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/ResultPanel.tsx、src/added/pages/quick-creation-agent/RunProgress.tsx、src/added/pages/quick-creation-agent/StyleLibrary.tsx、src/added/pages/quick-creation-agent/quickCreation.css…）；工具 4（tools/handoff-local.mjs、tools/manifest-src.mjs、tools/self-check.mjs、tools/walkthrough.json）；文档 6（交付说明.md、交接清单.md、思路.md、设计文档/源码差异.diff、设计文档/演示数据.json、设计文档/验收计划.md）

源码有 17 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V6：49/49
- V10：60/60

## 五、稿件属性

- prototypeVersion：6 → 7

源码差异没有附在包里（17 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v6 --to v10`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
