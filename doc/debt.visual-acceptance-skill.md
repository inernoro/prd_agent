# debt.visual-acceptance-skill

> 类型: debt（工程债务台账） | 状态: active | 模块: create-visual-test-to-kb 验收技能
> 创建: 2026-05-27

`create-visual-test-to-kb` 技能 2026-05-27 做了一波增强（wave 1），本文件登记当时刻意不做、留作后续的部分，避免下一次 session 无人记得。

## wave 1 已落地（2026-05-27）

- **E1 强制必给地址**：`archive_report.py` doc-store 模式归档收尾必打印「验收归档完成 · 必给地址」块——分享短链优先，接口超时拿不到则给 owner 登录路径；条目已建即视为归档成功，分享链单独 try/except，绝不静默。curl 重试 3→5、退避加长。main() 包 try/except，写库失败打印「归档失败」+ exit(3)，不抛裸栈。
- **E2 ZZ 照做风模板 + 逐步配图**：新增 `templates/zz-report.md`（全大标题、一句话一步、文字在上图在下、分支顺序讲）。`assemble()` 支持 `{{IMG:<截图name>}}` 逐步内联占位（与旧 `{{EVIDENCE}}` 集中证据二选一/并用）；`validate_inputs` + `PLACEHOLDER_PAT` 放宽接受 `{{IMG:`。标准 §6.3 写明 ZZ 九条铁律。
- **E3/E4/E7 画框 + 步骤序号**：`harness.mjs` 新增 `box`/`clearBoxes`/`stepClick`/`stepShot`。`stepClick` 在点击目标上画红框 + 序号角标 → 截「点这里」图 → 清框 → 真点击；`stepShot` 截结果图并框住变化处。让"点哪到哪""哪里变了"一目了然。已用本地样例验证红框 + 序号渲染正确。
- **命名固定结构 + 状态走标签**（用户定 2026-05-27）：标题恒为 `项目 · 模块 · 功能 · 操作方式 · 验收报告`（`--module/--feature/--type` 拼装、空段跳过），verdict（通过/不通过）不进标题、改用 `tags=[verdict_cn,type,tier]` 标记。复测翻转结论只改 tag，标题恒定可检索。config naming + standard §2.1 同步。
- **防断头报告**（实测根因 2026-05-27）：doc-store 两步归档（建条目→PUT 正文），PUT 撞 524 会留下"有标题、点开空白(暂无可预览的内容)"的空壳。修复：建条目后强制 `GET /content` 校验 `hasContent`，写不进则重写一次→仍失败自动删空壳 + 报错（main 打印「归档失败」exit 3）。standard §2.2 立为硬规则。教训：此前 5 条历史归档全是空壳（PUT 在早期 CDS 不稳时静默丢失），用户"点开看不到"才暴露。

## wave 2 待补（差异化）

- **E5 自动识别变化区画框**：当前 `stepShot` 的高亮区要调用方手传 locator。理想是操作前后 DOM diff 自动定位"新增/变化的元素"并自动画框，driver 不用手指。可借 MutationObserver 在 `stepClick` 内记录点击后新增节点，回传给下一张 `stepShot` 当默认 highlight。
- **E6 流程缩略图横条**：把一轮验收的 N 张步骤图拼成一条带序号的横向缩略图（流程总览），放报告顶部"一眼看完整个流程"。纯图像拼接（可 Playwright 起一个 canvas 页或 python PIL），不依赖外部服务。
- **E8 AI 生成 ZZ 文案**：步骤 caption / 一句话描述目前人写。可接 `ILlmGateway`（走 AppCallerRegistry 注册一条 caller）把"截图 + 操作动作"喂给 vision 模型自动产 ZZ 风一句话，人只校对。注意 CLAUDE §6 流式可视化、§0 禁 emoji。

## wave 3 待补（智力层）

- **E9/E10 AI 视觉判定 + Verdict 建议**：把 N 张截图喂 vision 模型，自动比对"预期 vs 实际"、给出每条用例 pass/fail 初判 + 整体 Verdict 草案，人只复核。能把"读图核对"从纯人工降到"AI 初筛 + 人确认"。需谨慎：AI 判定只作建议，最终 Verdict 仍由 §7 规则 + 人把关（避免假阳性放过真 bug）。
- **E11/E12 历史回归对比**：同一目标的本轮截图与上一轮归档截图做像素/结构 diff，自动标出"这次和上次哪里变了"，回归验收用。依赖归档库按 target 检索历史报告 + 取图。

## 明确不做（用户 2026-05-27 定）

- **录屏（screen recording）**：用户原话"录屏幕有点难了"。Playwright 有 `recordVideo` 能力，但产物大、入库膨胀（与"代码里不允许验收图片"的体积顾虑同源）、且分享阅读器不渲染视频。结论：不做，留此条说明缘由，未来若要做必须走外部对象存储 + 仅存链接，不进知识库正文。
- **自动把操作过程转成视角偏移 + 标注的现成开源组件**：子智能体 2026-05-27 搜过 GitHub，无 Playwright 可直接集成的"自动平移/缩放镜头 + 标注"库。最接近的 Screenize（操作录制转视频）、rrweb（会话回放）都不是 Playwright 截图链路能直接拼的（一个是独立录屏 app，一个是 DOM 事件回放 SDK）。结论：放弃找现成轮子；我们自建的 `box`/`stepClick` 红框 + 序号已覆盖"标注"这一核心诉求（"视角偏移"= 镜头跟随，属录屏范畴，随上一条一起不做）。
