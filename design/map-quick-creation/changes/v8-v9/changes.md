# 版本差异：V8 → V9

> 程序生成（version-diff.mjs），不要手改。方向：升级。只列净变化：中间版本加了又删的不出现。

## 一、验收项

- 新增 4：`A-55` 开工前就知道成片多长，也能自己定：时长和风格收在输入框里同一个按钮上（按钮写「约 3 分钟 · 视觉笔记」），面板顶部是时长，默认自动并直接写出估算值；可选约 1 / 3 / 5 / 10 分钟；面板写明依据（稿件字数、全文照念多长）、幕数和预计生成耗时；估算由服务端给出，前端不自己算；`A-56` 分镜脚本按目标时长写：每幕写秒数，顶部写合计与目标；「短一点 / 长一点」在 1–10 分钟的档位间重写这版脚本；对话里说「5 分钟」「长一点」同样生效；培训、教程类先问一次想要多长；服务端校验脚本总时长落在目标的 ±15%，不够就补写；`A-57` 服务器不渲染视频：成片是能播放的网页（画面代码 + 配音），播放与导出都在用户浏览器里；完成卡写实际时长与目标；「导出 MP4 文件」显示帧数进度、已用与还需时间、保持前台的提醒，可取消，完成后可下载；发布到网页托管发布的是能播放的网页（约几 MB），不传视频文件；`A-58` 浏览器不能本机合成时（没有 WebCodecs，或 H.264 与 VP9 都编不了）说明原因并给两条路：换电脑上的 Chrome / Edge / Safari 打开这一页，或请服务器代为导出（排队，作为兜底）
- 删除 0：无
- 改写 0：无

## 二、画面

- 新增 4：`duration-picker` 开工前定时长：「时长 · 风格」按钮的面板顶部，自动写出估算值，可选 1 / 3 / 5 / 10 分钟；`export-done` 成片导出完成，可下载；`export-progress` 成片在浏览器里导出：帧数进度与还需时间；`export-unsupported` 浏览器不能本机合成：换浏览器或请服务器导出
- 删除 0：无
- 改动 0：无

## 三、文件

- 新增 5：源码 4（src/added/pages/quick-creation-agent/BrowserExport.tsx、src/added/pages/quick-creation-agent/Duration.tsx、src/added/pages/quick-creation-agent/browserExport.ts、src/estimate.ts）；文档 1（设计文档/成片时长与浏览器渲染.md）
- 删除 0：无
- 改动 19：自检 2（checks/handoff-local.json、checks/result.json）；其他 2（design.json、versions.json）；原型 1（dist/index.html）；源码 8（src/added/pages/quick-creation-agent/BriefChat.tsx、src/added/pages/quick-creation-agent/QuickCreationAgentPage.tsx、src/added/pages/quick-creation-agent/StyleLibrary.tsx、src/added/pages/quick-creation-agent/quickCreation.css、src/added/pages/quick-creation-agent/types.ts、src/added/services/real/quickCreation.ts…）；工具 2（tools/manifest-src.mjs、tools/walkthrough.json）；文档 4（交付说明.md、思路.md、设计文档/源码差异.diff、设计文档/验收计划.md）

源码有 12 个文件变化，差异没有附在包里（见文末命令）。

## 四、自检

- V8：55/55
- V9：59/59

源码差异没有附在包里（12 个文件）。需要时运行 `node version-diff.mjs --dir <稿件目录> --from v8 --to v9`；没有 git 时，从 CDS 下载两版归档，用 --from-dir、--to-dir 比较。
