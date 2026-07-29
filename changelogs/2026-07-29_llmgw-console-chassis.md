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
| fix | llmgw | 修复两处「接口 success 但 body 缺字段即整页白屏」：预算与用量的 statusDistribution、系统运维的 keyHealth/configAuthority/shadow summary |
| test | llmgw | 新增 e2e/llmgw-page-acceptance.mjs：逐页真人路径 + 双主题验收，断言白屏/h1/标题裸露/贴边/pageerror，首次运行即抓到上述两处白屏 |
| fix | prd-admin | 区分模型网关跳转的两种失败：预览分支名过长导致网关子域超 DNS 63 字符上限时，不再误报「登录凭据未通过安全校验」，改为报出真实原因与超出字符数 |
| feat | cds | 部署时向所有容器注入已发布入口表 CDS_PREVIEW_URL / CDS_SERVICE_URLS（平台事实层，强制覆盖，项目 env 不得伪造），应用侧不再需要自己按 hostname 推算兄弟服务域名 |
| refactor | cds | 新增 preview-entrypoints.ts 作为「本分支发布了哪几个入口」的计算 SSOT；DNS 63 octet 判据此前分裂在 forwarder-route-publisher、computeBranchGatewayUrls 两处字面量，收敛为共享谓词 isPublishableNamedLabel |
| feat | prd-api | SSO 票据接口新增 console 字段，由服务端按平台注入的入口表回答「这张票据该送去哪个控制台」：有基址 / 明确未发布 / 同源三态 |
| fix | prd-admin | 删除前端按 location.hostname 拼网关子域的第二份域名实现（违反规则 #11）：预览分支名过长导致平台未发布该子域时，此前会拼出一个不存在的域名并把失败报成「登录凭据未通过安全校验」，现改为如实报出未发布原因 |
| test | cds | 新增 preview-entrypoints 守卫（含 2026-07-29 现场 67 字符分支用例、63/64 边界、项目 env 不得伪造平台注入） |
| test | prd-admin | SSO 落点测试改为契约驱动，新增源码守卫禁止 llmGatewaySso.ts 再出现域名推算痕迹 |
| docs | doc | 新增 debt.platform.preview-entrypoints.md 台账：记录截断未覆盖复合标签、入口表容器创建时定格、其他消费方未清查三项欠账 |
| fix | prd-api | 区分「入口确实未发布」与「旧版平台没下发入口表」：过渡期预览环境不再误判为正式环境而回退到并不存在的同源控制台 |
| refactor | prd-api | DeploymentAuthority 里读了两遍的 CDS_PROJECT_ID 判据抽成 IsCdsBranchPreview，供第三个消费方复用 |
| test | prd-api | 新增 PlatformEntrypointsTests：表里取值 / 尾斜杠归一 / 缺项返回 null 不猜 / 畸形 JSON 降级 / 「没有表」与「表里没这项」可区分 |
| feat | cds | 命名子域超 DNS 63 字符上限时改为截断 slug + 接 8 位 sha1 摘要（此前整条路由跳过不发布，长分支拿不到网关等命名入口）；摘要保证前缀相同的长分支不会塌成同一 host |
| fix | cds | 发布器写 host、两处 SSRF 白名单此前各自拼 `<slug>-<sub>`，改为统一走 namedServiceLabel，否则截断后发布的 host 与白名单算出的不是同一个 |
| fix | cds | 超长命名子域的截断改为只在 `-` 段边界下刀（此前按字符硬切会切出 `...-f4oeh6-cla` 这种半截词，人读不出也拼不对） |
| refactor | cds | 模型网关控制台子域 llmgw-web 改名为 llmgw（它本身就是 web，`-web` 是废字，还白占 4 个 DNS 标签额度）；发布器同时发布历史别名，存量链接与未重新导入 compose 的存量部署都不受影响 |
| fix | llmgw | 控制台「返回 MAP / 教程」深链此前硬编码 `-llmgw-web` 后缀反推 MAP 地址，子域改名即失效；改为新旧后缀都认并收敛成文件内唯一一处 |
| feat | llmgw | console-api 经 /gw/healthz 下发 mapHomeUrl（源头 CDS_PREVIEW_URL），控制台「返回 MAP / 教程」深链改用平台权威地址，不再按 hostname 反推（推算仅作平台未下发时的兜底） |
| test | prd-admin | 新增全仓守卫 previewHostDerivation.guard：扫 prd-admin 与 llmgw/web 全部源码，禁止新增按 hostname 拼预览域名的实现，例外须登记理由与清除条件 |
| fix | cds | 撞名检查与两处 SSRF 白名单只算规范子域、漏掉同样被发布的历史别名：别的分支能占走别名 host，探测/压测打自己发布的别名会被自家闸门 403；三处统一走 publishedServiceLabels |
| fix | llmgw | 新人清单的事实读取失败被当成「确实没有」缓存 60 秒：一次瞬时 500 就让配置齐全的租户被告知去建团队、拉成员；改为失败即抛不入缓存，并新增 unavailable 态让清单沉默 |
| fix | llmgw | 建团队 / 拉成员 / 签密钥后主动失效新人清单缓存并通知已挂载组件（此前失效函数无人调用，且清缓存本身不会让 hook 重跑） |
| docs | doc | 预览入口下发债务台账登记进 index.yml 与 guide.list.directory |
| fix | llmgw | 教程深链传的是未削 basename 的路径：同源部署下控制台挂在 /llmgw/，传过去的 /llmgw/service-keys 与图谱登记的 /service-keys 逐段比对必然不匹配，每个页面都报「没有找到关联教程」 |
| fix | llmgw | 章节深链改用独立参数 tutorialSourceId：此前把教程 sourceId 塞进 entry（那是 Mongo 文档 id），且会被 tutorialRoute 解析结果覆盖，标着第 15 / 19 章的链接统统打开第一章 |
| fix | llmgw | 站内学习中心回落改走 router Link：裸 a 标签在 basename=/llmgw 下会跳到 MAP 应用的 /learn |
| fix | prd-admin | 知识库教程深链按 tutorialSourceId 选中对应章节，取不到才回落第一篇 |
| test | llmgw | 新增教程深链契约守卫 check-tutorial-deeplink.mjs 并接进 build（这三条依赖 router basename 与跨应用参数约定，行为测不到，只能钉源码契约） |
