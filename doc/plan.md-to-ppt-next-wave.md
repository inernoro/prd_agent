# plan.md-to-ppt-next-wave — MD 转 PPT 下一波（大纲右侧编辑器 + 状态机 + 澄清问卷）

> 状态：待执行 | 来源：用户 2026-06-10 晚 11 条反馈中的大件（#4/#5/#6/#9/#10/#11）
> 上下文：同日已落地的快修与大功能见 changelogs/2026-06-10_md-to-ppt-engine-stream-theme.md。
> 本计划是下个会话可直接照做的执行清单；借鉴库：https://github.com/nexu-io/open-design.git
> （用户明示可借鉴以减少措辞往返，clone 后重点看其大纲编辑器与 clarify 问卷交互）。

## 1. 大纲右侧编辑器（用户原话：调整大纲也在右侧，可自己编辑也可让 AI 改，视角更大）

- 大纲生成后，右侧从模板画廊切换为「大纲编辑器」状态：每页一张可编辑卡
  （标题 input + bullets textarea，可增删页、拖拽排序），编辑**即时生效**到状态。
- 左侧对话保留大纲摘要气泡 + 「确认，生成 PPT」；右侧顶部同样有确认按钮。
- 「让 AI 改」：右侧编辑器底部一条指令输入（或沿用左侧对话），AI 改完回填右侧。

## 2. 状态机 + 刷新中间态（用户原话：不点击继续就停留在这个状态，刷新也在）

当前缺口：outline 状态只活在 sessionStorage 的 messages 里，右侧大纲编辑器引入后
必须把「工作流状态」显式建模并服务端持久化。

- 新模型 MdToPptSession（或扩展 MdToPptRun）：{ stage: outlining|outline-ready|
  clarifying|generating|done, outline JSON, clarifyAnswers JSON, templateId, theme }。
- 阶段流转：发需求 → outline-ready（右侧编辑器，可停留任意久，刷新恢复）→
  确认 → generating → done。每次编辑 debounce PUT 服务端。
- 页面 mount：先拉服务端 session 状态恢复右侧视图（server-authority，sessionStorage
  只做加速缓存）。生成中刷新已可经 runs 恢复（已有），补 outline 阶段即可闭环。

## 3. 澄清问卷（opendesign 式，减少歧义）

- 大纲接口扩展：模型可返回 clarifyQuestions: [{id, question, type: single|multi|text,
  options[]}]（仅当确有歧义，提示词约束最多 3 题）。
- 右侧大纲编辑器顶部渲染问卷卡（单选/多选/填空），「保存」落 session.clarifyAnswers，
  左侧出现「发送给 AI」按钮把答案并入调整指令。无歧义则不出问卷。

## 4. 调整大纲页数守护（快修已做，留验证项）

- 已修：adjustOutline 沿用上一版 totalPages + 指令注入「除非明确要求否则页数不变」。
- 待验证：连续两次调整、调整时明确要求加页/减页两条用例。

## 5. 编辑模式深修（#10：部分内容不可改、A+/A- 异常）

- 快修已做：可编辑 SEL 扩展 .stat/.stat-l/.lead/.eyebrow/.chip/.quote。
- 待查：A+/A- 对 clamp() 字号的体感问题（computed px 覆盖后失去响应式，缩放窗口
  会跳变）；toolbar 遮挡首行元素时的定位；td/th 编辑后表格布局抖动。
  复现路径：编辑模式点 .stat 大数字 → A+ ×3 → 缩放窗口观察。

## 6. 套图背景（#9，用户：不好做就搁置）

- 搁置。若做：生图管线（visual-agent）按模板风格批量产 3-5 张背景图供选择，
  与 deck CSS 的 .orb/底纹替换联动。先不动。

## 7. 视觉验收归档（上轮时间不够的尾巴）

- 证据已齐：/tmp/ppt-accept/r3/（9 图 + results.json，三轮 19 项断言 18 过）。
  注意 tmp 会话结束即失，归档需重跑 driver3（脚本思路在会话记录里）。
- 跑 create-visual-test-to-kb 全流水线归档（archive_report.py，verdict=conditional，
  缺陷清单：乱码时代旧 run 黑屏边界 + sidecar 增量未上线前思考期文案兜底）。

## 8. 上线前置依赖（再次强调）

- claude-sdk-sidecar 的 include_partial_messages 修复（e8cc003）合并 main +
  sidecar 实例重启后，思考流/逐页实况才真正在线上活起来——本计划 1-3 的体验
  都建立在真流式之上，应最先落地。

## 9. 用户模板共享走海鲜市场（2026-06-11 用户提案：做得不错的模板可以拿来）

复用既有 Marketplace 基建（`.claude/rules/marketplace.md`），不另造轮子：

- 后端：`MdToPptTemplate` 实现 `IForkable`。
  - `GetCopyableFields()` 白名单：Name / StyleSpec / BgColor / AccentColor
    （ExtractModel / UserId / CreatedAt 不复制，OnForked 重置归属与时间）。
  - 加 `IMarketplaceItem` 公共字段（IsPublic / ForkCount / 描述），
    publish / fork 端点挂在 MdToPptController 或独立 marketplace 路由。
- 前端：`marketplaceTypes.tsx` 的 `CONFIG_TYPE_REGISTRY` 注册新类型
  `pptTemplate`（label「PPT 模板」，数据源 `md_to_ppt_templates`），
  PreviewRenderer 直接复用画廊迷你幻灯卡（bgColor + accentColor + styleSpec 摘要）。
- 画廊加第三个分组「市场精选」：列出已公开模板，一键 fork 进自己的自定义模板。
- 验收口径：A 用户上传参考图建模板并公开 → B 用户海鲜市场看到并 fork →
  B 的画廊出现该模板且能用它生成（styleSpec 生效）。

## 10. 官方模板持续扩容（2026-06-11 已扩到 10 套，后续节奏）

- 已落地 10 套（tech-dark / cobalt-grid / editorial-ink / warm-zine /
  swiss-minimal / aurora-gradient / sunset-bold / forest-organic /
  royal-velvet / ocean-glass），前后端 value 一一对应
  （后端 ThemeTokens switch + 前端 THEME_OPTIONS）。
- 后续每加一套的清单：后端 ThemeTokens case（:root token + tone 描述）→
  前端 THEME_OPTIONS（label/desc/dotBg/dotRing/preview 迷你幻灯参数）→
  画廊自动出卡，工具栏自动出色点，无需其他改动。
- 参照业界（Gamma/Pitch/Beautiful.ai）的风格族谱继续补：玻璃拟态亮色系、
  暗色弥散光、报刊双栏、手绘标注风等候选。
