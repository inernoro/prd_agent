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
