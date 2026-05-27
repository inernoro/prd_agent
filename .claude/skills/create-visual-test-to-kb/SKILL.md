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

## 工作流(四步)

1. **定标准与档位**:读 `reference/standard-v2.md`,按改动定 L0/L1/L2(下限见 §3)。
2. **写 driver 取证**:用 `scripts/harness.mjs` 的 helper 写本次验收的真人路径脚本。基础 helper:`launch/login/gotoByClick/click/type/setTheme/shot`。**ZZ 照做 helper(画框 + 步骤序号,默认用)**:`stepClick(page,outDir,N,locator,name,caption)` 在点击目标上画红框 + 标序号 → 截"点这里"图 → 清框 → 真点击;`stepShot(page,outDir,N,name,caption,highlight?)` 截结果图并框住变化处;`box/clearBoxes` 手动画框。跨用户前置(如造分享链)走 API。核心页双主题各一张;结束 `writeManifest(outDir)`。
   运行:`PWPATH=$(npm root -g)/playwright node <driver>.mjs`(无 playwright 先 `npm i -g playwright && npx playwright install chromium`)。
3. **读图核对**:截图用 Read 工具读回,肉眼级核对(这套抓到过"匿名未登录""按钮没渲染"等真 bug)。据此填模板得出 Verdict。**默认用 `templates/zz-report.md`(ZZ 照做风:全大标题、一句话一步、`{{IMG:<name>}}` 逐步配图、文字在上图在下、变化处画框、分支顺序讲,见标准 §6.3)**;旧版九段集中证据用 `templates/report-template.md` + `{{EVIDENCE}}`。
4. **归档**:`python3 scripts/archive_report.py --config acceptance.config.json --target "<目标>" --module "<模块>" --feature "<功能>" --type "<新增功能|优化|修复>" --verdict <pass|conditional|fail> --tier <L0|L1|L2> --report-md <正文.md> --manifest <outDir>/manifest.json [--branch --commit]`。
   - **命名固定结构**(用户定):标题 = `项目 · 模块 · 功能 · 操作方式 · 验收报告`(`--module/--feature/--type` 拼装,空段自动跳过)。**状态(通过/不通过)不进标题——走 tags 标记**(脚本自动写 `[verdict_cn, type, tier]`),不靠改名表达状态。
   - 正文用 `{{IMG:<截图name>}}` 逐步内联(ZZ)或 `{{EVIDENCE}}` 集中,脚本自动替换为内联截图。
   - **防断头报告**:建条目后强制校验正文真的落库(`GET /content` 的 `hasContent`);写不进(预览 524 等)会**自动删空壳条目 + 报错**,绝不留"有标题、点开空白"的半截条目。
   - **必给地址**:收尾必打印「验收归档完成 · 必给地址」块(分享短链优先,拿不到则给 owner 登录路径)——每次归档都有一个可达地址交付,绝不静默。

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

## 交付(可靠路径 + Verdict)

- **owner 自看(唯一可靠,默认私有库恒可用)**:登录 MAP → 点击左侧「知识库」→ 打开「验收报告」库 → 本次报告(最新一篇)。走授权 DocBrowser,正文 + 内联截图完整渲染。**这是交给用户验收的主路径。**
- **分享给登出第三方**:`/library/share/{token}`(脚本输出)当前**只渲染目录、不渲染 reference markdown 正文**(实测 LibraryShareReader 的已知缺陷,2026-05-26)。要给第三方看,二选一:① 让对方登录后走授权路径;② 把报告库设 `isPublic:true` 并走殿堂页(需文档空间侧支持)。**别直接把 share 链接当"点开即看正文"交付。**
- **聊天内直给**:截图发给用户(authed 渲染图)是最稳的"立即可读"方式,不依赖任何链接。
- 禁止把 `/library/{storeId}` 当私有库入口(会撞"未对外开放")。

> 历史教训(2026-05-26):一次把 share 链接当"点开即看"交付,结果第三方看到空白正文——根因是分享阅读器不渲染 reference markdown。交付前必须自己用无头浏览器走一遍目标查看路径,确认正文 + 截图都渲染,避免"断头报告"。

## 按需文件(渐进式披露)

| 文件 | 内容 | 何时读 |
|------|------|--------|
| `reference/standard-v2.md` | 完整标准:命名/档位/浏览器操作/截图/报告结构/Verdict 规则/国际标准对照 | **必读**,动手前 |
| `templates/zz-report.md` | **默认** ZZ 照做风骨架(全大标题 + 一句话一步 + `{{IMG:}}` 逐步配图) | 写报告时(首选) |
| `templates/report-template.md` | 旧版九段骨架(速览卡 + 九段 + 用例表 + `{{EVIDENCE}}` 集中证据) | 要集中证据段时 |
| `scripts/harness.mjs` | 模拟人类浏览器 helper(点击导航/截图/主题 + ZZ 画框 stepClick/stepShot/box) | 写 driver 时 |
| `scripts/archive_report.py` | 配置驱动归档(上传/删图保URL/建条目/写正文/分享链) | 归档时 |
| `acceptance.config.json` | 项目配置(预览域名/登录/文档空间API/库名/截图);跨仓库改这个 | 接新仓库时 |

## 跨仓库复用

整个技能项目无关,耦合点全在 `acceptance.config.json`:预览域名命令、登录选择器与 env、文档空间 API base、报告库名、截图参数。别的仓库装本技能 + 改配置即用;`report.mode=local` 时退化为写 `doc/acceptance/` 本地 md + 截图,不依赖文档空间。

## 与既有技能的关系

- `acceptance-checklist`(/uat):执行**前**生成真人逐步打勾清单。本技能:执行**后**沉淀结果报告。互补。
- `bridge`:操作"用户当前真实浏览器"(交互/演示)。本技能取证走**本地无头浏览器**,二者不混用。

## 合规

全中文;禁 emoji(CLAUDE §0);截图引用式(传 URL 内联,不塞 base64);报告不可变(重测出新 report_id);预览地址走 cdscli 禁手拼(规则 #11)。
