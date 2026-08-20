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
| security | prd-api | appsettings.PasswordLoginDisabled 补脱敏：源站关了口令登录、而与它配套的 SSO 密钥与回跳地址恰恰被清空，同步完目标站除 ROOT 破窗账户外谁也进不去；守卫加一条自洽断言——SSO 必要字段被清空时这个开关就不许跟着过去 |
| fix | prd-api | 导出页里非字符串元素改为直接失败：此前静默丢弃、游标照常前进、集合报成功，等于把「documents 不是数组」那个洞往下挪了一层 |
| fix | prd-admin | 进度流断开后自动重连并补拉快照：此前 effect 只依赖 runId 与 status，代理抖一下把流掐断后 status 恒为 running、effect 再也不重跑，页面永久停在最后一帧而同步还在后台跑；重连带指数退避，每次先 GET 一次以便流始终连不上时仍能拿到终态 |
| security | prd-api | 票据校验每次拿当前允许名单重对一遍回跳地址：此前只看全局开关，把某台机器移出名单时只要名单没空、开关就还开着，那台机器手上没过期的票照样能读数据最长两小时——撤销入口写着「移除」却要等票自己过期 |
| test | prd-api | 补两条守卫：移出名单后那张票必须失效（纯函数断言），以及 ResolveExportGrantAsync 必须真的调用它（源码接线守卫——这条接线删掉编译过、全量测试也绿） |
| fix | prd-admin | 起始屏首次使用引导的承诺文案与同意页默认行为对齐：此前无条件写「口令一律留在源站」，而同意页默认勾着「连登录口令一起给」 |
| docs | doc | 设计文档的范围表跟上实际：账号与组织那行改为「口令散列默认跟着走」，新增「本站自有状态」与「凭据嵌在结构里的集合永不导出」两行，删掉已不再导出的工作流定时任务口令 |
| fix | prd-api | 本站不认识的集合不再进执行清单：源站升级后新增的集合会带着真实条数出现在对照表上、看着就是要同步的，worker 到跟前 TryResolve 失败跳过、整条 Run 照样报成功。Plan 改为把它们标成「本站不支持、不会同步」并排除出 PlannedCollections；worker 万一仍遇到则判失败而不是静默跳过 |
| fix | prd-api | 令牌在「Start 成功之后、worker 下次轮询之前」过期的 Run 不再永远停在 running：HeldRunIds 清理过期条目时留一份 id，worker 拿它把这些 Run 落终态（只处理本进程握过的，不碰别的部署） |
| fix | prd-admin | 断流重连时快照请求也失败的话安排下一次退避重试：此前直接 return，status 与 phase 都没变，effect 再也不会跑，网络恢复后页面依然永久冻住 |
| fix | prd-admin | 对照表把「不会同步」的行讲清楚：源站没有这个集合、或本站版本还不认识它，都在最后一列点名原因，条数列显示破折号而不是 -1；这两个标记后端早就算出来了，此前没渲染，那些行和正常行长得一模一样 |
| security | prd-api | user_shortcuts 移出白名单：TokenHash 上有唯一索引，而脱敏把它清成同一个空串——多条捷径只有第一条插得进去，其余撞重复键被计成「跳过」、整条同步还报成功；何况散列清掉后这条捷径永远认证不了，搬过去只是死数据 |
| test | prd-api | 新增守卫：登记了脱敏的字段不许落在唯一索引上。这是「清空」这个手段与唯一约束的天然冲突，钉通则而不是钉某个字段；解析 MongoDbContext 的索引定义做交叉比对 |
| fix | prd-admin | 待补密钥卡片区分试跑：试跑没写库，那些字段此刻在本站根本不存在，文案改成「真跑之后要补」，不再把人支去翻一批没导进来的记录 |
| fix | prd-api | nextCursor 类型不对改为直接失败：此前当成 null，调用方据此判定这个集合拉完了、置 Done=true，后面所有页一条不落地而 Run 报成功 |
| feat | prd-admin | 对照表在勾了 users 时给出身份冲突告警：两边各自初始化过同名账号会留下两行同名用户（Username 是非唯一索引），按用户名登录拿到哪一个不确定；提示同步后去用户列表确认 |
| docs | doc | 台账新增 DS18（跨实例身份归并缺失），写明主场景为何不受影响、出问题的是哪一种、以及根治为何是独立 PR 的量级 |
| security | prd-api | 授权范围冻结在签发那一刻：grant 原来只记分组 key，清单与导出各自按**当前**白名单重新展开——源站在票的两小时有效期内上线一个新集合并归进已批准分组，这张老票立刻就能读到批准人从没见过的数据。改为签发时把展开结果冻进 grant，换票/清单/导出一律按它判；存量票没有该字段时退回按分组展开（那是它们签发时的语义），两小时后自然过期 |
| security | prd-api | MAP_ADMIN_FORCE_RESET 改为一次性：容器环境变量是持久的，原来每次进程启动都会重跑，把管理员后来自己改的密码悄悄改回部署配置里那个救场口令。改为记下用过的**开关值**（不记任何口令派生物），值没变就不动手；要再救一次把开关换个值。标记落在新集合 deployment_markers（不可导出）而不是 AppSettings——后者会被跨实例同步带走，等于把目标站的一次性动作重新武装或提前吞掉 |
| fix | prd-api | clearedFields 形状不对改为直接失败：此前 fail open，文档照样入库、Run 照样成功，而管理员不知道哪些凭据要补，相关集成静默不可用。上一轮我声称这一页字段「都过了一遍、没有第四处」，漏的就是它 |
| test | prd-api | 新增守卫：授权范围必须冻结在签发那一刻（签发时写入 + 三处按冻结清单判 + 导出不许退回按分组判） |
| docs | doc | 设计文档补「授权的范围冻结在签发那一刻」一节：说清只记分组会让票跟着白名单变宽，以及冻结只收窄不放宽 |
| security | prd-api | 跨实例同步的全部出站请求（握手 / 换票 / 清单 / 导出 / 交还令牌）改走 SafeOutbound 客户端：源站地址是管理员填的，默认客户端会让 https://127.0.0.1 或一个公网地址 302 跳内网，把 API 服务器变成打自己内网的跳板 |
| fix | prd-api | 文档字符串为空白时判失败而不是跳过：原来 continue 掉，这一页少一条、游标照常前进、Run 报成功 |
| fix | cds | 冒烟覆盖不全改为独立退出码 3，cmd_deploy 单独识别并把结论改成「已完成，但冒烟覆盖不全：…」。此前覆盖不全走 ok()（退出码 0），上层只看非零，照样打印「deploy 流水线全绿」——同一个假绿第三次回潮，前两次我改的注释和 note 调用方根本读不到 |
| test | cds | 新增 scripts/tests/test_cdscli_smoke_coverage.py 钉死上面两条，并把 cdscli.py 登记进 ci.yml 的 release_scripts 路径过滤——不登记的话只改 cdscli 的 PR 会整个跳过这道闸 |
| fix | prd-admin | 对外同步名单的连续改动串行化：两次快速移除原来都基于同一份没变过的 settings，后到的那次会把已撤销的机器放回去（而票据鉴权每次都读这份名单，等于撤销被悄悄取消）。改为传「怎么改」而非「改成什么」、乐观更新、保存期间禁用输入 |
| test | prd-api | 「空串与空集合不产生文档」这条用例原来把两者一起断言成空，等于用测试把「静默丢掉坏数据」钉死成正确行为（形状 4a）。拆开：空集合仍为空，空串/全空白改为必须抛，混在正常文档中间的空串同样抛 |
| test | prd-admin | 把对外同步名单的串行化抽成 serializedSave.ts 并补回归：本仓库前端没有 jsdom/RTL，逻辑留在组件里就没有任何东西钉得住「第二次改动必须看到第一次的结果」。四条行为用例（连续移除不放回、在途不接新改动、失败回滚、服务端回值优先）+ 三条接线守卫（getLatest 读 ref 而非渲染期快照、ProviderCard 收 mutator 而非值、页面用共享 helper 而非另抄一份） |
| docs | doc | 台账新增 DS19：对外同步名单没有乐观并发控制，跨标签/跨人同时改仍是后写覆盖先写。这次只修掉同一标签内的连续改动，跨端那一半要么加版本号要么把接口从整份覆盖改成增量，都动契约 |
| security | prd-api | 一次性迁移标记不随同步搬运：`appsettings` 覆盖写是整份替换，源站的 `CompletedOneTimeMigrations` 会顶掉目标站自己的执行历史——本站没跑过的迁移被当成跑过而跳过（权限缺失），或管理员手工回退过的被当成没跑过而重来（撤销的权限自己长回来）。清空也不行（等于全部重跑）。新增 PreserveFields 语义：出口整个删字段、写入前把目标站原有那份接回来，源站硬要送也以本站为准 |
| fix | prd-api | 待补清单只记真的落地了的文档：不覆盖模式下同 _id 被跳过、本站凭据原封不动还在，此前照样记进待补清单，等于诱导管理员去改坏一个能用的配置。改为按写入/将写入的文档逐条看字段在不在，整页都被跳过就不产生待补项 |
| fix | prd-api | 无人认领的 running Run 周期收尸：Start 已落 running、进程随即被硬杀（OOM/容器重建）时令牌随内存消失，重启后新进程的 vault 是空的，这条 Run 永远选不中也永远停在「进行中」。判据只用「15 分钟没心跳」——活着的 Run 每页都刷 UpdatedAt，所以共享库上兄弟部署正在跑的那条不会被误杀 |
| fix | prd-api | 源站地址不再放行回环：出站一律走 SafeOutbound，而它按解析地址挡掉回环段，于是 http://localhost:5001 这种地址在表单校验「通过」、到握手必然连不上且错误信息指不到原因。改为当场判「不支持」。浏览器回跳地址那一侧的回环豁免保留（两条通道的可达性判据本就不同），并加用例钉住这个不一致是有意的 |
| fix | cds | deploy 只输出一份结果：cmd_smoke 走 die() 会先打印一份 ok:false，cmd_deploy 接住 code=3 之后又打印一份 ok:true——机器读到两个 JSON 文档等于都不能信。新增 _nested_call() 让内部调用的 ok()/die() 把 payload 交给调用方而不是自己打印 |
| test | prd-api | 新增守卫：迁移执行历史属于目标站本地（出口删字段 + 写入接回 + 源站硬送也以本站为准 + 本站没有时不写空值 + 两头接线都在），待补清单只记落地文档（四条行为 + 两条接线），回环在出站禁止但在回跳允许 |
| test | cds | 冒烟守卫补两条：deploy 调 smoke 必须包在 _nested_call() 里，die/ok 的抑制判断必须在打印之前 |
| fix | prd-api | 批量插入部分失败后按**失败下标**剔除，不再砍末尾 N 条：IsOrdered=false 时冲突可以落在任意位置，砍尾巴数量对、身份错。计数看不出差别，待补清单看得出来——它要拿这批文档逐条看字段在不在，认错人就会漏报一个真需要补的凭据，或替一条根本没写进去的文档报一个假的。判据抽成 DataSyncApply.SurvivingInserts |
| docs | doc | 台账新增 DS21：worker 串行执行，排队中的 Run 界面显示「进行中」却无进度（票过期时会被既有收口落成终态并给出原因，所以不是静默卡死）。加 queued 态或并发上限都是新语义类别，记入后续 |
