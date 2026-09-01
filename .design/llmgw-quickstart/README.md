# 网关接入流程改版 · 设计稿源文件

用户 2026-08-28 反馈 Quickstart 第 2 步「还是很紧凑」，本目录是据此重做的版式稿。

画布（在线可看、可改、可导出 PNG/PDF）：
<https://claude.ai/code/artifact/dac088db-f60e-488b-b1e0-8119d3fa4f73>

## 落地状态

已实现（`fab3f45` 版式 + `020f697` 三处未生效声明的修复），预览域名上双主题 + 390
真实触控验收 20 条全过。稿子与实现如有出入，以实现为准、并回来改这里的源文件。

部署后验收抓到的三处「读得到却不生效」值得记住：
`.lg-qs-step-card` 少了 `display:flex`（gap 只对 flex/grid 生效，但 computed style
照样报得出 rowGap=28px）；窄屏覆盖块排在被覆盖规则之前，同特异性下被压掉；
`<button class="lg-text-link">` 没有背景重置，顶着浏览器默认按钮底渲染成灰方块。

## 目录里是什么

每个 `.dc.html` 是画布上的一个画板，`canvas.json` 定位置与分页。它们是**源文件**；
在线画布那个 2.5MB 的 `.html` 由它们 seed 得出，不进版本库（见 `../.gitignore`）。

| 文件 | 画的是 |
|---|---|
| `Main.dc.html` | 第 2 步 · 模型推导成功（主稿，改动集中在这一屏） |
| `Step1.dc.html` / `Step3.dc.html` | 第 1 步说清要做什么 / 第 3 步算谁的 |
| `Step2Streaming.dc.html` | 第 2 步 · 推导流式过程 |
| `Step2Fallback.dc.html` | 第 2 步 · 模型没给结果、两段需手选 |
| `Settings.dc.html` | 服务网关设置 |
| `Step2Light.dc.html` / `SettingsLight.dc.html` | 浅色档核对 |
| `Step2Mobile.dc.html` / `SettingsMobile.dc.html` | 390 宽 |
| `SpacingSpec.dc.html` | **改 CSS 时照这张取值**：间距尺度、第 2 步的三层、七档字号落点 |

## 改完怎么更新在线画布

```bash
cd .design/llmgw-quickstart
node "<design 技能目录>/seed-canvas.mjs" \
  --template "<design 技能目录>/payload.template.html" \
  --out llmgw-quickstart-redesign.html --title "网关接入流程改版" \
  --artboard Main.dc.html --artboard Step1.dc.html ... --canvas canvas.json
```

再用 Artifact 工具以同一路径重新发布，URL 不变。

## 落地时的硬约束

稿子里的取值不是随手拍的，逐条对着仓库现状定的：

- 颜色全部取自 `llmgw/web/src/theme.css` 的深浅两档 token，未四舍五入。
- 字号只用 `theme.css` 的七档（20/17/15/14/13/12/11）。
- 间距收敛成 **8 / 20 / 28** 三种、卡片内边距一种（桌面 24、窄屏 16）——
  `e2e/llmgw-layout-drift.mjs` 数的是**种类数**（上限取自基准页），不是大小，
  所以放大尺度不会让它变红，但**新增第四种间距会**。
