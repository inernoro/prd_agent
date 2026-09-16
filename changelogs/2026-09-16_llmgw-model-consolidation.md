| feat | llmgw | 批量导入上游模型时一步登上白名单：同时建公开模型名与上游线路，同名只加线路 |
| feat | llmgw | serving 补 GET /v1/models 与 /v1/models/{id}，OpenAI 标准清单，按 key 过滤白名单 |
| feat | llmgw | 对外清单按线路逐条报价，非美金整条不报，一条算不出价时 pricing 写 null |
| fix | llmgw | 公开模型名剥掉供应商前缀，官网与中转导入的同一模型不再变成两个条目 |
| feat | llmgw | 白名单页补「从上游批量登记」直达入口，导入结果如实回显登记了几个 |
| test | prd-api | 新增批量登记与对外清单守卫五条，测试项目引用 console-api 以做行为断言 |
| fix | prd-api | 逻辑模型 Offering 熔断后补上冷却与半开租约，不再永久出局 |
| fix | prd-api | 失败计数与健康状态改为原子自增加单调升级，并发下断路器不再迟迟不跳 |
| fix | prd-api | 隔离路径清掉半开租约与人工恢复标记，坏成员不再每轮抢占首发名额 |
| refactor | prd-api | 熔断阈值与冷却租约收敛为 GatewayCircuitBreakerPolicy 唯一判据源 |
| feat | llmgw | 新增手工恢复上游线路端点，恢复语义为授予半开资格而非直接放回健康 |
| test | prd-api | 新增熔断守卫 14 条，覆盖判据单调性、原子写口径与半开接线 |
| docs | llmgw | 台账记入调度器死配置、探针从未启用、流中断不切换、调度空壳四条已知边界 |
| feat | llmgw | 逻辑模型页重做为模型白名单：一行一模型，上游成带色线路，用量给趋势线 |
| feat | llmgw | 新增逻辑模型近 30 天用量聚合端点，按天卷起调用量与美金花费 |
| fix | llmgw | 团队授权改为给数量不平铺名字，部门多或名字长时不再撑爆列宽 |
| refactor | llmgw | 协议、优先级、权重等内部字段下沉到展开态，列表表面只留要决策的四件事 |
| test | prd-api | 新增白名单列表三条源码守卫：团队计数口径、按线路逐条报价、趋势线渐变 id 唯一 |
| feat | llmgw | 模型页新增「调用全貌」：六步推演现在发一个请求会落到谁，含只给 appCallerCode 不点名那条路 |
| feat | llmgw | 新增 GET /gw/logical-models/{id}/call-trace：目录闸、不点名去向、候选线路逐条、协议、近 30 天账本 |
| fix | llmgw | 前端不再自己判「哪条线路在扛流量」，改用服务端下发的排队名次——旧判据比运行时严，把降级但仍在承接的线路显示成「没有主」 |
| refactor | prd-api | 挑选判据抽成 GatewayRouteSelection 纯函数，ModelResolver 调它；停用与熔断不再写在 Mongo 查询条件里 |
| test | prd-api | 新增判据行为对照：同一组输入喂运行时与控制台镜像，逐条断言结果一致，红绿闭环跑通 |
| docs | doc | 新增 design.platform.llm-gateway.model-architecture：四层架构、一次调用七步、异构上游三个槽 |
| fix | llmgw | 调用全貌的默认模型查询补 Enabled 与排序，与运行时逐条对齐；「会落到它」增加「真有一条线路能接」这一条 |
| fix | llmgw | 跳过判据补「目标模型或所属上游被停用」这一档——线上队首指向的物理模型是停用的，面板照样指着它 |
| polish | llmgw | 模型行按钮列放宽，「调用全貌」「展开」不再挤成一列每行一个字；协议未显式配时说「跟着目标模型走」而不是拼一个假适配器名 |
| test | e2e | 新增调用全貌真人路径验收脚本；双主题判据改为「两张图真的不一样」，此前只断言「不是深色底」而默认本就是浅色 |
| feat | prd-api | 模型可标记为「这个用途没点名时用它」，同租户同用途最多一个 |
| feat | prd-api | 解析链路未点名模型时先找默认模型，找不到或解析不出来原样回落到模型池 |
| refactor | prd-api | 按名字与按默认两条入口共用同一个逻辑模型解析体，不再各写一份 |
| feat | llmgw | 控制台行上显示默认标记，展开态可设可取消，并说清顶掉了谁 |
| test | prd-api | 新增默认模型守卫 5 条，回落承诺与先清旧再置新的顺序各做过红绿闭环 |
| fix | llmgw | 搬迁的模型能力从池成员快照取，不再是空集合导致能力门不放行 |
| fix | llmgw | 影子比对区分「新路没生效」与「选了别的上游」，不再混成一句不一致 |
| test | prd-api | 能力采集 8 条行为断言，Value=false 不当成具备，无快照退基线能力 |
| fix | llmgw | 搬迁改为「近期不可用照搬、陈年旧账重置」，24 小时为界 |
| test | prd-api | 近期失败判据 9 条行为断言，含无失败时间与降权两种边界 |
| fix | llmgw | 搬迁遇到能力为空的已有模型会补上，只补空的不覆盖人工调过的 |
| fix | llmgw | 搬迁也守「同用途最多一个默认」，第二个降级并报出来，不再绕过 PUT 的互斥 |
| feat | llmgw | 新增搬迁影子比对脚本：同一批请求新旧两路解析必须一致，差异逐条列出 |
| test | prd-api | 守卫补：搬迁端点必须再走一遍同用途唯一默认那条规则 |
| refactor | llmgw | 上游页展开即见名下模型与登记状态，没登记的排前面并直说「调用方找不到它」 |
| refactor | llmgw | Provider 与 Exchange 合成「上游」一个入口两段，/exchanges 落到转接上游段、锚点保留 |
| refactor | llmgw | 模型池停止新建（冻结横幅指向模型页），保留摘成员/恢复/停用等修复动作 |
| refactor | llmgw | 路由导航五条收成两条（模型 / 上游），三条旧地址保留路由与页内入口 |
| refactor | llmgw | 「模型白名单」页标题改为「模型」，与导航同名 |
| test | prd-api | 新增两条跨模块守卫：上游名下模型接线、导航两条且旧地址不留死链；均做过红绿闭环 |
| chore | prd-api | 测试项目删掉两个已由 ProjectReference 提供的 Compile Link，消除 CS0436 |
| fix | llmgw | /v1/models 的 DataContext 参数补 [FromServices]，不注册它的宿主不再整张端点表构建失败 |
| test | prd-api | 新增 serving 端点绑定守卫：最小宿主上枚举 EndpointDataSource 必须建得起来 |
| polish | llmgw | 上游页删掉指向 Exchange 的那句说明（转接段就在上面），名下模型列不再折行 |
| fix | llmgw | GET /v1/models 的权限判反：列模型是读不是调用，改判 route:read |
| docs | llmgw | 新增模型概念收敛活看板，四个阶段各带 blocker、下一步与验收证据 |
| test | prd-api | 补守卫：/v1/models 必须在落到 invoke 兜底前判成 route:read |
| feat | llmgw | 新增池搬迁端点：池 Code 成公开名、成员成线路、兜底标记原样搬 |
| feat | llmgw | 搬迁默认试运行，只读旧表写新表，可重复跑不重复建 |
| test | prd-api | 搬迁判据 7 条行为断言 + 端点守卫（试运行、不动旧表、健康不搬） |
| fix | llmgw | 对外模型清单的 via 不再回落到内部 Mongo id，取上游模型名 |
| test | prd-api | 补守卫：via 不许写成 TargetId |
| docs | llmgw | 活看板记录 P0 已验收，五条实打结论与两个实测 bug |
| fix | llmgw | 调用全貌的「不点名会落到它」补上调用方主语，配了专属池的调用方不再被谎报 |
| feat | llmgw | 调用全貌面板新增判定流程图，每条岔路按当前状态点亮或灰掉 |
| docs | llmgw | 架构文档补分层框图与判定流程图两张 Mermaid |
| test | prd-api | 镜像行为对照补调用方维度，守卫覆盖流程图接线与逐调用方冒烟 |
| refactor | prd-api | 删掉只被一条测试养着的池端点测试器 |
| test | llmgw | 真人路径验收补流程图与逐调用方两条断言 |
| docs | llmgw | 看板补阶段 4 删除清单，分三档并给出「先断流再删路最后删壳」的顺序 |
| fix | llmgw | 结论那句也补主语：配了专属池的调用方点名与不点名都走不到这张目录 |
| fix | llmgw | 验收脚本改为直连预览：钉代理 CA 公钥而非忽略证书，等待判据不再用 networkidle |
| feat | prd-api | 对外模型可「指定调用方」：这些调用方不点名时走它，优先于用途默认——断流的前提 |
| feat | llmgw | 模型页可看可改指定的调用方；调用全貌逐调用方结论认两层默认 |
| test | prd-api | 守卫钉住两层顺序（认领必须查在用途默认之前）与认领唯一性的维护顺序 |
| feat | llmgw | 「active 调用方必须绑池」换成「必须有人接得住」：判据与运行时两层同序 |
| fix | llmgw | 调用全貌的「其余为什么没落到它」按真实构成说，不再写死成专属池或未放行 |
| refactor | prd-api | 删掉解析器里的模型池分支：ResolveCoreAsync 767 行降到 88 行，整个文件 3702 行降到 2297 行 |
| refactor | prd-api | 池查询换成状态查询（114 行降到 55 行）；可选模型清单只剩端出对外模型目录（89 行降到 14 行） |
| refactor | prd-api | 删掉 13 个已成死码的池方法共 649 行，以及 3 条测已删功能的用例 |
| test | prd-api | 清理钉住已删池行为的守卫；「GW-only 不得查 MAP 调用方」的不变量升级为「压根不查」 |
| docs | llmgw | InMemoryModelResolver 化石记进债务台账 |
| refactor | llmgw | 删壳第二层：console-api 删掉模型池的 11 个写入端点与 `/gw/pool-types/ensure`，连带清掉随之变孤儿的 7 个辅助函数与 12 个请求/结果 DTO，Program.cs 净减 1419 行、Dtos.cs 减 94 行 |
| refactor | llmgw | 保留三个只读/搬迁入口：`GET /gw/pool-types`、`GET /gw/pools`（调用方页的池筛选、实体详情的池展示仍在读）、`POST /gw/pools/migrate-to-models`（正式环境的存量池尚未搬迁，删了就再也搬不了） |
| refactor | llmgw | 前端删掉最后一个孤儿池接口 `removePoolModel` 与随之未用的 `ModelPool` 类型导入 |
| test | prd-api | `GatewayLegacySweepGuardTests` 改为池退场的反向守卫：钉住三个保留入口仍在、12 个已删路由不许回来（红绿闭环验证过），并清掉 `GatewayDataDomainGuardTests` 里 16 条锁死已删实现的断言 |
| chore | prd-api | 协议路由审计脚本去掉两条指向已删池写入端点的静态断言 |
| fix | llmgw | 删壳后跟上文案：首页不再说学习中心讲「模型池」、学习中心那条卡片改指 `/logical-models`（原先指向已删的 `/pools`）、排查指引改说「对外模型 / 线路」 |
| refactor | prd-api | 挑选判据从 5 份收到 2 份：删无人调用的 SelectBestModel，池成员排序与测试拷贝改为调权威判据 |
| fix | prd-api | 删掉永远为假的 ResolutionType == "DefaultPool" 及它喂的恒为 false 的 DTO 字段 |
| refactor | prd-api | 删掉无人调用的 NeedsModelConfigFallback |
| test | prd-api | 新增两条减枝守卫：解析标签字面量必须真的会被产出；挑选判据只许权威与镜像两份 |
| docs | llmgw | 架构文档补「减枝」一节，写清三条现在不砍的枝与理由 |
| fix | llmgw | 模型价格抽屉的两个接口路径自带 /gw 前缀，拼成 /gw/gw/... 后 404 |
| test | llmgw | 挂载点守卫新增判据：客户端路径不许自带 /gw 前缀 |
| fix | llmgw | 补登喂给每一道名录门：导入端点原本只查内置 38 条，刚补登的模型会被当场拒 |
| fix | llmgw | 名录补登的唯一性覆盖别名，且更新端点补上同一份查重 |
| fix | llmgw | 导入失败后重试真的能补回缺失的对外模型与线路（原来重试时整段被跳过） |
| fix | prd-api | 生图契约覆盖表按租户过滤，不再把别的租户的配置装进进程全局表 |
| fix | llmgw | 池搬迁影子比对脚本不再永久改掉线上默认（快照 + finally 恢复） |
| fix | llmgw | 教程漂移判据认「本次被删掉的页面」，不再要求给不存在的页面登记教程 |
| test | prd-api | 新增「补登喂给每一道名录门」守卫，跑过红绿闭环 |
| fix | llmgw | 批量导入盖上能力 schema 版本，不再让导入后的第一次 capability-audit 变红 |
| fix | llmgw | 批量导入遇到同名但别的用途的对外模型时拒绝挂线路，不再让生图线路被当成 chat |
| fix | llmgw | 生图同步状态按租户分行，共用网关库时不再互相覆盖 |
| test | prd-api | 名录门兑换所用例改走对外模型线路，暴露出一条真缺陷（详见提交说明） |
| fix | prd-api | 对外模型解析带上物理模型的价格：此前读方强类型缺这几个字段，价格写进去读不出来，每次调用都按「没配价」记账且无任何报错 |
| fix | llmgw | appCaller 页的模型池控件退役成只读回执：解析器已不读那几个字段，保存成功却什么都不改变，是一次静默空操作 |
| fix | llmgw | appCaller 列表不再把模型池当「当前路由」显示，删掉随之失效的「预览模型池」抽屉 |
| test | prd-api | 新增对外模型计价守卫（弱类型写、真解析器读），红绿闭环验证过 |
| fix | llmgw | /v1/models 的可用判据与运行时对齐：熔断线路、指向已停用模型/平台/兑换所的线路不再当成可用发布 |
| fix | llmgw | 价格抽屉清空全部价格时发 clearPricing，过期价格终于删得掉 |
| fix | llmgw | 调用全貌面板不再说「回落到模型池」——那条路已退场，改说当场解析失败并给下一步 |
| fix | prd-api | 加权选路只在最健康那一档内分配，降级线路不再被旋到健康线路前面；面板报的比例同范围 |
| fix | llmgw | 生图契约的模式冲突检查收敛成一份，更新端点不再是后门 |
| fix | llmgw | 创建对外模型时校验「指定调用方」唯一性，不再出现两个模型同时认领 |
| fix | llmgw | 池搬迁四处：跨用途标识撞车当场拒绝、盖能力契约版本、成员按三种标识匹配、上游名取物理文档真名 |
| fix | llmgw | 批量导入重发布按规范化名查询，换个大小写重试不再空跑 |
| test | prd-api | 新增加权跨健康档的行为用例（遍历全部 seed 落点，两份判据各断一遍） |
| ops | llmgw | chat 的默认从 `default-chat`（169 条能接线路、127 条是 OpenRouter 全量导入、第 2-8 位全是 gpt-3.5 全系与 gpt-4 初代）改指新的旗舰梯队：gpt-5.6-sol 直连 → 同模型异上游 → sol-pro → terra → 5.5 → claude-opus-5 → claude-sonnet-5，七条里没有任何 mini/nano/lite/flash/haiku 便宜档 |
| ops | llmgw | 老的 `default-chat` 原地保留为归档（描述里写清为什么），回退就是把默认指回来。数据面改动，正式环境要另做一次 |
| feat | prd-api | 生图模型契约可以配在控制台、不用改代码不用发版：新增 `GatewayImageModelConfig` 实体与 `llmgw_imagegen_model_configs` 集合，`ImageGenModelAdapterRegistry.TryMatch` 内部先查覆盖表再回落到代码内置那 19 条（纯增量：库里一行都没有时行为逐字节不变） |
| feat | prd-api | 新增 `ImageGenModelConfigSyncWorker`：每 60 秒整表原子替换覆盖表，拉取失败保留上一版快照不清空；并在启动时把代码内置那份发布进 `llmgw_imagegen_builtin_catalog`，供控制台显示与「照这条建一份」 |
| feat | llmgw | 控制台上游页新增「生图契约」一段：列表、增删改、看内置那 19 条、照内置那条建一份；界面如实写明「保存后最长 60 秒生效」 |
| test | prd-api | 新增 `ImageGenConfigOverrideGuardTests` 七条：覆盖真的赢过内置（红绿闭环验证过）、空覆盖回到内置、没人绕过唯一判定入口、实体每个字段都真的接进运行时、控制台词表与运行时常量一致、内置清单由运行时发布而非手抄、刷新器接上线且失败不清空 |
| refactor | prd-api | 「数据行 ↔ 运行时配置」的翻译从 Api 的 worker 搬进 `PrdAgent.Infrastructure/LLM/ImageGenConfigTranslation.cs`——守卫项目不引用 Api，留在 worker 里「漏接一个字段」这种静默坏法没有任何东西够得着 |
| feat | llmgw | 生图契约补同步状态回写：刷新器每轮把「几点同步的、认到了哪几个模式」写进 `llmgw_imagegen_sync_status`，控制台读它，界面逐条对着刚填的模式说「已生效」或「还没被认到」——不再只说一句「最长 60 秒」让人盯着屏幕猜 |
| feat | llmgw | 模型名录可在控制台补登：上游出新模型时登记一次立刻生效，不用改代码也不用发版 |
| feat | llmgw | 上游清单那一屏的「名录外」模型就地补登，补完重拉当场翻成「名录内」 |
| test | prd-api | 新增 9 条名录补登守卫（补登优先、同一套查找规则、别名、端点现查、写入侧拒未知用途、两处前端接线） |
| fix | llmgw | 模型名录那一段的界面文案漏了 Markdown 星号，用户会原样看到；已改用 strong |
| test | llmgw | 新增守卫：src 下全部 tsx 的界面文案里不许出现 Markdown 强调符 |
| polish | llmgw | 上游主表去掉「类型 / API URL / 并发」三列，接口细节收进「查看接口」预览与编辑折叠区 |
| test | prd-api | 新增守卫：主表不许摆接口实现细节，且三项必须仍在预览里查得到 |
| test | prd-api | 名录门兑换所用例拆成两个对外模型：旧形态那条原本与被测线路同挂一个模型、按设计放行后顶了上来，断言测不到被测项 |
| test | prd-api | pinned 用例从模型池改建对外模型 + 两条线路，补上「不点名会选到另一条」的对照物，并钉住 pinned 不读线路协议 |
| fix | prd-api | 还绑着模型池的调用方不再静默走默认：解析时点名那条已失效的绑定并说清下一步 |
| test | prd-api | 池退场留下的测试债：视觉目录、未登记调用方回落、名录门顶替三组改用对外模型表达同一批不变量 |
| ops | llmgw | default-chat 队首换成 gpt-5.6-sol（OpenAI 直连那条线路顺位 670 → 10）。这是数据面改动，落在 CDS 共享库里、不随代码走，正式环境要另做一次 |
| fix | prd-api | 调用方去向判据从三档收到两档：模型池退场后运行时不再读 `AllowedModelPoolIds`，放行的调用方一律认对外模型目录。此前面板拿这个历史字段下结论，对 `document-store.transcribe-summary::chat` 说「点名与不点名都走不到 default-chat」，真打一次点名却落到了 default-chat 的队首——结论是反的 |
| refactor | prd-api | 视觉创作那三个调用方的名单从共享判据搬回解析器：它剩下的唯一职责是模型选择器的目录展示，解析判据与控制台面板都不需要知道它，份数 2 → 1（权威 + 控制台镜像 → 只剩权威） |
| fix | llmgw | 面板同步：结论句改说「放行中的 N 个」、逐调用方 chip 去掉「走自己的专属池」、判定流程图第一个菱形从「认对外模型目录吗」改为「放行吗」、构成统计去掉已不存在的那一档 |
| test | prd-api | 行为对照测试改判新不变量「放行与否是唯一判据，换哪个调用方代码都必须同一个答案」（红绿闭环验证过）；删掉那条正在保护错误结论的用例（形状 4a：它逐字要求面板继续按池来判） |
| docs | llmgw | 架构文档同步：判定流程图去掉池岔路并把两层默认画出来、第 5 节补这次判据收敛的实证、6.5 节记「预判对了一半」 |
| fix | llmgw | 教程映射跟上页面收敛：模型池那一面退场、并入「模型」；「上游」改成一壳两段，判据认内嵌面 |
| fix | doc | 看板 H1 与 index.yml / guide.list 登记的标题对齐 |
| test | llmgw | 内嵌面新增 2 组守卫（现状必须真的走到那条分支 + 三种坏法逐个必须报错） |
| fix | llmgw | 批量导入的多模态模型判成 chat 而不是 vision：带图对话走的就是 chat 端点，判 vision 会让 gpt-4o 这类模型接不了普通文本请求 |
| fix | llmgw | /v1/models 只报显式声明 USD 的价格：缺币种此前落进报价分支，而 pricing 段 label 写死 USD |
| fix | llmgw | /v1/models/{id} 改 catch-all 路由并认百分号编码，带斜杠的 PublicId 终于取得回来 |
| fix | llmgw | 调用全貌结论补上「上游模型被停用」这第三种跳过原因，不再输出「0 条全被停用」 |
| fix | prd-api | 声明「没有尺寸概念」的生图模型不再发任何尺寸参数（此前白名单为空会兜底成 1024x1024） |
| chore | llmgw | 30 个 changelog 碎片按规则 #4 合并成一个 |
| docs | llmgw | 台账新增：对外模型删除没有保留窗口，会打断在途的异步视频任务 |
| fix | llmgw | 生图契约刷新器搬进 Infrastructure 并在 serving 也注册：此前控制台配的契约对网关的生图请求完全不生效，而界面显示「已同步」 |
| fix | llmgw | 模型编辑抽屉判据改成「动没动过」：清空价格删得掉了，只改名字也不再把上游价谎报成人工价 |
| fix | llmgw | 最大输出 token 补显式清空标志，兑现界面上「留空表示不限制」那句话 |
| fix | llmgw | /v1/models 补上场景能力判据：分层这类动作能力模型不再列给普通生图调用方（列出来一调就失败） |
| fix | prd-api | 半开探测失败时作废人工恢复通行证，否则坏线路被每个后续请求反复抢去当队首，冷却形同虚设 |
| fix | llmgw | 「算不出钱的笔数」两处都补上 stale_currency，不再报「0 笔未计价」 |
| fix | llmgw | 调用全貌面板不把缺币种的价标成 USD（上一轮只修了 /v1/models 那一处，同类没横扫） |
| security | llmgw | 兼容入口拒绝客户端自带的 pinned_platform_id / pinned_model_id：池退场后那道调用方边界没了，一把 key 只要知道内部 id 就能调任何启用的物理模型 |
| fix | llmgw | 发布门禁两条池判据换成对外模型可达性，不再让正确配置的调用方卡住发布且无处可修 |
