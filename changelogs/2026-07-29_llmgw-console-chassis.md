| refactor | llmgw | 新增页面骨架 PageShell（PageHeader/PageBody/Prose/FormGrid/HelpPopover/DetailsBlock/TutorialLink），统一控制台页头与容器 |
| refactor | llmgw | 「团队与成员」按风格调性 v1.2 重写：取消 1060px 居中改贴边全宽、成员卡片流改表格、增改走抽屉、角色说明收进 ? 浮层、概念解释收进折叠块并深链教程第 5 章（537 字/8 段 → 225 字/1 段） |
| feat | llmgw | 新增令牌 --measure 与 .lg-prose / .lg-form-grid：容器贴边，可读宽度改为作用在段落与表单列上 |
| feat | llmgw | 新增文字预算守卫 check-prose.mjs（常驻正文 ≤2 段 / ≤400 汉字，出口内文字不计入；页面级居中直接判错），接进 pnpm build |
| feat | llmgw | check-typography 新增规则三：小字号配正文行高即判错，按棘轮制记录存量只减不增 |
| fix | llmgw | 修复 --danger / --success 两个从未定义的 CSS 变量：报错文字不显红、ServiceKeys 警告框连边框底色一起丢失；统一改走 --err / --ok 并抽出 InlineAlert |
| fix | llmgw | 修复角色说明浮层被表格 overflow-x 容器裁切（第 5 个角色显示不全），HelpPopover 增加 align 参数 |
| style | llmgw | 卡片内边距归一到 14px（此前 home/usage/settings 为 18px），实体详情页取消 1180px 居中 |
| docs | llmgw | 控制台风格调性规则升到 v1.2：新增原则 6（容器贴边、可读宽度作用在内容上）与原则 7（文字预算与三轨接入），补记漂移检测的三个前提 |
| fix | llmgw | 修复组织页重构打破的 5 条跨模块源码契约断言（GatewayDataDomainGuardTests 直接读前端源码，本机无 dotnet 未能及时发现） |
| feat | llmgw | 新增源码契约守卫 check-source-contracts.mjs：解析 GatewayDataDomainGuardTests.cs 并在本地复算全部 343 条前端断言，接进 pnpm build |
| refactor | llmgw | 「预算与用量」按 v1.2 迁移：解释收进 HelpPopover/DetailsBlock、账单导入表单改抽屉、「对账覆盖」由说明句改为页头派生指标（7 段/575 字 → 0 段/241 字） |
| refactor | llmgw | 「提示词策略」按 v1.2 迁移：取消 1040px 居中改贴边全宽，合并顺序与日志口径收进折叠块并深链教程第 20 章（3 段/274 字 → 1 段/103 字） |
| fix | llmgw | 修复预算与用量页表单控件缺高度（padding 撑出的高度低于漂移检测 34px 下限），改用 FIELD_INPUT |
| refactor | llmgw | 「逻辑模型目录」按 v1.2 迁移：页头统一走 PageShell、创建卡内边距归一到 14、表单栅格改固定列宽，路由策略等说明收进 HelpPopover 并深链教程第 18 章（2 段/230 字 → 1 段/155 字） |
| fix | llmgw | 逻辑模型页 var(--danger)/var(--success) 两处失效 token 改为 --err/--ok |
| refactor | llmgw | 系统运维页按 v1.2 迁移：容器拓扑收进折叠块并删 desc 列、删 7 个与侧边栏重复的快捷入口、页头 summary 由发布 Gate 派生（3 段/163 字 → 1 段/76 字） |
| refactor | llmgw | Exchange 映射按 v1.2 迁移：自造页头换 PageHeader、内边距从 4 种收敛到 2 种（4 段/417 字 → 0 段 JSX 正文） |
| refactor | llmgw | 模型池按 v1.2 迁移：六种调度策略说明收进 HelpPopover、程序池追加语义收进折叠块（8 段/488 字 → 1 段/286 字） |
| refactor | llmgw | 接入密钥按 v1.2 迁移：作用域与轮换说明收进出口（4 段/446 字 → 0 段/309 字） |
| refactor | llmgw | 模型管理按 v1.2 迁移：定价说明收进 HelpPopover、内边距 4 档收敛到 2 档（2 段/275 字 → 0 段/193 字） |
| refactor | llmgw | 学习中心按 v1.2 迁移：改为「概念索引 + 深链教程」，不再在控制台复述教程正文（真实可见正文 1126 字/15 段 → 274 字/0 段） |
| refactor | llmgw | Quickstart 按 v1.2 迁移：删 1080px 居中与三张纯解释 Step 卡，首屏挂接入片段与派生态清单（9 段/607 字 → 0 段/335 字） |
| feat | llmgw | 三轨接入：AccessSnippetBar（老手拿地址就走）+ OnboardingChecklist（四步派生态，全绿自动消失）+ useOnboardingState（按租户缓存 60s） |
| fix | llmgw | 文字预算守卫补两个洞：正文搬进常量数组即可绕过预算；prose-ok 逃生门因先剥注释而从未生效 |
| fix | llmgw | 修复 --bg-muted / --radius-xs 两个从未定义的 CSS 变量（圆角与底色此前静默失效） |
| fix | llmgw | 修复 .lg-tutorial-link 的 5px 间距：该组件出现在每个迁移页，给 4 条被监测路由同时引入第 6 种容器间距 |
