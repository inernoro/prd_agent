---
name: create-visual-test-to-kb
description: 工业级功能验收/视觉测试全流水线（MAP 验收标准 v2）——模拟人类的浏览器取证 + 标准化验收报告 + 归档进知识库并出分享链。一个技能内含三段：标准/模板、模拟人类浏览器取证（点击导航进入、禁地址栏直达、双主题截图、ZZ 照做风画框标序号 stepClick/stepShot）、报告归档（命名 状态前置，根治目录 `---`，**每次归档强制输出可达地址**：分享短链优先、拿不到则给 owner 登录路径）。默认报告走 **ZZ 照做风**（全大标题 + 一句话一步 + 逐步配图 `{{IMG:}}` + 文字在上图在下 + 变化处画框 + 分支顺序讲，同岗位照做必复现）。归档前有**强制准入校验**：目标/档位/Verdict/截图数/证据完整性/报告结构不达标直接拒收（入口准则，杜绝"什么都能进"）。项目无关，改 acceptance.config.json 即可跨仓库复用；无文档空间的仓库退化为本地 md+截图。触发词："视觉验收"、"验收"、"视觉测试"、"验收归档"、"归档验收报告"、"create visual test"、"/视觉验收"、"/验收"。
---

# 验收归档 v2 — 工业级功能验收全流水线

> 一条不可分的流水线:**标准定义测什么/怎么截/怎么命名 → 模拟人类浏览器取证 → 证据落库出分享链**。
> 主纲在此,完整规则按需加载(见下"按需文件")。**先读 `reference/standard-v2.md`**——那是下限基线,不是参考是必读。

## 何时用

- 一个功能/PR 开发完成,需要可查收、可追溯、结构化的验收报告(替代塞 PR 评论 / 塞 HTML 进 doc/)。
- AI 自测完(CLAUDE #8.1)后,以**真人路径**复验并归档结论 + 证据。

## 前置依赖（接入即查,缺一不可)

| 依赖 | 用途 | 怎么装/拿 |
|------|------|----------|
| **Playwright + Chromium** | harness 跑无头浏览器取证 | `npm i -g playwright && npx playwright install chromium`;运行时设 `PWPATH=$(npm root -g)/playwright` |
| **Python 3** | 跑 `archive_report.py` | 系统自带 |
| **登录凭据 env** | harness 表单登录 | `MAP_AI_USER`(用户名)、`MAP_ACCEPT_PASS`(密码)。**禁止写进文件**,运行时 export |
| **归档密钥 env**(仅 doc-store 模式) | 落库鉴权 | `AI_ACCESS_KEY`(AI 超级密钥)、`MAP_AI_USER`(impersonate 谁) |
| **cdscli**(可选) | 自动取预览域名 | 仓库内 `.claude/skills/cds/cli/cdscli.py`;没有就在 config 填 `previewUrlOverride` |

`report.mode=local` 时**只需 Playwright + Python**,不需要任何密钥/网络——报告写本机临时目录,默认 `/tmp/map-acceptance-local`。不得写入仓库内 `doc/acceptance/`。

接入新仓库:见文末"跨仓库复用",改 `acceptance.config.json` 一处即可。

## 三个核心规矩(v2 相对 v1 的升级,违反即不合格)

1. **模拟人类,禁地址栏直达**:登录后用 `gotoByClick(可见文本)` 点击导航进入目标页,`page.goto` 只许用于登录页。**从导航点不到目标页 = P1 缺陷**(功能做了但用户找不到/没进菜单)——这是 goto 直达永远测不出的真问题。
2. **人类可读优先**:报告首屏是"验收速览卡"(Verdict + 一句话结论 + 元信息表),不是 YAML。
3. **命名 + 防 `---`**:报告名业界状态前置 `[{verdict_cn}] {目标} · 验收报告 · {项目} · {日期}`;正文必须以 `# 标题` 打头(目录显示名取 summary 首行,见标准 §2.1)。`archive_report.py` 已内置,手工归档也照此。
4. **准入门槛(入口准则)**:归档前强制校验——目标有意义、档位/Verdict 合法、截图数达档位下限、证据完整、报告结构齐、无半成品残留;**任一不达标直接拒收、不写库**(见标准 §3.5)。输入不对,输出不可能对。
5. **证据文件不进代码库**:截图、录屏、临时 HTML、manifest、报告草稿等验收产物必须写到 `/tmp`、系统临时目录、对象存储或知识库,**禁止落到 git 仓库目录内**。默认配置已把 `screenshot.outDir` 与 `report.localOutDir` 指向 `/tmp`;`harness.mjs` 和 `archive_report.py` 会拒绝仓库内截图路径。归档前必须看一眼 `git status --short`,发现 `*.png/*.jpg/*.jpeg/*.webp/*.gif/*.mp4/*.webm` 或 `doc/acceptance/`、`acceptance-*`、`peer-sync-effect-*.html` 这类验收产物在仓库内,先移到 `/tmp` 或删除,不得提交。

## 取证选材与标注（重点,2026-05-31 强化）

> 用户反复反馈的体验缺陷:截了一堆图,但读者**不知道这部分在验证什么**。本节是硬要求。

### A. 框选重要的东西(不是全截,也不是只截一张)

- **框选**:覆盖本次验收里**所有"用户能直接看到的重要变化"**——核心页面、关键交互、新增入口、状态切换。不要只截一个首页就交差。
- **但只截重要的**:跳过纯后端 / 纯配置 / 无视觉变化的改动;不为凑数截无关页面。
- **判定**:"用户会因为这个变化而感知到差异" → 必须有图;"用户看不见" → 不截,但在报告里用文字说明已验证。
- 多功能验收时,**每个重要功能至少一张结果图**,关键交互补"点这里"步骤图(stepClick)。

### B. 每张截图必须标注"验证了什么"(caption 硬约束)

- caption 格式:**`{功能/区域}：{这张图证明了什么}`**。
- ✅ 正确:`AI 大事双栏布局：feed 居左 + 右侧栏填充,宽屏无大片留白`
- ✅ 正确:`网页托管评论：右下角浮动按钮点击后滑出评论抽屉`
- ❌ 错误:`首页截图` / `AI 大事` / `截图1`(只说在哪/是什么,不说验证了什么——读者只能靠猜)
- **harness 的 `shot/stepShot/stepClick` 的 caption 参数即此用途**;`writeManifest` 落进 manifest 的 `caption` 字段会原样进报告图注。**caption 为空或只有功能名 → 视为证据不合格**(准入校验 §3.5 已对空 caption 拒收,本节进一步要求"必须含验证点")。

### B2. 框选重点是硬要求（caption 文字在图外,读者不知道看哪——必须在图上画框）

> 历史教训(2026-06-04):给用户发"证据图"、"手机端改造前后"等截图,只配了文字 caption、**没在图上框出重点**,用户反馈「我甚至都不知道你指的是哪些」。caption 在图的外面,读者的眼睛在图里面——**文字说不清"看这里"**。

- **任何"指向具体元素/区域/差异/问题"的截图,必须在图上画标记 + 一句标签**(harness `box(page,locator,label,{shape})` / `stepShot(...,highlight,{shape})` / `stepClick(...)`)。标记 + 序号/短标签直接压在目标上,读者一眼定位。
- **形状选择(2026-06-05 起)**:指向**单个**按钮/输入框/图标/pill → 用**圈圈** `shape:'circle'`(更友好、更像人手画的指向,治"看到一个单独页面就懵逼");框**一片区域/差异/列表** → 用**方框**(默认)。`annotate.mjs` 的 box 项加 `"shape":"circle"`,harness `box(page,loc,label,{shape:'circle'})`,`stepClick` 默认已是圈圈。
- **标签必须答"看这里:是什么"**:caption/标签写成「看这里:右上角『本页教程』入口」这种**指路 + 命名**句式,而不是只写功能名。读者顺着圈 + 这句话就懂这张图在证明什么,不用猜。
- **同一张图里有多个有先后关系的操作/状态时,必须用数字标顺序**:标签写成 `① 生成连接串`、`② 复制连接串`、`③ 粘贴对端连接串`、`④ 添加按钮禁用/可点` 这种形式。禁止只写「串」「复制」「禁用」「表单」这类无序语义标签,除非这些重点确实可以无序阅读。判定标准:读者如果需要知道"先做哪个、后看哪个",就必须编号。
- **唯一豁免**:纯"整体观感/全局布局"的 overview 图(就是要看整体,无单一重点)可不画标记,但 caption 要写明"看整体布局,无单点"。
- **本规则不限于全流程验收 driver**——**任何发给用户的截图都适用**,包括:临时诊断、方案评估、critique、改造前后对比。哪怕只是一次性 `page.screenshot()`,也要**先注入带标签的红框再截**。**最省事的做法:直接用 `scripts/annotate.mjs`** —— 一条命令对任意页面按 selector/坐标画框 + 标签再截图,不用写整个 driver(支持 `--login` 表单登录、`--mobile` 手机视口、`--click` 截图前先点开某元素)。也可 `import { box, clearBoxes } from harness.mjs` 脱离 driver 单独用。
- **多个重点画多个框 + 编号**(①②③),标签用不同颜色区分维度(如 红=错误/问题、橙=冗余、蓝=缺失)。框要框在"我这句话说的那个东西"上,不能泛框一大片。**同页多步骤截图没有数字顺序 = 不合格**,需要返工截图或把该图拆成多张 stepClick/stepShot。
- 判定:**把这张图单独发给一个没听我解释的人,他能不能 3 秒看出"重点在哪、这框说的是什么"?** 不能 → 没框/框错,返工。
- **这是硬门禁,不是自觉(2026-06-05 起,治"技能这么多次给没标注的截图")**:`harness.shot()` 在截图瞬间自动探测页面有没有标记(`.__acc_box`),把 `annotated` 落进 `manifest.json`;`archive_report.py` 准入对 `annotated:false && !overview` 的图**直接拒收**——**没画框/圈的指向性证据图,报告归档不进去**。所以:
  - 用 `stepClick` / `stepShot(...,highlight)` / 截图前先 `box(page,loc,label,{shape})` —— 它们都会留下 `.__acc_box`,自动算"已标注"。
  - **唯一豁免**:纯整体观感/全局布局图,`shot(page,out,name,cap,{overview:true})` 显式标 overview,门禁放行(对应"当然没必要的除外")。
  - 直接 `page.screenshot()` 不进 manifest、不受门禁保护,**禁止**用它出证据图;一次性发图也走 `annotate.mjs`(它本就带框/圈)。

### C. 报告里图文对应,不留疑问

- 每张图在正文里**紧跟它所验证的那段文字**(ZZ 照做风:文字在上、图在下、`{{IMG:<name>}}` 占位)。
- 某个重要功能**没截到图**时,必须显式写「本功能未取截图,原因:……」,不留空白让读者怀疑是漏测还是没做。

## 自动选模板（AI 自决，告知用户；歧义才问）

技能本身按规则自动决定用哪套模板（v2.1 起），**不让用户每次都选**。AI 调用本技能时按下表判定，并在第一句话告诉用户「本次用 X 模板，理由 Y」：

| 信号 | 选模板 | 理由 |
|---|---|---|
| 单一功能/单页/单模块；流程线性（点A→点B→看结果） | **ZZ 照做风**（默认） | 步骤化叙事让"同岗位照做能复现"，对线性交互最直观 |
| L0 / L1 档位；用户提了具体场景化诉求 | **ZZ 照做风** | 步骤序号天然映射诉求条目，便于一一对应 |
| 跨模块/跨端（后端+前端+桌面）；L2 档位 | **九段集中证据** | DoD/自测路径/硬约束/缺陷分段更适合复杂证据 |
| 安全/性能/合规重点；用例非线性需要 ISO 25010 维度分类 | **九段集中证据** | 用例表带 Phase + 维度列，集中证据段适合截图+日志混排 |
| 单纯回归测试，不引入新行为 | **九段精简版**（删 5.5 节，保留其他） | 用户没提新需求 → 不需要"需求一一对应表" |
| 信号矛盾（如 L2 但单页、或多端但单一诉求） | **问用户**（仅此场景才问） | 用 AskUserQuestion 给两个选项 + 推荐项 |

**实操**：AI 在 driver 写完截图后、归档前，按上表挑模板，并在交付消息里第一段写：

> 本次验收用「ZZ 照做风」模板。理由：单页交互 + 用户提了 10 条线性诉求，步骤号天然对齐诉求表。

歧义场景才走 AskUserQuestion。**禁止"凭感觉随便选"或"两套都跑一遍"**。

## 工作流(四步)

1. **定标准与档位 + 选模板**:读 `reference/standard-v2.md`,按改动定 L0/L1/L2(下限见 §3);按上表「自动选模板」决定 zz-report.md / report-template.md(歧义才问用户)。
2. **写 driver 取证**:用 `scripts/harness.mjs` 的 helper 写本次验收的真人路径脚本。基础 helper:`launch/login/gotoByClick/click/type/setTheme/shot`。**ZZ 照做 helper(画框 + 步骤序号,默认用)**:`stepClick(page,outDir,N,locator,name,caption)` 在点击目标上画红框 + 标序号 → 截"点这里"图 → 清框 → 真点击;`stepShot(page,outDir,N,name,caption,highlight?)` 截结果图并框住变化处;`box/clearBoxes` 手动画框。跨用户前置(如造分享链)走 API。结束 `writeManifest(outDir, {verdict,target,themeSupport,timing})`。
   - **v1.0 自动捕获(默认开,零配置)**:`launch()` 已默认挂 `attachAutoCapture`——取证全程自动收集 console.error / 同源 4xx-5xx / 未捕获异常(标准 §5.3),P0 级(未捕获异常 + 5xx)自动折叠进截图 warnings → 准入直接拒收。这是"人眼扫静态图永远漏"的维度,机器替你盯。
   - **v1.0 双主题**:先 `detectThemeSupport(page,cfg)` 探测本页是否真支持 light(标准 §5.4);`supportsLight=true` 才双主题各一张,dark-only 页单图 + 注明不计 fail。别交两张一模一样的暗图。
   - **v1.0 机读产物**:`writeManifest` 同时写 `result.json`(verdict/autoFindings/themeSupport/timing),供下游 Agent 直接消费。
   - **v1.0 过程视频(可选)**:`launch(cfg,{recordVideoDir:OUT})` + 收尾 `finalizeVideo(page,ctx,OUT)`,产 `walkthrough.webm` 作**本地证据,不进知识库正文**(沿用用户决定,见 `debt.visual-acceptance-skill.md`)。
   运行:`PWPATH=$(npm root -g)/playwright node <driver>.mjs`(无 playwright 先 `npm i -g playwright && npx playwright install chromium`)。
3. **读图核对（全量,不许抽查)**:manifest 里**每一张**截图都用 Read 工具读回,肉眼级核对 caption 与图内容一致(这套抓到过"匿名未登录""按钮没渲染"等真 bug)。图文不符 → 修 driver 重拍,**禁止改 caption 迁就错图**。pass 用例必须连图、图必须独立可证 claim(反例:声称"下拉含 8 选项"但图里下拉收起——先 `select.size=N` 展开再截)、关键词断言不得同义反复(排除自己输入的消息,锚定产物区域)。详见 standard §3.6 证据链连线,准入第 8 项机检兜底。据此填**自动选定的模板**得出 Verdict。两套模板共享同一速览卡(H1 + Verdict + 一句话结论 + 元信息表) + 同一结尾(meta 注释);中间章节按所选风格走。
   - **每日验收报告结构(2026-06-18 固化)**:每日/昨日验收类报告必须先给类似周报的「昨日工作总结」,说明昨天做了什么、按模块覆盖了哪些内容、哪些没覆盖;紧接「覆盖矩阵」和「目录」,再按大章节逐页验收。页面章节顺序建议:总结 → 覆盖矩阵 → 目录 → 验收地址 → DoD/自测 → 需求一一对应 → 用例表 → 截图回读检查 → 页面验收章节 → 重试记录 → 缺陷清单 → 总结论。不得直接堆截图。
   - **每日验收必须内置标记法则与验收标准**:每日/昨日验收报告必须有「标记法则与验收标准」章节,把颜色含义、严重级、测试规则、所用验收标准写清楚,让读者不用回看技能文档也知道图上的框是什么意思、为什么最终判通过/不通过。
   - **颜色标记统一**:红色=P0 阻断缺陷(空白/崩溃/核心不可用),橙色=P1/P2 中高风险或体验干扰(遮挡/错位/可用但不稳),蓝色=环境/路径/数据可达性说明(顶栏可见/路由可达/接口返回),绿色=通过证据(主体可见/关键区域正常)。同一张图里同时存在「可达」和「失败」时必须拆成不同颜色标记,不能全用一种颜色。
   - **问题标记必须可定位**:问题区域必须框到具体范围,标签写清严重级 + 现象,如 `P0: 正文区域空白`;禁止只写「有问题」「异常」「看这里」。通过标记也要写清通过了什么,如 `通过: CDS Agent 主体可见`;禁止只写「正常」。
   - **截图回读必须显式写进报告**:截图后不仅要自己看一眼,还要在报告里增加「截图回读检查」表,逐图记录是否截歪、是否加载完成、是否空白、问题是否入镜。发现缓慢加载/半截/空白但不是目标缺陷时,必须重拍;如果空白正是目标缺陷,要在图上框出空白区域并在回读表中说明。
4. **归档**:`python3 scripts/archive_report.py --config acceptance.config.json --target "<目标>" --module "<模块>" --feature "<功能>" --type "<新增功能|优化|修复>" --verdict <pass|conditional|fail> --tier <L0|L1|L2> --report-md <正文.md> --manifest <outDir>/manifest.json [--branch --commit]`。
   - **知识库传输共享协议（强制）**:归档脚本必须把报告正文和截图资产一次性提交给 `PUT /api/document-store/entries/{id}/content`。正文保留 `{{IMG:name}}`/`{{EVIDENCE}}` 结构，截图走 `assets[]`，由知识库后端统一上传正式资产、重写 Markdown 图片 URL、写 ParsedPrd、刷新 `document:{DocumentId}` 缓存。**禁止**脚本自行猜图片域名、禁止先上传截图条目再删除、禁止直接写 Mongo、禁止把 `data:image` 写进知识库正文。
   - **命名固定结构**(用户定):标题 = `项目 · 模块 · 功能 · 操作方式 · 验收报告`(`--module/--feature/--type` 拼装,空段自动跳过)。**状态(通过/不通过)不进标题——走 tags 标记**(脚本自动写 `[verdict_cn, type, tier]`),不靠改名表达状态。
   - 正文用 `{{IMG:<截图name>}}` 逐步内联(ZZ)或 `{{EVIDENCE}}` 集中,脚本自动替换为内联截图。
   - **防断头报告**:建条目后强制校验正文真的落库(`GET /content` 的 `hasContent`);写不进(预览 524 等)会**自动删空壳条目 + 报错**,绝不留"有标题、点开空白"的半截条目。
   - **必给地址**:收尾必打印「验收归档完成 · 必给地址」块(分享短链优先,拿不到则给 owner 登录路径)——每次归档都有一个可达地址交付,绝不静默。
5. **归档后自查能否打开(强制,创建≠能看)**:拿到分享链后**必须**跑 `PWPATH=$(npm root -g)/playwright node scripts/verify-open.mjs <shareUrl> "<标题里必现的一段>" <最少图片数>`。它 headless 打开真页面断言报告渲染(标题 + 正文 + 截图);默认**最多尝试 2 次**(首试 + 1 次重试),用来吸收 CDS/Cloudflare/预览网关的偶发抖动。**重试不能抹掉首试失败**:若第 1 次失败、第 2 次通过,报告必须记录「第一次结果 / 重试动作 / 第二次结果 / 最终判定」,并把它标为链路风险;**exit 0 = 真能看**才算交付完成,**exit 2 = 空白/打不开/截图缺失 → 重新推送验收**(重跑第 4 步,生成新 report_id)。杜绝"建了条目但点开空白"流到用户手里。

## 端到端示例(照抄即可)

`scripts/example-driver.mjs` 是可直接改的取证脚本骨架。完整一轮:

```bash
SKILL=.claude/skills/create-visual-test-to-kb
export PWPATH=$(npm root -g)/playwright
export MAP_AI_USER=inernoro MAP_ACCEPT_PASS='***' AI_ACCESS_KEY='***'

# 1. 复制示例 driver,按本次验收改 gotoByClick/click/shot 步骤
cp $SKILL/scripts/example-driver.mjs /tmp/my-driver.mjs
#   编辑 /tmp/my-driver.mjs:登录 → gotoByClick(目标菜单) → 操作 → shot(...)

# 2. 取证(产出 /tmp/acc_shots/*.png + manifest.json)
node /tmp/my-driver.mjs "$(python3 $SKILL/../cds/cli/cdscli.py --human preview-url)"

# 3. 读图核对(用 Read 工具逐张看),据 templates/report-template.md 写 /tmp/report_body.md
#    正文里用 {{EVIDENCE}} 占位,脚本自动替换为内联截图

# 4. 归档(doc-store 模式;无文档空间改 config.report.mode=local)
python3 $SKILL/scripts/archive_report.py --config $SKILL/acceptance.config.json \
  --target "你的验收目标" --verdict pass --tier L2 \
  --report-md /tmp/report_body.md --manifest /tmp/acc_shots/manifest.json \
  --branch "$(git branch --show-current)" --commit "$(git rev-parse --short HEAD)"
```

## 交付(三条路径,殿堂≠分享,务必分清)

> **殿堂(发布到殿堂)和分享(共享给别人)是两码事**(用户 2026-05-27 强调):**殿堂 = 对所有人开放**(库 `isPublic=true` → 进 `/public/stores` 公开陈列,谁都能浏览);**分享 = 对部分人开放**(库可私有,生成 share token → `/s/lib/{token}`,只有拿到链接的人能看,**不靠公开**)。验收报告是内部产物,**默认私有 + 分享链**,**不进殿堂**。两者正交,绝不可拿"设 public 进殿堂"冒充"分享给某人"。

- **① 分享链(对部分人,默认交付)**:`/s/lib/{token}`(脚本输出,2026-05-27 实测正确路由——旧 `/library/share/{token}` 不存在、会落到首页)。token 独立授权,**库私有也能看**(已实测:库 `isPublic=false` 时分享链仍渲染正文 + 4 张内联截图)。`LibraryShareViewPage` 渲染书册目录 + 正文 + 内联截图。分享是**库级**(整库一个 token、内含多篇),对方在左侧目录点具体报告阅读。
- **② owner 登录自看(恒可靠)**:登录 MAP → 左侧「知识库」→ 「验收报告」库 → 最新一篇。走授权 DocBrowser,正文 + 截图完整渲染。给本人验收用。
- **③ 殿堂(对所有人,仅当你确实要公开展示才用)**:把库设 `isPublic=true` → 进公开殿堂,任何人可浏览。**这不是分享,是公开**;验收报告默认不走这条。
- **聊天内直给**:截图发给用户(authed 渲染图)是最稳的"立即可读"方式,不依赖任何链接。

> 历史教训:(2026-05-26)曾把 share 链接当"点开即看"交付却空白——根因是用错路由/正文没落库。(2026-05-27)曾把验收报告库误设 `isPublic=true` 公开进殿堂,混淆了"分享给某人"与"公开给所有人"。交付前必须自己用无头浏览器走一遍目标查看路径,并确认库可见性(私有/公开)符合预期。

## 按需文件(渐进式披露)

| 文件 | 内容 | 何时读 |
|------|------|--------|
| `reference/standard-v2.md` | 完整标准:命名/档位/浏览器操作/截图/报告结构/Verdict 规则/国际标准对照 | **必读**,动手前 |
| `templates/zz-report.md` | **默认** ZZ 照做风骨架(全大标题 + 一句话一步 + `{{IMG:}}` 逐步配图) | 写报告时(首选) |
| `templates/report-template.md` | 旧版九段骨架(速览卡 + 九段 + 用例表 + `{{EVIDENCE}}` 集中证据) | 要集中证据段时 |
| `scripts/harness.mjs` | 模拟人类浏览器 helper(点击导航/截图/主题 + ZZ 画框 stepClick/stepShot/box) | 写 driver 时 |
| `scripts/annotate.mjs` | 通用「框选重点」工具:一条命令对任意页面按 selector/坐标画框+标签再截图(--login/--mobile/--click) | 发任何指向性截图前(§B2 硬要求) |
| `scripts/archive_report.py` | 配置驱动归档(一次性提交正文+assets[]，由知识库后端资产化图片/建条目/写正文校验/分享链/必给地址/可见性防漂移) | 归档时 |
| `scripts/verify-open.mjs` | 归档后自查:headless 打开分享链断言报告渲染(标题+正文+截图);空/打不开 exit 2 | 归档后(强制) |
| `scripts/read_comments.py` | 回读闭环:拉知识库最近批注(用户在验收文档上的划词/全文批注),按时间倒序,供复测 | 复测/收集反馈时 |
| `acceptance.config.json` | 项目配置(预览域名/登录/文档空间API/库名/截图);跨仓库改这个 | 接新仓库时 |

## 回读批注闭环(用户批注 → 智能体复测)

知识库与本技能是双向的:技能把验收报告**写**进知识库;用户在那篇报告里**划词/框选文字批注**(或对整篇评论)留下反馈,验收智能体再把这些批注**读**回来做下一轮复测。最简实现是按需轮询(不是监听):

```bash
# 归档后,归档脚本会输出 storeId/entryId;隔段时间或被要求复测时拉一次最近批注
python3 $SKILL/scripts/read_comments.py --config $SKILL/acceptance.config.json \
  --store "验收报告" --entry <报告条目 entryId> --since <上次拉取时间ISO>
```

- 鉴权复用归档同一把 `MAP_DOC_STORE_KEY`(`document-store:write` 写蕴含读,可调读接口);后端 `GET /stores/{storeId}/recent-comments` 已做读权限校验,只返回该 key 可读库的批注。
- 输出末尾 `COMMENTS_JSON: {...}` 供智能体解析:每条含 `entryTitle / selectedText(被批注原文) / content / authorDisplayName / createdAt / isWholeDocument / status`。智能体据此定位"用户对哪段不满意",针对性复测/修复,再走第 4 步重新归档(新 report_id)。
- `--since` 做增量:只取上次拉取后的新批注,避免重复处理。监听式(webhook/SSE 主动推送)是后续增强,先用这条拉取路径跑通。

## 跨仓库复用

整个技能项目无关,耦合点全在 `acceptance.config.json`:预览域名命令、登录选择器与 env、文档空间 API base、报告库名、截图参数。别的仓库装本技能 + 改配置即用;`report.mode=local` 时退化为写 `/tmp/map-acceptance-local` 这类仓库外临时目录,不依赖文档空间。

## 与既有技能的关系

- `acceptance-checklist`(/uat):执行**前**生成真人逐步打勾清单。本技能:执行**后**沉淀结果报告。互补。
- `bridge`:操作"用户当前真实浏览器"(交互/演示)。本技能取证走**本地无头浏览器**,二者不混用。

## 合规

全中文;禁 emoji(CLAUDE §0);截图通过知识库传输共享协议一次性提交,最终正文只能保留正式 HTTPS 图链,不允许 `data:image`;报告不可变(重测出新 report_id);预览地址走 cdscli 禁手拼(规则 #11)。
