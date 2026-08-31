# 视觉创作首页改版 · 设计画布源文件

**一句话**：这里是设计画布的**源文件**，成品页（`visual-agent-home.html`，2.5MB）是构建产物，已进 `.gitignore`。
**谁该读**：要改这版设计、或要按这版设计写代码的人。
**读完能做什么**：改一版设计并重新发布，或照着画板值实现页面。

发布地址：https://claude.ai/code/artifact/21062aa3-c793-4db2-b778-b57d5b2a1c5a

## 由来

2026-08-31 用户原话：「视觉创作的页面 优点老，是否可以模仿视频创作一样，有一种神秘莫测的设计感」。

## 四张画板

| 文件 | 是什么 |
|---|---|
| `Main.dc.html` | 方向 A · 暗房。与视频创作同结构；背景潜像场用生图等待卡同一套材质（45° 织纹 + 呼吸辉光） |
| `DirectionB.dc.html` | 方向 B · 星图。项目即星，底纹用画布真实点阵 |
| `DirectionC.dc.html` | 方向 C · 工作墙。压暗的印相纸墙 + 一束慢灯 |
| `Current.dc.html` | 现状复刻，仅供对照，不是要实现的东西 |
| `canvas.json` | 画板布局 + 五张便签（含每个方向的赌注与代价） |

## 取值来源（不是自己配的色）

全部取自 `prd-admin/src/styles/tokens.css` 与 `prd-admin/src/pages/video-agent/videoConsole.css`：
底 `#141418`、抬升面 `#1e1e24`、强调色 `#D97757`、`--accent-gold-2: #E8A87C`、
正文 `#f7f7fb` / 0.80 / 0.68 三档、描边 0.08 / 0.12 / 0.18 三档、
字体 Space Grotesk（display）+ Inter（body）、圆角 6–8px、`--shadow-card: 0 2px 14px rgba(0,0,0,0.35)`。

**视频创作那种「控制台感」的来源是 9–13px 的小字号 + 小圆角 + 单一强调色**，不是任何一种背景插画。
改这版设计时别把字号放大回 14–15px，那一步就会掉回「老」。

## 怎么改

改 `.dc.html` 源文件，然后重新生成并发布到**同一个** URL：

```bash
node "<design 技能目录>/seed-canvas.mjs" \
  --template "<design 技能目录>/payload.template.html" \
  --out visual-agent-home.html --title "视觉创作首页改版" \
  --artboard Main.dc.html --artboard DirectionB.dc.html \
  --artboard DirectionC.dc.html --artboard Current.dc.html \
  --canvas canvas.json
```

不要手改 `visual-agent-home.html`——它每次都是从模板全新生成的，手改会被下一次生成覆盖。

## 已知边界

- 四张画板都是 1440 桌面宽，**没有手机断点**。
- 缩略图全是占位色块，不是真图；项目名取自用户截图里出现过的（白桃 / 梅花 / 绿帽子）。
- 画布舞台是钉死暗色的，但首页不是——落地时**浅色档要一起做**，双皮肤棘轮会拦硬编码色
  （见 `.claude/rules/admin-dual-theme.md`）。
