# debt.visual-acceptance-skill

> 类型: debt（工程债务台账） | 状态: active | 模块: create-visual-test-to-kb 验收技能
> 创建: 2026-05-27

`create-visual-test-to-kb` 技能 2026-05-27 做了一波增强（wave 1），本文件登记当时刻意不做、留作后续的部分，避免下一次 session 无人记得。

## wave 1 已落地（2026-05-27）

- **E1 强制必给地址**：`archive_report.py` doc-store 模式归档收尾必打印「验收归档完成 · 必给地址」块——分享短链优先，接口超时拿不到则给 owner 登录路径；条目已建即视为归档成功，分享链单独 try/except，绝不静默。curl 重试 3→5、退避加长。main() 包 try/except，写库失败打印「归档失败」+ exit(3)，不抛裸栈。
- **E2 ZZ 照做风模板 + 逐步配图**：新增 `templates/zz-report.md`（全大标题、一句话一步、文字在上图在下、分支顺序讲）。`assemble()` 支持 `{{IMG:<截图name>}}` 逐步内联占位（与旧 `{{EVIDENCE}}` 集中证据二选一/并用）；`validate_inputs` + `PLACEHOLDER_PAT` 放宽接受 `{{IMG:`。标准 §6.3 写明 ZZ 九条铁律。
- **E3/E4/E7 画框 + 步骤序号**：`harness.mjs` 新增 `box`/`clearBoxes`/`stepClick`/`stepShot`。`stepClick` 在点击目标上画红框 + 序号角标 → 截「点这里」图 → 清框 → 真点击；`stepShot` 截结果图并框住变化处。让"点哪到哪""哪里变了"一目了然。已用本地样例验证红框 + 序号渲染正确。
- **命名固定结构 + 状态走标签**（用户定 2026-05-27）：标题恒为 `项目 · 模块 · 功能 · 操作方式 · 验收报告`（`--module/--feature/--type` 拼装、空段跳过），verdict（通过/不通过）不进标题、改用 `tags=[verdict_cn,type,tier]` 标记。复测翻转结论只改 tag，标题恒定可检索。config naming + standard §2.1 同步。
- **防断头报告**（实测根因 2026-05-27）：doc-store 两步归档（建条目→PUT 正文），PUT 撞 524 会留下"有标题、点开空白(暂无可预览的内容)"的空壳。修复：建条目后强制 `GET /content` 校验 `hasContent`，PUT 抛错（curl 重试耗尽）或返回了但没落库都先复查、再写一次→仍失败自动删空壳 + 报错（main 打印「归档失败」exit 3）。standard §2.2 立为硬规则。教训：此前 5 条历史归档全是空壳（PUT 在早期 CDS 不稳时静默丢失），用户"点开看不到"才暴露。注：524 多是网关丢了**响应**，写入其实可能已落库——故校验以 `hasContent` 为准，不以 PUT 返回为准。
- **分享 URL 路由修正**（实测 2026-05-27）：脚本原拼 `/library/share/{token}`——该路由在 App.tsx **不存在**，会落到营销首页（用户以为没分享）。正确路由是 `/s/lib/{token}`（`LibraryShareViewPage`），实测能渲染书册目录 + 正文 + 4 张内联截图，可直接当"点开即看"交付。SKILL.md「分享给登出第三方」旧称"只渲染目录不渲染正文"的缺陷描述同步更正（新页面已能渲染正文）。
- **殿堂≠分享 概念订正**（用户强调 2026-05-27）：殿堂(发布到殿堂)=`isPublic=true`→进 `/public/stores`→**对所有人**公开浏览；分享(共享给别人)=`/s/lib/{token}`→**对部分人**(持链接者)，token 独立授权，**库私有也能看**(已实测：库 isPublic=false 时分享链仍渲染正文+4图)。二者正交，绝不能拿"设 public 进殿堂"冒充"分享给某人"。修复：(A 数据)把「验收报告」库 `isPublic` 从误设的 true 改回 false→退出殿堂，分享链仍可用；(B) SKILL.md 交付段重写为三路径(分享链/owner自看/殿堂)并删掉"设 public 走殿堂当分享"错误兜底；(C) archive_report.py 复用库时校验 isPublic 与 config 不符则告警，必给地址默认给分享链+owner、殿堂不作默认；(D) standard §8.5 立术语区分。教训：该库被早期 session 误设公开，验收报告一度对所有人可见，是可见性漂移。

- **归档后自查能否打开**（用户要求 2026-05-27「创建之后要能打开」）：新增 `scripts/verify-open.mjs`——headless 打开分享链断言报告真渲染(标题 + 正文 + 截图)，exit 0=能看、exit 2=空/打不开→重新推送验收。SKILL.md 工作流第 5 步定为强制：归档后必跑，杜绝"建了条目但点开空白"流到用户手里。全链路复验已实测：脚本归档(写正文 success + hasContent 校验) → 分享链 → verify-open(必现文字命中 + 4 图齐 + 无死页 exit 0) 全绿。历史 2 条空壳(旧MECE + SaaS)已删除，库内仅剩有内容条目。

## wave v1.0 已落地（2026-06-04，固化自元 issue #605 三位执行 Agent 反馈）

harness `scripts/harness.mjs` 实装、本地自测 10/10 通过（local http 造 console.error + 500 + 未捕获异常 + 撑破 modal + dark-only 页，断言全部命中）：

- **运行时错误自动捕获**（issue #605 二.2，"机器最该补、人最易漏"）：`attachAutoCapture`，`launch()` 默认装。pageerror→P0、同源 5xx→P0、console.error→P1、同源 4xx→P1、requestfailed→P1。判级保守去噪：只计同源（app 自己 host），跨域第三方不计；401/403/404 跳过；主动 abort 跳过；`ignore` 正则白名单。`blockSeverity`（默认 P0）：≥此级别的 finding 自动折叠进"截图那一刻"的 warnings → `archive_report.py` 准入（§3.5 第 4 项）直接拒收，把机器抓到的严重运行时错误变成硬门禁。P1 记 result.json 不硬阻断。
- **机读 result.json**（issue #605 二.3）：`writeManifest(outDir, extra)` 除 manifest.json（契约不变）外同写 result.json = `{verdict,target,themeSupport,timing,shots,autoFindings,autoFindingsSummary}`，下游 Agent 直接消费不解析 markdown。
- **dark-only 双主题伪命令消除**（issue #605 二.2）：`detectThemeSupport` 切 dark/light 采样 body 背景亮度，差 < 24 判 dark-only，driver 据此单图 + 注明，不计 fail。
- **导航 timing**（issue #605 二.5）：`captureTiming`，呼应 CLAUDE §6。
- **过程视频**（issue #605 二.1）：见下方"录屏决定重审"。
- 标准同步：`reference/standard-v2.md` §5.3/5.4/5.5 + header；离线镜像 `doc/rule.issues-system.md` §5 bump v1.0。

### 录屏决定重审（2026-06-04）

2026-05-27 用户原话"录屏幕有点难了"判"明确不做"，顾虑是**体积大 + 阅读器不渲染 + 进知识库正文膨胀**，但当时也留口"未来若要做必须走外部对象存储 + 仅存链接，不进知识库正文"。issue #605 二.1 执行 Agent 复提视频为最高 ROI。**调和方案（不违背原决定）**：`launch(cfg,{recordVideoDir})` + `finalizeVideo()` 产 `walkthrough.webm` 作**默认关闭的本地可选附件**，**绝不自动上传知识库正文**——完全落在原决定的"未来若要做"caveat 内。需长期托管仍走外部对象存储仅存链接。

## wave 2 待补（差异化）

- **E5 自动识别变化区画框**：当前 `stepShot` 的高亮区要调用方手传 locator。理想是操作前后 DOM diff 自动定位"新增/变化的元素"并自动画框，driver 不用手指。可借 MutationObserver 在 `stepClick` 内记录点击后新增节点，回传给下一张 `stepShot` 当默认 highlight。
- **E6 流程缩略图横条**：把一轮验收的 N 张步骤图拼成一条带序号的横向缩略图（流程总览），放报告顶部"一眼看完整个流程"。纯图像拼接（可 Playwright 起一个 canvas 页或 python PIL），不依赖外部服务。
- **E8 AI 生成 ZZ 文案**：步骤 caption / 一句话描述目前人写。可接 `ILlmGateway`（走 AppCallerRegistry 注册一条 caller）把"截图 + 操作动作"喂给 vision 模型自动产 ZZ 风一句话，人只校对。注意 CLAUDE §6 流式可视化、§0 禁 emoji。

## wave 3 待补（智力层）

- **E9/E10 AI 视觉判定 + Verdict 建议**：把 N 张截图喂 vision 模型，自动比对"预期 vs 实际"、给出每条用例 pass/fail 初判 + 整体 Verdict 草案，人只复核。能把"读图核对"从纯人工降到"AI 初筛 + 人确认"。需谨慎：AI 判定只作建议，最终 Verdict 仍由 §7 规则 + 人把关（避免假阳性放过真 bug）。
- **E11/E12 历史回归对比**：同一目标的本轮截图与上一轮归档截图做像素/结构 diff，自动标出"这次和上次哪里变了"，回归验收用。依赖归档库按 target 检索历史报告 + 取图。

## 明确不做（用户 2026-05-27 定）

- **录屏（screen recording）**：用户原话"录屏幕有点难了"。Playwright 有 `recordVideo` 能力，但产物大、入库膨胀（与"代码里不允许验收图片"的体积顾虑同源）、且分享阅读器不渲染视频。结论：不做，留此条说明缘由，未来若要做必须走外部对象存储 + 仅存链接，不进知识库正文。**（2026-06-04 重审：已按此 caveat 落地为"默认关闭的本地可选附件，不进知识库正文"，见上方 wave v1.0「录屏决定重审」。原顾虑未被违背。）**
- **自动把操作过程转成视角偏移 + 标注的现成开源组件**：子智能体 2026-05-27 搜过 GitHub，无 Playwright 可直接集成的"自动平移/缩放镜头 + 标注"库。最接近的 Screenize（操作录制转视频）、rrweb（会话回放）都不是 Playwright 截图链路能直接拼的（一个是独立录屏 app，一个是 DOM 事件回放 SDK）。结论：放弃找现成轮子；我们自建的 `box`/`stepClick` 红框 + 序号已覆盖"标注"这一核心诉求（"视角偏移"= 镜头跟随，属录屏范畴，随上一条一起不做）。
