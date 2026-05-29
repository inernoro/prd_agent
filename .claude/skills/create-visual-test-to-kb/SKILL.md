---
name: create-visual-test-to-kb
description: 工业级功能验收/视觉测试全流水线（MAP 验收标准 v2）——模拟人类的浏览器取证 + 标准化验收报告 + 归档进知识库并出分享链。一个技能内含三段：标准/模板、模拟人类浏览器取证（点击导航进入、禁地址栏直达、双主题截图、ZZ 照做风画框标序号 stepClick/stepShot）、报告归档（命名 状态前置，根治目录 `---`，**每次归档强制输出可达地址**：分享短链优先、拿不到则给 owner 登录路径）。默认报告走 **ZZ 照做风**（全大标题 + 一句话一步 + 逐步配图 `{{IMG:}}` + 文字在上图在下 + 变化处画框 + 分支顺序讲，同岗位照做必复现）。归档前有**强制准入校验**：目标/档位/Verdict/截图数/证据完整性/报告结构不达标直接拒收（入口准则，杜绝"什么都能进"）。项目无关，改 acceptance.config.json 即可跨仓库复用；无文档空间的仓库退化为本地 md+截图。触发词："验收"、"视觉测试"、"验收归档"、"归档验收报告"、"create visual test"、"/验收"。
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

`report.mode=local` 时**只需 Playwright + Python**,不需要任何密钥/网络——报告写本地 `doc/acceptance/`。

接入新仓库:见文末"跨仓库复用",改 `acceptance.config.json` 一处即可。

## 三个核心规矩(v2 相对 v1 的升级,违反即不合格)

1. **模拟人类,禁地址栏直达**:登录后用 `gotoByClick(可见文本)` 点击导航进入目标页,`page.goto` 只许用于登录页。**从导航点不到目标页 = P1 缺陷**(功能做了但用户找不到/没进菜单)——这是 goto 直达永远测不出的真问题。
2. **人类可读优先**:报告首屏是"验收速览卡"(Verdict + 一句话结论 + 元信息表),不是 YAML。
3. **命名 + 防 `---`**:报告名业界状态前置 `[{verdict_cn}] {目标} · 验收报告 · {项目} · {日期}`;正文必须以 `# 标题` 打头(目录显示名取 summary 首行,见标准 §2.1)。`archive_report.py` 已内置,手工归档也照此。
4. **准入门槛(入口准则)**:归档前强制校验——目标有意义、档位/Verdict 合法、截图数达档位下限、证据完整、报告结构齐、无半成品残留;**任一不达标直接拒收、不写库**(见标准 §3.5)。输入不对,输出不可能对。

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
2. **写 driver 取证**:用 `scripts/harness.mjs` 的 helper 写本次验收的真人路径脚本。基础 helper:`launch/login/gotoByClick/click/type/setTheme/shot`。**ZZ 照做 helper(画框 + 步骤序号,默认用)**:`stepClick(page,outDir,N,locator,name,caption)` 在点击目标上画红框 + 标序号 → 截"点这里"图 → 清框 → 真点击;`stepShot(page,outDir,N,name,caption,highlight?)` 截结果图并框住变化处;`box/clearBoxes` 手动画框。跨用户前置(如造分享链)走 API。核心页双主题各一张;结束 `writeManifest(outDir)`。
   运行:`PWPATH=$(npm root -g)/playwright node <driver>.mjs`(无 playwright 先 `npm i -g playwright && npx playwright install chromium`)。
3. **读图核对**:截图用 Read 工具读回,肉眼级核对(这套抓到过"匿名未登录""按钮没渲染"等真 bug)。据此填**自动选定的模板**得出 Verdict。两套模板共享同一速览卡(H1 + Verdict + 一句话结论 + 元信息表) + 同一结尾(meta 注释);中间章节按所选风格走。
4. **归档**:`python3 scripts/archive_report.py --config acceptance.config.json --target "<目标>" --module "<模块>" --feature "<功能>" --type "<新增功能|优化|修复>" --verdict <pass|conditional|fail> --tier <L0|L1|L2> --report-md <正文.md> --manifest <outDir>/manifest.json [--branch --commit]`。
   - **命名固定结构**(用户定):标题 = `项目 · 模块 · 功能 · 操作方式 · 验收报告`(`--module/--feature/--type` 拼装,空段自动跳过)。**状态(通过/不通过)不进标题——走 tags 标记**(脚本自动写 `[verdict_cn, type, tier]`),不靠改名表达状态。
   - 正文用 `{{IMG:<截图name>}}` 逐步内联(ZZ)或 `{{EVIDENCE}}` 集中,脚本自动替换为内联截图。
   - **防断头报告**:建条目后强制校验正文真的落库(`GET /content` 的 `hasContent`);写不进(预览 524 等)会**自动删空壳条目 + 报错**,绝不留"有标题、点开空白"的半截条目。
   - **必给地址**:收尾必打印「验收归档完成 · 必给地址」块(分享短链优先,拿不到则给 owner 登录路径)——每次归档都有一个可达地址交付,绝不静默。
5. **归档后自查能否打开(强制,创建≠能看)**:拿到分享链后**必须**跑 `PWPATH=$(npm root -g)/playwright node scripts/verify-open.mjs <shareUrl> "<标题里必现的一段>" <最少图片数>`。它 headless 打开真页面断言报告渲染(标题 + 正文 + 截图);**exit 0 = 真能看**才算交付完成,**exit 2 = 空白/打不开/截图缺失 → 重新推送验收**(重跑第 4 步,生成新 report_id)。杜绝"建了条目但点开空白"流到用户手里。

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
| `scripts/archive_report.py` | 配置驱动归档(上传/删图保URL/建条目/写正文校验/分享链/必给地址/可见性防漂移) | 归档时 |
| `scripts/verify-open.mjs` | 归档后自查:headless 打开分享链断言报告渲染(标题+正文+截图);空/打不开 exit 2 | 归档后(强制) |
| `acceptance.config.json` | 项目配置(预览域名/登录/文档空间API/库名/截图);跨仓库改这个 | 接新仓库时 |

## 跨仓库复用

整个技能项目无关,耦合点全在 `acceptance.config.json`:预览域名命令、登录选择器与 env、文档空间 API base、报告库名、截图参数。别的仓库装本技能 + 改配置即用;`report.mode=local` 时退化为写 `doc/acceptance/` 本地 md + 截图,不依赖文档空间。

## 与既有技能的关系

- `acceptance-checklist`(/uat):执行**前**生成真人逐步打勾清单。本技能:执行**后**沉淀结果报告。互补。
- `bridge`:操作"用户当前真实浏览器"(交互/演示)。本技能取证走**本地无头浏览器**,二者不混用。

## 合规

全中文;禁 emoji(CLAUDE §0);截图引用式(传 URL 内联,不塞 base64);报告不可变(重测出新 report_id);预览地址走 cdscli 禁手拼(规则 #11)。
