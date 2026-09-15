| fix | cds | 合并主干后修复主域默认站选取：根路径声明与按名兜底都在分支声明过的全部服务里选，主入口不可路由时不发默认路由，避免主域滑到兄弟网关 |
| security | cds | OpenDesign 会话必须由已验证的 MAP 连接来源发起，workspaceTransfer 的下载与回写地址逐一钉在该来源上，堵住项目级 Key／全局 Key／仪表盘 cookie 三条路径下的 SSRF |
| fix | prd-api | 原生 Responses 非流式响应改为先读完校验再交付，上游 200 却缺终态或内容类型不符时如实返回 502，不再让调用方读到一次干净的 200 加残缺输出 |
| fix | llmgw | 流式原生响应在终态缺失时可观测地终止（补 error 事件并中断连接），不再干净收尾冒充完整成功流 |
| fix | prd-api | 完整版本预览的可嵌入来源跟随已声明的 Cors:AllowedOrigins，跨源部署下 iframe 不再被 frame-ancestors 'self' 挡成空白；跨站嵌入时预览票据 cookie 降到 SameSite=None，同源部署维持 Strict |
| fix | prd-admin | 知识条目选择弹窗不再在容器上叠整体内边距（会和分区内边距叠起来），并把钉死共享弹窗实现的那条断言收回本组件自己的契约 |
| fix | prd-api | OpenDesign 运行时数据面放行清单补上 llm/v1/responses（Codex 运行时用的正是 responses 协议），并加反射守卫防止新增端点再漏登记 |
| fix | cds | 连接凭据放行 MAP 的单条会话回读（instance:read），停止返回不可判定错误时才分得清「已经没了」与「真失败」；会话列表仍不开放 |
| fix | prd-api | 设计运行时模型代理不再吞掉上游刻意造出的中断：已发头就同样中断下游，未发头返回 502 说明被上游中断，调用方断开仍保持安静 |
| test | prd-api | 原生 Responses 终态失败用例不再断言「已转发字节仍在」——abort 与缓冲刷出是竞态，那条断言会随机红；判据收敛为「要么中断、要么有 error 事件，且不能干净收完残缺内容」 |
| fix | prd-api | 网页生成与改写把网关 Start 分片解析出的实际模型透出成 model 事件并落到 run 上，面板顶部按「模型 · 平台」展示，满足 ai-model-visibility |
| fix | prd-admin | 生成弹窗与改写面板订阅 model 事件并在顶部渲染实际模型与平台，值全部来自后端不推断 |
| ops | cds | 索引目录退出部署链路：撤掉 mongodb-indexes 一次性容器与 api 对它的启动依赖，索引仍由 DBA 手动跑，并补守卫防再加回来 |
| fix | prd-api | 实际模型落库补上：worker 逐字段写库，原先只改内存对象，导致 run DTO 字段在而值恒为 null，刷新后面板显示不出模型 |
| fix | prd-api | 公开生成流的事件白名单补上 model，否则 worker 发出的模型事件在 SSE 出口被静默丢弃，前端永远收不到；并加守卫按 worker 实际 append 的事件名逐一比对白名单 |
| security | cds | 伙伴侧 workspaceTransfer 的下载与回写一律不跟随重定向：会话创建时钉死的 origin 在 3xx 之后不再成立，改走唯一入口 fetchPartnerTransfer 并把 3xx 判成失败，另加接线守卫防止新调用点绕过 |
| fix | prd-api | 刷新恢复读回的 run DTO 补上 ResolvedModel／ResolvedPlatform，否则模型事件只在流的开头出现一次，刷新之后徽章再也回不来；并加守卫对齐两个 Controller 的 run 投影 |
| fix | prd-admin | 生成弹窗与改写面板的恢复路径读回模型徽章，且弹窗重开时清空上一轮模型（常驻挂载，不清会把上一轮的模型当成本轮的显示出来）；平台兜底称谓收敛成共用常量 |
| fix | prd-api | 删除站点遇到发布租约而推迟清理时不再往团队活动流记「删除了站点」——202 也是 2xx，会被记成已完成的删除，而站点还在；改用过滤器既有的抑制钩子，等真删掉再留痕 |
| fix | prd-admin | 生成弹窗的恢复轮询把 NOT_FOUND 当终态收尾（停 generating、清 sessionStorage 旧 run），不再把永久失败当断线每 1.5 秒无限重试、让用户连下一次生成都发不起来；改写面板原本就是这么处理的 |
| fix | prd-admin | AI 调整大纲时把当前知识来源一并带进新的大纲 run，原先传空数组会让确认生成撞上后端的来源一致性校验（409 outline_knowledge_mismatch），知识驱动的 PPT 一经调整就再也生成不出来 |
| fix | prd-api | 实际模型落库改走与 phase 相同的租约闸：丢了租约的 worker 不再覆盖接管者写入的模型、也不再推一条骗人的 model 事件，未命中即按租约丢失停手 |
| fix | prd-api | Redis 投影不可用时的 Mongo 兜底补发 model 事件（生成流与改写流各一处），值就在库里，不补的话「读不到模型」跟「这次没有模型」长得一模一样 |
| fix | prd-admin | 删除被发布租约推迟时不再把卡片抹掉：两个单站点删除处理器改为先看 deleted 再决定，如实留住卡片并说明在等什么 |
| test | prd-api | 模型落库守卫从钉住实现字面量改为断言行为：原先断言 `Set(item => item.ResolvedModel` 这串写法，补租约闸把写入抽成 PersistResolvedModelAsync 后 lambda 形参改名，守卫就红了而代码其实更对——反向锁死住实现的断言（形状 4a）换成「模型分支必须调落库方法、落库方法必须写这两个字段」 |
| fix | prd-api | 设计模型代理超时且已发过响应头时中断下游连接：不中断的话 Kestrel 会把它收成一次干净的 200 EOF，超时被抹平，调用方读到「完整的成功」；上一轮只给上游中断那一支加了 Abort，超时这一支漏了 |
| fix | prd-api | 改写流的 Mongo 兜底补发 model 事件时去掉 !redisProjectionAvailable 条件：该标志只在本 Controller 读 Redis 失败时才翻，而 worker 的写入侧独立失效，写侧挂了读侧好着就会把模型事件永久抑制 |
| fix | cds | 基础设施维护 job 记进程代次，读取点先把上一个进程遗留的 active 收敛成 failed：执行体只活在进程内存里，CDS 在 begin 与 finish 之间重启会让这条记录永远挡住凭据轮换且无从清理 |
| docs | cds | compose 就地写明 llmgw-serve 的就绪声明实为存活检查（readyz 带密钥门、CDS 探针匿名且把 401 当就绪），三个候选方案与取舍记入 debt 台账待作者拍板 |
| security | cds | 密封旧版迁移凭据前先脱敏日志：publicDataMigration 靠 source/target 上的明文密码比对着抹掉 log/progressMessage/errorMessage 里的密码，密封把明文拿走后就再也抹不掉了，存量 migration.log 里旧管线写进去的 --password <secret> 会从接口原样吐出且永久留存 |
| security | cds | 凭据升级的落盘顺序改成备份在前、主文件在后：该流程只在「主文件报告发生变化」时触发，先写主文件则崩在中途会让备份里的明文永远不再被重扫；倒过来写则崩溃后下次启动仍能检测并续跑 |
| perf | prd-api | 版本历史列表排除整页 HTML 与文件字节数组：一条记录可带多兆的整页与整包文件，列表一次取 100 条而对外只映射元数据，不排除就等于打开版本面板即分配几百兆；「只带元数据」同时写进接口契约，不在实现里偷偷 Project |
| fix | cds | 凭据轮换的 verify 与 enumerate 对齐判据：认哪个应用连接键改用 profile 自己声明的键（写死 .NET 键名会让靠 ${CDS_*_URL}/MONGO_URI/DATABASE_URL/CACHE_URL 接入的消费者查无此键、整次轮换回滚），就绪探测改走 profile 声明的路径而非按 api/llmgw 命名设白名单；已知形态仍做深度校验，认不得的退到「声明的探针返回 200」 |
| fix | prd-admin | 团队空间里「引用知识生成」的网页也归属该团队与分组：归属逻辑抽成共用函数，上传与生成两条创建路径共用；深链直接开生成弹窗时也快照当前空间，不再沿用上一次的旧值 |
| fix | prd-admin | 主区外边距四边同宽：外壳桌面分支 px-4 py-3（左右 16、上下 12）改为 p-4，消除方向差 |
| fix | prd-admin | 网页托管桌面端不再渲染那个恒为空的 toolbar 包裹层：它高度为 0 却仍是 flex item，和下一个子元素之间白吃根上的 gap-4，把整页内容多推下去 16px（顶部实测 29px、左侧 17px 的来源之一） |
| fix | prd-admin | 生成弹窗的 sessionStorage 访问全部收敛进带 try 的封装：那次写入夹在「服务端任务已创建」与「进入流式 try」之间，隐私窗口/配额用尽时会抛异常并就地中断——服务端继续生成，弹窗永远停在「正在校验所选知识」 |
| fix | prd-admin | PPT 页不再把知识正文写进 session（正文可达数兆且同一份存两遍）：超配额时 saveSession 静默吞掉、快照停在上一版，刷新后连 runId 都恢复不出来；恢复只需身份，正文不落盘 |
| test | prd-admin | 终态分支守卫改断言行为而非 sessionStorage.removeItem 的字面拼写——收敛进封装后它会红而代码更对（形状 4a，今日第二次同形） |
| security | cds | 旧版迁移日志里「紧跟密码旗标的那一个值」不看长度一律掩掉：创建接口对口令长度没有下限，一两位的口令会跳过 length>=3 的整串脱敏，而密封紧接着拿走明文，那串密码从此永久留在 GET /data-migrations/:id/log 里 |
| refactor | cds | 旧版迁移遗留文本（log / progressMessage / errorMessage）的脱敏收敛成唯一口径 redactLegacyMigrationText，升级与对外投影两处共用，不再各写一套 |
| fix | prd-admin | 生成任务恢复不到（NOT_FOUND）时不再谎称「原来的知识与要求仍保留，可以直接重新生成」：打开弹窗已清空要求、无 initialSource 时连知识也清空，生成按钮此刻是禁用的；文案改为按真实状态分两种说法 |
| fix | prd-api | 保存分享时复制循环的三个早退出口统一先清理已上传对象：出口都排在 InsertManyAsync 之前，那批对象没有任何 HostedSite 认领也没有清理账本，而去重那关看的是 HostedSite，插入没发生就不算数，用户每重试一次都会再留下一批孤儿对象 |
| fix | prd-api | 改写流的 Mongo 兜底补发 phase 也去掉 !redisProjectionAvailable：写侧独立失效时该标志恒为 true，阶段与进度会被一路抑制到终态，用户盯着几分钟不动的进度而库里一直在推进；补一条守卫钉住两条流的四处补发都不看读侧健康 |
| fix | prd-admin | 分享页修改坞的 Escape 只关最上面那一层：嵌套的知识选择弹窗在捕获阶段已处理并 preventDefault，坞不再把同一次按键当成关自己，避免连带丢掉还没保存的修改要求 |
| fix | prd-api | 保存分享的复制阶段外面再罩一层 catch → 收尾 → 重抛：finally 里释放借用围栏那步写 Mongo 失败时，异常会直接穿过整个方法、一个 return 都不经过，已上传的对象照样无主无账本 |
| fix | prd-admin | Escape 只关最上面那一层：预览浮层与分享页修改坞共用同一个 shouldCloseOnEscape，嵌套弹窗已处理掉的按键不再连带关闭外层、丢掉未保存的修改要求 |
| fix | prd-admin | 改写面板的模型徽章在进入 generating 的同一拍清空：原先排在创建任务之后，创建期间顶上挂着上一轮的模型，创建失败时更会把它留在一次根本没发生的调用上 |
| fix | prd-admin | 知识条目落盘只扔正文、留篇幅：页数估算靠的正是篇幅，刷新后一篇长文档原本会被估成最低 4 页，而服务端严格按客户端给的页数执行 |
| fix | cds | env 文件目录 fsync 的路径为空时退回当前目录：CDS_ENV_FILE 写成相对文件名时 dirname 是空串，os.open 当场抛，而它排在 mv 之后——文件已换好却报失败，strict 模式下留半套配置。两处写法一并修 |
| fix | cds | 凭据轮换读部署结果改为解析 SSE 终态帧并要求 complete 的 ok 为真：原判据是「出现 event: complete 或任意 "ok":true」，而失败部署同样发 complete（只是 ok 为 false），于是失败被读成成功，下游继续走向撤销旧凭据 |
| fix | cds | OpenDesign 产物导出改用本次会话真正在跑的镜像：能力探测、准备、主会话都走 this.image，只有导出退回编译进来的默认镜像，离线节点上会整轮跑完只在导出失败，且失败指向一个与本次运行无关的镜像 |
| fix | prd-admin | 生成弹窗的模型徽章也在进入 generating 的同一拍清空：与改写面板同一处判据的另一半，不关弹窗再发起一次生成时，创建期间顶上挂着上一轮的模型，创建失败时更会留在一次根本没发生的调用上 |
| fix | cds | 维护 job 落盘失败时先摘掉内存里那条预约再抛：它盖的是当前代次而收割器只收上一代，调用方又拿不到 handle 去 finish，一次写盘抖动就把该服务的凭据轮换钉死到进程重启 |
| feat | prd-api | 分享响应逐站点带上 viewerCanEdit：由后端用编辑端点那同一道角色门算出（抽成 CanEditSiteAsync，编辑入口自己也改走它），匿名恒为 false |
| fix | prd-admin | 分享页编辑坞的门改用后端给的 viewerCanEdit，不再拿 createdBy（「谁建了这条分享链接」）当编辑权判据——团队编辑者可建分享，旧判据会让真正的站点主人进不去、只建过链接的人反而看得见 |
| feat | prd-api | 生成任务的目标团队随创建请求冻结到 run 上，并在用户还在场那一刻用 CanPublishIntoTeamAsync 校验（不通过当场 403）；建站时由服务端应用，失败原因记在 run 上并随终态事件下发 |
| fix | prd-admin | 生成弹窗把目标空间随请求送出（打开那一刻冻结），完成回调不再自己归属团队——用户在终态前关掉页面时那条回调根本不会执行，网页会静默留在个人空间 |
| fix | llmgw | 控制台就绪探针超时时真的取消下游 Mongo 探测：原先只让调用方走人、探测留在后台跑，Mongo 掉线期间每 5 秒堆一条在途操作；外层仍留一层 5 秒上限，探测实现不认令牌时也成立 |
| fix | prd-api | 公开创作者榜里任一头像查存在性失败不再打成 500：这条校验只为「别把已删对象露出去」，查不清就按头像不可用降级、前端退回首字母占位，降级留痕，调用方取消仍照常上抛 |
| docs | doc | debt.platform.open-design 记第十五轮复审三条的处置：百宝箱 wip 那条不改（网页托管在主干早已是无 wip 的正式导航项，只是补了移动端入口），OpenDesign 模型分片维持 B 类，另两条按 A 类修掉 |
| fix | prd-api | 团队活动流留痕改成提交之后的尽力而为：站点文档已写进库，留痕再抛出去会把一次已成功的归属报告成失败——controller 那条路给 500，生成任务那条路记下 DestinationApplyError，终态事件于是告诉用户「网页留在个人空间」，而它已经在团队里了；吞掉但留日志 |
| security | prd-api | 归属失败给用户的那句话收敛成有限枚举，不再用异常的 Message：它经 run 落库、经终态事件下发、最后原样进浏览器提示框，而 Mongo／网络／驱动的消息里常带库名、主机与协议状态；诊断细节只进服务端日志 |
| refactor | prd-api | 测试里的一次性 Mongo 库收敛成共用 fixture：三份私有拷贝逐字相同、只有库名前缀不同（形状 3） |
| fix | prd-api | MAP 的 /health/ready 超时改成真的取消下游探测：Mongo / Redis 那两条此前只让调用方走人、探测留在后台跑，依赖掉线期间每次就绪请求都堆一条在途操作 |
| fix | prd-api | /health/ready 的对象存储探测补上与其余依赖相同的超时：此前它没有上限，存储卡住时 Task.WhenAll 一直等、整个就绪检查挂着，部署就绪检查会超时而调用方在它后面排队 |
| fix | prd-api | 原生 Responses 缓冲路径改为按手里那份完整 body 判定：观测器逐字累积的 4 MiB 字符上限与缓冲接受的 32 MiB 不一致，中间那一档合法响应会被判成未完成，一次成功的调用被退成 502 OUTCOME_UNKNOWN |
| fix | prd-api | 归属失败写回 run 加租约闸并对齐提交后阶段的判据（Running 或 Committing）：只按 run id 写的话，丢了租约的 worker 会把接管者已跑成功的那一轮改写成「归属失败」；被取消不再当成归属失败上报 |
| fix | prd-api | 回退重放放行过期的 Publishing 尝试：进程在标成 Publishing 之后、切换站点指针之前停掉时，指针永远对不上，而发布方法自己有按 TTL 接管的路径——此前被这道筛子挡掉，40 轮全空转，这条回退记录对回退接口永久失效；超时改为抛出最后一次的真实原因而非笼统的「正在处理」 |
| ops | prd-api | 网页托管删除清理的两条索引补进 DBA 可执行清单与索引文档：本仓库禁止启动时自动建索引，只写在 CreateIndexes() 里等于线上根本没有，而清理任务每分钟一轮整表扫描加排序 |
| test | prd-api | 新增索引目录覆盖守卫：代码里定义的每条索引都必须在 DBA 清单里有同名条目（按清单声明的名字集合比对，不做子串包含），落地时差集恰好为零 |
