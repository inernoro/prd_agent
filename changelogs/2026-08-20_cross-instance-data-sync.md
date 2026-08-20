| feat | prd-api | 新增跨 MAP 实例数据同步：动态授权（跳转源站、管理员当场勾选并同意、PKCE 换一次性导出令牌），只执行一次 |
| feat | prd-api | 新增导出白名单 DataSyncScope：270 个集合逐个分类，敏感字段在源站出口清空；CI 强制新集合必须分类 |
| feat | prd-admin | 新增数据同步三屏：源站同意页（默认全选、列出不会带走的集合）、回跳落地页、执行页（执行前对照表 + SSE 进度 + 待补密钥清单） |
| fix | prd-api | 同步进度的 SSE 与 GET 统一 camelCase 字段名，避免同步跑起来时前端读不到进度 |
| docs | doc | 新增 design.platform.cross-instance-data-sync 与 debt.platform.cross-instance-data-sync（含附件绝对地址待纠正项） |
| chore | prd-api | Core 的 MongoDB.Bson 从 2.25.0 对齐到 2.29.0，与 Infrastructure 的 Driver 版本一致 |
| fix | prd-api | 同步 API 前缀改为 api/instance-sync：原 api/data-sync 会被 AdminController("data") 的裸前缀匹配吃掉，匿名换票与导出端点在真实部署上返回 401 |
| fix | prd-admin | 同意页与回跳页自己应用明暗偏好：两页在 AppShell 之外，此前切浅色仍是暗的（真机取证发现） |
| fix | prd-admin | 数据同步入口归到「全部能力」的基础设施分组：百宝箱卡片网格要求每张卡有独占插画素材，它是运维入口不是智能体 |
| fix | prd-admin | 数据同步补进 buildStaticInfra：「全部能力」页的基础设施分组读的是这份手写清单而非 NAV_REGISTRY，只登记后者会导致真人在页面上找不到入口 |
| test | prd-admin | 新增 launcherInfraCoverage 棘轮：NAV_REGISTRY 的 infra 入口若没同步接进 buildStaticInfra 即 CI 红，已知未接的 5 条只许减不许增 |
| feat | prd-admin | 数据同步起始屏补历史列表：接上一直没人调用的 GET /api/instance-sync/runs，可回看任意一次同步、一键复用上次的源站地址；空态改为讲清四步流程而非留白 |
| security | prd-api | 同步消费方的 plan/start/get/list/stream 补判管理员：此前只有 prepare/callback 判了，任何登录用户拿到 pending 的 runId 就能带 overwrite=true 把数据写进共享库；新增守卫测试逐个 action 钉死 |
| security | prd-api | 源站 scope-catalog 补判真人管理员：此前只写了 [Authorize]，任何登录用户都能拿到全站集合清单与逐集合条数；守卫测试扩到源站，带 [Authorize] 的端点必须调 ResolveAdminIdentityAsync |
| security | prd-api | 横扫可导出集合里所有长得像凭据的字段，补 15 个集合的出口脱敏（知识库跨环境同步令牌、自动化 webhook 密钥、各类分享链令牌、周报数据源令牌、工作流定时口令、llmconfigs 密钥密文等）；并把这次横扫做成守卫，新字段没交代即 CI 红 |
| security | prd-api | 同步跑到终态时目标站主动交还导出令牌、源站当场作废；此前界面说「一次性同步已结束」而票在源站眼里还能再用近两小时 |
| fix | prd-api | 试跑不再把「打算写」记成「写了」：新增 PlannedInsert/PlannedUpdate，Inserted/Updated 只在真跑时累加 |
| fix | prd-admin | 试跑的进度与历史列表改显示「预计新增 / 预计写入」，不再对着一次没写库的试跑显示「写入 N 条」 |
| feat | prd-api | 源站允许名单支持在同意页上当场准入：来源不在名单时管理员额外勾一次即同时开启对外同步并记入名单，落 AppSettings 无需重启（原 DS6） |
| feat | prd-admin | 同意页新增当场准入确认块：点名是哪台机器在要数据，没勾确认前「同意」按钮不可点 |
| fix | cds | 冒烟 L3 改读被测应用自己的 AI key（MAP_AI_ACCESS_KEY），不再复用 cdscli 连 CDS 的那把；缺 key 或缺冒充用户时判为跳过并说明缺什么，而不是报成应用 401 |
| docs | doc | design 文档 H1 补 `· 设计` 后缀与 index/guide.list 对齐，修复 docs-readability 标题漂移 |
| docs | doc | 台账补 DS13（当场准入只能加不能删）与 DS14（交还令牌失败不重试）；DS5 真人视觉验收、DS6 源站名单入口标为已解决 |
| fix | cds | 冒烟 L3 用回退 key（AI_ACCESS_KEY）拿到 401 时给出提示，指明这把可能不是被测应用的 key，而不是让人以为应用坏了 |
| feat | prd-api | 新增 GET/PUT /api/instance-sync/provider-settings：读写本站对外同步开关与允许名单，名单每条都过形状校验（原 DS13） |
| feat | prd-admin | 同步页新增「本站对外同步」卡片：看得见已允许的机器、逐条可移除；此前当场准入只能加不能删 |
| fix | prd-api | 批量插入撞唯一索引不再判整次同步失败：只有全部错误都是重复键才按「跳过」计入 Skipped 并继续，其余错误照旧上抛；此前一条冲突就会让已写入的部分不计数、后面的集合全被放弃 |
| fix | prd-api | 待补密钥清单改用源站上报的 clearedFields，不再由目标站看「字段是不是空的」自己推——后者会把源站从来没配过的密钥也列成待补 |
| fix | prd-api | 同步进度 SSE 补 10 秒心跳（server-authority #4）：慢导出期间进度长时间不变会被 ingress 空闲超时掐断，前端当成正常收尾不重连，屏幕永远停住 |
| fix | prd-api | 服务关停时把认领中的 Run 落到 failed 终态、且收尾一律用 CancellationToken.None（server-authority #5）：此前重启后内存令牌已失、没有 worker 能再认领，历史页上那条 Run 永远转着 |
| security | prd-api | 邀请码补脱敏（groups.InviteCode / teams.InviteCode）：那是「拿着它就能加入这个私有群/团队」的通行证，只是名字里没有 token；守卫的关键词表同步放宽到 invitecode / otp / signature / salt 等 |
| fix | prd-api | 启动同步改为原子认领（更新条件带 Status=pending，没改到就回 409）：此前两个并发 Start 都会成功，后到的还能把 DryRun 从 true 改成 false——用户点的是试跑，worker 拿到的却是真写库 |
| fix | prd-api | 源站清单解析失败改为 fail closed：此前退回空列表，对照表显示「0 个集合」而开始按钮照样能按，worker 随后把 Run 里每个集合都同步一遍，等于绕过确认关口 |
| fix | prd-api | 允许名单被显式清空时不再被环境变量顶回来：null 才落回环境变量，空串是一次明确的撤销 |
| fix | prd-admin | 登录守卫保留 URL fragment：授权码走 #code=... 回跳，登录一插进来旧实现会把它当 hash 路由，码就丢了、整条授权链要重走 |
| feat | prd-api | 同步前先握手对版本：新增匿名 GET /api/instance-sync/handshake 报站点名、协议版本与构建号；目标站在跳转前打一次，版本不一致就当场拦下，不再等跑到一半才发现两站字段结构对不上（原 DS7） |
| feat | prd-admin | 输入源站地址后自动探测：认出对方站点名与版本才让你跳过去授权，探测失败直接说明是打不通还是版本不合 |
| feat | prd-api | 同步用户账号时可连口令散列一起搬（IncludeCredentials）：搬过去原密码直接能登，不再要求管理员逐个重设（原 DS2）；不勾时维持旧行为，出口清空散列并标记需重设 |
| feat | prd-admin | 同意页收敛成一个决定：默认全给，13 个分组折进「想只给一部分？展开逐类勾选」；「让对方能直接用原密码登录」作为一个复选项默认勾上 |
| feat | prd-api | 新增 MAP_ADMIN_FORCE_RESET 开关：置 1 时启动会把已存在的管理员账号按 MAP_INITIAL_ADMIN_* 重置回可登状态；此前 EnsureAdminUserAsync 见到有管理员就直接返回，改了初始账号配置也永远不生效 |
| feat | prd-api | 新增 POST /api/v1/auth/change-password 自助改密：验旧密码、抬两端 tokenVersion 并清 refresh 会话作废别处登录，当前这一端换发新令牌继续用；此前只有「首次登录被强制改」一条路 |
| feat | prd-admin | 账户设置新增「登录密码」卡片：随时自助改密，ROOT 应急账户明说改不了并指路正式账号 |
| fix | prd-api | 执行范围以确认时的清单为准：Run 落 PlannedCollections，开始时清单为空直接回 DATA_SYNC_PLAN_REQUIRED，worker 只跑这份清单 |
| fix | prd-api | 出口脱敏按原类型清：字符串清成空串、其余清成 null；此前一律写空串会把 bool? 与数组字段变成字符串，目标站反序列化直接炸 |
| fix | prd-api | 强制重置管理员时先按用户名找目标：目标用户名已被另一个账号占着时重置它、而不是把手上这个管理员改名撞过去；捞到的若不是管理员则一并对齐角色 |
| security | prd-api | workflows / workflow_schedules / automation_rules 三个集合改为不导出：它们的凭据藏在嵌套结构里（Variables[].DefaultValue 带 IsSecret、VariableOverrides、Actions[].WebhookSecret），而出口脱敏只认顶层字段名，登记了也是空转 |
| test | prd-api | 凭据守卫扫描扩到一层嵌套：集合实体的属性若是另一个模型类型，逐个字段一起追问；同时禁止豁免名单留死条目 |
| test | prd-api | 新增守卫：登记的脱敏字段必须在实体顶层真实存在。当场查出 automation_rules 与 hosted_sites 两处空转的脱敏登记 |
| fix | prd-api | 批量插入只在「没有写关注错误且全部是重复键」时才按跳过咽下：写关注失败不带任何 WriteError，原判据在 0 == 0 上恒真，一次持久性未知的写入会被计成成功 |
| fix | prd-admin | 同意页的承诺文案随「连登录口令一起给」联动：勾上时逐字段行显示「PasswordHash 会带走」、页脚明说对方将能用这里的账号密码登录，不再一边导出口令散列一边写「口令一律留在本站」 |
| fix | prd-api | 对照表报的脱敏字段改用「按本次批准条件真正会清的那一份」：判定抽成 DataSyncScope.ApplyGrant，清单与导出同走一个出口；此前勾了「连口令一起给」，导出放行 PasswordHash 而清单仍说它已清空，目标站管理员是对着一份与事实相反的对照表点的确认 |
| fix | prd-api | 服务关停这条终态路径也交还导出令牌：此前只顾了成功与异常两条，关停时本地令牌被忘掉、源站那张票却还能再用近两小时，且重启后没人记得去作废它 |
| fix | prd-api | Plan 落 PlannedCollections 的更新加 Status=pending 条件：Start 之后清单必须冻住，否则另一个标签页再调一次 Plan 就能换掉执行范围——人按下开始时看的是一份，worker 跑的是另一份 |
| test | prd-api | 「只对 users 开一个口子」从扫源码改成断言 ApplyGrant 的返回值，并补一个合成输入（换个集合名、同样带 PasswordHash）钉死集合名判断——原来那圈遍历真实集合的断言其实证明不了它，把集合名判断整个删掉也不会红 |
