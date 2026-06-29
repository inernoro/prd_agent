# 更新记录

> 记录 PRD Agent 全栈项目的所有变更。版本发布时自动插入版本标记行。
>
> **格式规范**：见底部 [维护规则](#维护规则)。

---

## [未发布]

### 2026-06-27

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 根治 override.containerPort=null 覆盖 baseline 端口致 `docker: invalid containerPort: null`：resolveProfileWithMode/applyProfileOverride 两处合并改用 `!= null`，null 不再覆盖 baseline 真实端口（prd-agent-main 等 api/admin 部署失败修复） |
| fix | cds | 新增部署卡死状态 reconciler：时间戳证据 + 保守硬超时终结卡死非终结态（branch/service starting/building/stopping/restarting），极速版镜像落后 HEAD 含运行时改动时只告警不自动部署 |
| fix | cds | 根治 branch override 的 null 结构哨兵覆盖 baseline（sanitizeProfileOverride 在 merge/writer 双端剥 null），整类 `invalid containerPort: null` / 空镜像 `sh:latest` 部署故障一次性消失 |
| fix | cds | docker run 前增加空镜像断言：解析出的 dockerImage 为空或含未解析模板时明确报错并指出是 CDS profile 解析问题，不再误判为 Docker 镜像问题 |
| fix | cds | 看门狗双路径各自 try/catch：webhook 派发收敛与卡死收敛崩溃各记各的 action/source，不再张冠李戴（Bugbot Low #940） |
| fix | cds | 服务级卡死收敛改了 service.status 后重算分支聚合 status/errorMessage，避免发出「branch 仍 running、某 service 已 error」的脏更新（Codex P2 #940） |
| fix | cds | 卡死看门狗有在途操作的分支整条跳过，合法长任务（>45min 编译/迁移）不被硬超时误杀（Bugbot Medium #940） |
| fix | cds | 卡死看门狗：有服务的分支聚合状态一律以服务真实状态为准，治「服务全 stopped 但分支仍 running」（Bugbot Medium #940） |
| fix | cds | 源码部署 pull 后用 parsePulledSha 取裸 SHA（优先 after）刷新 githubCommitSha + 构建历史版本列，治 head 带标题不匹配裸 SHA 正则导致版本列停在旧 SHA（Codex P2 #940） |
| fix | cds | 源码部署刷新 githubCommitSha 用完整 40 位 SHA（pull 新增 afterFull=rev-parse HEAD，parsePulledSha 优先全 SHA），避免截断成短 SHA 影响 GitHub check-run/release/OperationLog.commitSha 等外部集成（Codex P2 #940） |
| fix | cds | 部署历史「部署类型」chip 区分缺失元数据与显式源码模式：旧历史行 deployMode 为 undefined 显示「未记录」而非臆造「源码/默认」（Codex P2 #940） |
| fix | cds | 卡死看门狗聚合重算保留分支级 error（webhook 派发失败/镜像门等非服务来源），不再被服务聚合清成 idle/清空 errorMessage（Bugbot Medium + Codex P2 #940） |
| fix | cds | executor /exec/deploy 起点盖 lastDeployStartedAt，让 executor 本地卡死看门狗硬超时有锚点（集群模式，Codex P2 #940） |
| fix | cds | executor 节点禁用看门狗硬超时（allowHardTimeout=isMaster），只做时间戳证据收敛+告警，避免无租约判活时把合法 >45min 远端构建误判 error（Bugbot High #940） |
| fix | cds | 看门狗分支聚合按当前在册 build profile 过滤服务，僵尸服务（profile 删/改名残留）不再把健康分支翻回 error（Codex P2 #940） |
| fix | cds | executor 代理 source-build 的 pull 回传结构化 head/after/afterFull，master 用 parsePulledSha 取全 SHA 刷新构建历史+branch HEAD，远端路径不再只记短 SHA（Bugbot Low #940） |
| fix | cds | 看门狗：getBuildProfiles 空数组视为不过滤(不把所有服务当僵尸误判 idle)；多服务分支不再用 branch.lastReadyAt 把仍在 starting 的服务过早翻 running；executor 模式不按本地 profile 过滤僵尸服务（Bugbot Medium×2 + Codex P2 #940） |
| fix | cds | 远端执行器部署：master 从 complete 事件复制 executor 回报的真实 deployedMode，express→source 回退不再被构建历史误标 express（Bugbot Medium #940） |
| fix | cds | 单服务部署 deployedMode 缺失/空时退回 resolveEffectiveProfile，不再保留 pull 前配置态（Bugbot Low #940，与主/远端路径一致） |
| feat | cds | CDS 系统设置-维护：自更新「更新日志」面板在有更新任务时默认展开（DisclosurePanel 支持 defaultOpen + 展开/收起标签），不用每次点开看进度 |
| fix | cds | 部署刷新 githubCommitSha 改用 shouldRefreshCommitSha：同 commit 的短 SHA 可升级为完整 40 位（不降级），治已持久化短 SHA 的分支 OperationLog.commitSha 一直短、版本元数据存歧义（Codex P2 #940） |
| fix | cds | 卡死看门狗以「存活服务」（按在册 profile 过滤后）判定是否走分支级收敛：分支只剩僵尸服务时退回硬超时成 error，不被聚合藏成 idle（Codex P2 #940） |
| polish | cds | 自更新历史耗时条：任何未计量时间都补「其他」铺满进度条（不留暗色黑轨道），「其他」颜色从 /30 提到 /55 中性灰（暗色下不再像黑块），图例仍只在 >1.5s 列出（用户反馈「后面黑色的是什么」） |
| docs | cds | 新增 debt.cds.executor-watchdog：记录 executor 卡死看门狗硬超时的 #228/#233 评审冲突与根治方案（cluster-only） |
| fix | cds | 卡死看门狗服务级收敛跳过僵尸服务（已删/改名 profile 残留条目），不再被单服务证据路径误翻 running/stopped 在 UI/快照留误导状态（Bugbot Medium #940） |
| fix | cds | 部署耗时显示：终态但缺 finishedAt 的旧历史行（legacy 投影）不再被当进行中虚高耗时/超 60min 误报「疑似卡住」（computeDeployDurationDisplay 增 isRunning，HistoryRow 按 status 传入）（Codex P2 #940） |
| ci | cds | 新增 cds-prebuilt.yml + Dockerfile.dist：push 改 cds/** 时 CI 编译 CDS（esbuild 后端 + vite 前端 + tsc 门）并打成 ghcr 产物镜像 cds-dist:sha-<40hex>，为「CDS 自更新极速版」铺路（自更新拉产物跳过本机编译；找不到产物回退现编，纯增量不影响存量） |
| feat | cds | CDS 自更新极速版 第2步：新增 cds-prebuilt.ts 纯函数决策层（computeCdsPrebuiltImageRef 与 CI 同公式 / parseCdsPrebuiltManifest 校验 / shouldTryCdsPrebuilt 灰度判定）+ 10 单测，运行层据此决定拉产物或回退现编 |
| fix | cds | 看门狗在途操作跳过加年龄上限（2× 硬超时=90min）：deploy 路由自身挂死（git/docker pull 无界卡住）导致租约永不释放时，超龄租约不再护着分支，让硬超时把它收敛成 error（Codex P2 #940） |
| feat | cds | CDS 自更新极速版 第3步(运行层模块)：新增 cds-prebuilt-runtime.ts（fetchCdsPrebuilt：docker pull + create + cp 解出 /dist /web-dist 到 staging + 校验 manifest，任何失败 ok:false 供回退现编，I/O 全注入可单测）+ 8 单测 |
| docs | cds | 新增 debt.cds.selfupdate-prebuilt：CDS 自更新极速版台账（CI 产物+决策+拉取三层已落地验证，orchestrator 接线精确 spec 待真实环境灰度） |
| fix | cds | 自更新极速版产物镜像加无害 CMD + 运行层 docker create 显式传命令：FROM scratch 无 CMD/ENTRYPOINT 时 docker create 报 "No command specified" 创建失败，会导致快路径永远回退本机现编（Codex P2 #940） |
| fix | cds | 卡死看门狗在途租约判活抽成 hasYoungActiveLease 纯函数：缺/坏起始戳的租约不再永久护住分支（原 return true 重蹈「租约永不释放」覆辙），放行给硬超时收敛（Bugbot Medium「Bad lease timestamp skips forever」#940）+ 5 单测 |
| fix | cds | 卡死看门狗 restarting 排除出时间戳证据路径（分支级+服务级）：重启不刷新 lastDeployStartedAt，旧 lastReadyAt 会把仍在重启的分支/服务误翻 running；真完成由服务真相聚合上浮、真卡死由硬超时兜底（Codex P2「Do not finalize restarts from old deploy timestamps」#940）+ 3 单测 |
| fix | cds | 部署历史 commit 列以**实际部署** SHA 为准：源码 deploy 总 reset 到分支 HEAD，webhook 带 requestCommitSha=A 但 origin 已到 B 时落地的是 B；opLog.commitSha 改为不受 requestCommitSha 冻结、跟随 pulledSha（主路径+单服务路径，Codex P2「Do not freeze webhook history on the requested SHA」#940） |
| docs | cds | debt.cds.executor-watchdog 补登 #940 三项 cluster/UI 延期项（executor commit/mode 不回传、TYPE1 告警分支卡片不可见） |
| chore | doc | 熵清理：D1 0个，D2 +0/-0，D3 +0/-0，D4 +0/-0，D6 5条（manifest累计已处理batch完成） |
| feat | prd-admin | 文学创作正文配图支持点击放大/缩小/拖拽预览（ImageLightbox 新增缩放控件，正文内联图片与右侧卡片统一接入灯箱） |
| fix | prd-api | 修复单个生图请求超时（最长 600s）会阻塞整个生图队列、导致后续所有生图跟着超时的问题：ImageGenRunWorker 改为有界并发处理 run（LLM:ImageGenMaxParallelRuns，默认 4），单个慢 run 不再饿死其它 run |
| fix | prd-admin | 文学创作配图灯箱：点击的图不在轮播列表时只展示用户实际点击的那张（不再误开第一张）；正文内联与右侧卡片两个入口统一 markerItemImageUrl 取 URL（trim 一致，跨入口可正确匹配下标） |
| fix | prd-admin | 配图灯箱评审修补：工具条/导航按钮 zIndex 高于图片（放大拖拽后不再被图片盖住拦截点击）；初始下标钳制到合法区间防破图；正文内联与右侧卡片统一规范轮播顺序（markers 阅读顺序）；正文链接图点击阻止冒泡，不再跟随链接跳走而是打开预览 |
| fix | prd-admin | 正文内联配图点击改按 data-marker-idx（marker 身份）定位轮播起点，多 marker 共用同一 URL 时也不会命中错下标 |
| fix | prd-api | 生图并发后的"重生成冲突"取舍改为「最新成功优先、失败不抹旧图」：文学 marker 新增 ImageRunAt 时间戳（产图 run 的 CreatedAt），成功仅当更新才覆盖、失败在已有成功图时不写错误；marker 状态+资产指针+DoneImageCount 统一在一次乐观锁 RMW 内原子写入；画布元素同样按 imageRunAt 时间戳守成功排序（画布失败路径本就只动占位、不抹成功图），与完成顺序无关 |
| fix | prd-api | 配图灯箱并发取舍补存量兼容：ImageRunAt 字段出现前已成功的 marker（ImageRunAt 空但 Status=done 且有 AssetId/Url）失败回填时也判为"已有成功图"并跳过，避免一次失败重生成抹掉旧好图 |
| fix | prd-api | 配图资产指针写入改回"每 marker 原子 + 时间戳门控"（新增 AssetRunAtByMarkerIndex 门控字段）：批量并发时不再因 workspace 乐观锁被消息保存 churn 掉、重试耗尽而丢失 AssetIdByMarkerIndex/DoneImageCount；同时消除对可能为 null 的字典直接索引导致的崩溃 |
| fix | prd-admin | 图片灯箱开着时实时跟随最新配图：lightbox 只存打开位置（index+single 兜底），图片列表渲染时从最新 markerRunItems 重算（不再冻结快照）；ImageLightbox 越界下标改为渲染期 safeIdx 兜底，列表实时增减不再打断当前浏览位置 |
| fix | prd-api | marker 显示回填的成功/失败门控同时参考权威指针时间戳 AssetRunAtByMarkerIndex（非仅 marker.ImageRunAt）：新 run 指针写成功但 display RMW 失败时，旧/失败 run 不再把 display 改成与权威指针不一致的状态 |
| fix | prd-admin | 图片灯箱实时列表被重算成空时通知父级关闭，避免遮罩消失但父级 state 仍 open、Esc/清理失效 |
| fix | prd-api | 修复并发 run 整体回写 ArticleWorkflow 互相覆盖原子指针（High）：marker 显示字段改为针对该 marker 子字段的定向 $set（ArticleWorkflow.Markers.{i}.*），不再整体替换 wf，杜绝跨 marker 抹掉彼此的 AssetIdByMarkerIndex/AssetRunAtByMarkerIndex |
| fix | prd-api | DoneImageCount 改为单调门控写入（仅当新值更大才 $set，Lt 过滤）：并发完成时陈旧的较小计数不再最后落地把进度压低 |
| fix | prd-admin | 图片灯箱列表改回"打开时快照"（撤销实时重算）：避免打开期间更靠前 marker 后完成插入导致正在看的图悄悄错位（最小惊讶）；新配图重开灯箱即可见 |
| fix | prd-api | marker 显示写入加原子时间戳门控并恢复卡死态：done 写入 filter 携带 AssetRunAtByMarkerIndex 守卫（陈旧 run 通过内存门控后也不会后落地覆盖更新 run 的 display）；失败但已有成功图时把因重生成置 running 的 marker 恢复为 done（不再卡 running）；无成功图写 error 时 filter 守卫"无成功指针"防并发成功被覆盖 |
| fix | prd-admin | 图片灯箱滚轮缩放改用原生非 passive wheel 监听（React onWheel 默认 passive，preventDefault 被忽略导致页面在遮罩后滚动穿透） |
| fix | prd-api | 修复文学配图写入打到幽灵字段（P1）：ImageMasterWorkspace.ArticleWorkflow 等经 BsonClassMap 绑定为 camelCase，而 MongoDB 字符串路径 $set 不套用类映射约定——此前 PascalCase 字符串路径写到了顶层幽灵 ArticleWorkflow，编辑器/投稿读的 articleWorkflow 收不到 assetIdByMarkerIndex/doneImageCount/marker 状态。改为 camelCase 路径（articleWorkflow.markers.{i}.status 等），并给新字段 AssetRunAtByMarkerIndex/ImageRunAt 补 camelCase 元素名使读写一致 |

### 2026-06-26

| 类型 | 模块 | 描述 |
|------|------|------|
| perf | cds | 源码 build/install 命令降调度优先级(nice，CDS_BUILD_NICE 默认 10)，让编译不饿死同机预览/代理，治预览根文档偶发卡几十秒；serve 命令保持正常优先级，非 docker 资源硬限 |
| perf | prd-admin | 首页智能体卡片封面图 lazy + async 解码，屏外封面滚动到视口才下载，砍掉首屏整片大图负载 |
| fix | cds | 验收报告全局视图：GET /api/report-folders 缺省 projectId 改为返回全部项目文件夹（与 /api/reports 语义对齐），修复全局视图「按项目分组」只显示 CDS 自身一组、其余项目文件夹不显示 |
| fix | cds | 修复落地页底部 chips 手机端参差换行：改为整齐两列卡片网格 + 信任行竖排 |
| fix | cds | 修复左下角更新徽章长文案在手机端溢出屏幕、操作按钮够不到：限宽 + 文案截断 + min-w-0 链 |
| fix | cds | 修复数据库工作台（MySQL/Mongo 的 ResourceWorkbenchModal）手机端窗格重叠、结果区塌陷：< lg 切换 flex 自然流堆叠 + 模态 body 可竖滚，desktop 保持填满布局 |
| fix | cds | 修复加载页（LoadingPagesTab）固定两列网格在窄屏溢出：手机单列、`lg:` 恢复两列 |
| fix | cds | 修复项目列表卡片底部状态行在手机端裁切（容器在线/构建率被截）：手机隐藏 production 前缀与「次构建/时」，保「运行中·容器在线·CPU」完整 |
| polish | cds | 项目设置/系统设置的横向 tab 条手机端加右侧渐隐，提示可横滑（替代下一个 tab 被硬切） |
| polish | cds | 项目卡片技术栈图标 dock 手机端缩小节点 + `safe center`/可滑，修复第 5 个图标被切半 |
| rule | cds | 新增 `mobile-layout-fallback.md`：desktop-fill 必须配 mobile-flow 兜底，归因并防止富面板手机端不可用 |
| feat | cds | 验收报告入库归一化：内联 base64 图片抽出存为内容寻址资源(GET /api/reports/assets/:name)，正文改写为 HTTPS 链接，CDS 报告正文不再携带 base64 |
| feat | cds | 验收报告文件夹支持嵌套层级：项目=根目录，技能(cdscli/visual-test)用项目 key 提交带 folderPath("视觉创作/2026-06-22") → CDS find-or-create 多层文件夹链并归入；全局视图左侧按项目分组（多一级"项目"分类）；删除父文件夹时子上提一层、报告改未归类不丢内容 |
| feat | cds | cdscli report create --folder-path / report-folder create --parent，支持嵌套文件夹归类 |
| fix | cds | 验收报告页移除冗长描述 banner（标题+verdict 统计即可）；站内信铃铛图标 16→20px 满足 icon≥55% 比例 |
| polish | cds | 分支卡服务 chip：基础设施(infra)依赖弱化为次要（无端口/无边框/静默底，与自有容器分主次）；运行态去掉冗余状态点（仅 error/中间态保留），治理一排"碎点" |
| fix | cds | 验收报告头部加 shrink-0：修复加载完成后报告列表(flex-1)抢空间把头部压扁("刷新完成头部收缩")的 flex 布局问题 |
| fix | cds | 验收报告列表端点 projectId 规范化 slug→id（GET /api/reports + /report-folders），传 slug 不再命中空集 |
| perf | cds | peer-sync export 改异步读报告正文（libuv 线程池），避免大批量大报告导出阻塞单进程事件循环 |
| security | cds | peer-sync handshake/cancel 改为要求 HMAC 签名且只能撤销签名所属节点，防任意人凭 node id 撤销配对 |
| security | prd-api | CdsReportImportService 导入到显式 storeId 时校验归属，防把 CDS 报告写进别人私有知识库 |
| fix | prd-api | CdsReportImportService 增量游标只对默认全量镜像（无 projectId 过滤+同源）生效，过滤/换源导入改全量扫描且不回写共享水位，防项目 A 的游标永久跳过项目 B 旧报告 |
| fix | prd-api | CdsReportImportService 正文 contentHash 命中时仍同步标题/标签/元数据，防仅改 verdict/标题的报告在 MAP 镜像永久保留旧元数据 |
| fix | cds | 验收报告 PATCH 先校验 folderId（存在+同项目）再改内容，非法/跨项目文件夹不再先落盘内容后回 400 导致部分修改 |
| fix | prd-api | CdsReportImportService 仅本轮零失败才推进增量水位，单条拉取/归一化失败时保留旧游标重试，防瞬时失败变成知识库永久缺条 |
| fix | prd-api | CdsReportImportService 导入条目按归一化正文字节数填 FileSize（insert+update），防 document-store/peer-sync 把报告当 0 字节空条目 |
| security | prd-api | CDS 报告导入 HTTP 入口剥离调用方自带的 cdsBaseUrl/cdsAccessKey，强制走已授权存储连接，防任意登录用户借此 SSRF 探测内网 |
| fix | cds | 新建验收报告弹窗的文件夹下拉按所选项目过滤 + 提交时丢弃跨项目 folderId，防选了别的项目文件夹被服务端静默存成未归类 |
| fix | cds | 共享顶栏 .cds-topbar 加 shrink-0：修复 h-14(56px) 顶栏被下方高内容挤压到 ~37px("刷新完成顶栏收缩"，所有页面一致) |
| feat | prd-admin | 知识库详情工具栏加「星系」直达按钮（Orbit 图标），3D 文档星系 1 下进入；「更多」菜单也补一项「3D 文档星系」 |
| fix | prd-admin | 修复知识库「更多」下拉点不开：PageHeader 根 overflow-hidden 裁掉了原地 absolute 菜单，改 createPortal 到 body + getBoundingClientRect 定位 + 外点关闭兼顾按钮与菜单两个 ref |
| fix | prd-admin | 文档星系返回按钮按来源决定目的地：从宇宙图进来回宇宙图，从知识库详情「星系」直达/深链进来回库详情（不默认回可能 403 的宇宙图）（Codex P2）|
| polish | prd-admin | 知识库列表顶栏不再用不透明 var(--bg-base) 整块铺底（用户反馈「黑黑的一坨」），改半透明 color-mix 55% + 加重磨砂模糊，保留 sticky 玻璃感但更轻 |
| chore | doc | 熵清理：D2 +1/-0，D3 +20/-0，D6 新增 5 条 changelog 到 manifest |
| polish | prd-admin | 知识库「星系」入口按钮改名「知识星球」并加柔和脉冲光环 + 渐变底（借鉴本页教程 pill），更吸引点击 |
| fix | prd-admin | 文档星系「返回」一律回到该知识库详情，不再回 obsidian 风「宇宙图」（两套图谱心智不同，不应互为返回关系）|
| polish | prd-admin | 库详情「更多」菜单默认只保留「知识星球（3D 星系）」入口，暂收起「关系图谱/宇宙图」（路由仍在，深链可达），待智能判别落地再放开 |
| polish | prd-admin | 文档星系类型图例只列「本库真实存在(count>0)」的类型，不再把 spec/design/... 全摆成一排 0（很多库文档未细分类型，全是「其他」）|
| polish | prd-admin | 知识库文档阅读顶栏「评论/全屏/历史版本/编辑」按钮改为纯图标方钮（评论有数时保留计数），收窄控制条占位 |
| fix | prd-admin | 文档星系面包屑「同级跳转」下拉改 createPortal 到 body：顶栏与面包屑容器都 overflow:hidden 会裁掉原地 absolute 菜单，导致新加的同级菜单看不见/不可用（Codex P2）|
| fix | prd-admin | 修复文档星系选中环偏移（用户反馈「歪/溢出位移」）：环外层容器以左上角对齐星的投影点，而内部环/指针绕容器中心排布，整圈偏到星右下 ~32px。给外层加 translate(-50%,-50%) 让容器中心对到星；并把 4 个指针尖角改为对称 ±34px 推出（旧写法对边钉同名边，盒尺寸同向相加偏右下 ~3.5px，Codex 几何复核发现）|
| polish | prd-admin | 文档星系关系链面包屑从居中改到左上角（紧挨库名左对齐），右侧统计/搜索/标题开关用弹性占位推到最右 |
| chore | prd-admin | 新增「文档星系加载动效候选」预览页 public/galaxy-loaders.html：9 个星系专属加载动效供选型（配色取自真实 TYPE_COLOR），选定后替换星系两处通用 MAP 加载 |
| feat | prd-admin | 文档星系按标题分隔符(· / > | 及「空格-空格」)分层聚簇：描述式标题(如「prd-agent·知识库·…·验收报告」)取前 1-2 段作分组，共享前缀的文档聚成簇，不再全堆「未分类」蘑菇；裸连字符不拆(prd-agent 整段保留) |
| fix | prd-admin | 文档星系选中的文档星补标题标签：叶子不生成常驻 sprite，选中时在环下方显示标题(随结构名/正文标题开关切换)，解决「选中的文档星没有标题」 |
| chore | prd-admin | 文档星系加载动效候选精修为 4 个(轨道环绕精修/星座连线精修/轨道+星座融合/倾斜盘)，替换原 9 个简陋版 |
| feat | prd-admin | 文档星系加载动效落地：选定「星座连线」做成 GalaxyConstellationLoader（几何规则化为内外双六边环 + 辐条），替换构建星系/加载文档/加载星系三处通用 MAP 加载 |
| feat | prd-admin | 文档星系阅读面板可左缘拖拽改宽 + 默认宽度放大 1/4(760→950)，宽度入 localStorage；投影偏移随实际宽度同步，聚焦星稳居左半中心 |
| feat | prd-admin | 文档星系滚轮/触摸板区分：黏性判别设备，鼠标滚轮=缩放、触摸板双指滑=平移、捏合/⌘·Ctrl+滚轮=缩放 |
| fix | prd-admin | 文档星系阅读面板「两个标题」去重：面板头已显示标题，正文若以同名 H1/H2 开头则剥掉该行(兼容「文件名 — 真标题」式) |
| fix | prd-admin | 文档星系构建失败/加载中也渲染「返回」兜底顶栏：全屏路由隐藏了 AppShell 导航，galaxy 为 null 时不再无路可退(Codex P2) |
| chore | prd-admin | 移除已完成选型的临时预览页 public/galaxy-loaders.html（星座动效已落地为 GalaxyConstellationLoader，demo 不再随站点发布）|
| polish | prd-admin | 文档星系顶部收成两层：关系链面包屑上移回顶栏（第一层，含 ▾ 同级下拉），类型 chips 留在画布左上角透明浮层（第二层），不再三层 |
| fix | prd-admin | 文档星系阅读抽屉打开时用 camera.setViewOffset 把投影左移，聚焦星 + 选中环居中于左半可见区（而非全屏中心被抽屉盖住/溢出位移），随抽屉开合与窗口尺寸自适应 |

### 2026-06-25

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 验收报告新增 verdict/tier/缺陷计数/部署上下文(commit/branch/PR/deployMode)元数据,分支关联时自动补全部署上下文 |
| feat | cds | 验收报告列表支持 ?updatedSince= 增量过滤 + 响应附带 projectSlug,为跨系统(MAP)消费铺路 |
| feat | cds | cdscli report create 新增 --verdict/--tier/--branch/--commit/--pr/--deploy-mode/--defects 元数据参数 |
| refactor | cds | 验收技能 create-visual-test-to-kb 去分流:默认归档进 CDS 验收中心(按项目+文件夹,自包含 markdown 内联截图),不再分流到 MAP 知识库;local 离线兜底,doc-store 向后兼容 |
| feat | cds | 验收报告页新增 E2 验收看板(verdict 计数+通过率条)与逐行 verdict 徽章/部署上下文(commit/PR)展示 |
| feat | cds | 验收报告新增 E6 匿名只读分享链 /r/&lt;token&gt;(token 自鉴权、可撤销、不经登录网关),报告阅读器内一键生成/复制/撤销 |
| feat | cds | 验收报告新增 E4 验收回写 PR：把 verdict 作为 PR 评论 + GitHub check-run(验收绿/红) 推回关联 PR(报告须带 prNumber，项目已 link GitHub)，阅读器内一键回写 |
| feat | cds | 新增 WS3 MAP-KBTP v1 peer-sync 端点(handshake/ping/capabilities/signature/export/apply)，CDS 作只读源 peer 把验收报告以 document-store 资源暴露，HMAC-SHA256+5 分钟时间窗+一次性配对码鉴权，供 MAP 等系统整库 pull |
| feat | cds | cdscli 新增 peer pairing-code/nodes/revoke 配对管理命令(VERSION 0.7.1) |
| fix | cds | peer-sync HMAC 改用全局解析器已存的 req.rawBody 取原始正文(自带 body 解析器会被全局解析器抢先消费导致拿到空串、handshake 400)，测试镜像生产全局解析器 |
| fix | cds | peer-sync 空 body 的 HMAC bodyHash 改为 sha256("") 与 MAP PeerNodeService 对齐(原空串约定致 MAP 配对后 GET ping 401 回滚)；fail() 增嵌套 error.{code,message} 供 MAP 显示精确失败原因 |
| fix | cds | peer-sync 放行整个 /api/peer-sync/ 前缀(admin 除外)+ 显式 handshake/confirm·finalize 返 404、cancel 清半连接节点，使 CDS 单阶段握手被 MAP legacy-peer 判定(依赖 404)识别(原 confirm 落登录网关 401 致 MAP 取消配对) |
| feat | cds | 预览等待页显示构建模式(极速版/源码)+分支与PR直达链接 |
| fix | cds | 预览等待页从容应对推送瞬间的"分支已停止"抖动(连续3拍非加载态才跳诊断页，期间显示"正在恢复") |
| polish | cds | 预览等待页百分比改为按预估时间倒推的两位小数平滑递增(封顶99.99%，ready前不显示100%) |
| feat | prd-api | 新增 CDS 验收报告导入器(CdsReportImportService + POST /api/document-store/import-cds-reports)：复用「系统互联」已授权的 CDS 全局连接长效令牌(X-AI-Access-Key)，免 peer-sync 握手、一次鉴权增量同步 CDS 报告进知识库(updatedSince + contentHash 去重) |
| fix | cds | 预览等待页进度小数位冻结修复：百分比改为按 ETA 连续时间插值(server 锚点→99.99)，小数位随秒持续跳动；旧 max(server,timePct) 被整数封住小数冻在 .00 |
| fix | prd-admin | 知识库文档阅读 HTML 报告双滚动条修复：srcDoc 预览 iframe 改 allow-same-origin(仍禁脚本) + onLoad 量高自增高，iframe 不再内部滚动，只剩外层一条滚动条 |
| polish | prd-admin | 知识库侧栏头部：排序 + 正文标题切换 + 显示设置合并到一行省垂直空间；侧栏很窄时正文标题/显示只留图标 |
| fix | prd-admin | 知识库工具行合并后排序选项字字竖排折叠修复：排序控件 shrink-0 + whitespace-nowrap 永不被挤压换行；正文标题/显示窄栏(<380px)收成纯图标；整行放不下时横向滚动，绝不竖排折叠 |
| fix | prd-api | CDS 报告导入器补归一化：导入时走 DocumentStoreAssetNormalizer 把 CDS 报告内联 base64 图片抽出存进统一资产库(IAssetStorage,SHA256 去重)改写成 HTTPS 图链，MAP 知识库正文不再留 data:image(原导入直接 DocumentService 存原文绕过了归一化) |
| polish | cds | 左侧导航改为 icon 菜单（260→72px，省横向空间）+ 验收报告页撑满全宽（去 max-width 居中留白） |
| feat | cds | cdscli 新增 report / report-folder 子命令 + 沉淀视觉取证管线进 cds 技能（cli/acceptance + reference/acceptance-reports.md） |
| fix | prd-api | 缺陷修复技能最低版本门槛提升至 1.6.0，并将技能文案残留的「发布中心」统一为「更新中心」 |
| chore | doc | 熵清理：D1 0个，D2 +0/-0，D3 +0/-0，D4 +0/-0，D6 5条（2026-06-20 手机密度+VOC改版） |
| feat | prd-admin | 文档星系视图视觉精修：UnrealBloom 选择性辉光 + ACES 色调映射 + 深空星点/星云背景 + 距离自适应星体光晕，功能零回归 |
| fix | prd-admin | 文档星系悬浮卡/列表预览改用 cleanPreview 剥 frontmatter+markdown，不再糊出 `--- title --- #` 原文 |
| fix | prd-admin | 文档星系触控板平移方向对齐视觉创作（cam-delta），上下/左右不再反 |
| polish | prd-admin | 文档星系顶栏拆包：类型图例 + 关系链面包屑移出顶栏浮到左上角（图例透明无底、面包屑淡渐变药丸），顶栏只留返回/库名/统计/搜索/开关 |
| feat | prd-admin | 文档星系面包屑每段加 ▾，点开看同级兄弟下拉（分组→聚焦该枢纽 / 文档→打开），点外部/切换自动收起 |
| feat | prd-admin | 文档星系图例飞出/枢纽清单/搜索结果的列表行悬浮展开 2 行正文预览 |
| feat | prd-admin | 文档星系选中文档星加发光旋转环指针（虚线自转环+呼吸内圈+4 向内尖角，色随 docType，DOM 叠层每帧跟随屏幕坐标，星被筛掉/背面自动隐藏） |
| fix | prd-admin | 文档星系类型筛选时空分组整体隐藏：某分类/应用/子模块下文档被筛光时，空枢纽+标签+连线一并消失，不再悬空（Codex P2）|
| feat | prd-admin | 文档星系涌现优化（可观测/预期/可操作）：构建期显示「已加载 N/总 篇」进度、全局搜索框（命中→飞到打开）、常驻「复位视角」按钮、stats 补「N 悬空」计数 |
| fix | prd-admin | 文档星系排除目录订阅容器条目（x-github-directory）不计为文档叶，避免幽灵节点/虚增篇数/空白阅读器（Codex P2）|
| fix | prd-admin | 文档星系 unknown 类型可被图例筛选/列出（有未分类文档时追加「其他」chip），不再强制常显（Codex P2）|
| feat | prd-admin | 文档星系悬浮缩略卡增信息：叶子加「所在路径」面包屑、枢纽（分类/应用/子模块）加可点文档清单（半屏可滚 + 悬停保持 + 点跳转），根仍紧凑 |
| feat | prd-admin | 文档星系双击空白处恢复自动旋转 |
| feat | prd-admin | 文档星系对齐苹果触控板手势：两指滑动平移、⌘/Ctrl+滚轮或双指捏合缩放（OrbitControls 接管 wheel，遵 gesture-unification） |
| feat | prd-admin | 文档星系头部面包屑每段加 kind 图标（分类/应用/子模块/文档按 docType 上色），一眼分清层级 |
| feat | prd-admin | 文档星系点击文档（星点/图例清单/枢纽清单/面包屑）相机飞到该文档并脉冲高亮，不再原地不动 |
| feat | prd-admin | 文档星系交互调优：枢纽节点点击聚焦（相机平滑推进 + 子树高亮 + 祖先链点亮 + 信息面板含直接子项下钻列表）；鼠标悬浮显示缩略卡（叶子=类型徽章/标题/摘要，枢纽=篇数/类型分布条） |
| polish | prd-admin | 文档星系顶部两横合并为一横：返回/库名/类型图例/统计/关系链面包屑/搜索/标题开关并入单条顶栏，去掉独立头部，更清爽 |
| feat | prd-admin | 文档星系选中文档持续高亮：被选中的文档星 发光（bloom 增强 + 光晕变亮）+ 放大 + 呼吸动效，关闭抽屉/复位时解除，一眼可见当前选中 |
| polish | prd-admin | 文档星系阅读抽屉降低透明度（底色 0.92）保证正文可读，保留轻玻璃质感 |
| feat | prd-admin | 文档星系顶部 type 图例 chip 悬浮弹出该类型全部文档清单（半屏可滚 + 悬停保持 + 点条目跳转）；星系内枢纽悬浮恢复为紧凑摘要卡，叶子悬浮显示文档简介 |
| feat | prd-admin | 文档星系标题显示开关默认改为正文标题；画布标签随开关切换重绘（单文档子模块簇在正文标题模式下显示该文档正文标题） |
| fix | prd-admin | 文档星系正文标题模式举一反三：剥掉 H1 里重复的文件名前缀（doc 作者约定 H1 写成「文件名 — 真标题」），无人类标题时画布标签用结构段名而非全文件名，根治「都是文件名字」|
| fix | prd-admin | 文档星系关系识别：GitHub 目录订阅的非点分文件从 sourceUrl 还原仓库内目录层级，不再一律落「未分类」（Codex P2）|
| feat | prd-admin | 文档星系阅读抽屉改玻璃悬浮卡（拉宽至 760px + 四周留白全圆角 + backdrop-blur 通透 + 正文限宽居中），顶部带关系链路径 |
| feat | prd-admin | 文档星系悬浮分类/应用/子模块枢纽弹出该簇文档清单（半屏可滚 + 悬停保持 + 点条目直达），根节点仍为紧凑摘要卡 |
| feat | prd-admin | 文档星系头部右上「结构名/正文标题」显示开关（复用 DocBrowser parseFrontmatter 口径，默认结构名），头部中部显示当前关系链面包屑（叶子可点跳转） |
| fix | prd-admin | 文档星系双链接口失败时显式标注「引用关系加载失败 / 引用未知」，不再静默渲染成「0 引用」误导用户（Codex P2）|
| feat | prd-admin | 知识库 3D 文档星系拆为独立全屏页（/document-store/:storeId/galaxy），从宇宙图「星系」按钮跳转 |
| fix | prd-admin | 星系视图加失败必报：25s 超时显式报错、所有失败路径 console.error、Canvas 外套 ErrorBoundary 防 WebGL 白屏空转 |
| fix | prd-admin | 星系图例改为顶部 flex 排布，消除与宇宙图头部绝对定位叠加 |
| refactor | prd-admin | 知识库 3D 文档星系渲染内核切回 vanilla three.js（原生 EffectComposer + UnrealBloomPass 选择性 bloom），与演示版同一套逻辑，修复白色 group/root 节点过曝爆成大白团 |
| chore | prd-admin | 移除仅本组件使用的 @react-three/drei / @react-three/postprocessing / postprocessing 依赖 |
| fix | prd-admin | 文档星系完整视觉对齐演示版（数值 SSOT）：照搬布局尺度/节点尺寸/光晕(缩小+压透明,消白团)/配色/相机/星云，不只 bloom 配方 |
| fix | prd-api | 修复网页托管 PDF 在高 DPR 手机端预览文字发糊的问题 |
| fix | prd-admin | 移动端首页/个人中心新增 VOC（行为洞察）入口，修复手机端完全找不到 VOC 的问题 |
| feat | prd-admin | 首页基础设施 SSOT（buildStaticInfra）补齐三处移动端孤儿入口：VOC、智识殿堂、开放平台（按权限门控） |
| fix | prd-admin | 补充 /team-activity 的移动端兼容标记（limited，横屏更佳） |
| feat | prd-admin | VOC 端点下钻改三段式：证据先行→大模型阅读效果→模型返回后收束成顶部 Tab（AI 报告为第一个默认 Tab，原始证据为第二个），治「AI 报告埋在长页底部要下滑」 |
| feat | prd-admin | VOC 下钻 AI 报告/请求样本包 ExpandablePanel：右上角放大全屏看 + 右下角拖拽改尺寸，解决窄抽屉大段内容看不全 |
| fix | prd-admin | VOC 下钻真实请求样本超长内容默认截断（>600 字），「展开全部」后限高滚动，避免撑爆抽屉 |
| polish | prd-admin | VOC 下钻抽屉桌面端加宽至 560px（手机仍 94vw），给根因诊断/报告更多默认空间 |
| feat | prd-admin | VOC 下钻根因诊断等待态改推进式步骤清单（读取样本→解析耗时→比对错误码→归纳根因），不再静态 spinner |
| fix | prd-admin | VOC 下钻根因报告改自适应全高展示，不再固定 460px 内截断（整页滚动交给抽屉） |
| feat | prd-admin | VOC 行为洞察仪表盘趋势爆点/声道看板新增全屏按钮（与热力图一致） |
| refactor | prd-admin | VOC 行为洞察移除「体验痛点指数」仪表盘（作用不大），右下整宽保留声道看板，删除 ExperienceStats |
| feat | prd-admin | VOC 视图切换改用全项目统一 SegmentedTabs（与「应用模型池管理」同款 pill），SegmentedTabs 支持 icon + 新增 hover 反馈 |
| feat | prd-admin | VOC 置顶进首页基础设施区，对有 team-activity.read 的用户替换掉智识殿堂（无权限者仍保留智识殿堂） |
| polish | prd-admin | VOC 热力图小格标题按宽度自适应铺满（窄块小字号+截断省略），不再因放不下而整块无标题 |
| fix | prd-admin | VOC 声道看板渠道标题（如「行为之声」）不再折叠换行，副标过窄时截断让位 |
| fix | prd-admin | VOC 视图切换改用设计系统 TabBar（与应用模型池管理完全同款 surface-nav 顶栏+滑块），修复 SegmentedTabs 样式不一致+顶栏丢失；SegmentedTabs 回退原状 |
| feat | prd-admin | TabBar 非激活项 hover 增加底色反馈（surface-nav-button:hover），更明显 |
| feat | prd-admin | VOC 趋势爆点曲线新增汇总指标条（报错总数/慢请求总数/爆发点/单桶峰值），信息更丰富 |
| feat | prd-admin | VOC 下钻加载动效 1:1 复刻：证据卡阅读期点亮 + 阶段步骤脉冲环/打勾 + 报告打字机流式 + 分段浮现左缘点亮 + 页签切换淡入过渡 |
| polish | prd-admin | VOC 行为洞察右列比例调整：趋势爆点(带汇总指标+曲线)上行加高(1.45fr:1fr)，声道看板下行，曲线不再挤 |
| polish | prd-admin | VOC 右列比例修正：趋势爆点上行改矮、声道看板下行改高(1fr:1.7fr)，按用户截图(趋势短/声道长) |
| revert | prd-api | 删除所有催办：移除缺陷超时催办 DefectEscalationWorker 与项目逾期提醒 PmOverdueReminderWorker，清理 DefectReport 的 LastEscalatedAt/EscalationCount 字段及 Program.cs 注册（反复催办被持续忽略，干扰正常需求） |
| fix | prd-api | DefectReport 加 BsonIgnoreExtraElements：删除催办字段后兼容存量 defect_reports 文档残留字段，避免反序列化 FormatException 致缺陷列表/详情查询 500 |
| chore | prd-api | 一次性清理服务 EscalationNotificationCleanupService：上线时删除已移除催办 Worker 留下的存量提醒通知（pm-reminder / defect-escalation key 前缀），避免用户上线后仍看到最多 3 天的催办噪音；采用有界周期清扫（约 20 分钟窗口）覆盖滚动发布期旧实例迟插入的记录 |
| fix | prd-api | 修复网页托管访问便捷链历史过期导致次日打开失效的问题 |

### 2026-06-24

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | Cmd/Ctrl+K 命令面板支持苹果聚焦式搜索字段级设置与配置（保活/探活/240/镜像等口语词带同义词匹配），新增系统级+项目级设置索引 settingsSearchIndex |
| feat | cds | 命令面板搜索结果带完整面包屑路径（设置类显示「CDS 系统设置 / 调度器」，分支类带上所属项目），让用户搜一次记住位置 |
| feat | cds | cdscli 新增 profile list/deploy-mode/readiness + branch set-mode 命令，AI 用 key 直接设就绪超时(探活)与部署模式，不再依赖 dashboard |
| fix | cds | 部署重试默认关闭（治重试风暴）：CDS_DEPLOY_DISPATCH_RETRY_ENABLED 未设则对账器只标记 stale 不自动补发部署，根治多部署来源互相抢占打满 CPU 导致整个 CDS 进不去 |
| fix | cds | 根治 fenced-cleanup 竞态(No such container)：被抢占的部署清容器前，若有更新的 runtime-producing 操作(deploy/restart/auto-restart 等)在接管则跳过删除，避免删掉对方正用的容器导致 restart/auto-wake 报 No such container、服务 0/N |
| feat | cds | 发布探活分阶段：部署首启就绪探测加系统级下限 deployReadinessFloorSeconds(默认1200s,项目可覆盖),取 max(profile超时,下限),避免慢首启(构建/JVM暖机)被探活超时误杀;运行期重启/唤醒不受影响保持短超时 |
| fix | cds | 极速版镜像缺失自动回退源码编译（治「极速版永远不极速 / 部署出现异常打不开」）：CI 按 path-filter 只构建改动组件,任何不同时改 prd-api+prd-admin 的分支必缺 ≥1 个 sha 镜像 → express docker pull 404。原先硬失败要人手切回源码;现 runService 拉取失败(含 branch-main 回退)后,自动挑一个带 command 的非 prebuilt 部署模式(优先 static)从源码在 CDS 本机编译跑起来,无需人工干预;仅当该 profile 确无源码模式才维持硬失败 |
| fix | cds | 首页 Enter Console/Log in 探测会话态(GET /api/me),已登录直接进控制台,不再每次重复弹登录框 |
| fix | cds | /login 路由挂载时探测会话态,已登录自动跳目标页(默认 /project-list 或 ?redirect=),探测期间显示加载态不闪登录框 |
| feat | cds | 预览页既有 CDS 分支 widget（左下角）补显构建版本：sha7 + 部署模式 chip（极速/源码，颜色沿用 widget 既有配色），服务端预填首屏即见、并修复 sha 取值（兼容 githubCommitSha 字段）；标签页标题前缀沿用 widget 原有逻辑。混搭多版本/多标签时一眼区分，不再单开第二个角标（合并冗余）。 |
| feat | cds | 过期分支预览页按合并/放弃分流：合并显示「已合并到主分支」中间页+切主分支预览按钮（沿用动效网格背景），放弃显示「分支已放弃」页+跳 PR；新增分支墓碑（BranchTombstone）持久化 |
| feat | cds | 没走 PR 的直接删分支（git push --delete）也写墓碑（reason=abandoned），过期预览页落到「已放弃」页而非泛化「启动失败」；recordRemovedBranch 加 merged 粘性，避免删分支 delete 事件把已合并墓碑降级 |
| fix | cds | 修复极速版分支卡在「等 CI 镜像」被误标成「容器停止·无记录·时间未知」：分支卡拆出「等待 CI 镜像/CI 镜像未就绪/待部署」三态，shouldShowStopReason 对齐后端 isStoppedBranch 口径 |
| feat | cds | 新增「等待 CI 镜像」看门狗：waiting 超时（默认 15min，CDS_CI_WAIT_TIMEOUT_MS 可调，多因分支缺 branch-image.yml）自动翻 failed + 写人类可读归因 + server-event + branch.updated 事件，根治无限期 idle 无记录 |
| fix | cds | PR review 修复：已合并页主分支链接优先用 baseRef（实际合并目标）而非 defaultBranch；prClose 策略关闭时合并 PR 也记 merged 墓碑（防 delete 事件误降级为已放弃）；停止面板判定严格对齐后端 isStoppedBranch（不靠孤立 lastStop* 误标停止）；recordRemovedBranch 承袭更丰富 PR 元数据（关 PR→删分支不丢「查看 PR」）；CI 失败 branch.updated 事件带上 ciImageError 实时下发 |
| fix | cds | PR review 二轮：delete 策略关闭时也记 abandoned 墓碑（与 prClose 一致，删分支清理不再落泛化「启动失败」）；墓碑增 branchId/aliases 兜底键 + findRemovedBranchByIdentifier，自定义子域别名访问 gone 页也能匹配到合并/放弃页（previewSlug 主键查不到时兜底） |
| fix | cds | PR review 三轮（竞态）：delete 先到清掉 entry 时，closed(merged) 仍基于 head.ref 写 merged 墓碑（merged 粘性升级 delete 写的 abandoned，合并 PR 不再错显已放弃）；CI 完成早到的缓存认领路径 failed 分支也写 ciImageError + 清 ciWaitingSince（脱离 waiting 后看门狗不兜底，看板能实时显示原因） |
| fix | cds | PR review 四轮：CI 等待看门狗超时翻 failed 时清掉 ciWorkflowRunUrl，避免卡片「查看构建」指向与「无匹配构建完成」失败无关的历史 Actions run |
| fix | cds | PR review 五轮：停止但未删除的 PR 分支（仓库保留合并分支）也落合并/放弃页——proxy.routeToBranch 在 stopped 兜底前查墓碑命中则走新增 onBranchGone 回调到 serveBranchGonePage；fail-safe（无墓碑照旧 + 仅拦 HTML 导航 + 置于 auto-wake 副作用前不复活已合并分支） |
| fix | cds | PR review 六/七轮：CI 状态字段清空在 **state** 里写 '' 而非 undefined——/api/branches/stream 的 branch.updated 从 state 重新序列化整个 branch 下发、BranchList 按 data.branch merge，JSON.stringify 丢 undefined 字段导致客户端保留旧值（旧「查看构建」链接/旧错误文案/旧等待时间）。看门狗超时 + CI 缓存认领 + 主 workflow_run + 进 waiting 等所有清空点统一改 ''（ciWorkflowRunUrl/ciImageError/ciWaitingSince/ciWorkflowConclusion） |
| feat | cds | 验收报告页支持 ?report/?folder 直达深链 + 行内「复制直达链接」按钮 |
| feat | cds | 验收报告新增项目级文件夹分类（ReportFolder CRUD + 报告 folderId 归属/移动） |
| feat | cds | 项目卡右上角新增「验收报告」入口按钮，按项目筛选进入验收报告 |
| feat | prd-admin | 知识库文档星系：新增关系识别业务逻辑核心 buildDocGalaxy（点分命名→文件夹/parentId 兜底→叠加双链，与可视化解耦的纯函数 SSOT）+ canonical appname 四大类分类器 + 10 项单测 |
| feat | prd-admin | 知识库「关系图谱」页新增 宇宙图/星系 切换：DocumentGalaxyView（R3F 3D 放射星系，按 docType 七色上色，点文档星复用 MarkdownViewer 全文阅读面板），消费 buildDocGalaxy，懒加载、宇宙图功能零改动 |
| fix | prd-admin | 星系视图分页取全 entries（跟 total 翻页，修 >200 文档库丢文档/双链）+ 切到星系时停掉宇宙图 RAF 力导向循环（修后台空转抢主线程）|
| fix | prd-admin | 星系分类器容旧扁平名：最长 canonical 前缀去扁平化（cds-project-migration → cds 下钻），真数据 346 篇悬空 79%→36%、cds-* 收进单一 cds 节点 |
| fix | prd-admin | 修复知识库顶栏「更多」下拉被 PageHeader 的 overflow-hidden 裁切/遮挡，新增可复用 AnchoredMenu（createPortal 到 body + 锚点定位 + 视口夹取/上翻 + 点外/ESC 关闭），知识库卡片「更多」同步改用 |
| feat | prd-admin | 知识库顶栏「更多」新增「下载全部文档（ZIP）」，分页拉取全量条目（不止内存首页 200）后逐篇导出：文字类存 .md/.html、二进制类（pdf/docx/图片）下原文件，带进度 toast |
| polish | prd-admin | 知识库划词评论改为「默认内联，点击某条 → 右侧批注栏展开，关掉即回内联」，移除「批注栏/内联」布局切换开关（activeCommentKey 单独驱动），删除不再使用的 docReaderPrefsStore |
| chore | doc | 熵清理：D1 0 个，D2 +0/-0，D3 +0/-0，D4 +0/-0，D6 5 条（manifest 累计 360 条） |
| fix | prd-api | 官方技能打包补齐 frontmatter version 字段，修复海鲜市场 15 个白名单技能版本号为空（bundle-official-skills 只读 frontmatter） |
| fix | prd-api | ai-defect-resolve 官方下载模板同步到 v1.8.0，补齐自治纪律（三档边界 + 五层自治回路）段，与仓库内置技能契约一致 |
| fix | prd-api | agentLaunch 广告的 ai-defect-resolve minVersion 1.5.0→1.8.0，与官方模板同步，确保老 agent 被提示重装以获得 loopGuard 自治纪律 |
| polish | prd-admin | 教程中心承接卡定稿为「徽章环」样式（保留 7 级帽子系统），删除段位条/帽子阶梯两套选型与对比脚手架 |
| fix | prd-admin | 首页 Hero 右栏平板窄宽(<576px 侧栏展开)允许收缩竖排，修复横向溢出 |

### 2026-06-23

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | ci | branch-image.yml 默认分支 main 无论改动路径都构建 api/admin 两镜像（不走 path-filter 跳过）：根治「main 仅改 cds/docs 时不产 sha-<commit> 镜像 → CDS 极速版 docker pull 404、分支显示部署异常/无法构建」。main 是全体分支的回退镜像源(:branch-main)且自身极速版部署只认 sha-<commit>，必须始终产出；feature 分支保留 path-filter 优化 |
| feat | cds | 分支卡片新增生命周期动效:新分支(branch.created)淡入长出、分支回收(branch.removed,GitHub 删分支链路)两段式淡出收起后再移除,不再瞬间消失;尊重 prefers-reduced-motion |
| feat | cds | 新增「极速版（CI 预构建）」部署模式：push 后不在 CDS 本机编译，改由 GitHub Actions 把 commit 编译成 ghcr 镜像，CDS 监听 workflow_run 后按 SHA docker pull + run，省服务器算力 |
| feat | ci | 新增 .github/workflows/branch-image.yml：每分支 push 把 prd-api / prd-admin 编译成 ghcr 镜像（sha-<SHA> + branch-<slug> tag） |
| feat | cds | DeployModeOverride 扩展 prebuilt / containerPort；dockerImage 支持部署期模板变量 ${CDS_COMMIT_SHA} / ${CDS_BRANCH_SLUG}（resolveImageTemplate） |
| feat | cds | webhook 新增 workflow_run 事件处理：CI 成功→拉取部署、失败→标记可切回源码编译；push 在极速版分支置「等待 CI 镜像」而非立即编译 |
| feat | cds | 分支卡新增 CI 状态徽章（等待 CI 镜像 / CI 构建失败 + 切回源码编译 + 查看构建链接）；部署模式标签细化「极速版」 |
| feat | cds | cds-compose.yml 给 api / admin 增加 express 模式（极速版，prebuilt + 8080 端口） |
| docs | cds | spec.cds.compose-contract 补 x-cds-deploy-modes 子键表（含 prebuilt/containerPort/模板）；新增 debt.cds.ci-prebuilt 台账 |
| feat | cds | 极速版分支卡用独立 Zap（闪电）图标 + 青色徽章「极速版」,从「发布版」里区分出「拉 CI 镜像 vs 源码编译」（lucide SVG,非 emoji,遵 §0） |
| feat | cds | 项目设置新增「强制所有分支对齐」：一键把项目默认运行模式写入全部已有分支配置（POST /api/projects/:id/align-deploy-modes，复用 applyDefaultDeployModesToBranch；只写配置不批量重部署,各分支下次部署生效,避免压垮宿主） |
| fix | cds | PR review 修复（Bugbot/Codex）：align-deploy-modes 补 assertProjectAccess 防越权；push「等待 CI」判定不再用项目默认（与 deploy 一致,避免无 override 旧分支误等 CI 后跑源码）；workflow_run 匹配带 head_branch + 允许 failed re-run 成功恢复；deploy 兜底从 worktree HEAD 推导 commit SHA（避免极速版镜像 tag 变 sha-空）；极速版配置未生效显示「极速版·待生效」；CI 等待/失败徽章仅在仍是极速版时显示 |
| fix | cds | PR review 修复（Bugbot）：commit SHA 推导上提到集群分发决策之前，集群/远端部署经 proxyDeployToExecutor 前先 stamp githubCommitSha，避免远端 payload 极速版 dockerImage 仍是 sha-空 tag 导致 docker pull 失败；本地路径不再重复推导 |
| fix | cds | PR review 修复（Bugbot/Codex P2）：早到的 workflow_run.completed 不再丢弃——按 repo+sha 进程内缓存(1h/200 上限,一次性消费),push 把分支置 express-waiting 时先认领缓存命中即直接 ready+deploy / failed,另加 githubCommitSha 兜底匹配,根治「push 延迟导致极速版分支卡死 waiting」 |
| fix | cds | PR review 修复（Bugbot）：docs-only push 命中等待中的极速版分支时同步推进 ciTargetSha,避免新 commit 的 CI run 因 ciTargetSha 滞留旧 SHA 永不匹配 |
| fix | cds | PR review 修复（Bugbot）：webhook self-test/dry-run 在极速版分支返回 ci-image-waiting（无 deployRequest），与真实路径一致,不再误报会部署 |
| fix | cds | PR review 修复（Codex P2）：static→express 配置变更标记为「待生效」——配置预构建但实际容器是别的 release 模式时也判 pendingPublish,卡片不再亮虚假「极速版」绿徽章 |
| fix | cds | PR review 修复（Codex P2）：项目设置「强制所有分支对齐」在默认模式有未保存改动时禁用并提示先保存,避免按旧默认覆盖全部分支而 toast 误导 |
| fix | cds | PR review 修复（Bugbot/Codex P2）：早到 CI 结果缓存键加 head_branch,同一 commit 的两分支各跑各的 workflow_run 不再互相覆盖/吞噬;认领时也按分支匹配,避免 A 分支用 B 分支的成功结果误标 ready |
| fix | cds | PR review 修复（Codex P2）：docs-only push 推进 ciTargetSha 后同样认领早到的 CI 缓存(提取 claimCachedCiRunForExpress 复用),命中直接 ready+deploy/failed,不再因绕过认领而卡 waiting |
| fix | cds | PR review 修复（Codex P2）：极速版 docker pull 前 fail-fast 校验镜像 tag 已解析,未解析(含 ${ / 空 :sha-)直接报可操作错误而非语义不清的拉取失败 |
| fix | cds | PR review 修复（Bugbot）：check_run 重跑在极速版 waiting/failed 分支不再绕过 CI 闸门直接部署预构建镜像(镜像可能未 push),仅 ciImageStatus=ready 才放行;非极速版行为不变 |
| fix | cds | PR review 修复（Bugbot）：align-deploy-modes 写 override 时若分支模式真的变了,清掉旧 ciImageStatus/ciTargetSha/ciWorkflowConclusion/ciWorkflowRunUrl,避免卡片显示与新模式不符的「等待 CI / CI 失败」陈旧徽章;模式未变不动(不打断 in-flight 等待) |
| fix | cds | PR review 修复（Bugbot）：check_run 重跑放行极速版部署须同时满足 ciImageStatus=ready 且 ciTargetSha===head_sha,避免「A 已 ready」误部署 commit B 的预构建镜像 |
| fix | cds | PR review 修复（Bugbot）：新 push 重置 express 分支为 waiting 时一并清掉旧 ciWorkflowRunUrl,避免「等待 CI 镜像」卡片的「查看构建」指向旧的失败/无关 Actions run |
| fix | cds | PR review 修复（Bugbot）：workflow_run 标记 ready/failed 时同步 ciTargetSha=head_sha,避免 fallback(按 githubCommitSha)匹配后 ciTargetSha 滞留旧值,导致 check_run 闸门(ready && ciTargetSha===head_sha)永久卡住 |
| fix | cds | PR review 修复（Bugbot）：deploy 路由补极速版 CI 闸门——极速版分支 ciImageStatus=waiting/failed 时手动/内部重部署返回 409 ci_image_not_ready(给可操作提示 + ?ignoreCiGate=1 逃生口),避免 docker pull 不存在的镜像留下噪音错误;非极速版/ready/CI 驱动部署不受影响 |
| fix | cds | PR review 修复（Codex P2）：移除 workflow_run 的 githubCommitSha 兜底匹配,只按 ciTargetSha(显式等待标记)匹配,避免 docs-only push 刷新 githubCommitSha 后其 CI 完成被误部署(docs-only 已显式跳过);早到竞态仍由结果缓存兜底 |
| fix | cds | PR review 修复（Codex P2）：本地 deploy 在 worktree pull 后用真实 HEAD 刷新 githubCommitSha,避免远端已前进时极速版镜像 tag 仍渲染 pull 前旧 SHA 导致跑旧镜像/拉错 tag;主 deploy 与单服务 deploy 两路径均覆盖 |
| fix | cds | PR review 修复（Bugbot/Codex P2）：极速版部署严格锁定 CI 就绪 SHA——deploy 闸门改为「仅 ciImageStatus=ready 且 ciTargetSha===目标 SHA」放行(undefined/align 清空/ready-但-SHA-不符 一律 409);pull 后刷新 githubCommitSha 仅限非极速版,极速版镜像永远锁在 CI 就绪的 ciTargetSha,不跟随 pull 后新 HEAD |
| fix | cds | PR review 修复（Codex P2）：分支卡 CI 徽章改用 deployRuntime?.prebuilt!==false 判定,使 SSE 新建(无 deployRuntime 的原始 BranchEntry)的极速版分支在全量刷新前也显示「等待 CI/构建失败」反馈;明确非极速版(prebuilt=false)仍隐藏 |
| feat | ci | branch-image.yml 改为 path-filter 按组件构建(dorny/paths-filter):只改 prd-api/ 只构建 api、只改 prd-admin/ 只构建 admin、仅 cds/docs 两者都不构建,不再每次重复构建两镜像 |
| feat | cds | 极速版「逐组件回退主分支」(用户决策):DeployModeOverride 新增 fallbackImage;runService 按「本 commit 镜像 → 固定主分支镜像(:branch-main)」优先级 docker pull,任一拉到即用,两者都拉不到才报错——解决 CI 按需构建后某 commit 缺某组件镜像(三场景:只一个构建/都没构建/仅 cds 改动)导致预览起不来 |
| fix | cds | 极速版部署移除手动/单服务硬闸门(改为上面的逐组件回退):deploy 路由不再返回 409 ci_image_not_ready;镜像可用性下沉到 runService 逐组件回退处理,never 硬失败 |
| fix | cds | workflow_run 匹配补「当前仍是极速版」校验(branchUsesPrebuiltMode),分支切回 dev/static 后旧 CI 完成事件不再被认领自动重部署一个已退出极速版的分支 |
| docs | cds | debt.cds.ci-prebuilt 状态枚举改「进行中」(合规 rule.doc.naming);#3「每次构建两镜像」标记已偿还(改 path-filter + 回退) |
| fix | cds | PR review 修复（Bugbot High）：极速版镜像 tag 的 ${CDS_COMMIT_SHA} 优先解析为 ciTargetSha(CI 真正构建镜像的 commit)而非 githubCommitSha——后者会被 docs-only push / 被拦的 check_run 重跑悄悄推进却不产新镜像,用它渲染会拉错 SHA 镜像或静默回退 branch-main,使预览与就绪 CI 产物不一致;ciTargetSha 未设时退回 githubCommitSha |
| fix | cds | PR review 修复（Bugbot）：path-filter 下 docs-only push 不再推进 ciTargetSha / 认领缓存——docs commit 不产镜像,推进会把正在构建的代码 commit 顶成孤儿(永不部署)或让分支显示「CI ready」却指向无镜像 SHA;改为只刷新展示用 githubCommitSha,CI 状态保持等待正在构建的代码 commit |
| fix | cds | PR review 修复（Codex P1）：极速版回退改为**有序回退链**(fallbackImage 支持 string[])——本 commit 无该组件镜像时先退到本分支该组件最近一次构建(:branch-<slug>),再退到固定主分支(:branch-main)。修复「A 改 api、B 只改 admin」部署 B 时 api 直接回退 main、丢掉本分支 A 的 api 改动(混入 main 代码);admin 对称。runService 按链逐个 docker pull,第一个拉到即用 |
| fix | cds | PR review 修复（Codex P2）：slugifyBranchForImage 对齐 docker/metadata-action 的 tag 规则——保留大小写、保留 _ 和 .,只把非法字符序列转 -,使 branch-${CDS_BRANCH_SLUG} 回退能命中 CI 实际推送的 tag(此前小写+改写 _/. 会让 Codex/fix、release/v1.2 等分支回退落空到 main、丢本分支改动) |
| docs | cds | guide.cds.github-webhook-events 补充:极速版(CI 预构建)项目必须额外订阅 workflow_run 事件(需 Actions:Read-only 权限),否则极速版分支永久卡「等待 CI 镜像」;workflow_run 从噪声过滤表移到必订表 |
| fix | cds | 修复预览子域错误/降温诊断页「返回 CDS 控制台」「查看加载页预览」按钮使用相对路径导致落到预览子域而非控制台域名的问题，改用 dashboardDomain/mainDomain 绝对地址 |
| feat | cds | 预览访问自动唤醒：调度器降温的分支被真实页面导航访问时自动 docker restart 唤醒并展示等待页，就绪后落到真实页面，不再甩诊断死页；严格限定调度器降温分支（报错/崩溃/手动停/已删除一律保留诊断页），仅顶层导航触发，可用 CDS_PREVIEW_AUTOWAKE=0 关闭 |
| feat | cds | 新增项目级暂停功能：一键冻结项目（拦截 webhook/自动+手动部署、停止所有运行容器、reconciler 不再重试），项目卡片变灰并显示「已暂停」，恢复后手动重新部署 |
| feat | cds | 新增项目级资源占用统计：周期采样各容器 docker stats 按项目汇总 CPU/内存 + 近 1h/24h 构建频次，卡片显示 CPU/构建频次小标签，新增可排序「资源占用」面板一键揪出并暂停作死项目（GET /api/cds-system/resource-usage） |
| fix | cds | 修复 deploy-dispatch 重试风暴根因（「7 小时前的构建还在跑」幽灵）：stale dispatch 重试加次数上限+指数退避+超龄不复活+在途构建不叠加+暂停项目跳过；首次派发时间锚点不再被重试刷新 |
| rule | skills | 下沉每日视觉验收自动化规则到技能，缩短每日自动化 prompt |
| fix | prd-admin | 修复全局提交缺陷未选择提交用户时缺少明确提示的问题 |
| fix | prd-desktop | 修复群组标题显示 HTML 标签内容的问题 |
| fix | prd-admin | 修复知识库空状态引导卡点击无反馈的问题 |
| chore | doc | 熵清理：D2+D3 补缺 debt.frontend.mobile-control-bar-overload（index.yml + guide.list），D6 处理 5 条 changelog 碎片（2026-06-15 批次） |
| feat | prd-admin | MAP 首页搜索框移到顶部、教程中心卡左侧分列 |
| feat | prd-admin | 教程中心承接卡新增等级帽子系统（7 级配色递进 + 大师/宗师皇冠）与三套视觉效果选型（徽章环/段位条/帽子阶梯） |
| fix | prd-api | 修复网页托管 JPG 图片 MIME 类型错误导致 Logo 显示异常 |
| polish | prd-admin | 加载页 MAP 字标改为单款干净白光（跟随主题），去掉随机彩色/紫色渐变 |
| fix | prd-admin | 加载遮罩背景改透明（去掉「大黑板」），保留并放大 MAP 过渡动画 + 加柔光，确保过渡清晰可见 |
| feat | prd-admin | PPT 创作工作台未连接 CDS Agent 时整页禁用，给「前往连接」引导卡 + 重新检测，不再放行到必然降级的生成 |
| feat | prd-api | 新增 GET /api/md-to-ppt/connection-status 返回 CDS 连接状态 |
| fix | prd-api | 并行逐页生成统计降级兜底页数，done 事件回报 degraded/total，杜绝把全页降级当成功 |
| fix | prd-admin | PPT 生成有页退化为「标题+要点」兜底时如实告知页数 + 警告 toast，不再一律报「PPT 已生成」 |
| fix | prd-api | 降级页数改用 per-page 标记统计，修复 retry 兜底后 EmitAsync 抛异常被外层 catch 重复计数 |
| fix | prd-api | MdToPptRun 持久化 degraded/total 并由 GetRun 返回，刷新/断线恢复仍如实告警降级 |
| fix | prd-admin | 三处 run 恢复路径读取 degraded，降级时同样弹告警 + 改写完成文案，不再报普通成功 |
| fix | prd-admin | 修复批量模型统计接口请求体被二次序列化导致后端 400 |
| feat | prd-api | 知识库跨节点同步支持二进制附件：导出带 peerAttachment 元信息，接收方下载并重传重建附件条目，实现真正一篇不差 |
| feat | prd-api | peer-sync 二进制条目幂等键 peerSourceAttachmentUrl，已下载且字段无变化时廉价跳过，避免重复下载 |
| fix | prd-api | peer-sync 漂移签名纳入附件标识，修复仅二进制文件变化时误报「已同步」 |
| docs | doc | debt.platform.peer-sync 标记原 #1（二进制附件跨节点）已实现，新增 B1-B3 残留边界 |
| fix | prd-api | peer-sync 二进制幂等叠加文件大小校验（同 URL 换字节也重下），漂移签名纳入 size（Bugbot Medium） |
| fix | prd-api | peer-sync 文本条目转二进制时清理被替换的 ParsedPrd，消除孤儿解析文档（Bugbot Medium） |
| fix | prd-api | peer-sync 二进制导出携带规范 sourceId（源头身份）与本地 url 分离，修复 both 双向回流时两侧身份错位、永不收敛（Codex P1 / Bugbot） |
| fix | prd-api | peer-sync MetaEqual 剥离 peerSourceAttachmentUrl 键，避免接收方单边写入导致每次重同步误判已变化反复重写（Bugbot Medium） |
| fix | prd-api | peer-sync 附件下载边读边卡 50MB 上限（流式），防对端不带 Content-Length 时缓爆内存（Codex P2） |
| fix | prd-api | peer-sync 二进制幂等/签名改用「源头侧 att.Size」（存入 peerSourceAttachmentSize 元数据）同口径比对，修复 entry.FileSize≠att.Size 时无限重下循环（Bugbot Medium） |
| fix | prd-api | peer-sync 文本条目转二进制时改写 ContentIndex 为附件提取文本（或清空），消除旧正文残留导致的搜索误命中（Bugbot/Codex Medium） |
| docs | doc | debt.platform.peer-sync 新增 B4：可提取文本文件（PDF/DOCX）仅同步正文不同步原件，留待结构性合并文本/二进制 apply 路径 |
| fix | prd-api | peer-sync 文本覆盖时清空残留 AttachmentId（与二进制路径清 DocumentId 对称），避免同条目同时挂文档+附件引用（Bugbot Medium） |
| fix | prd-api | peer-sync 二进制条目变更检测纳入 ContentType/FileSize/提取文本，文件未变仅元数据变也落更新；文件未变时刷新已存在 Attachment.ExtractedText/FileName，消除陈旧提取文本（Bugbot Medium x2） |
| fix | prd-api | peer-sync 附件下载支持相对 URL：按 sourceBaseUrl 解析对端本地存储返回的相对地址（/api/...），使自托管/本地存储节点也能同步文件（Codex P2） |
| fix | prd-api | peer-sync 文件条目被改成（空）文本时强制走全量更新，避免空文本与文件兜底空串哈希相等导致条目卡在旧文件不转文本（Codex P2） |
| fix | prd-api | peer-sync 形态切换只认「纯二进制」(有 AttachmentId 且无 DocumentId)，双形态条目(PDF/DOCX 同时有文档+附件)文本更新不再误清 AttachmentId，修复 both 回流丢原件（Codex P1 回归修复） |
| feat | cds | 新增 CDS 项目迁移(项目设置「迁移」Tab):一键导出本项目 cds-compose 配置 + dry-run 预演 + merge 推送到另一个 CDS 节点复刻部署;迁移目标(CdsPeer)管理 + 连接测试;数据迁移只读扫描 + 备份/恢复手动桥接。补回早已丢失的迁移路由层(state/类型/API label 尚在,处理器与 UI 缺失) |
| feat | cds | 迁移「添加目标」可填目标节点自己的 Access Key;留空回退本机 key(同时读 process.env 与 Dashboard 全局变量 AI_ACCESS_KEY) |
| security | cds | 迁移仅限人类管理员(CDS cookie 或 GitHub 会话):AI 会话/项目级或全局 Agent Key/静态 AI_ACCESS_KEY 一律 403,杜绝非人类调用方诱导服务端把 bootstrap key 外泄;远端只用 merge(不做 replace-all,避免清空目标其它项目配置) |
| fix | cds | 迁移 Tab 健壮性:跨项目切换 stale-guard(防别项目 cds-compose+明文 env 串显)、加载失败不再无限转圈、verify/replicate/data-plan 统一带回退 key 鉴权(修空 key peer 推送 401) |
| fix | cds | 修复 CDS 系统设置/项目设置长页(如「更新与重启」)滚动条默认隐藏、看似滑不动:壳 h-screen 固定 + 内容区 .cds-main 自身 overflow-y:auto + scrollbar-gutter:stable + 全局 ::-webkit-scrollbar 常驻可见非 overlay,顶栏/左导航钉住 |
| fix | prd-admin | 修复更新中心空数据渲染崩溃:releases/fragments/days/entries/highlights 全面补空值保护,避免整页跌入错误边界;更新中心滚动区加 .clg-scroll 常驻可见滚动条 |
| fix | cds | 迁移「节点地址」输入框默认值由 noroenrn.com(测试残留)改为空,仅保留 placeholder,避免误添加错误目标 |
| fix | cds | 迁移连接测试/数据扫描探活改用 import-config dryRun(复刻真正会打的端点)而非 /api/me:后者在 github-auth 远端无 cookie 会 401、auth-disabled 远端无脑 200,都无法证明 key 有效;/api/me 仅降级为取友好名(PR #909 Bugbot) |
| fix | cds | 迁移 guard 在 CDS_AUTH_MODE=disabled(开放面板)下放行:该模式无 cookie/session 标记且本无安全边界,否则迁移整页 403 不可用(PR #909 Codex P2) |
| fix | cds | 迁移连接测试不再把探测成功后的落库/响应失败误报为「连接失败」:仅网络探测放进该 catch,落库失败走正常 500(PR #909 Bugbot Low) |
| fix | prd-admin | 修复创建智能体测试对话流式输出时持续抢占用户滚动的问题 |
| fix | cds | 调度器永不降温主干分支：SchedulerService.isPinned 新增按 git 分支名判定主干（项目 gitDefaultBranch，兜底 main/master），与 Project.defaultBranch（CDS 分支 id，可能未配置/不符）解耦，根治「主分支空闲超阈值被自动降温」。空闲降温与容量驱逐两条路径均跳过主干 |
| fix | prd-admin | 修复百宝箱分享智能体详情返回后仍停留在窄筛选状态的问题 |
| fix | prd-admin | 修复 VOC 体验全景热力图「时铺满时留白 + 入场动画随机不播」：ResizeObserver 改用回调 ref（容器一挂载即测量），入场闸门绑到真实测量尺寸首帧 |
| refactor | prd-admin | VOC 桌面看板全景热力图升为主角约 2/3 满高，右栏约 1/3 还原排布（趋势整宽在上、痛点指数仪表盘 + 声道并排在下），仪表盘填满首屏视口、底部明细全宽下移滚动可见 |
| refactor | prd-admin | VOC AI 用户分析从底部内联面板改为点击触发的右侧抽屉（与端点下钻同一种抽屉），按钮文案改「AI 用户分析」 |
| fix | prd-admin | 修复 VOC 同时打开下钻抽屉与 AI 用户分析抽屉时 ESC 误关被盖住的下钻抽屉：ESC 改按视觉层叠关最上层（brief 先于 drill） |
| feat | prd-admin | VOC 热力图卡头新增常驻「AI 用户分析」入口：仪表盘填满整屏后底部触发按钮落到首屏下，故首屏热力图头部再放一个一键入口（点击才分析），底部入口保留 |
| fix | prd-api | 提高网页托管 ZIP 文件数上限以支持多资源静态页面上传 |
| fix | prd-admin | 上传站点文案提前提示 ZIP 文件数上限 |
| fix | prd-api | 修复普通用户标记周报海报已读被模板管理权限拦截 |

### 2026-06-22

| 类型 | 模块 | 描述 |
|------|------|------|
| perf | cds | GET /api/branches 列表加短 TTL 缓存（默认 1s）+ 同 key 并发去重 + 并行解析各分支资源，10+ 并发从"各算一遍串行排队 5s+"降为"只算一次"，显著提升高并发吞吐 |
| perf | cds | GET /api/branches 命中缓存的 dashboard 请求改发预序列化 JSON 串（widget 请求仍走 res.json 过滤），10+ 并发不再每请求重复全量序列化 |
| perf | cds | 状态广播（state-stream SSE）改为前沿即时+尾沿合并节流，构建期 deploy-log 追加风暴不再每次全量序列化整个 state，消除构建时仪表盘与所有 /api/* 集体卡死 |
| perf | cds | 新增全局构建并发闸（CDS_MAX_CONCURRENT_BUILDS，默认 3），多分支同时部署时排队，避免构建互相饿 CPU（实测并发时 admin 构建从 ~300s 膨胀到 845s） |
| feat | cds | 构建排队状态写进部署日志 + SSE + /api/cluster/status，用户看到「排队中，前面还有 N 个」而非疑似卡死的 spinner（每 15s 刷新位置） |
| fix | cds | 修复 cleanup-stopped 缺项目级鉴权（Bugbot High）：项目级 cdsp_ key 未带 ?project= 时锁定到自身项目，跨项目一律 assertProjectAccess 403，杜绝越权批量删分支 |
| fix | prd-api | 资产存储 auto 模式部分云凭据 fail-fast（Codex P2）：凭据配一半时报错而非静默回退本地，避免资产写容器本地盘重部署即丢；仅完全无云凭据才用 local 占位 |
| fix | prd-api | 本地存储传图 URL 可读（Codex P2）：image-master 文件读取补 assets/img + cds/img 两域，修复 local 模式下知识库/CDS 传图返回的 URL 404 |
| refactor | cds | 移除分支列表页孤儿轮询（Bugbot Low）：opsStatus/hostStats 写后不读且与 MonitoringDialog 的 useMonitoringData 重复轮询，删之省去 8s+30s 冗余请求 |
| fix | cds | 修复 cleanup-damaged-containers 缺项目级鉴权（Codex P1）：同 cleanup-stopped，项目级 cdsp_ key 锁定到自身项目，杜绝跨项目删容器 |
| fix | cds | 修复执行器卡片分支数恒显示 0（Bugbot Medium）：/api/executors 返回 branches 数组无 branchCount，卡片改用 branchCount ?? branches.length 兜底 |
| polish | cds | 分支卡片等高：停止/降温/出错时隐藏服务端口"那一横"，在同一槽位单行显示统一状态提醒（停止来源/调度器降温原因/错误），每张卡片此行恒单行 → 等高 |
| refactor | cds | 卡片错误提醒只此一处：删除底部单独的 BranchFailureHint 错误块，错误并入统一状态行（含完整失败原因，hover 看全文） |
| refactor | cds | 合并"运维监控"与"运维"为单一「运维」面板：MonitoringDialog 新增"运维操作"页签承载原 OpsDrawer 内容（清理/运维状态/请求观测/痕迹），项目页与项目列表入口统一为「运维」，删除重复按钮与 OpsDrawer |
| feat | cds | 运维抽屉新增「日志中心」页签：权威系统事件日志（GET /api/server-events，容器/docker/系统三类 + 严重级过滤 + 刷新），统一可观测入口 |
| refactor | cds | 运维面板改回侧抽屉（不再是居中弹窗）：MonitoringDialog 重做为右侧抽屉（背景遮罩+ESC+滑入），保留页签 |
| refactor | cds | 运维操作拆为多个页签：原单一"运维操作"页签拆为 清理 / 运维状态 / 请求观测；删除与内置 性能/执行器/活动 重复的 主机健康/执行器/最近活动 段及死代码 |
| feat | prd-api | 强化缺陷自动化每日计划提示词，加入协议自检、环境边界、无缺陷收尾和正式发布后验收通知规则 |
| feat | prd-admin | 缺陷自动化面板新增自动化边界说明，降低每日任务误用风险 |
| feat | scripts | 新增缺陷自动化协议探针脚本，用于每日任务启动前校验 domain、K、scope 和 workflow 版本 |
| docs | doc | 更新缺陷自动化协议，补充安全自检与每日任务提示词要求 |
| fix | prd-api | 明确缺陷自动化正式缺陷系统读写与测试/预览环境验收边界 |
| fix | prd-admin | 缺陷自动化面板补充正式缺陷系统读写、测试/预览验收的边界说明 |
| security | prd-admin | 工作流模板 CSV 占位示例与缺陷导入测试 fixture 中的真实人名脱敏为合成占位（负责人A/B/C、测试处理人/创建人），消除 #700 真名残留 |
| chore | doc | 熵清理：D1 0 个，D2 +2/-0，D3 +2/-0，D4 +0/-0，D6 5 条 |
| feat | prd-api | 更新中心新增 GitHub 待审核提交接口并纳入后台刷新 |
| feat | prd-admin | 更新中心新增 GitHub 待审核提交页签展示 open PR |
| rule | prd-api | 每日缺陷自动修复规则要求 PR 不得为草稿并明确继续或停止条件 |
| fix | prd-admin | 更新中心 GitHub 待审核提交行补齐自动化缺陷关联标记 |
| feat | prd-api | 资产存储新增 local provider + auto 兜底：ASSETS_PROVIDER 未配且无云凭据时回退本地占位存储，修复无云凭据实例（如 CDS 预览）上传图片直接失败 |
| feat | prd-api | 知识库新增单独上传图片接口 POST /api/document-store/stores/{id}/images（multipart，返回稳定 URL），解决"上传 HTML 报告内嵌图存不住、又无单独传图入口" |
| fix | prd-admin | HTML 报告 srcDoc 注入 viewport + 流式 CSS，修复移动端验收报告显示过小（按设备宽度重排而非 980px 桌面视口缩放） |
| docs | chore | create-visual-test-to-kb / cds 两个 skill 补资产存储后端（local/R2/COS）+ 单独传图接口说明 |
| refactor | prd-admin | 抽取首页静态入口（智能体/实用工具/基础设施）到 lib/homeLauncherItems 作为桌面+移动共用 SSOT |
| feat | prd-admin | 移动端首页补回「基础设施」区（知识库置首），与桌面首页同源，消除知识库手机端找不到的割裂 |
| feat | prd-admin | 移动端「我的/设置」页新增「平台能力」快捷入口（知识库置首），知识库多处可达 |
| feat | prd-admin | 新增移动端可复用原语 MobileBottomSheet/MobileSegmented/MobileFab（components/mobile/） |
| feat | prd-admin | AI 百宝箱「发现」手机端原生重构（MobileToolboxView）：首屏即时出内容不卡加载、段控+横滚 chip+FAB、智能体 2 列大卡铺满 |
| refactor | prd-admin | 抽取 Agent 配色/图标解析到 lib/agentAccent（移动端 SSOT），MobileHomePage 改用共享件 |
| feat | prd-admin | 移动端 headbar 统一形态（共享 TabBar）：标题居中、tabs/操作各自单行横滚 + 右侧渐隐滚动提示 |
| feat | prd-admin | 移动端隐藏 TabBar 内嵌教程 pill，让出顶部空间；教程改由「我的 → 学习中心」入口承载 |
| rule | - | onboarding-tips 规则补移动端例外（手机隐藏教程 pill，收进学习中心 + 自动开讲不变） |
| fix | prd-admin | 移动端 headbar 内容垂直居中（surface-nav-content justify-content center），修复单行 tab 顶到上方 |
| feat | prd-admin | 新增移动端溢出菜单原语 MobileOverflowMenu（components/mobile/），治"控制条过载"一类问题 |
| feat | prd-admin | 知识库列表工具栏手机端瘦身：统计/发送到/接入AI 收进「⋯更多」Sheet、新建知识库改 FAB，桌面端零改动 |
| docs | - | 新增 doc/debt.frontend.mobile-control-bar-overload 控制条过载治理台账（机制+优先级清单+候选文件） |
| fix | prd-admin | 移动端 headbar 的 tab 整组水平居中（surface-nav-tabs: safe center），放不下退化为横滚 |
| fix | prd-admin | 移动端 TabBar 工具栏改单行横滚（surface-nav-content nowrap+overflow），修复 tabs+教程在手机端换行成两行 |
| feat | prd-api | 知识库双向同步新增「后台自动同步」：PeerSyncScheduleWorker 按周期复用最近一次同步的对端+方向自动 push/pull/both（非破坏性，绝不删条目），默认每小时、下限 5 分钟 |
| feat | prd-api | 新增 POST /api/peer-sync/auto-sync 端点开关单库自动同步（仅 document-store，须先手动同步过一次） |
| refactor | prd-api | 抽出 IPeerSyncTransferService（per-item 同步核心 + 网络/台账/归属辅助）为 SSOT，手动 transfer 与自动同步 worker 共用同一条路径，杜绝逻辑漂移 |
| feat | prd-api | DocumentStore 新增自动同步字段（PeerSyncAutoEnabled/IntervalMinutes/AutoLastAt + 分布式租约 LeaseOwner/ExpiresAt），共享 Mongo 多容器下同库同刻仅一容器同步，防请求风暴 |
| feat | prd-admin | 同步中心弹窗新增「后台自动同步」开关 + 周期选择（每15分/小时/6小时/天），未手动同步过的库禁用并提示 |
| test | prd-api | 新增 PeerSyncScheduleTests 守卫到期判定（未开启/无对端/进行中/周期内/周期下限夹紧不误触发） |
| fix | prd-api | 自动同步 worker：因「不到期/已关」提前返回时不再推进 PeerSyncAutoLastAt，避免把未真跑的尝试记成满周期延后下次同步（Bugbot） |
| fix | prd-admin | 同步中心方向标签去除天平/箭头等符号字形，改纯文本（CLAUDE.md §0 禁 emoji，Codex P1） |
| fix | prd-admin | 同步中心交互草图(assets/prototypes)清除全部 emoji 图标，改纯文本（CLAUDE.md §0，Codex P1） |
| fix | prd-admin | 知识库卡片「更多」菜单补 onMouseDown stopPropagation，修复菜单项点击前被 document mousedown 卸载（Bugbot/Codex） |
| fix | prd-admin | 知识库置顶保存失败时回滚到操作前集合（原 prev2=>prev2 空操作不撤销乐观更新，Bugbot） |
| docs | prd-api | spec.knowledge-base.transfer-protocol H1 补 · 规格 后缀 + 版本/日期/状态 标准头（doc-naming，Codex） |
| fix | prd-api | 自动同步 worker 释放租约按 owner 限定（仅 PeerSyncLeaseOwner==本实例才清），避免超时被接管后误清新持有者租约放行第三次并发同步（Bugbot High） |
| fix | prd-api | 同步 apply 的廉价跳过纳入 sortOrder/category 比较，修复仅排序/分类变化被漏同步（Bugbot） |
| fix | prd-admin | 同步台账轮询加发号器 stale-response 守卫（DocumentStorePage + SyncCenterDialog），防慢响应覆盖新状态 |
| fix | prd-api | 手动 transfer 与自动 worker 共用库级互斥租约（TryAcquireStoreSyncLeaseAsync），手动同步进行中 worker 抢不到、反之手动撞上自动直接跳过，杜绝同库并发同步（Bugbot 复发项） |
| fix | prd-api | 自动同步 worker 补防自指守卫（对端 RemoteNodeId==selfNodeId 跳过），与手动 transfer 同口径，治共享 Mongo 预览自我同步（Bugbot） |
| fix | prd-api | BuildActorAsync 恢复权限兜底：GetEffectivePermissions 瞬时失败时退回调用方传入的 JWT claims 权限，避免 super 用户被误降级（Bugbot） |
| fix | prd-api | IsDue 不再用 PeerSyncStatus==syncing 判在途（崩溃残留 syncing 会永久禁用该库自动同步），改由租约承担互斥+在途检测（有 TTL 自愈）（Bugbot High） |
| fix | prd-api | 库级同步互斥租约 TTL 10min→30min 并 worker/手动共用同一常量，覆盖大库最坏同步耗时防超时被并发抢锁；>30min 超大库的心跳续租列入 debt.platform.peer-sync（Bugbot High） |
| fix | prd-admin | 详情页同步按钮「进行中」只认近 30 分钟内的 syncing 运行（与租约 TTL 同口径），不再叠加可能陈旧的 store.peerSyncStatus，避免崩溃后永久脉冲（Bugbot） |
| fix | prd-api | 自动同步 worker 成功通信后 bump 对端 PeerNode.LastContactAt（与手动 transfer 同口径），修复纯后台同步部署「最近通信」长期陈旧（Bugbot） |
| fix | prd-api | 同步 apply 文件夹 upsert 纳入 SortOrder/Category 比较与写入，修复目录手动排序/分类漂移被漏同步（Codex） |
| docs | prd-api | spec.knowledge-base.transfer-protocol 去除星标记字形，改 (v1.1) 纯文本（CLAUDE.md §0，Codex P1） |
| fix | prd-admin | 同步中心面板「进行中」判定同样加 30 分钟新鲜窗口（头部转圈/tab 计数/2s 轮询），与详情页一致，陈旧 syncing 台账不再永久脉冲（Bugbot） |
| fix | prd-admin | 同步台账卡片(RunCard)对陈旧 syncing 行(超30min)显示为中性「未完成」而非金色脉冲，与进行中判定一致（Bugbot） |
| fix | prd-api | 同步完成（手动/自动）终态回写一并重置 PeerSyncAutoLastAt，避免手动同步一个已到期库后 worker 约 1 分钟内又自动跑一遍（Bugbot） |
| fix | prd-admin | 知识库排序保存失败时回滚 defaultSortMode（同置顶回滚），避免侧栏排序与服务端不一致（Bugbot） |
| fix | prd-api | 自动同步 worker 每次尝试用唯一租约持有者（实例id+guid），杜绝下一扫描周期因「同 owner 可重入」在同实例叠开同库第二个同步（Bugbot High） |
| fix | prd-api | 漂移签名 ComputeSignature 纳入 sortOrder/category/defaultSortMode，避免仅排序/分类变化时签名不变、漂移检测误报已同步（Codex） |
| fix | prd-api | 自动同步 sourceBaseUrl 兜底取 config["ServerUrl"]（worker 无 Request），反代部署未设 PEER_SELF_BASE_URL 时图片本地化不再降级（Codex） |
| fix | prd-admin | 知识库置顶写入串行化（合并为最新一次、单请求在途、失败拉服务端权威值），杜绝快速连点乱序丢项 + 陈旧回滚丢新选择（Codex） |
| fix | prd-admin | 同步中心自动同步开关跟随 props 更新（onAfterSync 重载后不再与服务端不一致，Bugbot） |
| fix | prd-admin | 置顶写入失败且在途又有新点击时继续发最新意图（不再 return 致最新选择不落库；无 pending 才拉服务端纠正），Codex |
| fix | prd-api | 修复 PRD 问答默认提示词缺少无 emoji 与提示注入防护约束 |
| polish | prd-admin | 视觉创作工具栏做减法：移除 Mark/上传视频/智能画板/形状文本 等未开发的禁用占位项，单项的「+新增」下拉收敛为直接「上传图片」按钮 |
| feat | prd-admin | 视觉创作桌面端「对话优先」：进入编辑器且画布无产物时自动聚焦右侧输入框，描述即生成无需先摆生成框 |
| fix | prd-admin | 视觉创作手机端补回 pc-only 门槛：该页是独立全屏路由绕过 AppShell 导致 MobileCompatGate 失效，手机用户直接走进桌面画布产生留白；现手机访问显示「建议用电脑」门槛，桌面端不受影响 |
| fix | prd-admin | 视觉创作「对话优先」聚焦改绑画布恢复完成点：原独立 1200ms 定时器在 workspace 切换后不再重跑、且会在画布异步水合前误判空画布抢焦点（有作品时也抢）；现并入 boot 恢复完成的 applyCanvasFocus，按 workspace 每次重判、确认无产物才聚焦 |
| feat | prd-admin | 视觉创作生图等待加「计时可见性」：画布 running 占位新增 已耗时(每秒+) + 平均预计时长(历史耗时指数滑动平均存 localStorage,首样本前 40s 兜底) + 进度条(按时间逼近封顶95%,超时转黄显示「即将完成」),消灭空等焦虑;running→done 自动采样刷新平均 |
| feat | prd-admin | 视觉创作生图加载动效换新（贴合靛蓝新主体风格）：running 占位由旧「金色 Nebula 花瓣」改为「流光进度条」GenSweepLoader——靛蓝斜向流光扫过 + 底部计时条(已耗时/预计~Ns/渐变进度条,超时转黄「即将完成」),倒计时融入动效;计时 helper 抽到 lib/genTiming.ts、loader 抽成 components/ui/GenSweepLoader.tsx 复用;error 态仍用花瓣灰显 |

### 2026-06-21

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 修复分支部署失败时卡片永远转圈不更新：部署 catch 分支补发 branch.status SSE 事件，前端无需刷新即可看到失败态 |
| feat | cds | 项目页新增"清理停止分支"一键清理（清理孤儿右侧）+ POST /api/branches/cleanup-stopped |
| fix | cds | 修复 Webhook 日志按分支过滤双重前缀 bug 导致"永远只命中一条"：比对前 ref 归一化去 refs/heads/ 前缀 |
| perf | cds | Janitor 周期安全清理 Docker 悬空镜像 + 构建缓存（不碰容器/卷/有 tag 镜像），根治几百次构建后构建越来越慢 |
| docs | cds | 新增 debt.cds.performance 性能债务台账：构建变慢根因(Docker 垃圾堆积) + mongo 索引非主因结论 + 逐步解决路线 |
| fix | cds | 修复 CDS 系统更新弹窗"目标分支"下拉选中后不关闭（选中回焦输入框时被 onFocus 重新打开）|
| fix | cds | 修复"重启未确认"频繁误报：除 daemonReadyAt 外，用进程启动时间 __CDS_PROCESS_STARTED_AT 兜底确认重启完成；server.ts 顶层判定同步对齐并对 web-only 更新判 not_required |
| fix | cds | 修复集群统计 embedded 主节点 CPU/内存/容器数/分支数恒为 0：新增 refreshEmbeddedMasterLoad，按需从 os + 主节点状态重算真实负载 |
| feat | cds | 项目列表页与项目页右上角新增"运维监控"入口，性能(含容器总数)/执行器/活动三页签展示，取代单列长滚动 |
| perf | prd-admin | Dockerfile 增加 pnpm BuildKit 缓存挂载，避免每次分支预览构建从零重装依赖 |
| perf | cds | Dockerfile 增加 pnpm BuildKit 缓存挂载 |
| polish | cds | 分支等待页 ETA 文案标明为"本项目"口径并带构建模式(发布版/热加载)，澄清非单分支均值 |
| polish | cds | 发布弹窗增加发布前检查/提交任务/发布进行中的阶段反馈与"已用时"计时，消除等待期空白(2 秒原则) |
| perf | cds | 性能专项：定位首要根因为预览调度器被禁用（空闲分支永不回收致 43 容器堆满 18 核主机，load 28），启用 warm-pool 调度器后运行容器 43→10、主机负载回落 |
| feat | cds | 新增运维健康观测端点 GET /api/cds-system/perf-health（host load/容器数/调度器状态/各项目构建中位 + 告警），监控弹窗性能页签顶部「运维健康告警」红黄横幅 + 调度器状态 + 构建耗时中位 |
| feat | cds | 后端每 5 分钟 perf-health 自检：调度器禁用/主机过载/容器堆积命中即告警进日志，避免性能事故静默复发 |
| chore | doc | 熵清理：D4 +1（acceptance-test-design 技能表补缺），D6 处理 5 条 changelog |
| security | prd-api | VOC 下钻样本/AI 诊断请求体脱敏:屏蔽 password/token/secret/authorization/cookie/签名 等键值,不再把 /auth/login 之类明文请求体外泄给 read 用户或 LLM prompt |
| fix | prd-api | VOC 下钻改整路径锚定正则查询(:id 段→[^/]+),修复广泛 :id 家族下目标行落到 5000 上限外致计数低估;转需求访问域放行产品应用管理员(AdminIds) |
| fix | prd-admin | 热力图 SVG 渐变 id 经 useId 唯一化(全屏+格内双实例不再冲突);自定义范围密度数据加载后重置刷选选区(避免开早了 Apply 误选最旧一天) |
| fix | prd-admin | 行为洞察热力图改像素级 viewBox 彻底铺满整格(消除 meet letterbox 左右黑边) + 声道看板去掉与220px行高冲突的minHeight撑破、改格内滚动 + 四图行高244px |
| feat | prd-admin | 行为洞察电脑版改 Bento 看板：大小不一拼一起 + 趋势空吸收补满 + 热力图全屏放大铺满动画；移动端单列堆叠 |
| fix | prd-admin | 行为洞察热力图全屏/格子 aspect-aware 沾满（ResizeObserver 按容器真实宽高比布局，消除上下 letterbox 空白） |
| fix | prd-admin | 行为洞察四图仪表盘等高填满格子（地图/趋势/痛点指数/声道看板各自 flex-1 撑满，无底部空白） |
| fix | prd-admin | 行为洞察趋势爆点无数据（桶<2 或全 0）时桌面整格隐藏，不显示空壳 |
| fix | prd-admin | 行为洞察四图流式自适应：趋势隐藏后剩余格自动重排铺满不留洞（奇数格末格横跨两列） |
| fix | prd-admin | 行为洞察:热力图/趋势拉取失败清空旧数据(不再残留上个时间窗) + 下钻透传选中to(诊断不再默认end=now) + 下钻按叶子真实kind(slow不误标api-error) + 缺陷弹窗无预填时重置(不残留上次VOC草稿) |
| fix | prd-api | 体验之声转需求:补产品访问域校验(负责人/成员/product-agent.manage,杜绝越权写任意产品需求池) + 重算Product.RequirementCount去规范化计数 |
| feat | prd-admin | 团队动态更名VOC(菜单/页头/短标签) + 行为洞察tab置前并设为默认首屏(?tab=feed回动态流) |
| fix | prd-admin | 行为洞察 insights 拉取失败时也清空旧数据(与热力图失败清空对称),痛点榜/ribbon/stats 不再与空热力图打架 |
| fix | prd-api | VOC 洞察聚合自排除 /api/team-activity + /api/behavior(慢/错聚合及兜底,与热力图/趋势同口径),杜绝仪表盘自身慢请求回流成关于 VOC 页的洞察反馈回路;转需求初始化 StateEnteredAt,产品看板 SLA 首次流转前正常显示 |
| fix | prd-admin | 趋势爆点标记画在当前桶主导的那条线(慢主导=黄/报错主导=红),slow-only 突增不再误画到红色报错线基线;用户之声不传 filter 取全员缺陷全局列表(filter:all 会被后端限定为"我相关",漏掉他人提交) |
| fix | prd-admin | 时间控件预设悬浮预览对齐实际窗口:本周/本月按本周一/1号至今聚合(不再用滚动近7/30天),预览数字与点击后加载一致 |
| security | prd-api | VOC 下钻脱敏扩展:覆盖 application/x-www-form-urlencoded / 查询串 key=value(password=/client_secret=)+client_secret JSON 键,堵住非 JSON 请求体明文外泄;转需求幂等仅在选中产品命中时返回,杜绝跨产品需求元数据泄露 |
| fix | prd-admin | VOC 时间窗一致性收口:「全部」实际加载近90天(resolveRange 显式传 from,与悬浮预览同口径) + 自定义刷选本周/本月初始选区按 presetFrom(本周一/1号)对齐 + 用户之声(真实缺陷)随时间窗过滤并重拉,与行为之声同窗口 |

### 2026-06-20

| 类型 | 模块 | 描述 |
|------|------|------|
| perf | prd-admin | 手机端密度优化（共享原语）：全局内容外边距 16→10px、GlassCard 嵌套卡片手机端自动去 chrome（收紧内边距+缩小圆角+去投影）、PageHeader 手机端收紧、新增 useIsMobile 轻量选择器 |
| rule | prd-admin | 新增 mobile-first-density 规则：手机端满铺单层 padding / 不堆嵌套卡片 chrome / 进内容前≤1条控制条 / 内容占视口≥60% |
| feat | prd-admin | 行为洞察 VOC 闭环「转为缺陷」改为弹窗：预填可编辑标题/正文 + 指派人（发给谁）+ 严重度，确认后才创建 |
| feat | prd-admin | 行为洞察 VOC 闭环「转需求」改为 3 步向导弹窗（选产品 → 核对内容 → 确认流转）+ 顶部步骤进度指示，替换下钻抽屉就地展开 |
| feat | prd-api | 团队动态行为洞察新增端点下钻明细（GET /api/team-activity/endpoint-detail）与 AI 根因诊断 SSE 流式端点（GET /api/team-activity/diagnose），注册 AppCaller prd-admin.team-activity.endpoint-diagnose::chat |
| feat | prd-admin | 体验全景热力图点痛点块/痛点榜「AI 诊断」→ 右栏切换为下钻抽屉（四级面包屑 + 错误码分布 + 真实请求样本 + AI 根因诊断流式 + 转为缺陷） |
| fix | prd-admin | 体验热力图痛点辉光描边移到顶层装饰层，修复被相邻块覆盖导致边框光效被裁掉 |
| polish | prd-admin | 突增彗星重做为块内斜向上飞的渐隐流星（静止帧透明），消除停在角落像「棒棒糖」的观感 |
| refactor | prd-admin | 行为洞察「转为缺陷」复用真实缺陷面板（GlobalDefectSubmitDialog 加预填/创建回调），删除自造 DefectConvertModal |
| polish | prd-admin | 行为洞察下钻诊断改右侧整高 drawer（440px / min(440px,94vw)，滑入 + 遮罩/ESC 关闭） |
| feat | prd-admin | 行为洞察声道看板「用户之声」改拉用户主动提交的真实缺陷（listDefects 倒序），「行为之声」保持遥测痛点 |
| refactor | prd-admin | 行为洞察删除痛点雷达视图（移除 ExperienceRadar） |
| feat | prd-admin | 行为洞察电脑版改 2×2 四图仪表盘（端点地图/趋势爆点/痛点指数/声道看板），站点地图并入端点地图格切换；移动端单列单图切换 |
| refactor | prd-admin | 团队动态-行为洞察布局重构为热力图 Hero（占满整宽，ribbon/痛点指数/痛点榜/已闭环下放纵向堆叠） |
| refactor | prd-admin | 团队动态-视图切换(动态流/行为洞察)移到页头 tabs、时间范围 chips 移到页头 actions 显眼可见 |
| feat | prd-admin | 团队动态-热力图新增全屏放大浮层(createPortal+中心放大入场动画+更多标签层级)与右侧滑入下钻浮层抽屉 |
| feat | prd-admin | 团队动态-时间范围切换过渡态：旧内容保留可见+顶部扫光+重聚合提示，消除「本周→全部」卡顿观感 |
| perf | prd-admin | 团队动态-行为洞察视图下不再拉取动态流 feed 数据，减轻切换卡顿 |
| polish | prd-admin | 行为洞察手机端满铺改造：GlassCard 新增 mobileFlush（顶层卡手机端去边框/圆角/底色满铺到边）+ 嵌套卡彻底去 chrome、InsightsPanel 顶层卡满铺 + 内容贴边、热力图手机端长满首屏(min(66vh,600px))吃掉下方空白 |
| fix | prd-admin | 行为洞察头部/ribbon/视图切换/热力图/弹窗手机端响应式修复，根治逐字竖排与文字重叠 |
| feat | prd-api | 团队动态行为洞察新增趋势爆点端点 GET /api/team-activity/experience-trend（按时间桶聚合报错/慢请求，桶粒度自适应小时/天，30s 缓存 + 兜底空桶） |
| feat | prd-admin | 行为洞察 Hero 支持多视角切换（热力图/趋势爆点/痛点雷达/站点地图/声道看板）五视图 |
| feat | prd-api | 团队动态-行为洞察新增 insights/to-requirement 端点：体验痛点一键流转产品需求池（生成 Requirement + 回写关联） |
| feat | prd-api | SetInsightState 标记 resolved 时快照坏请求基线，insights 响应附 reboundPct 复测回落百分比 |
| feat | prd-admin | 体验下钻抽屉新增「转需求」按钮 + 产品选择，已转显示「已转需求 #No」chip |
| feat | prd-admin | 痛点榜/已闭环条目展示「需求 #No」chip 与复测回落徽章（已回落/复发/基本持平） |
| feat | prd-admin | 闭环 ribbon 升级：转缺陷/需求合并展示，复测回落改为「N 个已回落 / M 个复发」 |
| feat | prd-api | 团队动态体验全景热力图叶子新增 burstPct 环比突增百分比（上一等长窗口坏请求聚合 join，仅痛点且 badCur>=5 时有值） |
| feat | prd-admin | 体验全景热力图痛点块新增「突增 +N%」徽章 + 彗星动画（burstPct>=50 触发） |
| feat | prd-admin | 团队动态行为洞察新增闭环 ribbon（监测/预警/AI 根因/转缺陷/修复追踪/复测回落六阶段，从热力图与洞察数据现算） |
| feat | prd-admin | 团队动态时间选择控件落地（方案1+方案2 结合）：预设胶囊悬浮微预览（真实信号/痛点数 + mini sparkline）+ 自定义范围活动密度刷选条（近 90 天密度柱 + 双把手拖动刷选，应用时才提交），接 experience-trend 真实数据前端聚合，from/to 透传 feed/stats/insights |

### 2026-06-19

| 类型 | 模块 | 描述 |
|------|------|------|
| chore | doc | 熵清理：D1 0 个，D2 +0/-0，D3 +0/-0，D4 +0/-0，D6 5 条 |
| feat | prd-api | 团队动态新增体验全景热力图端点 GET /api/team-activity/experience-map（按模块聚合端点访问量/报错率/慢请求率，与 insights 同源 apirequestlogs，target 同口径供下钻联动） |
| feat | prd-admin | 行为洞察 tab 顶部新增体验全景热力图（squarified treemap）：每块=端点、面积=访问量、颜色=健康，痛点带发光描边，点击下钻联动到下方痛点榜对应行 |
| fix | prd-admin | CDS 静态部署修复：serve 改为本地 devDependency + pnpm exec serve 启动，避免受限网络下运行时拉包失败(Command serve not found) |
| polish | prd-api | 体验全景热力图模块/端点名改中文示意名(SegmentLabels+LeafLabel)，原始路径保留在悬浮提示，分区上限放宽到 24 |
| feat | prd-admin | 体验全景热力图入场动画(react-bits 交错揭示)+ 实时扫描光带 + 醒目"实时扫描中"徽章；右侧新增可折叠"体验痛点指数"仪表盘 + 痛点声道占比(从痛点榜现算) |
| docs | doc | 新增 design.team-activity.voc 设计文档(VOC 设计思想/数据流/波次规划)，同步 index.yml 与 guide.list |
| polish | prd-admin | 热力图入场动画重做为两遍「写字→点睛」：块随扫描笔尖经过(按x位置)依次写出全部→写完后痛点才点睛(扩散环ping+脉冲描边+辉光)；扫描笔与块写出严格同步且一次画完即隐(不空转)，绑定真实数据刷新重放 |
| feat | prd-admin | 热力图换时间窗时块「生长」morph：几何尺寸/位置 CSS 过渡平滑补间(谁访问多谁长大可见)；入场写字+点睛用 isEntrance 闸门仅首屏放一次，之后只 morph 不重演 |
| fix | prd-admin | 修复热力图左上角文字糊块：CSS x/y 几何属性对 <text> 无效导致所有标签掉回原点(0,0)堆叠，文字位置改回属性(rect 尺寸仍走 style 过渡做生长) |
| perf | prd-api | 体验全景热力图端点性能优化：分组下推到 MongoDB 聚合(服务端归一化路径+$group，只回传分组桶，不再拉最多6万条文档)+ 30s TTL 缓存(来回切档秒回)+ 聚合失败回退旧路径兜底 |
| perf | prd-api | insights 端点报错/慢两段也下推到 MongoDB 聚合(报错用 $facet 同时算分组去重人数与错误码计数、慢用单组，userCount/durSum 服务端算好只回传≤千桶，不再各扫2万文档)，聚合失败回退 C# 扫描兜底；行为事件量小保持原样 |
| polish | prd-api | 热力图痛点判定增加绝对次数门槛(报错/慢≥5次)，与痛点榜阈值对齐，减少"点了红块却未上榜"的困惑 |
| polish | prd-admin | 点击未上榜痛点块的提示写清楚：显示端点名+指标+为何没上榜(累计≥5次才上榜)，不再含糊 |
| feat | prd-admin | 体验全景热力图新增「全域/痛点」双模式切换：全域=全部端点按访问量，痛点=只看病灶按问题严重度(访问量×报错/慢率)放大占满画布，切换即 morph 聚焦；痛点模式无病灶给"全部健康"空状态 |

### 2026-06-17

| 类型 | 模块 | 描述 |
|------|------|------|
| chore | doc | 熵清理：D3 补缺 1 条（plan.md-to-ppt.next-wave），D6 处理 5 条 changelog（补全对应 design 文档） |
| chore | doc | 新建 design.ccas-agent.md（PRD 生成 + 设备素材库 + 流程示意图三件套设计文档） |
| chore | doc | 补全 design.skill.marketplace-open-api.md §十一（技能分享 UX 增强：分享弹窗 / 公开页免登录下载 / 我的分享聚合 / 排序调整） |
| chore | doc | 补全 design.shortcuts-agent.apple.md §十一（剪贴板健壮性 + 连接自检端点 + 安装页增强） |
| chore | doc | 补全 design.workflow-agent.auto-config.md §十（Phase 1-2 实现备注：SSE 修复 / 校验容错 / 补缺接线 / 门禁加严 / 持久化），状态从「待评审」更新为「Phase 1-2 已实现」 |
| chore | doc | 同步更新 doc/index.yml 和 doc/guide.list.directory.md（新增 design.ccas-agent 条目） |
| security | prd-api | 修复工作流手动执行入口缺少私有工作流归属校验的问题 |
| security | prd-api | 修复快捷指令绑定私有工作流时可绕过归属校验的问题 |

### 2026-06-16

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 知识库卡片新增「置顶」按钮：用户级服务端持久化（跨设备/重登录保持），置顶库排最前 |
| feat | prd-api | UserPreferences 新增 DocumentStorePinnedIds + PUT /user-preferences/doc-store-pins 端点 |
| polish | prd-admin | 知识库卡片图标按类别变化（验收/周报/教程/缺陷/视觉/产品…）；右上角操作改为常驻「置顶 + 更多菜单」（放大更醒目，非管理者也有置顶不空）；分享/同步状态徽标移到副标题行 |
| polish | prd-admin | 知识库卡片状态徽标（已分享/同步）统一为图标 only（去掉文字）+ 与同步徽标等大对齐，修复一个偏上 |
| polish | prd-admin | 知识库卡片状态徽标(已分享/同步)移到右上角与置顶/更多同一排 items-center 对齐，彻底消除「图标比圆点偏上」 |

### 2026-06-15

| 类型 | 模块 | 描述 |
|------|------|------|
| chore | doc | 熵清理：D3 补缺 plan.md-to-ppt.next-wave 至 guide.list，D6 处理 5 条 changelog 碎片 |
| feat | prd-api | MAP 知识库传输协议 v1.1：新增 peer_sync_runs 同步运行台账（进行中/发出去/收进来/历史）+ GET /api/peer-sync/runs 端点 |
| feat | prd-api | 跨节点同步支持「强制对齐」：align=remote/local/both（远端为准/本地为准/同时对准），新增 SyncApplyMode.Mirror 镜像删除语义 |
| feat | prd-api | 同步契约补全：bundle 携带 contentHash/sortOrder/category + 主文档/置顶血缘 + 默认排序，修复置顶/分类/排序不同步 |
| feat | prd-api | 知识库支持服务端持久化默认排序 DefaultSortMode（换设备/重登录/刷新保持） |
| feat | prd-admin | 知识库新增「同步中心」弹窗：进行中/发出去/收进来/历史四视图 + 强制对齐三选项（远端为准/本地为准/同时对准，删除需二次确认），有任务时入口转圈 |
| feat | prd-admin | 知识库文档列表新增排序控件（默认/最新创建/最近更新），选中即服务端持久化，刷新/重登录不重置 |
| feat | prd-admin | 知识库「同步」按钮轮询运行台账，进行中时转圈+脉冲+「同步中…」文案，明确告知正在同步 |
| polish | prd-admin | 知识库顶栏收敛：发布/关系图谱/统计/订阅收进「更多」下拉，常驻仅留 同步/分享/上传文档，改善折叠屏布局 |
| docs | doc | 新增 spec.knowledge-base.transfer-protocol.md（MAP-KBTP v1 对外协议 + 第三方接入方法） |

### 2026-06-14

| 类型 | 模块 | 描述 |
|------|------|------|
| chore | doc | 熵清理：D3 补缺 1 条(plan.md-to-ppt.next-wave)，D6 标记已处理 5 条 changelog |

### 2026-06-13

| 类型 | 模块 | 描述 |
|------|------|------|
| chore | doc | 熵清理：D3 补缺 1 条(plan.md-to-ppt.next-wave)，D6 changelog manifest 登记 147 条 |

### 2026-06-09

| 类型 | 模块 | 描述 |
|------|------|------|
| chore | doc | 熵清理：D2 index.yml +3 条，D3 guide.list +2 条，D6 manifest +5 条 changelog |


### 2026-06-21

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 验收报告页右侧预览撑满高度与宽度，不再挤成小窄盒（新增 .cds-workspace--fill 修饰类，修复外壳高度不传递） |
| rule | cds | 新增「内容填满画布」原则：主产物区必须 flex-1 填满并占主导，高度从外壳一路传到产物 |
| rule | cds | 新增「预期管理」总纲原则：让用户随时知道在做什么/还要多久/接下来怎样/变了什么/该做什么 |
| fix | cds | 验收报告 JSON 粘贴绕过全局 100kb 解析器，大报告(数 MB)可正常保存 |
| fix | cds | 本地账号 githubId 用唯一负数占位，避免多本地用户在 githubId 唯一索引撞键 |
| fix | cds | basic 模式登录放行 /api/auth/login 等路由，保住单用户部署登录回退 |
| fix | cds | 部署耗时仅在真正就绪(runtimeStartedAt)时采样，避免污染中位 ETA |
| fix | cds | mongo 用户操作痕迹按容量裁剪，避免无界增长 |
| security | cds | 验收报告路由对项目级 key 调用 assertProjectAccess，禁止跨项目列/读/改/删 |
| fix | cds | mongo 活动裁剪用 $lt 严格小于，避免同毫秒新记录被连带删除 |
| fix | cds | pending 发布版重建时 ETA 取目标模式样本桶，等待页/卡片不再误用热加载估算 |
| fix | cds | 预览等待 ETA 仅扫描本分支所属项目的 profile，避免他项目发布版 profile 串改估算 |
| security | cds | 验收报告项目级 key 全面收敛：禁访全局/他项目报告、建报告强制归本项目、关联分支限本项目 |
| security | cds | 被禁用账号不能再通过 GitHub OAuth 登录（handleCallback 校验 status） |
| fix | cds | 管理员改用户先重置密码再改状态，避免密码重置失败但状态已落库 |
| security | cds | 易失(memory)存储后端禁用首启 bootstrap，防重启后被自封 system owner |
| fix | cds | 本地账号创建捕获唯一索引冲突(E11000)，并补登 username 唯一稀疏索引文档 |
| feat | cds | github 模式网关同等放行 cdsp_/cdsg_/静态 AI key（与人类会话并存），项目报告作用域生效 |
| fix | cds | 本地登录处理器加 try/catch 兜底，存储后端异常返回 500 而非挂起 |
| fix | cds | 预览等待页 ETA 在途重建时以 lastDeployStartedAt 为锚点，不再回退到上一轮历史日志误算几小时 |
| fix | prd-admin | 知识库「接入 AI」弹窗在 allowedScopes 异步到达后重新播种预选 scope，一键签发不再因预选落空失败 |
| fix | cds | 执行器构建路径在成功 complete 时戳 runtimeStartedAt 并采样部署耗时，执行器构建的项目也能积累 ETA 历史 |
| fix | cds | 单服务/首次 clone 部署起点也钉 lastDeployStartedAt，且 ETA 解析在 stamped 不旧于最新日志时优先它，单服务重部署不再误算几小时 |
| fix | cds | 首启引导加进程内串行锁，防并发 bootstrap 铸出多个 system owner |
| fix | cds | 预览等待 ETA 不再跨模式回退：发布版重建无样本时显示「暂无预计」而非热加载 ETA |
| fix | prd-admin | 知识库「接入 AI」按 Key 真实 scope 出文档空间 API 指令，不再发海鲜市场提示词/装 findmapskills |
| fix | cds | 本地账号创建加进程内串行锁，关闭同名并发竞态（叠加 username 唯一索引 + E11000 兜底） |
| ops | deploy | 新增 fast.sh 作为可超时的后端镜像预热脚本，并让 exec_dep.sh 默认使用镜像与静态包代理和超时拉取，避免正式发布被网络拉取阻塞 |
| perf | cds | mongo-split 写入合并：高频 save() 不再每次同步 structuredClone 整个 state，改为每事件循环 tick 至多一次快照+落盘，根治 master 事件循环被部署日志/调和器 save 风暴堵死（网页 524 超时、就绪探测超时误判、容器被当部署失败清理） |
| fix | prd-admin | 更新中心 GitHub commit 记录显示可点击的关联缺陷标志 |
| fix | prd-api | 更新中心缺陷关联按 commit id 返回提交者本人标识和发布状态 |
| feat | prd-api | 缺陷自动化新增 workflow 协议端点以减少智能体机械编排 |
| docs | doc | 新增缺陷自动化协议规格并更新缺陷管理教程 |
| rule | prd-api | 缺陷自动化技能补充更新中心 UI 标志验收门禁 |
| fix | prd-api | 缺陷自动化 workflow 禁止已失败或已结束运行继续领取缺陷，并限制完成回写只能作用于当前运行已领取的缺陷 |
| fix | prd-admin | 更新中心关联缺陷标志的“我的缺陷”计数仅统计当前提交人自己的缺陷 |
| feat | prd-api | 缺陷自动化 workflow 支持 defectId 精确领取，用于演练、回归和人工确认后的单点处理 |
| fix | prd-api | 缺陷自动化 workflow/block 将阻塞缺陷切到待补充状态，避免后续日常任务反复领取同一条缺陷 |
| rule | acceptance | 加固每日验收内容充裕门禁，防止薄报告和空泛占位遮盖遗漏 |
| fix | acceptance | 修复每日验收场景识别、深入功能验收深度门禁和跨分支范围盘点 |
| feat | prd-api | 缺陷自动化完成和验收回写增加 PR、commit、验收报告证据评论 |
| feat | prd-admin | 更新中心关联缺陷弹层展示 PR、commit、验收报告并支持直达缺陷详情 |
| fix | prd-admin | 修复更新中心关联缺陷直达详情在目标不在当前列表时无法打开 |
| feat | prd-admin | 知识库页新增「接入 AI」入口，当场签发 document-store:write 长效 Key（谁需要谁签发） |
| refactor | prd-admin | SkillOpenApiDialog 支持 presetScopes/contextLabel，复用为知识库签发入口；CreateKeyTab scope 图标去 emoji 改 lucide |
| ci | prd-admin | 修复最新 admin 前端 Pages 产物只落到子目录导致正式同步源仍可能读取旧资源 |
| fix | prd-api | 修复群会话切换到测试角色后执行测试技能仍被成员固定角色拦截的问题 |
| fix | prd-api | 修复官方验收技能包依赖下发与复杂验收门禁误判 |
| feat | skill | 为每日自动验收新增范围盘点脚本、深度门禁与分享链三次打开验证 |

### 2026-06-20

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 新增验收测试设计官方技能，强化每日视觉验收的影响面、融合测试和证明力门禁 |
| ops | prd-admin | 补充 CDS Admin 静态预览所需 serve 运行依赖 |
| fix | prd-api | 官方视觉验收技能下载包随包下发验收设计和场景编排依赖技能 |
| test | prd-api | 稳定模型池 Race 调度测试，避免 CI 偶发失败 |
| ops | prd-api | API 镜像构建注入 commit 与构建时间，支持正式环境发布版本比对 |
| feat | cds | 新增 CDS 自托管验收报告（支持 HTML/Markdown，挂在 CDS 登录态之后无需知识库或额外权限） |
| feat | cds | 验收报告 HTML 以无 same-origin 沙箱 iframe 渲染，Markdown 经 marked 转换后同样沙箱隔离 |
| fix | cds | Java/Go/Rust/Python 项目缓存挂载固化（新增 cache-catalog SSOT），避免每次构建重复下载依赖 |
| feat | cds | 自动发布成功后记录 lastPublishReason/lastPublishAt，使"自动切发布版"的模式跃迁可观测 |
| docs | cds | 新增 CDS 构建耗时诊断与发布版/热加载机制说明文档（design.cds-build-time） |
| feat | cds | 分支构建中卡片展示已耗时与历史中位预计耗时，区分发布版/热加载（近 20 次中位值，无样本则只显示已耗时） |
| fix | cds | 修复 ESM 模块内 require('node:*') 运行时报错（memory 后端鉴权全 500、stack 检测、TCP 探测三处） |
| test | cds | 新增 ESM 卫士测试，禁止源码出现 CommonJS require() 调用（单测因 CJS interop 掩盖此类 bug） |
| fix | cds | 修复旧 deploy fenced cleanup 误删更新运行时容器导致预览回到 503 |
| fix | cds | 保留构建中分支的 forwarder 预览域名路由，避免部署状态回退时出现 unknown-host 503 |
| fix | cds | 源码部署容器自动注入 commit 与构建时间环境变量，保证 /api/version 可用于发布版本比对 |
| feat | cds | 新增本地账号密码登录（与 GitHub OAuth 并存）：scrypt 加盐哈希、首启引导创建系统所有者、修改密码、系统所有者用户管理（创建/禁用/重置密码） |
| feat | cds | 新增用户操作痕迹（登录/退出/改密/建用户等关键操作记录），CDS 系统设置「用户管理」「用户痕迹」两个 tab，系统所有者看全部、普通用户看自己 |
| feat | cds | 预览构建等待页展示已等待时长与预计剩余时间（复用部署耗时中位，无样本时不编造） |
| polish | prd-admin | 缺陷自动化弹窗展示最近运行的单缺陷处理明细、commit、预览地址和失败原因 |
| polish | prd-api | 缺陷自动化每日计划文案补齐可直接执行的连接配置、单缺陷闭环步骤和发布后验收通知阶段 |
| test | prd-admin | 增加缺陷自动化运行项状态文案测试 |
| polish | prd-api | 强化缺陷自动修复技能的真实闭环证据门禁 |
| docs | prd-api | 更新 ai-defect-resolve 官方兜底技能到 1.4.1，明确日常自动化 domain+K、单缺陷闭环和发布中心只读关联 |
| polish | prd-admin | 缺陷自动化面板入口文案从历史分享调整为分享管理，并区分首次生成与重新生成授权配置 |
| test | prd-admin | 补充缺陷自动化授权复制按钮文案单元测试 |
| feat | prd-api | 知识库正文写入新增图片资产规范化：支持 {{IMG:name}}+assets[] 一次性传输，自动把 data:image 迁移为正式资产图链 |
| refactor | create-visual-test-to-kb | 验收归档脚本改为知识库传输共享协议，一次提交报告正文与截图资产，由知识库后端统一上传图片和重写正文 |
| rule | skill | 更新 create-visual-test-to-kb 与 ai-defect-resolve，禁止绕过知识库写入边界手动上传图片或写入 data:image |
| fix | prd-api | 修复官方技能版本断言与验收报告知识库归档鉴权兜底 |

### 2026-06-19

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 额度判定排除限流误报：429 / "Rate limit exceeded" / "requests per minute" 等节流不再被当成额度用尽（LLM_QUOTA_EXCEEDED 误触发额度告警）；额度只认 key/credit/quota/balance/billing 明确信号 |
| fix | prd-admin | 视觉分镜台并发竞态修复：每轮「生成分镜」自增 genRef 作废上一轮在途关键帧 SSE 与图生视频轮询（stale-response guard），旧回调不再画到新分镜板同 sceneIndex；创建关键帧任务无 runId 时复位 spinner 为 error；同镜正在转视频时禁止重复触发「动起来」 |
| fix | prd-admin | 视觉分镜台图生视频改走 visual-agent 自有端点（/api/visual-agent/video-gen/runs，appKey=visual-agent），避免 visual-agent-only 账号撞 video-agent 403、并用本应用配额/appKey（遵循 app-identity 规则） |
| fix | prd-admin | 图生视频轮询：客户端窗口 6→11 分钟以覆盖后端 worker 10 分钟终态期，避免 6-10 分钟才完成的视频被误判「生成超时」；提交失败/超时回填补 genRef 守卫，旧板任务不再误标新板场景 |
| fix | prd-api | OpenRouter 图片回退收窄：images/generations 失败回退 chat/completions 仅在非鉴权(401/403)/额度(402)/限流(429)时触发，避免真实上游错误被改协议重试覆盖+徒增流量 |
| fix | prd-admin | 视觉分镜台卡片渲染按 vidStatus 优先：重绘关键帧时清空旧视频状态，且 vidStatus 为 running/error 时不再显示上一版成片——重生视频能正常显示进度/失败 UI，用户可核对新关键帧 |
| fix | prd-api | 图生视频 worker 按 run.AppKey 选 caller：visual-agent 分镜台创建的 run 归属 visual-agent 视频配额/模型池与日志归因（新增 AppCallerRegistry.VisualAgent.VideoGen.Generate），不再一律记到 video-agent |
| fix | prd-api | 分镜脚本 JSON 提取改用括号深度匹配（字符串内花括号不计 + 去 markdown 围栏），替代「首 { 到末 }」贪婪截取，模型夹带说明文字/值含 } 时不再「分镜解析失败」 |
| fix | prd-admin | 该镜正在转视频时禁用「重绘」并在 regenerateScene 早退：单镜重绘不 bump genRef，旧 animateScene 轮询会用上一帧成片覆盖刚重绘的新关键帧，故视频生成中不允许重绘（Codex review） |
| fix | prd-admin | 视觉分镜台关键帧放大预览改用 createPortal 挂到 document.body，遵循 frontend-modal.md（避免 overflow/transform 祖先裁剪 position:fixed 浮层）（Codex review） |
| fix | prd-admin | 关键帧批次与单镜重绘并发隔离：新增 per-scene 运行 token（sceneKfGen），后发重绘顶替该镜所有权，使先前批次对该镜的 SSE 回填/流结束兜底变 no-op，避免「批次仍在跑、其中一镜被重绘」时批次兜底把正在重绘的镜误判失败（Bugbot review） |
| fix | prd-admin | 图生视频沿用关键帧出图画幅：SceneVM 记录 kfAspect，animateScene 用 s.kfAspect 而非全局 aspect，避免用户改画幅后用旧帧出错比例（Codex review） |
| feat | prd-api | 放开视觉创作视频每日限额（DailyLimit 1→999，用户决定）：原 1/天「体验」限额会让多镜分镜每天只能动 1 镜，其余被配额 400 挡；放开后多镜分镜可逐镜出视频 |
| fix | prd-admin | 分镜台卸载时 bump genRef 停止图生视频轮询（避免卸载后 setScenes）；分镜卡片按 s.kfAspect 取景（改全局画幅后旧镜不再被错误裁剪） |
| fix | prd-api | OpenRouter 出图回退进一步收窄为「仅端点缺失」(404/405/501)：原先非 400/413 等即回退，对非 OpenRouter 平台(如 Volces)瞬时 5xx 会用错协议重打、覆盖真实错误（Codex+Bugbot 双标），现只在端点确实不存在时回退 |
| fix | prd-admin | handleGenerate 补 stale 守卫：拆分镜 await 返回后校验 genRef，卸载/新一轮已作废时丢弃过期脚本响应，不再 setTitle/setScenes/启动 renderKeyframes |
| fix | prd-api | 拆分镜接口转发 gateway 中文报错：原先失败统一回 `分镜生成失败：{ErrorCode}` 丢掉 ErrorMessage，额度等错误的 LLM_QUOTA_EXCEEDED 中文文案被吞成泛化提示，现转发 ErrorMessage + 透传 gateway ErrorCode（Bugbot review） |
| fix | prd-api | LlmGateway.StreamAsync 非 2xx 分支补额度检测：原先只有非流式 SendAsync/Raw 路径调 IsQuotaExceeded/HandleQuotaExceeded，导致 toolbox/defect/literary/polish 等主聊天(走 StreamAsync)遇 OpenRouter 402 / Key limit exceeded 不触发 admin 额度告警、不透传额度文案，现对齐（Codex review） |
| fix | prd-admin | 分镜台「动起来」补同步去重：vidStatus='running' 是异步 state，两次快速点击会在落地前都通过守卫、重复提交后端视频 run + 叠加轮询，改用 animatingRef Set 同步拦截（Bugbot review） |
| fix | prd-admin | 分镜台挂载拉取生图模型补 alive 守卫：卸载/重挂后丢弃过期响应，不在已卸载组件上 setPools/setModelsLoading（Bugbot review） |
| fix | prd-api | 额度告警改 await 写入：IPoolFailoverNotifier 为 Scoped、持 scoped MongoDbContext，原 fire-and-forget 在 request/stream scope 释放后 upsert 会被取消/off-thread 失败，恰在 402/额度用尽时丢告警，现 await 确保 scope 存活期内写完（Codex review） |
| fix | prd-admin | 分镜台关键帧提示词改后标 kfDirty：出图后编辑提示词不再静默沿用旧帧，转视频前强制重绘，避免「旧首帧 + 新提示词」出错配视频（Codex review） |
| fix | prd-admin | 分镜台「动起来」锁改为按 genRef 代次记账：重新生成分镜后旧板未结束的视频轮询不再占用相同 sceneIndex 导致新板动起来静默无响应；旧轮询 finally 仅在仍持本代次锁时释放，不会清掉新板锁（Bugbot review） |
| fix | prd-api | IsQuotaExceeded 去掉「429 一律 false」短路：部分供应商(如 OpenAI insufficient_quota)用 429 返回额度耗尽，原短路使其漏掉额度告警走泛化 LLM_ERROR，改为只按速率文本排除限流，额度文本(quota/credit/balance)继续判定（Codex review） |
| fix | prd-api | 分镜 title/topic/keyframePrompt/motionPrompt 落库前剥 emoji + system prompt 加无 emoji 约束：LLM 返回的标题会直接渲染进页头，违反 CLAUDE.md §0 禁 emoji（Codex review） |
| fix | prd-admin | 分镜台「动起来」提交后若被新一轮生成/卸载作废，取消刚创建的视频 run（新增 cancelVisualVideoRunReal 走 visual-agent cancel 端点），避免后台继续烧视频额度且结果已无法回到 UI（Codex review） |
| fix | prd-admin | 分镜台视频轮询期间作废也取消后端 run：上一轮只在轮询开始前取消，轮询中的 genRef 守卫直接 return 不取消，worker 仍烧额度。抽 bailIfStale 统一在所有 stale 退出点取消（Bugbot review） |
| fix | prd-admin | 关键帧 dirty 判定改按提示词比对：渲染途中改词后，旧提示词的图到达时不再无条件清脏，仅当当前词仍等于已出图的词才清，避免旧帧配新词被当干净帧（Codex review） |
| fix | prd-admin | 分镜台关键帧模型选择改用 text2img 专属池端点（/models/text2img），不再用合并了 img2img/vision 的列表，避免选到只配了 img2img/vision 的池导致每帧失败（Codex review） |
| fix | prd-api | 图生视频直出 worker 提交前补取消闸：CancelRunAsync 仅设 CancelRequested，而 claim 只过滤 Status==Queued，取消的 run 仍可能在 worker 提交到 OpenRouter 后才被轮询取消、白烧额度。ProcessDirectVideoGenAsync 领取后 + 提交前两处检查 CancelRequested，命中即置终态不提交（Codex review） |
| fix | prd-api | 分镜台 ExtractChatText 兼容数组型 content：部分 chat 网关把 message.content 返回为部件数组 [{type:text,text:..}]，原先只当字符串读会抛异常退回整段响应、导致 JSON 提取抓到外层 envelope 而非分镜对象、报通用解析失败。改为字符串/数组两种形态都正确拼接文本（Bugbot review） |
| fix | prd-api | ExtractChatText 再兼容单对象型 content：网关把 message.content 返回为单个 {type,text} 对象（非数组）时也能取文本，抽 PartText 助手统一处理 字符串/单对象/数组三形态（Bugbot review 续） |
| fix | prd-api | 分镜解析截断至 MaxStoryboardScenes(12)，与请求侧 sceneCount 钳制共用常量：模型对长文超产时不再全量下发撞图生图 run 条目上限导致整板无关键帧（Codex review） |
| docs | prd-agent | debt.cds-backend-deploy-freeze.md 移除 3 个裸 NUL 字节(改字面 \0)，使 git 不再把该 md 当二进制、diff 工具可正常处理（Codex review） |
| polish | prd-admin | 分镜台拆分镜等待加预估耗时文案(10-40s)，补全 CLAUDE.md §6 兜底(动画加载+预估耗时)；完整 SSE 流式见 debt #4（Codex review） |
| fix | prd-api | 图生视频 submit/status 失败转发 Gateway 额度文案：OpenRouterVideoClient 原先只从 Content/ErrorCode 构造错误，丢掉 SendRawWithResolutionAsync 已写入 ErrorMessage 的 LLM_QUOTA_EXCEEDED 中文提示。新增 QuotaOrUpstreamMessage：额度错误优先用友好文案、其余保留 /videos 上游解析，使「动起来」与拆分镜额度提示一致（Bugbot review） |
| fix | prd-admin | 关键帧 imageDone 但 url/base64 均缺时标 error 而非 done：原先无图也置 done、kfUrl 为空，卡片永远停在 shimmer（卡片仅在 done && kfUrl 才显示图）。改为无图即 error 提示重绘（Bugbot review） |
| fix | prd-api | 图生视频下载失败路径也走 QuotaOrUpstreamMessage：原先只用 ErrorCode/HTTP 状态+诊断，丢掉 Gateway 的 LLM_QUOTA_EXCEEDED 友好文案，与 submit/status 不一致（Bugbot review） |
| fix | prd-api | 分镜解析按请求 sceneCount 截断：ParseStoryboard 接收 maxScenes(用户指定 N 则裁到 N，否则全局上限 12)，兑现 system prompt「恰好 N 个」、控制下游关键帧批量与成本（Bugbot review） |
| fix | prd-api | OpenRouter 生图解析回退兜底：启发式(body 含 choices/image_url/images 子串)命中但解析到 0 张图时，不再立即失败，回退标准 data[] 解析，避免有效 images/generations 响应被误报「未包含图片数据」（Bugbot review） |
| ops | prd-api | cds-compose.yml 的 api 服务 build/run 显式统一 `-c Debug`：原先 build 与 dotnet run --no-build 都依赖默认配置，缺显式 -c 易漂移(build 出 Release 而 run 加载 Debug → 跑旧程序集，正是部署冻结症状)（Bugbot review） |
| fix | prd-admin | 分镜「动起来」视频轮询超时改基于服务器状态：worker 串行处理，本镜排在长任务后会长时间 Queued，原按创建时间起算 11 分钟会在后端刚开始时误判超时。改为离开 Queued 才起算处理窗口(11min)，排队期单独按 20min 上限 + 「排队中」文案（Codex review） |
| fix | prd-api | OpenRouter/标准 data URL 生图保留 MIME：data:image/jpeg|webp 原先只剥 base64、丢 MIME，落库用默认 image/png，导致 COS 存成 png 却是 JPEG/WebP 字节。ImageGenImage 加 Mime 字段，解析时取 data URL 头 MIME，上传时据此设 outMime（Bugbot review） |
| fix | prd-admin | 分镜关键帧模型从池内挑健康端点：原先固定取最高优先级 sorted[0]，该端点不可用/降级时关键帧全失败而无视池内其他健康模型。改为优先 Healthy → 非 Unavailable → 回退 sorted[0]（Codex review） |
| fix | prd-admin | 分镜「动起来」本地超时后取消后端视频 run：原先只标错误，仍 Queued 的任务会被 worker 更晚提交 OpenRouter、在 UI 已告知失败后继续烧额度（Codex review） |
| fix | prd-api | OpenRouter 出图透传画幅 aspect_ratio：按官方 image-generation 文档，chat/completions 出图加 image_config.aspect_ratio（从请求 size 推最接近受支持比例），修复 16:9/9:16 关键帧被裁切/与图生视频画幅错配；推不出比例则不加避免未知字段（Codex review，待部署验证） |
| fix | prd-api | 图生视频未指定模型时不再硬编码 alibaba/wan-2.6：留空交由 AppCaller 对应视频池(visual-agent/video-agent)解析各自默认模型，避免以 Wan 当 expectedModel 搜遍所有池绕过 visual-agent 池配置（Codex review） |

### 2026-06-18

| 类型 | 模块 | 描述 |
|------|------|------|
| ops | cds | 延长 prd-admin 静态发布 readiness timeout，避免主干生产构建完成前被误判失败 |
| feat | cds | 新增 CDS 全局 7 天过期删除策略设置，并修正停止来源归因与卡片展示 |
| fix | cds | 修复 exec_cds.sh init 在新环境缺少 Node.js 或 Docker 时只提示不自动安装的问题 |
| fix | cds | 关闭预览 nginx 到 cds_worker 的 upstream keepalive，修复预览域名间歇性空 400 |
| fix | prd-api | 更新中心关联缺陷反查兼容短 commit id |
| feat | prd-api | 新增缺陷自动化长期授权确保接口 |
| fix | prd-api | 缺陷自动化单次运行跳过已完成或失败的缺陷 |
| fix | prd-api | 缺陷自动化连接器授权复用检查补充过期与撤销判断 |
| security | prd-api | 缺陷自动化写入端点增加运行记录、目标缺陷和验收 trace 权限边界 |
| security | prd-api | 新增 defect-agent:share 窄 scope，仅允许访问缺陷分享端点 |
| fix | prd-admin | 缺陷分享临时密钥申请 scope 改为 defect-agent:share |
| feat | prd-api | 缺陷来源连接器返回单缺陷和轻量修复机读策略 |
| docs | prd-api | 更新 ai-defect-resolve 技能到 1.4.0 |
| fix | cds | API 预览服务补充就绪超时配置，避免冷启动被误判为 503 |
| fix | cds | Admin 静态预览改用锁定的 serve 依赖启动，避免 npx 动态安装后端口未监听 |
| feat | prd-api | 新增缺陷自动化控制台接口，返回长期授权、运行历史、统计和每日计划模板 |
| feat | prd-admin | 缺陷页面新增缺陷自动化控制台，支持一键生成并复制长期授权每日计划 |
| docs | skills | ai-defect-resolve 改为优先使用缺陷页面自动化入口生成永不过期授权 |
| ops | cds | Admin 预览容器改为从仓库根目录进入 prd-admin 启动，避免源码模式缺少 package.json |
| fix | prd-api | 缺陷自动化 commit 回写优先使用长期 K 标识，确保发布后验收和通知可继续查询 |
| chore | doc | 熵清理：D3 补缺 2 条（debt.map-mcp-connector / plan.md-to-ppt-next-wave），D6 处理 5 条 changelog（marketplace 技能分享 / 短视频卡片 / 快捷指令剪贴板 / 工作流自动配置 / ASR 多模态 chat）|
| fix | prd-api | LlmGateway 二进制响应改为「先无损读字节再判类型」+ 文件魔数嗅探(LooksBinary)：彻底修复图生视频成片下载被当文本损坏（mp4 标成 application/json 也能识别），不再依赖单一 ExpectBinaryResponse 标志 |
| feat | prd-api | 大模型额度用尽/限额及时提醒：网关识别 OpenRouter "Key limit exceeded"/402 等限额错误 → 专门错误码 LLM_QUOTA_EXCEEDED + 清晰中文提示 + 主动站内告警(去重)，避免额度不足时各功能静默失败、用户无从知晓 |
| feat | prd-admin | 新增液态玻璃三方对照评估页(labs/liquid-glass):现有重模糊做法 vs B清晰棱光 vs A SVG真折射并排对比,供选型 |
| feat | prd-admin | App背景加极淡彩色光晕(.app-aurora,双主题):此前全站接近纯黑平底导致液态玻璃无内容可折射,光晕给玻璃"有活干"的深度,克制不伤正文对比度 |
| fix | prd-admin | 液态玻璃默认开启:DEFAULT_THEME_CONFIG.performanceMode 由 performance 改 quality,此前默认性能模式导致全站GlassCard走实底降级、液态玻璃从不渲染 |
| feat | prd-admin | 液态玻璃改用B方案:全站GlassCard质量模式blur大幅下调(40→14px)+边缘棱光/镜面反光+暗色底色提一档,清晰度优先不靠重模糊 |
| feat | prd-admin | 共享弹窗改液态玻璃:遮罩降不透明度(0.72→0.40)+backdrop模糊让繁忙页面映照出来,面板由实底改半透磨砂玻璃(blur24+棱光镜面),所有走Dialog/prd-dialog-content的弹窗一并升级 |
| feat | prd-admin | 头像菜单新增「液态玻璃」一键开关:点击不关菜单,当场切换全局玻璃开/关(performance↔quality),无需进设置中心皮肤页 |
| polish | prd-admin | 全局 aurora 背景光晕温和加强(暗色 5 团色斑透明度 +~35% 并扩大范围),让半透卡片(--bg-card 白@0.08)与玻璃面板背后透出更明显的淡彩底色;浅色主题不变 |
| fix | prd-admin | 修复 aurora 背景被内容区遮挡:<main> 背景由不透明 var(--bg-base) 改 transparent,让外层 .app-aurora 彩色光晕透到内容区,半透卡片/玻璃面板才能折射到淡彩底色而非平底色(aurora 自身以 var(--bg-base) 收底,floor 色不变) |
| perf | prd-admin | 性能模式下停掉全局 aurora 背景动画并回退 var(--bg-base) 实底,去除全屏大渐变持续重绘的视觉负载(玻璃关闭时无需可折射底色) |
| fix | prd-admin | 液态玻璃性能模式/reduced-motion 边界统一退实底:shouldReduceEffects 纳入 prefers-reduced-motion,与性能模式同路径由 themeApplier 把 --glass-bg 整体切实底并打 data-perf-mode(卡片/弹窗/所有玻璃面统一退实底);头像菜单徽章用 shouldReduceEffects 判定(auto 在 Windows 降级时显示「已关闭」);弹窗面板在两路径下恢复近实底背景 + 遮罩回退 rgba(0,0,0,0.72),避免半透失焦 |
| fix | prd-admin | reduced-motion 反应性闭合:initializeTheme 监听 prefers-reduced-motion 变化重跑 applyThemeToDOM(含老 Safari addListener 回退);新增 useReducedMotion 钩子(useSyncExternalStore),Dialog 遮罩与头像玻璃徽章随 OS 偏好运行中变化即时重渲染,消除滞后 |
| fix | prd-admin | 液态玻璃评估页(labs)对照卡响应式:初始位置按舞台实测宽度铺开,并用 ResizeObserver 在窄屏/缩放时把三张卡夹回可视范围,避免被 overflow:hidden 裁出舞台 |
| fix | prd-admin | 玻璃评估页(labs)对照卡:舞台首次测得宽度为 0 时补做铺开(spreadDoneRef 标志),避免三张卡堆在原点后不再展开 |
| fix | prd-api | 短视频卡片时长按平台单位自适应：BuildShortVideoCard 用 >=1000 阈值区分毫秒/秒，避免把已是秒的小数值（如 45）误当毫秒算成 0 或过短（Bugbot Medium） |
| feat | prd-admin | 知识库右上角「运行中的智能体」入口：短视频解析任务关掉抽屉/刷新页面后仍可见（sessionStorage 持久化 shortVideoRunStore），点击重开抽屉恢复进度；新增页面级 Host 对非终态 run 周期续查，刷新后自动继续推进不再凭空卡住/重新计时 |
| fix | prd-api | 视频下载器把任意 */octet-stream（含 binary/octet-stream）归一成 video/mp4（Bugbot），ASR 转写 chat-audio 路径排除所有 Exchange（gemini-native 等 transformer 会丢音频，doubao-asr 已单独分流，Codex P2） |
| fix | prd-api | 短视频解析卡死自愈：(1) ShortVideoMaterialRun.Status 默认值由 running 改为 queued，杜绝缺省/反序列化出的 run 永远卡"处理中"无人 claim；(2) Worker 增加周期性兜底，把 status=running 且 updatedAt 超 15 分钟未推进、非当前处理中的 run 标记为失败（自愈成"可重试"），不再依赖重启才回收；(3) ProcessAsync 进入即把 parse 标 running 并落库，前端立刻看到"正在解析"而非僵在 pending，同时作为心跳。根治"加了短视频链接半天没反应" |
| fix | prd-admin | 短视频卡片：视频已入库但转写 stage 失败（run 为 done、phase 非 error）时，补一行显示转写失败原因 + 可单独重试提示，不再让用户看不出"为什么没有文字"（Codex P2） |
| fix | prd-admin | 短视频轮询：run 为 done 但未返回完整入库产物时，error 消息一并同步终态 run，避免卡片渲染上一轮旧 run 与终态 API 不一致（Bugbot Low） |
| fix | prd-api | 短视频下载器对通用 Content-Type（application/octet-stream 等非 video/*）归一成 video/mp4，避免 COS 落成 .bin 地址导致前端卡片把可播放视频当图片显示成破损媒体（Codex P2） |
| fix | prd-api | 视频下载器对显式非视频类型（text/html 分享/登录/防盗链页、image/*）直接拒绝而非改写成 mp4 存入非视频字节，避免 source 假成功 + 卡片/ASR 误导性失败；仅 缺失/application/octet-stream 归一成 video/mp4（Codex P2 二轮） |
| feat | prd-admin | 视觉分镜台新增关键帧模型选择器：不再硬绑首个模型池，单一 OpenRouter 出图模型偶发 404 时可一键切换到其他可用出图模型（仅一个模型时自动隐藏选择器） |
| fix | prd-api | LlmGateway 原始响应二进制识别补齐 video/* 与 image/*：图生视频（Wan 2.6 等）下载 video/mp4 时此前被当文本读取，导致「视频下载失败: HTTP 200」，视频产物无法落 COS |
| fix | prd-api | 图生视频下载根因修复：OpenRouter /videos/{id}/content 回 mp4 字节却标 Content-Type=application/json，新增 GatewayRawRequest.ExpectBinaryResponse 强制按字节读取，彻底修复「视频下载失败: HTTP 200」 |
| fix | prd-api | 图生视频下载二次根因：下载 GET 复用视频 resolution(isExchange=true) 误入 Exchange async 轮询，二进制响应跳过轮询(与响应转换块同口径 !isBinaryResponse)，成片字节直出 |
| perf | prd-admin | 视觉创作上传大图自动压缩（最长边封顶 2560px / 体积 8MB），缓解画布卡顿 |
| fix | prd-admin | 视觉创作批量上传超过 20 张时先截断再压缩，避免解码丢弃图拖卡标签页 |
| fix | prd-admin | 视觉创作上传压缩：尺寸被缩过时即便字节变大也返回封顶版本，防止超大图漏过尺寸封顶 |
| fix | prd-admin | 视觉创作上传压缩移入串行锁内，避免并发上传同时解码多张大图触发内存峰值 |
| fix | prd-admin | 视觉创作批量上传改串行逐张压缩，避免单批 20 张并发解码爆内存 |
| fix | prd-admin | 视觉创作上传压缩放行 SVG（与 GIF 一致），避免矢量图被栅格化丢失语义 |
| fix | prd-admin | 视觉创作上传压缩按 EXIF 方向解码（createImageBitmap），避免手机照片压缩后旋转/镜像 |
| fix | prd-admin | 视觉创作上传压缩对可能透明的输入只输出 webp，不兜底 jpeg，避免透明图被糊成黑底 |

### 2026-06-17

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 修复 PR 834 活跃请求观测后续 review 问题，补齐 /_cds 部署分类、observer 自排除和 delayed close 清理 |

### 2026-06-16

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | ASR chat-audio 路由收紧：IsChatAudioModel 不再用裸 gpt-4o 匹配（gpt-4o/gpt-4o-mini 不支持 input_audio），只认含 audio 或 gemini 的模型 |
| fix | prd-admin | 短视频卡片在解析失败/轮询超时（phase=error）时显示错误与详情，不再被卡片吞掉；状态行不再误显"忙碌中" |
| fix | cds | 修复性能概览与活跃请求列表漏看 forwarder 流量和部署 SSE 分类错误 |
| feat | prd-api | 新增缺陷修复与 commit 关联追踪记录，修复报告可回写 commit、预览和验收报告信息 |
| feat | prd-api | 新增缺陷自动化 Agent 端点，支持长期授权拉取下一条缺陷、评论、回写提交信息并标记修复 |
| feat | prd-api | 新增缺陷自动化运行记录、连接器握手和正式发布后验收通知回写接口，保存验收结论与知识库名称 |
| feat | prd-admin | 发布中心 GitHub 提交行展示关联缺陷入口和发布状态 |
| feat | skills | 升级 ai-defect-resolve 到 domain + 长期授权 K 的日常自动化闭环流程，并接入发布后视觉验收归档协议 |
| docs | doc | 补充缺陷修复追踪和自动化运行集合的 MongoDB 索引说明 |
| fix | prd-admin | 修复产品管理列表「筛选设置」弹层被工具栏 overflow 裁剪导致筛选项看不到：改 createPortal + fixed 锚定按钮定位，滚动自动关闭；筛选下拉宽度上限放宽到 220px 防长标签截断 |
| refactor | prd-admin | FEATURE_TYPE_LABEL/FEATURE_TYPES 提取到 types.ts（消除 FeatureCatalogTab 与 ProductObjectDetailPage 两处重复定义） |
| fix | prd-admin | 知识库插入图片/保存正文不再整页刷新回顶：保存后用服务端 updatedAt 推进 loadedContentKey 短路内容重拉，插入即所见、图片不再消失 |
| feat | prd-api | 知识库版本控制：新增 document_entry_versions 集合 + DocumentVersionService，每次保存留存快照（去重+留存上限100），新增 列出/查看/恢复 版本三端点；版本只存文本不碰图片资产，恢复不删除任何资产 |
| feat | prd-admin | 知识库文档编辑器新增「历史版本」弹窗：版本列表 + 正文预览 + 一键恢复（恢复就地更新预览不刷新） |
| feat | prd-api | 知识库大小统计端点 GET stores/{id}/size：正文/附件/图片/历史版本字节与数量聚合 |
| feat | prd-admin | 知识库标题栏新增大小徽章（总体量 + 图片数，tooltip 给出明细） |
| test | prd-api | 新增 DocumentVersionLogicTests（版本去重/递增/UTF-8 字节/图片外链文本快照安全性）6 例 |
| feat | prd-api | 订阅源/GitHub 同步覆盖文档正文前先把旧正文快照成版本（source=sync，去重）：订阅文档被远端同步覆盖时，用户本地插入的配图等改动不丢，可从历史版本恢复 |
| fix | prd-admin | 历史版本弹窗面板改用不透明 --bg-elevated（原 --bg-card 暗色为 rgba(255,255,255,0.08) 半透明，背景正文透出造成重叠）+ 阴影/轻背板模糊 |
| feat | prd-admin | 编辑订阅/GitHub 每日同步文档时顶部显示警示横幅：手动修改（含插入配图）可能被下次同步覆盖，改动已留存历史版本可恢复 |
| feat | prd-admin | 知识库列表卡片副标题新增体量徽章（懒加载，滚动进视口才取 size），库外即可纵览每个知识库多大 |
| fix | prd-api | UpdateEntryContent 用单一时间戳写库与返回（原两次 DateTime.UtcNow 差几毫秒，前端缓存键与列表重载不一致会触发多余重拉回顶）—— Bugbot |
| fix | prd-admin | 历史版本列表 RelativeTime 加 refreshIntervalMs=0（列表场景禁用每实例刷新定时器，最多 100 行）—— Bugbot |
| fix | prd-api | GitHub 同步 SHA 缓存复用分支补齐覆盖前后版本快照（原仅 live-fetch 分支快照，缓存分支会静默覆盖本地改动无法恢复）—— Codex |
| fix | prd-api | AI 再加工写回（reprocess apply replace/append）接入版本快照，历史可撤销 AI 改写 —— Codex |
| fix | prd-admin | 历史版本「恢复」按钮不再因「是最新快照」禁用（存在不产生版本的写入路径时会挡住撤销）—— Codex |
| fix | prd-api | 版本恢复 ApplyContentToEntryAsync：DocumentId 指向的 ParsedPrd 行丢失时也 upsert 落库正文，避免恢复后重载空白 —— Bugbot High |
| fix | prd-api | DeleteStore 级联删除 document_entry_versions，避免删库后版本全文残留泄漏 —— Bugbot |
| fix | prd-api | GitHub 同步删除远端已不存在的子条目时级联删除其历史版本，与手动删除一致 —— Bugbot |
| fix | prd-api | AI 再加工写回对无 DocumentId 短文档也快照改动前基线（ContentIndex 即完整正文），保证可撤销 —— Bugbot |
| fix | prd-api | 版本恢复前的基线快照来源由 sync 改为 edit，避免历史里把手动编辑误显示为「外部同步」—— Bugbot |
| fix | prd-api | UpdateEntryContent：DocumentId 指向 ParsedPrd 丢失时也 upsert 落库正文（原只在 doc!=null 时保存→重载空白）；无 DocumentId 短文档用 ContentIndex 做基线快照 —— Bugbot High/Medium |
| fix | prd-admin | 历史版本列表加载加 fetchId 防过期响应守卫（切换文档后慢响应不覆盖当前列表）—— Bugbot |
| fix | prd-api | 版本恢复 ApplyContentToEntryAsync 对无 DocumentId 短文档也用 ContentIndex 做基线快照，与 UpdateEntryContent 一致 —— Bugbot |
| fix | prd-admin | 历史版本切换时先清空 detail + 加载中禁用恢复 + handleRestore 校验 detail.id==selectedId，避免拿上一条快照误恢复 —— Bugbot |
| fix | prd-api | 编辑/恢复/AI再加工写入正文改为内容寻址+共享保护：旧 ParsedPrd 被别的 entry 共享时不就地覆盖（避免改到他人正文），独占时复用旧 id 不产生孤儿 —— Codex P1 |
| fix | prd-api | 历史版本 列出/查看 端点改为要求写权限，避免公开库只读访客取回作者已删除的旧版本正文 —— Codex P1 |
| fix | prd-api | 知识库大小统计按 MIME 判定图片（上传附件 Type 统一为 Document），修复上传图片统计为 0 图 —— Codex P2 |
| fix | prd-admin | DocBrowser loadEntryContent 加 fetchId 防过期响应 + commitLocalSave 作废在途加载，保护「保存不刷新」不被慢请求回滚 —— Bugbot |
| fix | prd-admin | 历史版本弹窗切换 entry 时先清空 versions/selectedId，避免残留上一篇版本列表 —— Bugbot |
| fix | prd-api | 版本基线快照不再回退截断的 ContentIndex（2000字上限）：DocumentId 在但 ParsedPrd 丢失时宁可不快照，避免长文档留下截断的改动前版本 —— Bugbot |
| fix | prd-admin | commitLocalSave 记录刚保存内容；onSaveContent 返回 void 时 loadEntryContent 凭快照直接采纳新 key 跳过重拉，保存不刷新对所有调用方生效 —— Bugbot |
| fix | prd-admin | commitLocalSave 作废在途加载时同步清 contentLoading，避免内容区卡在 loading 占位 —— Codex P2 |
| fix | prd-admin | 历史版本首条徽章「当前」改为「最新」，个别写入路径（替换文件）不产生版本时不误导为当前在线正文 —— Codex P2 |
| fix | prd-admin | 保存豁免重拉改为一次性（用完即清 lastSavedContentRef），只豁免保存紧接的那次重拉；之后订阅同步 bump updatedAt 仍正常重拉，不会一直拿本地旧文盖掉服务端已同步的新内容 —— Bugbot |
| fix | prd-admin | 知识库大小徽章 refreshKey 改为含各 entry updatedAt（原仅条目数）：编辑/恢复/替换改变体积但条目数不变时也刷新 —— Codex P2 |
| fix | prd-admin | 版本恢复回调硬化：preview 为 null 时也写出恢复正文（防空白）+ 校验恢复的是当前选中条目（防画错文档）+ 作废在途加载（防慢响应覆盖）—— Bugbot High/Medium |
| fix | prd-admin | commitLocalSave 同步内部 searchResults 的 updatedAt，避免搜索命中条目保存后 contentKey 不一致引发整页重拉闪烁 —— Bugbot |
| fix | prd-admin | loadEntryContent 改用 previewRef 读当前 preview（移除 preview 依赖），避免切文档时 setPreview(null) 改变回调标识触发二次加载、大文档下载两次 —— Codex P2 |
| fix | prd-api | 版本列表次级按 CreatedAt 倒序，并发重复 VersionNumber 时顺序确定（最新徽章不随机）；唯一性兜底索引建议入 guide.mongodb-indexes —— Codex/Bugbot P2 |
| feat | prd-api | 新增 MAP MCP 连接器网关（POST /api/mcp，Streamable HTTP）：把海鲜市场/知识库的开放接口翻译成 MCP 工具，可被 Claude/Codex 当连接器接入，复用 sk-ak + scope 鉴权，tools/call 回环转发到真实接口 |
| feat | prd-api | 新增 document-store 开放接口 DocumentStoreOpenApiController（/api/open/document-store，ApiKey+scope+boundUserId），让 MCP 知识库工具用 sk-ak 跑通（原 stores/entries 业务路由因 PublicRoutes 豁免无法注入 sk-ak 身份会 401） |
| fix | prd-api | MCP 网关处理 PR 二轮评审：协议版本回我方支持版本（不回声客户端任意版本）、回环地址解析补 `://*` 通配符 |
| fix | prd-api | MCP 动态工具 tools/call 替换 Path 中的 {param} 占位（原样转发会让路由参数原文漏到 loopback）；document-store 开放接口的 entries/content 也排除项目库/产品库/识途库专用库（与 stores 列表一致，防止知道 id 绕过） |
| fix | prd-api | MCP 端点路由由顶级 `/mcp` 改为 `/api/mcp`：CDS 反代只把 `/api/*` 转后端，顶级路径被前端 SPA 兜底接走导致 404/200-html 不可达；回环同时转发 X-AI-Access-Key fallback 鉴权头 |
| security | prd-api | MCP 回环 client 禁用自动重定向(AllowAutoRedirect=false):防回环目标返回跨主机重定向时把转发的 sk-ak/X-AI-Access-Key 凭据带到外部主机;回环异常信息改用 JsonObject 序列化防 ex.Message 破坏 JSON 信封 |
| test | prd-api | 新增 MCP 网关纯逻辑单测 McpGatewayLogicTests（工具目录/scope写隐含读/动态工具名唯一/路径占位替换/请求拼装/inputSchema 推断），不依赖 live 密钥即可断言行为 |
| feat | prd-api | AgentApiKeysController 增加 AiAccessKey 自助通道(全局超级密钥+X-AI-Impersonate 代用户签发 scoped sk-ak;归属校验+scope 白名单兜底),供 AI 无人值守自测开放接口 |
| fix | prd-api | MCP 回环转发 X-Client-Base-Url/X-Forwarded-Host/X-Forwarded-Proto,使下游 ResolveServerUrl 构造公网 URL 而非 localhost(影响海鲜市场 official skills 下载链接) |
| fix | prd-api | MCP 回环 client 禁用系统代理(UseProxy=false),防配了 HTTP_PROXY 的部署把携带 sk-ak 的回环请求发给代理 |
| docs | doc | 新增 guide.mcp-connector 接入教程(Claude/Codex 接入 + 5 工具 + 共享其他 Agent + 自助签发自测 + 排障) |
| fix | prd-api | MCP 回环 SendAsync 改用 CancellationToken.None(对齐 server-authority:客户端瞬断不取消下游长任务,120s 超时兜底) |
| fix | prd-api | MCP 网关非抛出式读取 method/name(畸形如 "method":1 返回 -32600 而非 500),加 AsString 单测 |
| revert | prd-api | 撤回 AgentApiKeysController 的 AiAccessKey 自助通道(改回纯 [Authorize])——双凭据时 FindFirst(sub) 选错用户(Bugbot Medium);AiAccessKey 鉴权器原设计未动;AI 自助签发改为未来专用端点 |
| fix | prd-api | 动态工具 inputSchema 把 Path 的 {param} 占位补为 required 字符串属性(否则客户端不传致下游 404);回环超时 120s→600s(动态长任务 Agent 动作),配合 None 取消由下游服务端限制控制 |
| fix | prd-api | 网页托管 PDF 壳子改用 PDF.js 渲染成 canvas，修复转发链接在手机浏览器/微信内置 WebView 打开 PDF 一片空白 |
| fix | prd-admin | 分享页 PDF 站点统一 iframe 到壳子 siteUrl（PDF.js canvas），移动端可正常显示 |
| fix | prd-admin | 短视频卡片标题/标签贴底：底部信息块 pb-20 改 pb-4，避免窄卡片下标题悬在中部、底部留大片空白 |
| fix | prd-admin | 修复短视频卡片布局：封面图加 referrerPolicy=no-referrer 绕过抖音防盗链（之前封面 403 变成纯色块）；底部标题/标签让出右侧互动指标栏宽度，避免窄卡片下文字与点赞数重叠 |
| fix | prd-api | 后台任务"定向消费"：知识库 Agent（字幕/视频转文字、文档再加工）与短视频解析的 run 增加 OwnerInstanceId（=git 分支），Worker 只领取属于本实例（或历史无主）的 queued 任务、启动兜底也只回收本实例的 running 任务。根治共享 Mongo 下多分支/主干容器互抢任务、A 分支的任务被跑旧代码的 B 容器消费的问题（见 cross-project-isolation 规则） |
| fix | prd-admin | 短视频卡片右栏无可见互动指标时不再为其预留 60px padding |
| fix | prd-admin | PosterFeedCardView 底部留白改为 compactFooter 可配置：默认 px-7 pb-20 给轮播叠加控件让位，短视频抽屉传 compactFooter 用紧凑 px-4 pb-4，修复改共享默认导致周报轮播标题被分页/CTA 控件遮挡的回归（Codex P2） |
| fix | prd-api | 定向消费边界修复：启动兜底回收一并回收历史无主（OwnerInstanceId 空）的 running 任务，避免上线前旧代码遗留的在途任务永卡 running；再加工续聊重新排队、字幕去重复用时把 run 归属改/限定为当前实例，避免复用别的分支/主干拥有的 queued run 后本实例不处理导致永卡（Codex P2） |
| fix | prd-api | 字幕去重复用改为原子认领：用 FindOneAndUpdate 一次性钉住无主 queued run 的归属，杜绝「先 Find 再 UpdateOne」期间被别的实例抢走却仍当复用返回的 TOCTOU；无主 running 不再复用，避免观测到跑在别处的 run（Codex P2） |

### 2026-06-15

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 视频转文字/字幕生成支持「多模态 chat + input_audio」转写路径：模型名含 audio/gemini/gpt-4o（非 whisper）时把音频发到 /v1/chat/completions 让多模态模型逐字转写，支持 OpenRouter 等无 Whisper 端点的平台（短视频转写 CapsuleExecutor 与知识库字幕 SubtitleGenerationProcessor 两条链路均覆盖） |
| fix | prd-api | 多模态 chat 音频转写仅对 OpenAI 兼容平台启用：按平台类型排除原生 google/gemini/anthropic/claude（google 与 gemini 都是原生 Google 平台，走 v1beta generateContent），避免把 OpenAI input_audio 形态请求发到原生端点导致转写失败（Codex P2，SubtitleGenerationProcessor + CapsuleExecutor 两处同步） |
| fix | prd-api | 字幕 ffmpeg 抽音频在 WaitForExit 前并发读 stderr/stdout，避免长输入写满管道缓冲死锁、任务卡在 running（Codex P2） |
| feat | prd-api | CCAS 设备素材库新增本地上传接口（equipment/upload） |
| feat | prd-admin | CCAS 设备素材库 Tab 支持上传本地图片入库 |
| polish | prd-admin | CCAS 设备素材库 Tab 描述补充上传说明 |
| feat | prd-api | CCAS PRD 新增多轮改稿 SSE 端点 prd/revise/stream |
| feat | prd-admin | CCAS PRD Tab 底部改稿助手，整篇文档流式修订 |
| fix | cds | 修复手机端分支详情抽屉、设置导航和主题悬浮按钮的布局挤压与遮挡问题 |
| test | cds | 新增手机端布局冒烟脚本，监控横向溢出、文字竖排挤压和可点击目标遮挡 |
| fix | cds | 修复慢请求观测口径，新增 active 长请求和按类型拆分的 CDS 请求慢榜 |
| feat | prd-api | 营销问策列表分页+筛选：GET /api/product/consult 支持 page/pageSize/keyword/customerId/verdict/template，返回{items,total,page,pageSize}；MarketingConsultReport 加 Verdict 字段并生成时落库（旧数据回退解析） |
| feat | prd-api | 问策知识库端点：GET consult/knowledge(列表)、GET consult/knowledge/{id}(全文)、POST consult/knowledge(添加，需管理权限)，复用 find-or-create 问策库 |
| feat | prd-admin | 营销问策子模块重做为「列表→详情」：分页+搜索+客户/判定/模版筛选+「问策」按钮；详情聚合同一客户的其他问策；compose 自由文本/可选客户一键问策 |
| feat | prd-admin | 设置「问策知识库」改为文档列表展示：点击查看（Markdown 渲染）+「添加资料」扩充 |
| feat | prd-api | 营销问策支持自由文本问策（不绑定客户）：生成端点改为 POST /api/product/consult/generate，body {customerId?,input?,note?,template?}；MarketingConsultReport.CustomerId 可空；新增 GET /api/product/consult 全部问策列表（含客户名/自由问策）；BuildConsultData 兼容无客户 |
| feat | prd-admin | 营销问策子模块重设计：顶部显眼介绍（基于米多四力模型4FM与全域粉销理念）+ 左问策列表 + 右 AI 输入/回答；默认自由文本输入客户情况，可选「选已有客户一键问策」；报告右侧内联预览（可全屏）+ 分享/切模版/存托管 |
| fix | prd-api | 修复营销问策报告匿名分享链接返回 UNAUTHORIZED：AdminControllerScanner 匿名白名单补登 /api/product/consult/shared/（同项目简报先例，token 即凭证 + 查库校验） |
| style | prd-admin | 全局输入聚焦环由靛紫(indigo)改为品牌青(cyan)，输入光标色同步，去除紫色聚焦框 |
| refactor | prd-admin | 产品管理「客户」改为 客户管理 / 营销问策 两个平级子模块：营销问策从客户详情 Tab 独立出来，自带客户选择器；客户列表行/详情提供「营销问策」快捷入口，点击把该客户作为上下文带入 |
| feat | prd-admin | 客户详情仅保留 基本信息 / 动态跟进；新增/编辑客户按「设置→客户→客户表单」配置渲染自定义字段（DynamicForm，存 FormData） |
| fix | prd-api | 修复营销问策报告渲染器编译错误（MarketingReportRenderer 误用 t.Template，Theme 无该属性，应为 d.Template），导致 P2 后端构建失败、api 容器启动失败 |
| style | prd-admin | 输入框聚焦不再画内环（input/textarea/select focus-visible outline 去除），只保留容器外边框 + focus 边框变色反馈 |
| style | prd-admin | 产品管理卡片图标由 Boxes 换为 Blocks（更具辨识度，区别于项目管理 FolderKanban） |
| feat | prd-api | 产品管理客户实体扩展商户基础字段（商户编号/简称/状态/认证状态/区域/行业/开户时间/过期时间），新增动态跟进 CustomerFollowUp 模型 + customer_follow_ups 集合 + follow-ups 三端点 |
| feat | prd-admin | 产品管理「客户」模块改为 master-detail，详情拆分三 Tab：客户信息（商户基础字段表单）/ 动态跟进（富文本时间线，记录时间·创建人·内容）/ 营销问策（P2 占位） |
| feat | prd-api | 产品管理客户新增「营销问策」：聚合客户全量信息+动态跟进+问策知识库(全域粉销/4FM)，AI 流式产出营销评估并服务端渲染为自包含 HTML(4 专业模版)，支持切模版/分享/保存网页托管，全链路对照项目简报 |
| feat | prd-api | 新增 MarketingConsultReport 模型 + marketing_consult_reports 集合 + MarketingReportRenderer(4模版) + MarketingConsultService(SSE 流式 LLM) + consult 端点区，注册 AppCaller product-agent.marketing-consult::chat |
| feat | prd-api | 问策知识库 find-or-create（DocumentStore），首次自动灌入 3 份默认资料（4FM/范式革命/缩量内卷），种子 md 随程序部署(SeedData) |
| feat | prd-admin | 客户「营销问策」Tab：输入客户情况/一键问策 + SSE 流式可视化(阶段·模型·思考·逐字) + 4 模版选择 + iframe 报告预览 + 分享/切模版/保存网页托管 + 历史报告列表 |
| feat | prd-admin | 设置「问策知识库」分类说明默认资料与维护入口 |
| refactor | prd-admin | 产品管理 / 项目管理智能体显示名去掉「智能体」后缀（导航 + 百宝箱 + 后端 AppName + 权限标签） |
| feat | prd-admin | 产品管理「应用」与「设置」合并为统一「设置」中心，按 权限/产品/需求/功能/缺陷/客户/问策知识库 七分类组织（ProductSettingsHub） |
| feat | prd-api | 产品管理新增通用等级目录 ProductGradeOption（优先级/严重程度 × 需求/功能/缺陷，可增删改查 + 内置默认项），新增 grade-options CRUD 端点 |
| feat | prd-admin | 产品管理设置内新增「优先级 / 严重程度」可配置目录（GradeCatalogManager） |
| feat | prd-api | 产品管理单产品新增「产品结构」：ProductStructureNode 模块/能力骨架树（product_structure_nodes 集合 + 树 CRUD，删除级联软删后代并解挂功能）；Feature 加 StructureNodeId + PUT features/{id}/structure-node 挂载端点 |
| feat | prd-admin | 单产品新增「产品蓝图」导航：子 tab 产品结构（树编辑：增删改/逐层展开）+ 功能清单（已有功能挂结构节点的结构化全局总览 + 未归类区，复用 Feature 不另存） |
| feat | prd-api | 产品蓝图新增「产品规则」「产品字典」两实体（product_rules/product_terms 集合 + 各 GET/POST(upsert)/DELETE 端点，写=产品管理员）；ProductRule 含分类/标题/Markdown正文/状态，ProductTerm 含术语/别名/Markdown定义/分类 |
| feat | prd-admin | 产品蓝图新增「产品规则」「产品字典」子 tab：规则按分类分组+状态(生效/草稿/废弃)+Markdown正文折叠查看；字典术语+别名+分类+Markdown定义+搜索；均支持增删改，正文可用 [[术语]] 轻量交叉引用 |
| feat | prd-admin | 教程走完毕业帽飞回「教程」入口时，pill 用弹簧物理「接住」一下（非等比挤压回弹 + 环形辉光 + 涟漪），全局单点实现，全站入口统一生效 |
| fix | prd-admin | 修复页面卡顿时「接住」闪光比帽子落地迟数秒的脱钩：接住动画改为与飞行同帧挂载、用合成层 delay 预约引爆，不再走 onfinish→setState→重渲染的主线程链路，无论页面多卡都与帽子落地严丝合缝 |
| fix | prd-admin | 修复「接住」FX 在延迟未引爆时被新教程打断卸载后，挂在入口节点上的预约挤压动画幽灵引爆并与下次接住重叠（Bugbot Medium）：卸载时取消仍在 delay 期的 pill 动画、新教程启动前清空 flyBack/landFx |
| fix | prd-api | 修复 API Key 钥匙环误把错误密钥解出的乱码当作有效明文 |

### 2026-06-14

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | 修复海鲜市场技能预览右侧 SKILL.md 失真：代码块内 Prism markdown 表格 token 类名 `table` 与 Tailwind v4 `.table{display:table}` 撞名导致每个单元格各占一行，强制代码块 token 回退 inline |
| feat | prd-admin | 技能分享公开页顶部横条新增「下载技能压缩包」按钮（免登录直下，走已有公开 zip 端点） |
| feat | prd-admin | 技能分享改为弹窗式，支持选择有效期（永久/7/30/90 天），全局单例 SkillShareDialog 由卡片与详情弹窗共用 |
| fix | prd-admin | 技能分享弹窗：生成链接期间忽略别处 open()，避免界面与复制链接对应不同技能；详情弹窗 Esc 让位给上层分享弹窗，不再一次 Esc 连关两层 |
| fix | prd-admin | 技能分享弹窗 busy 闸改为生成时同步置位（不走 effect），杜绝点击到 effect 之间的竞态窗口 |
| feat | prd-api | 「我的分享」聚合新增技能分享（marketplace_skill），跨 5 类统一管理；技能分享链接 /s/skill/{token} 可在「我的分享」查看/复制 |
| feat | prd-admin | 「我的分享」页新增「技能」分类标签与筛选 |
| polish | prd-admin | 海鲜市场官方技能去置顶：取消「官方推荐」独立置顶区，官方与社区技能按当前排序（热门/最新）混排，官方身份仍由卡片「官方」徽章标识 |
| feat | prd-api | 短视频解析新增 Card 展示卡片数据（封面/作者/头像/时长/话题/点赞评论等统计）+ COS 永久视频地址，后端从平台原始元数据抽取干净字段供前端直接渲染 |
| feat | prd-admin | 短视频解析粘贴链接后改用仿真短视频卡片（复用海报 PosterFeedCardView）展示封面+可播放视频，取代原先的文字块；解析进度降为卡片下方一行状态，封面先出、入库后切 COS 永久地址播放 |
| fix | prd-admin | 修复快捷指令复制到剪贴板在非安全上下文/内嵌浏览器下静默失败却假报「已复制」的问题 |
| feat | prd-admin | 新增健壮剪贴板工具 lib/clipboard.ts（async API + execCommand 兜底 + 真实成功反馈），统一快捷指令各处复制 |
| fix | prd-admin | 快捷指令 iCloud 模板安装：配置复制失败时不再跳转 iCloud，避免装出来读不到配置 |
| fix | prd-admin | 快捷指令扫码安装页错误提示读错字段（永远显示「加载失败」），改为按 error.code 区分过期/失效/已删除/网络并给出下一步与重试 |
| feat | prd-admin | 快捷指令安装页新增「连接自检/验证密钥」：装完点一下诚实探活密钥是否仍被服务器接受（安装后唯一用户自查不了的失败点），非破坏性、不展示收藏内容。注：scs- token 按账号汇总且可共用，靠收藏计数判定「本次安装成功」不可靠，故只验密钥 |
| feat | prd-admin | 快捷指令安装页新增「遇到问题」常见卡点 FAQ（iOS 15+/不受信任/分享表单/网络权限） |
| polish | prd-admin | 快捷指令安装页手动兜底场景增加诚实友好提示（说明为何要多走几步+鼓励），并补全手动添加步骤（请求体/头部/自检收尾） |
| polish | prd-admin | 快捷指令 iCloud 模板配置面板增加影响说明（不配=全员手动，配好=全站一键），促使一次性配好 |
| fix | prd-admin | 快捷指令手动兜底：自动复制被浏览器拦截时也解锁「打开快捷指令编辑器」，避免照提示手动复制后仍卡死无法继续 |
| fix | prd-admin | 安装页暴露「完整配置」JSON 可手动复制：iCloud/签名流程下自动复制被拦截时不再死胡同（模板从剪贴板读的是整段 JSON 而非仅 Token） |
| fix | prd-admin | iCloud 流程自动复制被拦截后，新增「已手动复制？点此打开 iCloud 模板」直达链接，手动复制后仍能继续不卡死 |
| fix | prd-admin/prd-api | 连接自检改走专用 GET /api/shortcuts/verify，校验口径与 Collect 一致（密钥有效+未禁用+未过期），修复「已禁用快捷指令自检却显示密钥有效」；前端区分禁用/失效给不同提示 |
| fix | prd-admin | 安装页换快捷指令（路由 :id/t 变化复用组件）时重置 step/copyTried 并 remount 连接自检，避免显示上一条指令的「已复制/密钥有效」 |
| fix | prd-admin | iCloud/签名流程下自动复制失败的提示改为指向「完整配置」整段（模板读 JSON），纯手动流程仍指 Token/接口，避免照提示复制错内容 |
| feat | prd-admin | 新增「视觉分镜台」：想法/文章拆成电影分镜，关键帧复用视觉创作生图引擎实时生长、逐镜精修，预留 image-to-video |
| feat | prd-api | 新增视觉分镜拆镜接口 storyboard-script（visual-agent.storyboard.script::chat）：输出每镜关键帧图 prompt + 运动 prompt |
| fix | prd-api | OpenAIImageClient 支持 OpenRouter 图片生成协议（/chat/completions + modalities:[image,text]，从 message.images 取图），修复 OpenRouter 图片模型 404 |
| feat | prd-api | 工作流对话助手新增「校验+自动接线+自愈+缺项扫描」闭环：AI 生成的工作流自动规范化插槽、按 dataType 自动接线、结构错误回喂 LLM 自愈最多 2 轮，把产物从草稿变可跑件 |
| feat | prd-admin | 工作流助手对话气泡新增自动校验卡：展示校验状态、自动接线说明、待补齐配置/密钥项 |
| fix | prd-api | 修复工作流 from-chat SSE 事件用 `event: message` 包裹导致前端按 data.type 分发失效（workflow_created/generated/delta 事件无法触达） |
| feat | prd-api | 对话助手系统提示注入「暂未开放能力」清单（定时/Webhook 触发），引导 AI 改用手动触发而非静默省略 |
| feat | prd-admin | 工作流自动校验卡的「待补项」改为就地可填表单：填完一键「补齐并应用到编辑器」把值烘焙进节点配置/变量，省去逐节点找配置 |
| feat | prd-admin | 工作流列表页新增「一句话生成工作流」入口：描述需求 → 自动建流进画布并由 AI 生成，不必先建空白再手配 |
| fix | prd-api | 工作流校验对重复 nodeId 容错（不再 ToDictionary 抛异常崩 SSE），重复 ID 报为结构问题交自愈 |
| fix | prd-api | AI 生成工作流仅在结构校验通过时才落库自动创建，自愈仍失败的退回草稿不持久化残缺工作流 |
| fix | prd-admin | 有缺项时隐藏「应用到编辑器」绿钮（避免用未填值覆盖）；缺项未填全时禁用「补齐并应用」，杜绝假「已补齐」 |
| fix | prd-api | 工作流校验对重复变量 key / null 节点 config 容错，不再崩 SSE；SSE 错误事件补 message 字段让前端显示真实失败原因 |
| fix | prd-api | 自动接线改为「补缺连线」：漏接一跳的处理节点自动从前序节点补上游，避免它当空输入独立根却被判可执行 |
| fix | prd-admin | 「一句话起步」auto-send 与历史加载竞态：历史晚返回不再覆盖刚追加的流式消息 |
| fix | prd-admin | 画布保存补回 variables：AI 缺项补齐填入的变量默认值（如 cookie）不再在 handleSave 时丢失，并带入执行变量 |
| fix | prd-api | 缺项扫描新增条件必填：TAPD 选 Cookie 认证时 cookie/dscToken 必填、选 Open API 时 authToken 必填，避免漏报后执行才炸 |
| fix | prd-api | 自动接线改为按插槽粒度：data-merger 等多输入节点的每个必填输入槽都补上游，补不上的暴露为结构问题（不再单输入静默通过） |
| fix | prd-api | 校验结果随对话消息持久化：刷新对话历史后「应用门禁」与缺项卡可恢复 |
| fix | prd-admin | 应用门禁加严：结构无效（环/重复/停用舱补不掉）时禁用「应用到编辑器」「补齐并应用」，并提示先解决结构问题 |
| ops | deploy | 兼容正式环境仅配置项目 JWT 时的 API Key 加密密钥空值默认 |
| fix | cds | self-update 后仅在 forwarder 运行时文件变化时重启 forwarder |
| fix | cds | 修复 forwarder-run 覆盖运行时签名导致 master 重启时反复重启 forwarder 的问题 |
| fix | cds | 兼容旧版裸 forwarder 签名文件，升级时只迁移签名不重启业务转发进程 |
| fix | cds | forwarder 自同步签名仅纳入实际运行的 JS 文件，避免 source map 和类型声明变化触发重启 |
| fix | cds | forwarder 自同步优先按源码签名判断，避免构建产物波动导致 master 重启时误重启业务转发进程 |
| fix | cds | forwarder 自同步在 Git 仓库内优先使用 HEAD 源码 blob 签名，避免 pnpm/install/systemd 环境差异造成签名抖动 |
| fix | cds | master-run 在 systemd 非交互环境下以 CI=true 执行 pnpm install，避免 pnpm 要求确认删除 node_modules 导致 master 启动失败 |
| fix | cds | self-update 默认跳过分支操作排空等待，仅在请求显式传 drain 参数时等待 |
| fix | prd-admin | 修复对端同步队列待开始与全局失败状态展示不一致 |
| fix | prd-admin | 修复短视频后台轮询在抽屉关闭或切换后继续写入界面 |
| fix | prd-api | 短视频下载前强制要求解析器返回真实媒体地址 |
| polish | prd-admin | 优化知识库短视频解析结果按钮分组，将已入库产物与继续加工动作分区展示 |
| feat | prd-api | 短视频解析改为服务端后台 run 执行，阶段进度和入库产物持久化到 MongoDB |
| feat | prd-admin | 短视频解析前端轮询服务端 run，刷新后可恢复后台进度并动态展示结果按钮 |
| polish | prd-admin | 短视频解析结果展示服务端解析说明，明确元数据降级和待补充文案骨架状态 |
| polish | prd-admin | 优化短视频解析后台进度文案，隐藏内部状态码并改为用户可理解的处理进度 |
| polish | prd-api | 调整短视频解析 run 阶段持久化文案，避免刷新恢复后显示内部工程词 |
| security | prd-api | 短视频素材与视频转文字下载改用 SafeOutbound 校验，阻断内网地址 SSRF |
| security | prd-api | 模型平台 API key 加密改为独立 ApiKeyCrypto__Secret，兼容旧 JWT 密文并支持自动迁移 |
| security | cds | 项目容器不再使用 CDS_JWT_SECRET 兜底注入 Jwt__Secret，避免 CDS 自身密钥轮换穿透业务项目 |
| fix | prd-api | 短视频解析改为视频优先入库，禁止把平台描述冒充字幕文稿 |
| fix | prd-api | 修复 TikHub 抖音视频对象解析为超长 JSON 导致无法下载的问题 |
| fix | prd-api | 短视频 ASR 兼容现有 Whisper/OpenAI 普通模型池，不再只支持 doubao 流式转写 |
| fix | prd-admin | 短视频解析新链接发送时清理旧回复，并按视频、原始文字、后续加工展示动作 |
| fix | prd-api | 更新短视频解析器 TikHub 调用到 OpenAPI 新端点，修复旧接口返回 HTML 导致降级的问题 |

### 2026-06-13

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 处理人选择新增「负责人/产品管理员/应用管理员」快捷项，保留手动搜索 |
| polish | prd-admin | 产品管理模块所有处理人输入统一接入产品维度快捷选择组件 |
| polish | prd-admin | 管理员设置页新增产品/管理员两列表，管理员按分号展示 |
| fix | cds | 新 CDS 空 Mongo 首启默认 fresh，不再静默导入旧 state.json 生成遗留 default 数据 |
| fix | prd-admin | 修复 CI：tsc 类型错误、版本导入「产品」列误匹配、单测补全 |
| fix | prd-api | ProductImportProductRoutingTests / ProductEntityNumberingTests 补 using Xunit 修复 Server Build CS0246 |
| test | prd-api | DefectSeverityCatalog TAPD 优先级映射测试 |
| fix | prd-admin | 修复小技巧自动开讲未复用导航逻辑导致同路由详情态找不到锚点 |
| fix | prd-api | 修复知识库与同步教程 seed 的落点和过时锚点 |
| fix | prd-admin | 新建缺陷关联版本默认取功能 plannedVersionId，兜底纳入版本中 updatedAt 最新 |
| docs | 下载 | 产品管理系统设计理念 MD 与 50 条需求 CSV 测试数据 |
| feat | prd-admin | 缺陷导入支持 RTF 与「处理人」「创建人」列解析 |
| feat | prd-api | 缺陷/需求批量导入按 TAPD 处理人姓名匹配系统用户并写入 AssigneeId |
| feat | prd-api | 缺陷总览导入新增 overview/defects/import，按应用/产品列跨产品路由 |
| feat | prd-admin | 缺陷总览导入取消手动选归属产品，按文件应用/所属产品列自动匹配系统产品 |
| fix | prd-admin | 缺陷导入：TAPD「优先级」唯一映射为系统「严重程度」，无值留空 |
| fix | prd-api | 缺陷导入移除优先级→Grade 误映射，仅写 structuredData 严重程度 |
| fix | prd-api | 移除编译失败的 DefectPriorityCatalog，TAPD 优先级改映射严重程度 |
| polish | prd-admin | 功能目录工具栏单行对齐，宽搜索模式隐藏 0/0 命中计数 |
| fix | prd-admin | 修复 listFilter FilterBar 未解构 showResultCount 导致 tsc 失败 |
| polish | prd-admin | 历史数据导入入口收敛至总览菜单（管理员），功能目录保留单产品页导入 |
| polish | prd-admin | 移除单产品版本/需求页的历史导入按钮 |
| feat | prd-admin | 发起立项表单改为产品搜索选择，移除系统/应用/部门/需求描述手填 |
| feat | prd-api | 立项创建关联产品并自动填充部门与系统/应用 legacy 字段 |
| feat | prd-api | 立项记录新增 Agent 评审尝试历史、会议稿次结构与 PATCH meeting 回填接口 |
| feat | prd-admin | 内部版本详情页新增「立项详情」Tab：Agent 评审记录 + 线下评审会稿次编辑 |
| feat | prd-admin | 立项向导第三步支持选择计划稿次（1–3 稿）；评审失败可重新发起、决策待办可继续决策 |
| polish | prd-admin | 内部版本列表新增 Agent 评审分列；操作列按需显示「重新发起立项」「会议结果」 |
| polish | prd-admin | 立项向导第 2/3 步新增「上一步」；回退修改基础信息时 PATCH 更新原记录 |
| feat | prd-api | 立项 PATCH 基础信息；decision_pending 状态允许重新同步 Agent 评审 |
| fix | prd-api | 修复 MdToPpt 整篇生成复用预热会话时未校验所选模型配置的问题 |
| polish | prd-admin | 主页缺陷列表加长搜索框、五维筛选、追踪按钮移至筛选项右侧 |
| polish | prd-admin | 主页需求列表同步宽搜索框与追踪按钮位置 |
| polish | prd-admin | 单产品需求/缺陷、功能目录、版本工作流列表统一工具栏布局与主体字段筛选 |
| feat | prd-api | 跨产品缺陷列表 API 返回处理人字段 |
| fix | prd-admin | 产品负责人多选去掉下拉重复搜索框并统一正式占位文案 |
| polish | prd-admin | 优化对端同步弹窗的队列状态、反向校验与主操作展示 |
| polish | prd-admin | 收敛对端同步弹窗视觉层级，区分可点击控件与只读监控信息 |
| polish | prd-admin | 优化知识库卡片分享与跨系统同步状态展示，避免长文案在窄卡片中竖排换行 |
| fix | prd-admin | 修复对端同步进行中取消勾选后任务卡片误显示为未选的问题 |
| fix | prd-api | peer-sync 同步结果返回结构化新增/更新/跳过统计，并同步知识库模板键 |
| perf | prd-api | 知识库互传记录源正文 hash，已同步内容二次同步时跳过图片重传和重复合并 |
| polish | prd-admin | peer-sync 队列增加已跳过状态，文档树时间统一为紧凑绝对时间 |
| polish | prd-admin | 将知识库卡片双向同步状态图标调整为左右双向箭头，提升语义可读性 |
| polish | prd-admin | 优化知识库跨系统同步弹窗右侧传输预览动效 |
| polish | prd-admin | 重设计知识库跨系统同步右侧状态面板,突出成功失败结果 |
| fix | prd-api | 修复知识库跨系统同步在内容未变时跳过原始时间回写的问题 |
| fix | prd-api | 修复知识库跨系统同步图片重传的域名识别与精确替换问题 |
| fix | prd-api | 修复受保护知识库被对端失败 apply 标记为同步错误的问题 |
| fix | prd-admin | 修复发送到对端弹窗加载错误误判为同步失败的问题 |
| fix | prd-api | 对齐产品工作流默认流转数量与目录测试断言 |
| chore | .claude | 修复视觉验收归档 local 模式默认输出目录绕过代码库保护的问题 |
| ci | github-actions | 将预览冒烟和 Playwright E2E 移出 PR 必经 CI,改为独立手动验收 workflow |
| docs | repo | 清理 GitHub 根目录展示,重写 README 并归档原型与冒烟样本 |
| feat | prd-api | 跨系统知识库同步支持保留原时间、允许覆盖、目标域图片重传和同步状态回写 |
| polish | prd-admin | 重做发送到对端节点弹窗为左右同步工作台，并在知识库列表与详情展示跨系统同步标识 |
| fix | prd-api | 项目管理：目标标题/描述/负责人更新后级联同步到联动里程碑(AutoFromGoal)，修复里程碑显示旧目标名 |
| fix | prd-admin | 项目管理：目标编辑保存后刷新父级 goals/milestones，里程碑「关联目标」下拉与列表同步最新目标名 |
| feat | prd-admin | 项目管理：目标/里程碑/任务/立项表单新增草稿缓存(sessionStorage)，误关弹窗或误跳页后重开自动恢复未保存内容 |
| feat | prd-admin | 项目管理：目标支持同级拖拽排序 + 向上/向下添加同级；里程碑支持拖拽排序(改为手动顺序优先) |
| feat | prd-api | 项目管理：新建目标支持指定 OrderKey，用于「向上/向下添加同级」按相邻中值定位插入点 |
| feat | prd-api | 项目管理：新增全局总览只读端点(global/projects + global/summary)，跨全公司项目多维筛选+健康预警+经营汇总+负责人负载，权限 pm-agent.global |
| feat | prd-admin | 项目管理：新增「全局总览」菜单(NPSS看板上方，仅管理层)，四块只读洞察(项目总表/健康预警/经营汇总/负载分析) |
| fix | prd-admin | 修复项目知识库预览全屏不展开（DocBrowser 阅读区改用 createPortal 全屏覆盖层，替代原生 Fullscreen API） |
| feat | prd-api | 项目管理智能体新增全局知识库只读端点（knowledge/overview + entries + entry content，仅 pm-agent.dashboard，绕过项目成员鉴权） |
| feat | prd-admin | 项目管理智能体工作台新增「全局知识库」菜单：管理员只读洞察全部项目知识库，多维筛选 + 默认展开分组 + DocBrowser 正文预览 |
| fix | prd-admin | 修复知识库全屏覆盖层背景误用半透明 token 导致整页穿透（改用不透明 --bg-base）；修复上传 PDF 等文件后标题回退显示文件名（放开提取正文类型参与正文标题推导，仅排除 HTML/XML 源码） |
| refactor | prd-admin | 全局知识库改为列表→详情两段式（列表全宽、点文档进该项目全宽 DocBrowser），解决多列嵌套挤压正文；Agent 全屏左导航支持收起/展开；DocBrowser 阅读区右侧本页章节/批注栏支持收起 |
| fix | prd-admin | 修复全局知识库详情阅读区高度截断（DocBrowser wrapper 补 flex flex-col 使 flex-1 生效）；列表改扁平表格行+服务端分页（应对文档多）+ 新增项目筛选；去除"只读/掌控全局"等冗余文案；DocBrowser「+」新建按钮仅在有写操作时显示（只读态不再露占位项） |
| feat | prd-api | 项目管理审计日志端点新增 keyword（路径/操作 regex）+ method 筛选参数 |
| feat | prd-admin | 项目管理审计日志顶部新增搜索框 + 操作方法筛选（关键词防抖、筛选重置页码） |
| fix | prd-admin | 修复 MD 转 PPT 大纲流取消后仍可能回写草稿的问题 |
| fix | prd-api | 修复 MD 转 PPT 整坨 JSON fallback 大纲未持久化导致刷新恢复为空的问题 |
| fix | cds | 修复 Agent 请求观测台只在 stop 时落历史导致完成或失败请求重启后丢失的问题 |
| fix | cds | 修正 cdscli preview-url 本地 fallback slug 说明与实际优先级不一致的问题 |
| polish | prd-admin | 产品管理员一览从设置页移至应用配置页 |
| polish | prd-admin | 产品管理员一览改为应用配置页独立标签（需求/功能/缺陷/产品管理员） |
| fix | prd-admin | 修复版本详情 TS 类型与未使用导入导致 CI tsc 失败 |
| fix | prd-api | 工作流内置流转边数量与 pending 状态迁移测试对齐当前目录 |
| fix | prd-api | 修复 ProductAgentController 解析 customerNames 时 GetValueKind 未加括号导致 CS8978 编译失败 |
| fix | prd-api | 补充 System.Text.Json 引用修复 JsonValueKind CS0103 编译失败 |
| feat | prd-api | 设置调试入口：清空产品管理全部业务数据（保留配置） |
| feat | prd-admin | 设置页新增「调试」tab，确认后一键清空演示数据 |
| fix | prd-api | 调试清空收紧范围：知识库仅删 product-agent 挂载，缺陷仅删追溯/导入记录 |
| feat | prd-admin | 产品/需求/功能列表标题展示当前筛选结果总数 |
| feat | prd-api | 新建产品编号改为 TAPD 风格纯数字（全局递增） |
| feat | prd-admin | 产品管理全量列表统一复选框多选，复用 listSelection + ListBatchBar 支持批量导出/删除/指派 |
| refactor | prd-admin | 新增 selectableList 组合层，各 tab 收敛 useOverviewTableSelection + SelectionActionBar + SelectableRow，消除重复样板代码 |
| fix | prd-admin | 列表多选复选框列统一固定宽度居中，表头全选与行复选框垂直对齐 |
| feat | prd-api | 产品支持多位负责人 OwnerIds，创建/导入默认留空不再绑定当前用户 |
| feat | prd-admin | 产品新建/修改弹窗增加多选负责人，列表空负责人显示待认领 |
| refactor | prd-admin | 内部/正式版本表格与详情去掉系统/应用列，合并为产品列 |
| test | prd-admin | workflowTransitionGuard 与 versionBasicInfoCatalog 补充用例 |
| feat | prd-api | 产品编号改为「类型前缀-全局序号」，调层级只改前缀不改号 |
| feat | prd-admin | 记录详情标题旁新增追踪星标与复制菜单（标题/ID/链接/标题+链接） |
| feat | prd-admin | 需求/功能/缺陷/版本列表工具栏新增「追踪」筛选，仅显示已追踪记录 |
| fix | prd-admin | 正式版本详情页：基础信息改卡片属性表，需求/功能/缺陷三标签改列表，加载失败时 listReleases 兜底 |
| feat | prd-admin | 全局产品总览「产品」区块新增卡片/列表视图切换，列表复用 OverviewDataTable |
| fix | prd-api | 工作台 AI 助手创建需求时识别客户提出方：写入 CustomerIds、需求来源，并加载全局客户名录 |
| fix | prd-api | 工作台助手：客户未建档时先多轮确认再 create_customer+需求；禁止客户名称文本兜底；前端传对话历史 |
| polish | prd-admin | 新建需求保存禁用时顶栏展示校验原因并高亮来源补充字段 |
| fix | prd-api | 新建需求 CurrentState 回退内置 new（待评审），ResolveInitialStateAsync 不再返回 null，LegacyStateMap 迁移误写的 state |
| fix | prd-admin | 新建需求顶栏展示初始状态「待评审」，表单模板排除 state/状态 字段避免与流程状态混淆 |
| polish | prd-admin | 列表多选复选框默认低透明度，悬停行/单元格时显现，选中态保持可见 |
| feat | prd-api | 需求导入无外部 ID 时自动分配纯数字 RequirementNo 并同步 ExternalId，同批导入全局递增 |
| fix | prd-api | 需求编号改为全库全局递增（不再按产品隔离），与 TAPD/设计理念一致 |
| fix | prd-api | 缺陷编号改为全库 DefectReports 单表全局递增；T/V 版本编码全库全局递增 |
| refactor | prd-api | 功能编号按正式版本清单（OfficialReleaseId）递增；抽取 ProductEntityNumbering SSOT |
| fix | prd-admin | CSV 空需求 ID 列解析为未提供，交由后端自动编号 |
| fix | prd-api | 单产品需求导入写入指定产品；overview 我的需求含负责人 |
| fix | prd-admin | 需求 CSV 无应用列时支持默认归属产品，0 条写入时明确提示 |
| feat | prd-admin | 新建需求按来源动态展示必填补充项（客户/规划/活动/竞品） |
| feat | prd-admin | 知识库添加短视频解析入口，并在百宝箱注册短视频解析常用工具 |
| feat | prd-api | 新增短视频素材解析接口，复用短视频解析胶囊并沉淀原始素材、字幕文稿和时间轴片段 |
| feat | prd-admin | 将短视频解析改为知识库内素材加工工具，解析产物作为知识库资产继续再加工 |
| fix | prd-admin | 修复全量 lint 阻断的正则转义与条件 Hook 问题 |
| polish | prd-admin | 优化短视频素材入库弹窗的遮罩透明度、结果表达和素材包产物可读性 |
| refactor | prd-admin | 将短视频解析入口改为复用知识库智能体对话，短视频链接作为默认工具输入处理 |
| fix | prd-admin | 修复短视频工具会话冷启动时未默认选中短视频解析智能体的问题 |
| polish | prd-admin | 内部版本与正式版本详情页容器改为全宽布局 |
| fix | prd-admin | 版本详情页固定四标签结构：基础信息对齐立项/上线语雀 Excel 全列，需求/功能/缺陷空列表仍保留表头 |
| fix | prd-admin | 历史导入正式版本（announcement_pending）进入详情四标签只读视图，不再落入申领表单 |
| fix | prd-api | 版本工作流导入时将备注与项目组成员写入 legacyData 供详情页展示 |
| feat | prd-api | 版本总览导入新增 overview/versions/import，按应用/产品列跨产品路由 |
| refactor | prd-api | 需求/缺陷导入移除 forcedProductId 兜底产品分支，单产品入口复用核心方法统一按行路由 |
| polish | prd-admin | 历史导入弹窗移除「默认归属产品」选择，需求/缺陷/版本统一按文件应用/产品列自动匹配，未匹配行跳过 |
| rule | .claude | 强化视觉验收技能,禁止截图和临时验收产物写入代码库 |

### 2026-06-12

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 统一拓扑页基础设施数据入口到独立资源控制台，并支持资源深链直接打开数据页签 |
| security | cds | 修复项目级 key 可在发布目标中引用跨项目服务器凭据的问题 |
| feat | cds | 发布中心升级为站点发布作战台，补齐健康探测、失败重试和版本选择回滚闭环 |
| polish | cds | 发布中心默认入口改为 `/release-center`，项目 query 仅作为多项目覆盖使用 |
| polish | cds | 将发布中心与分支发布弹窗改为站点发布视角，补齐发布确认信息、步骤化发布记录、发布脚本可执行检查和移动端弹窗约束 |
| fix | prd-admin | 商品溯源智能体：问题排查长回答改为块级可换行气泡，流式输出只动画尾部但保留全文，避免回答若干行后被压缩成空框 |
| fix | prd-admin | 清理标签截断工具正则中的非法全角空白字符，解除前端全仓 lint 阻塞 |
| feat | prd-admin | 商品溯源智能体 Tab 支持 `?tab=cases` 深链，预览验收可直接打开问题排查页 |
| fix | prd-admin | 商品溯源智能体-问题排查：修复 AI 回答流式输出几行后塌缩成空框（onDone/onError 的 setMessages 惰性 updater 读到被同步清空的 streamRef，落库空内容；改为先取局部常量再提交） |
| fix | prd-admin | 商品溯源智能体：修复问题排查生成中向上滑动时回答被压缩——自动滚动改为仅在用户贴底时触发（向上滑离底即停），并用即时滚动替代 smooth，避免与用户滚动相互打架 |
| fix | prd-admin | 商品溯源智能体：彻底修复问题排查长回答被压缩成一行——气泡外层 flex flex-col 容器在内容含 overflow 子元素时 flex item 自动最小高度塌成 0，改为普通块级布局（与业务知识一致） |
| fix | prd-admin | 商品溯源智能体：修复问题排查/业务知识流式回答在若干行后被压缩成代码框（局部未闭合 markdown 重渲染），统一改用 StreamingText（流式渲染纯文本、完成后渲染 markdown） |
| fix | prd-admin | 商品溯源智能体：各 Tab 改为常驻挂载（display 切换），切换 Tab 不再清空业务知识/问题排查的对话记录 |
| feat | prd-admin | 商品溯源智能体：业务知识 / 案例文件导入新增口令校验弹窗（口令 090676）才能导入 |
| fix | prd-admin | combobox 内嵌 input 加 no-focus-ring，修复搜索框「框中框」重复渲染观感 |
| polish | prd-admin | 功能详情/新建功能「主需求与关联需求」改用 ItemSearchSelect + ItemMultiSearchSelect（对齐客户选择交互） |
| feat | prd-admin | 产品管理评论区支持微信式 @ 成员：输入 @ 弹出检索下拉并提醒对应用户 |
| fix | prd-api | 缺陷导入只读 TAPD「严重程度」列五档映射 V2.6，镜像 TAPD严重程度 |
| fix | prd-admin | 缺陷导入支持 xlsx，不再误读「优先级」「缺陷等级」列 |
| feat | prd-api | 应用配置缺陷工作流种子、POST /transition 支持 defect、流转联动需求↔缺陷 |
| feat | prd-api | 缺陷 ProductDefectClassification 字段；需求 FormData 产品缺陷标记 |
| feat | prd-admin | 应用配置版本 tab 改为缺陷；流转矩阵支持跨对象联动配置 |
| feat | prd-admin | 需求详情勾选产品缺陷；缺陷详情勾选非产品缺陷 + WorkflowBar 流转 |
| feat | prd-admin | 缺陷详情按 TAPD 结构重建（25 个对齐字段 + 评论/变更历史 + 附件区） |
| feat | prd-api | TapdDefectFieldCatalog + 缺陷 structuredData 更新接口 |
| polish | prd-admin | 功能详情「所属功能模块」改为可搜索选择框 |
| chore | doc | 熵清理：D3 补缺 2 条(debt/design.knowledge-base-mention-network)，D6 处理 5 条 changelog(里程碑/peer-sync/pm/产品卡片) |
| fix | prd-admin | 功能目录树左右栏撑满视口高度，主页功能 tab 去掉 SectionShell 滚动包裹 |
| feat | prd-admin | 功能 tab 改为左侧无限层级目录树 + 右侧子树表格，支持 CSV/Excel 导入目录结构 |
| feat | prd-api | 新增 POST products/{productId}/features/import-tree 按路径导入功能树 |
| feat | prd-admin | 功能详情页按 V2.6 字段规范重组：基础信息/版本信息/需求关联/缺陷关联/交付内容 |
| polish | prd-admin | 功能「计划版本」改为「内部版本号」，立项必选并链到内部版本详情；验收标准去掉 AC 缩写并补充说明 |
| polish | prd-admin | 功能表单「正式上线版本号」统一为「正式版本号」 |
| feat | prd-api | 功能目录导入须指定正式版本，导入记录写入 OfficialReleaseId 并按版本隔离路径幂等 |
| feat | prd-admin | 导入弹窗增加正式版本必选；功能清单筛选改为正式版本（V 号） |
| feat | prd-admin | 所属功能模块改为功能目录树逐级点选 + 搜索快捷定位，选中后保存完整目录路径 |
| fix | prd-admin | 功能对象移除分级（P0-P3）UI：新建/详情/总览/图谱/看板/批量操作不再展示或编辑分级 |
| fix | prd-admin | 修复产品管理 SingleProductView Row 可选删除与 VersionWorkflowTab 未使用符号的 tsc 报错 |
| polish | prd-admin | 功能目录树默认展开 3 级 |
| polish | prd-admin | 前端搭档智能体图标统一为项目管理智能体同款 |
| polish | prd-admin | 前端搭档智能体生成按钮升级为液态动效 |
| fix | prd-admin | 历史导入需求/缺陷描述与评论中的 @用户名 渲染为高亮 mention 标签 |
| fix | prd-admin | 产品动态评论空 content 兜底，避免 ActivityTimeline 类型报错 |
| fix | prd-api | 导入按「应用」匹配产品，未匹配行跳过，移除兜底落入 |
| fix | prd-admin | 版本/需求导入 UI 去掉兜底产品选择，预览未匹配为跳过 |
| fix | prd-api | 版本工作流/需求导入按 Excel「应用」列匹配系统产品，支持跨产品路由 |
| fix | prd-admin | 版本工作流导入预览展示「应用→产品」映射，全局导入走 overview API |
| feat | prd-admin | 立项向导第二步 Agent 评审增加进度条、过程日志与分项评分实时展示 |
| test | prd-admin | 立项评审进度计算单元测试 |
| fix | prd-admin | 立项评审 SSE 完成后跳过易失败的 getSubmission，直接同步并支持重试 |
| feat | prd-admin | 知识库划词 AI 局部编辑：选中文字浮层从「添加评论」扩展为 评论 / AI 改写 / 配图 动作条；AI 改写支持润色/精简/扩写/书面化/纠错 + 自定义指令，流式生成 + diff 对比 + 替换原文（唯一定位校验，歧义禁替换）/ 插到原文后；配图内嵌视觉创作 mini 面板，按选区与文档上下文生成并插入选区段落之后 |
| feat | prd-api | 新增知识库划词改写 SSE 端点 POST /api/document-store/entries/{id}/selection-rewrite（服务端定位选区 + 截取上下文窗口喂 LLM）与动作清单端点 GET /api/document-store/selection-rewrite/actions（SelectionRewriteActionRegistry 为 SSOT），注册 AppCallerCode document-store.selection-rewrite::chat |
| test | prd-admin | 新增 selectionEdit 纯函数单测 16 例（选区定位/DOM 序号指认/歧义拒绝/替换/段落后插入/frontmatter 前缀拼接/图片 markdown 清洗） |
| fix | prd-admin | 划词改写选区定位改为 DOM 序号指认（Bugbot High）：同文多处出现时 useContentSelection 的 offset/contextBefore 恒指向第一处，旧逻辑会替换错位置；现从真实 DOM Range 数"选区前同文出现次数"指认第几处，序号与正文统计不一致即禁用替换 |
| fix | prd-admin | 划词改写浮层展示模型 thinking 流（Codex P2）：推理模型先吐思考时不再只有 spinner |
| fix | prd-admin | 分享阅读页「返回我的知识库」按钮常驻显示：旧逻辑仅登录态渲染，未登录标签页里入口整个消失（用户反馈"找不到回知识库"）；匿名点击走登录，文案如实标注 |
| fix | prd-admin | 划词改写「替换原文」可用性改为实时计算（Bugbot Medium：打开浮层时冻结的 canReplace 会过期）；新增 isReplaceSafe 守卫——选区落在 wikilink/markdown 链接标记内部时禁用替换，防止 AI 结果拼进括号中间破坏语法（Bugbot Medium） |
| fix | prd-admin | 划词配图浮层隐藏「插入原文+配图」按钮（Codex P2：选区场景原文已在文档里，该动作会丢弃文本参数且语义重复）；VisualCreationMiniPanel 的 onInsertImageWithText 改为可选 prop |
| polish | prd-admin | 产品/需求/缺陷列表条数从页面标题移至表头「产品名称/标题」列 |
| polish | prd-admin | 功能页标题去掉条数后缀 |
| polish | prd-admin | 主页功能 tab 产品选择改为可搜索下拉，置于「全部版本」左侧 |
| polish | prd-admin | 主页功能面板对齐单产品 FeatureCatalogTab：产品标签 + 版本筛选，操作钮移至搜索框右侧 |
| feat | prd-admin | 全局功能页为管理员启用「导入目录结构」按钮 |
| fix | prd-admin | 产品管理总览支持 ?section=versions 等深链直达左侧导航分区 |
| polish | prd-admin | 全局总览需求分区标题由「需求（跨产品）」改为「需求」 |
| polish | prd-admin | 全局总览页缺陷/版本/知识库标题去掉「跨产品」后缀 |
| fix | prd-admin | 总览 section 深链改为 URL 派生状态，对齐 SingleProductView 模式 |
| polish | prd-admin | 全局总览表格标题默认截断 40 字，列宽可拖动并 sessionStorage 记忆 |
| fix | prd-admin | 产品负责人多选去掉下拉重复搜索框并统一正式占位文案 |
| feat | prd-api | 跨产品版本 overview 接口扩展为与单产品版本 tab 同构的全字段宽表数据 |
| feat | prd-admin | 主页版本列表对齐单产品内部/正式版本表列（只读，无操作列） |
| fix | prd-admin | 目标设为里程碑后「里程碑」tab 看不到：GoalsPanel 联动操作（设为/取消里程碑、删目标）通过 onMilestonesChanged 通知父级刷新 milestones，不再依赖整页刷新 |
| fix | prd-admin | 里程碑日历视图新增「未排期」区域：无截止日的里程碑（含目标联动里程碑）不再隐身，可点开补日期 |
| fix | prd-api | 删除目标时级联清理 AutoFromGoal 联动里程碑，不再留孤儿数据（手动建的关联里程碑不动） |
| feat | prd-api | 里程碑列表返回 autoFromGoal 字段，前端可区分目标联动里程碑 |
| feat | prd-admin | 目标/里程碑视觉区分：联动里程碑在时间轴/日历/管理条/详情抽屉显示 Target 图标 + 「来自目标」紫色标记；设为里程碑的目标在列表卡与画布节点常显紫色 Flag 标记 |
| feat | prd-api | AI 项目简报：POST /api/pm/projects/:id/briefings/generate SSE 生成（硬数据服务端统计 + LLM 结构化内容 + 模板渲染自包含 HTML），简报列表/详情/删除端点，pm_briefings 集合，注册 pm-agent.briefing::chat |
| feat | prd-admin | 报表 tab 新增「项目简报」区块：生成（SSE 阶段/思考/逐字全程可视化 + 模型名展示）、历史列表、iframe 预览、下载 HTML 单文件 |
| feat | prd-api | 简报分享与托管：POST /briefings/:id/share 开关分享（可撤销 token），GET /briefings/shared/:token 匿名直出 HTML，POST /briefings/:id/save-to-hosting 一键存网页托管；审计过滤器登记简报动作 |
| feat | prd-admin | 简报预览弹窗新增「开启分享/复制链接/撤销分享」「保存到网页托管」操作，列表显示分享中/已托管标记 |
| fix | prd-api | 简报匿名分享被 AdminPermissionMiddleware 拦成 401：/api/pm/briefings/shared/ 加入扫描器 PublicRoutes 白名单（token 即凭证） |
| feat | prd-api | 简报 5 套风格主题（经典商务/暗夜科技/暖纸杂志/极简黑白/活力渐变）：生成时可选，落库渲染数据快照，POST /briefings/:id/restyle 切换风格即时重渲染不重调 LLM；styles 清单端点 SSOT |
| feat | prd-admin | 简报生成弹窗新增风格选择卡；预览弹窗新增全屏切换、切换风格面板；保存到托管成功后按钮变「打开托管站点」+ 列表「已托管」可点击直达，反馈不再依赖弹窗 |
| feat | prd-api | 简报重命名端点 PUT /api/pm/briefings/:id（owner/leader/创建者，120 字上限），审计登记 |
| feat | prd-admin | 「资料」tab 新增「简报」子 tab 管理主场：搜索/风格筛选/行内重命名/批量删除/超 10 条按月分组，?sub= 深链直达；报表 tab 简报区块瘦身为最近 3 条轻入口 + 「管理全部」跳转 |
| polish | prd-api | 简报 HTML 去掉页脚「由 PRD Agent 生成 · 模型」注释（模型名系统内弹窗仍可见） |
| feat | prd-api | 简报报告周期：生成接受 from/to（中国时区自然日），叙事数据按周期取（周期内达成里程碑/周期内周报），总体指标保持截至当前真值；标题与页头带报告周期，periodFrom/To 落库 |
| feat | prd-api | 简报调整：POST /briefings/:id/refine（SSE），复用落库硬数据快照 + 原内容 + 自然语言指令重写并原地覆盖（不重调统计、不留旧版本）；生成端点支持可选补充要求 note |
| feat | prd-admin | 生成弹窗新增报告周期选择（本周/上周/本月/上月/全周期/自定义）与「补充要求」输入；预览弹窗新增「调整内容」：自然语言描述 → SSE 流式重写 → 原地刷新 |
| fix | prd-api | 简报调整偶发「LLM 流式失败: No cookie auth credentials found」：PM 智能体所有 LLM 流式调用在零产出失败时自动重试（至多 3 次，每次重新走模型解析切换池内健康平台） |
| refactor | prd-admin | 项目知识库移除「成员作品」子视图与二级标题，只保留知识文档直出 |
| feat | prd-api | 网页托管新增 GET /api/web-pages/:id/content：服务端代理读取站点入口 HTML（owner/团队成员可读，2MB 上限，包装资产站拒绝），供知识库导入绕开浏览器跨域 |
| feat | prd-admin | 项目知识库新增「从网页托管导入」：选择我的/团队共享站点，HTML 内容一键导入为知识文档（可预览） |
| revert | prd-admin | 按用户要求下线简报「调整内容」入口（预览弹窗按钮/面板/流式重写 UI 移除；后端 refine 端点暂留无入口，记入债务台账） |
| feat | prd-admin | 知识库 HTML 文档真渲染：fileTypeRegistry 新增 html 类型（Globe 图标 + html 预览），FilePreview 对 HTML 正文用 sandbox iframe srcDoc 渲染页面而非源码（编辑态仍可改源码） |
| feat | prd-admin | 知识库双击文件名即可重命名（复用既有重命名弹窗，文件夹双击仍为展开/收起） |
| polish | prd-admin | 「从网页托管导入」并入文档列表统一「添加」菜单（与新建文档/上传文件/新建文件夹同级），移除右上角独立按钮，内容区上移；HTML 文档不再被 <!DOCTYPE html> 源码首行污染「正文标题」 |
| fix | prd-api | 知识库上传/编辑被拦 403「无权限」：document-store 的 stores/entries 业务路由从 AdminPermissionMiddleware 豁免（登录 + 业务层 CanRead/CanWrite 鉴权保留）；控制器权限位改为权限服务回查兜底（豁免后中间件不再注入 claims，避免识途/产品知识库管理员判定失效） |
| fix | prd-admin | 任务开始/截止日期保存后少一天（看似保存不了）：日期改为纯日期字符串提交（与里程碑同口径），不再经本地时区转 UTC ISO |
| fix | prd-admin | 普通用户搜不到人：成员/干系人/会议参会人三处面板弃用管理员 /api/users 预取，统一走 UserSearchSelect 的 directory 搜索（仅需登录）；组件新增 onSelectUser 回传用户对象供记录姓名快照 |
| fix | prd-admin | 知识库编辑/预览区铺满高度（KnowledgePanel 内层 wrapper 补 flex 容器，DocBrowser flex-1 生效） |
| feat | prd-admin | 知识库阅读区「全屏」按钮（原生 Fullscreen API，ESC 退出，MD/HTML 通用） |
| feat | prd-admin | 双击重命名改为行内编辑（原地 input，Enter 保存/Esc 取消/失焦保存），不再弹框；右键菜单弹框保留 |
| feat | prd-admin | Markdown 富文本编辑：引入 @uiw/react-md-editor（懒加载独立 chunk），富文本（所见即所得）/源码双模式切换，源码模式保留 [[ 引用自动补全；HTML 等仍编辑源码 |
| feat | prd-admin | 目标三视图统一编辑：仪表盘卡片点击打开与画布同一个 GoalDetailDrawer，保存同源刷新，数据同步 |
| polish | prd-admin | 目标抽屉信息架构重排：「AI 拆细 / 加子目标」上移头部常驻可见，「删除目标」收进底部危险区，不再埋在正文中部 |
| feat | prd-api | 项目级「里程碑交付物类型」字典：PmProject.DeliverableTypes（更新端点整表替换，去空去重限 30），交付物 Type 放开为自由字符串 |
| feat | prd-admin | 里程碑详情页 /pm-agent/p/:projectId/milestone/:id：OKR（关联目标 + KR 完成度条）、验收标准 DoD 勾选/增删、名下任务直达任务详情、交付物管理（内置 + 项目自定义类型即时增删）、标题行内改/计划日/负责人/标记达成；抽屉头部加「详情页」入口 |
| polish | prd-admin | 「应用」改一级菜单，页标题「应用配置」；移除升级申请子标签 |
| chore | prd-admin | 新增产品管理智能体全量功能目录测试 Excel（163 条，对齐导入列格式） |
| feat | prd-admin | 产品列表卡片收藏与「收藏」筛选；搜索框加长并修复聚焦时外边框高亮 |
| test | prd-admin | productFavoriteStorage 单元测试 |
| polish | prd-admin | 产品管理跨产品图谱增加「全部产品」筛选，联动版本下拉仅显示所选产品版本 |
| fix | prd-admin | 移除产品管理侧栏标题上方错误渲染的全局搜索框 |
| feat | prd-admin | 产品内需求改为逐字段表格，并在主页面集中提供需求、功能、缺陷、版本历史数据导入 |
| feat | prd-admin | 产品管理设置新增应用管理员维护，仅应用管理员可见历史数据导入入口 |
| feat | prd-api | 新增产品管理应用管理员名单、跨产品版本列表及功能、缺陷、版本幂等导入接口 |
| feat | prd-admin | 按产品研发管理规范 V2.6 补齐功能新建表单和详情页的模块、类型、主需求、版本、规则与验收字段 |
| feat | prd-api | 扩展功能实体与接口，持久化并校验产品研发管理规范 V2.6 要求的功能字段 |
| feat | prd-api | 产品内需求/缺陷列表支持 mine 参数（负责人/处理人或处理人/上报人） |
| feat | prd-admin | 单产品需求/缺陷 tab 默认仅展示当前账号相关记录 |
| polish | prd-admin | 主页跨产品需求/缺陷文案明确为全部记录汇总 |
| feat | prd-api | ProductRelease 增加功能清单 FeatureManifest、继承上一正式版 API |
| feat | prd-admin | 功能 tab 按正式版本号展示清单；申领正式版本号改为详情页双标签 |
| feat | prd-admin | 新增 ReleaseWorkflowDetail（基础信息 + 功能清单，标注相对上版变更） |
| feat | prd-admin | 新建需求智能填充增强：回填需求来源/客户/父需求/关联功能，并支持语音输入 |
| feat | prd-api | 需求 AI 智能填充扩展提示词与字段解析（来源/客户/父需求/功能/版本 ID 匹配） |
| feat | prd-api | 需求 AI 填表增强：注入已有需求/功能/客户/版本目录并扩展 JSON 输出字段 |
| feat | prd-admin | 新增 applyRequirementAiFill 将 AI 结果映射到表单（来源/客户/父需求/关联功能） |
| fix | prd-admin | 新建需求表单隐藏「产品缺陷」勾选，创建时不写入该标记，转缺陷由成立后工作流处理 |
| feat | prd-admin | 新建需求页按 TAPD 布局重做（左描述右属性 + combobox 字段） |
| feat | prd-admin | 新建需求补需求来源下拉、客户名称历史搜索与 + 快速新建 |
| fix | prd-admin | 新建需求移除归属版本必填，创建后再在详情/关联关系维护 |
| fix | prd-admin | 客户名称快速新建 + 移入下拉弹窗顶栏右侧 |
| fix | prd-admin | 用户表单不再展示模板内部名「需求默认表单」，附件区统一标题「附件」 |
| fix | prd-admin | 新建需求附件移至右侧基本信息下方，左侧编辑器下不再展示 |
| fix | prd-admin | 新建需求表单全宽布局，右侧属性栏加宽减压 |
| fix | prd-admin | UserSearchSelect 改为单输入框 combobox，移除下拉内第二层搜索 |
| test | prd-admin | 新增 requirementCreateValidation 与 customerRecentStorage 单元测试 |
| fix | prd-admin | 新建需求关联功能改为非必填，RelationField 改用单层 combobox 输入 |
| feat | prd-admin | 流程模板状态配置改为表格式（颜色/名称/说明/起始/结束/删除确认） |
| fix | prd-admin | 状态定义区补回状态说明列并固定列宽，名称列不再挤占其他列 |
| feat | prd-api | WorkflowState 新增 Description 字段供状态说明存储 |
| refactor | prd-admin | 应用配置移除功能流转页，功能状态改读所属计划版本 |
| feat | prd-api | 需求工作流 7 状态补全状态说明种子文案（SeedRevision 7） |
| fix | prd-admin | 应用配置恢复功能标签（流转矩阵+状态定义），功能详情恢复 WorkflowBar |
| feat | prd-api | 新增产品批量导入 API（应用管理员，同名跳过） |
| feat | prd-admin | 产品列表新增导入产品（CSV/Excel）及 19 个应用初始模板 |
| fix | prd-admin | 修复产品导入 Excel 解析静默失败，新增一键加载初始模板与解析反馈 |
| feat | prd-api | 功能工作流「已取消」改为「已下架」并补全 5 状态说明种子（FeatureWorkflowRevision 1） |
| feat | prd-admin | 新增 featureWorkflowCatalog 兜底目录与已下架展示名 |
| fix | prd-admin | 需求列表表格改为全宽 table-fixed 列宽比例，操作列不再挤在页面左侧 |
| fix | prd-admin | 修复 CDS 构建失败：OverviewShell ??/|| 括号、VersionWorkflowTab Td、测试桩与死代码 |
| feat | prd-api | 新增 RequirementType 实体与 requirement-types CRUD，内置 5 类需求类型种子 |
| feat | prd-api | 需求 AI 智能填充按可配置类型定义识别 formData.需求类型 |
| feat | prd-admin | 新建/详情需求表单增加需求类型下拉 |
| feat | prd-admin | 设置页新增「需求类型」可视化管理（名称 + 定义 + 新建分类） |
| fix | prd-admin | 需求来源选项与需求类型解耦（来源改为客户反馈/内部规划等） |
| fix | prd-api | 修复 UpsertRequirementType 重复声明 dup 导致 CS0136 编译失败 |
| fix | prd-admin | RTF 需求导入图片按魔数校正 mime、去重上传，失败跳过并继续导入 |
| test | prd-admin | 补充 RTF 图片嗅探与失败占位清理单测 |
| fix | prd-admin | TAPD 批量导出 RTF 按 ID 行拆分为多条需求导入，预览与写入支持单文件多记录 |
| test | prd-admin | requirementRtfImport 增补多需求拆分用例 |
| feat | prd-api | 新增 TAPD 缺陷自动提报智能体后端预览流与确认提交接口 |
| feat | prd-admin | 新增 TAPD 缺陷自动提报百宝箱入口和草稿确认页面 |
| fix | prd-api | TAPD 缺陷短句描述自动补全前置条件、复现步骤、实际结果和预期结果 |
| fix | prd-admin | TAPD 缺陷自动提报改为页面直填 Cookie，不再依赖外部授权 |
| fix | prd-admin | TAPD 缺陷自动提报移除 add_bug_token 与 dsc_token 手动输入要求 |
| fix | prd-admin | TAPD 缺陷类型下拉改为逻辑错误、不符方案、功能遗漏、历史缺陷、产品缺陷 |
| docs | doc | 补充 TAPD 缺陷自动提报智能体权限、SRS 与 README 说明 |
| feat | prd-api | 需求/缺陷 ID 统一 TAPD 纯数字规则：导入保留 TAPD ID，新建在本产品最大 ID（含已导入）基础上 +1 |
| fix | prd-api | 缺陷导入写入 StructuredData「缺陷ID」、重导按 DefectNo 兜底匹配并同步 ProductExternalId |
| polish | prd-admin | 需求/缺陷列表与详情统一「ID」列；缺陷 xlsx 解析保留 TAPD 中文状态 |
| refactor | prd-api | 需求默认工作流对齐 TAPD 米多需求收集工作流（7 状态 + 流转矩阵 + 遗留状态迁移 + 导入映射） |
| refactor | prd-api | 流程定义增加 SeedRevision/IsUserCustomized：仅初始化写入 TAPD 种子，管理员保存后不再覆盖 |
| docs | prd-api | 新增 tapd-requirement-workflow.seed.json 作为 TAPD 工作流初始化 SSOT |
| fix | prd-api | 修正需求状态排序与 TAPD 一致：已上线/已拒绝在已排期之前（seed_revision=3） |
| refactor | prd-api | TapdRequirementWorkflow 重命名为 RequirementWorkflowCatalog：运行时 SSOT 为 MongoDB 流程定义，Catalog 仅种子/迁移 |
| refactor | prd-api | 流转/标签解析改为 workflowDef 优先，支持用户自定义状态；MapImportedStatusLabel 仅 import 路径 |
| docs | prd-api | requirement-workflow.seed.json 替代 tapd-requirement-workflow.seed.json（MAP 内置种子文档） |
| refactor | prd-admin | requirementWorkflowCatalog + utils：工作流 API 优先，内置目录仅兜底 |
| polish | prd-admin | 需求模块去外部品牌：RTF 导入/字段/列表/详情统一为 MAP 原生文案与命名 |
| refactor | prd-admin | tapdRtf* 重命名为 requirementRtfImport*；sourceSystem 新写入 rtf |
| test | prd-admin | requirementWorkflowUtils 单元测试 |
| test | prd-api | RequirementWorkflowCatalog 单元测试（31 边、短标签、workflowDef 优先解析） |
| polish | prd-api | 跨产品 overview/requirements 返回 stateLabel；存量状态 Key 幂等规范化迁移 |
| fix | prd-admin | 需求详情移除属性栏重复状态（state_N），顶部 WorkflowBar 用导入快照兜底展示中文状态 |
| feat | prd-api | Wave3：流转 AllowedRoles/RequiredFieldKeys 校验 + ProductWorkflowTransitionGuard |
| feat | prd-api | 流转到已上线默认限制 product_admin/owner；种子 revision 升至 5 |
| feat | prd-admin | WorkflowTransitionDialog 替代 window.prompt；WorkflowBar/看板按权限过滤 |
| feat | prd-admin | 设置页流转编辑支持角色多选与必填字段配置 |
| test | prd-api | ProductWorkflowTransitionGuard 单元测试 |
| test | prd-admin | workflowTransitionGuard 单元测试 |
| feat | prd-api | Wave4：已立项/已排期/已上线闸门 + 立项/上线通过自动流转需求状态 |
| feat | prd-api | 流转支持 versionIds/initiationId/releaseId；已排期种子必填归属版本 |
| feat | prd-admin | 流转弹窗支持选择立项单、上线单、归属版本 |
| test | prd-api | RequirementWorkflowTransitionGates 单元测试 |
| refactor | prd-admin | 流程模板从「设置」拆至主页「应用」菜单独立入口 |
| feat | prd-admin | 团队动态升级「团队脉搏」：新增顶部聚合面板（动作总量滚动数字 / 模块能量条 / 24h 活跃热力 / 成员排行），时间线按模块配色并折叠连续同类动作（×N 徽章） |
| feat | prd-admin | 团队动态新增隐私脱敏开关（默认开启）：动态标题与成员姓名打码，适合投屏与旁观场景，偏好本地记忆 |
| feat | prd-api | 团队动态新增聚合统计端点 GET /api/team-activity/stats（总量 / 环比上一窗 / 活跃成员 / 模块分布 / 成员排行 / 小时直方图），支撑脉搏面板 |
| polish | prd-admin | 团队脉搏产品化打磨：默认范围改「今天」、动作总量带环比趋势（较昨日/上周/上月）、模块图例与成员排行可点击下钻筛选、单模块时隐藏零信息量比例条 |
| style | prd-admin | 团队动态视觉对标业界（GitHub/GitLab/Linear）：时间线改 rail + 头像角标动作图标 + 吸顶日期头，活跃时段改平滑面积曲线，脉搏面板加分栏线与氛围光；标题恢复全文显示，匿名模式仅隐藏成员姓名 |
| style | prd-admin | 团队动态超宽屏排版修正：页面居中限宽 1240px 消除面板真空区与超长视线距离；视觉去「圆润饱满」——药丸统一小圆角、能量条/排行条细线化、撤掉径向柔光 |
| feat | prd-admin | 团队动态改控制台三栏布局：左栏成员统计（脉搏总量+环比+成员排行）、中栏时间线、右栏分类统计（模块分布/动作类型/活跃时段），两侧统计可点击下钻 |
| feat | prd-api | 团队动态 stats 端点新增动作类型分布聚合（Top 10，标签来自白名单注册表） |
| feat | prd-admin | 团队动态新增「行为洞察」视图：从沉默的行为信号聚合带证据的改进方向（频繁报错/等待过久/停留过久/秒退放弃/反复横跳），每条注明涉及人数、次数、位置与建议 |
| feat | prd-admin | 新增全局行为信号采集器 behaviorTracker：路由级可见停留与跳转批量上报，标签页隐藏不计时，登录后生效 |
| feat | prd-api | 新增 behavior_events 集合与 POST /api/behavior/events 批量采集端点；team-activity 新增 GET insights 聚合分析端点（API 日志 + 路由信号双数据源） |
| feat | prd-admin | 行为洞察处理闭环：洞察可「转为缺陷 / 确认待改 / 已修复 / 忽略」，忽略项指纹级持久化不再打扰，可一键恢复；转缺陷自动携带证据生成缺陷内容并关联展示 |
| feat | prd-api | 新增 behavior_insight_states 集合与 POST /api/team-activity/insights/state 端点；insights 查询按指纹挂载处理状态并默认过滤已忽略项 |
| style | prd-admin | 洞察面板视觉去 AI 感：单卡分隔行替代漂浮盒子、左缘信号色条、目标/指标走 mono 字体、琥珀色强调主操作；脉搏大数字改实色微光、排行条单色化 |
| feat | prd-admin | 行为洞察新增 AI 简报：一键流式生成面向产品负责人的洞察简报（SSE 打字效果 + 顶部模型可见），完成后可一键发布到知识库「行为洞察简报」存档 |
| feat | prd-api | 新增 GET /api/team-activity/insights/brief SSE 端点（ILlmGateway 流式 + LlmRequestContext + AppCallerRegistry 登记 insight-brief），洞察计算抽出 ComputeInsightsAsync 供查询与简报共用 |
| fix | prd-admin | AI 简报发布防重复：发布成功后按钮变「已发布」徽章，同日重复发布幂等更新同一篇文档而非新建；发布中禁用按钮 |
| fix | prd-api | AI 简报流式中断治理：SSE 每 10 秒心跳防代理空闲断连（写锁防交叉写入）、max_tokens 提至 8192、超时放宽 300s、done 事件带 complete 标记 |
| fix | prd-admin | AI 简报前端识别中断：未收到显式 done 即结束时提示「生成被中断」并提供重新生成，半截简报不允许发布 |
| fix | prd-admin | 评审修复（Bugbot）：环比零基线明示「全为新增」不再误标无动作；洞察视图明示「全部=近30天」口径；登出不再丢弃待传行为事件队列 |
| fix | prd-api | 评审修复（Codex）：AI 简报过滤已忽略洞察（与 insights 查询口径一致）；新增 team-activity.manage 写权限，洞察状态变更与只读查看权限分离 |
| feat | prd-api | 需求/功能/缺陷工作流统一为需求 7 状态；需求新增「转为缺陷」、缺陷新增「非产品缺陷」并联动创建对端记录 |
| feat | prd-api | 功能工作流对齐需求 7 状态并保留「已下架」；仅已上线可下架，下架后可重新打开 |
| feat | prd-admin | 同步工作流状态标签兜底与缺陷状态展示 |
| polish | prd-admin | 新建功能页布局对齐功能详情（属性/主需求分卡、补父功能） |
| refactor | prd-admin | 内部版本详情改为单列布局：属性字段表 + 需求/功能列表表格，移除动态区 |
| feat | prd-admin | 版本页仅保留正式版本与内部版本两个标签，两标签均支持 Excel/CSV 历史数据导入 |
| refactor | prd-admin | 移除跨产品版本「历史版本」tab 及单产品旧版版本折叠区 |
| feat | prd-admin | 网页托管团队空间：双击团队名/专题名/分类名就地重命名（Enter 保存、Esc 取消，按编辑权限门控） |
| feat | prd-api | 团队成员支持角色标签（如「前端组」），新增成员标签端点；网页托管分组支持受限可见性与按成员/标签授权规则，列表、单查、分组操作全链路按规则隔离 |
| feat | prd-admin | 团队管理面板支持给成员打角色标签；空间 owner 可对专题/分类设置访问权限（跟随空间/受限+授权规则），受限分组带锁标识 |
| refactor | prd-admin | 网页托管团队空间信息架构重组：横向分组 chips 改为左侧树形导航（全部/未分组/专题/分类，含计数、新建、改名、删除、权限入口），结构一目了然 |
| polish | prd-api | 网页托管页面教程第 11 步文案同步树形导航改版（锚点对账：webpages-folders 个人/团队空间各落一处） |
| polish | prd-admin | 团队空间交互打磨：新建/加入改行内输入（去浮层零跳动、支持名称创建或 INV- 邀请码加入）；团队/分组改名与成员标签增删全部乐观更新不闪刷；双击当前团队不再触发整页重载；标签删除按钮加大可点区域 |
| polish | prd-admin | 新建团队空间输入框占位改「输入团队空间名称」并加创建/加入按钮（Enter 同效）；成员角色标签支持双击就地改名（同名自动合并） |
| polish | prd-admin | 应用配置流转改为 TAPD 风格矩阵表，规则详情收入设置弹窗 |
| polish | prd-admin | 应用配置移除流程名称标题与输入（系统即单一工作流） |
| fix | prd-admin | 修复语雀版本 Excel 导入：空表头行误判、非定制项目映射、V/T 号为「-」跳过 |
| fix | prd-api | 总览版本列表补全 ProductRelease/ProductInitiation 集合映射，修复导入后列表空白 |
| fix | prd-api | 版本工作流导入：负责人写入 legacyData，列表按 CreatedBy 可见 |
| fix | prd-admin | 导入弹窗 created=0 时不关闭；表格展示历史负责人 |
| test | prd-admin | 补充语雀上线/立项导出格式解析单测 |

### 2026-06-11

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 补齐资源工作台 MongoDB find 命令、PostgreSQL schema 表树与数据库初始化入口 |
| fix | cds | 修复资源工作台读取未展开数据库环境变量导致 PostgreSQL 连接失败 |
| chore | doc | 熵清理：D1 重命名 1 个，D2 +2 index.yml，D3 +2 guide.list，D6 +5 manifest |
| fix | prd-admin | 修复版本页导入历史上线和历史立项弹窗被滚动容器裁剪、点击后无可见反馈的问题 |
| feat | prd-admin | 知识库详情页工具栏新增「关系图谱」按钮（Obsidian 同款入口），点击进入宇宙图 |
| fix | prd-admin | 宇宙图「返回」按钮修正，凭 sessionStorage 回到原知识库详情而非空白列表页 |
| polish | peer-sync | 系统互联添加对端页改为居中工作台布局，弱化纯黑面板，连接串空状态改为紧凑操作区 |
| fix | peer-sync | 连接串有效期调整为 3 天，仍保持使用一次后失效 |
| feat | prd-admin | 项目管理智能体全屏改版：两层信息架构（工作台层左侧一级导航 + 项目层独立全屏路由，项目内 9 大模块迁移到项目层左侧导航，URL 持久化） |
| feat | prd-admin | 项目管理智能体新增首页 AI 工作台：70% 跨项目 AI 助手（SSE 流式 + 对话创建项目/目标/里程碑/任务）+ 30% 我的待办 / 可配置便捷操作 |
| feat | prd-admin | 项目管理智能体新增一级「报表」页：跨项目执行数据（生命周期/任务/里程碑/风险四区，纯 CSS 可视化） |
| feat | prd-api | PmAgentController 新增首页工作台端点：POST /api/pm/assistant/ask（SSE 动作协议）、GET /api/pm/my-todos、GET /api/pm/reports/summary、便捷操作偏好读写；AppCallerRegistry 注册 pm-agent.assistant::chat |
| refactor | prd-admin | 抽取 AgentFullscreenLayout 与 agent-cards.css 为跨智能体共享件（product-agent 原文件转发兼容），项目卡片对齐 pa-card 动效（蓝色强调） |
| polish | prd-admin | 项目头部精简：AI 健康诊断 / AI 结案报告 / 结案评价收进「更多操作」下拉，层次更清晰 |
| feat | prd-admin | 项目管理/产品管理智能体 AI 助手输入框左下角支持上传附件作为上下文（md / pdf），可基于文档内容分析与批量创建（共享 AssistantAttachments 组件） |
| feat | prd-api | 新增 AI 助手附件解析端点 POST /api/pm/assistant/attachments 与 /api/product/assistant/attachments（PdfPig 提取纯文本，无状态不落库），ask 请求支持 attachments 回传拼接上下文 |
| feat | prd-admin | 产品管理智能体工作台改版：AI助手内嵌主区（70%）+ 右栏我的待办/快捷操作（30%），移除右上角抽屉入口 |
| feat | prd-admin | 工作台新增「快捷操作」卡片：注册表模式收录 13 个系统操作，支持勾选/排序配置，默认创建需求/创建缺陷 |
| feat | prd-api | 新增产品管理智能体用户偏好端点（GET /api/product/preferences、PUT /api/product/preferences/quick-actions），配置用户级跨产品共用 |
| refactor | prd-admin | 工作台数据展示区（KPI/需求分级/缺陷状态/版本生命周期）并入报表 tab，报表重构为 KPI/进度/分布/版本四分区并去重 |
| refactor | prd-api | 产品 analytics 接口扩展返回 counts 与需求分级/缺陷状态/版本生命周期分布，前端不再拉列表自算 |
| polish | prd-admin | AI助手输入框增高为 Codex 桌面端风格大输入框（3 行起步 + 框内操作行），新增浏览器语音输入（Web Speech API，不支持自动隐藏） |
| polish | prd-admin | 工作台右栏「我的待办 / 快捷操作」按 7:3 固定分高，各自内部滚动 |
| feat | prd-api | AI助手具备创建能力：对话中可直接创建需求/功能/缺陷（动作指令随流尾解析执行，创建逻辑与 REST 端点对齐），SSE 新增 action 事件 |
| feat | prd-admin | AI助手对话内渲染创建结果卡片（编号+标题，点击直达详情页，失败显示原因），空状态提示创建用法 |
| fix | prd-admin | AI助手输入框聚焦不再出现全局紫色 focus 环；语音聆听中发送后静默取消识别，输入框不再残留已发送文本 |
| feat | prd-admin | 需求支持批量导入 TAPD RTF 并还原字段、正文、图片与评论 |
| feat | prd-api | 需求模型保留 TAPD 来源快照并支持按外部 ID 幂等导入 |
| feat | prd-api | 新增团队动态功能：全局白名单审计过滤器（ActivityLogActionFilter）自动留痕知识库/缺陷/周报/视觉/文学/网页托管 6 模块的关键写操作，新集合 activity_logs，新端点 /api/team-activity/logs + modules，新权限 team-activity.read |
| feat | prd-admin | 新增「团队动态」管理页（/team-activity）：按天分组时间线流，头像 + 「谁 在 哪个模块 做了什么《对象标题》」+ 相对时间，支持按成员/模块/时间范围筛选与加载更多 |
| test | prd-api | 新增 ActivityActionRegistryGuardTests：白名单 Controller.Action 复合键与真实 Controller 反射比对，防重命名后动态静默断流 |
| fix | prd-admin | 教程抽屉自动弹出严格按页:删除"定向推送(isTargeted)自动弹+切全部教程"旧路径,改为仅本页存在未学会的更新教程时自动展开本页列表,无教程页面不再弹窗 |
| fix | prd-api | daily-tips /visible 的 isTargeted 与置顶排序不再把 Track 统计埋点产生的 Delivery 记录误判为"被推送",根治普通教程被污染成"为你推送"后到处自动弹窗 |
| feat | prd-admin | 多步教程气泡新增「我已学会」一键退出口（标记学会该页不再自动弹），给觉得弹窗烦的用户无需走完整套即可退出 |
| feat | prd-admin | 教程关闭飞回入口动画扩展到所有关闭路径（X/点空白/ESC/我已学会/完成），并放慢一倍（720ms→1440ms）解决「看不见」 |
| feat | prd-admin | 新增「轻微提醒更新」(*-update-reminder) 第三类自动弹出：进页以单步悬浮气泡轻提醒新功能，看过即永不再弹 |
| feat | prd-api | 新增 visual-agent-paste-update-reminder seed（视觉创作首页可粘贴图片提醒），并把视觉创作 page-guide 第 4 步同步补充粘贴/拖入说明 |
| fix | prd-admin | 轻微提醒更新：同 session 内本页 page-guide 刚走完不再紧跟弹 reminder（避免重复打断），并占当天自动弹额度防抽屉在气泡上层展开 |
| fix | prd-admin | 单步教程 5s 自动淡出 / autoClick 完成的关闭也走飞回动画，与手动关闭口径一致 |
| fix | prd-admin | 轻微提醒更新只在精确目标页且锚点存在时才弹/标记学会，避免在编辑器子路由(/visual-agent/:id)弹空目标并永久消费 |
| fix | prd-admin | 视觉创作首页拖拽：移入内部子元素(textarea等)不再误清拖拽高亮，消除提示蒙层闪烁 |
| fix | prd-admin | markLearned 对非 page-guide 也记乐观学会版本，避免标记落库失败后陈旧刷新把 reminder 恢复成未学会、与 session 锁不一致 |
| fix | prd-admin | 轻微提醒更新去掉锚点 DOM 预检(懒加载页首跑锚点未挂会导致永不自动弹)，只保留精确路由门，锚点就绪交 SpotlightOverlay 轮询兜底 |
| fix | prd-admin | 抽屉自动展开的 reminder 抑制守卫加精确路由判断，避免子路由(/visual-agent/:id)上不会弹的 reminder 误抑制周更新抽屉 |
| fix | prd-api | 新增跨产品 overview/releases 与 overview/initiations 列表接口 |
| fix | prd-admin | 主页版本 tab 分正式/立项/历史三栏，行点击进三标签详情 |
| fix | prd-admin | 历史版本详情改为基础信息/需求/功能三标签 |
| fix | prd-admin | 正式版本列表整行可点进详情；路由注册顺序修正 |
| feat | prd-api | 新增 GET /api/product/initiations/{id} 立项详情接口 |
| feat | prd-admin | 内部版本立项详情页：基础信息 / 需求 / 功能三标签，列表可点击进入 |
| feat | prd-admin | 正式版本详情扩展为「基础信息 / 需求 / 功能」三标签，需求可跳转对象详情 |
| feat | prd-admin | 视觉创作首页输入框支持直接粘贴（Ctrl/Cmd+V）和拖入剪贴板/本地图片作为参考图，与编辑器画板交互对齐 |
| feat | prd-admin | 网页托管一级导航改为「个人空间 / 团队空间」两级结构，团队以标签平铺展示 |
| feat | prd-api | 网页托管密码分享链支持团队成员免密访问（外部访客仍需密码） |
| feat | prd-api | 网页托管团队空间新增「专题/日常分类」分组实体（web_page_groups）与站点归组、复制进团队端点 |
| feat | prd-admin | 网页托管团队空间支持创建专题/分类、按分组筛选、批量移入分组、从个人空间物理复制网页进团队 |
| feat | prd-api | 知识库/网页托管团队作用域支持不传 teamId 的跨团队聚合查询 |
| feat | prd-admin | 知识库团队空间改版：团队下拉框改标签平铺、默认「全部」聚合，并展示团队共享的网页托管站点 |
| fix | prd-admin | 团队空间卡片分节改按专题/分类切分（修正误显示文件夹「未分类」），分组开关文案随空间切换 |
| polish | prd-admin | 分享页密码屏增加「团队成员？登录后可免密访问」入口与已登录非成员提示 |
| fix | prd-api | 网页托管分享数字短链改为按需懒分配，默认创建只发不可枚举的 /s/wp/{token} 长链，不再无脑写入 short_links 集合 |
| feat | prd-api | 新增 POST /api/web-pages/shares/{shareId}/short-link 端点，支持事后为已存在分享按需生成数字短链（幂等） |
| fix | prd-admin | 分享管理面板主链接/复制/预览默认走字母长链，修复「用户没选数字短链却总拿到 /s/{seq} 数字链」问题；数字短链改为单独「生成/复制」按钮主动获取 |
| feat | prd-api | 知识库新增双链 + 反向链接基础设施（mentions 通用账本 + WikiLinkParser + MentionService + MentionsController） |
| feat | prd-api | 文档保存时自动解析 [[xxx]] 写入 mentions；删除时级联清理 |
| feat | prd-admin | MarkdownViewer 渲染 [[xxx]] 为可点击蓝链；DocBrowser 新增 contentFooter 插槽 |
| feat | prd-admin | DocumentStorePage 文档底部展示反向链接面板（被引用 + 出链），点击跳转 |
| feat | prd-admin | 新增「知识宇宙图」页面（Obsidian Graph View 风格），力导向布局 + Filters/Groups/Display/Forces 设置面板 |
| feat | prd-admin | navRegistry 注册 /document-store/:storeId/universe 路由（wip 标记，待验收后转正式） |
| feat | prd-admin | 编辑器双链自动补全：输入 `[[` 或 `@` 弹下拉框，上下键选 + Enter 确认 + Esc/Tab 取消 |
| feat | prd-admin | 双链悬停预览卡：鼠标停在 `[[xxx]]` 上浮出标题 + 摘要；目标不存在时变橙色虚线 + 提示「文档不存在」 |
| feat | prd-admin | 新增 `lib/wikilinkCache.ts` 客户端缓存（标题 → 条目摘要）；DocumentStorePage 在 entries 变化时同步喂 |
| test | prd-api | 新增 WikiLinkParserTests（13 个场景：空输入/单链/带别名/多链/中文/嵌套/换行/上下文/去重防御等） |
| docs | doc | 数据字典补 `mentions` 集合段；`.claude/rules/codebase-snapshot.md` 集合数 118→119 + 引用网络功能进"已完成"清单 |

### 2026-06-10

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | skills | 验收技能新增「证据链连线」硬门禁（standard §3.6 + archive_report.py 准入第 8 项）：pass 用例必须连图、IMG 引用必须在 manifest、禁止「文字记录」充当证据；SKILL.md 强制全量读图核对 |
| fix | skills | verify-open 死页判定改为仅在内容未渲染时生效（全文扫词会误杀正文合法含「不存在/已失效」的报告），关键词改用完整短语 |
| feat | cds | 新增数据库初始化自动识别、推荐与部署后执行流程，支持 Prisma、Drizzle、TypeORM、Sequelize、Django、Alembic、Rails 与 schema.sql/init.sql，并在数据库服务卡片提供导入 SQL、重新初始化和手动迁移命令兜底入口 |
feat(cds): add SSH release control plane MVP

- Add ReleaseTarget, ReleasePlan, ReleaseRun and ReleaseArtifact state models.
- Add `/api/releases/*` APIs for SSH targets, preflight checks, release logs, release runs and rollback.
- Add release center UI and branch-card release entry for running preview branches.
| fix | prd-api | 更新中心 GitHub 提交总数改为仓库全历史总数（本地 git rev-list --count，浅克隆时用 GitHub API Link header 反推兜底），不再把「最近一周条数」当总数展示 |
| feat | prd-admin | 更新中心 GitHub 提交列表按自然周分组展示（本周/上周语义化标签 + 日期范围），chip 与说明文案区分「仓库总提交」与「近一周条数」 |
| feat | prd-api | 彩蛋：GitHub 提交作者名与系统用户名自动匹配（忽略大小写、去数字与分隔符、容忍姓名前后颠倒），命中时返回系统用户显示名 |
| feat | prd-admin | GitHub 提交行作者展示合并为单 chip：命中系统用户时直接显示系统名（GitHub 原名进 tooltip），不再单列两个名字 |
| feat | prd-api | 识别 commit message 的 Co-authored-by 联合作者（本地 git trailers + GitHub API 双路径），每位联合作者同样做系统用户匹配 |
| feat | prd-api | 用户名匹配支持剥离团队通用组织后缀（如 yurenping-miduo 匹配 yurenping） |
| feat | prd-admin | 更新中心面板动态化：统计数字滚动、新提交到达扫光、同步状态呼吸点、AI 总结按钮流光 |
| feat | prd-admin | 筛选标签 Telegram 式热度角标：常驻类型彩色 + 右上角近 30 天条目数徽章，最热标签火焰角标 + 流光描边 + 呼吸光晕，点击迸发同色粒子 |
| polish | prd-admin | 热度视觉收敛：火焰并入最热标签徽章（修复与相邻角标遮挡）、去掉 chip 整体呼吸/流光只保留火花跳动、口径提示「近 30 天热度」弱化挪至筛选行尾 |
| feat | prd-api | 商品溯源智能体：新增「排查清单」（内置防窜模板 + 自定义 CRUD，channel_trace_checklists 集合） |
| feat | prd-api | 商品溯源智能体：诊断会话一键沉淀为缺陷（复用缺陷 Agent DefectReport，草稿态） |
| feat | prd-api | 商品溯源智能体：诊断会话导出 Markdown 证据包（问答 + 召回案例 + 命中代码） |
| feat | prd-api | 商品溯源智能体：业务知识问答 / 对话诊断支持粘贴页面 HTML/文本上下文（去标签转纯文本） |
| perf | prd-api | 商品溯源智能体：案例检索改用词重合排序 + 子串兜底，召回更全（替代纯正则 OR） |
| feat | prd-admin | 商品溯源智能体：新增「排查清单」Tab（模板/自定义、逐项勾选进度、另存为我的清单） |
| feat | prd-admin | 商品溯源智能体：问题排查界面新增「导出证据包」「沉淀为缺陷」按钮 + 粘贴上下文输入 |
| feat | prd-admin | 商品溯源智能体：业务知识问答新增「粘贴页面 HTML/文本」输入 |
| chore | doc | 熵清理：D2 index.yml +3 条，D3 guide.list +2 条，D6 manifest +5 条 |
| fix | prd-admin | vite build 关 sourcemap、esbuild minify 降低 CDS static 部署 OOM 风险 |
| fix | cds-compose | admin 构建增加 NODE_OPTIONS=--max-old-space-size=4096 |
| fix | prd-admin | CDS 构建检测 VITE_BUILD_ID：关 minify、限 rollup 并行；新增 cds-vite-build.sh |
| fix | cds-compose | admin 默认改 dev(Vite HMR) 秒级就绪；static 走 scripts/cds-vite-build.sh |
| feat | prd-admin | 前端搭档智能体页面精简布局：右侧 PDA/项目表弹窗入口、标题文案与流式动效 |
| feat | prd-admin | 截图视觉诊断支持 Ctrl+V 粘贴截图、预览与上传，随请求发送 Vision 识图 |
| feat | prd-admin | 粒子宇宙凄凉背景（星尘/流星/冷色星云）+ 按钮手型悬停抬起与按下反馈 |
| feat | prd-admin | 怀旧星夜视觉：暖色标题/胶片颗粒/扫描线、密集流星与暖色玻璃面板 |
| refactor | prd-admin | 前端搭档视觉对齐视觉创作智能体：夜景+粒子漩涡、全息标题、靛紫玻璃面板 |
| refactor | prd-admin | 抽取共享 NightSkyBackground 组件供视觉/前端搭档复用 |
| fix | prd-admin | 目标技术栈默认改为 Vue3 + UniApp 小程序 |
| feat | prd-api | 前端搭档智能体截图诊断接入 Vision 多模态，注册 front-end-agent.assistant::vision |
| fix | .claude/skills/cds | cdscli preview-url 本地推算优先 git remote 仓库名，修复 Cloud Agent workspace 目录拼错预览域 |
| fix | prd-api | 修复 CDS Agent 会话事件按 payload 内容判重导致重复 delta token 被丢弃（Agent 引擎生成 PPT 全文乱码的根因），改为按 CDS seq 水位线去重并随轮询增量拉取 |
| feat | prd-admin | MD 转 PPT 生成/精修全程流式可视化：等待面板实时滚动展示 AI 正在输出的 HTML 与已接收字符数，不再静止转圈干等 |
| fix | prd-admin | 风格语义纠偏：删除前端 !important CSS 换皮覆盖层，风格是 AI 生成时参照的设计语言；生成后切换风格改为 AI 参照新风格整体重绘 |
| fix | prd-api | MD 转 PPT patch 接口支持 theme 字段，换风格重绘按对应风格系统提示词执行 |
| refactor | prd-api | MD 转 PPT 移除 MAP 直出引擎与模型列表接口，convert/patch 全部走 CDS Agent 会话；Agent 路径补发 model 事件（模型可见性） |
| refactor | prd-admin | MD 转 PPT 删除引擎/模型选择 UI（含 ModelChipPopover），模型名改为只读 chip 回显 |
| feat | prd-admin | 生成等待面板重设计：幻灯页进度卡逐张点亮（解析流式 HTML 的 section 与页标题）+ 总进度条 + 阶段文案 + 代码流尾巴，消除空等体感 |
| feat | prd-admin | 生成等待主视觉升级为实况渲染（对标 Gamma）：每页 HTML 流式闭合后立即在 iframe 真实渲染成幻灯页，默认跟随最新完成页，底部页卡可点击回看；首页出现前用骨架幻灯过渡 |
| feat | prd-api | 新增 /api/md-to-ppt/prewarm：大纲确认期间预创建并启动 CDS Agent 会话，convert 自动复用，把 5-15s 环境启动开销藏进用户阅读大纲的时间 |
| feat | prd-admin | 大纲生成成功后静默预热 Agent 会话（fire-and-forget，失败不打扰用户） |
| feat | prd-api | MD 转 PPT 透传推理模型 thinking 事件到 SSE（deepseek-v3.2 实测思考占总耗时 90%，思考期必须有内容可看） |
| feat | prd-admin | 等待面板新增 AI 思考过程实时流（思考期主视觉），状态行显示已思考字数 |
| feat | prd-admin | 百宝箱「MD 转网页 PPT」摘除 wip 标记（预览环境真人路径验收通过：8 页 deck 生成/渲染/翻页全链路跑通） |
| fix | claude-sdk-sidecar | 修复假流式根因：官方 SDK 路径开启 include_partial_messages，token 级 text_delta/thinking_delta 实时产出（此前正文等整条消息生成完一次性爆发），完整消息块去重防正文双倍 |
| feat | prd-admin | MD 转 PPT 历史生成：右上「历史」入口列出过往 runs，点击载入旧 deck 继续精修/编辑/换模板/发布 |
| feat | prd-api | MD 转 PPT 自定义模板：上传参考图由视觉模型提取风格规范（配色/字体/版式），生成与重绘时作为 AI 设计参照；模板 CRUD 接口 + md_to_ppt_templates 集合 |
| feat | prd-admin | 右侧空状态改为模板画廊：官方 5 套大卡片迷你预览 + 自定义模板卡片 + 上传参考图新建，模板不再藏在设置里；工具栏色点扩展自定义模板，「风格」统一更名「模板」 |
| feat | prd-admin | 知识库引用升级大模态：库列表 → 文档列表 → 内容预览 → 确认引用，不再盲选 |
| feat | prd-admin | 思考流移入对话气泡（对话归对话，中间只放 PPT 预览）；输入框聚焦整圈高亮（边框+光环）；左侧对话栏宽度可拖拽（280-640px，localStorage 记忆） |
| fix | prd-admin | 输入框聚焦内圈浏览器默认 outline 残留清除（只留外壳整圈高亮）；知识库预览复用全站 MarkdownContent 渲染（不再裸文本） |
| fix | prd-admin | 调整大纲不再按文本长度重估页数（沿用上一版页数，除非用户明确要求增减）；生成等待的「Agent 环境准备」移入对话气泡，预览区只留产物 |
| fix | prd-admin | 编辑模式可编辑范围扩展 .stat/.stat-l/.lead/.eyebrow/.chip/.quote（大数字等 div 文本块此前点不中） |
| feat | prd-admin | 大纲右侧编辑器：大纲生成后在右侧大空间逐页编辑（标题/要点/增删页/上下移），即改即存且刷新恢复（outline-ready 状态持久化）；头部常驻「确认生成」，底部「让 AI 调整」输入 |
| feat | prd-api | 大纲接口扩展澄清问卷：需求确有歧义时模型返回最多 3 题（单选/多选/填空），无歧义不出题 |
| feat | prd-admin | 澄清问卷卡（opendesign 式）：右侧填写 → 保存并发送给 AI 重排大纲，可跳过；对话输入在大纲阶段直接路由为 AI 调整大纲 |
| feat | prd-admin | 大纲编辑器页卡改网格布局（一排 3-4 个自适应列宽，「添加一页」为网格末位虚线卡） |
| feat | skills | 验收标准 v2.5 两条硬门禁：报告必含「验收地址」段（标的物深链+分支+commit，与报告同域名）；证据必须步骤式（>=3 个「## 步骤 N」逐段配图，集中 EVIDENCE 在证据板渲染为空）——archive_report.py 机检同步 |
| fix | prd-api | 澄清问卷出题阈值微调：未指明受众/正式程度且显著影响内容时应出 1-2 题（需求明确时仍禁止出题） |
| feat | prd-admin | 大纲规划等待改产物形状动画（3:4 骨架卡逐张脉冲浮现，替代居中转圈）；页卡改 3:4 竖卡比例 |
| feat | prd-admin | 大纲卡拖拽换位（替代上下按钮），换位区间序号 1.6s 紫色渐变高亮——变化必须被看见 |
| fix | prd-admin | AI 调整大纲时编辑器保持在场（内联蒙层+状态条），不再切全屏规划态造成"大纲全消失"错觉；调整返回后仅改动页渐变高亮 |
| fix | prd-api | 调整任务硬约束：未被调整要求点名的页 title/bullets 逐字原样保留（修"定向修改结果全文案被重写"） |
| feat | rules | 新增 miduo-review-lens.md：用户审查习惯六镜头（等待产物感/比例美感/交互成本/变化可感知/AI最小惊讶/证据闭环），交付前强制自查 |
| feat | prd-api | 并行逐页生成编排（用户架构提案落地）：大纲定稿 → deck 壳子确定（设计系统 head）→ 4 路子智能体并行各画一页 → 每页完成即推 page 事件 → 服务端拼装；frame/page 新 SSE 事件 |
| feat | prd-api | 逐页提示词反「套模板」：组件类降级为可选工具箱，每页给版式自由 + 相邻页差异化指令 + 版式轮换建议 |
| feat | prd-admin | 等待面板 pages 模式：页卡按真实完成并行点亮（可点已亮页卡先看该页实况渲染），进度 X/Y 页为服务端真实进度——不再依赖 token 流，绕开 sidecar 假流式 |
| fix | prd-admin | 刷新恢复对账：run 完成/失败时翻转聊天里残留的「正在生成」气泡（修"图片返回了还显示生成中"）；等待计时改用服务端 run.createdAt 基准（修刷新后计时归零） |
| fix | prd-api | 大纲提示词加厚：每页 3-5 条要点、每条 12-30 字带具体落点，禁止空壳短语（修"大纲内容太少"） |
| feat | prd-api | 官方模板扩容至 10 套：新增极光渐变 / 日落炽橙 / 森林有机 / 鎏金深紫 / 海洋玻璃（参照 Gamma 系风格族谱），每套含完整设计 token 与气质描述 |
| feat | prd-admin | 模板画廊卡升级：真渐变/格纸纹理迷你幻灯预览 + 主题字体示例标题 + 角标数据 + 一句话气质描述（替代原始的"Aa 标题示意"色块条） |
| refactor | prd-admin | 删除头部「设置」收起面板（模板 chips 与画廊重复）：生成前选模板唯一入口为右侧画廊，生成后切换走预览工具栏色点 |
| docs | doc | plan.md-to-ppt-next-wave 新增 §9 用户模板共享走海鲜市场（IForkable + CONFIG_TYPE_REGISTRY 方案）与 §10 官方模板扩容节奏清单 |
| fix | prd-api | P0 修复并行逐页生成的页面黑屏：section 根元素 inline display/min-height:100vh 覆盖 reveal 隐藏规则导致当前页被推出视口；新增 SanitizeSection 消毒（布局样式挪入 pp-root 包裹层、尺寸定位属性剥离、vh 单位替换）+ 5 条回归测试 |
| feat | prd-api | deck 壳子注入溢出自适应守卫脚本：内容高于 700px 设计框时对 pp-root 等比缩小（兜底） |
| fix | prd-api | 逐页提示词版面硬约束：禁止 vh/vw、根元素禁止 style、内容预算（要点不超过 5 条）、横向时间线最多 4 项且每项 min-width 170px（修文字逐字竖排挤压） |
| feat | prd-api | 新增 GET /api/md-to-ppt/profiles + convert/patch/prewarm 支持 runtimeProfileId：用户在 PPT 页随时切换生成模型（与基础设施运行配置同数据源）；预热会话与所选模型不匹配时弃用重建 |
| feat | prd-admin | 输入框旁新增模型 chip + 切换弹层：任何时候可换模型，选择持久化并随生成/精修/预热下发 |
| feat | prd-admin | 生成期底部页卡升级为真实缩略图（完成页用同一设计系统迷你渲染，一眼看到每页效果），未完成页骨架占位 |
| feat | prd-admin | 并行生成全程对话同步：壳子确定/每页完成/最终汇总都更新聊天气泡（左侧保持主力语言交互，不再静默） |
| feat | prd-admin | 预览工具栏新增「重绘本页」：定向只重绘当前页（修复溢出/挤压排版），内容逐字保留其余页不动 |
| feat | prd-admin | 生成后切换模板改为先确认再重绘（确认条说明耗时与影响），杜绝误触模板色点白白触发 1 分钟整体重绘 |
| fix | prd-admin | 模型切换弹层补点击外部关闭（fixed 背板），不再只能点 chip 收起 |
| feat | prd-api | 定向单页 patch：SlideIndex 命中时只把目标页交给单个子智能体重画并原位替换（页级提示词+消毒+心跳），不再整篇 58KB 重出（旧路径实测 7 分钟未完成）；失败回落整篇路径 |
| fix | prd-api | 标签碎片守卫：上游偶发丢字符（deepseek/OpenRouter 实测 finalText 缺 26 个 "<"）导致标签当正文渲染——ExtractSection 检测损坏自动走重试/兜底链路 + 3 条回归测试 |
| fix | prd-admin | 输入框底部工具行视觉修整：快捷键提示挪进 placeholder/按钮 title（原被模型 chip 挤成两行折叠）；模型 chip 只显示短名（vendor 前缀去掉，全名在 tooltip） |
| feat | prd-api | 官方模板 +2 套（借鉴 open-design.ai 招牌设计系统）：工坊拼贴 Atelier Zero（暖纸/珊瑚单热点/Inter 800 混 Playfair Italic/罗马数字章节/mono 微注）与 Kami 纸墨（羊皮纸/墨蓝 ≤5%/衬线单字重 500 禁粗禁斜/四级暖灰/实色 tag） |
| feat | prd-admin | 模板画廊新增工坊拼贴 / Kami 纸墨两张卡（官方共 12 套），迷你预览含纸面径向晕影与衬线示例标题 |
| feat | prd-admin | 基础设施服务页模型运行配置补全 CRUD 接线：卡片新增 编辑/设为默认/测试连通/两击确认删除（后端 PUT/DELETE/test 早已就绪，此前 UI 只读改不了）；表单区分新增/修改模式（编辑留空 key 沿用原 key）；新增「从模型管理导入」一键建配置 |
| feat | prd-admin | /infra-services 支持 ?tab=config 深链直达配置 tab；失效连接默认折叠（12 条尸体卡不再占满首屏）；PPT 模型弹层只有一条配置时给出去基础设施新增的引导链 |
| fix | prd-admin | 基础设施操作台整段上移到页面第二屏（原埋在测试台/架构介绍下第四屏，用户两次找不到模型配置）；「配置」tab 排第一并设为默认——进页即见模型运行配置 |
| feat | prd-api | 模型池直选（用户提案落地）：GET /api/md-to-ppt/pool-models 列出启用池模型 + POST profiles/from-pool 一键物化为运行配置（幂等复用平台 baseUrl/key，零手填）；无池调度概念——选中哪个就把哪个的配置原样传给 CDS，由 CDS 自行发请求 |
| feat | prd-admin | PPT 模型弹层新增「从模型池直选」组：搜索模型/平台、点选即自动建配置并选中、已物化标「已就绪」；不再要求用户去基础设施页手抄 baseUrl/key |
| feat | prd-api | InfraAgentRuntimeProfileService 新增 ImportFromPoolAsync：任选池内模型物化为运行配置（协议/runtime 自动推断、key 加密存储、不抢默认位） |
| feat | prd-api | 流式逐页大纲 POST /api/md-to-ppt/outline-stream：模型按 JSONL 输出（首行 meta 含整体配色/排字/气质，随后每页一行含 design 设计意图），服务端逐行解析每成功一页立刻推 SSE——第一页几秒内可见；兜底整 JSON 解析 |
| feat | prd-api | 页级 design 字段贯通：大纲设计意图（版式/视觉装置/排字/强调）随 OutlinePages 直接喂给并行子智能体的页级提示词（设计闭环非摆设） |
| feat | prd-admin | 大纲编辑器流式化：meta 到达即出编辑器骨架（脉冲占位卡），每页到达填充真卡并渐变高亮；卡片新增可编辑设计意图行；流式中确认禁用、序列化大纲带设计行 |
| feat | cds | Agent 请求观测台（用户信任诉求落地）：新页 /agent-requests/:projectId——一条条请求实时列表（title/clientApp/clientUser/model/状态/耗时/事件数 + 收发内容预览）、按用户/应用/状态/关键字筛选、行展开看完整事件流；项目卡心电图按钮直达 |
| feat | cds | 会话打标 + 聚合端点：POST agent-sessions 接受 title/clientUser/clientApp；GET /projects/:id/agent-requests 合并 live 会话与持久历史（state 持久 ring buffer 500 条，重启后历史可查）；结构性事件发布 agent-session.activity 到全局 SSE 总线（text_delta 不发防洪水）+ 5 条路由测试 |
| feat | prd-api | MAP 创建 CDS 会话补传观测台标签：title/clientUser(userId)/clientApp；CreateInfraAgentSessionRequest 加 ClientApp，MdToPpt 全部会话标记 md-to-ppt |
| fix | prd-api | CDS 会话失联秒级对账：CDS 自更新/重启清空内存会话后，MAP 轮询撞 session_not_found 立即标记会话 failed + 落 error 事件（此前空转 4 分钟才超时）——页级重试随即重建新会话（两次真实事故根因：并行 agent 频繁 self-update 生产 CDS） |
| feat | prd-admin | 锚定 deck 前端适配：实况/缩略图改为完整单页 deck（prefix+active slide+suffix，模板自带运行时缩放居中）；iframe 控制协议双模式（reveal + zhangzara 方向键/active 类，MutationObserver 报页码）；编辑器序列化兼容无 reveal 结构 |
| fix | prd-admin | SSE 断线不再误报"生成失败"：error 前先对账 run 真实状态，活着转后台跟踪轮询到终态（修用户截图实锤的 network error 误报） |
| fix | prd-admin | 锚定 deck 页码桥 v2：active/is-active/current 类 + 视口中心 elementFromPoint 反查 + 800ms 兜底轮询（monochrome 等不打类标的运行时页码也跟手） |
| feat | prd-admin | 输入框大气化（用户点名）：composer 加高加圆角、聚焦上浮+饱满光环；页卡缩略图 hover 浮起投影（交互灵动） |
| fix | prd-admin | looksLikeDeck 识别锚定 deck（div.slide）：retro-zine 等 div 容器模板生成完被误判"结果异常"丢弃的问题 |
| fix | prd-api | 单页故障绝不杀整本：RunAgentOnceAsync 永不抛（传输异常折叠为页错误走重试/兜底）+ 并行任务体全链路兜底页（实测单页 HttpClient 100s 超时异常逃逸炸掉整个 deck） |
| fix | prd-admin | PPT 工作台修复加号菜单「引用知识库/添加文件」点不动：composer 卡 focus-within transform 创建 stacking context 导致 z-10 菜单被 z-5 关闭蒙层盖住，移除 translate 保留光环动效 |
| feat | prd-api | PPT 锚定模板新增 2 套暗色 deck（cyber-terminal/dark-graph，来自 open-design hermes/graphify）：Tech 极黑、极光渐变不再映射到浅色锚，提取器 v3 支持非 zhangzara 目录、is-active 修饰符、注释取版式名并为无运行时静态 deck 附加通用键盘导航 |
| fix | prd-api | 暗色锚定 deck 翻页失效修复：提取时剥掉模板自带 Static-preview fallback 样式块（强制所有 slide 可见），导航运行时类切换即可真实翻页 |
| fix | prd-api | 模型池直选凭据预检：pool-models 返回 available/unavailableReason，平台 key 缺失或解密失败的模型提前标记；from-pool 报错区分「未配 key」与「key 解密失败（环境加密密钥不匹配）」并给出修复指引 |
| fix | prd-admin | 模型池弹层把凭据预检不过的模型置灰显示原因，不再让用户点了才撞「缺少 API key」报错 |
| fix | cds | Jwt__Secret 注入改为项目环境变量优先、CDS 全局值仅兜底：根治换 CDS_JWT_SECRET 跨项目穿透打哑其他项目存量密文的联动事故 |
| feat | prd-api | 新增 PlatformKeyIntegrityWorker：启动及每 6 小时自检平台 API key 可解密性，发现环境密钥不匹配立即 LogError + 全局站内告警（幂等，恢复后自动关闭），杜绝密钥哑掉两小时无人知的静默故障 |
| chore | - | 删除过期验收驱动 e2e/lifecycle.mjs（写死旧分支 URL 的一次性脚本）；新增 .claude/rules/cross-project-isolation.md 跨项目隔离原则与共享通道清单 |
| chore | - | 合并 main（218 个提交）进开发分支：container.ts 环境构建采用 main 的 resolveProfileRuntimeEnv 重构并移植 Jwt 项目级优先修复，remote-hosts.ts 合并双方 import；CDS 1932 测试、API 943 测试、admin 419 测试全绿 |
| feat | prd-api | 平台密钥自愈端点 POST /api/mds/platforms/:id/restore-key-from-profile：密钥环境不匹配时从仍可解密的运行配置（DataProtection）服务端恢复平台 key 并用当前密钥重加密，明文不出进程、同 host 守卫防错配 |
| fix | prd-admin | 重绘单页不再冒充全部重绘：单页 patch 保持整份 deck 可见，仅顶部状态条提示「仅重绘第 N 页」，不再铺满 8 张等待骨架（后端本就只 splice 替换目标 section，是前端骨架误导） |
| fix | prd-admin | 大纲卡片由 3:4 竖比例改 1:1，减约 1/4 高度，消除内容只占一半的空白 |
| fix | prd-admin | 页码指示器改为视口可见度优先判定（cur），修复锚定 deck 末页仍显示 1/N 的问题（诉求 6） |
| fix | prd-admin | 编辑模式下锚定 deck 所有页平铺可滚动可编辑，不再只能编辑第一页（诉求 8） |
| feat | prd-admin | 全屏改为自定义演示模式，底部新增子页缩略条（点击跳页 + 方向键 + Esc 退出），不再只有单张全屏 PPT（诉求 9） |
| fix | prd-api | 锚定页提示词新增硬约束：内容不得压到页脚、视觉装置（图表/SVG/大数字）不得留空占位（诉求 4/7） |
| fix | prd-api | 兜底页不再裸奔：子智能体两次输出无效时，降级页继承版式范本的装饰块（网格/扫描线/背景 SVG）与页脚，仍穿设计系统的衣服 |
| polish | prd-admin | 演示模式缩略条加渲染微光占位，iframe 逐张渐进渲染期间不再是黑块 |
| fix | prd-admin | 刷新中断对账：大纲规划（客户端 SSE 无服务端 run）被刷新打断后，气泡不再永远停在「正在规划大纲」，挂载时翻转为可重试的中断提示 |
| fix | prd-api | dark-graph 锚定模板范本去 emoji（PR #799 Codex P1）：图标位 pictograph 全部替换为终端风等宽字符标记，全锚定资产 emoji 清零 |
| fix | - | AGENTS.md 修正 cdscli 路径（.Codex/skills 不存在，实际在 .claude/skills，Bugbot Medium）；cdscli 去重 _repo_name_from_git_ref 双定义并让 _fallback_project_slug 与 _project_slug_hints 共用同一优先序（Bugbot Medium/Low），pytest 125 绿 |
| security | cds | 只读 SQL Console 危险关键字检查扩到全部放行语句头：堵 PostgreSQL EXPLAIN ANALYZE UPDATE 绕过写权限门（PR #799 Codex P1，main 既有） |
| feat | prd-api,prd-admin | 大纲生成纳入服务器权威性（server-authority.md）：大纲也是一次 Run（op=outline），结果落库 OutlineJson，客户端刷新/断开后后台跑完仍可按 runId 取回，不再「刷新即丢」「永远转圈」 |
| fix | - | 验收技能 L0 档步骤式证据门禁按档位缩放（Bugbot Medium）：L0 轻量验收不再被「>=3 步骤」硬卡，下限=min(档位截图下限,3) |
| security | cds | MongoDB 只读 Console $where 正则修复（PR #799 Codex P2）：去掉前导 \b 边界（{/空格后永不成立），堵 db.find({$where:...}) 服务端 JS 谓词绕过 |
| fix | cds | 部署日志 entrypoint 空格警告字符串去 emoji（⚠ → [警告]，PR #799 Codex P1，铁律 §0） |
| chore | - | 清理仓库存量验收图片与废弃设计原型：删 doc/acceptance/（43 文件 1.7M 历史验收报告+截图，违反 doc/ 扁平+前缀规则）+ design-mockups/（7 文件 1.1M 零引用设计探索），共减约 2.8M/12 图；gitignore doc/acceptance/ 防本地验收产物再入库 |
| feat | prd-admin | MD转PPT 页位恢复：编辑保存/换主题/精修后 iframe 重载不再跳回第 1 页（ready 信号 + goto 回跳，借鉴 open-design） |
| feat | prd-admin | MD转PPT 圈选反馈：工具栏「圈选反馈」拖框圈选幻灯片区域 + 写要求，自动反查选区内元素文本组装成精修指令填入输入框（不自动发送） |
| feat | prd-admin | MD转PPT 编辑模式升级：悬浮工具条新增 6 色文字颜色、左中右对齐、撤销（最多 20 步）；序列化时清洗 reveal 运行时状态，产物更纯净 |
| feat | prd-admin | MD转PPT 工具栏模型 chip 可点击弹层切换（借鉴 open-design InlineModelSwitcher），免去翻设置面板 |
| feat | prd-admin | MD转PPT 生成完成后显示「下一步」引导条：精修建议 chip（填入输入框）+ 下载 HTML + 发布为网页 |
| fix | prd-admin | MD转PPT 页位恢复竞态修复：新 iframe 初始页码上报会清零实时跟踪 ref，改为重载触发时快照进 pendingRestoreRef，ready 按快照回跳 |
| fix | prd-admin | MD转PPT 编辑器样式写入改 setProperty important：修复主题覆盖层 !important 压住编辑颜色导致改色无效（验收 driver 实测捕获） |
| feat | prd-admin | MD转PPT 新增所见即所得编辑模式：点击幻灯片文字直接修改内容，悬浮工具条 A+/A- 调整字号，postMessage 同步回主应用，退出时自动保存 |
| feat | prd-admin | MD转PPT 预览工具栏新增页码指示（N / M）、5 主题快速切换色点（即时换肤）、下载独立 HTML、全屏演示按钮 |
| feat | prd-admin | MD转PPT 空状态新增 3 个快速开始示例（产品发布会/季度业务汇报/技术方案评审），点击一键填入输入框 |
| fix | prd-admin | MD转PPT 修复翻页按钮在沙箱 iframe（opaque origin）下完全失效的问题，翻页改走 postMessage 通道 |
| fix | prd-admin | MD转PPT 修复发布/下载的 HTML 不携带前端注入主题样式导致主题丢失的问题；发布标题改为取自 deck title |
| fix | prd-admin | MD转PPT 下载文件名清洗非法字符，下载 anchor 挂载 DOM 后触发（Firefox 兼容） |
| feat | prd-admin | MD转PPT 对话区布局改造（借鉴 open-design composer-shell）：左栏 288 加宽到 340px，输入区卡片化（无边框 textarea 自动增高 + 底部工具行 + 实底发送主按钮 + focus 高亮整卡），底部留白避开 CDS 预览挂件遮挡 |
| feat | prd-api | MD转PPT 新增 GET /api/md-to-ppt/models 端点（列出 chat 池可切换模型），Convert/Patch 支持 Model 参数经 ExpectedModel 传给 Gateway 调度 |
| feat | prd-admin | MD转PPT 设置面板新增模型选择器（仅直出引擎）：自动调度 / deepseek-v4-flash / deepseek-v4-pro 等 chat 池模型可切换 |
# 2026-06-10 系统互联 http→https 规范化

## 背景

对端连接串可能携带 `http://` baseUrl，但实际站点由 nginx 301 到 `https://`。系统互联的 `PeerSync` HttpClient 出于 SSRF 防护禁用了自动重定向，因此握手会把 301 当作失败。

## 变更

- 新增 `PeerSyncRedirectHelper`，只允许同 host、同 peer-sync 端点的 `http -> https` 重定向规范化。
- 新增配对握手遇到上述 301/302/307/308 时，显式重试 HTTPS，并在成功后存储规范化后的 HTTPS baseUrl。
- 配对后的连通测试、资源 push/pull 调用也支持同样的一次性规范化，并在成功后回写 HTTPS baseUrl。
- 仍不启用全局自动重定向；跨 host、跳到非 peer-sync 路径、携带 query/fragment 的重定向继续按失败处理。

## 验证

- `curl -X POST http://map.ebcone.net/api/peer-sync/handshake` 返回 301 到 `https://map.ebcone.net/api/peer-sync/handshake`。
- `curl -X POST https://map.ebcone.net/api/peer-sync/handshake` 可到达 peer-sync 端点，返回业务层 400。
- `dotnet build prd-api/PrdAgent.sln --no-restore`
| polish | prd-admin | 产品管理智能体卡片 hover 交互统一：grid 可点击卡片复用 pa-card（上浮+青色辉光+错峰入场），列表行/看板卡/紧凑项新增 pa-row（描边提亮+辉光，不上浮） |
| polish | prd-admin | 产品智能体工作台/报表/追溯矩阵/概览图表/活动时间线卡片补齐统一 hover 动效，与产品卡一致 |
| fix | prd-api | 修复产品知识库"文档空间不存在"：DocumentStore 读写判定补齐全局产品管理权限（Super/ProductAgentAdmin/ProductAgentManage），与产品访问口径对齐 |
| refactor | prd-admin | 产品知识库重构 P0：新增 4-Tab 知识模块（知识列表/分类管理/文件夹管理/标签管理），知识列表支持筛选/搜索/分页/增删改/重新上传，新增独立知识详情页路由 |
| feat | prd-api | DocumentEntry 新增 VersionIds 字段（知识关联版本 N:N），条目列表支持 category/tag/versionId/excludeFolders 过滤，更新端点支持 versionIds |
| feat | prd-admin | 产品知识库重构 P1：版本详情「本版本知识」调取卡（从产品库按版本筛选+关联知识对话框），总览知识库改为跨产品聚合列表（搜索/产品筛选/分页/进详情页） |
| refactor | prd-api | 版本独立知识库下线：懒迁移旧版本库条目进产品库（VersionIds 标记归属，幂等），新增总览聚合知识端点 /overview/knowledge/entries |
| chore | prd-admin | 清理死代码：VersionRelationModal / KnowledgeStoreModal / ProductKnowledgePanel 下线 |
| feat | prd-admin | 知识详情页重写：左侧文件夹目录快速切换、HTML 直接预览+代码模式切换、富文本编辑器（图片上传/粘贴/拖拽 + 附件上传），新建文档默认富文本 |
| feat | prd-api | DocumentStore 内容更新端点支持可选 contentType（富文本编辑后置为 text/html） |
| fix | prd-admin | 知识详情 HTML 预览改为沙箱 iframe 真实网页渲染（保留自带样式/布局/脚本视觉，预览容器放宽至 1400px），富文本片段仍走主题内联渲染 |
| polish | prd-admin | 知识详情：预览/代码切换仅对完整 HTML 网页显示（md/富文本片段不再显示）；显示卡片与富文本编辑器宽度/样式统一；列表点标题快捷改名；详情目录双击标题改名 |
| fix | prd-admin | 富文本工具栏逐项修复：execCommand 前确保光标在编辑器内（修「点了没反应」），标题/引用/代码块改为可切回正文的块级切换，styleWithCSS=false 输出语义标签 |
| fix | prd-admin | 富文本工具栏根治：新增 knowledge-rich 作用域 CSS（Tailwind preflight 重置了 h2/blockquote/ul/pre 默认样式导致 formatBlock 生效但视觉无变化），编辑器与片段渲染同 class 所见即所得 |
| fix | prd-admin | 知识格式纠错：contentType 误标 html 但正文无标签的按 Markdown 渲染与编辑（保存自动纠正类型），详情页新增「格式」手动切换（Markdown/富文本）；md 预览/编辑宽度与 HTML 统一为 1400 |
| feat | prd-api | UpdateEntry 支持可选 contentType（格式纠错 Markdown 与 HTML 互转） |
| fix | prd-admin | md 格式显示 HTML 裸标签乱码根治：新增 HTML↔Markdown 轻量互转；格式切换真正转换正文、markdown 模式遇 HTML 正文兜底按 HTML 渲染、进编辑自动 HTML→干净 Markdown |
| feat | prd-admin | 知识编辑器升级：编辑态富文本/Markdown 模式切换（正文实时互转）、统一外壳、Markdown 专属语法工具栏（光标处插入）、富文本新增文字颜色调色板 |
| feat | prd-admin | 知识目录升级：文件夹/文件分区显示并加大字号，文件可拖入文件夹/拖回根目录，同容器内拖拽排序（持久化 sortOrder），文件夹双击改名；列表行新增「移动到文件夹」 |
| feat | prd-api | DocumentEntry 新增 SortOrder（目录手动排序），UpdateEntry 支持写入 |
| feat | prd-api | 新增识途 Agent（shitu-agent）：四分类知识库 find-or-create + 严格 RAG 问答 SSE |
| feat | prd-api | DocumentStore 新增 ShituCategoryRef，个人知识库列表与互传排除识途库 |
| feat | prd-admin | 新增识途页面：四 Tab + 问答窗 + 内嵌知识库，注册百宝箱与导航 |
| feat | prd-admin | 识途新增使用帮助抽屉与作者署名（魏喜胜），百宝箱卡片同步展示作者 |
| polish | prd-admin | 识途使用帮助抽屉去掉作者展示，页头与百宝箱保留 |
| feat | prd-api | CCAS Agent meta 返回 authorName（魏喜胜） |
| feat | prd-admin | CCAS 页头与百宝箱卡片展示作者魏喜胜 |

### 2026-06-09

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 修复 CI 的 CDS Build & Test 失败：cds/pnpm-workspace.yaml 只有 allowBuilds 没有 packages 字段，CI 的 pnpm 9 在 `pnpm store path` 时报 "packages field missing or empty" → store path 为空 → actions/cache 拿不到 path 直接失败。补一个匹配不到任何子包的占位 glob(packages/*)满足 pnpm 9 字段校验，同时保留 allowBuilds(host 的 pnpm 11 仍需它批准 native build) |
| feat | cds | 将分支服务标签升级为统一资源 chip，新增后端分支资源聚合 API，并在分支抽屉新增应用、数据库、缓存资源控制台 |
| feat | cds | 新增资源外部访问策略、资源审计查询和数据库克隆任务状态，MySQL 空库创建可生成分支级独立连接变量 |
| feat | cds | MySQL clone-main 任务接入 mysqldump 后台复制，执行过程中记录进度、失败原因，并在完成后注入分支级连接变量 |
| feat | cds | 分支资源控制台新增 MySQL 资源级备份列表、手动备份和恢复覆盖接口，恢复前自动生成安全备份并写入破坏性操作审计 |
| feat | cds | 资源连接页新增 MySQL 分支凭据重置、连接变量注入依赖应用和反向依赖展示，注入写入分支 profile override 并记录审计 |
| feat | cds | MySQL 资源数据页接入只读表列表、schema、数据预览和只读 SQL Console，查询按分支数据库执行并记录审计 |
| feat | cds | PostgreSQL 资源复用 SQL 数据面板，支持表列表、schema、只读预览和只读 SQL Console，并按 runtime 使用 PostgreSQL 引号规则 |
| feat | cds | Redis 资源数据页接入只读 key browser、TTL、value preview 和 memory usage，后端仅执行 SCAN/TYPE/TTL/MEMORY/GET 等只读命令 |
| feat | cds | MongoDB 资源数据页接入 database/collection/document browser 和 JSON 只读 query console，后端只接受 filter/projection/sort object 不执行任意 JS |
| feat | cds | 资源写操作新增 member/developer/admin 权限门控，生产资源公网访问、备份恢复、连接已有数据库等高风险操作要求 admin 权限 |
| feat | cds | 资源连接页新增外部访问 TTL 与 IP allowlist 表单，备份页新增从备份创建新库和连接已有数据库入口，后端写入分支级 env 并记录任务审计 |
| feat | cds | 资源级备份恢复扩展到 PostgreSQL、MongoDB、Redis，PostgreSQL/MongoDB 支持空库创建、clone-main 和从备份创建分支独立库 |
| feat | cds | 资源设置页新增清空数据、删除分支数据库、执行写 SQL 的危险操作入口，后端强制管理员权限、资源名确认、安全备份和审计日志 |
| fix | cds | MySQL clone-main 复制任务现在检查 mysqldump/mysql 导入退出码，失败时正确落到任务失败状态并记录失败原因 |
| feat | cds | 新增资源权限摘要 API，资源控制台按服务端判定的 member/developer/admin 权限禁用重启、外部访问、备份恢复、凭据、克隆和危险操作按钮 |
| feat | cds | 资源详情指标/日志 tab 接入资源级 metrics/logs API，数据库、缓存等 infra 容器不再显示占位指标和占位日志 |
| feat | cds | 资源公网 TCP 访问接入受管 Docker proxy 与 iptables allowlist，数据库外部连接串使用动态端口并在资源连接页显示网络层执行状态 |
| fix | cds | MongoDB 数据面板支持切换 database 后查询 collection/document，资源连接页新增按权限复制真实可用连接串，避免 Redis 只复制星号密码 |
| fix | cds-skill | bump CDS 技能版本 0.6.7 → 0.6.8，让已合入的 `X-Cds-Cli-Latest` 更新提醒对旧 0.6.7 客户端可见 |
| fix | cds | CDS API 响应统一下发 `X-Cds-Cli-Latest`，让旧版 `cdscli` 普通请求也能提示运行 `cdscli update` 升级 |
| fix | cds-skill | CDS 技能 `SKILL.md` frontmatter 版本与 `cdscli.py VERSION` 对齐，并新增守卫测试防止两处版本再次漂移 |
| docs | cds-skill | drop-in 升级说明改为优先 `cdscli version && cdscli update`，手动重装仅作为旧包兜底 |
| docs | doc | 新增 CDS 技能版本与更新架构文档，沉淀版本权威源、响应头提醒、更新路径和 findmapskills 边界 |
| docs | skills | 同步本地 findmapskills 文档到 1.1.0，补充海鲜市场上传幂等覆盖与 slug/version 决策规则 |
| fix | prd-admin | 更新中心类型筛选改为固定中文枚举，并新增 changelog 碎片与 commit message hook 校验脚本，避免新增记录继续出现难懂的英文自由类型 |
| feat | prd-api | 商品溯源智能体：业务知识/线上问题支持导入文件入库（知识 1 文件 1 条、案例 AI 解析为多条结构化案例 SSE 流式） |
| feat | prd-api | 商品溯源智能体代码对比改造：内置 fc_codeapi/fc_YmSystem 两仓库，新增 ChannelTraceCodeScanService 子 agent（描述抽关键词→克隆扫描→命中代码→AI 异同分析），GitHub PAT 走配置 ChannelTrace__GitHubToken |
| feat | prd-admin | 商品溯源智能体：知识/案例 Tab 增加导入文件入口；代码对比 Tab 改为描述驱动，展示内置仓库/关键词/命中代码 + token 未配置告警 |
| feat | prd-api | 商品溯源智能体线上问题诊断升级为多轮对话：新增 ChannelTraceDiagnoseSession 会话存储 + diagnose/ask SSE 端点（每轮召回历史案例 + 扫描内置仓库代码定位 + 信息不足时主动追问引导补齐），会话 CRUD 端点 |
| feat | prd-admin | 商品溯源智能体「问题排查」Tab 改为多轮对话式 UI：流式问答、召回案例/命中代码可视、历史会话切换与新建对话 |
| fix | prd-api | 修复商品溯源「线上问题」导入大文件（如 93 条缺陷汇总）耗时很久且最终失败：原单次 LLM 解析全文 → 输出超 max_tokens 被截断 → JSON 解析失败。改为分段解析 + 逐条入库 + 增量进度 + 容错 JSON 提取，单段失败不影响整体 |
| feat | prd-api | 商品溯源代码扫描 GitHub PAT 解析增加通用环境变量兜底（GITHUB_TOKEN/GH_TOKEN/GITHUB_PAT/GITHUB_ACCESS_TOKEN/MIDOUTECH_GITHUB_TOKEN），不再仅限 ChannelTrace__GitHubToken |
| feat | prd-api | 商品溯源业务知识问答支持上传防窜后台页面截图（视觉识别）/ 文档作为上下文；系统提示词强化：识别到「怎么操作/在哪操作/线上问题如何在后台排查」时输出「操作步骤」分步指引（入口路径→点哪些菜单按钮），内置防窜系统访问入口导航（不含账号密码） |
| feat | prd-admin | 商品溯源「业务知识」问答框支持附加截图/文档（多选），用于让 AI 识别页面与关键操作 |
| feat | prd-api | 新增商品溯源智能体（channel-trace-agent）：防窜物流业务知识库 + 线上问题案例库 + 业务/代码差异对比，三类能力均走 ILlmGateway SSE 流式 |
| feat | prd-admin | 新增商品溯源智能体页面（百宝箱 wip），三 Tab：业务知识问答、线上问题智能排查、业务规则 vs 代码实现差异对比 |
# 2026-06-09 知识库验收报告图标与列表样式

## 背景

知识库列表中的验收报告此前仍使用普通文档图标，并通过左侧竖向色条表达验收结论。实际扫读时，左侧色条和条目图标含义重叠，且验收报告的文档类型不够明确。

## 变更

- 验收报告条目识别 `metadata.kind=acceptance-report`、`metadata.type=acceptance-report`、合法 `metadata.verdict`，以及历史标签 `视觉验收` / `验收报告`。
- 验收报告使用 `ClipboardCheck` 图标，与行业里常见的“清单 + 勾选”验收/审核语义一致。
- 移除知识库条目左侧验收结论竖条和选中态竖条；结论继续由 `通过 L1`、`有条件 L2` 等 chip 表达，避免同一状态重复编码。

## 验证

- `pnpm --prefix prd-admin tsc --noEmit`
| feat | prd-api | 新增前端搭档智能体流式助手接口，支持 API 接入、组件生成、报错诊断和视觉样式建议 |
| feat | prd-admin | 新增前端搭档智能体页面与百宝箱入口，支持四类任务流式生成前端交付方案 |
| feat | prd-admin | 前端搭档智能体新增前端项目表，可按项目名、技术栈、仓库和构建地址查询项目位置 |
| feat | prd-admin | 前端搭档智能体新增 PDA 项目手册，沉淀 uniapp-pda 项目说明、操作要点和发布流程 |
| feat | prd-admin | MD转PPT智能体页面重构为对话+预览双栏布局（大纲先行确认流程、左侧聊天面板、右侧 reveal.js iframe 实时预览） |
| feat | prd-api | 新增 POST /api/md-to-ppt/outline 大纲规划端点（JSON，非 SSE，支持附件/知识库上下文/历史对话） |
| fix | prd-admin | P1 安全漏洞：iframe sandbox 移除 allow-same-origin，注入内存存储 shim，消除 LLM 生成脚本访问主应用鉴权 Token 的风险 |
| feat | prd-admin | 新增知识库引用选择器（KbPicker）和大纲确认气泡（OutlineBubble）组件 |
| feat | prd-admin | 新增 "+" 菜单支持文件上传和知识库引用，对话历史通过 sessionStorage 持久化跨刷新恢复 |
| feat | prd-api | AppCallerRegistry 新增 md-to-ppt-agent.outline::chat 和 md-to-ppt-agent.chat-refine::chat 两个注册常量 |
| fix | prd-api | MdToPpt MAP路径：超时从180s提升至600s，OperationCanceledException改为发error事件而非静默吞掉，添加SSE keepalive防代理断连 |
| fix | prd-admin | mdToPptService：stream意外关闭未收到done/error时调用onError解除前端"生成中"卡死 |
| feat | prd-admin | MD转PPT：前端注入主题 CSS 覆盖层，确保主题始终正确渲染（不依赖 LLM 输出） |
| feat | prd-admin | MD转PPT：注入 Google Fonts（Inter 400-900），提升排版质量 |
| feat | prd-admin | MD转PPT：显示模型徽章（模型名 + 平台）在 artifact 工具栏 |
| feat | prd-api | MD转PPT：扩充 CSS 组件库（.feat 功能列表 / .table 对比表 / .step-row 流程 / .callout 标注） |
| feat | prd-api | MD转PPT：5 种主题增加风格个性描述，版式库扩展至 10 种，质量自检覆盖视觉多样性 |
| feat | prd-admin | MD转PPT：借鉴 open-design 重设计 5 种差异化主题（Tech 极黑/钴蓝格纸/纸墨编辑/复古 Zine/Swiss 极简），各主题 !important 覆盖 reveal.js 元素级样式 |
| feat | prd-admin | MD转PPT：钴蓝格纸主题注入 CSS 方格纸背景，Swiss 极简主题添加页眉页脚发丝线，Tech 极黑主题添加渐变光晕 |
| feat | prd-admin | MD转PPT：扩充字体栈（JetBrains Mono / Newsreader / Hanken Grotesk / Playfair Display / Space Grotesk / Noto Serif SC），各主题字形各异 |
| feat | prd-api | MD转PPT：更新后端 ThemeTokens 5 个新主题描述，提示词强化字体/背景/层叠约定 |
| fix | prd-admin | MD转PPT：修复刷新后历史记录丢失问题——改用 lazy useState initializer 在首次渲染前从 sessionStorage 恢复状态，消除 saveSession 以空初始 state 覆写的竞态 |
| fix | prd-admin | MD转PPT：将工具注册到百宝箱 BUILTIN_TOOLS，修复百宝箱找不到「MD 转网页 PPT」卡片的 P1 缺陷 |
| fix | prd-api | MD转PPT patch 页码归一:前端"指定第几页"是 1-based 原样下发,后端原先又 +1(输入 3 改成第 4 页)、留空写成"第 0 页";改为直接用 1-based 页码,留空时提示"按要求修改整份 PPT" |
| fix | cds | 修复 CDS Agent 会话可观测面板:事件字段对齐后端真实形状(payload/createdAt,原误写 data/ts 导致时间 Invalid Date、摘要永远为空)、tool 事件读 toolName、过滤流末尾 keepalive 垃圾行、新增思考事件标签 |
| fix | cds | CDS Agent 会话详情改为按 afterSeq 持续重连轮询:CDS stream 端点是一次性(回放缓冲事件+keepalive 后即 Connection:close),运行中会话单次读完即假死,现轮询到终态事件才停 |
| fix | cds | CDS Agent 会话列表 5s 自动刷新改 silent(不再每 5 秒闪 loading 骨架) + loadSessions 加 fetchSeq 守卫(切项目时旧请求晚返回不再覆盖新列表) |
| fix | cds | 修复 Agent 会话端点跨租户越权:authenticateProjectRequest 原把所有 _aiSession 当 admin 等价放行,导致项目级 Agent Key(cdsp_*)改 URL 里的 projectId 就能列/控制别的项目的 Agent 会话;改为项目级 key 强制 cdsProjectKey.projectId === 路由 projectId,全局超级密钥与人类 cookie 仍放行 |
| fix | cds | self-update boot 预检(#746 guard#3)不再重复 install:仅当 runPnpmInstallWithCache 命中缓存跳过真实 install 时才补跑 boot 预检;helper 本轮已用同一条命令真实跑过则不再跑第二遍(省双倍 install 时间、避免第二次偶发失败误伤) |
| fix | cds | self-update boot 预检测试随 guard#3 条件化更新:本 mock 无 lockfile stamp(install 真实跑)时 cdsDir 命令数从 3 改为 2(真实 install + tsc),boot 预检仅在缓存跳过时补跑 |
| fix | prd-api | MD转PPT CDS Agent 引擎补齐 server-authority:客户端断开时 SSE 心跳写失败不再 break(原会提前掉进超时分支落半成品 HTML 并 StopAsync 掉还在跑的会话),改标记 clientGone 继续轮询到 done/error/timeout 完整落库,客户端凭 runId 重连 |
| fix | prd-admin | CDS Agent code 模式「知识库/工作区」selector 暂禁用并标注「开发中」:后端尚无把知识库灌进 Agent 会话上下文的能力,createInfraAgentSession 也无此字段,避免"选了却不生效"误导(债务见 doc/debt.md-to-ppt.md) |
| fix | prd-admin | 知识库再加工确认窗写回失败不再误关:performApply 返回写回成功与否,confirmPendingApply 仅成功才关 diff 预览,失败时保留预览供用户直接重试 |
| fix | cds | CDS Agent 会话详情流补 stale 守卫:切会话/关窗后,上一会话晚返回的 SSE 事件不再 append(原会把两个会话时间线混在一起),且被 abort 的旧轮询不再误置新会话的 streaming=false |
| feat | prd-admin | 产品管理智能体缺陷「严重度+优先级」统一为 P0-P3「等级」，与需求/功能口径一致 |
| feat | prd-api | DefectReport 新增 Grade 字段；产品缺陷创建/编辑/图谱/概览/转需求改用 grade（旧数据由 severity 兜底） |
| fix | prd-admin | 产品管理智能体工作台「我的待办」及缺陷列表/概览/状态分布图，缺陷状态由英文(submitted)改为中文标签(已提交/待处理等) |
| feat | prd-api | 工作台「我的待办」新增 GET /products/{id}/my-todos 端点，只返回需我处理项（需求/功能按状态责任人+未到终态，缺陷跟我相关+未完成） |
| fix | prd-admin | 工作台「我的待办」改用 my-todos 端点，已处理/已流转/已完成的需求·功能·缺陷自动从待办消失，需求/功能状态显示中文工作流状态名 |
| fix | prd-admin | 产品管理智能体评论区@提醒：改用 /api/teams/search-users（普通成员可用），修复非管理员列表空无法@；KanbanBoard 处理人姓名同步改造 |
| fix | prd-admin | UserSearchSelect 下拉空间不足时向上翻转 + 按可用空间限高 + 左边界夹取，修复评论区@弹层靠底被裁切显示不全 |
| fix | prd-api | 工作台「我的待办」缺陷改为按状态责任人过滤：上报人仅在草稿/待验收才显示，提交流转到处理环节后从上报人待办消失（修复 reporter 提交后仍挂待办） |
| feat | prd-api | 产品管理智能体新增工作助手问答 SSE 端点 POST /products/{id}/assistant/ask：以该产品全量数据+知识库文档为上下文流式回答，严格按产品成员权限闸口、只限本产品、知识库仅取文本索引截断 |
| feat | prd-admin | 工作台新增「工作助手」入口，点击从右侧滑出抽屉(占视口30%)，问答形式调用AI，预置本月需求分析/需求矩阵分析/缺陷分析三个快捷问题 |
| feat | prd-api | AI助手上下文补全人员(处理人/负责人/上报人/团队)与关系(功能→需求、缺陷→追溯对象)，prompt 改为纯文本输出+深度分析(关系挖掘/人员负载/经验总结建议)，修复"查无某人"；端点重命名为 AI助手 |
| fix | prd-admin | AI助手回答去除 Markdown 标记渲染为纯文本(stripMarkdown)；「工作助手」改名「AI助手」 |
| fix | prd-admin | UserSearchSelect 已选 value 在关闭态预拉目录解析显示名，修复「处理人」已指派却显示占位空白 |
| fix | prd-admin | AI助手抽屉改主流聊天样式：用户/AI 各带头像+气泡(底色+边框)，回答可一键复制，字号收小；对话存 sessionStorage(按产品隔离)关闭重开不丢+手动清除；工作台入口移到 SectionShell 右上角不占空间 |
| feat | prd-admin | 需求/功能/缺陷列表新增搜索+多字段筛选(客户端)：关键词搜编号/标题/描述，可按等级/状态/处理人/负责人/上报人/版本/客户/关联功能/时间等筛选；默认展示核心项，「筛选设置」可自定义显示哪些(按列表类型存localStorage) |
| fix | prd-admin | 图谱「关系分析」去除 Markdown 标记渲染为纯文本 + 一键复制；stripMarkdown 提取为 lib 共享工具(AI助手复用) |
| fix | prd-api | 追溯关系分析 prompt 改为简洁纯文本输出(3-5 要点、禁 Markdown 标记、保留关键信息与风险) |
| feat | scripts | 新增 Claude Code 技能迁移脚本，支持从 `.claude/skills` 迁移到 `.agents/skills`、`~/.codex/skills` 或任意目标目录，并提供 copy/link 两种模式、dry-run、指定技能、覆盖和 manifest 输出 |
| feat | prd-admin | 新增技术分析文档格式校验 Agent，支持 PM2502 模板生成、上传检查、需求文件上传、GitHub 项目路径选择、流式生成后自动校验 |
| feat | prd-admin | 技术分析文档格式校验 Agent 新增内容质量校验，阻断只输出模板占位或残留 PM2502 示例内容 |
| feat | prd-api | 新增技术分析文档格式校验 Agent 的 GitHub Device Flow、仓库列表、目录浏览与项目关键文件读取接口 |

### 2026-06-08

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 项目业务目标(北极星)支持内联编辑:目标列表卡片右上角编辑,保存走 updatePmProject,头部「目标」同步更新(owner/leader 可编辑) |
| perf | cds | 登录页右侧访问区重构为可登录 runtime board：账号/密码保持上下结构，session/console/preview 节点在同一面板内静态连线，首页 Enter Console/Access 改为本页原地切换访问态，并增加 board morph、输入展开与 Access 收缩动画 |
| fix | cds | 分支卡片服务标签移除立方体容器图标，改用状态圆点，避免 chip 内出现块状图形干扰 |
| chore | doc | 熵清理：D2 +7 index.yml，D3 +7 guide.list，D6 +5 changelog manifest |
| fix | prd-admin | 修复里程碑详情日期/负责人行样式错乱:两个日期同行各占半,负责人独占一行 |
| feat | prd-api | 目标可设为里程碑:POST /api/pm/goals/:id/milestone 开/关,开→建联动里程碑(AutoFromGoal,GoalId 关联),关→删;PmMilestone 加 AutoFromGoal;目标列表返回 isMilestone |
| feat | prd-admin | 目标「设为里程碑」开关:画布(GoalDetailDrawer)开关 + 列表行 Flag 按钮,设置后在里程碑同步显示,团队/个人目标均支持 |
| fix | prd-admin | 目标详情「详细描述」默认 5 行高度(minHeight 120)可拖拽,「进展/信心」框统一同高 |
| feat | prd-api | 目标支持调整层级:POST /api/pm/goals/:id/reparent(同范围+防环+层级上限校验+子树深度级联) |
| feat | prd-admin | 目标画布支持拖拽改层级(Xmind 式):拖到另一目标=成为其子目标,拖到北极星/个人根=升为顶层,落空回弹 |
| fix | prd-api | 修复 MD转PPT SSE 两个引擎(MAP/CDS Agent)均 524 超时：SetSseHeaders 不再手动写 Transfer-Encoding: chunked(由 Kestrel 管理)，与既有 SSE 控制器一致 |
| fix | prd-api | MD转PPT SSE 末尾一次性吐出：补 IHttpResponseBodyFeature.DisableBuffering() 禁用 Kestrel 响应缓冲(与既有 SSE 控制器一致) + Cache-Control no-transform + 2KB padding |
| fix | cds | 修复 pnpm-workspace.yaml allowBuilds 占位字符串导致 master-run 启动崩溃：pnpm 11 把未批准的 native build(cpu-features/esbuild/ssh2)当 fatal(ERR_PNPM_IGNORED_BUILDS exit 1)→ exit 78 崩溃循环；改为 allowBuilds:true 显式批准 |
| feat | cds | #746 self-update 加固：guard#3 boot-install smoke(swap 前用 master-run 确切命令跑真实 pnpm install，挡住"编译过但启动崩"，两次 502 都是从 cached-install skip 缝里溜过) + guard#2 分支落后 main 非阻断警告 |
| fix | cds | 修复 Sidecar Pool 观测面板对仪表盘操作者永远 401：agent-sessions 端点的 authenticateProjectRequest 只认 Bearer 连接 token，浏览器带的是 cds_token cookie；改为人类 cookie 登录(_cdsCookieAuth)/AI 超级密钥(_aiSession)等 admin 等价会话直接放行 |
| fix | prd-api | 大幅提升 MD转PPT 生成质量：内置完整 reveal.js 设计系统提示词(卡片/数据/光晕/强调条) + 强制每页结构杜绝空洞页；标题改实色(原渐变 color:transparent 在嵌入式渲染会整页消失) + 服务端兜底剥离 emoji(规则#0) |
| fix | prd-admin | 修复 MD转PPT 预览里递归显示整个 MAP 应用而非幻灯：iframe sandbox 去掉 allow-same-origin(生成 HTML 跑在本应用同源里，reveal 的 history/相对跳转会把 iframe 导航回应用 /) + onDone 校验返回的确实是网页 PPT(非 SPA 外壳/空内容) |
| fix | prd-api | 修复 MD转PPT 幻灯整页空白(只剩光晕)：设计系统里 `.reveal .slides section>*{position:relative}` 优先级高于 `.orb{position:absolute}`，把装饰光晕变成 relative 块占掉 ~700px 流高把正文挤出可视区。服务端 InjectDeckCssFix 强制 .orb 绝对定位(预览+发布都生效) + 提示词移除该冲突规则 |
| fix | prd-admin | MD转PPT 翻页体验：结果工具栏加显眼的上一页/下一页按钮(直接驱动预览 iframe 的 reveal，免去用户找小箭头/点 iframe 取焦点的『翻不了页』困惑) + 生成期间不再糊原始 HTML 流，只显示增长中的字符计数作进度 |
| feat | prd-api | MD转PPT 落库可重连(server-authority)：生成创建 MdToPptRun 记录(running)并经 SSE run 事件下发 runId，done/error/timeout 全落库；MAP 路径客户端断开不再 return 中止(clientGone 只跳过 SSE 写入、继续生成并落库)；新增 GET runs/{id} + GET runs 历史 |
| feat | prd-admin | MD转PPT 刷新不再丢：收到 run 事件存 runId 到 sessionStorage，进页/刷新后凭 runId 重连——还在跑就轮询、已完成直接还原结果 |
| feat | prd-api | MD转PPT 多风格模板：提示词从单一深色玻璃改为 BuildPptSystemPrompt(theme) 按风格出不同设计系统(深色玻璃/浅色简洁/紫色渐变/商务蓝/暖色大地，各一套配色 token)；标题/正文全 token 化(var(--ink)/var(--a1))，浅色模板也能正常显示 |
| feat | prd-admin | MD转PPT 生成前定页数(按内容约 N 页，可改) + 风格模板下拉带描述(不用描述清楚自己要什么，直接选) + 引擎选择(MAP直调/CDS Agent)移到左侧选项区显眼位置 |
| fix | prd-admin | 项目资料-成员作品卡片无预览:网页托管作品无封面图时改用缩放 iframe 实时预览托管页(无封面图才白占位) |
| feat | prd-api | 里程碑健康度:有「实际完成时间」(ReachedAt)即视为已完成、不再判逾期(早于/等于计划截止=按时);UpdateMilestone 支持设置/清空实际完成时间 |
| feat | prd-admin | 里程碑详情新增「实际完成」时间填写,保存即按是否晚于计划截止提示按时/逾期;修复完成的里程碑被误标已逾期 |
| fix | prd-admin, prd-api | 系统互联添加对端收敛为单一连接串流程；后端添加改为 prepare/confirm/ping 后才落正式 PeerNode，失败不保存半连接状态 |
| fix | prd-admin | 修复项目管理-目标画布:有"业务目标北极星"根节点时仍显示"还没有目标"空状态导致重叠;改为按画布实际节点数判断,真无节点才显示 |
| feat | prd-api | 项目管理任务支持进度百分比(ProgressPercent)+父任务按子任务自动汇总(roll-up) |
| feat | prd-api | 项目管理新增任务工作日志(pm_task_work_logs):处理人按天记录做了什么、填报进度,带进度时联动任务进度 |
| feat | prd-api | 任务子任务强制两级约束:创建/挂载子任务时拒绝三级嵌套 |
| feat | prd-admin | pmAgent 服务层新增工作日志 CRUD + PmTask 进度字段类型 |
| feat | prd-admin | 新增任务独立详情页(/pm-agent/p/:projectId/task/:taskId):双栏布局,左侧描述/工作日志/动态,右侧状态/进度/负责人/子任务/依赖 |
| feat | prd-admin | 新增任务工作日志面板 TaskWorkLogPanel:按天分组时间线 + 新增/编辑/删除 + 进度滑块联动 |
| feat | prd-admin | 子任务增强:支持新建子任务 + 选择已有任务挂为子任务(两级约束),抽屉/详情页双入口 |
| feat | prd-admin | 看板卡片/列表行新增进度条;抽屉新增进度滑块 + 进详情页入口;PmAgentPage 支持 ?project 深链返回 |
| feat | prd-admin | 新建任务改为进入新建详情页(task/new 空表单,填全字段保存才落库),快速添加框可预填标题 |
| feat | prd-admin | 产品管理智能体产品卡片新增动效:入场淡入上浮错峰 + 悬停抬升青色辉光,含 reduced-motion 降级 |
| feat | prd-admin | 百宝箱"产品管理智能体"入口卡片新增动态卡面:知识图谱链路(节点脉冲+连线数据流光+彗星沿链流动+光晕漂移),悬停提速,reduced-motion 降级 |
| fix | prd-admin | 首页 AGENTS 区"产品管理智能体"卡片同步知识图谱动态卡面(AgentLauncherPage 之前漏接,只有百宝箱 ToolCard 接了) |
| feat | prd-admin | 产品管理-新建缺陷:优先级与关联功能改为必填,移除关联需求,版本默认填充所选功能的版本号(可改) |
| feat | prd-api | 建产品缺陷接口支持 featureId,写入缺陷的 TracedFeatureId |
| fix | prd-admin | 产品管理-删除产品增加二次确认弹窗(列表行 + 单产品视图两处) |
| fix | prd-admin | 产品管理-单产品视图当前 tab 记入 URL,从对象详情返回时停在原 tab(不再回弹工作台) |
| feat | prd-admin | 产品管理-缺陷详情页对齐需求详情:标题/描述/严重度/优先级/状态/处理人/关联功能/版本可就地编辑保存 |
| feat | prd-api | 产品内缺陷编辑接口 PUT products/{id}/defects/{defectId}(更新核心字段,完整流转仍在缺陷管理) |
| feat | prd-admin | 产品管理-缺陷详情保持独立闭环:去掉「解除追溯」「在缺陷管理打开完整缺陷」,「转为需求」移到右上角 |
| feat | prd-admin | 产品管理-缺陷 tab 去掉「关联已有缺陷」,缺陷在本产品内独立新建(不从全局缺陷池关联) |
| feat | prd-admin | 产品管理-新建缺陷改为独立全屏页(对齐新建需求):富文本描述+严重度+优先级+处理人+关联需求/版本,删除原3字段弹窗 |
| feat | prd-api | 建产品缺陷接口扩展 priority + assigneeId(回填处理人显示名),对齐新建需求字段 |
| feat | prd-admin | 产品图谱去掉"全部展开/收起"(无节点级折叠,实为死按钮),换成"整理/离散"布局切换 |
| feat | prd-admin | 图谱新增"离散"布局:自写轻量力导向(斥力+边弹簧+向心,确定性种子),参考 Obsidian 有机散布,不挤不规则;"整理"=按类型分列 |
| feat | prd-admin | 图谱圆点缩小(9+desc*2)、动效加大(浮动-8px/脉冲1.42/常态呼吸错峰)、新增悬停激活追溯(移出取消,点击固定保留) |
| feat | prd-admin | 图谱离散布局新增实时拖拽力导向(Obsidian 式):拖动节点,关联点经弹簧+斥力丝滑跟随,松手落点固定其余 settle;仅拖动期间运行 rAF,reduce-motion 无碍 |
| feat | prd-api | 产品图谱新增「追溯关系分析」SSE 端点:按前端传入关系链(节点+关系边)从 DB 补全描述/时间戳,AI 流式分析前因后果/关键对象关系/时间节点 |
| feat | prd-admin | 图谱节点抽屉(需求/功能/缺陷)新增「关系分析」按钮:点亮整条追溯链并流式展示 AI 关系分析(StreamingText) |
| fix | prd-admin | 修复用户选择器普通成员搜不到用户:UserSearchSelect 改用仅登录的 /api/teams/search-users,不再误用管理员 /api/users(需 users.read) |

### 2026-06-07

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 修复 CDS Agent direct-sidecar 路径多轮对话上下文丢失问题，LoadConversationHistoryAsync 加载最近 20 条历史消息（字符预算 40000）并作为完整对话链传给 LLM |
| feat | prd-admin | 新增 MD 转网页 PPT 智能体页面（左侧输入/右侧流式预览+iframe 展示，支持局部修改与发布） |
| feat | prd-api | MdToPptController 重写：ILlmGateway 直出 reveal.js HTML，新增 patch 局部修改端点 |
| feat | prd-api | AppCallerRegistry 新增 MdToPptAgent 三条注册项（html-generate/patch/convert） |
| feat | prd-api | MD 转网页 PPT 后端改用 CDS Agent 会话（IInfraAgentSessionService）生成 reveal.js HTML，支持 SSE 流式推送 delta/done/error 事件，会话出现在 CDS 控制台 Sidecar Pool 列表 |
| fix | prd-api | MD转PPT 走 CDS Agent 的 convert/patch SSE 补 keepalive 心跳(每~10s),根治 agent 慢/思考期间无数据导致的 Cloudflare HTTP 524 超时(server-authority 规则#4 子智能体漏了) |
| feat | prd-admin | MD转PPT 新增生成引擎切换（MAP直调 / CDS Agent），默认走 MAP 直调路径 |
| feat | prd-api | MD转PPT MAP直调引擎：通过 ILlmGateway.StreamAsync 直接流式生成，不经过 CDS Agent |
| fix | prd-api | MD转PPT CDS Agent 路径改用 DenyAll toolPolicy，修复因 tool-call 循环导致的 HTTP 524 超时 |
| feat | prd-api | MD转PPT Agent 路径新增全链路诊断：per-stage 耗时/事件计数/tool-loop 告警，通过 diag SSE 事件实时推送前端 |
| feat | prd-admin | MD转PPT 前端实时展示 diag 诊断面板，CDS Agent 引擎下颜色编码显示各阶段耗时与 tool-call 次数 |

### 2026-06-06

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | CDS Agent 事件流不再注入每条消息的传输内幕 debug 日志（cds-session-transport/operator-debug-only），移到服务端日志，消除用户事件时间线刷屏 |
| fix | prd-admin | CDS Agent「同步系统主模型」按钮改为「一键启用默认模型」+ 解释 tooltip（说明何时/为何出现），消除莫名其妙的困惑 |
| fix | prd-api | CDS Agent 改为真流式：ImportCdsStreamEventsAsync 增量读取 CDS SSE（边读边落库），前端 /stream 实时转发逐字呈现，消除「不流式 / 很久不返回」 |
| fix | prd-api | CDS Agent 发送不再卡死：SendMessage 把消息 POST 到 CDS 后立即入队返回，由 InfraAgentRuntimeWorker 后台拉流落库（与 HTTP 解耦，server-authority），消除「发送卡 2 秒→一直等→死掉」 |
| fix | prd-admin | CDS Agent 事件「详情」仅在展开后确有内容时才显示，空 payload 事件不再展开成「{}」/空（修复"展开折叠没内容"） |
| feat | prd-api | CDS Agent 新增工作区文件注入接口 POST /api/infra-agent-sessions/{id}/inject-files（path 1 接缝 v1，复用 CDS files 端点，不改边车镜像），用于把知识库文件喂给 agent 处理 |
| fix | prd-admin | CDS Agent 输入区重做：真输入框做成醒目带边框可输入+自动聚焦，去掉看着像输入框的提示框，修复"框选错半天无法输入" |
| fix | prd-admin | CDS Agent 新建会话不再起怪名「远程巡检任务」，默认从首条消息自动命名（留空→「新会话」） |
| fix | prd-admin | CDS Agent 对话流隐去纯内部状态/日志气泡（后台状态 running/dispatching run/陈旧用时），只保留用户/Agent消息+工具/错误/审批；运行状态看右侧面板 |
| fix | prd-admin | CDS Agent 简洁模式右栏精简：Git/证据/运行摘要/调试 等运维遥测收起，只留「准备情况/运行进展」，让简洁模式回归纯净聊天（用户心智：这是聊天不是运维台）；专业模式不变 |
| fix | prd-admin | CDS Agent 回复按 markdown 渲染：本轮收到 done 即渲染（不再因会话持续 live 而一直纯文本展示 ##/**/反引号） |
| fix | prd-admin | CDS Agent 输入区按 Codex 极简：去掉「官方 SDK」徽标+「不要求仓库…」说明+冗余提示，Code 巡检改名「代码」，思考指示改「Agent 思考中…」 |
| feat | prd-admin | CDS Agent 输入栏加模型选择器（参照 Codex）：新会话可直接选模型（解决配了 v4 却跑 v3.2 → 选对的那个），运行中显示当前模型 |
| feat | prd-admin | CDS Agent 展示思考过程：推理模型 thinking 内容流式显示在「Agent 思考中」气泡，消除推理期间空白 |
| feat | cds | CDS Agent 边车 sdk_events 映射 thinking 块 + remote-hosts 透传 thinking 事件给 MAP（原先只透 text_delta/tool_use/tool_result，思考被丢弃） |
| feat | cds | CDS Agent 边车 agent_loop 两条上游链路都透出思考：raw-anthropic 识别 thinking_delta；openai-compatible(OpenRouter) 请求体加 include_reasoning/reasoning + 解析 reasoning/reasoning_content，根治「等 40 秒才出第一个字」 |
| feat | prd-api | CDS Agent MAP 端打通 thinking 事件：SidecarEventType/InfraAgentRuntimeEventType/InfraAgentEventTypes 三处枚举补 Thinking，direct-sidecar 路径 switch 落 thinking 事件（不计入 finalText），CDS-managed 路径本就透传 |
| fix | prd-admin | CDS Agent 输入框不再发送后从中间跳到底部:输入区永远停底部(空状态也在底部),中间只放引导;根治布局跳变 |
| fix | prd-admin | CDS Agent 流式回复 markdown 不再「结束啪一下变样」:同一个 StreamingText 贯穿流式→完成两阶段(blur 过渡),不再换组件硬切 |
| fix | prd-admin | CDS Agent 右栏「结果可复盘」不再显示原始事件序号(一句闲聊刷几十个事件的噪音),改为「回复已生成」/真实产物数 |
| fix | prd-admin | CDS Agent 等待文案收敛:有思考显示「正在思考」,否则「正在生成回复」,「推理较慢」提示仅在等待≥15s 才出,不再一上来吓唬人 |
| fix | prd-admin | CDS Agent 右栏不再把「运行日志」当产物:纯聊天不再误报「1个产物」,真实文件/diff/命令/快照才计入产物数 |
| fix | prd-admin | CDS Agent 发送后消息不再「闪一下消失再出现」:乐观消息改 null 绑定(不再误绑到超时旧会话)+按内容(剥模式前缀)与服务端消息去重,新建会话切换也无空窗 |
| fix | prd-admin | CDS Agent 发送时不再弹「正在发送任务/复制诊断」开发者卡片:该诊断卡仅失败时出现,正常进度由对话气泡+右栏承载 |
| fix | prd-admin | CDS Agent 无模型配置时自动启用系统默认主模型(静默,失败保留手动按钮兜底):刷新后不再卡在「请先同步系统主模型」三连警告 |
| fix | prd-admin | CDS Agent 兑现「回车发送」:输入框此前没有 onKeyDown,回车只换行不发送;补 Enter 发送(Shift+Enter 换行,输入法组字回车不误发) |
| fix | prd-admin | CDS Agent 输入区抄 Codex 融合一体:模式/模型/停止/发送合并到输入框底栏一行,textarea 无边框透明融入容器,去掉顶部独立 tab 行+分隔线+提示文案,发送改圆形箭头,不再臃肿拆分 |
| fix | prd-admin | CDS Agent 右栏「准备情况/运行进展」可折叠(顶栏按钮):折叠后聊天主区占满宽度,借鉴 Codex 右侧不占固定栏 |
| fix | prd-admin | CDS Agent 刷新后不再 10 秒空白:首屏 loadAll 期间主区显示加载动画(MapSectionLoader),不再空等 |
| fix | prd-api | CDS Agent 会话一轮回复结束(done)即转 idle(可复用、不计时超时),不再停留 running 直到超时:根治「历史消失(每次发送新建会话)」+「任务列表全是新会话已超时尸体」;CDS-managed 与 direct-sidecar 两条路径都修;done 后停止拉流释放 worker |
| fix | prd-admin | CDS Agent 输入框选中高亮走外层容器(focus-within ring),不再高亮内层 textarea(符合 surface 选中规则) |
| fix | prd-admin | CDS Agent 追问复用同一会话:已 provision 过(有 cdsSessionId)的会话不再 re-start,直接发消息(CDS 会话被回收时由 SendMessage 按同一 MAP 会话重建),根治「追问时上一轮历史丢失/新建会话」 |
| fix | prd-admin | CDS Agent 输入框 textarea 加 .no-focus-ring 压掉全局 textarea:focus-visible 内框描边,选中高亮只落外层容器(此前外环加了但内框蓝还在) |
| refactor | prd-admin | CDS Agent 代码模式工作区改为以文件夹/知识库为主，GitHub 降级为可选钩子 |

### 2026-06-05

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 知识库「AI 文档对话」写回前新增 diff 预览确认闸：replace/append 显示逐行红删绿增、new 可改标题，确认后才落库，让用户感知改动 |
| feat | prd-admin | 知识库「AI 文档对话」面板顶部展示当前调用的「模型 · 平台」（从流式 onStart 透出，不硬编码），提升 AI 调用可观测性 |
| feat | prd-api | AgentUniverse 流式新增 model 事件：内置智能体（文学/PRD/缺陷）适配器透出 gateway 真实解析到的模型·平台，对齐 ai-model-visibility 规则 |
| feat | prd-api | 知识库新增目录列表接口 GET stores/{id}/folders；apply-content 的 new 模式支持 parentId 落到指定目录（校验同库文件夹） |
| feat | prd-admin | 知识库「AI 文档对话」另存为新文档可选择落点目录（目录选择器，按层级缩进），让智能体产出能填充到指定目录 |

### 2026-06-03

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 首页改造（A2 深空玻璃方向）：hero 背景图降级为氛围层（压暗+降饱和+轻模糊+底部 scrim 熔进深空底色），Agent 封面图与功能卡背景统一降饱和并套同一层暗角蒙版，消除卡片画风割裂的拼贴廉价感 |


### 2026-06-07

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | 待发布瀑布加载 offset 计算错误：原 `fragments.length + daysOffset` 会把每批响应的 skip 值二次叠加，从第二次续接起每次跳过几天留下日期组空洞（4→14 应为 4→10），改为 `fragments.length` |
| fix | prd-admin | summary 刷新清空 days 时，本地 `releaseDetailTriggeredRef` 记忆导致详情不再重拉、卡片留空的问题：删本地缓存，以 `entriesOmitted` 为信号，并发去重由 store 端 `loadingReleaseVersions` 兜底 |
| fix | prd-admin | 实时日志 35s 轮询 / 手动刷新会用 first-page 80 条覆盖整个列表，丢掉 cursor 续接的更老历史：刷新路径保留 previous tail（不在 newShas 中的条目）合并 |
| fix | prd-admin | SSE / 后台 `loadCurrentWeek({daysLimit:4})` 会把已通过 loadMoreFragments 累积的 fragments 缩回 4 个：store 端按 date 集合保留 incoming 之外的尾部 |
| fix | prd-api | `MapReleases` 的 `TotalReleases/TotalEntries` 之前从 `view.Releases`（已被 limit 截断）算，chip 计数会偏低：controller 永远以 limit=100 拉 reader，totals 走全量、输出列表按 displayLimit 切片 |
| fix | prd-admin | GitHub 日志刷新合并 tail 时未保留 cursor：原本用 first-page 的 nextCursor 续接，会拉回已经在 preservedTail 里的同一批产生重复条目，改为保留 previous.hasMore / previous.nextCursor |
| fix | prd-admin | GitHub 日志 loadMoreGitHubLogs stale-response 保护：开始时快照 githubLogsRef，若等待期间 refresh 完成（latest.logs 已不含 requestedCursor），丢弃旧 cursor 的延迟响应避免污染新列表 |
| fix | prd-admin | 用户手动「刷新」（force=true）时不再保留旧 fragments tail：尊重用户明确的「全量重载」意图，仅 SSE/后台刷新路径保留 tail |
| fix | prd-admin | 铃铛 openPopover 不再 force=true：原本会清空更新中心页 loadMoreFragments 累积的尾部日期组，让正打开页面的用户瞬间「列表变短」；SWR 5min 新鲜度足够 |
| fix | prd-admin | 已发布列表上限从 8 改为 100：原本若 CHANGELOG 版本 > 8 则永远看不到更老版本，chip 与列表数字会对不齐。summary 模式下 100 个版本元数据仍 < 10kB，几乎零成本 |
| fix | prd-api | ChangelogRefreshWorker 的 ReleasesLimit 从 20 改为 100，与 controller 总是读 releases:100 cache key 对齐，避免 worker 预热的快照永远命中不到前端读取的 key |
| fix | cds | ⋮ 动作 sheet 改 portal 到 body(backdrop 盖满全屏,不再被顶栏 backdrop-filter 裁成只盖顶栏);导航抽屉 inert 改 JSX 同步设置(关闭即移出 Tab 序,无延迟窗口) |
| fix | cds | ⋮ sheet 打开先算定位再切状态,杜绝「锁背景却无 sheet」;登录后 legacy .html 重定向目标改硬跳转,保留服务端 legacy→React 路由重写 |
| fix | cds | ⋮ sheet/backdrop z-index 降到 Radix Dialog(z-50) 之下,修复从 sheet 内动作打开的对话框(如「一键部署」创建)被 sheet 盖住打不开 |
| feat | prd-admin | 知识库划词评论气泡改为头像堆叠（变体 C：最多 3 个真实头像 + 超出 +N + 最右戴线程色 ring）|
| feat | prd-admin | 提交批注后自动激活该线程 → 自动从正文气泡画连线到右侧批注卡，不再需要手动点气泡 |
| fix | prd-admin | 划词批注浮层打开后正文里的选区高亮不再消失（覆盖层模拟选区色，跟随滚动） |
| fix | prd-admin | 划词批注浮层增加「你选中的内容」明确标签 + 引用块样式 + 放大字号和高度，避免写到一半忘记自己选中了哪段 |
| fix | prd-api | peer-sync: P1 修复 PeerNodeService.GetSelfNodeIdAsync 用 SetOnInsert 在已存在文档场景不落库导致 selfNodeId 每次返回新 GUID 的严重 bug（PR #742 Codex/Bugbot）|
| fix | prd-api | peer-sync: 配对码原子 claim（FindOneAndUpdate）防止并发握手同码双用拿到不同 secret（PR #742 Bugbot）|
| fix | prd-api | peer-sync: PeerSync HttpClient 挂 SafeOutbound handler 禁自动重定向，防恶意对端 3xx 跳内网绕过 SSRF（PR #742 Bugbot）|
| fix | prd-api | peer-sync: transfer 接口 push/pull 任一阶段失败时每条目独立报 ok=false，前端不再误显示"成功"（PR #742 Bugbot）|
| feat | prd-api | peer-sync: 缺陷管理（Defect）接入 ISyncableResource 单向 push-only（按 DefectProject 粒度互传，附件传引用元数据）|
| feat | prd-admin | peer-sync: 系统互联页 + 发送到弹窗加进度提示（"正在握手 / 校验配对码 / 交换密钥…"分阶段 + 已用 Xs 秒表），告别空白等待 |
| refactor | prd-admin | 知识库「跨环境同步」tab 下架 skblink_ 路径：横幅引导改走系统互联，弹窗只保留同环境两库配对，砍 GenerateLinkDialog |
| feat | prd-admin | 演讲智能体新增播放态（全屏分屏+键盘控制）：root 封面屏→ Level 1 章节逐屏→ 谢幕屏；←/→/空格/ESC 键盘操作；进度条+章节序号；CSS 入场动画 |
| feat | prd-admin | 演讲创建页大改：上传文件入口（拖拽/点击，.md/.txt，1MB 上限）+ 受众/风格/深度收进「高级选项」折叠面板默认收起+ 文件名自动取标题；落地输入零摩擦+ 奥卡姆剃刀 |
| feat | prd-api | 演讲生成引入 GenerationRunId 指纹（SpeechDeck + SpeechNode 各加可空字段）：每次 claim 一个新 Guid，service 给本批节点打标，swap 前重新读 deck.GenerationRunId 校验，被后来者抢占则放弃本批 + 删自己刚插入的节点；Ready/Failed 终态更新都加 RunId 守卫，避免 stale-timeout 让两个并行 run 互相覆盖（Bugbot High "Overlapping regen corrupts node tree"） |
| fix | prd-api | 演讲删除 deck 同步吊销分享链：扫该 deck 名下所有 speech-agent HostedSite，对应 ShareLink 批量 IsRevoked=true，避免删了演讲但旧 /s/wp/{token} 仍能访问（Codex P2 "Revoke public shares when deleting decks"） |
| fix | prd-api | 演讲 service 在 Ready 终态 UpdateOne MatchedCount==0 时（被新 run 抢占）改发 error 事件而非 done，前端不会误以为本次成功（Bugbot High "Done without Ready confirmation"） |
| fix | prd-api | 演讲 controller onModel 落库带 GenerationRunId 守卫，避免慢的旧 run 覆盖新 run 的 model/platform 元信息（Bugbot Medium "Model update ignores run guard"） |
| fix | prd-admin | 演讲编辑器顶层 onError 与 onEvent.error 调度协同：顶层用 setTimeout 调度 load()，并发拒绝场景下 onEvent.error 同步取消，避免 banner 被秒抹（Bugbot Medium "Concurrency error banner cleared"） |
| fix | prd-admin | 演讲播放页切 deck 时重置 activeIndex / cameraTargetIndex / rawNodes / deck，避免从上一个 deck 的中段开始（Bugbot Medium "Play state persists across decks"） |
| fix | prd-api | 演讲重新发布顺序调整：先插入新分享链，再吊销旧链；新链创建失败时旧链未被吊销，避免死局（Bugbot Medium "Republish revokes before new link"） |
| fix | prd-api | 演讲智能体 SSE 写入：ConnectionResetException 继承自 IOException，只 catch 父类即可（修 CS0160 编译错误，导致 CDS 部署失败） |
| fix | prd-api | 演讲智能体知识库建演讲：支持用户自填标题（空时回落 entry.Title），走 IDocumentService.GetByIdAsync 保持缓存一致，思维导图 JSON 解析兼容 root.children 嵌套（Bugbot Medium 三项） |
| fix | prd-api | 演讲智能体 model SSE 事件：onModel 改为 awaitable Func，落库与 SSE 写入串行化，避免与紧随的 thinking/text 帧交错（Codex P2） |
| fix | prd-admin | 演讲创建页知识库通道：将用户自填标题透传到 createFromDocument |
| fix | prd-api | 演讲智能体发布 HTML：节点图片 URL 走 escapeHtml,堵住属性逃逸 XSS（Bugbot Medium "Published image URL unescaped"） |
| fix | prd-admin | 演讲创建页「填入示例」按钮：同时清空 kbSelectedEntryId / sourceFileName,避免示例文本却跑 createFromDocument（Bugbot Medium "Sample fill keeps KB binding"） |
| fix | prd-admin | 演讲播放页加载错误区分：deck 加载失败/无权/不存在不再误显「无节点」,新增 loadError 状态 + 区分文案（Bugbot Medium "Play load errors show empty"） |
| perf | prd-api | 演讲列表接口 Project 掉 sourceText 字段：每条上限 1MB 的原始文本不再随列表返回（Codex P2 "Exclude source text from deck lists"） |
| fix | prd-admin | 演讲编辑器重新生成不再先抹掉旧节点：用 pendingClearRef 延迟到首个 node 事件再清，并发拒绝/HTTP 失败/SSE 早炸时保留上一轮 mindmap（Bugbot Medium "Regenerate clears nodes without restore"） |
| fix | prd-admin | 演讲编辑器错误 banner 覆盖非终态错误：只要 errorMessage 存在就展示（并发拒绝/SSE 网络错原本静默）（Bugbot Medium "SSE errors hidden from users"） |
| fix | prd-api | 演讲 SourceText 落库前截断到 16K（与 LLM 实际使用一致）：避免 DB 存 1MB 但模型只看 16K 的认知错位，也防止 MongoDB 16MB doc limit 撞库（Bugbot Medium + Codex P2 "Source text not truncated" / "Bound persisted source text size"） |
| fix | prd-api | 演讲发布 HTML 播放器无根节点兜底：root 缺失时不再 throw 整屏白屏，挂错误提示并跳过 build（Bugbot Low "Published player crashes without root"） |
| fix | prd-api | 演讲重新生成：旧节点改为"解析成功后才删 + 插",LLM/解析失败时上一轮 mindmap 不再永久丢失（Bugbot Medium + Codex P2 "Defer deleting old nodes until regeneration succeeds" / "Failed regen shows ghost nodes"） |
| fix | prd-admin | 演讲编辑器挂上 useSseStream 顶层 onError：HTTP 4xx/5xx/fetch 失败不再静默无提示（Bugbot Medium "Editor omits SSE hook onError"） |
| fix | prd-admin | 演讲编辑器切 deck 时重置 autoStarted 旗：新 deck 的 ?autoStart=1 不再被旧 mount 的 ref 卡住（Bugbot Low "autoStart skipped on deck switch"） |
| fix | prd-admin | 演讲创建页 KB 文档选择 pickKbEntry 加 fetchIdRef stale guard：快速切文档时慢响应不再覆盖后选的（Bugbot Medium "KB pick lacks stale guard"） |
| fix | prd-api | 演讲重新生成节点替换改为两阶段 + InsertMany 单批：先 InsertMany 新节点（失败按新 Id 精确回滚），再 DeleteMany 快照旧 Id（按旧 Id 精确删，避免误伤并发），杜绝半棵树（Bugbot High "Node replace not atomic"） |
| fix | prd-api | 演讲 claim 不再归零 NodeCount：旧节点解析成功才删，失败时列表卡片继续显示旧 mindmap 的真实节点数（Bugbot Medium "NodeCount zeroed on failed regen"） |
| fix | prd-api | 演讲重新发布吊销旧分享链：先扫该 deck 名下所有 speech-agent 站点，把对应未 revoke 的 ShareLink 批量置 IsRevoked=true（Codex P2 "Revoke the previous speech share on republish"） |
| fix | prd-admin | 演讲 handleStart 同步清本地 errorMessage：避免上一轮失败的红条与「生成中」并排显示（Bugbot Medium "Stale error banner during regen"） |

### 2026-06-06

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 分支卡标题改单行截断:长分支名不再 break-all 断成单字母、运行模式徽标不再换行孤悬(手机端整屏宽卡片观感修复) |
| fix | cds | 静态资源压缩缓存改为有界(按条数+字节淘汰最旧),避免多次部署后内存无限增长;手机端导航抽屉打开时锁背景滚动 |
| fix | cds | 分支卡服务芯片改用容器图标(Container),标签芯片由绿色改中性色,避免标签被误认为容器 |
| fix | cds | 首页 prefers-reduced-motion 下停止持续动效:隐藏 SVG animateMotion 数据包、停掉虚线流动/logo 旋转/呼吸/扫光等无限循环(虚线本体仍可见) |
| fix | cds | 手机端 app-bar 第二行恢复 center 槽(分支搜索/Git URL 快建),修复窄屏丢失主流程入口;导航抽屉关闭时设 inert,键盘不再 tab 进隐藏导航 |
| feat | cds | 手机端改为原生移动布局:汉堡抽屉导航 + 单行 app-bar 标题 + ⋮ 溢出动作菜单,替换原先"压缩 PC"式常驻图标栏/拥挤面包屑/平铺工具栏 |
| fix | cds | 修复手机端 TopBar 面包屑与动作按钮重叠溢出(branch-list/detail/topology/项目设置 横向溢出归零) |
| fix | cds | 修复项目设置「最近自动部署」长分支名链接未截断导致的横向溢出 |
| fix | cds | 手机端导航抽屉/⋮ 动作 sheet 打开时加焦点陷阱(Tab 不再跑到背后工作区);topbar center 改单实例纯 CSS 重定位,跨断点不再卸载重挂 |
| feat | cds | 首页/登录/内容页转场丝滑化:lazy chunk 预取消除 Suspense 白屏 + 路由 View Transition 溶解 + 登录页入场动画,三页观感一体 |
| fix | cds | 手机端 ⋮ 动作 sheet 支持 Esc 键关闭并把焦点还给触发按钮(配合焦点陷阱,键盘用户不再被困在菜单里) |
| fix | cds | 手机端 ⋮ 动作 sheet 打开时锁背景滚动(与导航抽屉一致) |
| fix | cds | 静态资源压缩按 Accept-Encoding q 值选择,尊重 br;q=0 / gzip;q=0 显式禁用,不再给声明不支持的客户端发压缩 |
| perf | prd-api | 更新中心 `GET /api/changelog/releases` 默认 limit 从 20 降到 8，首屏 JSON 体积大幅缩小 |
| perf | prd-admin | 更新中心首屏只拉 8 个版本，1.5s 空闲后台补到 50 个，用户滚动到底前已备好，消除首屏卡顿 |
| perf | prd-admin | GitHub 实时日志 35s 轮询改为按需启动（仅当用户进入「实时日志」tab 时），不再抢首屏主线程 |
| refactor | prd-api | 删除 `MergeChangelogMarkdownIntoCurrentWeek` 死代码（从未被调用） |
| fix | prd-admin | 「待发布」chip 增加 hover tooltip，显示碎片文件数 + 合并方式提示，避免数字过大产生不切实际的错觉 |
| perf | prd-admin | 更新中心 ChangelogBell / AppShell / AgentLauncherPage 均改用 daysLimit=8 拉 current-week，避免每次页面加载都拉 260kB 全量碎片 |
| perf | prd-admin | 历史发布版本详情改为 IntersectionObserver 懒加载：仅第一个版本（未发布）立即拉，其余版本卡片进视口才拉，避免一次性 700kB 详情压栈 |
| perf | prd-admin | 历史发布渲染逻辑：summary 模式（entriesOmitted=true）下即使 days/highlights 都为空也渲染卡片，让 IntersectionObserver 能挂上 |
| fix | prd-admin | 实时日志 chip 计数显示 0 的 bug：首屏拉一次 limit=80 让 totalCount 准确，不进入轮询 |
| perf | prd-api | 更新中心三个端点支持瀑布式分页：releases 加 summary 模式（只元数据 + 计数）+ by-version 详情端点；current-week 加 daysLimit/daysOffset；github-logs 加 before cursor |
| perf | prd-api | 三个 DTO 新增 totalEntries/totalCount/hasMore/nextCursor，前端 chip 计数从全量取，不受分页切片影响 |
| perf | prd-admin | 更新中心首屏 payload 从 ~474kB 砍到 ~10kB：releases summary 模式 + current-week daysLimit=4 + github-logs limit=80 |
| perf | prd-admin | 历史发布版本详情按需懒加载：summary 到位后并发拉取 by-version，每个版本独立小请求，首屏即可见 chip 计数和高亮 |
| perf | prd-admin | 待发布日期组瀑布加载：滚动到末尾 1 组内自动 fetch 下一批，IntersectionObserver 触发 |
| perf | prd-admin | 实时日志 cursor 分页：首屏 80 条，滚动到末尾 10 条内自动续接更老批次 |
| refactor | prd-admin | useIncrementalVisible 保留用户滚动进度（total 增长时不重置 visibleCount） |
| feat | prd-api | 新增系统级跨节点互传（Peer Sync）：管理员配对对端节点（一次性配对码 + HMAC 互信）+ 通用 ISyncableResource 框架 + node-to-node 数据端点 + 用户发起 push/pull/双向 互传 |
| feat | prd-api | 知识库接入跨节点互传（DocumentStoreSyncResource，支持双向同步，按用户名/邮箱对齐归属，bundle 带 schemaVersion + extras 向下兼容） |
| feat | prd-admin | 新增「设置 → 系统互联」管理页：配置对端节点、生成配对码、测试连通、解除配对 |
| feat | prd-admin | 知识库列表右上角新增「发送到」入口（通用 SendToPeerDialog：选节点 + 多选库 + 选方向，知识库支持双向） |
| feat | prd-api | 产品管理智能体新增产品团队成员管理与产品管理员指派（Product.AdminIds + 成员 list/add/remove/role 端点，分权：MAP管理员/负责人指派产品管理员，产品管理员增删成员） |
| feat | prd-admin | 产品管理智能体单产品视图新增「团队」tab：成员角色徽章、添加/移除、指派/撤销产品管理员（复用 UserSearchSelect） |
| perf | prd-admin | 产品知识图谱关系链视觉精致化：线条更细更透明、箭头更小、激活节点微微浮动+圆点呼吸，减少对节点的视觉干扰 |
| feat | prd-admin | 产品管理智能体新建需求/功能时默认自动套用默认描述模板（描述为空时预填，无需再点「套用模板」） |
| feat | prd-admin | 产品版本改为独立详情页：版本描述(富文本+默认模板)、内联关联需求/纳入功能、生命周期/大版本/父版本编辑、版本知识库入口 |
| feat | prd-admin | 版本/产品知识库增加分类筛选(MRD/SRS/PRD/设计稿/会议纪要/测试用例)与快速新建标准文档(以文档标签实现) |
| fix | prd-admin | 修复产品/版本知识库面板未撑满高度(flex 父容器缺失导致塌成内容高度) |
| feat | prd-admin | 需求/功能/版本/缺陷详情页新增「追溯关系路径」抽屉(右展开70| fix | prd-admin | 修复产品/版本知识库面板未撑满高度(flex 父容器缺失导致塌成内容高度) |
| feat | prd-admin | 需求/功能/版本/缺陷详情页新增「追溯关系路径」抽屉(右展开70%,内嵌图谱自动锚定当前对象高亮全部关联) |
| feat | prd-admin | 知识库分类升级为一等维度：DocumentStoreBrowser 从 store.categories 读分类、按 entry.category 筛选、快速新建、右键改分类、分类管理与标签管理面板、常驻新建文件夹按钮 |
| feat | prd-admin | 客户改为产品管理全局：总览新增「客户」入口(全局客户表+增改删)，单产品移除客户 tab，需求关联客户改用全局客户列表 |
| feat | prd-admin | 新建需求支持 AI 智能填充：粘贴文本→SSE 流式按模板回填标题/描述/分级/自定义字段→用户修改确认 |
| feat | prd-admin | 单产品概览改造为「工作台」：新增「我的待办」面板(指派/负责的需求+功能 + 本产品未关闭缺陷，点击直达)；导航重排为 工作台/报表/看板/版本/需求/追溯矩阵/功能/缺陷/团队/知识库/图谱 |
| feat | prd-api | 新增演讲智能体后端：SpeechDeck/SpeechNode 模型 + SpeechAgentController（CRUD + SSE 生成） + SpeechAgentService（ILlmGateway 流式拆大纲） |
| feat | prd-admin | 新增演讲智能体前端：列表 / 创建 / 编辑器三页 + 思维导图列式视图 + SSE 流式生成 + 节点编辑面板 |
| refactor | prd-admin | 首页「教程中心」承接卡从顶部整条宽 banner 改为搜索框下方的紧凑竖版小卡,让位给智能体卡片(承接元素不该抢主视觉,符合视觉层级) |

### 2026-06-05

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 知识库划词评论新增「右侧批注栏」边读边看布局：评论卡片常驻正文右侧显示头像+名字+内容，与正文高亮 hover 联动 |
| feat | prd-admin | 划词评论支持「批注栏 / 内联」布局切换（右上角，个人偏好持久化），并改为选区就地输入（取代右侧抽屉） |
| feat | prd-api | 新增知识库最近批注聚合接口 GET /api/document-store/stores/{storeId}/recent-comments（按时间倒序，供验收智能体回读用户在验收文档上的批注） |
| feat | prd-admin | 知识库批注强关联：同色锚定（高亮下划线=卡片色条同色）+ 点气泡/卡片激活联动 + active-only 牵引连线 + 批注密集时折叠成一行 |
| fix | prd-admin | 修复批注牵引连线两个边界：高亮/卡片滚出正文可视区时不再画线（避免飞到窗口角/越过顶栏）；连线改连续 rAF 直接改 DOM，跟手不再延迟抖动 |
| fix | prd-admin | 修复批注评审 5 项：composer 提交落到选区所属条目（切档不串档）、删除/激活滚动加 stale 守卫、激活用真实锚点滚动且取消激活不跳视口 |
| fix | prd-agent | read_comments.py：--entry 改用 per-entry 接口拿全量（避免被 store 级 limit 挤出页）、since 查询 URL 编码 |
| fix | prd-admin | 批注评审二轮：创建后乐观插入防 UI 滞留、删光分组清激活态防幽灵连线、只读访客不弹写入 composer、收起批注栏时点气泡自动重开 |
| fix | prd-api | recent-comments 返回补 authorAvatar 字段，与 per-entry 接口对齐供 store 级轮询取头像 |
| fix | prd-admin | 批注评审三轮：连线不再用正文 bounds 误判右栏卡片致误隐藏、抽屉关闭同步 commentsCanCreate、margin/inline 删除按钮加二次确认 |
| fix | prd-admin | 批注删除后 bump fetchId 作废在途刷新，防止删除前的服务器快照晚到把已删评论复活 |
| fix | prd-admin | 批注栏/内联的回复改为落到该线程所属条目（base.entryId），防切档后回复写到别的文档 |
| fix | prd-admin,prd-api | 批注删除按钮按「库主/作者」逐条判定权限（recent list 返回 isOwner+viewerUserId），公开库非作者读者不再看到删不掉的删除按钮 |
| fix | prd-admin | 划词就地输入浮层跟随正文滚动平移，不再因滚动停在错误位置挡错内容 |
| fix | prd-admin | 评论加载 effect 改以 entryId 为依赖，后台列表刷新（同一条目新数组引用）不再清掉正在写的就地浮层/草稿 |
| fix | prd-admin | 评论删除按钮 stopPropagation，避免点删除冒泡到批注卡 root 误切换激活态 |
| fix | prd-agent | read_comments.py --entry --since 改为解析 datetime 再比较，兼容带时区偏移的 ISO 时间 |
| fix | prd-admin | 其它面板增删评论后自增 syncTick 驱动已打开的抽屉重拉，抽屉不再与正文数据脱节 |
| fix | prd-agent | read_comments.py 仅对疑似 storeId（32位hex）做直查，含空格/中文的库名直接走名称查找，不再因非法URL报错 |
| fix | prd-admin | 抽屉内增删评论回调父级刷新（margin/overlay/计数反向同步）；抽屉 load 加 stale-response 守卫防旧响应覆盖 |
| fix | prd-admin | 评论抽屉的删除按钮同样按库主/作者逐条判权（之前仍用 canCreate）；收起批注栏时点已激活气泡强制重开并保持激活 |
| perf | prd-admin | 首页「实用工具」区首次出现延迟减半(2x 加速,utilitiesHeader 400→200 / cardBase 420→210),step 与其它区动画不变 |
| fix | prd-admin | 首页搜索框移到问候/副标题下方(靠左),教程承接卡独占右上(靠右),不再与搜索堆叠在右上角 |
| fix | prd-admin | 修复学习中心首屏 progress 未就绪时 `progress.items` 空指针崩溃(快速导航进入的竞态,验收自动捕获 P0),与同文件 line41 一致改 `progress?.items` |
| fix | prd-admin | 修复 TabBarItem 接口 dataTourId 重复声明导致 tsc 失败 |
| fix | prd-admin | 网页托管：已分享站点卡片/列表的按钮由「一把全撤」改为「分享管理」单按钮，点击打开 scope 到该站点的分享面板（看链接/复制/单条取消/续期/新建都在里面），去掉 inline 轻确认与整站盲撤 |

### 2026-06-04

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 容器编译/构建失败导致就绪探测超时时，从容器日志抽取真实根因（如 error CS0101）点名到 errorMessage，不再只显示笼统的"就绪探测超时" |
| fix | cds | 分支卡片错误归类把"就绪探测超时/编译失败"正确归为「应用代码错误」，不再误落到「未分类错误」让用户误以为是 CDS 自身问题 |
| fix | cds | failure-diagnosis 新增 build-failed 归类（C#/TS/MSBuild 编译失败 → 代码侧）+ 兜底识别中文「就绪探测超时」 |
| refactor | cds | 漂移徽标「收敛」措辞改为「重新部署」，去掉用户看不懂的「异常收敛」内部术语 |
| feat | cds | 部署失败时把自动诊断的根因（如 error CS0101）+ 容器日志尾部写进 GitHub PR Check 的 output，sandbox agent 无需 CDS 凭据/网络即可经 GitHub 读到失败原因 |
| feat | cds | 被动授权:新增「请求密钥(cdsr_)+ 授权密钥」两级凭据 — Agent 持永久低权限请求密钥发起授权申请,右下角一键批准即派发全权授权密钥,Agent 凭它直接读项目环境变量/参数,无需用户反复手动喂参数 |
| feat | cds | 项目设置新增「授权密钥」tab 签发/吊销请求密钥;AppShell 右下角新增「授权申请」审批盒(复用 pending-import 被动审批底座 + SSE 实时刷新) |
| refactor | cds | 被动授权改为最短路径:删除「请求密钥」概念与项目设置「授权密钥」tab,改为 Agent 免密直接发起授权申请(按项目限量防刷)+ 一次性 pollToken 取结果,用户只需右下角一键批准,前置步骤归零 |
| fix | cds | 修复授权申请轮询用项目 slug 时误报 404:轮询端点改用 getProject 把 slug/id 统一解析为 project.id 再比对(发起存的是 project.id,真实环境用 slug 轮询会漏判) |
| fix | cds | 被动授权审批加固:approve/reject 仅限登录用户(cookie/GitHub),拒绝机器密钥——杜绝项目 A 的 cdsp_ key 批准项目 B 申请的跨项目越权;批准签发授权密钥失败时回滚已签发 key 防游离;失败诊断 check-run 文本截断只砍日志尾部、保住顶部根因 |
| fix | cds | 被动授权二轮加固:github 鉴权模式同样放行免密发起/轮询(抽 isPublicAccessRequestRoute 共享,防两网关漂移);授权申请列表改登录用户专属(机器密钥不得跨项目枚举申请方/用途);一次性 authorizationKey 明文加入 HTTP 日志 redactor(authoriz),不再落 cds_http_logs |
| fix | cds | 被动授权三轮加固:disabled 鉴权模式放行审批(本地 dev 操作员即用户,否则 403 用不了);轮询票据改 X-Poll-Token header only,去掉 ?token= query(URL 会进 HTTP 日志/activity 广播不脱敏,泄露可取密钥的票据);审批人身份读 cdsUser.githubLogin(github 模式审计不再全记 operator) |
| fix | cds | 失败根因 check-run 只诊断本次 startup-plan 的活跃服务:传入 activeProfileIds 过滤 zombie(已删/改名残留)error 服务,与 deploy 主路径 hasError 同口径,避免把旧 profile 日志当本次根因 |
| refactor | cds | CDS 主页与登录页统一为黑色 ShapeGrid 蜂窝风格，移除紫色渐变背景 |
| fix | cds | 主页 Enter Console 按钮改为跳转登录页（带 redirect 回项目列表），不再直接进入未登录的项目列表 |
| fix | cds | 主页/登录页背景调亮，蜂窝栅格更通透（提高底色与网格线亮度、减弱压暗叠层） |
| feat | cds | CDS 首页重做为 Railway 风格：纯黑白灰 + 项目拓扑画布动效（部署数据包沿连线流动）+ 蜂窝/粒子/辉光背景 |
| refactor | cds | 登录页背景统一为首页同款蜂窝纹+粒子+辉光，视觉与首页一致 |
| feat | prd-api | 更新中心数据终身存储到 MongoDB（changelog_snapshots），加载只读存量绝不空白 |
| feat | prd-api | 更新中心后台固定周期自动刷新（默认 4h，Changelog:RefreshIntervalHours 可配），与用户访问解耦 |
| feat | prd-api | 更新中心新增 SSE 推送端点 /api/changelog/stream，后台刷新有更新时主动推到页面 |
| feat | prd-admin | 更新中心头部展示「更新时间 + 更新规则（每 N 小时自动刷新·终身缓存）+ 实时同步状态」 |
| feat | prd-admin | 更新中心订阅 SSE，服务器有更新自动推送并静默重读存量，无需手动刷新 |
| fix | prd-api | 更新中心冷实例 hydrate 到陈旧快照时也后台静默 revalidate，与热缓存路径对称（修复重启后首请求停在旧快照需等 Worker 周期的不对称） |
| fix | prd-api | 更新中心快照 GetAsync 改按 UpdatedAt 倒序取最新；登记 changelog_snapshots.Key 唯一索引（防多实例并发 upsert 重复行） |
| fix | prd-admin | 更新中心 GitHub 日志在途刷新期间到达的 SSE update 改 trailing-edge 补跑，不再被吞 |
| fix | prd-admin | 更新中心 SSE 流干净结束时也清掉「实时同步」徽标并触发重连，不再虚标连接健康 |
| fix | prd-admin | 更新中心 loadCurrentWeek/loadReleases 冷加载在途时也 trailing-edge 补跑 SSE 重读，避免页面停在旧快照 |
| fix | prd-admin | 更新中心 trailing-edge 补跑保留 force 意图，避免冷加载在途时用户硬刷新被降级为只读重读 |
| fix | prd-api | 更新中心快照 UpsertIfChangedAsync 比对读也按 UpdatedAt 倒序，与 GetAsync 一致，重复行下不比错行 |
| fix | prd-api | 更新中心快照写入改为定向更新最新行(按 Id)，变化检测/写入/hydrate 三者命中同一记录 |
| fix | prd-admin | 更新中心 store 加单调请求号 stale-response 守卫，丢弃乱序旧响应，防旧拉取覆盖 SSE 新数据 |
| fix | prd-api | 更新中心 GitHub 路径区分「拉取失败」与「目录确实为空」：空目录落库+推送清空待发布列表，不再永远 hydrate 旧非空快照 |
| fix | prd-api | 更新中心 GitHub 待发布：碎片全部 raw 拉取失败致空时标记不可用，避免假空覆盖好快照 |
| fix | prd-api | 更新中心 GitHub 待发布任一碎片拉取失败即不落库（保留完整旧快照），避免持久化不完整列表 |
| fix | prd-admin | 更新中心 GitHub 日志后台/SSE 成功刷新也清错误横幅，不再失败后残留红色提示 |
| fix | prd-api | 更新中心拉取失败回退最佳存量(内存→DB)无视 force，避免冷实例硬刷新返回空视图覆盖好 UI |
| fix | prd-admin | 知识库访客记录抽屉：登录访客渲染真实头像（原永远显示通用占位图标）、暗色面板改不透明避免页面头部穿透、补 createPortal + ESC 关闭、停留时长为 0（leave 信标未送达）显示「—」而非误导性「< 1 秒」 |
| fix | prd-admin | 知识库访客记录列表行紧凑化：缩小行内边距/头像、时间+停留靠右填充原本空荡的右侧 |
| fix | prd-admin | 修复 DocBrowser 文档列表前导图标大小不一：图标外包 flex-shrink-0 容器，避免长标题时 SVG 被 flexbox 压缩 |
| fix | prd-admin | 移除 DocBrowser 订阅条目的状态小圆点（出错红点等），不再为单个小点占用整行徽章行 |
| feat | prd-api | 新增知识库访客聚合报表端点 GET /stores/{id}/analytics（按天趋势/24h时段/文档排行/停留分布/KPI，MongoDB $facet 聚合，支持时间档 days + 本地时区 tz） |
| feat | prd-admin | 访客记录抽屉升级为聚合报表：时间档切换（7/30/90天）、KPI 扩展（平均停留/回访率/跳出率）、访问趋势折线 + 24h时段柱图（ECharts）、停留分布条、文档访问排行、CSV 导出 |
| feat | prd-api | 新增账号级访客总计端点 GET /stores/analytics-summary（聚合我名下所有知识库的总访问/独立访客/总停留） |
| feat | prd-admin | 知识库「我的空间」统计行内联扩展账号级总计：在「共 N 个知识库 · M 篇文章」后追加 总访问/访客/总停留 |
| feat | prd-api | 访客报表/明细端点重构为「按 storeIds 聚合」可复用，新增账号级 GET /stores/analytics-all 与 /stores/view-events-all（聚合我名下所有知识库） |
| feat | prd-admin | 知识库列表页新增「统计」按钮（分析全部知识库），知识库内「访客」按钮改为「统计」（分析本库）；ViewersDrawer 支持 account 范围复用同一报表 |
| feat | prd-admin | 账号级访客总计数字 count-up 缓动 + 整段淡入，避免异步加载后突然蹦出撑宽统计行 |
| fix | prd-admin | 知识库列表页统计行左右重排：功能区（库数/文章数）居左，统计区（访问/访客/停留）移到右侧，统计按钮再往右 |
| feat | prd-api | 访客聚合报表新增「知识库访问排行 topStores」「标签访问统计 tagStats（lookup 文档标签聚合）」，文档排行/流水补 storeId 供点击跳转 |
| feat | prd-admin | 访客统计抽屉新增 最受欢迎文档(可点击跳转)/知识库访问排行(可点击)/标签访问统计；点击文档排行或流水中的文档直达对应知识库并打开该文档 |
| fix | prd-admin | 修复 Bugbot 反馈：访客报表切时间档加 seq 守卫防旧响应覆盖；账号总计 count-up 动画期间数字取整，避免闪现小数 |
| fix | prd-api | 修复 Codex/Bugbot 反馈：访客报表 $match 下界对齐 trend 首日本地零点（KPI/排行与趋势之和一致）；账号级三端点排除 PmProjectId 项目库，与「我的空间」列表口径一致 |
| fix | prd-admin | 订阅源同步状态改用 Rss 图标变色表达（出错红/暂停琥珀/同步中蓝/健康灰）+ title，恢复异常状态在文档树的可见性，且不再独占徽章行 |
| feat | prd-admin | 证据板加交互解「线条错综复杂」:点任意节点进入聚焦(高亮它的连线+直接相连节点、其余淡出)+ 底部信息面板用文字列出「这张证据证明了哪些诉求/这条诉求由哪些证据证明」+ 顶部「只看未完成(N)」开关折叠已落地、突出部分/未做 |
| refactor | prd-admin | 验收报告「证据图」重构为真·证据板:解析报告「需求一一对应表/验收用例」,把 诉求/用例 → 证据截图 → 结论 连成真关系图(左诉求·右证据·连线=被这些图证明),节点按 通过/部分/未做 上色 + 图例;废弃旧的"步骤按文档顺序串成假箭头"图;无对应表的旧报告优雅降级为纯证据截图竖排 |
| feat | prd-api | 知识库跨环境/本地库↔库同步引擎：新增 DocumentStoreSyncController（令牌链接配对 + 双向手动推送 + 血缘 ID 幂等 upsert + 签名快照变更检测），令牌永久有效，复用 export/import 数据形态 |
| feat | prd-api | DocumentStore 新增 SyncToken 字段 + 新增 document_store_sync_links 集合（DocumentStoreSyncLink 配对记录） |
| feat | prd-admin | 知识库新增「跨环境同步」页签：启动链接（粘贴对方链接，跨环境/本地两库二选一）+ 生成连接链接 + 配对列表（单向/双向切换 + 立即同步 + 撤销）；知识库详情右上角显示同步状态徽章（已同步/待同步/出错） |
| fix | prd-admin | 知识库手机端阅读头部:徽章/标签不再挤出右边缘相互重叠——移动端 header 允许换行(flex-wrap),隐藏「更新于/更新者」+ new/订阅徽标(其 ml-auto 会顶出窄屏);桌面端不变 |
| fix | prd-admin | 知识库手机端友好:DocBrowser 移动端改「主从单栏」(列表与正文一次只显示一个+「目录」返回按钮),不再把正文挤成右侧细栏;移动端隐藏拖拽把手+右侧章节导航 TOC、正文内边距收窄;桌面端布局零改动。同步惠及分享链阅读页/周报页(共用 DocBrowser) |
| feat | prd-admin | MAP 加载器改版：9 款现代字标设计 + 3 款紧凑 spinner，整页锁定随机抽取（同一会话内全部 loader 统一样式，刷新换款），笔触描边为加权默认款 |
| fix | prd-admin | 修复新手引导 Spotlight 气泡溢出视口:用实测高度替代硬编码 180px 估高,卡片夹进视口 + 中段可滚 + 底部「下一步/完成」常驻可点,解决「点不到完成 → 走不完 → 不存储 → 每次进页重弹」 |
| fix | prd-admin | 修复「教程被小技巧拦住了」:Spotlight 教程开讲时自动收起教程抽屉,避免抽屉浮层(右上角)盖住被高亮的页面元素,导致光圈打在抽屉自己卡片上 |
| fix | prd-api | 网页托管退役「本周改动」碎片教程(webpages-feature-2026w22),其排序/分组/视图/提亮内容已并入 14 步系统教程,一页只保留一个体系化教程 |
| feat | prd-api | 开放接口网关 Phase 2：按 Key 限流桶（每分钟速率）+ 每日请求/Token 配额拦截（429）+ 配额阈值(80/100%)与专属模型降级管理预警（按天去重）+ 当日用量统计 |
| feat | prd-admin | 开放平台「开放接口」tab 增加每 Key 限额编辑（每分钟/每日请求/每日token）与今日用量展示 |
| feat | prd-api | 开放接口 Phase 3：model 走 Key 模型白名单（客户可在白名单内自选，越界 400 model_not_allowed，第一个为默认，空=默认池）+ GET /api/v1/key 密钥自省 + 响应 id 与日志 requestId 同源 + X-RateLimit-* 头 + 输入大小上限(400 input_too_large) |
| feat | prd-admin | 开放接口 tab 绑定改为模型白名单编辑（chips 增删 + 首个为默认）；/v1/models 反映白名单 |
| docs | doc | 新增 guide.open-api 接入指南（quickstart + 契约 + 白名单语义 + 自省/限流/可观测性） |
| fix | prd-api | 开放接口流式 chat 在错误/异常/无 Done chunk 退出时补发 `data: [DONE]` 终止符，兼容 OpenAI SDK 收尾 |
| fix | prd-api | 开放接口每日请求配额改用 INCR-then-check + 超额回滚，消除"读-判-写"竞态 |
| fix | prd-admin | 开放接口本页教程步骤补 tab-gated 锚点回落，默认 tab 非开放接口时不卡步 |
| fix | prd-api | 开放接口准入把每日请求配额校验移到速率窗口前，日配额拒绝不再白白占用分钟桶槽位，速率拒绝回滚日配额占用 |
| fix | prd-api | 开放接口输入字符上限纳入多模态 image_url（base64 数据 URI），大图不再绕过 MaxInputChars 直打上游 |
| fix | prd-api | 开放接口准入改单条 Lua 原子脚本（速率+每日请求配额合并），消除读-判-写竞态/日配额拒绝占速率槽/fail-open 后悬挂计数三类边界 |
| fix | prd-admin | 开放接口模型白名单选择器补「模型池 code」选项，可让客户走整池故障转移而非钉死单模型 |
| fix | prd-admin | 开放接口本页教程第 2 步起带 ?tab=open-api 跳转，确保切到开放接口 tab 后 stats/list 锚点已挂载 |
| fix | prd-api | /v1/models 修复"JWT 会话 + 有效 sk-ak 密钥"被误判无效 key→401（TryLoadKeyFromAuthAsync 会话取不到 key 时回落 ApiKey 认证） |
| fix | prd-api | /v1/models 仅把 sk-ak-* 视为开放接口密钥凭据，平台 X-AI-Access-Key/旧 sk- App key 做模型发现不再被误 401 |
| fix | prd-api | 开放接口流式 chat 在流开始前上游失败时返回 502+JSON 错误，不再伪装成 200 空流让客户端误判成功 |
| fix | prd-api | 开放接口流式 chat 日志状态码取客户端实际收到值（pre-stream 错误记 502 而非 500），按 requestId 排障一致 |
| fix | prd-api | /v1/models 对有效但缺 open-api:call scope 的 Key 返回 403，避免越权发现开放接口模型绑定 |
| fix | prd-api | 开放接口输入字符上限纳入 tools/functions schema，大工具定义不再绕过 MaxInputChars |
| fix | prd-api | 开放接口绑定失效检测：绑定的模型/池被删改导致回落默认调度时补发降级预警，不再静默跑共享默认池 |
| fix | prd-admin | 开放接口客户列表加载失败时清空行数据，避免汇总/列表展示过期 Key 数据误导运维 |
| fix | prd-admin | 开放接口模型池加载失败时清空 pools，避免白名单选择器展示已下线/过期池选项被误存进 Key |
| fix | prd-api | 开放接口流式 chat 收到 Done 后不再立即 break，继续读完上游迭代器让 LlmGateway 完成 FinishStreamLogAsync，避免成功请求日志卡 running 被误判超时 |
| fix | prd-api | 开放接口本页教程第 2-6 步移除 tab 逗号兜底（querySelector 文档顺序会让 tab 永远命中），聚光灯正确落在内容区 |
| fix | prd-api | 开放接口 chat/image：[Authorize] 通过但 AgentApiKey 行查不到（鉴权后被删）时返回 401，堵住无 Key 绕过限流/配额的旁路 |
| fix | prd-api | 开放接口流式 chat 在流开始前异常时回 500 + OpenAI 形状 JSON 错误体（此前只设状态码、Content-Type 仍是 event-stream 致空响应） |
| fix | prd-admin | 开放接口调用日志加载失败时清空 logs，避免运维复制到过期 requestId 用于排障 |
| chore | prd-api | AgentApiKeysController 显式 using 父命名空间引用 OpenApiController.ScopeCall（跨命名空间引用更清晰） |
| docs | prd-api | guide.mongodb-indexes 补 open_api_request_logs 索引（KeyId+CreatedAt / CreatedAt / RequestId / 可选 TTL），按 no-auto-index 规则由 DBA 手动建 |
| fix | prd-admin | 开放接口列表刷新后同步已打开抽屉的 detail 到最新行，头部今日用量/限额默认不再停留在打开时快照 |
| fix | prd-api | 开放接口流式 chat 中途失败时也调 RecordUsageAsync，已产生 token 计入配额并跑降级预警，不再漏记 |
| fix | prd-api | 开放接口生图先解析模型再占配额：MODEL_NOT_FOUND 时不再空烧客户每日额度/限速槽 |
| fix | prd-api | 开放接口 chat 解析失败/流前上游错误（零输出）时退回每日请求额度（新增 RefundDailyRequestAsync），不空烧客户配额 |
| fix | prd-api | 开放接口 ReadBodyAsync 改有界读取 + Content-Length 早拒（8MB 原始上限），超大 body 不再无限读爆内存/CPU |
| fix | prd-api | 开放接口退配额覆盖所有零输出失败路径：chat 非流式/流式异常 catch + image 上游失败/异常（image 用 reserved 标记避免误退未占额请求） |
| fix | prd-api | 开放接口绑定失效预警移除反向前缀 act.StartsWith(exp)：该方向非 ModelResolver 匹配档，会吞掉"绑定被删回落更长默认模型"的降级预警 |
| fix | prd-api | 开放接口流式 catch 退额前先快照 HasStarted，避免写完 JSON 错误体后 HasStarted 翻 true 导致零输出 pre-stream 异常不退额 |
| fix | prd-api | 开放接口超大请求体返回 413 input_too_large（ReadBodyAsync 区分超限与格式非法），不再与"格式非法"共用 400 误导客户端 |
| fix | prd-admin | 开放接口客户列表加载失败时一并关闭详情抽屉，避免列表清空而抽屉仍展示过期 Key 数据 |
| fix | prd-admin | 修复「本页教程」打开却弹出别页教程:教程抽屉改为按当前路由作用域过滤,移除随机兜底,无本页教程时给空态+「浏览全部」入口 |
| fix | prd-admin | 修复多步引导连续找不到锚点时旧光圈滞留导致「每步都指向同一元素」的错觉(SpotlightOverlay 切步时若目标不在 DOM 先清光圈改显「正在定位」) |
| fix | prd-admin | 本页没有任何教程时不再显示「本页教程」入口按钮;按钮显隐与抽屉作用域共用 filterPageTips 单一过滤逻辑(SSOT) |
| fix | prd-admin | 移除「本日首访自动展开教程抽屉」兜底:不再在用户未点按钮时自动弹出残留公告类教程,教程入口统一走页头常驻按钮(仅管理员定向推送 + 未走完 page-guide 的 Spotlight 仍自动) |
| feat | prd-admin | 学会的本页教程(*-page-guide)按钮保留可随时重看:学会后停止自动开讲/入口脉冲,抽屉显示「已学会」标签,入口仍在 |
| fix | prd-api | /visible 对 *-page-guide 学会后不再过滤(仍返回并带 learned=true),供前端保留重看入口;非 page-guide 学会仍隐藏 |
| fix | prd-admin | 引导气泡「下一步/完成」按钮始终钳进视口:按实测气泡高度限制 bubbleTop + 气泡 maxHeight 自滚,修复高亮元素过高/贴底时完成按钮跑到屏幕外点不到 |
| fix | prd-admin | 图谱抽屉按钮文案「新窗口打开详情」改为「查看详情」 |
| fix | prd-api | 修复 CDS 构建失败 CS0101：ProductAgentController 的 AddCommentRequest 与 PmAgentController 同名冲突(同命名空间)，重命名为 ProductCommentRequest |
| feat | prd-api | 图谱节点 AI 摘要端点(items/{type}/{id}/summary，需求/功能/缺陷)：剥离 HTML 后走 ILlmGateway 生成 2-3 句概括；注册 AppCaller product-agent.graph-summary::chat |
| feat | prd-admin | 图谱抽屉不再糊原始 HTML：默认显示干净纯文本节选 + 「新窗口打开详情」+ 「AI 摘要」按钮(2-3句概括，需求/功能/缺陷通用) |
| fix | prd-admin | 图谱抽屉:关联客户/归属版本显示实际名称(米多网络/V0.1)而非数量;需求/功能/缺陷首次展开自动 AI 摘要(系统仅自动一次)，去掉原始描述节选，之后由用户「重新摘要」 |
| feat | prd-admin | 富文本编辑器粘贴自动去底色：cleanPastedHtml 剥离来源页背景/颜色/字体/对齐等表现型样式与 class/style，只留结构，融入当前主题；工具栏新增「清除格式」按钮一键洗已粘贴内容 |
| feat | prd-api | AI 摘要服务端缓存(product_item_summaries)：同一需求/功能/缺陷只在首个打开者触发 LLM 生成并落库，其他人读缓存不重复调用；summary?force=true(重新摘要)才重算覆盖 |
| feat | prd-admin | 图谱抽屉 AI 摘要走缓存：自动摘要读缓存(无则首个人生成)，「重新摘要」force 覆盖；显示「由 X 生成」 |
| feat | prd-admin | 图谱追溯模式:追溯线条与箭头改用母体(追溯锚点)对象的类型颜色,线条加粗,替代统一琥珀色,更清晰好看 |
| feat | prd-admin | 图谱追溯线条改为按每条边各自母体(来源节点)的类型色着色,同一追溯网呈现多种颜色 |
| fix | prd-admin | 教程入口呼吸灯常驻:每个页面的「本页教程」入口持续呼吸(新人强脉冲/老人柔和呼吸),让用户随时知道教程存在 |
| fix | prd-admin | 首页(登录落地页)不再自动弹出教程抽屉,只展示通知;首页若有专属教程仍走 Spotlight 自动开讲 |
| fix | prd-admin | 教程抽屉严格按页过滤:当前页绝不展示其他页面的教程(page-guide 及带导览的小技巧只在匹配路由显示,定向私信/纯公告不受限) |
| fix | prd-admin | 重设计右下角通知卡片:左侧等级色条 + 图标徽章 + 两段式底部操作(批量行/单条行),修复按钮换行错乱 |
| feat | prd-admin | 通知新增「免打扰」防打扰机制:可暂停 1 小时/4 小时/今天剩余时间,期间通知不自动弹出只留安静铃铛,点击即恢复 |
| fix | prd-admin | 通知卡固定贴右下角(bottom:20):删除为已移除的「教程小书」预留底距的遗留逻辑(notifCardBottom/FLOATING_DOCK_HEIGHT_EVENT),修复通知卡停在半空中而非真正右下角 |
| fix | prd-admin | 免打扰到期后通知卡自动恢复:snooze 不再置 toastCollapsed,避免免打扰窗口结束后卡片永久收起(Bugbot) |
| fix | prd-admin | matchPageGuide 与抽屉过滤统一 strip query/hash:防止带 query 的 actionUrl 在抽屉显示却不触发 Spotlight/脉冲(Bugbot) |
| fix | prd-admin | 教程抽屉自动展开 effect 把 location.pathname 纳入 deps:修复首页守卫导致导航后 effect 不再触发、整 session 不再自动弹的问题(Bugbot) |
| fix | prd-admin | 教程抽屉 editor 分支也 strip query/hash:与 matchPageGuide/非 editor 分支统一口径,防带 query 的编辑器教程出现「Spotlight 触发但抽屉看不到」漂移(Bugbot) |
| fix | prd-admin | 抽取 routeMatchesActionUrl 统一路由比对(strip query/hash):matchPageGuide/tips 过滤/pageMatchedIndex/handleOpenTip 全走同一实现,根治带 query 的 actionUrl 在轮播选中/CTA 导航/抽屉显示间的连环漂移(Bugbot),并加单测锁定 |
| fix | prd-admin | 教程抽屉页面过滤不再用 isTargeted 豁免:后端 isTargeted 会被 Track 的 Delivery 污染(看过即变 true),改以 isPageBound 为唯一判据,防止看过的全局本页教程泄漏到其他页起空锚点 tour(Codex P2) |
| fix | prd-admin | 教程 CTA 导航保留 query 作为目标状态:页面匹配 strip query,但 handleOpenTip 对带 query 的 actionUrl(如 /settings?tab=nav-order)要求 pathname+query 完全一致才算已到,否则 navigate 切到目标 tab,修复同 pathname 不同 tab 时 tour 超时(Codex P2) |
| fix | prd-admin | 抽取 tipNavTarget 统一「是否导航+导航到哪」:强制自动开讲 effect 与 handleOpenTip 同口径保留 query 作为目标状态,修复带 query 的本页教程自动开讲时不切 tab、tour 找不到锚点还被标记已开讲(Bugbot),并加单测 |
| fix | prd-admin | 强制自动开讲 effect 回退到仅写 payload,不在同 tick navigate:避免 overlay 同步消费 payload 后在旧 tab 找锚点的竞态;页面内跳转由 tour 各步 navigateTo 在 overlay 内统一驱动(Bugbot) |
| fix | prd-admin | 根治教程导航竞态:首步导航统一搬进 SpotlightOverlay(读 payload 时按 steps[0].navigateTo 切路由,navigate 与 poll 同组件无竞态)。auto-start effect 不再 navigate;handleOpenTip 仅对无导览步骤的单 selector tip 兜底导航。带 query 的本页教程(如 /settings?tab=nav-order)在任意 tab 自动开讲都会先切到正确 tab(Bugbot/Codex 根治) |
| fix | prd-admin | 修复「本页教程」面板出现其他页面教程：被投递(isTargeted)的页面教程改为按 actionUrl 页面限定，仅无落点页面的纯个人消息不限页面 |
| feat | prd-admin | 教程入口:点「本页教程」始终展示完整列表(不再「只有一套就直接开讲」跳过列表) |
| feat | prd-api | 教程难度分级(初/中/高)+ 经验值/等级:完成教程按难度攒经验(初10/中20/高40),progress 端点新增 xp/level/levelName/xpToNext,visible/progress 下发 difficulty+xpReward(难度缺省按步数推断,可显式上调) |
| feat | prd-admin | 头像徽章显示等级;学习中心新增等级/经验进度条 + 每条教程难度徽章 + 经验奖励 |
| refactor | prd-admin | 下线「系统设置→小技巧管理」编辑页 + 删除 AdminDailyTipsController(create/update/delete/push/seed/reset),教程统一为代码内置 seed(BuildDefaultTips),visible/progress 自动并入无需手动 seed |
| feat | prd-admin | 学习中心从百宝箱(wip)升为「基础设施」一级导航;首页顶部新增「教程中心」承接卡(展示等级+掌握度,点击进 /learning-center) |
| feat | prd-api | 新增 GET /api/daily-tips/progress 学习进度端点(官方教程目录 SSOT + 掌握度统计) |
| feat | prd-admin | 教程高亮支持「镂空可点」: 用户可亲手点高亮目标推进, 不再被整屏遮罩拦截 |
| feat | prd-admin | 教程走完后新增「飞回教程入口」毕业帽动画, 提醒以后从右上角 pill 重看 |
| feat | prd-admin | dailyTipsStore 接入学习进度(loadProgress + markLearned 乐观更新) |
| fix | prd-admin | 修复 TabBar TabBarItem.dataTourId 重复声明导致 tsc 报错 |
| feat | prd-admin | 教程抽屉由轮播改为「选择面板」: 本页多套教程列卡片(步数/约时/状态/跟我做), 单套点 pill 直接开讲 |
| feat | prd-admin | 新增「学习中心」页(百宝箱): 按分类列全部官方教程 + 掌握度环 + 一键跟我做/重看 |
| feat | prd-admin | 头像外圈新增教程掌握度进度环(满环毕业角标), 头像下拉新增「我的学习进度」入口 |
| feat | skill | 视觉验收技能 harness v1.0：运行时错误自动捕获（console.error/同源4xx-5xx/未捕获异常 自动判级，P0 成归档硬门禁）+ 机读 result.json + dark-only 双主题探测 + 可选过程视频 + 导航 timing；自测 10/10 通过 |
| docs | doc | 视觉测试协议 #605 bump v0.1→v1.0（矩阵加路径/运行时维度、失败表加主题归因/规则文件/修复指向列、证据包段）；standard-v2 §5.3-5.5；rule.issues-system §5 镜像同步 |
| fix | prd-admin | 网页托管列表的排序/视图/分组偏好用 localStorage 持久化，刷新/重开浏览器后不再重置 |
| fix | prd-admin | 更新中心-周报正文 mermaid 代码块改为渲染图表，不再显示为高亮源码 |
| feat | prd-admin | 周报「关键更新脉络」timeline 改用自研纵向时间线组件（按天分组卡片），替代 mermaid 横向布局解决"看不清"；其余 mermaid 图仍走 MermaidDiagram |
| fix | prd-admin | DocBrowser cards 模式（周报）补回可拖拽分隔条，列表宽度可调，对齐知识库 inset 模式 |
| fix | prd-admin | 周报 Tab 移除 minHeight 560px 魔数，改走 flex 链撑高，修复内容溢出把顶部菜单栏顶出视口 |

### 2026-06-03

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 自更新历史进度条修复:重启前「等待分支操作排空」(可达 180s)此前不计入任何 step,导致各段之和远小于总耗时——进度条大片留白、看不出时间去哪了。后端把排空等待计入 `timings.drainMs`(self-update + self-force-sync 两处),前端进度条新增「等待排空」段 + 把残余未计量时间补成「其他」中性段铺满进度条 + 新增「总计」chip 让账对得上 |
| feat | cds | 进行中的自更新新增「预计进度条」:以历史成功记录各阶段中位数当预期时间线,按当前阶段 + 已用时长把对应段填实、未到的段淡显,并显示「已用 Xs · 预计约 Ys」,让用户对"还要多久"有大致预期而不是空盯秒表;超出预期时高亮提示 |
| fix | cds | `fmtMs` 时长格式 ≥60s 改用「X.X min」,180s 排空等待等长耗时更易读 |
| feat | cds | 预计进度条左侧显示总进度百分比 + 「预计还需 ~Zs」倒计时(超预期封顶 99%) |
| fix | cds | 修复进行中进度条阶段映射(Bugbot #716):①`nginx-render`/`cache`/`analyze` 不再误归到末尾重启段而跳到 ~100%;②后端排空等待前先把 step 切到 `drain`,UI 实时高亮「排空+重启」段而非停在 web-build 干等 180s;③`validate-timings`/`validate-done` 等过渡步骤改走 elapsed 兜底,不再误高亮类型校验。step→段改用精确映射表,过渡步骤按已用时长定位 |
| fix | cds | 预计进度条逐段兜底(Codex #716):某段在历史里没样本(旧历史缺 drainMs / hot 模式缺后端段)时用基线值补上而非留 0 宽,避免新加的排空+重启段零宽、ETA 漏算那段最长 180s 的等待 |
| fix | cds | 预计进度条时钟对齐(Bugbot #716):进度条 elapsed 改以后端 `activeSelfUpdate.startedAt` 为锚点,与同源的 step 配同一时钟,缺失再退回客户端 runStartedAt。修从本 tab 触发更新时百分比/段填充/「预计还需」与真实阶段对不上;同时面板副标题「执行中 · Xs」也改用同一 elapsed,避免标题与进度条「已用」打架 |
| fix | cds | `validate` 步骤不再钉死 install 段(Codex #716):后端整段校验只发一个 `validate` step(install+tsc 合一),钉死 install 会让 tsc 期间进度条卡住;改为走 elapsed 兜底,随时间从 install 平滑推进到 tsc |
| fix | cds | 自更新历史数据源上移(Bugbot #716):进度条与历史列表共用 `useSelfUpdateHistory` 一份数据,不再各自 fetch 同一 endpoint,消除进度条挂载初期空 fetch 期间误显「暂无历史 · 粗略估算」 |
| fix | cds | 预计进度条 percent/填充/「预计还需」统一时钟(Bugbot #716):三者改由单一 `progressedMs`(step 给下限 + elapsed 推进 + 封顶)派生,修「早期阶段比中位数快时百分比冲顶但预计还需仍很大」的自相矛盾 |
| perf | prd-api | 更新中心「待发布」GitHub 兜底逐文件拉取限并发(8)，避免数百碎片打爆连接池/限速导致冷缓存首屏长时间转圈 |
| perf | prd-api | AI 大事资讯改真 serve-stale-while-revalidate + 后台每 4 分钟预热，用户访问路径不再每 5 分钟同步阻塞外网拉取 |
| feat | prd-api | 更新中心/AI 大事成功路径补计时日志(elapsed/files/failures/rateRemaining)，让外网拉取卡顿可被检测 |
| fix | prd-api | 模型分组删除受阻时新增 usage/unbind 端点，支持查询占用应用并一键解绑 |
| fix | prd-admin | 模型池删除被应用占用时改为弹窗列出占用应用并支持一键解绑/解绑全部并删除 |
| fix | prd-admin | 模型池详情面板每个模型新增「从池中移除」按钮，修复无法删除单个模型的问题 |
| feat | prd-admin | 生图模型选择下拉框重设计：每个模型加副标题/描述、推荐徽标（当前推荐 gpt-image-2-all），文案前端临时内置、预留后端下发 |
| fix | prd-admin | 视觉创作结果尺寸徽标改读后端真实出图尺寸（effectiveSize），修复"请求 1:1 但实际 16:9 仍显示 1K·1:1" |
| fix | prd-admin | 视觉创作模型徽标统一显示模型池名（与"用户期望"/选择器一致），实际 modelId 不同时以淡色后缀+ tooltip 露出，便于核对"选 A 给 B" |
| fix | prd-admin | 视觉创作画布标题/引用名走 cleanDisplayTitle 清洗，修复标题自我拼接、引用图标泄漏；并在引用 label 注入处断掉逐代递归 |
| fix | prd-api | image_gen 持久化的 [GEN_DONE] 消息补充 actualModel/effectiveSize/isAdaptive 字段，使尺寸与模型展示刷新后不丢失 |
| feat | prd-api | 新增开放接口（OpenAI 兼容）对外 API 网关（/api/v1/chat/completions + images/generations + models），按 Key 绑定固定模型/专属池，未绑定回落默认池 |
| feat | prd-api | AgentApiKey 新增开放接口绑定与配额字段 + open-api:call scope；新增 AdminOpenApiController 管理 Key→模型绑定/可绑池/调用日志 |
| feat | prd-admin | 开放平台移入 NAV_REGISTRY（SSOT），首页/Cmd+K 搜索/设置导航池可见可搜 |
| fix | prd-api | 修复产品管理列表/单产品访问与仪表盘范围不一致：ProductAgentAdmin 现为 ProductAgentManage 超集(统一 CanManage 判定)，管理员在产品/需求/功能列表与单产品视图可见全部，不再仪表盘有数而列表空 |
| fix | prd-api | UserNamesAsync/ProductNamesAsync 改去重安全写法，避免历史重复键导致 overview 列表端点 500(表现为列表空) |
| feat | prd-api | 产品管理新增批量操作端点(items/batch)：需求/功能 批量删除/指派处理人/改分级，受访问范围约束、自动重算计数 |
| feat | prd-admin | 单产品需求/功能列表支持多选 + 批量操作条(批量指派/改分级/删除) |
| feat | prd-api | 产品管理智能体：产品类型改为可增删改查（新增 ProductCategory 实体 + product_categories 集合 + categories CRUD 端点，内置 4 项固定 Id 兼容存量数据、占用中禁删） |
| feat | prd-admin | 产品类型不再写死：筛选 chips / 产品卡片 / 编辑表单 / 单产品视图副标题改用动态类型，设置页新增「产品类型」管理面板（改名/改色/排序/增删） |
| feat | prd-api | 产品管理新增详情描述模板：ProductDescTemplate 实体 + product_desc_templates 集合 + desc-templates CRUD 端点(按对象类型，管理权限) |
| feat | prd-admin | 详情「描述」区支持一键套用描述模板(右上角入口，空则套用/非空则追加)；设置新增「描述模板」管理(按对象类型增删改，富文本编辑) |
| feat | prd-admin | 产品管理详情页布局调整：整体宽度占 80%、左右 70/30；左主栏只留描述(加高至420)+附件，其余(属性/关联关系/追溯缺陷/信息)移到右栏 |
| feat | prd-admin | 关联对象选择器支持搜索筛选 + 列表(显示总数/已选数/可单独移除已选项)，对象多时不再难选 |
| feat | prd-admin | 产品管理智能体对象详情页重构为 Jira/TAPD 双栏专业布局：头部(编号+大标题+状态流转+统一保存按钮+未保存提示)、左主栏(描述/内容型字段/关联关系/追溯缺陷)、右属性栏(分级/状态/属性型字段/信息) |
| fix | prd-admin | 详情页去除与系统字段(标题/描述)重名的自定义模板字段，消除「填两遍」重复；系统必填字段补必填星号、统一视觉语言 |
| fix | prd-admin | 关联字段未配置 relationEntityType 时从标签兜底推断目标类型(客户/功能/需求/版本)，修复「未配置关联对象类型」 |
| feat | prd-api | 产品管理新增全局搜索端点(search?keyword=)：跨产品/需求/功能/客户/缺陷按关键词分组返回，受访问范围约束 |
| feat | prd-admin | 管理层总览顶部新增全局搜索框(300ms防抖)：分组结果下拉，点击直达对应详情/单产品视图 |
| feat | prd-admin | 产品管理需求/功能父子层级 UI：详情属性区可设「父需求/父功能」(后端 ParentId 已支持)，列表按层级缩进树形展示 |
| feat | prd-api | 产品管理新增需求批量导入端点(products/{id}/requirements/import)：每行标题必填、自动绑定默认流程+初始状态，单次上限500 |
| feat | prd-admin | 需求列表新增 CSV 导入/导出(零依赖 csv 工具)：导出当前列表、导入按表头或位置解析标题/分级/描述 |
| feat | prd-api | 工作流状态新增 WipLimit(看板在制上限)，默认流程开发中/测试中预置 WIP |
| feat | prd-admin | 看板新增泳道(无/按处理人/按分级)+ WIP 在制上限(列头显示 当前/上限，超限红色告警)；流程模板编辑器可配 WIP |
| feat | prd-admin | 产品管理P0：详情页状态流转条默认可见(有默认流程即显示)，需求/功能详情/新建支持设置处理人(MAP用户)，总览需求/功能表新增「我负责的」过滤 + 处理人列 |
| feat | prd-api | 产品管理P1：缺陷转需求端点(defects/{id}/convert-to-requirement)，按严重度映射分级、记录来源缺陷、建立缺陷→新需求追溯、幂等；Requirement 新增 SourceDefectId 溯源字段 |
| feat | prd-admin | 缺陷详情新增「转为需求」按钮(转换后跳转新需求)；需求详情属性区展示「来源缺陷」并可回跳缺陷 |
| feat | prd-api | 产品管理P2：对象动态/讨论时间线(product_item_activities，评论+系统活动合流) + GET activities/POST comments 端点；状态流转/转交/改处理人/缺陷转化自动记录时间线并通过 admin_notifications 通知处理人/负责人/@提醒人 |
| feat | prd-admin | 需求/功能详情新增「动态」卡片：评论(富文本+截图+@提醒选人)与系统活动(流转/指派/转化)按时间正序混排 |
| feat | prd-api | 产品管理P3：工作流状态加 SLA 时效(SlaHours)、流转加自动认领(AutoAssignToActor)；需求/功能加 StateEnteredAt(进入状态时间)，创建/流转/补绑时维护；流转 claim 自动指派操作人并通知 |
| feat | prd-admin | 单产品视图新增「看板」分区：按工作流状态分列、拖拽卡片即流转(解析可达流转动作)，卡片显示分级/处理人/SLA停留(超时高亮)；详情状态区显示停留时长+超时；流程模板编辑器可配 SLA小时 + 自动认领 |
| feat | prd-api | 产品管理新增报表端点(products/{id}/analytics)：版本进度(需求按状态分类)+总体进度+迭代速度(近8周进入终态吞吐，源自活动时间线) |
| feat | prd-admin | 单产品视图新增「报表」分区：总体进度环图 + 迭代速度柱图 + 版本进度堆叠条 + 完成率 KPI(ECharts) |
| feat | prd-admin | 产品管理智能体详情页「描述」改为富文本（排版工具栏粗体/斜体/下划线/标题/列表 + 截图粘贴/拖拽上传），对齐 Jira/TAPD/Linear；RichTextField 支持 placeholder 与可配置高度 |
| feat | prd-api | 产品管理新增 RTM 需求可追溯矩阵端点(products/{id}/rtm)：每条需求→归属版本/实现功能/关联客户/追溯缺陷 + 覆盖缺口统计(未实现/未规划版本/无来源功能) |
| feat | prd-admin | 单产品视图新增「追溯矩阵」分区：需求×版本/功能/客户/缺陷二维表，未实现需求标红、无来源需求的功能单列，格子可点跳详情 |
| fix | prd-admin | 产品管理富文本渲染前 XSS 净化：新增零依赖 sanitizeHtml(去脚本/危险标签/on*事件/javascript:协议)，评论时间线渲染与富文本编辑器加载均过净化，堵存储型 XSS |
| refactor | prd-admin | 网页托管「快速分享」弹窗改版：谁能访问/链接形式改为 icon+短标题分段卡（「仅我」放当前用户头像），有效期下拉改胶囊，说明文字仅展示选中项一行，整体文字量减半，主次更清晰 |
| fix | prd-admin | 智能体·视觉创作 mini 面板：生图等待从静态 spinner 升级为爬升进度条 + 分级状态文案(含模型名/已用时) + 取消按钮，消除 30s+ 空白等待；新增 genPhaseText 单测 |
| feat | prd-admin | 视觉创作 mini 面板生成结果支持点击全屏放大(lightbox + ESC/点击关闭 + 原图/下载)，解决 640px 抽屉里图太小看不清 |
| refactor | prd-admin | 视觉创作 mini 面板移除内嵌的千行水印编辑器(水印由视觉创作统一管理/服务端自动叠加)；模型/尺寸行在无可选项时整行隐藏(奥卡姆剃刀) |
| refactor | prd-admin | 知识库文档「再加工」入口按钮(下拉菜单 + 工具栏)更名为「智能体」 |
| feat | prd-api | 知识库智能体抽屉对话后端持久化:新增 document_store_conversations 集合 + GET/PUT/DELETE conversation 端点(按 userId+entryId upsert,不走 Run 规避旧"污染新会话"bug),修复关浏览器标签页对话全清空 |
| feat | prd-admin | 智能体抽屉接入对话后端持久化:开抽屉从后端恢复(优先于 sessionStorage,避开旧 run 污染)、去抖落库、"开启全新对话"清后端;mini 面板「已生成未插入」图随对话持久化 + 重开回填 |
| fix | prd-admin | 智能体抽屉:取消挂起的去抖后端保存于"新对话"清空前 + 切换文档时,杜绝 pending save 在 DELETE/切换后落库把旧对话复活或写错文档(Bugbot/Codex P2/Medium) |
| fix | prd-admin | 视觉创作 mini 面板同步 initialResult/initialPrompt 的后续 prop 变化:修复后端异步回填的暂存图被隐藏、"为这段配图"重新预填不生效(Bugbot Medium) |
| fix | prd-admin | 智能体抽屉暂存图生命周期:切换文档重置 pendingVisualUrl(防串档) + 插入文档后清空(防重开重复回填/重复插入)(Codex P2 x2) |
| fix | prd-admin | 智能体抽屉重开恢复合并后端+sessionStorage 两源(id+内容去重 union),修复切档取消去抖后端保存后只取较旧后端快照丢本地新消息(Cursor Medium);新增 mergeChatSnapshots 单测 |
| fix | prd-api | 智能体宇宙 invoke 补齐 review:每 agent 强制 {agentKey}.use 权限门(防 ai-toolbox.use 越权调 visual/defect, Codex P1) + 透传多轮 history(custom 走 messages 数组/adapter 折叠进消息, Cursor High) + custom 体补 EnabledTools(抽 ToolboxPromptEnricher 共享, Codex P2) |
| fix | prd-api | 知识库对话保存改原子 upsert(UpdateOne+IsUpsert)替代 find-then-insert,消除多标签页并发插重复行(Codex P2);唯一索引要求登记 guide.mongodb-indexes |
| fix | prd-admin | 视觉创作 mini 面板:父级清空暂存图(插入文档后)时同步清面板结果态,防同一面板重复插入(Codex P2);缺陷创建 toast 读 res.data.defect.title 修正(Bugbot Low) |
| feat | prd-api | 网页托管上传幻灯片类 HTML 时注入翻页方向兼容垫片：只认左右方向键的 PPT 导出页也能用上下方向键/空格/PageUp-Down/滚轮/触摸滑动翻页（保守判定为幻灯片才接管，普通网页不碰） |
| fix | prd-api | 翻页兼容垫片重写为「可靠驱动优先」：新增 reveal/swiper/impress API + 任意带 next()/prev() 方法的自定义元素（如 deck-stage 这类 web component PPT）+ scroll-snap 直驱；仅在解析到可靠驱动时才接管并 preventDefault，无驱动时只对上下键尽力合成且不抑制原生，修复对忽略合成事件(isTrusted=false)的自定义 deck 上下键无效的问题 |
| feat | prd-api | 翻页垫片改为「零重传直接生效」：HostedSite 加 SlideNavCompatVersion 版本号，startup backfill（HostedSiteBackfillService）把版本落后的存量站点 HTML 从 COS 拉回重新注入当前版垫片并 bump 缓存，用户无需重新上传；垫片代码升级（版本号+1）后存量站点自动获得新版。注入保持在隔离对象存储域名，不改变 iframe 跨域隔离安全模型 |
| feat | prd-admin | 网页托管分享页单站点视图新增「全屏演示」按钮（对容器 requestFullscreen，全屏时隐藏 MAP 顶栏，Esc 退出同步），iframe 加 allowFullScreen 让 deck 自带全屏按钮也能用 |
| feat | prd-api | 翻页垫片改为分档+透明可控（v3）：高可信信号自动开启并在角落显示可关闭提示条；低可信（仅 .slide≥2 类名、无可靠驱动）改为邀请式不自动劫持，避免误判普通网页；用户选择记入 sessionStorage。SlideNavVersion 2→3，存量站点启动自动升级 |

### 2026-06-02

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 新增「智能体宇宙」能力契约 SSOT（AgentCapability + AgentCapabilityRegistry）与统一调用信封 AgentUniverseController（capabilities + invoke SSE），按 invokeMode 路由到适配器生图或网关聊天 |
| feat | prd-admin | 新增 agentUniverse 服务（拉契约 + 统一 invoke SSE，支持图片 artifact） |
| fix | prd-admin | 修复文档再加工「选中智能体即自动发送」，改为选中只聚焦输入框、用户输入后才触发 |
| feat | prd-admin | 文档再加工抽屉改为契约驱动：视觉创作走真实生图并可一键插入文档，各智能体按 invokeMode 渲染对应交互 |
| refactor | prd-api | 智能体宇宙改为「绝不仿冒」：invoke 一律路由到真实 IAgentAdapter，删除硬编码提示词的假聊天路径；注册表只登记有真实组件的 4 个智能体（视觉/文学/缺陷/PRD），找不到真实适配器明确报错 NO_REAL_AGENT |
| fix | prd-api | VisualAgentAdapter 改走真实生图客户端 OpenAIImageClient.GenerateUnifiedAsync（与主视觉创作同一引擎），修复手搓 raw body 硬塞 quality 被模型拒绝（"不支持quality"）导致生图失败；并支持透传 size/model 参数 |
| feat | prd-api | 智能体宇宙新增 GET agents/{key}/parameters：按智能体自己原有的池下发真实可选参数（视觉=尺寸/模型，仅有多个可选项时才给选择器），invoke 已支持 parameters 透传到真实适配器 |
| feat | prd-admin | 文档再加工面板：生成型智能体显示尺寸/模型选择器（选项来自后端真实池，无可选项则不显示），所选参数随 invoke 透传 |
| feat | prd-api | 智能体宇宙 invoke 支持百宝箱自定义智能体（custom:{id}）：实时读库 systemPrompt + 知识库跑真实网关，新建任意自定义智能体零代码接入统一管道 |
| feat | prd-admin | 文档再加工：自定义百宝箱智能体改走统一 invoke 信封（与内置智能体同一管道），不再走独立 direct-chat |
| fix | prd-admin | 修复文档再加工抽屉真人体验:① 抽屉 z-index 提到铃铛 FAB 之上(发送按钮不再被遮)+ 发送按钮与输入框等高 ② 输入区显示「引用：《文档名》」+ 空状态说明预期(自动带文档/关闭保留/新对话/多轮) + 新增「新对话」按钮 ③ 思考态显示已用秒数+>15s 慢模型提示(分清卡死 vs 生成中) |
| feat | prd-api | 智能体宇宙能力契约新增 outboundActions(智能体专属出站动作):缺陷智能体声明「创建缺陷」,把产出送回原生系统而非只写回文档 |
| feat | prd-admin | 文档再加工巧思:① 选中智能体显示「智能涌现」提示(这个智能体能做什么特别的)② 缺陷智能体产出旁「创建缺陷」一键建入缺陷库(复用 POST defects,标题自动归一)③ 文学/PRD 产出仍可替换/追加/另存(插入当前文档) |
| feat | prd-api | 文学智能体声明 outboundActions「为这段配图」(illustrate),驱动文学→视觉接力 |
| feat | prd-admin | 智能体接力(E9):文学产出旁「为这段配图」一键编排 literary generate_illustration(构思插画描述)→ visual text2img(生图)→ 图片可插文档,全程分阶段进度 |
| feat | prd-admin | 视觉创作 mini 面板:再加工选视觉创作=真实视觉创作的缩小可交互版(提示词/用原文/参考图/真实水印 WatermarkSettingsPanel/尺寸模型/真实 generate 端点出图/插入文档/插入原文+配图);文学「为这段配图」改为打开 mini 面板并预填(交互式,不再默认值自动跑) |
| feat | cds | 检测回填透明化:返回每个服务的把握度(confidence)+ 识别依据(signals)+ 栈类型;前端按"把握 高/中/低"展示,把握不高或未完全识别时强烈建议先「试运行验证」——杜绝静默填错让用户盲信 |
| feat | cds | 一键部署新增「检测仓库并自动填好配置」:填 Git URL 后点一下,CDS 浅克隆+复用 detectModules(monorepo 感知)识别真实技术栈,把应用服务的镜像/命令/端口按检测结果填好,取代"按运行时猜测的默认",大幅降低第一次试运行点红的概率(少绕路 + 减少猜错) |
| fix | cds | 修复弹窗内容超高时飞出视口（「一键部署项目」等含 12 基建预设的高弹窗）：DialogContent 统一 cap 90vh + 内层 overflow-y-auto 滚动 + 关闭按钮 z-10 固定，根治「天上去了」与主操作按钮够不到 |
| fix | cds | 基础设施数据端点(query/init-sql)补项目级鉴权:项目级 key 跨项目访问数据库返回 403 project_mismatch,杜绝跨租户数据泄露 |
| fix | cds | 数据备份端点(backup/restore/backup-history)同步补项目级鉴权,堵住整库 dump 的跨项目越权(纵深防御) |
| fix | cds | infra-presets 应用预设端点补 assertProjectAccess,项目级 key 不得跨项目生成基础设施 |
| fix | cds | 数据面板 MongoDB 连接到应用配置库(svc.dbName/MONGO_INITDB_DATABASE)而非 admin,查询/初始化作用于用户自己的数据 |
| fix | cds | 数据面板 Redis 支持 requirepass:从 REDIS_PASSWORD 读取密码并以 -a + --no-auth-warning 传入,密码值脱敏 |
| fix | cds | 单例型基建(Kafka/RabbitMQ/NATS 等非数据库)禁止同类型多实例(覆盖重复调用 infra-presets 路径),仅可命名库的数据库预设允许多实例,避免容器自我广播地址串号 |
| fix | cds | 试运行/检测仓库(validate-runtime/detect-runtime)克隆复用 Device Flow token(_injectGithubTokenIfPossible),私有 GitHub 仓库在创建项目前也能跑检测/试运行;日志脱敏 token |
| fix | cds | 后台任务(worker)BuildProfile 设 readinessProbe.noHttp,部署就绪探测跳过 HTTP 只 TCP 探活,避免活着的 worker 被 HTTP 探测超时误判失败 |
| fix | cds | 创建项目时基建连接串覆盖用户粘贴的同名环境变量不再静默:收集被覆盖 key 回传前端(infraEnvOverrides)+ console.warn |
| fix | cds | 数据备份端点解析也按 ?project= 精确定位(与 infra-data 一致):两项目同名 infra(如都叫 postgres)时,owner 用 ?project= 命中自己的库不再 403,admin 也不会误流/误恢复到别项目的库 |
| feat | cds | 基建目录新增 MariaDB 一等预设(mariadb:11,MySQL 协议兼容,自动注入 DATABASE_URL/MYSQL_URL),消除 CLI 识别 mariadb 但 catalog 缺条目的 SSOT 漂移 |
| fix | cds | 拓扑「新增基础设施」选目录预设时改用后端返回的 applied[0] 作为 serviceId:同类型已存在时创建的 postgres-2 等新实例能被"立即启动"+选中,不再误启动已有实例 |
| fix | cds | 检测/试运行(detect-runtime/validate-runtime)拒绝项目级 agent key(403):这两个接口用服务器级 GitHub 凭据克隆任意仓库+跑任意命令+回流日志,项目级 key 无可授权目标,放行等于借服务器凭据克隆并 exfil 任意私有仓库;仅管理员/控制台会话可调用 |
| fix | cds | 数据/备份端点省略 ?project= 且 id 跨多个项目存在时返回 400 要求显式指定项目,杜绝 admin 误对错误租户库执行查询/init-sql/备份/恢复 |
| test | cds | 新增 infra-data-scope 测试(11 例,跨项目 403/owner 409/admin no-op + 同名 infra ?project= 消歧)+ buildInfraDataExec mongo 库名/redis 密码 + 单例守卫/数据库多实例 + worker noHttp + customEnv 覆盖提示回归(共 +19 例) |
| feat | cds | 分支详情抽屉新增「应用已上线 · 打开预览」高光横幅:分支 running 时顶部醒目展示预览地址 + 一键打开按钮(部署后的 Railway/Vercel 式上线时刻);后端分支列表带 previewUrl(SSOT slug + previewHost) |
| feat | cds | 一键部署:同类型数据库可挂多个实例(第2+个自动建 postgres-2 容器 + DATABASE_URL_2 独立连接串;首个实例零改动向后兼容) |
| feat | cds | 一键部署:项目环境变量就地粘贴 .env 文本(无需准备文件),创建时一并写入(少绕路原则) |
| feat | cds | 一键部署:后端默认运行时改为「自动识别」(按真实仓库推断启动命令,取代写死 Node 命令);命令字段标注可编辑best-effort |
| docs | - | 新增 .claude/rules/anti-detour.md 少绕路原则(能一步别多步/优先就地编辑/智能默认防写死) |
| feat | cds | 一键部署「选择应用服务」支持动态增删(默认前端+后端，可加 N 个，角色含前端/后端/后台任务)，不再写死 2 个 |
| feat | cds | 基础设施支持自定义数据库名(threaded 进容器初始化变量 + 连接串，取代写死 app) + 初始化 SQL 配置(随项目保存，数据面板一键载入执行) |
| fix | cds | 试运行验证修复(dogfood 发现):容器化 CDS 下 bind-mount 主机路径不一致导致 /workspace 空、所有真实仓库报"找不到 package.json"——改用 docker cp 装载代码;sh -lc 改 sh -c 修复 golang 等镜像 "go: not found"(login shell 重置 PATH) |
| fix | cds | 试运行端口探活改用 /proc/net/tcp(不依赖镜像有 wget/curl)——python:slim 跑 Flask 起来了却被误判"端口未响应"的假告警修复 |
| feat | cds | 试运行失败时按日志智能提示根因(缺 package.json/requirements.txt/Go 主包→可能在子目录;NETSDK 版本不匹配;端口占用;缺命令)而非只报退出码 |
| feat | cds | 一键部署「试运行验证」配置闭环:点一下用一次性容器在真实仓库上跑「镜像+启动命令」,SSE 流式日志+端口探活,给出 通过/需确认/不通过 三档结论;不行就地改命令/镜像再试,绿灯才部署。后端 POST /api/validate-runtime(克隆→拉镜像→跑容器→跟日志→探活→销毁) |
| refactor | prd-admin | 知识库/文档列表条目恢复两行布局：标题独占整行并增强（更亮/加粗/13px），验收·标签·NEW 徽章下移至第二行左对齐、时间右对齐，避免徽章挤占标题宽度 |
| refactor | prd-admin | 文档条目徽章药丸高度 16→15px 略缩，tag 去掉加粗，并按名字本地化排序（从左到右） |
| feat | prd-admin | 知识库列表新增左侧验收状态色条（通过/有条件/不通过 → 绿/琥珀/红竖条），整列向下可扫读结论分布 |
| feat | prd-admin | 知识库列表按时间分组小标题（今天/昨天/本周/本月/更早），仅 created/updated-desc 且非搜索态生效，文件夹不参与分组 |
| feat | prd-admin | 条目标签可点击即按该标签筛选，与顶部筛选条共用 selectedTags（SSOT），激活态加描边；新增 buildDisplayItems 分组单测 |
| fix | prd-admin | 知识库行内标签随侧栏宽度自适应：拖宽侧栏后展示更多标签（最多 12）+ 标签名展示更全，不再一律压缩成 +N |
| feat | prd-admin | 顶部标签筛选条标签 >6 个时收进「标签筛选」下拉（createPortal 长方形面板 + 搜索框 + 多选），避免一长串横向溢出 |
| chore | prd-admin | 移除 DocBrowser 代码注释里残留的 emoji，符合无 emoji 规则 |
| feat | prd-admin | 知识库空库时右栏展示完整首访引导（DocEmptyState：线框插画+说明+CTA+「3步开始」），替代原「选择左侧文件」占位 |
| chore | prd-admin | 新增 BulkActionBar（批量操作条）展示组件，下一波接线列表多选；DocHeadCard 因阅读区已有头部工具栏（标题/标签/时间/作者）而弃用，改为在阅读头补验收药丸 |
| fix | prd-admin | 知识库条目徽章行恒为单行：行内 tag 去掉 flex-wrap 改 overflow 裁切（+N 永久可见）+ 窄栏更激进收进 +N，杜绝标签竖直堆叠 |
| feat | prd-admin | 阅读区排版升级：代码块 hover 复制按钮（MarkdownViewer 全站生效）+ 顶部阅读进度条 + 阅读头补验收结论药丸（通过/有条件/未过 + 档位） |
| feat | prd-admin | 知识库行内评论高亮气泡：他人评论锚回正文（跨文本节点/去空白匹配）画高亮条 + 末尾可点气泡（点击打开评论抽屉，同句多条合并显示条数），失锚评论灰显降级；核心匹配 locateInSegments 加 7 条单测 |
| feat | prd-admin | 知识库列表批量多选：行 hover 浮出勾选框（仅文件），选中后侧栏底部浮出 BulkActionBar 批量删除（systemDialog 二次确认，逐条删除单个失败不阻断）+ 取消清空 |
| fix | prd-admin | 知识库订阅条目去重复 + 消除空旷副行：健康（已同步）不再画绿点（仅暂停/同步中/出错才显），健康订阅条目回落单行紧凑布局（时间贴标题右侧）；订阅 RSS 图标金色改中性灰，整库订阅源时不再满屏金色重复 |
| fix | prd-admin | 知识库条目 NEW 徽标移到标题同行末尾（不再单占副行，减少一行高度）：非文件夹标题改取自然宽度让 NEW 紧贴标题末尾、时间 ml-auto 顶右，标题保持左对齐不出现锯齿缩进 |
| fix | prd-admin | 知识库主页（DocumentStorePage）空状态接入 DocEmptyState：原页面自带简版空状态遮住了新组件，现替换为完整首访引导（插画+说明+新建/上传/添加订阅源三 CTA+3步开始），订阅 CTA 接入 SubscribeDialog |
| feat | prd-admin | 知识库阅读页加「返回」入口：① 分享页（别人分享给我的）右上角加「返回我的知识库」按钮（仅登录用户显示，匿名访客不显示）→ 跳 /document-store；② 自己的知识库阅读区头部加「返回列表」按钮 → 关闭当前文档回到本空间文档列表（DocBrowser 新增可选 onBackToList prop，受控由调用方决定行为） |
| feat | prd-admin | 网页托管/视觉创作/知识库/文学创作四个页面新增右下角「小技巧」本页完整新手指引锚点（data-tour-id） |
| feat | prd-api | DailyTips 新增四条本页教程 seed（webpages/visual/document-store/literary-page-guide，8-14 步），替换三条精简旧 seed |
| feat | prd-admin | 「小技巧」入口移到右上角带文字标签的常驻 pill（不再是右下角匿名图标）；进入任一有本页教程的页面自动开讲一次，未走完（点完最后一步）跨 session 会再弹，强制人人过一遍 |
| feat | prd-admin | 新增海鲜市场/智识殿堂/作品广场三页本页教程锚点 + seed；教程入口与 Spotlight 引导上移到 App 根挂载（全局唯一、跨任意路由含全屏编辑器不卸载），删除 FullscreenTipsDock 与 AppShell 内重复挂载 |
| feat | prd-api | DailyTips 新增 marketplace/library-landing/showcase 三条 page-guide seed |
| feat | prd-admin | 视觉/文学编辑器补 data-tour-id 锚点（visual-editor-*/literary-editor-*）；TipsDrawer 自动开讲匹配器区分列表路由与编辑器深层路由，CTA 已在目标路由内不再跳走 |
| feat | prd-api | DailyTips 新增 visual-editor/literary-editor page-guide（进入项目/文章编辑器后自动开讲），列表教程「贯通」到编辑器 |
| fix | prd-admin | 修正三处反馈：①分享/落地/登录/开发页不再挂教程入口（之前 /s/* 分享页误显示）②每条教程第 1 步从整页 root 改指向具体元素（高亮框不再框整屏看不出）③入口 pill z-index 50→300，确保各页右上角都在常规内容之上可见 |
| feat | prd-admin | 缺陷管理/PR审查/涌现探索/工作流四页补 data-tour-id 锚点（缺陷贯通到提交面板全流程） |
| feat | prd-api | DailyTips 新增 defect/pr-review/emergence/workflow 四条 page-guide seed（4-8 步） |
| fix | prd-admin | 涌现探索教程改锚到真实落地页 EmergenceIntroPage（hero/三步玩法/种子按钮/三维度），原锚的树列表视图非默认落地态导致定位失败 |
| fix | prd-admin | 右上角教程入口降突兀：新人(本页教程没走完)才强调色+脉冲闪烁，老人(走完/本页无教程)变中性安静低存在感 chip(不闪、不发光、低透明度)，融入页面 chrome；老人态隐藏计数徽标 |
| fix | prd-admin | 教程入口从右上角悬浮浮层改为内嵌进各页头部(融入而非悬浮)：新增 TipsEntryButton 内嵌进 TabBar/PageHeader(覆盖多数页) + 6 个自定义头部页(网页托管经 PageHeader、视觉/海鲜市场/智识殿堂/作品广场/PR审查/涌现落地页手动内嵌)；TipsDrawer 去掉悬浮书,改为监听 open 事件展开抽屉气泡 |
| feat | prd-admin | 多步教程引导改成「任务清单」式:Spotlight 气泡新增进度条 + 全步骤清单(已完成✓/当前●/待办○,当前自动滚入可见),像做任务一样一个个打勾完成 |
| feat | prd-admin | 子智能体批量给 7 个自定义头部页内嵌本页教程入口(视频/产品评审/项目路由/转录/快捷指令/技能/项目管理);arena、automations 无干净页头暂跳过 |
| fix | prd-admin | PR #712 评审修复：①视觉创作页教程入口误放进复用的 ToolbarButton(每个工具按钮上都叠一个)→ 移到 HeroSection 页面级单实例 ②教程气泡宽度 340→360 后 bubbleLeft 夹取仍用旧值(右溢出/偏移)→ 同步改 360/180 ③多步引导「下一步」自动点击改为仅在「下一步元素当前不存在」时才点,避免点到「分享统计」等按钮弹出 z-10000 抽屉挡住引导 |
| fix | prd-admin | PR #712 Codex P2:视觉编辑器旧版全屏路由 /visual-agent-fullscreen/:id 既不自动开讲也无入口。matcher 增配 -fullscreen 兼容前缀;VisualAgentFullscreenPage 编辑器态右上角内嵌教程入口(覆盖正式 + 旧版两路由,列表态不重复) |
| fix | prd-admin | PR #712 评审三连修：①公开主页 /u/:username 加入教程浮层排除名单(登录用户访问公开页不再冒出内部引导，Codex P2) ②文学编辑器头部右侧补本页教程入口(自动开讲关掉后可手动重开，Codex P2) ③修复抽屉自动展开与 Spotlight 叠加:改用渲染级 pageGuideHere 单一真值抑制(不再依赖 effect 声明顺序，Bugbot Medium) |
| fix | prd-admin | PR #712 再修三处：①TipsEntryButton 未登录不渲染(公开页 /library 匿名访客点了没人接还打 401，Codex P2) ②handleOpenTip 导航守卫补 -fullscreen/ 前缀(在旧版全屏编辑器点 CTA 不再被弹回列表，Bugbot Medium) ③入口点击的 load 去重(只 TipsDrawer 监听里 load 一次，Bugbot Low) |
| fix | prd-admin | PR #712 收尾三连：①抽取共享 matchPageGuide(pageGuideMatch.ts)，TipsDrawer.pageGuideHere 与 TipsEntryButton.newbie 共用一份匹配逻辑，并改用 store 稳定引用 items+dismissed 让 useMemo 真正生效(Bugbot Low×2) ②TipsDrawer 不再依赖 cardTips() 每次新建的数组做 memo |
| fix | prd-api | PR #712 Codex P2:涌现教程 4 步锚点改逗号兜底选择器(intro 落地页 hero/steps/seed/dimensions + 树列表 about/create-tree/tree-list 两套都给)，新老用户任一视图都不留空步骤；同时清除全部本页教程文案里的装饰性 emoji(违反最高优先 no-emoji 规则) |
| fix | prd-admin | PR #712 评审四连：①handleOpenTip 编辑器教程的 alreadyAtTarget 去掉 pathname===url 精确匹配(列表页不算「已在编辑器」,否则手动轮播到编辑器教程在列表页点 CTA 会起找不到锚点的 tour，Bugbot Medium) ②删除右上角抽屉的空转 ResizeObserver(dockBottom 恒为 20，改挂载时广播一次，Bugbot Low) | 
| fix | prd-api | PR #712 Codex P2:知识库教程全部 8 步 + TargetSelector 逗号兜底到常驻 library-tabs(顶部 tab 栏)——返回用户上次停在收藏/点赞 tab 时工具栏不渲染会卡「目标未找到」；新增 DocumentStorePage sticky 顶栏 data-tour-id=library-tabs |
| fix | prd-admin | PR #712 Bugbot:教程数据预加载与 TipsDrawer 条件挂载解耦——App 根在登录后无条件 load() 一次(幂等),修复停在 /home(登录默认落地页,不挂 TipsDrawer)时 tips 不预拉、进首个教程页才异步 fetch 导致开讲延迟;并补注 SpotlightOverlay 自动点击对逗号兜底选择器取「任一命中」的有意语义 |
| fix | prd-admin | PR #712 Codex P2:TipsDrawer 轮播过滤掉「不在对应编辑器路由」的编辑器教程(*-editor-page-guide)——否则用户手动翻页到它点 CTA 会跳列表页起一个找不到 visual-editor-* 锚点的 tour 卡死;在编辑器内仍保留供手动重开 |
| fix | prd-api | PR #712 Codex P2:新增 RetiredSeedSourceIds SSOT(webpages-basics/visual-first-image/library-publish 三条被新版 page-guide 取代的旧短教程)。Visible() 主动过滤这些 DB 残留(老环境无需管理员重置即不再新旧并存);Admin /seed 重植时一并删除 |
| fix | prd-admin | PR #712 Codex P2:App 根教程浮层排除名单补 '/library/'(带尾斜杠)——智识殿堂公开详情页 /library/:storeId 是免登录只读页,登录用户访问时不再冒出内部新手教程;'/library' 落地页(带 library-landing 教程)因无尾斜杠不受影响保留 |
| fix | prd-api | PR #712 Codex P2:缺陷管理教程第 3 步(缺陷列表)逗号兜底到常驻 defect-view-mode-switcher——返回用户上次停在看板/统计视图时 defect-list-container 不渲染会卡「目标未找到」 |
| fix | prd-api | PR #712 Codex P2:网页托管教程第 7 步(上传站点)逗号兜底到常驻 webpages-header-actions——团队空间只读成员无上传按钮时不再卡死,同时避免上一步 share-mgmt 按钮被自动点击误开抽屉 |
| fix | prd-admin | PR #712 Codex P2:pageMatchedIndex(抽屉打开时选哪条 tip)也改用编辑器感知的 matchPageGuide —— 在 /visual-agent/:id 等编辑器子路由上优先选 *-editor-page-guide，不再误选同 actionUrl 前缀的列表教程(其 CTA 会把用户导离编辑器)；非教程 tip 仍走原前缀兜底 |
| fix | prd-admin | PR #712 评审三连(TipsDrawer)：①两个自动弹窗 effect 把 pageGuideHere 加进 deps —— 修复「首屏落在有教程页 → early-return → 切到无教程页后整 session 不再自动弹」的陈旧闭包(Bugbot) ②CTA 导航守卫按是否编辑器教程区分:编辑器教程留在深层路由,普通列表教程即便当前停在编辑器子路由也回 actionUrl,避免 tour 在编辑器找不到锚点卡死(Codex P2) ③删除小书移除后残留的 edge-peek 死代码(edgeHover/全局 mousemove 监听/EDGE_PEEK_ZONE/mode 状态机),抽屉只剩 expanded 单态;保留 hiddenByUser/pinned(仍与 AppShell 通知铃铛贴边联动,非死代码)(Bugbot) |
| fix | prd-admin | PR #712 Bugbot:SpotlightOverlay 单步计数器条件 steps.length<=1 改为 ===1，避免 steps 为空时渲染「步骤 1 / 0」(多步走 >1 的进度条，0 步不显示) |
| fix | prd-admin | PR #712 Bugbot:①SpotlightOverlay 删除单步「步骤 1/1」无意义计数(多步走任务进度条,单步/零步不显示) ②抽取 isEditorPageGuide 共享判定(含 -page-guide 后缀守卫),TipsDrawer 轮播过滤/handleOpenTip 导航/matchPageGuide 三处统一调用,消除 handleOpenTip 缺后缀守卫的不一致 |
| fix | prd-admin | OKR 仪表盘「按周期」聚合改为按结构化周期(cycleId→名称)分组，与顶部周期筛选口径一致(此前仍按旧 period 文本，结构化周期下会全落「未设周期」) |
| test | prd-api | 新增 PmGoalProgressTests：覆盖 PmKeyResult.ComputeProgress 的百分比/数值/递减型 KR/span=0/越界裁剪/binary 及叶子 KR 均值汇总 |
| feat | prd-api | 目标 OKR 第一波：结构化关键结果 KR——PmGoal 增 KeyResults(percent/number/currency/binary，起/当前/目标值)；目标进度 auto 模式下有 KR 时按 KR 完成度均值汇总(优先于任务滚动)；ListGoals 返回 keyResults/keyResultCount |
| feat | prd-api | 目标负责人可指派：PmGoal 增 LeadId/LeadName(与 OwnerId/可见性解耦)，Create/UpdateGoal 落库 |
| feat | prd-api | 目标信心 + 进展 check-in：新增 PmGoalCheckIn + pm_goal_checkins 集合 + GET/POST goals/{id}/checkins(进度/信心/说明，更新目标最新信心)；删除目标级联清 check-in |
| feat | prd-admin | 目标详情抽屉新增：关键结果 KR 编辑器(类型/起当前目标值/单位/实时完成度) + 负责人(UserSearchSelect) + 进展 check-in 时间线(信心 high/medium/low + 进度 + 说明) |
| feat | prd-admin | 目标列表卡片展示 KR 数 / 信心点 / 负责人 |
| feat | prd-api | 目标 OKR 第二波：期末评分/复盘——PmGoal 增 Score(0.0-1.0)/ScoreNote/ScoredAt/ScoredByName + POST goals/{id}/score(评分/清除，团队限 owner/leader，个人限本人)；ListGoals 返回评分字段 |
| feat | prd-admin | 目标详情抽屉新增「期末评分/复盘」(0.0-1.0 + 复盘备注)、对齐路径面包屑(业务目标›父目标›本目标)；列表卡片显示评分徽章 |
| feat | prd-admin | 目标新增「仪表盘」视图(GoalsDashboard)：KPI(目标数/达成率/低信心/平均评分) + 状态分布 + 按负责人/周期聚合进度 + 需关注(低信心/风险/落后)目标预警；目标页视图切换增至 画布/列表/仪表盘 |
| feat | prd-api | 目标 OKR 第三波：结构化周期实体——新增 PmGoalCycle + pm_goal_cycles 集合 + goal-cycles CRUD 端点(active/closed 归档，删周期不删目标仅解除归属)；PmGoal 增 CycleId，Create/Update 落库，ListGoals 返回 cycleId |
| feat | prd-admin | 新增 CycleManagerModal(周期新建/改名/起止/归档/删除)；目标页头部「周期」入口；目标详情抽屉增 OKR 周期下拉、列表卡片显示周期 chip |
| feat | prd-admin | OKR 仪表盘增周期筛选(全部/各周期/未归类)，按周期盘点达成与评分 |
| feat | prd-admin | 目标评分面板增「按 KR 算分」：按 KR 完成度均值一键折算 0.0-1.0 评分 |
| feat | prd-admin | 项目「资料」三模块改版为全宽卡片列表页：周报(关键词/来源/作者/排序筛选)、会议纪要(关键词/时间范围/参会人/排序筛选)、知识库分「知识文档/成员作品」子视图；卡片含摘要/徽章/相对时间，点击进详情，编辑保留原 Markdown 编辑器 |
| feat | prd-admin | 成员网页托管作品列表：封面/可见性徽章(公开·未公开)/浏览数/成员/相对时间，支持按成员·可见性·关键词筛选，点击新标签打开访问 |
| feat | prd-api | 项目成员作品聚合放开可见性限制：新增 IHostedSiteService.ListAllByUserIdAsync(公开+私有)，member-sites 端点改用之并纳入观察者，返回 visibility/cover/viewCount/tags/updatedAt —— 成员未公开的托管站点在项目空间内也可见可访问(站点文件按 URL 直达，Visibility 仅控制公开页是否列出) |
| feat | prd-api | 里程碑第一波：PmMilestone 增 OwnerId/OwnerName(负责人) + AcceptanceCriteria(验收标准 DoD 清单)；CreateMilestone/UpdateMilestone 落库；标记达成加验收门禁(有验收项且未全勾选则拒绝)；ListMilestones 返回 owner/验收完成数/计划-实际偏差 slippageDays |
| feat | prd-api | 里程碑健康度改为前瞻式：除临近截止(≤3天)外，进度落后于时间消耗(SPI<0.85)即 at_risk，给足补救窗口 |
| feat | prd-api | 逾期提醒 worker：里程碑提醒改为定向到里程碑负责人(未设回退 leader)，并纳入临近截止(非仅逾期) |
| feat | prd-admin | 里程碑详情抽屉(MilestoneDetailDrawer)：负责人(UserSearchSelect)+验收标准清单(增删/勾选/编辑)+说明+关联目标+其下任务+进度+计划/实际偏差，验收未全勾选禁止标记达成 |
| feat | prd-admin | 里程碑卡片整卡可点进详情，新增负责人/验收 X-Y/延期或提前天数 展示；新增与编辑统一走详情抽屉 |
| feat | prd-api | 里程碑第二波：依赖/门禁——PmMilestone 增 DependsOn(前置里程碑，环检测保持 DAG)；ListMilestones 派生 blocked/blockedBy(前置未达成即受阻)；标记达成加依赖门禁(前置未全达成则拒绝) |
| feat | prd-api | 里程碑交付物关联：PmMilestone 增 Deliverables(weekly/decision/link 引用 + 标题快照)，Create/Update 落库 |
| feat | prd-api | 风险关联里程碑：PmRisk 增 RelatedMilestoneId，CreateRisk/UpdateRisk 落库 |
| feat | prd-admin | 里程碑详情抽屉新增：前置里程碑多选(受阻提示)+交付物 composer(周报/决策/外链)+反查威胁本里程碑的风险；标记达成受验收+依赖双门禁 |
| feat | prd-admin | 里程碑卡片新增 受阻/交付物数/前置数 标识；风险登记册可关联里程碑(下拉+卡片 chip) |
| feat | prd-admin | 甘特图里程碑菱形支持拖拽改期(owner/leader)：拖动实时显示新日期，松手落库 dueAt |
| feat | prd-api | 里程碑第三波：AI 里程碑建议——新增 pm-agent.milestone-suggest AppCaller + PmAgentService.SuggestMilestonesAsync + SSE 端点 projects/{id}/milestones/suggest(限 owner/leader，依据业务目标/团队目标/任务/计划周期建议分阶段里程碑含验收标准与建议日期) |
| feat | prd-api | 里程碑基线：PmMilestone 增 BaselineDueAt(立项时计划日快照)；ListMilestones 返回 baselineDueAt/driftDays(当前计划-基线)；MilestoneRequest 增 resetBaseline 重设基线；旧数据首次改期自动回填基线 |
| feat | prd-admin | 里程碑面板三视图切换：时间轴 / 月历(MilestoneCalendar) / 基线趋势(echarts: 基线·当前计划·实际达成对照) |
| feat | prd-admin | 新增 MilestoneSuggestPanel：SSE 流式 AI 建议里程碑草稿，可编辑(名称/说明/日期/验收项)+「按顺序串联前置依赖」批量创建 |
| feat | prd-admin | 里程碑详情抽屉展示基线计划日 + 滑移天数 + 重设基线；卡片展示「基线 +N 天」推迟标识 |
| feat | prd-admin | 产品管理智能体新增「缺陷」tab(产品级追溯缺陷一览 + 关联缺陷到产品)；需求/功能/缺陷新增独立详情页(路由 /product-agent/:productId/:kind/:id,可分享 URL)，含基础字段编辑、关系展示与编辑、缺陷追溯互跳 |
| feat | prd-admin | 产品管理智能体表单/流程引擎闭环：新建与详情页按生效的表单模板(产品覆盖>全局)动态渲染自定义字段并存入 FormData；对象绑定流程后显示当前状态 + 可执行流转按钮(WorkflowBar 调 /transition)；创建时自动绑定默认模板与流程并设初始状态 |
| feat | prd-admin | 自定义表单字段类型落地真实功能(参考TAPD)：附件上传(多文件/拖拽/图片缩略图/下载/删除,走 /api/v1/attachments)、富文本(排版工具栏 粗体/斜体/下划线/标题/列表 + 截图粘贴或拖拽上传图片)、对象关联(按类型拉本产品对象多选)、用户选择(复用 UserSearchSelect)；表单编辑器恢复这些字段类型并为关联类型加目标对象选择 |
| feat | prd-api | 产品管理智能体收尾：产品内新建缺陷端点(写 defect_reports + 自动追溯)、跨产品总览图端点(overview/graph 产品→版本)、版本创建自动绑定生效的默认表单/流程模板 |
| feat | prd-admin | 产品管理智能体收尾：总览「图谱」改为跨产品发布地图(ReactFlow,产品节点可下钻)；产品缺陷 tab 支持新建缺陷；版本关系弹层加状态流转条 + 动态自定义字段；需求看板有流程时按状态分列并支持拖拽改状态(走合法流转) |
| fix | prd-admin | 表单模板编辑器：展示各对象的系统预置字段(页面原生渲染,锁定不可改),自定义区明确为"额外字段勿与预置重复";字段类型移除未实现的富文本/对象关联/用户/文件,仅保留有真实控件的 9 种 |
| feat | prd-admin | 产品管理智能体改为全屏页(进入后不显示左侧导航),页首加返回首页按钮 |
| feat | prd-admin | 图谱详情抽屉优化：去掉"收起子节点"，详情(字段+描述)直接展示在抽屉内、编辑才跳转；选中节点高亮区分(卡片白色描边/圆点白色光环,不再用方框) |
| feat | prd-admin | 产品管理智能体知识图谱交互增强：展开/收起子节点、按类型/状态/版本过滤、关键词搜索定位高亮、从任一节点沿关系路径追溯(缺陷→需求→客户)并高亮关系网 |
| feat | prd-admin | 产品知识图谱体验优化：控制栏/画布顶部留白(fitView padding)；连线中间显示关系描述标签(包含/关联需求/纳入功能/实现/来自客户/追溯)；点击任一节点弹出右侧详情抽屉(类型/分级/状态 + 打开完整详情/追溯关系/展开收起子节点) |
| feat | prd-admin | 知识图谱二次优化：连线加箭头(方向)；节点详情抽屉改为直接拉取实体字段展示(编号/分级/状态/描述/关系计数)；追溯模式只暗化非路径节点、保留类型色边框；新增「圆点视图」可切换(彩色圆点大小随重要度+名称在下方) |
| feat | prd-admin | 功能支持关联缺陷：功能详情页新增追溯缺陷区(关联/列出/跳转)；缺陷可追溯到功能 |
| feat | prd-api | 知识图谱缺陷连线支持多目标(需求/功能/版本)，缺陷追溯到功能时画出 defect→feature 连线 |
| refactor | prd-admin | 产品管理智能体 IA 重构 P0：拆分为「产品管理列表页」(/product-agent,增删改查+筛选)与「单产品视图」(/product-agent/p/:id);需求/功能新建改为独立页面;单产品 tab 调序(缺陷移到客户前);升级申请并入版本 tab |
| fix | prd-admin | 文案：总览侧栏副标题改为"全局总览"，概览仪表盘描述改为"全局视角，跨全部产品" |
| feat | prd-api | 管理层总览图谱改为完整跨产品图：overview/graph 返回全部产品/版本/需求/功能/缺陷/客户 + 全部关系，节点带 productId 便于下钻 |
| feat | prd-admin | 管理层总览图谱复用单产品交互图(箭头/关系标签/类型过滤/状态/版本筛选/搜索定位/追溯/卡片与圆点视图/详情抽屉)，支持跨产品并按节点 productId 下钻;ProductGraphCanvas 泛化支持 overview 模式 |
| feat | prd-api | 产品管理智能体管理层总览 P1：新增 product-agent.admin 权限 + 跨产品聚合端点(overview/stats 仪表盘数据、overview/requirements|features|defects|knowledge 跨产品列表，按可访问范围/admin 全量) |
| feat | prd-admin | 产品管理智能体 IA 重构：/product-agent 改为管理层总览 shell(左侧持久导航栏:概览/产品/需求/功能/缺陷/知识库/图谱/设置)；概览仪表盘(6 KPI + 需求分级饼/缺陷状态条/版本生命周期漏斗 ECharts + 最近活动流)；需求/功能/缺陷跨产品数据表；产品区块卡片化管理；设置限 admin |
| feat | prd-api | 新增产品管理智能体(product-agent) P0：产品/版本/需求/功能/客户五类对象 + 通用自定义表单引擎 + 通用状态机流程引擎，8 个新集合与 ProductAgentController |
| feat | prd-admin | 新增产品管理智能体页面骨架（产品列表 + 详情五 tab：概览/版本/需求/功能/客户），注册导航/百宝箱/命令面板 |
| feat | prd-api | 产品管理智能体 P1：版本↔需求/功能反向同步、缺陷追溯(DefectReport.Traced* 字段 + trace/untrace/列出端点)、知识库 find-or-create 挂载(DocumentStore.ProductKnowledgeRef + 产品整体库/版本库) |
| feat | prd-admin | 产品管理智能体 P1：版本关系弹层(多选需求/纳入功能/版本知识库)、需求关系弹层(关联客户/版本 + 缺陷追溯选择器)、产品整体知识库 tab(嵌入 DocumentStoreBrowser) |
| feat | prd-admin | 产品管理智能体页面设计重构 P2：单产品视图改左侧导航栏 + 产品仪表盘(KPI + 需求分级饼/缺陷状态条/版本生命周期漏斗)；全局设置区新增表单模板编辑器(增删字段/类型/必填/选项/排序)与流程模板编辑器(状态 + 流转 from→to/动作/角色/需备注)，全局默认 + 允许产品覆盖 |
| feat | prd-api | 产品管理智能体 P2：知识图谱端点(nodes/edges)、大版本升级申请(VersionUpgradeRequest 模型+集合+CRUD+接入通用流转)、知识库产品成员访问授权(DocumentStoreController.IsProductKnowledgeMemberAsync) |
| feat | prd-admin | 产品管理智能体 P2：知识图谱画布(ReactFlow,类型分列着色+统一手势)、大版本升级申请 tab、需求分级看板视图(P0-P3 分列) |

### 2026-06-01

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | DocBrowser tag 筛选自动剔除当前 entries 不存在的已选 tag，跨知识库切换时不再卡死（Codex P2） |
| fix | prd-admin | DocBrowser 受控 tagColors 用 intentRef 跟踪最新色板，避免快速连点两个 tag 时第二次覆盖第一次（Bugbot Medium） |
| fix | prd-admin | DocumentStorePage tagColors 保存用 seq 守卫，避免老请求 rollback 覆盖新成功的保存（Bugbot Medium） |
| fix | prd-api | DocumentStore 导出/导入 bundle 包含 TagColors 字段，跨环境同步不再丢失自定义颜色（Bugbot Low） |
| fix | prd-admin | 去除赋码采集关联智能体施工中标记，知识库引用支持整库与多知识库选择 |
| fix | prd-api | CCAS 知识库引用支持整库展开、去重与更大上下文预算 |
| feat | prd-admin | 赋码采集关联智能体新增使用帮助抽屉与封面资源槽位 |
| feat | prd-admin | ccas-agent 新增「SQL助手」tab：内置 IN 转化、按行去重两个子工具，纯前端字符串处理零回传 |
| chore | prd-admin | ccas-agent 使用帮助抽屉去掉「封面图在哪加」一节，该信息属管理员后台职责，不在终端用户文档里赘述 |
| feat | prd-admin | ccas-agent SQL助手新增「常用语句」子 tab：内置陈智版 / 米多版 4 条排查 SQL，支持搜索 + 一键复制 + 方言徽章；数据/UI 分离，加新条目只动数据文件 |
| refactor | prd-admin | ccas-agent SQL助手「常用语句」改为左目录右内容布局，左右独立滚动；同步把 IN 转化 / 去重 / 容器层 overflow 重新分层，避免外层全局滚动跟内部 textarea 滚动打架 |
| feat | prd-api | ccas-agent 新增 `POST /api/ccas-agent/sql-ai/stream` SSE 端点，CcasSqlAiPrompts 把陈智版（BagCode/BoxCode 嵌套）+ 米多版（字段拍平）schema 内化进 system prompt，按方言 + 关联模式动态拼接 |
| feat | prd-admin | ccas-agent SQL助手新增「AI 助手」子 tab：自然语言提问 → SSE 流式生成可执行 SQL + 中文业务说明；顶部数据库版本 / 关联模式切换；复制 SQL 智能提取 fenced 代码块；满足 ai-model-visibility 顶部模型徽章 |
| feat | cds | 基础设施预设收敛为单一注册表 SSOT（src/services/infra-catalog.ts）：后端 createInfraPreset 改为读注册表，新增 Kafka / NATS / SQL Server / ClickHouse / Elasticsearch / MinIO / Memcached，消息队列与数据库一键可选，新增基建只需注册表加一条 |
| feat | cds | 新增 GET /api/infra/catalog 端点（按 database/cache/queue/search/storage 分类、脱敏不含密码），前端不再硬编码镜像/端口/连接变量名 |
| feat | cds | 一键部署项目弹窗的基础设施选择器改为读 /api/infra/catalog，按类别分组展示全部预设（含 Kafka/NATS），新增预设自动出现在 UI |
| feat | cds | 新增 4 个自包含示例工程（demo-admin-pg-redis / demo-queue-rabbitmq / demo-stream-kafka / demo-events-nats），均以 image+命令+挂载运行、cdscli verify 评级 A |
| test | cds | 新增 infra-catalog 单测 9 例（向后兼容 5 个旧预设、密码脱敏、卷启发式回退、Kafka KRaft 断言），全量 vitest 1796 通过 |
| docs | cds | 新增 design.cds-ai-compose（AI 借用 CDS Agent/OpenRouter 生成 compose 草稿的可选路径设计）+ plan.cds-visual-deploy（绝对可视化部署计划看板） |
| docs | cds | 新增 guide.cds-deploy-acceptance（部署+验收步骤指南）+ scripts/publish-cds-deploy-acceptance-kb.py，已发布到 prd-api 新知识库「CDS 部署验收知识库」（含主指南 + 4 个示例文档） |
| feat | cds | 拓扑页「新增基础设施」选择器改为读 /api/infra/catalog（按类别列全部预设含 Kafka/NATS），目录预设走新端点 POST /api/projects/:id/infra-presets（复用 applyInfraPresets，真随机密码 + 自动连接变量），修复 change-me 占位弱点；custom 镜像仍走手填路径 |
| feat | cds | 新增数据层操作（Railway 式「数据」面板）：cds/src/routes/infra-data.ts 提供 query/schema/init-sql（按 ?project= 精确定位 infra、密码脱敏），前端 InfraDataPanel 接入拓扑页 infra 卡片，支持 PostgreSQL/MySQL/MongoDB/Redis/ClickHouse |
| test | cds | 新增 infra-data 命令构造单测 11 例 + projects /infra-presets 端点测 2 例，全量 vitest 1810 通过 |
| feat | prd-api | DailyTip 加 `Tier` 字段（basic/advanced），basic 完成一次永不再弹（用 sentinel Version=int.MaxValue 写入 LearnedTips），advanced 走 Version 递增层叠推进 |
| feat | prd-api | /api/daily-tips/visible 响应携带 Tier 字段，前端可据此显示「升级」徽章 |
| feat | prd-api | seed tips 全部补 Tier：feature-release 类（2 条周报/知识库 + 新增 1 条网页托管本周改动）= advanced；其余基础操作教程 = basic |
| feat | prd-api | 新增 seed: `webpages-basics`（basic 4 步：空间模型 + dropzone + 投放面板）+ `webpages-feature-2026w22-pill-controls`（advanced 5 步：分级头部、排序/分组 pill、视图切换、整页提亮） |
| feat | prd-admin | 网页托管补 10 个 data-tour-id 锚点：webpages-root / webpages-header-actions / webpages-space-bar / webpages-space-add / webpages-sort-pills / webpages-group-pills / webpages-view-toggle / webpages-dropzone / share-dock-panel |
| refactor | prd-admin | DocBrowser 条目改单行布局，所有徽章统一压扁 16px 高度，行高节奏一致不再忽高忽低 |
| feat | prd-admin | DocToc 本页章节栏支持左边缘拖拽调整宽度，sessionStorage 持久化（同 sidebar 做法） |
| feat | prd-admin | DocBrowser tag 编辑器加 Finder 风格 7 色圆点选择：点击 tag chip 弹出色板，"默认"按钮回退哈希自动色 |
| feat | prd-admin | tag 颜色用户覆盖通过 TagColorsContext 全局共享，sessionStorage 持久化（后端持久化作为 follow-up） |
| feat | prd-admin | DocBrowser 搜索框下新增 tag 筛选条：多选 chips、横向滚动避免压缩、空状态自动隐藏，sessionStorage 持久化 |
| refactor | prd-admin | 知识库 tag 配色统一走 lib/tagPalette：8 色调色板按 tag 名哈希自动分配，相同 tag 永远同色；列表 chip 默认 2 字截断 |
| refactor | prd-admin | DocBrowser 条目恢复"左标题独占一行 + 右侧两层堆叠（上徽章下时间）"布局，minHeight 44px 保证节奏一致；标题不再被徽章挤压 |
| fix | prd-api | 真因修复：DeleteEntry 之前无条件级联删 Document（共享 SHA-256 内容寻址），把别人引用的 Document 一起删了 → 受害者预览空白 |
| fix | prd-api | DocumentSyncWorker hash 短路 + 304 短路加 self-heal：若 Document 已丢失则强制重拉，让历史污染条目自动恢复 |
| fix | prd-admin | 知识库顶部布局还原：空间切换（我的空间/我的收藏/我的点赞）回到左上角顶部一排，作用域切换（我的/共享文件夹）和「新建空间」下移到第二排，跟随顶部切换变化 |
| fix | prd-admin | 知识库 PR #704 二轮评审修复：loadFavorites/loadLikes 加 stale guard、三个加载器共用 listFetchSeq 实现跨 tab 互相失效、StoreDetailView 返回按当前 tab 路由对应 reload；团队空间新建知识库自动 share 到所选 team（避免新建后消失），未选 team 时按钮 disabled 并附 tooltip |
| fix | prd-admin | 知识库 tab/scope 切换的多项 race + 状态机修复（PR #704 评审反馈）：loadStores 加 fetchSeq 防 stale 响应、scope 显式传参不依赖闭包避免 tab 切换同帧 race、team 空 teamId 时清 loading、mine 不再覆盖团队记忆、筛选空态需 stores 非空、非 owner 隐藏破坏性按钮并改走只读 library 页 |
| feat | prd-admin | 知识库顶部 tab + 工具栏滚动悬浮（sticky）：知识库多时下滑菜单不消失，背景带毛玻璃模糊 |
| fix | prd-admin | 知识库术语与层级统一：顶部 4 个 tab（我的空间/共享空间/我的收藏/我的点赞），下方第二排按 tab 联动；「新建知识库」对话框改为「新建空间」；「共享文件夹」全量改为「共享空间」 |
| feat | prd-admin | 知识库列表第二排新增「标签筛选」下拉（多选，含标签搜索 + 数量 + 已选徽章 + 清除全部），sessionStorage 持久化；筛选无结果空态合并搜索/标签两种条件 |
| refactor | prd-admin | 「共享空间」全量改名为「团队空间」（tab 名、TeamScopeBar、对话框、活动日志、空态文案） |
| feat | prd-admin | 知识库列表第二排新增工具栏：统计概览（共 N 个知识库 · M 篇文章）+ 搜索（按名称/标签）+ 排序（最近更新/创建/名称/文章数，含 active 高亮）+ 新建知识库按钮；搜索词与排序规则通过 sessionStorage 持久化；筛选无结果时显示专门空态 |
| fix | prd-admin | 按用户调整层级模型还原术语：空间=顶层范围（我的/共享），知识库=空间里的条目；按钮/对话框/tooltip 从「新建空间」回滚为「新建知识库」 |
| feat | prd-api | 项目管理智能体目标支持递归拆解：PmGoal 新增 ParentId/Depth，decompose 端点支持 parentGoalId 对任意团队/个人目标拆子目标，子目标继承父 scope，prompt 带祖先链使越深越具体 |
| feat | prd-api | 目标进度三级回退（有子目标→子目标均值汇总→里程碑滚动→手填），删除父目标级联删整棵子树 |
| feat | prd-admin | 目标模块改为缩进树展示父子层级，逐卡「AI 拆细 / 加子目标 / 展开折叠」+ 层级标识，AI 拆解草稿的详细描述改为可编辑 |
| feat | prd-admin | 目标模块新增「思维导图画布」视图（默认，ReactFlow+dagre 横向树）：业务北极星/个人目标双根+团队/个人过滤、节点进度环、折叠展开、点节点右侧抽屉编辑全字段、节点上 AI 拆细/加子目标，统一画布手势；保留列表视图一键切换 |
| feat | prd-api | PM 项目知识库复用文档库：DocumentStore 加 PmProjectId、PmProject 加 KnowledgeStoreId，新增 GET /pm/projects/{id}/knowledge/store（find-or-create + 旧 PmKnowledgeFile 最大努力迁移）；DocumentStore 读写权限按项目成员判定，项目库从个人/公开列表隐藏 |
| feat | prd-admin | PM 项目知识库 tab 改用复用组件 DocumentStoreBrowser（封装 DocBrowser+document-store service），获得文件夹目录/多格式上传/MD预览/标签全套；保留成员托管站点区块 |
| feat | prd-admin | 文件预览支持 HTML 真渲染：html 条目用 sandbox iframe 渲染原文件（fileUrl），替代剥标签后的纯文本，sandbox 防 XSS |
| feat | prd-admin | 项目管理智能体里程碑独立成 tab(MilestonesPanel 时间轴卡片+健康度+关联目标+展开看任务+CRUD)；周报/会议纪要/知识库收进「资料」父 tab |
| feat | prd-api | 新增风险登记册：PmRisk 模型(概率×影响/应对/状态/责任人/关联目标任务)+pm_risks 集合+CRUD 端点 |
| feat | prd-admin | 新增「风险」tab(RiskPanel)：3×3 概率×影响热力矩阵可筛选 + 风险列表 CRUD + 风险值红黄绿定级 |
| feat | prd-api | PMO 项目健康总览：/api/pm/dashboard 扩 portfolioHealth(在管项目进度/逾期/高风险/预算→红黄绿) |
| feat | prd-admin | DashboardView 加「在管项目健康总览」卡片 |
| feat | prd-api | 截止/逾期提醒：PmOverdueReminderWorker 每天扫在管项目，按负责人聚合逾期+临近任务、leader 逾期里程碑，每人一条站内汇总通知 |
| feat | prd-api | AI 结案报告：新增 pm-agent.closure-report AppCaller + GenerateClosureReportAsync + SSE 端点(汇总目标/里程碑/任务/NPSS/风险/决策起草 Markdown) |
| feat | prd-admin | ClosureReportPanel：SSE 流式生成结案报告可编辑→保存到项目知识库；项目头部加「AI 结案报告」入口 |
| feat | prd-api | 项目管理第二波：决策关联目标/任务（PmDecision 增 RelatedGoalIds/RelatedTaskIds，CreateDecision/UpdateDecision 落库） |
| feat | prd-admin | 决策事项可关联团队目标(chip 切换)与任务(下拉添加+可移除 chip)，决策卡展示关联目标/任务 chip；目标详情抽屉反查新增「关联本目标的决策」 |
| feat | prd-api | 项目管理第二波：AI 项目健康诊断（pm-agent.health-diagnosis AppCaller + DiagnoseHealthAsync + SSE 端点 projects/{id}/health-diagnosis，汇总进度/逾期/里程碑健康/风险分布/未决决策/预算/周报趋势，限 owner/leader） |
| feat | prd-admin | 新增 HealthDiagnosisPanel：SSE 流式诊断(thinking/typing)→可编辑 Markdown→保存为知识库健康快照；项目头部新增「AI 健康诊断」入口 |
| feat | prd-api | 项目管理第三波：决策→风险联动（PmRisk 增 RelatedDecisionId，CreateRisk/UpdateRisk 落库，支撑风险回溯来源决策） |
| feat | prd-admin | 风险登记册编辑器增「来源决策」下拉，风险卡展示来源决策 chip；决策卡展示衍生风险 chip + 「据此登记风险」一键登记(自动回链本决策+继承首个关联目标/任务) |
| feat | prd-api | 项目级燃尽/预算挣值报表：GET projects/{id}/burndown（任务完成时间由 pm_task_activities status→done 重建，旧数据回退 UpdatedAt），输出燃尽点(剩余/理想)+挣值点(PV/EV)+SPI 进度绩效+预算/实际/挣值汇总 |
| feat | prd-admin | 项目详情新增「报表」Tab(BurndownPanel)：燃尽图(剩余 vs 理想 echarts 折线)+预算挣值曲线(PV/EV/AC markLine)+完成率/SPI/预算挣值统计卡，主题 token 适配 |
| feat | prd-api | 项目周报支持从周报Agent个人周报导入：新增 GET /pm/weekly-reports/importable（按 report-agent 可见性聚合：作者/leader·deputy/all_members/全局）+ POST /pm/projects/{id}/weekly-reports/import（服务端二次校验+快照渲染为 markdown+回溯 SourceReportId） |
| feat | prd-api | 目标/任务/周报关联建模：PmTask 加 GoalId（成果轴，与 MilestoneId 正交）；PmWeeklyReport 加 RelatedGoalIds/RelatedTaskIds/SourceType/SourceReportId；目标 auto 进度改为「直接任务∪里程碑任务」完成率 |
| feat | prd-admin | 项目周报面板加「导入个人周报」选择器（权限内）+ 周报可关联目标/任务（编辑勾选、阅读展示 chips+来源徽章）；任务详情抽屉加「所属目标」选择器（与里程碑并列） |
| feat | prd-admin | 目标详情抽屉新增反查区：关联任务（直接挂的+里程碑下的，带状态）+ 提及本目标的周报，关系闭环可见 |
| feat | prd-admin | 导入个人周报改为两步：选周报→按「作者+本周窗口」自动勾选推进任务（可调整）→确认导入；目标反查列表点击可跳转到对应任务/周报 |
| feat | prd-admin | 知识库「文档再加工」升级为多轮 AI 对话抽屉：模板变快捷 chip + 流式回复 + 三种写回（替换原文 / 追加末尾 / 另存为新文档） |
| feat | prd-api | DocumentStoreAgentRun 新增 Messages 数组承载多轮对话；新增 reprocess/chat、reprocess/active-run、agent-runs/{id}/apply 三个端点 |
| refactor | prd-api | ContentReprocessProcessor 重构为按对话末尾 user 消息逐轮处理；新增 ContentReprocessApplyService 负责写回 |
| feat | prd-api | 新增 reprocess_agents 集合 + ReprocessAgentSeeder：内置 4 个智能体（文学创作 / 产品评审员 / 周报助手 / 缺陷分析员），支持用户自建个人智能体 |
| feat | prd-api | DocumentStoreController 新增 reprocess-agents CRUD 端点（list / create / delete），processor 按 key 反查智能体的 system prompt |
| feat | prd-admin | 文档再加工抽屉首屏新增「智能体」chip 行 + 「新建智能体」浮层，可直接调用本系统内置智能体或创建专属智能体 |
| refactor | prd-admin | 文档再加工抽屉 v2 改架构：智能体调用统一走百宝箱 `/api/ai-toolbox/direct-chat`（系统智能体 SSOT），不再依赖知识库自建的 reprocess Worker；自建快捷智能体的 system prompt 叠加到通用 chat 链路 |
| feat | prd-api | 新增 `POST /entries/{id}/reprocess/apply-content` 无 Run 依赖的写回接口（replace/append/new），供前端直调百宝箱后 SSE 回写 |
| fix | prd-api | DocumentStoreAgentWorker.EmitEventAsync 加 3 秒硬超时：Redis multiplexer 半失活时 StringIncrementAsync 不按 SyncTimeout 抛异常而 hang 死整个 Worker 主循环（生产实测 root cause） |
| fix | prd-api | DocumentSyncWorker 自愈分支不更新 LastChangedAt：源内容未变，仅重建被误删 Document → 避免 DocBrowser NEW 徽标误亮（Bugbot Low） |
| fix | prd-api | DocumentStore 导入复用同名库时也合并 TagColors（白名单 sanitize），不再静默丢失跨环境同步的颜色（Bugbot Low） |
| fix | prd-admin | tag 颜色保存改 single-flight 队列，latest-write-wins，老请求成功不再覆盖新意图（Codex P2） |
| fix | prd-api | GitHubDirectorySyncService SHA 缓存复用必须校验 Document.RawContent 非空，避免"空壳 Document"通过缓存路径传染到所有 SHA 相同的同步条目（用户表现：同步时间更新但右侧"暂无可预览的内容"） |
| feat | prd-api | 同步路径自愈：SHA 相同但 Document 为空的存量条目，下次同步时强制重新拉取一次 |
| feat | prd-api | DocumentStore 新增 TagColors 字段（tagName→调色板 key 映射），白名单校验 8 色 |
| feat | prd-api | UpdateStore PUT 端点支持 tagColors 字段，传 null 不变、传空 dict 清空 |
| feat | prd-admin | DocBrowser 新增受控 props tagColors + onTagColorsChange：传入时全局持久化、未传时回退 sessionStorage |
| feat | prd-admin | DocumentStorePage 把 store.tagColors 接到 DocBrowser，编辑器选色后乐观更新 + PUT 落库 |
| feat | prd-admin | 右下角教程小书自动展开改为按日级节流：每天最多自动弹一次（含「首次兜底」与「新推送定向 tip」两条路径） |
| feat | prd-admin | 通知列表（顶部铃铛 / 移动端首页 / 移动端通知页）统一按 createdAt 倒序排列，最新通知排在最前 |
| fix | prd-admin | WebPagesPage 文件夹 tab 条补 `data-tour-id="webpages-folders"` 锚点，修复教程引导提示「没找到「第 1/3 步」的目标元素」 |
| fix | prd-admin | 教程小书首访兜底删除冗余 FIRST_VISIT_SHOWN_KEY，避免与日级节流双 flag 不一致（bugbot ref1：旧 flag 在 targeted-tip 路径先触发时永不写入，跨日 remount 会让新用户路径误触发） |
| feat | prd-admin | 网页托管恢复「按日期/按文件夹」分组切换下拉，位于排序下拉与视图切换之间 |
| fix | prd-admin | 网页托管列表视图去掉重度 GlassCard 背景，改为透明行 + 底边分隔线 + hover 高亮，密集列表更清爽 |
| feat | prd-admin | 网页托管页面背景提亮：根容器改为顶部柔和 indigo 光晕 + 上→下 elevated→base 渐变，缓解整体偏暗 |
| feat | prd-admin | 网页托管头部「分享统计」「分享管理」降级为 icon-only 按钮（hover bg + tooltip），与主操作「上传站点」分级，视觉降噪 |
| fix | prd-admin | 网页托管 PageHeader 去掉副标题（"上传 HTML/ZIP…"），首次进入页面已能从按钮和拖拽区猜到能上什么类型，副标题反而占垂直空间 |
| fix | prd-admin | 网页托管页面背景再次提亮：渐变改为 #20212a → #181a22 → #16181f，顶部 indigo 光晕强度从 0.06 → 0.14，肉眼可见的层次 |
| fix | prd-admin | 网页托管列表视图改为容器顶边 + 行底边的「单线分隔」，去掉 gap-2 和圆角，每行只有一条线（之前视觉上「两条线包夹」） |
| fix | prd-admin | 网页托管去掉列表行底边分隔线 + 日期组标题旁的延伸线，靠空白和日期标签做分组，整体更清爽 |
| feat | prd-admin | 网页托管「按日期/按文件夹」改为单击切换的 icon+文字按钮（替代 select），点一下就反转，0 次下拉 |
| feat | prd-admin | 网页托管「排序」从 select 改为 icon+文字 chip + floating menu，去掉表单壳；五个选项保留但视觉降噪 |
| fix | prd-admin | 网页托管空态修复教程引导锚点失效：webpages-folders 改为永远渲染（空态显示一句虚线引导文案），并在空态下补 webpages-card / webpages-viewcount 占位卡，让「网页托管 3 步」教程在新用户零站点场景也能完整跑完 |

### 2026-05-31

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 知识库列表卡片改版:多彩渐变图标(按库取色) + 文章迷你目录(序号+标题+标签+相对时间,露前3篇+「还有N篇」) + 浏览/点赞 meta + 右下角(相对修改时间+贡献者头像),移除底部「打开」蓝条,整卡可点 |
| feat | prd-api | 知识库列表预览接口 recentEntries 增加 tags 字段(每篇文章前几个标签),供卡片文章行展示 |
| feat | prd-admin | 知识库页头:视图切换(我的空间/收藏/点赞)上移到标题行,与作用域控件同排,移除独立第二行 |
| fix | prd-admin | 知识库卡片 RelativeTime 列表场景关闭每实例刷新定时器(refreshIntervalMs=0),避免大列表累积 N 个 setInterval |
| fix | cds | 教程04(及同源 fullstack-infra-smoke)init.sql 列名 name 改 label,与后端健康检查 INSERT/SELECT label 对齐,修复 /api/health 误报 MySQL down |
| fix | prd-api | 知识库列表 with-preview 接口补 LikeCount/ViewCount/FavoriteCount 字段,修复「我的空间」卡片浏览/点赞数恒为 0 |
| fix | prd-admin | 知识库卡片头像兼容两种来源字段:我的/团队列表用 ownerAvatarFileName,收藏/点赞列表用 ownerAvatar,修复互动列表头像空缺 |
| fix | cds | 教程03 后端 Mongo 连接改退避重试,避免 depends_on 短语法下 mongo 慢启动导致 /ready 永久 503 |
| feat | prd-api | 项目管理智能体新增「观察者」角色：与成员同权限、身份互斥、可同时是干系人，并入项目可见性与「我相关的」范围 |
| feat | prd-admin | 项目成员 Tab 拆为「成员 / 观察者」两区块；「我相关的」=成员/观察者/干系人且非项目经理；详情页新增立项后团队协作引导卡；优化立项步骤文案 |
| fix | prd-admin | 任务树修复 4 处竞态：loadTree/卡点墙加 fetchIdRef 防陈旧响应、wheel 缩放 effect 依赖修正确保 svg 挂载后绑定、对话摘取 node 事件加树归属校验 |
| fix | prd-api | 任务树 UpdateNode 防护：根节点不可改父节点（避免整树失去根渲染空白）、新父节点不能是自身子孙（防环） |
| fix | prd-api | 任务树 CreateNode parentId 为空时挂到既有根，避免产生第二个根导致节点在画布消失 |
| fix | prd-api | 任务树 AddDependency 加边前做可达性检测，拒绝形成循环依赖（DependsOn 保持 DAG） |
| fix | prd-api | 任务树 ListBlockers 对 DependsOn 做 null 防护，避免卡点墙聚合时空引用崩溃（High） |
| fix | prd-api | 任务树 UpdateNode 禁止把非根节点清空父节点（防止产生第二个根导致节点消失） |
| fix | prd-admin | 对话摘取切树后节点落到原树时弹 toast 反馈（遵循 server-authority 不中断服务端任务） |
| fix | prd-api | 任务树重命名根节点时同步 TaskTree.Title，避免树下拉/列表仍显示旧名（Codex P2） |
| fix | prd-admin | 任务树切树加载失败时清空画布并提示，避免残留上一棵树；仅首次加载播放整树生长动画（不再切树重放） |
| fix | prd-admin | 对话摘取切树后同步更新底部对话行，避免卡在"正在分析…" |
| fix | prd-api | CreateNode 不再接受裸 DependsOn（依赖一律经 AddDependency 校验+防环） |
| fix | prd-api | UpdateNode 点"卡点"pill（不带 blocker）时保留已有卡点描述，不再清空 |
| fix | prd-admin | 对话摘取 extract 走 VITE_API_BASE_URL 前缀，分离部署时 SSE 不再 404 |
| fix | prd-admin | 切树后 thinking/typing/error 流式事件一并丢弃，不再覆盖新树对话行 |
| fix | prd-admin | 摘取失败替换"正在分析…"占位行而非新增，避免重复消息 |
| fix | prd-admin | removeNode/addDep/removeDep 对 dependsOn 加 null 兜底 |
| fix | prd-admin | 重命名根节点时同步刷新本地 trees 列表（头部下拉即时更新） |
| fix | prd-api | DeleteTree 清理其它树对被删节点的跨树依赖引用，避免悬空依赖边 |
| fix | prd-admin | 创建任务树直接采用返回的树+根节点，不依赖二次 list/detail；失败不弹成功 toast |
| fix | prd-admin | loadTrees/卡点墙 scope 加载失败时报错兜底，不残留旧数据/不误显空状态 |
| fix | prd-admin | 侧栏标题清空失焦时还原为原标题，不留空白编辑框 |
| fix | prd-admin | extract SSE base URL 去尾部斜杠，避免双斜杠路由不匹配 |
| fix | prd-api | CreateNode 在树缺根节点时拒绝挂载，不再产生孤儿节点 |
| feat | prd-api | 个人任务树 v2：卡点墙支持 scope=all 全员聚合（新增权限 task-tree.view-all，给 admin/operator）+ 返回 ownerName/canViewAll |
| feat | prd-admin | 个人任务树 v2 编辑增强：节点加子任务/重命名/删除（含子树）、依赖增删（环防护：排除自身与子孙）、新建任务树入口、卡点墙「我的/全员」切换 |
| feat | prd-admin | 站点分享页评论入口移到顶栏「评论 N」按钮 + 右侧滑出抽屉，PPT/全屏页无需滚动、不遮挡页面控件，并实时展示评论数 |
| feat | prd-api | 有人评论站点时通知站点 owner（系统通知，自评不通知，每条评论幂等一次） |
| fix | prd-admin | 站点评论入口对团队 viewer 角色开放（去掉 canShare gate），「允许访客评论」开关仅 owner/editor 可见 |
| fix | prd-api | 豁免站点维度评论路由（{siteId}/comments 列表+发表、{siteId}/comments-enabled 开关）的 WebPagesWrite 权限闸门，改由 service 层自鉴权（成员可读/评、owner/editor 可改开关），修复团队 viewer/editor 被中间件提前 403 |
| fix | prd-admin | 修复网页托管在团队空间内拖拽上传的网页错误落到个人空间的问题（dropzone 上传后跟随当前空间投送，与弹窗上传路径保持一致） |
| perf | prd-admin | 网页托管列表预览改用 IntersectionObserver 懒挂 iframe，仅视口内卡片加载整页，离屏卸载，缓解大网页拖慢网速 |
| fix | prd-api | 修复网页托管评论作者/分享访问者用户名恒显示「用户」：GetDisplayName 读错 claim 名（应为 displayName），改为正确读取 + DB 兜底 |
| fix | prd-api | 网页托管分享标题去掉「{用户} 分享给你的」前缀（新链接不再写入；旧链接展示侧剥离，免数据迁移） |
| fix | prd-api | 修复网页托管访问统计取到 Docker 内网 IP（172.20.* / ::ffff:）：新增 GetRealClientIp 读 X-Forwarded-For/X-Real-IP 并规整 IPv4-mapped 地址 |
| fix | prd-admin | 网页托管分享页头部去掉「{用户} 分享给你的」前缀，直接显示站点标题 |
| fix | prd-admin | 网页托管 dropzone 拖拽上传：归属团队失败时不再静默报成功，弹错误提示告知仍在个人空间；并补齐团队空间编辑权限闸门，只读 viewer 不能通过拖拽绕过上传按钮投放到团队 |

### 2026-05-30

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 知识库新增模板约束（DocumentStore.TemplateKey）：验收报告库写入时校验必填 metadata（verdict/tier/target）与「需求一一对应表」section，机器归档缺项 422、人工软提醒 |
| feat | prd-api | 知识库跨环境同步：新增 GET /stores/{id}/export + POST /stores/import 端点，按 reportId 幂等去重 |
| feat | prd-admin | 知识库验收报告条目按 metadata.verdict 渲染通过/有条件/不通过状态徽章（新增 acceptanceVerdictRegistry 注册表） |
| fix | prd-admin | 验收报告库 owner 视角排序改为最新在前（created-desc）+ 默认显示更新时间，修复同名报告按字典序乱簇看不出新旧 |
| feat | create-visual-test-to-kb | 归档时建库带 templateKey、条目写 verdict/tier/target/reportId metadata；新增 kb_sync.py 跨环境同步脚本 |
| feat | create-visual-test-to-kb | 归档自动按模块（无模块则 YYYY-MM）find-or-create 子文件夹归类，验收库不再平铺 |
| feat | prd-api | 新增 document-store:read/write AgentApiKey scope；AdminPermissionMiddleware 支持 scope(a:b)→权限(a.b)精确映射；AgentApiKey 补 sub claim 使 M2M Key 能以 owner 身份写文档空间，替代 AI 超级密钥 |
| feat | create-visual-test-to-kb | 归档/同步脚本优先用 MAP_DOC_STORE_KEY（document-store:write 最小权限 scoped key，Bearer），无则回退超级密钥 |
| feat | prd-api | 新增「AI 大事早知道」资讯雷达后端代理（GET /api/ai-news/latest），代理 ai-news-radar 公共源 + 5min 内存缓存 + 6h stale 保底 |
| feat | prd-admin | AI 资讯改为「首页更新中心卡 teaser + 更新中心页 AI 大事时间线」：首页卡片底部偶尔跳出一条资讯标题，点进更新中心看时间分组资讯卡网格（全部/精选 + 加载更多往下翻）|
| feat | prd-api | AI 资讯返回上限 60 → 200，供更新中心时间线「加载更多」往下翻 |
| refactor | prd-admin | 移除首页常驻资讯大侧栏（视觉过重），首页恢复纯净单列布局；资讯逻辑抽到 components/ai-news/ 共享模块 |
| feat | prd-admin | 「AI 大事」默认改为单列新闻流时间线(左时间脊+来源 favicon+标题),可切换网格视图;favicon 加载失败回退分类图标 |
| feat | prd-api | AI 资讯透传 ai_signals 命中关键词数组,供前端做附加标签 |
| feat | prd-admin | 「AI 大事」时间线信息升级:左侧绝对时间轴(HH:MM)+来源身份行(favicon+来源名+站点)+加粗大标题+多标签(分类+命中关键词),每条独立富信息卡 |
| feat | prd-api | 新增「AI 大事」一句话解读：POST /api/ai-news/commentary 按资讯 id 批量调 LLM 生成编辑点评(基于标题/来源/分类)，落 ai_news_enrichments 缓存去重；注册 AppCaller prd-admin.ai-news.commentary::chat |
| feat | prd-admin | 「AI 大事」时间线改为流动新闻 feed(去掉每条独立边框,改细分隔线)，每条新增 AI 一句话解读(渐进拉取+生成中呼吸占位)，让资讯有内容、活起来 |
| fix | prd-admin | 「AI 大事」时间线视觉重做:三列布局(时间/脊/内容)修掉圆点压时间 bug;AI 解读去掉半透明圆角玻璃框,改扁平报刊导语(细实线+文字),整体更干净 |
| feat | prd-api | 「AI 大事」默认改为抓文章 meta 摘要(og:description/description)做内容片段,缓存 Excerpt;新增 POST /api/ai-news/excerpt(匿名,只抓 feed 内已知 URL 防 SSRF);AI 解读降级为抓不到摘要时的备用 |
| feat | prd-admin | 「AI 大事」内容片段默认显示文章摘要(无标签新闻 dek),抓不到才回退 AI 解读(带「AI解读」标签);渐进抓取 |
| feat | prd-admin | 「AI 大事」新增分类筛选:头部下方一排可横向滚动的 chip(全部/精选 + 各 aiLabel 分类,带图标+计数+分类色),点击按分类过滤 |
| fix | prd-admin | 「AI 大事」分类补全:上游 ai_label 实际有 11 种,之前只映了 2 种,补全 热榜/产品更新/开发工具/智能体/机器人/行业商业/算力基建/技术/研究论文,chip 完整(注:上游分类本身可能不准,此为治标映射) |
| feat | prd-admin | 「AI 大事」改双栏布局:主 feed 居左铺主区(去掉居中留白),右侧新增侧栏(今日概览+分类分布 mini bar 可点筛选 + 精选速览列表),宽屏填充右侧;窄屏侧栏自动隐藏 |
| fix | prd-api | 安全:AI 资讯 HttpClient 改走 SafeOutbound 处理器(禁用自动重定向+逐 IP 内网校验),堵住摘要抓取「文章 URL 重定向到内网/元数据地址」的 SSRF(PR #697 Codex P1) |
| fix | prd-admin | AI 大事健壮性(PR审查):feed 并发 load 加 seq 防陈旧覆盖;摘要/解读请求失败撤销占位可重试;摘要+解读都为空标记已解析避免永久「加载中」;无 id 条目不显示加载占位 |
| fix | prd-api | AI 资讯健壮性/安全(PR审查):摘要抓取区分「失败」与「确实无摘要」,失败不缓存待重试;commentary/excerpt 端点 ids 上限 60 防超大 $in;上游 feed 仅接受绝对 http/https URL,挡 javascript:/data: 危险 href |
| feat | prd-api | CDS Agent 工作台优雅降级：新增 Lite 只读审查 runtime 适配器（GatewayReviewRuntimeAdapter），R1 未闭合/官方 sidecar 不可用时不再硬卡报错，改走现有 LLM Gateway 产出只读代码审查 |
| feat | prd-admin | CDS Agent 简单视图新增「Lite 预览 / 官方 SDK」模式徽章与说明横幅；Lite 可用时不再阻塞发起任务 |
| fix | prd-api | InfraAgentSessionService 会话创建/发消息在 lite 兜底可用时不再因 profile 不兼容硬拒绝；运行时按 official/lite/unavailable 三态选择适配器 |
| feat | prd-api | 工作流 CdsAgentRun 事件渲染新增运行状态（Status）渲染，输出明确显示 Lite 预览/官方 SDK 模式，让降级在工作流里也可见 |
| fix | prd-admin | 修复 CDS Agent 工作台请求风暴：SSE pump 改为唯一事件读取器并在收到 done/error/终态 status 时立即停止（杜绝跑完后空转循环请求）；元数据轮询节流（消息/日志 6s、会话列表 12s，不再每 3s 拉 100 个会话） |
| perf | prd-admin | CDS Agent 时间线按 source/level 过滤底层传输 info 级 log（runtime-router/adapter），减少无用渲染，保留 warning/error |
| fix | prd-api | CDS Agent 授权一次即可：GetLongTokenAsync 改 revokeOnFailure:false（解密抖动不再自动吊销授权）；连接被误吊销但凭据仍可解密时自动恢复为 active（TryReactivateIfTokenValidAsync 自愈），不再反复要求重新授权 |
| fix | prd-admin | CDS Agent 后台状态/事件展开：强化噪声过滤（空消息 + 生命周期日志），并让错误/状态/日志等所有事件都能展开看人话细节（错误码/traceId/下一步、运行模式/原因），不再只有工具调用可展开、不再一堆「后台运行日志」无信息 |
| fix | prd-api | CDS Agent 对话模式彻底不依赖 CDS 授权：连接被撤销/凭据失效时，对话（无代码仓库）会话的创建与启动不再抛 connection_not_active，直接走 Lite 本地（仅调 LLM Gateway）；只有「代码巡检（有仓库）」才需要可用 CDS 连接。修复旧会话点「启动」永远报「系统级授权已撤销」的死路 |
| fix | prd-admin | CDS Agent：Lite 可用时不再强制 active CDS 连接即可发起对话会话（connectionId 允许为空），canCreateSession/创建/运行守卫同步放开 |
| feat | prd-admin | CDS Agent 零摩擦：Lite 可用时不再强制「同步系统主模型」——无 profile 也能发起会话（canCreateSession 只需 active CDS 连接），发一句话直接走 Lite 拿到回答 |
| fix | prd-api | CDS Agent 会话无绑定 runtime profile 时（无 provider 凭据）直接走 Lite，不再误选官方 sidecar 卡 R1；GatewayReviewRuntimeAdapter 无工作区时切换为通用助手提示词（对话模式），有代码时才用审查提示词 |
| feat | cds | cdscli verify 新增 compose 评分(0-100 + A-F 等级)+ --min-score 质量门禁 |
| feat | cds | cdscli verify --fix 自愈:自动修 env-var-unresolved / depends-on-hint,其余给建议,--write 落盘(先备份) |
| feat | cds | 新增 4 个从零 CDS 教程示例工程(静态/网页+后台/+MongoDB/+redis+mysql+rabbitmq),均评分 A |
| feat | cds | 新增知识库隔离发布脚本 scripts/publish-cds-tutorial-kb.py(每场景独立 DocumentStore,幂等) |
| docs | cds | 新增 doc/guide.cds-tutorial.md(横向×纵向矩阵指南)+ spec.cds-compose-contract §4.4/§4.5(评分/自愈 SSOT)+ debt.cds-tutorial.md |
| fix | prd-admin | 划词评论选区"自动撤销"修复：MarkdownViewer 用 memo 包裹，避免父级 re-render（liveSelection 变化）导致 ReactMarkdown 按新内联组件标识 remount 正文 DOM、清空原生选区 |
| fix | prd-admin | 知识库选中条目（含分享链 ?entry）自动展开其所有祖先文件夹 + 滚动到可见，解决子文件夹归档后看不到"当前在读哪一篇" |
| feat | prd-admin | 文档列表更新时间默认显示，且永远固定在每行最右边 |
| fix | prd-admin | GitHub 目录订阅父条目"打不开/空白"修复：FilePreview 渲染目录卡片（仓库/路径/分支 + 跳 GitHub），对存量数据立即生效 |
| feat | prd-admin | 验收报告新增「证据关系图」：工具栏按钮（非文章正中）打开 ReactFlow 模态，把报告「## 步骤 N」解析成节点+截图缩略图、按顺序连边，构成探案证据板（手势遵循 gesture-unification 标准 B） |
| fix | create-visual-test-to-kb | 验收报告排序"最新不在最前"修复：归档复用已存在库时补设 templateKey（历史库为 null 导致排序退化字典序）；撤销按模块自动建子文件夹（会把最新报告藏进文件夹、与最新最前打架），报告改平铺根级配合 created-desc |
| fix | prd-admin | 文档列表显示时间跟随排序键（created-desc 显示创建时间），消除"按创建排序却显更新时间"的错位 |
| feat | prd-admin | 文档列表条目改两行布局：第一行图标+标题（不再被徽章挤成 prd-age...），第二行徽章（状态/标签/NEW）+时间；文件夹保持单行 |
| fix | prd-admin | 证据关系图清晰度优化：节点放大(320px)+纵向单列自上而下、连边加粗、缩略图点击弹全屏大图灯箱、默认缩放不过度缩小、模态加大(95vw)，解决"太小看不清" |
| fix | prd-admin | 文档列表条目层次感：两行内部收紧(gap 0.5)成一组、条目间加淡分隔线+增大行距，相邻条目不再糊在一起 |
| fix | prd-api | 安全(P1)：移除 AgentApiKey 全局 sub claim，owner 身份只在通过 scope 门禁的 AdminController 端点注入，避免 document-store:write key 越权访问任意用户端点 |
| fix | prd-api | scope 写蕴含读：document-store:write 自动满足 document-store.read，修复推荐的 write-only key 在 GET 上 403 |
| fix | prd-api | 移除 DocumentStoreController 里用 NUL 字节做字典分隔符（致全文件被 grep/rg 当二进制），改用元组键 |
| fix | prd-api | ImportStore 复用已存在同名库时补 templateKey；跳过 binary-only 空条目；人工写入持久化 templateCompliant 软标记 |
| fix | prd-admin | 证据图按钮 + 祖先展开 parentMap 合并 searchResults，搜索命中的验收报告也能显示证据图按钮/展开定位 |
| fix | prd-admin | 搜索命中条目正文加载错位修复(High)：内容加载 effect 改用 selectedEntryData(含 searchResults)，避免选中搜索结果时 preview 停在上一篇 |
| fix | create-visual-test-to-kb | kb_sync export 失败显式报错(不再 KeyError) |
| fix | prd-api | 跨环境导入跳过所有无正文非文件夹条目(空壳/二进制)，避免重复同步重复插入 |
| fix | prd-api | templateCompliant 标记同时依据 metadata + 正文 section，避免补正文时把缺 metadata 的报告误标合规 |
| chore | prd-admin | 技能精简：下线 5 个冗余/失效技能（bridge / fix-unused-imports / technical-documentation / cn-brief-summary / daily-entropy-plan），official-skills bundle 同步移除 technical-documentation，海鲜市场不再提供该技能 |
| chore | prd-admin | skillGlyphRegistry 移除已下线的 technical-documentation 图标条目 |
| feat | prd-api | 新增个人任务树 Agent 后端：TaskTree/TaskNode 模型 + task_trees/task_nodes 集合 + TaskTreeController（树/节点 CRUD、依赖 DAG 增删、卡点上报、对话摘取 SSE 流式经 LLM Gateway） |
| feat | prd-api | 注册 AppCaller task-tree-agent.extract::chat、权限 task-tree.use（并入三个内置角色） |
| feat | prd-admin | 新增个人任务树页面 /task-tree：思维树可视化（横向 tidy / 径向布局、拖拽平移 + 滚轮缩放）、节点进度编辑、卡点墙上报视图、对话摘取任务（SSE 流式打字） |
| feat | prd-admin | task-tree 注册到 navRegistry + 百宝箱（wip）+ shortLabel；新增 service/contracts/api 端点 |
| feat | prd-api | 网页托管新增评论能力：站点评论 CRUD + owner 开关（hosted_site_comments 集合 + HostedSite.CommentsEnabled），分享页/站内双入口，复用分享可见性+密码门禁 |
| feat | prd-admin | 网页托管评论 UI：分享页 CommentsSection 访客读/登录评，站点卡「评论管理」按钮打开预览弹窗内嵌评论面板 + 允许评论开关 |
| fix | prd-api | 修复评论功能 CDS 编译失败：补齐 HostedSiteService 6 个评论方法实现 + AddCommentRequest 改名避免与 PmAgent 重名 |

### 2026-05-29

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | ccas-agent 新增「智能客服」端点 `/api/ccas-agent/qa/stream`：基于知识库的严格 RAG 问答；联网开关 ON/OFF 切换 system prompt 约束级别（OFF=只用知识库 / ON=允许补充模型公开知识）；reference SSE 事件返回命中条目用于前端引用脚注 |
| feat | prd-admin | ccas-agent 新增「智能客服」Tab：DeepSeek 风格对话 UI（消息气泡 + markdown 流式渲染 + 引用脚注 + 模型可见性 + 联网开关 + 知识库挂载） |
| fix | cds | infra 服务的 yaml command/entrypoint 里的 ${VAR} 引用现在用项目 customEnv 做模板替换,避免被 host shell 展开成空(以前 redis-server --requirepass ${CDS_REDIS_PASSWORD} 会让 redis FATAL 无限重启) |
| security | cds | **High 级修复 (Cursor Bugbot)**:运维操作 session 授权范围加 argsHash 绑定。原 sessionKey 只含 (callerKey, opId),用户对一条 `shell.run dmesg|head` 点"授权 7 天"= AI 之后 7 天可跑任意 root 命令。改后 sessionKey = `${caller}::${opId}::${sha256(args).slice(0,16)}`,不同 args 必须重新审批。7 天 TTL 保留(用户明确要求) |
| security | cds | **Medium 修复**:`POST /api/cds-system/operator/run` 400 响应不再回显期望的 confirmText 字段。原行为允许调用方一次往返拿到 token 立刻重发,绕过二次确认。改后只返通用 hint 文案 |
| docs | cds | 更新 `operator-approval.ts` 顶部注释:1h → 7 天 + 说明 argsHash 绑定原理 |
| fix | cds | **Medium 修复**:`container.startInfraService` 数组形态的 entrypoint 余下元素不再被静默丢失。`entrypoint: ["python3","-m","http.server"]` 现在正确生成 `--entrypoint python3 ... image -m http.server` |
| refactor | cds | [CDS 系统设置] 删除"运维控制台" Tab(`OperatorConsoleTab.tsx` + tabGroups 注册)。与弹窗审批流(`OperatorApprovalModal`)100% 功能重叠且暴露面更大;后端 op 注册表 + 路由全部保留,弹窗审批继续使用 |
| feat | cds | [项目设置 → 基础设施 Tab] 顶部增加「全部启动」/「全部停止」按钮 + 数据卷保留说明,改善 openvisual minio 灾难暴露的"逐个点删除" UX 问题 |
| test | cds | 新增 `operator-approval-args-binding.test.ts` 7 个测试,锁定 session args 绑定行为(避免未来回归到"7 天任意命令") |
| fix | cds | [安全] 虚拟 compose 权威校验补全:diff 改为解析整份文档(含顶层 networks/x-cds-domain)+ 递归到叶子,classifyComposeField 加祖先前缀匹配,堵死"改 networks 子键 / services.*.deploy.replicas 等 platform 字段被当 user 放行"的权威绕过(Codex P2×2) |
| fix | cds | 待审批导入抽屉:审批前对每条拉单条 detail 补回 composeYaml(列表端点刻意 strip),操作员不再盲批 agent 提交的 profile/infra/env(Codex P2) |
| fix | cds | operator 审批弹窗实时刷新:useCdsEvents 订阅 operator.request.* 事件并入 store,弹窗据此秒级刷新,不再最多隐身 25s 等 heartbeat(Codex P2) |
| fix | cds | self-status-cache 刷新合并补队列:运行中再被请求时标脏,当前 job 跑完补跑一次,防止 self-update 收尾的最终状态变化被吞、浏览器卡在 updating(Codex P2) |
| fix | cds | 重启前排空 in-flight 分支操作的默认上限从 5s 恢复到 deploy-safe 的 180s(抽成 DEFAULT_RESTART_DRAIN_TIMEOUT_MS + resolveRestartDrainTimeoutMs SSOT,utility 与 route 包装共用),避免 self-update/self-force-sync 几乎必然在 deploy 中途强制重启留下不一致状态;CDS_RESTART_DRAIN_TIMEOUT_MS 仍可覆盖(0=不等),早返机制不变(Cursor High+Medium) |
| fix | cds | [安全] infra restartPolicy 拼进 docker run 前按 Docker 合法策略白名单校验(no/always/unless-stopped/on-failure[:N]),非法值回落默认,杜绝 `no; touch /tmp/pwn` 类命令注入(Codex review P1) |
| fix | cds | infra resync execute 现在把 yaml 声明的 restartPolicy 落库(update + add 两路径),修复"检测到 restartPolicy 变化但不持久化、startInfraService 回落默认、预览永远报同一处漂移"(Codex review P2) |
| fix | cds | restartPolicy 解析补齐 parseComposeFile / parseComposeString(此前只 parseCdsCompose 有),否则这两条路径解析的 compose 永远不带 restartPolicy、resync diff 检测不到(Cursor Bugbot) |
| fix | cds | [安全] POST /api/infra 在存储边界就 sanitizeDockerRestartPolicy,不只依赖 docker run 时校验,避免未净化值留在 state 被其他路径带进 shell(Cursor Bugbot) |
| fix | cds | toCdsCompose(项目级 /api/export-config 导出)infra 段补出 command/entrypoint/restartPolicy,修复导出再 import 丢失启动命令(minio 崩溃循环复现)+ restart 策略(Codex review P2) |
| fix | cds | [项目设置] 虚拟 compose 首次保存修复:legacy 项目无持久化 composeYaml 时,PUT diff 基线改用 synthesizeComposeFromState(与 GET 一致),避免未改动的平台字段(ports)被误判为新增而拒绝保存(Codex review P2) |
| fix | cds | infra resync 现在能检测 restartPolicy 变化:compose-parser 从 yaml 的 restart: 字段解析 restartPolicy,diffSignatures 不再硬编码覆盖,与文件头声称的重建触发条件一致(Cursor Bugbot) |
| refactor | cds | infra cmd 白名单(minio/elasticsearch 必须显式 command)抽到 config/infra-cmd-whitelist.ts 做 SSOT,pending-import 与 project-infra-resync 共用,消除两处重复(Cursor Bugbot) |
| fix | cds | [安全] operator console requireHuman 同时接受已验证 GitHub 会话(github auth 模式下原来 admin 被 403);GET /operator/requests/:id 改为「人类 OR 本请求发起方」校验,堵 shell stdout/args/logs 对任意认证调用方泄露;session callerKey 绑定真实凭据(Authorization Bearer + ai-access-key 别名 + GitHub session id)优先于 IP,防同 NAT 蹭 7 天 session(Codex P1/P2 + Cursor Medium) |
| fix | cds | [安全] compose 权威 escapeSeg/splitPath:service 名含点(api.v1)时不再被 split 误切,services.*.ports/networks 平台规则仍命中,堵权威绕过(Codex P2) |
| fix | cds | project-compose PUT 补 stateService.save() 持久化(原只改内存,崩溃丢失)(Cursor Medium) |
| fix | cds | pending-import approve + infra-resync update/add 路径补 restartPolicy 透传 + 存储边界 sanitizeDockerRestartPolicy(Cursor Medium/Low) |
| fix | cds | [项目设置] compose/storage/resync 的裸 fetch('/api/...') 改走 apiUrl(),生产托管 dashboard 下正确命中 CDS 控制面而非预览 app(Codex P2) |
| fix | cds | [安全] operator console 的 run/ops/approve/reject/requests 加人类 cookie 鉴权,AI 与项目级 cdsp_ key 一律 403,封死"AI 自请求+自审批执行 root shell"+ confirmText token 泄露(Cursor High + Codex P1×2) |
| fix | cds | [安全] /api/cds-events SSE 对 project-scoped key 按 data.projectId 过滤,不再向某项目的 key 泄露全局 self.status 与跨项目 pending-import/config 事件(Codex P2) |
| fix | cds | pending-import.created 事件自带 pendingCount,消费方收到即可更新角标(Cursor Low) |
| fix | cds | supervisor 启动子进程前先 chdir 到 repo cds/ 目录,避免 @reboot crontab(cwd=/root)下 master 按错误 cwd 推算 config/repoRoot、在错误目录读写 state(Codex P1) |
| fix | cds | supervisor stop 超时强杀时连同 node 子进程一起杀(原来只杀 supervisor shell,child 成孤儿继续跑导致下次启动端口冲突)(Codex P2) |
| fix | cds | cds.migrate-to-supervisor 重排序:先写 marker+crontab+起 supervisor,再 detached 停用 systemd,避免"先停 cds-master 把执行迁移的进程自己杀掉、supervisor 还没起"的死局(Codex P1) |
| fix | cds | 迁移后写 .cds-supervisor-mode marker,exec_cds.sh should_manage_with_systemd 见到即强制非 systemd,阻止 self-update 重启把 systemd 单元装回来与 supervisor 抢端口(Codex P2) |
| feat | cds | [项目设置 → 项目配置] 新增虚拟 cds-compose.yml SSOT:Project.composeYaml 持久化(approve PendingImport 即固化,不再丢弃原始 yaml)+ 下载/复制/编辑回写 + 配置变更广播 project.config.changed 事件 |
| feat | cds | 配置字段三级权威模型(config-authority.ts):repo(workDir/command/image,可改应回写)/ platform(端口/网络/域名,只读)/ user(env,可覆盖)。PUT /compose 强制权威校验,platform 字段被非平台调用方改动一律 403 + 违规清单 |
| feat | cds | 新增 GET /api/projects/:id/compose.yml(下载) + GET /compose(JSON 含三级权威标注) + PUT /compose(回写带权威校验)。老项目无 composeYaml 时从已落库 profile/infra 反向生成只读起点 |
| feat | cds | [项目设置 → 基础设施] 新增「重新同步配置」按钮:粘贴 cds-compose.yml → 后端 diff 当前 vs yaml(adds/updates/removes/noChange)→ 用户预览每项变化原因 → 删除项需输入 yes 二次确认 → 执行批量 stop+rm 旧容器 + 用新签名重建 + start。**docker named volume 自动保留**,删/重建容器其数据卷会被新容器同名挂回。解决用户反馈"想重新初始化项目但没地方做,断头应用"的缺口 |
| feat | cds | 新增 `POST /api/projects/:id/infra/resync/preview` 和 `/execute` 路由(`routes/project-infra-resync.ts`):cmd 白名单复用 pending-import 同款规则(minio/elasticsearch 缺 cmd 直接 400)。diff 算法基于 image/cmd/entrypoint/env/volumes/ports/restartPolicy 任一变化即标"update"。removes 必须 confirmText="yes" 才执行 |
| test | cds | 新增 `infra-resync-diff.test.ts` 7 个测试锁定 cmd 白名单逻辑 |
| feat | cds | [项目设置 → 存储] 新增项目存储面板(feature-emerge 第二波 E7):展示该项目每个 docker named volume 大小/挂载关系/类型,后端 GET /api/projects/:id/storage 解析 docker system df -v 输出,前端 ProjectStorageTab 带刷新按钮 + 空状态引导 |
| feat | cds | 新增 volume-size 服务(parseDockerSystemDf 解析 + formatBytes 格式化),15 例单测覆盖大小单位/边界/空输出 |
| feat | cds | [项目设置 → 基础设施] 重新同步配置增强:yaml 来源三选一(① 项目根目录的 cds-compose.yml 默认 ② 最近 3 条已审批 PendingImport ③ 手动粘贴),新增 `GET /api/projects/:id/infra/resync/sources` 自动读取项目仓库根目录的 compose 文件 |
| feat | cds | 重新同步删除项新增「同时删除数据卷」复选框(默认不勾=只删容器数据卷保留;勾选=docker volume rm 彻底重装)。后端 execute 接 deleteVolumes 参数,ContainerService 新增 removeNamedVolumes 方法,bind mount 跳过,结果回 volumeRemovals |
| feat | cds | 分支卡新增「服务漂移」徽标 + 一键收敛:期望态(项目全部 build profile)vs 实际态(branch.services 快照)做 diff,缺失/异常服务在卡片上点名显示,点击按最新构建配置重新部署补齐(走 /deploy 而非 force-rebuild) |
| fix | cds | computeServiceDrift 纯函数 SSOT 落 deploy-runtime.ts,根治"项目加了 profile 但已部署分支不回灌、UI 只显示数量看不出少了谁"的快照漂移盲区 |
| fix | cds | 预览页左下角 widget 的 commit id 恢复显示 7 位短哈希（复用 shortSha()，完整 SHA 移入 title tooltip） |
| feat | prd-api | 新增项目管理智能体后端：PmProject/PmTask 模型 + PmAgentController(立项/任务CRUD/批量创建) + PmAgentService(AI 需求拆解 SSE 流式) |
| feat | prd-admin | 新增项目管理智能体前端：项目列表/立项弹窗 + 看板/列表/甘特图三视图 + AI 需求拆解面板，注册到百宝箱(wip) |
| feat | prd-api | 项目管理 Phase 2：干系人(权力利益矩阵) + NPSS 结案评价(受益方 2× 加权满意度 + 成功/平庸/失败等级) |
| feat | prd-admin | 项目管理 Phase 2：干系人 Tab(2×2 矩阵+列表) + 结案评价面板(0-10 打分→NPSS 满意度/等级) + 等级徽章 |
| fix | prd-admin | 修复项目管理智能体未出现在 AI 百宝箱：补登 toolboxStore.BUILTIN_TOOLS + ToolCard 注册 FolderKanban 图标 |
| feat | prd-api | 项目管理 Phase 3：组织级 NPSS 仪表盘(成功占比−失败占比 vs 全球基线36) + 奖金计算(基数×价值系数×满意度/100，<60归零，整改/督办无奖金) + 奖金配置端点 |
| feat | prd-admin | 项目管理 Phase 3：NPSS 看板(总览/等级分布/M.O.R.E自评/奖金明细) + 奖金基数配置编辑 + 项目价值系数 |
| fix | prd-api | 修复立项提交报错 Serializer User has no member Id：User 主键是 UserId（Id 被 UnmapMember），3 处查询改 u=>u.UserId |
| fix | prd-admin | 修复 modal 背景透出底层页面：modal 卡片背景由半透明 --bg-card 改为不透明 --bg-elevated |
| feat | prd-api | 项目管理 Phase 4：财年维度 NPSS 盘点(财年起始月可配) + 季度盘点 + 优秀项目评选 + 成本侧进度留痕(按时交付率/预算控制率) |
| feat | prd-admin | 项目管理 Phase 4：NPSS 看板增财年选择/季度盘点卡/成本指标卡/优秀项目星标；项目详情增预算-实际成本编辑 |
| feat | prd-admin | 任务管理 P0+P1：任务详情抽屉(全字段编辑)+拖拽排序落库+筛选/分组/仅看我的+逾期标记+子任务+依赖守卫 |
| feat | prd-api | 任务管理 P2：任务活动日志+评论(pm_task_activities)+批量操作端点+看板 WIP 限制(PmProject.WipLimits) |
| feat | prd-admin | 任务管理 P2：抽屉动态/评论区+列表多选批量操作(改状态/优先级/负责人/删除)+看板 WIP 上限配置与超载红标 |
| feat | prd-agent | 项目类型新增「普通」(默认)；项目管理首页新增使用说明引导区(可收起) |
| chore | prd-agent | 去除项目管理所有「米多/对齐米多」字眼，改为通用表述 |
| refactor | prd-api | 干系人改为从系统用户选择(+外部手填)；结案评价重构为多人独立打分流程：发起/各自打分/汇总(round 模型 + 权限隔离 + 干系人可访问项目) |
| refactor | prd-admin | 干系人列表改 UserSearchSelect 选人 + 外部手填；结案评价改为发起→各干系人独立打分(互相不可见,逐人提交)→全部评完汇总的协作流程 |
| refactor | prd-agent | 干系人一律为 MAP 用户(外部客户改选用户作代表+必填备注)；干系人界面重做为权力利益矩阵内点格加人/点卡编辑(单卡编辑,不再整列展开)；干系人变更自动失效进行中评价轮保持一致 |
| fix | prd-admin | 干系人编辑卡底部增主「保存」按钮，紧挨编辑区，避免顶部保存按钮太远被忽略 |
| feat | prd-admin | 项目管理智能体百宝箱卡片新增专属封面插画(看板/甘特意象),替代兜底图标 |
| feat | prd-agent | 项目管理信息架构 P0(一)：项目列表分「我管理的/我相关的/全部」(ListProjects scope)；立项强制指定项目经理(LeaderId 必填+弹窗 UserSearchSelect 字段)；新增项目成员管理端点 GET/PUT projects/{id}/members |
| feat | prd-agent | 项目管理 P1：项目知识库（多格式上传/分类/下载/删除，pm_knowledge_files + IAssetStorage）+ 网页托管联动（项目经理在知识库免密聚合查看成员已发布站点）|
| fix | prd-api | 补全 P1 知识库后端端点：上一提交仅注入了依赖与请求类，遗漏 list/upload/update/delete + member-sites 实现，前端调用会 404，本次补齐 |
| feat | prd-agent | 项目管理 P2：决策事项管理（待决策/已决策/备忘三态分栏，pm_decisions + PmDecision 模型）；转入已决策落定案人/时间，支持新建/内联编辑/状态流转/删除 |
| fix | prd-api | 修复组织 NPSS 为负的口径问题：公司级 NPSS 只统计正式分级项目（战略/创新/运营），排除普通项目；普通项目误计入是 -100 的根因 |
| feat | prd-api | 组织 NPSS 看板加管理层权限门：新增 pm-agent.dashboard 权限，仅授予管理层可看公司级经营看板（super/root 自动放行） |
| fix | prd-admin | NPSS 看板无分级项目时显示「—」而非误导性的「低于全球基线」；标题补口径说明；NPSS 看板入口按钮按 pm-agent.dashboard 权限显隐 |
| feat | prd-agent | 项目周报管理：PmWeeklyReport 模型 + pm_weekly_reports 集合 + 周报 CRUD 端点；前端 WeeklyReportsPanel（左列表+右阅读/编辑，支持 md 文档导入、内嵌图片上传插入、实时预览、reading 版式美化排版）；项目详情新增「周报」Tab |
| feat | prd-admin | MarkdownContent 增加响应式 img 渲染器（max-width 限制+圆角+懒加载），修复 Markdown 图片溢出，惠及知识库/周报等所有 reading 场景 |
| fix | prd-api | 修复项目知识库上传报错「type 不支持：pm-knowledge」：IAssetStorage 的 type 只允许 img/doc/font 等固定集合，知识库改按 mime 路由(图片→img，其它→doc) |
| fix | prd-agent | 项目成员：项目经理默认加入成员(立项写入+GetMembers/SetMembers 始终含 leader 且不可移除，兼容历史项目)；前端添加成员时用 MAP 用户列表立即解析显示名/头像，不再展示原始 UserId |
| feat | prd-agent | 项目管理 P3：会议纪要管理（PmMeeting 模型 + pm_meetings 集合 + CRUD 端点）；前端 MeetingsPanel（左列表+右阅读/编辑，参会人多选、会议时间/地点、Markdown 纪要正文+图片+reading 版式）；项目详情新增「会议纪要」Tab |
| feat | prd-agent | 项目管理 P4：目标/计划管理（PmGoal 模型 + pm_goals 集合 + CRUD 端点，可见性后端隔离：团队目标全员可见、个人目标仅本人）；前端 GoalsPanel（团队/个人两段，进度条+状态徽章+指标/周期，个人目标仅本人可改）；项目详情新增「目标」Tab；Tab 条改为可换行避免拥挤 |
| feat | prd-admin | 甘特图任务名/时间条可点击，复用统一的 TaskDetailDrawer 右侧抽屉查看任务详情（与看板/列表一致） |
| feat | prd-admin | 甘特图任务条上显示负责人（负责人名 + 人天，tooltip 带负责人） |
| feat | prd-agent | 项目管理 P6：审计日志（PmAuditLog + pm_audit_logs）。PmAuditActionFilter 统一拦截所有写操作(POST/PUT/DELETE)成功后自动留痕，覆盖 32 个动作零埋点；新增 pm-agent.audit 权限 + GET /api/pm/audit-logs(管理层可见，批量解析操作人/项目)；前端 AuditLogView 表格(时间/操作人/操作/项目/方法路径+分页)，入口按权限显隐 |
| feat | prd-agent | 项目管理 P7：任务评论 @ 提醒。评论可 @ 项目成员（前端 @ 自动补全下拉，回车/Tab 选中），后端为被提及成员各写一条站内通知（复用 admin_notifications 通知中心，TargetUserId 定向，Source=pm-agent，校验确属本项目成员防越权 @） |
| refactor | prd-admin | 项目管理信息架构阶段A：Tab 收为 8 个并按「目标/任务/决策/周报/会议纪要/知识库/成员/干系人」排序；看板/列表/甘特合并进「任务」Tab 内部视图切换；快速添加任务+AI拆解需求仅「任务」Tab 显示，结案评价留 header |
| feat | prd-agent | 项目管理阶段B：里程碑（PmMilestone 独立节点 + pm_milestones 集合 + CRUD 限 owner/leader）；PmTask 增 MilestoneId；里程碑进度按任务完成度读时滚动 + 派生健康度(on_track/at_risk/overdue/reached)；甘特图渲染里程碑菱形+竖虚线；任务详情抽屉可选所属里程碑；MilestonesBar 管理条；删除里程碑自动解除任务归属；审计补 3 个里程碑动作
| feat | prd-agent | 项目管理阶段C(核心)：目标 Tab 以业务目标为北极星 + 里程碑时间轴；目标进度支持 auto(关联里程碑任务完成度滚动)/manual(手填) 两模式；团队目标创建/编辑/删除收紧到 owner/leader(个人目标仍仅本人)；里程碑可关联目标(MilestonesBar 目标下拉)，驱动目标进度滚动
| feat | prd-agent | 项目管理阶段C(AI拆目标)：依据业务目标 AI 流式拆解目标/关键结果(OKR)。后端 PmAgentService.DecomposeGoalsAsync + SSE 端点 POST projects/{id}/goals/decompose(限 owner/leader) + AppCaller pm-agent.goal-decompose::chat；前端 GoalDecomposePanel(thinking/typing 实时展示+草稿审核编辑)，确认后批量创建为团队目标，目标 Tab 团队段「AI 拆目标」入口
| fix | prd-admin | 项目管理页文案对齐目标导向生命周期：副标题改「立项 → 目标 → 里程碑 / 任务 → 推进 → 结案」；引导简介与步骤卡补「定目标」(3步→4步)；空状态文案同步
| fix | prd-agent | 成员列表项目经理始终置顶；结案评价收紧为「仅项目经理发起 + 须过项目计划结束时间」，后端 StartEvaluation 强制校验(限 leader/未设结束时间或未到期均拦截并给提示)，EvaluatePanel 发起按钮按规则显隐+禁用+到期提示
| fix | prd-admin | 项目管理引导步骤卡「立项」去掉「（默认普通）」文本
| fix | prd-api | 项目列表「我相关的」口径修正：改为「我被设为干系人 且 我不是项目经理」的项目（原先多含了我创建的项目，已去掉 OwnerId 条件）
| fix | prd-agent | 创建项目支持设置项目时间（开始/结束，开始可早于今天）；项目详情头部显示并可内联编辑项目时间（改动经审计日志记录）；「立项注册」改名「创建项目」
| fix | prd-agent | 结案评价：完成后不可重复发起（前端隐藏「重新发起」+ 后端 StartEvaluation 拦截已 finalized/已有 evaluation）；收集中新增评分进度条（谁已评/未评一目了然，配合每行已评/待评徽章）
| fix | prd-api | 收紧划词评论写权限：私有库即便有分享链，第三方登录用户也不能写评论（PR #685 Bugbot/Codex High），canCreate 改为仅 owner + 公开库登录用户；List 仍允许分享访客读评论气泡 |
| fix | prd-api | owner-only 合集分享改逐站点验证团队权限：每个目标站点都需 owner 或团队成员，杜绝跨团队成员越权拿到非己团队站点（PR #685 Codex P1）。错误提示从"仅限创建者/团队"改为"含一个或多个你无权访问的站点" |
| fix | prd-api | 抽取 EnforceShareVisibilityAsync 共享方法，SaveSharedSiteAsync 同步加 Visibility 校验，防止 /save 端点绕过 /view 的 owner-only 防盗（PR #685 Codex P2） |
| fix | prd-admin | ShareAnalyticsDrawer 加 fetchIdRef stale-response 守卫，rangeDays 快速切换 7→30→90 时慢响应不再覆盖新结果（PR #685 Cursor Bugbot Medium） |
| fix | prd-api | CapsuleExecutor 工作流自动分享(autoShare=public/password)显式传 visibility=public，修复新默认 owner-only 导致外部分享链返回 visibility_denied 的 regression（PR #685 Codex P2） |
| fix | prd-api | ListInlineComments 读权限收紧到 valid share context：私有库须带未撤销+未过期的有效 shareToken 才能读评论，不再靠"存在任意分享链"放行（PR #685 Codex P1）；新增 ?shareToken= 参数 |
| fix | prd-admin | DocBrowser 新增 inlineCommentShareToken prop，分享视图透传分享 token 读私有库评论气泡；InlineCommentDrawer 同步透传 |
| fix | prd-api | EnforceShareVisibilityAsync 复制 SiteIds 新 list 再 Insert，避免原地 mutate 实体污染下游（PR #685 Bugbot Low） |
| fix | prd-admin | SharesPanel refreshShares 加 fetchIdRef stale-response 守卫（PR #685 Bugbot Low） |
| fix | prd-api | ListInlineComments 的 shareToken 校验补 EntryId 匹配：单文档分享 token 不能越权读整 store 评论（PR #685 Codex P1） |
| fix | prd-admin | fetchIdRef stale guard 改用 try/finally 保证 loading 清理：仅 latest 请求清，stale 让位避免 spinner 卡死（PR #685 Bugbot Medium）。SharesPanel + ShareAnalyticsDrawer 同步 |
| chore | prd-admin | 删 dead code listShareLogsForSite（services/real + index.ts re-export），无 consumer（PR #685 Bugbot Low） |
| fix | prd-api | CreateShareAsync 复用路径把 Visibility 加入 reuse key：请求 public 不再复用到旧 owner-only 链接，修复工作流自动分享仍可能返回 owner-only token 的 High 漏洞（PR #685 Bugbot High / Codex P2 二次）；legacy 空 Visibility 按 public 兼容匹配 |
| fix | prd-admin | DocBrowser 评论计数 fetchIdRef 守卫：进入条目预拉 + onClose 重拉都用同一 ref，切换条目时旧响应不覆盖新计数（PR #685 Bugbot Low） |
| fix | prd-api | GitRepoCacheService 加 per-cache-key SemaphoreSlim 锁，串行化同一仓库的并发 clone/fetch，避免两个用户同时引用同一 URL 时互相破坏 .git 目录 |
| feat | prd-api | GitRepoCacheService 启动时 fire-and-forget 异步清理超过 7 天未访问的缓存目录，防止 /tmp/project-route-agent-cache 无限累积 |
| test | prd-api | 新增 GitRepoCacheServiceTests：启动清理删旧留新 + 并发 EnsureClonedAsync 不死锁 |
| feat | prd-admin | 项目路由智能体新增专属动态卡片插画 ProjectRouteAgentCardArt：方案 .md → AI 抽取 → 多仓库克隆 → routemap 项目路径的完整业务流视觉化，含 dash 流动连线、仓库脉冲、命中行高亮、顶部 LIVE 状态、扫描线 5 处 SVG 动画 |
| feat | prd-admin | ToolCard / AgentLauncherPage 在 review-agent 之后挂载第二条内联插画分支 project-route-agent |
| feat | prd-api | 公共站点说明 UpsertSiteSpec 去掉 manage 权限校验，所有有 project-route-agent.use 权限的用户都能保存 |
| feat | prd-admin | 项目路由智能体页面「公共站点说明」tab 去掉 canManage 条件渲染，所有授权用户都能进入查看和编辑 |
| fix | prd-api | SSE WriteEvent + 心跳协程的 catch 列表新增 IOException，客户端断开时不再被外层 catch 当成业务异常上报，日志干净 |
| fix | prd-api | AnalyzePlanStream 的 writeLock SemaphoreSlim 用 using 释放，规范资源生命周期 |
| feat | prd-admin | 公共站点说明 AdminView 顶部新增「最近由 X 于 时间 更新」修改痕迹 + 多人协作提示文案，对应权限放开后的可追溯性要求 |
| feat | prd-api | UpsertSiteSpec 增加乐观锁：客户端提交 expectedUpdatedAt，与 DB 当前 UpdatedAt 差 >100ms 返 409 STALE_UPDATE，避免多人协作时静默覆盖 |
| feat | prd-api | UpsertSiteSpec 增加后端 markdown 大小校验（2 MB 上限），防止恶意客户端绕过前端 1 MB 限制 |
| feat | prd-admin | 公共站点说明顶部新增「重新加载」按钮 + 服务端原文 ref 做 dirty 检测，有未保存草稿时弹 confirm 防止误覆盖 |
| feat | prd-admin | upsertSiteSpec service 新增 expectedUpdatedAt 字段；save 时遇 STALE_UPDATE 错误高亮提示本地草稿仍保留 |
| fix | prd-api | 项目路由智能体 AnalyzePlanStream 增加 SSE 心跳（每 8s 写 `: keepalive`），对齐 server-authority 规则 #4，防止 LLM/克隆耗时超过 60s 时被 nginx/CDN 默认 idle timeout 断流 |
| fix | prd-api | 修复网页托管「替换网页不生效」——SiteUrl 追加 ?v={UpdatedAt.Ticks} 版本指纹，内容不变命中缓存、重新上传击穿缓存 |
| feat | prd-api | IAssetStorage.UploadToKeyAsync 支持 Cache-Control，网页托管对象设 public, max-age=3600 |
| fix | prd-api | 缓存指纹改用 ContentVersion（仅创建/重传变化），改标题/可见性等元数据不再误击穿 PDF 缓存 |
| fix | prd-api | ContentVersion 去掉 UtcNow 初始化器（老文档每次读都变）+ 读取侧回退 CreatedAt，老分享 PDF 缓存稳定 |

### 2026-05-28

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 赋码采集关联智能体 PRD Tab 增加「上传 .md/.txt 文件」按钮（FileReader 浏览器端读入，单文件 ≤ 2MB） |
| feat | prd-admin | 赋码采集关联智能体 PRD Tab 增加「引用知识库」抽屉：复用 document-store API（按 appKey=ccas-agent 优先排序），多选条目（上限 20 条 / 24K 字符），含 token 预算条 |
| feat | prd-api | CcasAgentController.GeneratePrdStream 增加 referenceEntryIds 字段：从 document-store 读条目内容，按 8K / 24K 字符预算注入到 system prompt 末尾「## 领域参考资料」段，权限只允许引用自己的或公开的空间，新增 reference SSE 事件回报实际注入数 / 跳过原因 |
| fix | cds | infra 容器全链路修复 yaml `command:` 透传:`ComposeServiceDef` / `InfraService` 加 command + entrypoint + restartPolicy 字段;parser 提取;`composeDefToInfraService` / `pending-import apply` 写库;`docker run` 把 cmd 拼到 image 之后 + `--entrypoint` flag。修 openvisual minio 容器无 cmd 启动后 exit 0 + unless-stopped 288 次重启拖垮 host 的灾难 |
| fix | cds | infra 容器默认 `--restart` 从硬编码 `unless-stopped` 改成 `on-failure:3`,可在 yaml 用 `restart:` 字段覆盖。避免烂配置 churn 全 host |
| feat | cds | 新增 `infra-flap-watchdog`:每 60s 扫所有 `cds.type=infra` 容器的 RestartCount,5 分钟内 delta ≥5 → 自动 `docker stop` 打破循环 + 标 service.status=error + bus 广播 `infra.flap.circuit-breaker` 事件。env: `CDS_INFRA_FLAP_*` 可调 |
| feat | cds | pending-import 审批时新增 infra cmd 白名单校验:minio/elasticsearch 这类需要子命令的 image 缺 cmd 直接 400 拒绝并给出修复示例,源头堵住灾难复现 |
| feat | cds | 所有 CDS 管理容器新增 `cds.project.id` label(app + infra),为后续按项目过滤清理铺路。老 legacy infra 用 `_legacy` 占位 |
| feat | cds | cds-events-bus 新增事件类型:`pending-import.created` / `pending-import.decided` / `pending-import.count` / `infra.flap.circuit-breaker`。pending-import 提交/审批/拒绝时实时 publish,替代前端 10s 轮询(全局徽章前端待 Phase B 接入) |
| feat | cds | 项目设置新增「基础设施」Tab(`ProjectSettingsPage.tsx`):列出该项目所有 infra 容器(mongo/redis/minio/postgres 等),支持启动/停止/删除。修复"openvisual 烂 minio infra 没法在 UI 删,只能调 API DELETE"的 UX 缺陷 |
| docs | cds | 更新 `cds-project-scan` / `cds` 技能文档 + `cdscli.py` 错误提示:Agent 提交 pending-import 后**不再需要主动告诉用户审批 URL**——CDS Dashboard 任意已登录页面右下角会自动弹出"Agent 导入 N"徽章(2026-05-28 起)。直达链接保留作 fallback |
| feat | cds | 新增 `PendingImportInbox` 全局组件:右下角浮动徽章 + 抽屉,任何页面都能看到 agent 提交的待审批 cds-compose 申请,一键批准/拒绝。事件驱动(订阅 `pending-import.*`),不再 10s 轮询。挂在 AppShell 与 OperatorApprovalModal 同层,用户不再需要 AI 给地址才能打开审批面板 |
| feat | cds | `useCdsEvents` hook 订阅新增 `pending-import.created/decided/count` + `infra.flap.circuit-breaker` 事件,在 store 中暴露 `lastPendingImportEvent` / `lastFlapEvent`,供 UI 组件响应 |
| feat | cds | infra flap 熔断告警自动在右下角持久 toast:容器名 + RestartCount + dismiss 按钮。用户能立刻知道是哪个 yaml 配置错引起的 |
| revert | cds | 回滚 @vitejs/plugin-react-swc → @vitejs/plugin-react。prod CDS host 上 @swc/core postinstall 下载 native binary 失败,导致 web pnpm install exit=1,整个 self-update 中止。本地实测 SWC vs Babel 速度持平(6.8s 都一样),收益本来就是零,移除以免再次卡死 self-update。仍保留 build script 里"删重复 tsc"那行 |
| refactor | cds | 重构 CDS 自更新状态可观测链路:新增 self-status-cache 权威缓存 + cds-events-bus 单一事件总线,消除 /api/self-branches 500 + /api/self-status?probe=remote 重复请求循环 |
| feat | cds | 新增 GET /api/cds-events SSE 统一通道,前端只需一条长连接;新增 POST /api/self-refresh 任务化刷新接口 (202 + jobId) |
| fix | cds | /api/self-branches、/api/self-status、/api/pending-imports 失败时永远返 200 + degraded,不再 4xx/5xx;鉴权失败仍返 401/403 |
| feat | cds/web | 新增 useCdsEvents hook(全局单例 EventSource + 状态机:idle/connected/degraded/refreshing/updating/disconnected/error),GlobalUpdateBadge + MaintenanceTab 合并订阅,移除独立轮询 + fallback polling |
| fix | cds/web | 修复快速切换路由时 cds-events SSE 触发浏览器原生重连风暴 — onerror 中显式 close + 自家 exponential backoff 接管,防止 Cloudflare 400 spam |
| fix | cds/web | RouteFallback 用 CdsLogoLoader 替换裸"加载中..."文本,跟品牌一致 |
| fix | cds/web | DashboardErrorBoundary 改为右下角小 toast (createPortal + position:fixed z-99999),严禁占满主区;chunk-load 失败 5s 冷却内自动 reload(原 60s 过长) |
| fix | cds/web | ApiError 增 transient 标志,Cloudflare 边缘 400/5xx + 空 body + 无 requestId 时识别为抖动,UI 文案精简为"网络抖动,稍后自动恢复"(完整诊断到 console);BranchListPage 三处 refresh 路径在 transient 时静默保留 lastKnownGood,不再弹横幅 |
| fix | cds/web | apiRequest 加 transient 静默重试 — 检测到 4xx/5xx + 空 body + 无 requestId 自动 500ms 后重试一次,99%+ Cloudflare 边缘抖动用户无感(GET 自动,POST 需 retryTransient:true) |
| feat | cds/web | 新增 useSseConnection hook(通用 SSE 长连接管理:onerror 立即 close + 5s/10s/20s 退避,3 次后停),作为后续 6 处 EventSource 迁移目标 |
| fix | cds/web | 5 处 raw EventSource 加 close-on-error 阻断浏览器原生 3s 重试:CommitInbox / BranchTopologyPage / BranchDetailPage ×2 / BranchListPage ×2 |
| fix | cds/web | ErrorBlock 加 transient 参数,transient=true 时完全不渲染(配合 ApiError.transient),为 20+ 处现有调用提供逃生通道 |
| fix | cds | infra auto-restart crash loop 检测 — 跟踪 lastSuccessfulStart 时间戳,启动后 < 60s 又死的标软失败,N 次软失败后 svc.status=error 停止重试。修复 minio "docker start 永远成功但 5s 后死" 的 30s 死循环 |
| fix | cds/web | App.tsx ErrorToastPortal 硬编码 #fff/#ef4444 改走 hsl(var(--destructive)) token,符合 cds-theme-tokens 双主题规则 |
| fix | cds | Node http.Server.keepAliveTimeout 5s → 65s + headersTimeout 70s,匹配 nginx upstream idle pool 60s。修复 nginx-reverse-proxy 场景下 stale-keepalive 导致 SSE 端点 50% 严格交替 400/200 的根因(SSH 现场诊断证实) |
| feat | cds | 运维控制台改弹窗审批流 — AI 通过 POST /operator/request 发起 → 全局 Modal 在任何页面弹出「允许本次 / 允许本 session(1h) / 拒绝」三按钮 → CDS 后端按 caller key + opId 记 session,1h 内同一发起方+同一 op 自动通过,免重复点击 |
| fix | cds | operator host.stats op 命令优化 — 简化 docker ps format 字符串避免 shell escape bug,加显式 `> cmd` log,超时延长到 8s |
| fix | cds | 拆除所有资源限制 — cds-master.service CPUQuota 100%→不限制(原只允许 1 core,导致 tsc/vite 编译被卡 5min+ 后 fail);cds-forwarder.service MemoryMax 256M→infinity + CPUQuota 50%→不限制;container.ts 移除 --cpus docker flag;100GB RAM + 18 cores 不需要任何 cgroup 防爆 |
| perf | cds | self-update / force-sync drain wait 默认从 180s 砍到 5s,且超时后不再 deferred 而是直接 restart——docker 容器归 daemon 管,cds-master 重启不影响在跑容器,断掉的 deploy SSE 由 webhook/UI auto-reconnect 兜底。"我没动其他容器但 self-update 要 3 分钟"根因 |
| refactor | cds | container.test.ts 同步移除 `--cpus` 残留断言,与"关闭所有容器资源限制"政策对齐 |
| fix | cds | [CDS 系统设置] 自更新历史改为常驻显示在「更新与重启」页面下方(不再藏在 Dialog 后面),并把"上次更新"chip 从可点击按钮改成纯标签(指向下方"完整历史见下方"),根治"按钮不够明显"和"看一眼被闪掉"两个问题 |
| fix | cds | 自更新历史列表不再随 SSE 每次 self.status 事件 re-render — 改用独立 `/api/self-update-history?limit=20` endpoint + 仅在"自更新真正完成"(updating: true→false)或用户点"刷新"按钮时才 fetch。中间的 heartbeat / status tick 全部忽略,杜绝看历史时被刷新闪掉 |
| feat | cds | 自更新历史可观测性加强:`SelfUpdateHistoryList` 在维护面板增加顶部聚合统计条(成功率/最快/中位/平均/P95/最长一次原因)+ 每条记录新增「阶段耗时条」可视化(拉取/切分支/install/tsc/cache/后端esbuild/web 重建/重启 各段按比例铺色),并补全 `timings` 字段类型(后端 `SelfUpdateTimingBreakdown` 数据全在,前端类型漏了导致 UI 渲染丢失,用户反馈"返回日志不正确 + 可观测性不强"的根因) |
| perf | cds | cds/web `build` script 删掉冗余 `tsc --noEmit &&`,validate 阶段已跑过 tsc,build 时再跑是浪费 10-20s |
| refactor | cds | cds/web 把 `@vitejs/plugin-react`(Babel) 换成 `@vitejs/plugin-react-swc`(Rust),build 时间持平但 dev HMR ~5x 提速 |
| fix | prd-admin | MarkdownViewer 给正文容器加 userSelect:'text'，防止任何祖先 user-select:none 让划词选区瞬间清空（分享视图划词评论修复） |
| feat | prd-admin | DocBrowser 进入条目时预拉评论计数，正文上方常驻「N 条评论」chip 入口，让分享视图也能直接看到「这里有 N 条别人留的评论」 |
| feat | prd-admin | 新增 components/ui/ImageLightbox.tsx 通用图片灯箱：createPortal + z-[10000] + 左右切换 + Esc/蒙版关 + 下载 + 计数指示 |
| feat | prd-admin | MarkdownViewer 集成 ImageLightbox：md 中的图片点击放大，整篇所有图片可 ← → 切换浏览（cursor:zoom-in 提示） |
| fix | prd-api | DocumentStoreController.CreateInlineComment 放宽权限：私有库但有活跃分享链时，登录用户也可评论（验收报告分享场景） |
| fix | prd-api | DocumentStoreController.ListInlineComments 三档权限：owner 总能读写；公开/有分享链 → 登录可读写、匿名可读；私有无分享 → 仅 owner |
| fix | prd-api | 修复项目路由智能体「服务器内部错误」：给 ProjectRouteExtractedRepo / ProjectRouteResolution / ProjectRouteRoutemapFile 三个嵌套 model 加 [BsonIgnoreExtraElements]，兼容 V1 时按 module 分组的老格式 plan 文档，避免 BsonSerializationException 被 ExceptionMiddleware 吞成 500 |
| fix | prd-api | MarkdownSectionExtractor 增加「文档头模式」：识别 `# 一、文档头` 节点下 `- 应用/业务模块：智能营销/营销后台` 这种合并 label 的行级 KV 写法，兼容半/全角斜杠、加粗、顿号回退、独立行 KV |
| test | prd-api | 新增 MarkdownSectionExtractorTests（7 个用例）覆盖用户真实方案截图场景 |
| feat | prd-api | CreatePlan 同用户下方案标题不允许重复（trim 后比较），返回 409 + PLAN_TITLE_DUPLICATE 错误码 |
| feat | prd-admin | 进入项目路由智能体页面默认自动选中最新方案展示到右侧，避免空白 |
| feat | prd-admin | 最近方案删除按钮改为常驻显示（不再 hover 才出），明示任何状态都可删 |
| refactor | prd-admin | 删除方案二次确认文案精简为「删除方案「{title}」？」单行 |
| feat | prd-admin | SharesPanel scoped 模式新增「本站点统计」按钮：与「新建分享」并排，触发 ShareAnalyticsDrawer scoped 到当前站点的过滤视图 |
| feat | prd-api | GET /api/web-pages/shares/analytics 新增 ?siteId 参数：把统计范围收窄到单个站点 |
| fix | prd-admin | DocBrowser 右键菜单加 createPortal + z-[10000]，修复被祖先 overflow:hidden 裁剪 / 被低层弹窗盖住的展开问题 |
| feat | prd-admin | DocBrowser 右键菜单加「在新窗口打开」+「复制条目链接」两个只读项，避免 share 视图等 readonly 上下文菜单空壳 |
| feat | skill | create-visual-test-to-kb v2.1 强制新增「需求一一对应表」段：archive_report.py 校验 + standard-v2 §6.4 + zz-report 模板提供示例。杜绝"用户提了 10 条只对应 6 条"的茫然 |
| feat | prd-admin | 团队邀请改为直接多选添加（UserSearchSelect 风格），移除邀请链接 |
| feat | prd-admin | 团队成员新增「退出团队」按钮（非 owner 成员可自行退出） |
| feat | prd-admin | TeamScopeBar 邀请弹窗改为直接搜索+添加用户 |
| feat | prd-api | 解散团队时 owner 的托管站点自动移入「{团队名} 团队解散文件夹」 |
| fix | prd-admin | TeamSpaceHeader 移除「邀请协作（复制链接）」按钮，改为「邀请成员」直达管理面板「添加成员」tab |
| feat | prd-admin | TeamManagerPanel 支持 initialTab/initialTeamId props，外部入口可指定初始展示 |
| refactor | prd-admin | 知识库分享阅读页（/s/lib/:token）改为复用 DocBrowser，删除 1225 行重复实现的 LibraryShareReader |
| feat | prd-admin | DocBrowser 新增 sortMode prop（default/created-desc/updated-desc），分享页默认按创建时间倒序 |
| feat | prd-admin | LibraryShareViewPage 支持 URL ?entry={id} 指定默认选中，无指定时默认选最新创建条目 |
| feat | skill | 验收归档脚本生成的分享链带 ?entry={eid}，分享对象一打开就看到新报告 |
| refactor | prd-admin | 更新中心-周报 WeeklyReportsTab 改为复用 DocBrowser（appearance="cards" 保留双卡片布局），删除 ~200 行自实现的 list+content 渲染 |
| feat | prd-admin | DocBrowser 新增 appearance (inset/cards)、isEntryFresh、sidebarHeader 三个可选 prop，支持周报场景的双圆角卡片布局和自定义 NEW 徽章规则 |
| docs | doc | 新增 debt.library-doc-reader（殿堂阅读器留债）+ debt.report-detail（周报详情页留债）+ 追加 debt.team-feature wave 2.5 章节 |
| docs | prd-admin | CLAUDE.md「已注册共享组件」表新增 DocBrowser 一行（含 3 个调用方 + 4 个关键 props 说明） |
| docs | doc | 同步 index.yml + guide.list.directory.md 收录两个新 debt 文件 |
| fix | prd-admin | TeamManagerPanel activity fetch + TeamScopeBar openPanel/invite search 加 fetchSeq stale guard（bugbot #1/#4） |
| fix | prd-api | DocumentStore DELETE 改为 owner-only，避免共享团队成员级联删除 owner 整个 store（codex P1 #2） |
| fix | prd-api | WebPageAnalyticsController 路由前缀改为 api/web-page-analytics，避开 AdminPermissionMiddleware 对 web-pages.write 的拦截，恢复访客浏览埋点（codex P2 #6） |
| feat | prd-admin | 网页托管分享面板重构：点击「分享」按钮改为弹出列表 + 续期 + 取消 + 新建一体化面板（参考知识库分享模式），不再直接生成单个链接 |
| feat | prd-admin | 分享创建表单新增「谁能访问」选项：仅我自己/团队成员（默认）/ 任何登录用户 / 任何人；防止链接被复制后被外部长期访问 |
| feat | prd-admin | 分享列表新增过期 7 天宽限期：已过期但 ≤ 7 天的链接保留显示并可一键续期 30 天，避免链接突然失效 |
| feat | prd-admin | 网页托管页右上角新增「分享统计」按钮 → 弹出 Drawer，展示活跃链接/PV/独立 IP/Top 链接/时间线（参考 Cloudflare 简化版） |
| feat | prd-admin | 分享列表展示新增 visibility chip、独立 IP 数、续期次数 |
| feat | prd-api | WebPageShareLink 新增 Visibility / RenewalHistory / UniqueIpCount 字段；分享访问加 visibility 校验（owner-only / logged-in / public） |
| feat | prd-api | 新增 POST /api/web-pages/shares/{shareId}/renew 续期端点（仅创建者，过期 ≤ 7d 宽限期内仍可续期） |
| feat | prd-api | 新增 GET /api/web-pages/shares/analytics 用户分享统计聚合端点（活跃链接、时间窗 PV、独立 IP、Top 链接、时间线） |
| feat | prd-api | 新增 GET /api/web-pages/{siteId}/share-logs 站点级分享访问日志端点 |
| feat | prd-api | 新增 GET /api/admin-web-pages/share-diagnostics/{token} 管理诊断端点：返回链接完整状态 + 续期审计 + 最近访问 + 一句话诊断 |
| feat | prd-api | CreateShare 加 forceNew 参数：分享面板每次显式创建新链接，避免旧链接被静默覆盖（"莫名其妙过期"的根因之一） |
| fix | prd-api | ListShares 过滤改为「未过期 OR 过期 ≤ 7 天」：超过 7 天的过期链接不返回列表但保留 DB 行用于审计 |
| fix | prd-api | HostedSiteBackfillService 新增一次性 BackfillShareVisibility：把发布前已存在的非 visit 分享 Visibility 迁移为 public，保护旧链接不被新默认 owner-only 误断 |
| fix | prd-admin | ShareViewPage 处理 403/visibility_denied：未登录提示登录入口；已登录非 owner 显示"仅创建者可访问" |

### 2026-05-27

| 类型 | 模块 | 描述 |
|------|------|------|
| perf | prd-api | 更新中心读取改为 serve-stale-while-revalidate：缓存陈旧时先返回旧值再后台静默刷新、按 key 去重防惊群、保留期 24h，生产冷启动不再卡 GitHub 拉取 |
| perf | prd-api | 更新中心新增启动预热（ChangelogCacheWarmer），首个用户请求前先把历史发布/待发布拉好放进缓存 |
| feat | prd-api | 更新中心 GET 端点下发 Cache-Control: private, no-cache（freshness-first）：浏览器每次向后端校验，杜绝「迟迟不更新」；秒开由前端 sessionStorage 首屏 + 后端内存缓存 ms 级响应兜底 |
| perf | prd-admin | 更新中心历史发布改用 stale-while-revalidate：releases/currentWeek 持久化到 sessionStorage，进页面先渲染缓存再后台静默刷新，消除每次打开都显示「正在加载历史发布」的转圈 |
| feat | prd-admin | 知识库分享落地页(/s/lib/:token)改用深色极简阅读器 LibraryShareReader(窄/宽栏 + 卡片式 + 全屏 + 目录 TOC + 树内搜索 + KaTeX 数学 + 代码高亮),数据层沿用 main 的 token 门禁匿名端点,支持整库/单篇两种分享范围 |
| fix | prd-api | 修复知识库「文档再加工」进度卡死:Worker 启动兜底回收上一个容器残留的 Running 任务并标记失败,避免重新部署/崩溃后前端进度条永远卡在「调用 LLM N%」(server-authority #5) |
| fix | prd-api | 修复「文档再加工」LLM 调用未设 LlmRequestContext 导致用量/配额挂不到用户:在 ContentReprocessProcessor 调用前用 run.UserId 开 BeginScope(llm-gateway.md) |
| feat | prd-admin | 毒舌秘书卡片插画重设计：从 MBB 金字塔+四象限改为 AI 秘书主题（双页笔记本+清单+琥珀印章「秘」+羽毛笔+AI 火花+咖啡杯），羊皮卷米色 #FAF1D6→#E4CD96 |
| feat | prd-admin | 毒舌秘书图标统一换 NotebookPen：toolboxStore / navRegistry / PaAgentPage 侧栏 hero 三处同步；ToolCard / AgentLauncherPage / ToolDetail 三处 ICON_MAP 注册 |
| feat | prd-admin | 毒舌秘书空状态文案改为「把模糊想法转成 MECE 执行清单的 MBB 级私人助理。毒舌幽默、不堆鸡汤、能落盘。」hero icon 改琥珀渐变 |
| feat | prd-admin | 毒舌秘书空状态新增「进一步了解我」ghost 二级 CTA，跳转 map.ebcone.net 新窗口 |
| feat | prd-admin | 新建 ChatMarkdown 组件，自定义 12 种 markdown 元素（H1-H4/段落/列表 marker/加粗琥珀色/引用左竖条/链接/行内/代码块/表格/分隔线），PaAssistantChat + PaReviewDrawer 共用 |
| feat | prd-admin | 毒舌秘书新增羊皮卷主题切换（BookOpen ↔ Moon），数据通过 data-pa-theme 属性挂在最外层 div，scoped CSS 变量覆盖一组 pa-* 不污染全局，sessionStorage 持久化 |
| feat | prd-admin | 毒舌秘书顶部 bar 加阅读偏好 A-/A/A+ 字号三档切换，--pa-fs-scale 变量级联到 6 档字号 token，sessionStorage 持久化 |
| feat | prd-admin | paAgent.css 扩展 ~300 行：主题 / 字号 / Markdown / 工具按钮 / ghost CTA 五大子系统作用域全部锁在 .pa-agent-root 内 |
| fix | prd-admin | 按验收反馈重绘毒舌秘书卡片为深蓝秘书风：拟人头像+耳麦+便签清单+光带，hover 时背景元素联动位移，首页与百宝箱统一 |
| fix | prd-admin | 卡片文案收敛：毒舌秘书卡片描述仅保留「把模糊想法转成 MECE 执行清单的 MBB 级私人助理」，百宝箱底部仅显示「私人助理」标识 |
| fix | prd-admin | 修复毒舌秘书字号切换体感弱问题：small/large 档位改为 0.8/1.28，并把空状态标题与文案字号绑定 --pa-fs-scale |
| fix | prd-admin | 优化羊皮卷主题可读性：将 pa-theme 变量映射回 --bg/--text 体系，统一全局容器配色，避免背景与文字冲突 |
| fix | prd-admin | 对话首页空状态图标改为拟人化秘书头像（发型+耳麦）并与深蓝主题统一 |
| fix | prd-admin | 对话等待首 token 时由三点跳动改为橙色动态「让我想想...」（琥珀渐变扫光 + 省略号起伏） |
| fix | prd-api | 毒舌秘书任务识别改为遍历全部 JSON 代码块并优先处理 save_task，避免与 update_profile 共存时漏入任务看板；同时强化 suggest/auto 判定提示词 |
| feat | prd-admin | 毒舌秘书视觉 v2：卡片 PaAgentCardArt 科幻深蓝+女秘书 bust；统一 PaSecretaryIcon 替换 NotebookPen（百宝箱/首页/侧栏/Cmd+K） |
| feat | prd-admin | 羊皮卷主题改为米白浅色系+淡淡书卷纹理，强调色改鼠尾草绿，与科幻秘书品牌区隔 |
| fix | prd-admin | 侧栏历史会话加线框卡片（pa-session-item）区隔每条对话 |
| fix | prd-admin | 修复 A-/A/A+ 字号：pa-fs-sm/xs 覆盖对话区 Tailwind 固定字号，档位拉大到 0.82/1.38 |
| fix | prd-admin | 修复羊皮卷下「让我想想」渐变字被褐色色块遮挡（保留 background-clip:text） |
| feat | prd-admin | 空状态换 PaSecretaryHeroArt 全息人像；卡片秘书 bust 重绘为 AI 科技风 |
| feat | prd-admin | 主背景切换为 Gemini 风格浅灰+淡蓝渐变，列表卡片改鼠标跟随 hover 光斑 |
| fix | prd-admin | “我的画像”按钮移到右上角 toolbar；删除左下角两个入口按钮 |
| feat | prd-admin | 背景三态循环：默认 Gemini 浅色 → 山蓝深色 → 羊皮卷；旧 dark 偏好自动映射 mountain |
| fix | prd-admin | 侧栏会话项统一 40px 高度，仅标题+时间，细线分隔；主内容区四角 18px 圆角 |
| feat | prd-admin | PaSecretaryIcon / PaAgentCardArt 改为 Gemini 风四色星芒与浅色卡片插画 |
| fix | prd-admin | 毒舌秘书首页卡片改回深蓝科技风；hover 时星芒增加旋转脉冲与轨迹流动动态效果 |
| fix | prd-admin | 页面四角改为外层容器圆角（左侧栏+右主区拼接）；对话主区左侧恢复直角，避免对话框额外倒圆角 |
| fix | prd-admin | 侧栏会话分隔线改 0.5px 浅色；选中态改 Gemini 圆角灰底；空状态图标换浅色底四色星芒 |
| fix | prd-admin | 去掉毒舌秘书最外层 shell 矩形背景，仅保留侧栏+主区圆角层铺主题底；羊皮卷纹理下移 |
| fix | prd-admin | 空状态 hero 图标重制为深蓝科技风（与首页卡片同款），含 idle/hover 星芒动效 |
| feat | prd-admin | 毒舌秘书圆角内容层背景加呼吸动效：双层径向光晕错相位 11s/13s 缓慢呼吸，三主题适配，尊重 prefers-reduced-motion |
| feat | prd-admin | 空状态标题「毒舌秘书」加流星扫光动效（background-clip:text 渐变高光带 5.4s 循环），三主题各自高光色 |
| fix | prd-admin | 强化圆角层背景呼吸效果：光晕饱和度+亮度提升，scale 拉到 1.18、opacity 0.55↔1，周期缩到 8s/9.5s，并加 blur 微焦交替，呼吸感更明显 |
| fix | prd-admin | 修复 pa-agent main 区子元素被强制 position:relative+z-index 导致 topbar 错位的回归；呼吸动效改为 background-position 长距离游走 + saturate/brightness 脉动，肉眼可见，仅作用 main 区不影响侧栏 |
| feat | prd-api | MarkdownSectionExtractor 加 maxScanChars 参数（默认 6000，约 100-150 行），限定只扫方案 md「文档头」抽应用/业务模块章节原话，避免抓到正文中后段的同名章节 |
| feat | prd-admin | 「我的最近方案」每条卡片加垃圾桶删除按钮；点击后 window.confirm 二次确认（带方案标题 + 提交时间），确认后调 DELETE /api/project-route-agent/plans/{id}；删除当前选中方案会同步清空右侧分析视图 |
| feat | prd-api | 项目路由智能体新增独立的 GitHub Device Flow OAuth 端点：POST /api/project-route-agent/github/device/start · poll · DELETE /github/connection。复用 IGitHubOAuthService 但不再让用户跳 /pr-review |
| feat | prd-admin | 新增 GitHubAuthModal 内联授权弹窗（Device Flow）：显示验证码 + 复制 + 「打开 GitHub 输入」按钮 + 自动轮询完成检测，全程在项目路由智能体页面内 |
| feat | prd-admin | GitHubStatusCard：「去授权」改为打开内联 Modal（不跳出）；已授权时「管理」改为「断开授权」内联 confirm |
| refactor | prd-admin | clone 失败仓库的「授权 GitHub 后重试」按钮也改用 Modal，不再跳 /pr-review |
| fix | prd-api | 安全：GitRepoCacheService 缓存复用前用当前用户凭据 ls-remote 校验访问权，防跨用户缓存绕权（P1 / Codex review） |
| fix | prd-api | 安全：GitRepoCacheService fetch 路径用 try/finally 把 origin set-url 还原成不带 token 的 URL，防 OAuth token 落盘 `.git/config`（P1 / Codex review） |
| fix | prd-api | 安全：CreatePlan 在 Attachment 查询里增加 UploaderId 过滤，防 attachmentId 泄漏后被其他用户拷贝出 ExtractedText（P2 / Codex review） |
| feat | prd-api | 产品评审 Agent 加入三层兜底（evidence gate / 数据密度封顶 / summary 一致性闸），杜绝 LLM 把非清单维度全填满凑 99 分的钻空子路径 |
| refactor | prd-api | 评审默认权重调整：清单维度 30→20，10 分按 +2 平均分摊到 consistency/problem_quality/user_value/feasibility/testability 五个高风险维度 |
| fix | prd-api | 评审 prompt：清单维度 Description 把 "得分 = 30 × ..." 改为 "MaxScore × ..."，与新 MaxScore=20 对齐，不再误导 LLM |
| fix | prd-api | evidence 正则收紧 \d → \d{2,}，章节匹配允许中间空格，长度门槛 30→15 + 强标记，既挡单数字钻空子又不误伤简洁高密度评语 |
| fix | prd-api | CountDataPoints 用 \d{2,}(?![%％]) 避免 "80%" 被同时计入两条正则，L2 阈值不再被高估撑过 |
| fix | prd-api | L3 关键词清单移除歧义词「标杆级水平」，避免误伤褒义 summary「达到行业标杆级水平」；新增「未达标杆/未到标杆」等明确负面词 |
| fix | prd-api | ApplyScoringGuardrails 防御 DB 自定义维度配置出现重复 Key，改用 GroupBy 避免抛 ArgumentException |
| feat | prd-api | ReviewDimensionScore 增加 OriginalScore 字段，记录被 guardrail 调整前的 LLM 原始分，便于审计 |
| feat | prd-admin | 评审结果页新增「系统兜底调整记录」展示区，触发 guardrail 时显示原分→新分及调整原因 |
| test | prd-api | ReviewAgentScoringGuardrailsTests 新增 8 条测试覆盖单数字钻空子防御、简洁高密度评语、百分比不重复计数、褒义标杆级表述、重复 Key 容错、OriginalScore 记录、L2→L3 跌破门槛等场景 |
| feat | prd-api | 产品评审 Agent 新增「未通过救机会」端点 POST /submissions/{id}/reupload-on-failure，每方案仅 1 次替换附件重评 |
| feat | prd-api | 新增 GET /submissions/{id}/results 返回该 submission 完整评审历史 |
| fix | prd-api | rerun/reupload 路径不再删除旧 ReviewResult，保留为评审历史 |
| fix | prd-api | LLM 网关 Error 后的"重新评审"重跑改用新字段 ErrorRetryCount，不污染 RerunCount，避免系统故障被错算成用户重评 |
| refactor | prd-api | 排行榜重写：先按 (submitterId, title) 聚到「方案桶」再统计；新公式「一次性通过率」= 一次过方案数 / 总方案数（非"通过的方案中无重评的占比"，修复永远 100% 的旧 bug） |
| feat | prd-admin | 评审结果页未通过状态新增「重新上传方案（剩 1 次救机会）」按钮 |
| feat | prd-admin | 评审结果页新增「评审历史」折叠区，列出该 submission 的所有评审记录（得分/通过状态/时间/兜底次数） |
| docs | prd-admin | 排行榜文案说明改为"按方案标题去重 + 系统故障重跑不计入用户重评" |
| test | prd-api | 新增 ReviewAgentLeaderboardTests 10 条单测覆盖一次过判定/桶级通过判定/同标题去重/跨用户隔离/F-2 ErrorRetryCount 不污染 RerunCount/张三全月示例端到端 |
| fix | prd-admin | 分享阅读页(LibraryShareViewPage)顶部品牌从「智识殿堂」改为「知识库 · 分享」并加「私有分享 · 仅持链接者可看」徽标，避免点对点分享被误认为公开殿堂 |
| feat | prd-admin | 新增 /join/:code 邀请链接落地页：打开链接、登录后自动加入对应空间并跳网页托管，无需填表 |
| feat | prd-admin | 网页托管改 SaaS 空间模型：顶部空间切换器（个人空间 / 团队空间，可新建/邀请码加入）；团队空间复用现有 Team（成员/角色/邀请，协作管理在空间层）；空间内文件夹由内容派生（纯组织、不单独分享）；网页可「移动到空间/文件夹」（移进团队空间=setSharedTeamIds，一个网页只属一个空间）。彻底分开「空间=协作边界」与「文件夹=空间内组织」，消除团队/文件夹概念冲突。删除来源筛选/分组切换/刷新等低频控件 |
| chore | prd-admin | 知识库暂仍用旧「我的/共享文件夹」切换条（共用组件未改）；后续可统一到空间模型 |
| fix | prd-admin | 修复串数据：在团队空间内新建上传的站点会落到个人空间——改为新建后按当前空间归属（setSharedTeamIds=[teamId]）；viewer 在团队空间隐藏「上传站点」入口 |
| fix | prd-admin | 文案统一：TeamManagerPanel「共享文件夹」残留改「团队空间」（与空间模型一致） |
| refactor | prd-admin | 布局：拆分 SpaceBar（空间切换器）与 TeamSpaceHeader（协作头部），头部移到搜索行下方，切换空间时搜索框位置稳定 |

### 2026-05-26

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 毒舌秘书 v2：新增 `pa_user_profile` 集合（跨会话画像）+ Prompt 顶部注入 `__PA_PROFILE_BLOCK__` |
| feat | prd-api | 毒舌秘书 v2：chat 流增加 `update_profile` JSON 块异步抽取（auto 直入注入，suggest 待用户确认） |
| feat | prd-api | 毒舌秘书 v2：新增 `POST /api/pa-agent/review/run` 复盘 SSE 流（pa-agent.review::chat），完成后落 PaSession.Type='review' |
| feat | prd-api | 新增 4 个 profile endpoint：GET/PUT/POST/DELETE 画像与 memories |
| feat | prd-api | AppCallerRegistry.PaAgent 新增 `pa-agent.review::chat`（毒舌秘书-复盘） |
| feat | prd-admin | 新增 PaAgentCardArt 内联 SVG 插画（MBB 金字塔 + 四象限 + 琥珀/青色），无 CDN 也能展示 |
| feat | prd-admin | 首页 FeaturedCard 与百宝箱 ToolCard 接入 pa-agent 插画兜底 + 资源上传覆盖（与视觉创作智能体同级） |
| feat | prd-admin | 百宝箱 ToolCard 接入 `useAgentImageUrl`/`useAgentVideoUrl`，与首页一致支持运维上传覆盖 |
| feat | prd-admin | toolboxStore 给 builtin-pa-agent 补 `kind:'agent'` + `permission:'pa-agent.use'`（移动端首页也能显示） |
| feat | prd-admin | homepageAssetSlots 加 pa-agent 槽位，运维可在「资源管理」上传 `agent.pa-agent.image/video` |
| feat | prd-admin | 新增 PaProfilePanel 我的画像面板（编辑节奏/偏好/memories，三档来源徽章） |
| feat | prd-admin | 新增 PaReviewDrawer 复盘抽屉（SSE 阶段提示 + StreamingText 流式渲染） |
| feat | prd-admin | PaAgentPage 侧栏底部新增"我的画像"入口；PaTaskBoard 顶部新增【复盘】按钮 |
| feat | prd-admin | PaAssistantChat 解析 SSE `profile` 事件，显示"秘书记住了 / 建议记下"轻量徽章 |
| docs | doc | 新增 doc/spec.pa-agent-savage-iter-v2.md（v2 落地版） |
| docs | doc | doc/guide.mongodb-indexes.md 登记 `pa_user_profile` 新索引 |
| feat | prd-admin | 毒舌秘书 UE 升级 Track B：PaAssistantChat / PaReviewDrawer 接入 StreamingText（Blur focus），消除 ReactMarkdown 全量重渲染抖动 |
| feat | prd-admin | 毒舌秘书 UE 升级 Track G：侧栏会话按 「我的复盘 / 今天 / 昨天 / 本周 / 更早」 分组，参考 Notion / Linear；新增 SessionSkeleton 骨架屏替代加载文字 |
| feat | prd-admin | 毒舌秘书 UE 升级 Track E：任务卡新增左侧象限色条 + 截止日期 chip（逾期/紧急/常规三色）+ 子步骤进度 chip + title/lead/caption 三档信息层级 |
| feat | prd-admin | 毒舌秘书 UE 升级 Track E：聊天空状态 hero icon 升级到 80×80 三色渐变 + 22px display 标题 + 双层描述 + 键盘提示行 |
| feat | prd-admin | 毒舌秘书 UE 升级 Track F：新建 paAgent.css，三档 easing token + 7 个 keyframe 动效（bubble-in / empty-in / hero-breath / checkbox-pop / shimmer 等），零 framer-motion 依赖 |
| feat | prd-admin | 毒舌秘书 UE 升级 Track F：所有 hover 加 spring + glow（pa-quick-cmd / pa-task-card / pa-primary-button），子任务勾选触发 spring pop tactile |
| feat | prd-admin | PaSessionInfo 类型新增 type?: 'chat' \| 'review' 字段（v2 后端 PaSession.Type 已经返回） |
| feat | prd-admin | 项目路由智能体「公共站点说明」Tab：管理员现在可直接上传 .md 文件填充 markdown 字段（含按钮 + textarea 拖拽，1 MB 上限） |
| fix | prd-api | GitRepoCacheService：clone 失败检测到「Remote branch not found」时自动 fallback 到仓库默认分支（master / develop / dev 等），不再因为硬卡死 main 导致老仓库无法分析 |
| feat | prd-api | project-route-agent：LLM Extract 阶段只读方案 markdown 头部 2000 字（包含「涉及应用 / 业务模块」元信息），不再读全文 |
| feat | prd-api | LLM Extract 提示词重写为两步显式：① apps/modules → ② 按 modules 查公共说明里的仓库；强制只接受 https URL（容器内无 SSH key） |
| refactor | prd-api | ProjectRouteResolution 数据模型重构为「按仓库分组」：RepoUrl + ProjectPaths[] + MatchedAppsOrModules[]；新增 CloneFailed / NoRoutemap 两个状态 |
| feat | prd-api | Resolve 阶段：baseline 先按所有仓库占位（含 clone 失败/无 routemap），LLM 只填克隆成功的子集；clone 失败状态保留不被 LLM 覆盖 |
| fix | prd-api | GitRepoCacheService：clone 加 1 次重试、URL 自动补 .git 后缀、fetch+reset 兜底优先于 reclone、错误信息完整 trail 透传 |
| refactor | prd-admin | ProjectRouteResolution 类型同步重构；第三栏 UI 改为「仓库 × 项目路径」分组展示，匹配的 modules 以 pill 形式直接挂仓库下 |
| feat | prd-admin | ResolutionBadge 新增 CloneFailed / NoRoutemap 状态色 |
| feat | prd-api | project-route-agent 复用 pr-review 的 GitHub OAuth 授权：clone 时把用户 access token 注入 https URL (x-access-token)，私有 / 组织仓库 routemap 现在也能拉 |
| feat | prd-api | GitRepoCacheService.EnsureClonedAsync 新增可选 accessToken 参数 + 自动 mask 错误日志里的 token + clone 成功后把 origin URL 改回不带 token 的形式 |
| feat | prd-api | 新端点 GET /api/project-route-agent/github/status：前端检查授权状态用 |
| feat | prd-admin | 分析视图新增 GitHubStatusCard：未授权时显示「去授权」按钮跳 /pr-review；已授权时显示账号名 + 「管理」链接 |
| feat | prd-admin | 仓库 × 项目路径栏：CloneFailed 状态 + 未授权时挂「去授权 GitHub 后重试」按钮 |
| fix | prd-api | GitRepoCacheService.ReadRoutemap 增加子目录递归搜索（BFS 深度 6，跳过 .git/node_modules/bin/obj/dist 等噪声目录），monorepo 中藏在 apps/x/routemap、services/y/routemap 的 routemap 现在也能被发现 |
| feat | prd-api | RoutemapSnapshot 新增 FoundLocations 字段：找到的所有 routemap 目录列表（相对仓库根）；文件 Path 也改为相对仓库根的完整路径，跨多个 routemap 时能区分来源 |
| feat | prd-api | SSE repo 事件 + Resolve LLM Prompt 都带上 FoundRoutemapDirs，让 AI / 用户能看到 routemap 实际所在子路径 |
| feat | prd-admin | 仓库栏新增「找到的 routemap 子目录」绿色 pill 列表展示 |
| feat | prd-api | 新增 MarkdownSectionExtractor：确定性解析方案 md 里「应用」/「业务模块」章节原话（命中关键词：涉及应用/相关应用/应用范围/应用 + 业务模块/涉及模块/相关模块/功能模块/模块），不让 AI 拆解原文 |
| feat | prd-api | 新增 ThirdPartyRepoExtractor：从命中的 routemap *.md 文件内容里用正则扫出所有第三方 git URL（https / git@ / ssh:// 三种），去重后写入 Resolution.LinkedThirdPartyRepos |
| feat | prd-api | ProjectRouteExtractedRepo 新增 SourceContext 字段：公共说明里命中此仓库的完整原文段落（不截断） |
| feat | prd-api | ProjectRouteResolution 新增 LinkedThirdPartyRepos + RoutemapFiles（含完整文件内容）字段，前端「查看明细」用 |
| refactor | prd-api | Controller.ExtractAppsAndReposAsync 流程改造：确定性章节命中时直接用原话覆盖 LLM 输出，LLM 仅负责仓库匹配 + sourceContext；找不到章节才回退 LLM 兜底 |
| feat | prd-admin | 第二栏「② 当前方案关联仓库地址」（改名）+ RepoCard 可折叠展开查看详情：完整 reasoning / sourceContext / routemap 子目录全部列表（不省略） |
| feat | prd-admin | 第三栏「③ 仓库 × 关联项目路径」（改名）+ ResolutionCard 可折叠展开查看 routemap *.md 文件全文 + 第三方仓库 URL 列表（可点击跳转） |
| feat | prd-admin | 最近方案：显示模块/仓库/路径统计；当前选中卡显示「重新分析」按钮；分析视图顶部显示「正在查看历史记录」banner（含提交时间 + 完成时间） |
| refactor | prd-api | project-route-agent V2：移除 ProjectRouteSiteSpec.Repos 仓库登记表字段；分析阶段 AI 直接从公共说明 markdown 抽 git URL |
| feat | prd-api | ProjectRoutePlan 加 ExtractedRepos[]：本次分析 AI 选中要克隆的仓库列表（每条带 reasoning） |
| feat | prd-api | LLM Extract 阶段合并为一次调用：apps + modules + repos 同步输出 |
| refactor | prd-admin | 管理员视图删整个「仓库登记表」section，仅保留标题 + markdown 上传/编辑 |
| feat | prd-admin | 管理员视图新增「仓库登记方式」说明 + markdown 内嵌仓库 URL 示范代码块 |
| feat | prd-admin | 分析视图第二栏改为展示 AI 选中的仓库（含 AI 的 reasoning）+ 实时克隆状态合并显示 |
| fix | prd-admin | 网页托管快速分享的短链无密码风险确认弹窗改为不透明红色醒目样式（原透明 bg-card 改用 bg-elevated 实底 + 红色边框/标题/告警图标 + 加深遮罩） |
| feat | prd-admin | 新功能小技巧公告：周报编辑器升级、知识库阅读体验升级两条 feature-release tip 默认推送给所有用户 |
| feat | prd-api | 小技巧过时机制：feature-release/bug-fix 类 tip 默认 7 天后过期；defect-fix 修复提醒 14 天改 7 天 |
| feat | prd-api | 首页提醒过时机制：AdminNotification 默认 7 天后过期，过时提醒不再堆在首页（显式指定过期时间的不受影响） |
| fix | prd-api | 修复 DailyTip seed/reset 克隆时丢失 StartAt/EndAt，导致内置 tip 无法携带过期窗口 |
| feat | prd-api | 网页托管团队共享细分 owner/editor/viewer 三角色：viewer 只读、editor 可编辑/重传/建分享、删除收敛到文件夹 owner 或站点创建者（细化决策10「成员全员平等」，知识库不受影响） |
| feat | prd-api | 新增 WebHostingPermission 纯策略类（角色继承解析 + 跨团队取最宽松 + 能力矩阵）+ TeamMember.WebHostingRole 字段 + TeamService.GetMyWebHostingTeamRolesAsync |
| test | prd-api | 新增 WebHostingPermissionTests，纯单测覆盖角色继承/取最宽松/站点角色解析(隔离)/能力矩阵 |
| feat | prd-api | 团队成员网页托管角色管理端点 PUT /api/teams/{id}/members/{userId}/web-hosting-role（仅团队管理员，团队创建者恒 owner）；GET /api/teams/{id} 返回 webHostingRoles 映射 + myWebHostingRole；web-pages 团队列表返回 myWebHostingRole |
| feat | prd-admin | 团队管理面板新增成员「网页托管角色」选择器（owner/editor/viewer）；网页托管团队视图按角色隐藏 viewer 的编辑/删除/分享/设公开入口 + 批量操作门控 + 顶部「我的权限」角标 |
| feat | prd-api | 网页托管新增访客痕迹审计：SiteViewEvent 记录登录访客ID快照 + WebPageAnalyticsController（record-view + owner查访客名单，owner或团队成员可见） |
| feat | prd-api | 新增高级权限 web-pages.viewAll + AdminWebPagesController：跨用户查看全部托管网页、阅读量与访客记录 |
| feat | prd-api | 网页文件夹绑生成器 WebFolder + WebFolderController/Service：给文件夹绑定 Markdown 模板一键生成网页/知识库条目（skill 生成因依赖 LLM 调用链暂缓，先支持 Markdown 即时生成） |
| feat | prd-admin | 网页托管接入：卡片「访客」抽屉、工具栏「文件夹」管理器、访问即记录访客；新增「全部网页（高级）」审计页 /admin-web-pages |
| feat | prd-admin | 网页托管新增 data-tour-id 锚点（文件夹按钮/阅读量/卡片）+ 入库 onboarding 小技巧，进页面即可弹出教学 Tour |
| refactor | prd-api,prd-admin | 「分类」概念并入既有「文件夹」（Folder）：WebCategory→WebFolder、/api/web-categories→/api/web-folders、CategoryManager→FolderManager，消除分类与文件夹双概念冗余 |

### 2026-05-25

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | 修复 AI 百宝箱知识库上传无效：handleKnowledgeFileSelect 在 e.target.value='' 之后才 Array.from(files)，而 value 清空会就地清空 live FileList，导致上传循环拿到空数组、文件不入列表也不上传。改为清空前先快照成数组（QuickCreateWizard + ToolEditor 两处） |
| fix | prd-api | 修复知识库分享链接打不开：分享 URL 统一为 /s/lib/{token}，新增 token 门禁的匿名端点（列条目 + 取正文）支持分享私有库，AccessShareLink 返回 entryId 支持单篇文档分享 |
| fix | prd-admin | 知识库分享链接从失效的 /library/share/{token} 改为统一的 /s/lib/{token}，新增全屏公开展示页 LibraryShareViewPage（复用 LibraryDocReader），接入 ShortLinkRouter |
| feat | prd-admin | 知识库支持单篇文档分享：文件树右键新增「分享」入口，分享弹窗区分整库/单篇 |
| feat | prd-admin | 知识库空状态同时提供「新建文档」+「上传文档」双入口；新建文档后默认进入编辑态，无需再点一次编辑 |
| fix | prd-api | MySharesController 知识库分享 PrimaryPath 修正为 /s/lib/{token} 并标记 Viewable，「我的分享」聚合页链接可正常打开 |
| fix | prd-admin | 修复 Bugbot/codex 评审发现的再加工相关问题：① 复用逻辑仅匹配进行中(streaming)任务，done/失败不再卡住重开；② 新建文档自动编辑前校验 preview 已是该文档内容，避免把旧正文存进新文档；③「开始加工」请求在途禁用按钮，防双击建重复任务；④ SSE error 不再被 onEvent.error 二次覆盖文案；⑤ 已完成的再加工 run 保留 streamedText，刷新后正文不丢；⑥ 知识库页只订阅无 streamedText 的签名，SSE 文本 chunk 不再触发整棵文件树重渲染 |
| feat | prd-admin | 知识库分享可见性:已分享出去的内容统一标黄——知识库卡片、文件树单篇文档都显示黄色「已分享」标识(点击查看/复制链接);分享弹窗里有效分享标黄、撤销置灰,完整链接平铺成可选中输入框 + 醒目「复制」,撤销降为次要操作 |
| feat | prd-api | 知识库 store 列表返回 hasActiveShare、entries 列表返回 sharedEntryIds(均按未撤销+未过期判定),供前端标黄 |
| feat | prd-api | 新增团队（Team）跨应用协作子系统：Team/TeamMember/TeamActivityLog 模型 + TeamController（创建/邀请码+直接添加/管理员/活动日志）+ TeamService/TeamActivityService |
| feat | prd-api | 网页托管与知识库支持团队作用域：SharedTeamIds 字段 + owner-or-member 过滤放宽（全员可编辑）+ 分享到团队端点 + 活动日志埋点 |
| feat | prd-admin | 网页托管/知识库顶部新增「我的/团队」切换栏 + 「管理团队」面板（成员/邀请/活动日志）+ 卡片成员归属头像昵称 + 分享到团队 |
| feat | prd-api | UsersController 之外新增 /api/teams/search-users 与 /api/teams/user-cards（仅登录可用，团队成员检索与展示卡解析） |
| fix | prd-admin | 修复团队管理面板背景透明：modal 误用 --bg-card（rgba 0.08 玻璃叠加层）改为 --bg-elevated（两主题均不透明） |

### 2026-05-24

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | 知识库文档再加工：任务状态上提到 reprocessRunStore，关闭抽屉后任务继续后台运行且可见（文件树"加工中 N%"chip + 右下角任务 pill），完成后自动刷新文件树并选中新文档 |
| feat | prd-admin | 知识库文档再加工支持刷新页面续传：runId 持久化到 sessionStorage，重进页面由 ReprocessRunHost 用 afterSeq=0 重连续传或补齐终态 |
| fix | prd-api | 生图失败/取消时回填画布占位为 error（原先只在成功路径回填，失败的 run 让画布永远停在 running 转圈） |
| feat | prd-api | 新增画布对账接口 POST /api/visual-agent/image-master/workspaces/{id}/canvas/reconcile：按 run.TargetCanvasKey 反查真实结果修复卡死占位，不依赖前端 runId，可拯救历史孤儿 |
| fix | prd-admin | 视觉创作 SSE 流结束不再盲目标 error：先查后端真实状态，成功则回填、仍在跑则保留占位，避免慢任务被代理 EOF 误判 |
| fix | prd-admin | 拿到 runId 后立即持久化画布（不等 debounce），避免关页/切走导致占位丢失 runId 成为孤儿 |
| fix | prd-admin | 看门狗改走 workspace 级对账（覆盖无 runId 占位）+ 阈值 120s 降到 45s；加载即对账修复历史卡死占位 |
| fix | prd-admin | 视觉创作三处生图 SSE 订阅补齐 maxAttempts=20（原默认 10，慢任务过早放弃） |
| fix | prd-admin | 画布本地序列化器补齐 runId 往返持久化（此前 canvasToPersistedV1/persistedV1ToCanvas 从不存取 runId，是占位丢 runId 成孤儿的真正根因） |
| fix | prd-admin | runId 立即落盘改为保存成功后才更新已存标记，失败时让 debounce 重试，避免误判已存导致 runId 永不落库 |
| fix | prd-admin | SSE 流结束查询到 run 已失败/取消时展示真实失败原因，不再一律误报"超时" |
| fix | prd-admin | 加载/看门狗对账增加 workspace 切换防串台守卫，避免异步响应套到别的 workspace 画布 |
| fix | prd-admin | 看门狗恢复对 runId 占位的直查 run 同步（修复 SSE 掉线但 worker 已成功时 server 已 done、对账扫不到导致本地永久转圈的 desync），无 runId 孤儿仍走 workspace 对账 |
| fix | prd-admin | 看门狗直查 run 的回填条件放宽到"running 或无图 error"：transient 误标 error 后 run 实际成功也能从 error 翻回 done（原先只 heal running 会卡 error 直到刷新） |
| fix | prd-admin | runId 立即落盘抽成统一 helper，快捷操作 / 草图两条生图路径也复用（原先只主生成路径补 runId） |

### 2026-05-23

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 新增「项目路由智能体」(appKey: project-route-agent)：Controller / Models / GitRepoCacheService（浅克隆任意第三方仓库 + 读 routemap/ 目录）+ 内联 SSE 两阶段 LLM 分析 |
| feat | prd-api | AppCallerRegistry 注册 project-route-agent.extract.apps::chat 与 project-route-agent.resolve.routemap::chat |
| feat | prd-api | AdminPermissionCatalog + BuiltInSystemRoles 新增 project-route-agent.use / project-route-agent.manage |
| feat | prd-admin | 新增 /project-route-agent 页面：上传方案 md → AI 抽应用/模块 → 克隆仓库 → 匹配 routemap 项目路径；管理员 Tab 维护公共站点说明 + 仓库登记表 |
| feat | prd-admin | toolboxStore / navRegistry / shortLabel / authzMenuMapping 注册「项目路由智能体」入口（wip: true） |

### 2026-05-22

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 新增赋码采集关联系统综合智能体（ccas-agent）后端：CcasAgentController + 三大子能力（PRD 文档生成 SSE / 设备素材库生成与管理 / 流程图 LLM→JSON 解析）+ 权限 ccas-agent.use + AppCaller 注册（ccas-agent.prd::chat / ccas-agent.flow::chat / ccas-agent.equipment::generation） |
| feat | prd-api | 新增 MongoDB 集合 ccas_equipment_assets / ccas_flow_diagrams + AppNames.CcasAgent / AppDomainPaths.DomainCcasAgent |
| feat | prd-admin | 新增赋码采集关联智能体三 Tab 页面：PRD 生成（工程版+敏捷版双模板，Part A/B 两阶段流式）/ 设备素材库（6 风格预设 + 收藏 + 删除）/ 流程示意图（ReactFlow + 素材图节点 + 区段色块 + 历史持久化） |
| feat | prd-admin | toolboxStore + navRegistry 注册 builtin-ccas-agent（wip）+ shortLabel 加「赋码」+ apiClient 路由识别 |
| feat | .claude/skills | 落盘用户提供的 product-document-generator skill（SKILL.md + 4 个 template，工程版主+子文档 + 敏捷版） |

### 2026-05-20

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 海鲜市场上传弹窗精简：核心 3 字段置顶、封面/图标/预览/标签折叠进进阶；标题/详情 hint 压缩到 1 行 |
| feat | prd-admin | 上传支持单文件（.md / .markdown / .txt），前端用 JSZip 实时包装成 SKILL.md zip 走原通道，零后端改动 |
| feat | prd-api | 新增 POST /api/marketplace/skills/draft-description SSE 端点，拖入文件后流式起草 30 字详情，避免空白等待 |
| feat | prd-admin | 详情输入框新增 AI 起草徽标 + 流式预填；用户开始输入立刻让步并中断 SSE |
| fix | prd-api | AppCallerRegistry 新增 marketplace-skill 注册项，修复 AI 起草 APP_CALLER_INVALID |
| fix | prd-api | SSE JSON 编码用 UnsafeRelaxedJsonEscaping，中文不再被转成 \uXXXX |
| fix | prd-admin | SSE 区分 event:error，错误不再被拼进详情框，改走 error 状态 |
| fix | prd-admin | 技能详情弹窗改用 surface-popover（panel-solid 0.92 不透明），不再透出底层市场卡片 |
| fix | prd-api | CI 守卫 default-deny：删 IsKnownPrefix 白名单，所有 caller-code 字面量必须在 Registry，杜绝新前缀（marketplace-skill / page-agent 等）静默漏检 |
| fix | prd-api | 补登注册 page-agent.generate::chat（CapsuleExecutor 3 处旧裸字符串），同步替换为常量引用 |
| feat | prd-api | 新增 GET /api/marketplace/skills/{id}/zip-content + public/skill-share/{token}/zip-content 同源代理，解决浏览器对 COS/R2 直链 CORS 拒绝 |
| fix | prd-admin | 技能详情弹窗 + 分享页 zip 预览改走同源代理 URL，不再 Failed to fetch；fetch 携带 Bearer token |
| feat | prd-admin | 海鲜市场卡片用 reactbits SpotlightCard（普通）/ PixelCard（官方）双形态；官方卡像素动效色种子来自标题哈希，无封面图 |
| feat | prd-admin | 封面图上传前客户端 resize（1280×720 上限 + webp/0.82），上传上限从 5MB 降至 2MB |
| chore | prd-admin | 新增 reactbits/ 目录 + LICENSE.md（MIT + Commons Clause 归属），eslint 对该目录关 ban-ts-comment / exhaustive-deps，保持上游原样可 diff |
| fix | prd-admin | 官方技能卡 PixelCard 改为挂载后程式 focus 自动触发 appear（不再 hover-only）+ IntersectionObserver 滚回视口再 focus + CSS 关 focus 轮廓 + 底色压暗让像素更显眼 |
| fix | prd-admin | 官方卡 PixelCard 内 mkt-card 被 grid 挤成 0 高度 → glass 被 overflow:hidden 切掉，导致整张卡只剩像素无文字；改用 position:absolute inset:0 直接覆盖在 canvas 上层 |
| fix | prd-admin | 官方卡像素「不悬浮就空白」修复：给 vendored PixelCard 加 autoAppear 开关（挂载即播放 + 忽略 mouseleave/blur 收起），替换之前不可靠的程式 focus hack；偏离上游已在 reactbits/LICENSE.md 标注 |
| feat | prd-admin | 官方技能卡改用自研 SkillGlyph（手绘古典线描）替代 reactbits PixelCard：暖彩线描 + feTurbulence 手绘抖线 + 暖光，三形态（罗盘/植物/星图）按 tag 命中 skillGlyphRegistry 决定、无 tag 回退名字哈希；视口懒渲染防 turbulence 拖慢；移除 vendored PixelCard + officialSkillPalette |
| feat | prd-admin | SkillGlyph 新增「精英」金色八角徽章形态（emblem），tag=精英 触发；skillGlyphRegistry 补全 工具/需求/技能 等 tag 归类 |
| chore | prd-admin | 官方技能打包：单主标签策略 + TAG_OVERRIDE 手工修正（老王=精英、findmapskills=技能+精英 等）+ 排除清单（qa-ledger/cn-brief-summary 等纯输出格式类不进市场） |
| feat | prd-api | 官方技能全量上架：OfficialSkillCatalog 读内嵌 JSON 注入 14 个精选技能（findmapskills 仍特殊处理）；csproj 内嵌目录；List/Fork/GetById/Favorite 全 touchpoint 按 official-{key} 解析；OfficialSkillsController.Download 从目录打完整 zip（含 reference/scripts 全部文本文件）|
| feat | prd-admin | 海鲜市场拆「官方推荐」+「社区上传」两区，官方置顶不挤瀑布流埋没用户上传 |
| chore | prd-api | 官方技能打包改 INCLUDE 精选白名单（15 个可移植技能）+ 完整目录打包（v2 catalog，单文件 96KB 上限），剔除绑死本仓库基础设施的内部技能 |
| fix | prd-api | 官方技能给中文友好备注名（DISPLAY_NAME map），卡片不再裸显英文 key |
| fix | prd-admin | 官方技能 zip 预览改用 skill.zipUrl 直连（同源 AllowAnonymous 完整 zip），修复 official-* 走 authed zip-content 代理查 DB 落空导致的 404 / 直开 401 |
| fix | prd-api | 官方目录 DTO createdAt 用固定发布日期（曾误用 DateTime.UtcNow → findmapskills AI 的 sort=new 轮询每次误报 14 个新技能、最新排序乱序）|
| fix | prd-api | Open API 官方注入加 includeCatalogWhenUnfiltered=false：无搜索词不注入目录技能，避免 AI list/分页/轮询被 15 个官方占满 budget 翻不到社区技能；Web 仍全展示（归「官方推荐」行）|
| feat | prd-admin | 社区 skill 无封面也用 SkillGlyph（哈希形态，不传 tags 故无精英徽章），拉平与官方卡的视觉；社区卡 hover 同样「绽放」 |
| feat | prd-api | /tags 端点合并官方 catalog 的 tag（精英/开放接口等），用户可按「精英」筛出 laowang 等 |
| feat | prd-admin | 海鲜市场改编辑气质：技能图标重做为炭黑手绘抽象线条 + 陶土锚点圆点（8 个专属象形符号 + 哈希抽象兜底），技能图标区背景走暖米灰纸底 #F0EEE6，市场页背景走暖白纸张 #FAF9F5；去辉光/去多彩，悬浮仅陶土锚点轻微放大。仅改背景+技能背景，不动卡片结构/工具栏 |
| feat | prd-admin | 技能图标定稿 v6 游戏技能图标：暖彩手绘线条 + 六边技能槽框（悬浮缓缓旋转）+ 13 个专属象形符号 + 哈希抽象兜底；撤销上一版纸张/炭黑/陶土编辑气质（页面背景、技能图标区背景回退深色），深浅混搭不协调问题消除 |


### 2026-05-24

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 快捷指令下载接口优先使用 macOS `shortcuts sign --mode anyone` 返回签名 `.shortcut`，签名不可用时不再伪装成一键安装 |
| fix | prd-admin | 快捷指令安装页改为签名下载优先、iCloud 模板其次、手动配置兜底，扫码安装路径更明确 |
| fix | prd-api | 内置 PrdAgent 收藏 iCloud 模板链接，并让快捷指令模板列表兼容前端读取的 `items` 字段 |
| feat | prd-api | 快捷指令授权默认 1 年有效，过期后拒绝 collect/install/download；管理端可按当前用户隔离延长到 3 年后 |
| feat | prd-admin | 快捷指令页新增实时收件箱，轮询展示当前登录用户通过快捷指令发来的最新收藏记录 |
| fix | prd-api | 启动时为历史快捷指令回填 `CreatedAt + 1 年` 的过期时间，避免旧授权永久有效 |
| fix | prd-admin | 创建成功弹窗新增完整安装配置 JSON，并提示 iCloud 模板不能只复制 Token |
| fix | prd-api | 修复 iCloud 快捷指令模板首次配置条件反向，避免未读取剪贴板配置导致 `获取 URL 内容` URL 为空 |
| fix | prd-api | 修正快捷指令模板读取/保存 `prdagent_config.txt` 的 Shortcuts 文件动作参数，确保配置可持久化 |
| fix | prd-api | 默认 iCloud 模板更新为重新生成的可配置 v4 链接，并在启动时覆盖旧默认模板链接 |
| fix | prd-admin | iCloud 模板安装按钮自动把 key 和当前站点接口地址写入剪贴板，用户无需单独复制 URL |

### 2026-05-22

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | 修复 Bugbot Medium：WebPagesPage「查看所有分享」链接 `/assets?tab=shares` → `/my-assets?tab=shares`（`/assets` 是 admin 资产管理页无 shares tab，`/my-assets` 才是 MyAssetsPage） |
| fix | prd-api | 修复 Bugbot High：WebPagesController ViewShare + SaveSharedSite 透传速率限制 429（之前被 switch 默认分支映射成 404），并设置 Retry-After header |
| fix | prd-admin | 修复 Bugbot Medium：ShareTeamWeekDialog handleClose 恢复安全默认（usePassword=true + 重新生成强密码），不再重置为 false 撤销密码保护默认 |
| fix | prd-api | 修复 Codex P1：工作流分享无前端展示页，撤销 WorkflowAgentController 的 ShortLink allocate + 不返回 shortShareUrl，避免暴露打不开的数字短链；移除未使用的 IShortLinkService 注入 |
| feat | prd-api/prd-admin | MyShareItem 加 `viewable` 字段：document_store（SPA 路由缺失）+ workflow（无展示页）标 false；前端「我的分享」对 viewable=false 的类型显示"展示功能开发中"提示而非死链 |
| docs | doc/debt.share-link-security.md | 更新 workflow / document_store 分享对外展示未实现的台账 |
| fix | prd-api | 修复 Bugbot Medium：MySharesController byType 改为基于全量统计（切 targetType filter 后 chip 计数不再错乱/消失）；items 单独按 targetType 内存过滤 |
| fix | prd-api | 修复 Codex P1：知识库分享同工作流——无可用 /library/share/:token SPA 路由，撤销 DocumentStoreController 的 ShortLink allocate，不暴露打不开的 /s/{seq}；移除未用 IShortLinkService 注入 |
| fix | prd-admin | 修复 Codex P1：ShortLinkRouter document_store case 从 Navigate（死路）改为 UnsupportedTargetError |
| fix | prd-admin | 修复 Bugbot Medium：MySharesPage load 加 try/finally（请求 reject 时 spinner 不再永久卡住，finally 中仅最新请求关 loading） |
| fix | prd-admin | 修复 Bugbot Medium：DesktopAssetsPage 加 useEffect 监听 URL ?tab= 变化（深链 /my-assets?tab=shares 在不 remount 时也能切到正确 tab） |
| fix | prd-admin | 修复 Bugbot Low：ShareLinkTesterPage handleResolve 加 try/finally（fetch 抛异常时按钮不再永久禁用）；LEGACY_PATH document_store 改 null 不显示死链 |
| fix | prd-admin | 修复 Bugbot Medium：MySharesPage「字母统一长链」/s/{token} 仅在 shortSeq>0（已注册 ShortLink）时展示——否则与 /s/{seq} 同样 resolve missing，避免给出打不开的可复制链接 |
| fix | prd-api | WebPagesController + ReportAgentController：unifiedShareUrl 仅在 ShortSeq>0 时返回（否则 null），与 shortShareUrl 同条件，未注册 ShortLink 时只暴露有效的带前缀长链 |

### 2026-05-21

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | AI Toolbox 快速创建向导第 3 步打通知识库上传（替换原"即将上线"占位符，复用 ToolEditor 同一套 attachment 上传与 prompt 注入通路） |
| docs | doc | 新增 debt.knowledge-base 债务台账（含 RAG/embedding 未做、两套知识库并存等 8 条 open） |
| fix | prd-api | 修复 Cursor Bugbot High/P1：MySharesController 知识库 `PrimaryPath` 从无效的 `/public/share/{token}` 改为有效的 `/library/share/{token}`（与 DocumentStorePage 创建 URL + ShortLinkRouter navigate 一致） |
| fix | prd-api | 修复 Bugbot P2：DocumentStoreController create-share 返回值恢复为完整 `DocumentStoreShareLink`（之前自定义匿名对象缺 viewCount/createdAt/isRevoked，前端 prepend 到 list 后字段缺失回归）；ShortLink 注册副作用保留 |
| fix | prd-admin | 修复 Bugbot High：ShareLinkTesterPage LEGACY_PATH 知识库路径 `/public/share/` → `/library/share/` |
| fix | prd-admin | 修复 Bugbot Medium：MySharesPage load 加 fetchIdRef 防过期响应守卫（filter/showRevoked 快速切换时丢弃旧回包，项目 learned rule） |
| fix | cds | 分支错误归类不再一律标记"应用代码错误"，区分 CDS 运行时错误（容器已丢失/镜像拉取/调度器异常等）、应用代码错误（启动崩溃/缺依赖/健康检查不过）、部署配置错误（端口冲突/OOM），避免冤枉应用方 |
| fix | prd-api | 更新中心待发布口径改为全部 changelogs/*.md 碎片，不再按当前周裁剪，也不再混入 CHANGELOG.md 日期块 |
| fix | prd-admin | 更新中心已发布/待发布/实时日志 tab 显示各自总数量，待发布文案对齐全部碎片口径 |
| feat | prd-api | 实时日志改取最近 7 天 GitHub commits，支持分页补全并返回提交者头像 |
| feat | prd-admin | 实时日志显示提交者头像与相对提交时间，刷新按钮强制重新拉取最新日志 |
| fix | prd-admin | 「管理标签」勾选「默认」时即时同步到上方标签条选中状态（无需关闭面板再生效） |
| refactor | prd-admin | 「本周待办」卡片去掉冗余提示文案「完成或删除前会一直流转到下一天」 |
| refactor | prd-admin | 「管理标签」面板紧凑化：单行 input+按钮+统计、2 列网格布局、去掉「系统/不可删除」冗余文字、控件缩小，整体高度减半 |
| feat | prd-api | DailyLogItem 新增 CompletedAt 字段（Todo 完成时间快照） |
| feat | prd-api | UserPreferences.ReportAgentPreferences 新增 DailyLogTagOrder / DailyLogDefaultTags 字段；GET/PUT /api/report-agent/my/daily-log-tags 响应与入参扩展 tagOrder + defaultTags |
| feat | prd-admin | 日常记录中央列加「本周待办」置顶卡片，跨日聚合所有本周未完成 Todo，hover 显示「✓ 标记完成 + 🗑 删除」 |
| feat | prd-admin | Todo 行操作按钮区分：未完成 → 「✓ 标记完成 + 🗑 删除」、已完成 → 「已完成」chip + 删除；非 Todo 维持「编辑 + 删除」 |
| fix | prd-admin | 去掉默认勾选「开发」标签，进入今日打点默认空选；用户在「管理标签」勾选的默认标签会自动应用 |
| feat | prd-admin | 管理标签面板重写：系统 + 自定义标签统一拖动排序、可勾选默认；系统标签不可删，自定义可重命名/删除 |
| feat | prd-admin | 周报 Agent 顶部新增「日常记录」Tab（位于「周报」之前），独立承载 DailyLogPanel + 我的记录子菜单 |
| refactor | prd-admin | 「周报」Tab 内的「日常记录」按钮 + showDailyLog 内嵌视图删除（已上移到顶级 Tab） |
| feat | prd-api | UserPreferences.ReportAgentPreferences 新增 DefaultTab 字段；新增 GET/PUT /api/report-agent/my/default-tab 端点 |
| feat | prd-admin | 「设置」新增「自定义登录页面」section，默认「团队」，可选「日常记录 / 周报 / 设置」共 4 项；登录后默认 Tab 按用户偏好；未设置时按团队成员关系兜底 |
| fix | prd-admin | 「本周待办」条目前面误导性的圆形 ✓ icon 删除（用户以为是操作按钮） |
| fix | prd-admin | 自定义登录页偏好仅在「外部进入」周报 Agent 时应用，内部跳转（子路由 back / setActiveTab）保持当前 tab；修复设了「日常记录」为默认页后、在团队点周报跳详情再回来被拉回日常记录的 bug |
| feat | prd-api | 缺陷分享响应新增精简 Agent 启动包，声明 domain/auth/scope 与 ai-defect-resolve 技能版本要求 |
| feat | prd-admin | 缺陷分享提示词收敛为 Agent 启动参数，临时密钥分享自动创建受控缺陷分享 |
| docs | skills | ai-defect-resolve 技能补充版本号、本项目内置优先和精简分享包输入规则 |
| docs | doc | 新增缺陷分享与 Agent 技能修复架构文档，并登记到文档索引 |
| docs | doc | 从信息损耗视角重写缺陷分享架构摘要，补充低损耗修复链路图 |
| fix | defect-agent | auth 缺失时不再提示 Agent 猜测环境变量，改为询问主站或引导用户打开分享链接一键签发临时 key |
| feat | prd-admin | 知识库左侧目录新增「显示设置」弹窗，可开启在每个条目右侧显示相对更新时间（hover 显示精确时间 + 作者），默认关闭、设置以 sessionStorage 持久化 |
| feat | prd-admin | 文档阅读器正文最大宽度由固定 860px 改为自适应 min(100%, 1180px)，宽屏下表格/正文获得 ~37% 更大阅读空间 |
| feat | prd-admin | 文档阅读器顶部「更新于」改用相对时间（刚刚/几分钟前/昨天/N 天前，hover 显示精确时间）；作者未知时不再显示「更新者 未知用户」减少噪音，new 徽标保留 |
| fix | prd-admin | 修复知识库左右分栏拖拽不跟手/跳动：宽度基准由写死的 20px 偏移改为拖拽开始时实测侧栏左边界（getBoundingClientRect），并移除导致每帧重挂监听的依赖 |
| fix | prd-admin | 修复保存后「更新于」显示陈旧时间：相对时间显示改回只用 updatedAt（保存会刷新），lastChangedAt 仅供 new 徽标；并给侧栏每行相对时间关闭独立 60s 定时器，避免大知识库累积大量 timer |
| feat | prd-api | 新增 `GET /api/my/shares`：跨 4 类 ShareLink（web_page / report / document_store / workflow）聚合当前用户的全部分享，关联 ShortLink 索引补齐数字 Seq，按 createdAt 倒序输出统一形态 + 按类型分组统计 |
| feat | prd-admin | 新增「我的分享」页面 `/my/shares`：按类型分类筛选 / 含已撤销切换 / 每条 3 种 URL 形态可一键复制 + 新标签打开 / 已撤销 / 已过期视觉降级 / 空状态引导文案 |
| feat | prd-admin | 注册百宝箱条目 `builtin-my-shares` + 短标签 `'shares' → '我的分享'` |
| fix | prd-api | 用户改名后级联同步周报域所有冗余姓名快照（团队成员/周报作者/审阅人/退回人/日常打点/点赞/浏览），新增 POST /api/users/backfill-display-names 一次性回填历史数据 |
| fix | prd-admin | 团队周报列表卡片改用 flex-1 撑满剩余视口，去掉 max-h-540 魔数避免宽屏下方大块空白 |
| feat | prd-admin | 日常记录 Todo 标签的"计划周次"新增"本周"选项，与已有"下周"/"下下周"组成三选一 |
| feat | prd-admin | 日常记录右栏"快捷分类"替换为"待办计划"面板，按本周/下周/下下周三组聚合所有 Todo 条目 |
| feat | prd-admin | 周报编辑器：同章节内 items 支持拖动排序。hover 任意 item 左侧出现 GripVertical 拖动手柄，按住可在该章节内改顺序；拖动时元素半透明，drop target 顶部 2px indigo 横线指示；跨章节拖动直接拒绝。覆盖 BulletList / RichText / IssueList 三种 inputType，复用 useAutosave 自动保存 |
| feat | prd-admin | 周报编辑器加左侧 sticky 章节大纲（仅桌面 lg+ + 章节数 ≥3 时显示）：章节编号 + 标题 + 填写进度 + 点击 scrollIntoView 跳转 + IntersectionObserver scroll-spy 自动高亮当前章节；内容主区 max-w 860→920，整体外层 max-w 1200 利用宽屏左右留白 |
| refactor | prd-admin | 周报编辑器章节卡：上一轮去框过头导致章节融化到主背景，恢复轻量 surface 容器（暗色 rgba(255,255,255,0.025) + 1px hairline border + 微 backdrop-blur + 双层柔和阴影；浅色 #FFFFFF + hairline + sm 阴影），保留中性灰阶不回退到彩色色斑；mono 章节编号"01"提升为悬浮页边码（桌面 lg 断点显示在卡片外左侧，窄屏内联回 header）；header / items 间加 mx-6 hairline 细分隔；bullet 与拖动手柄通过 fixed-height 容器对齐输入框首行中心 |
| refactor | prd-admin | 周报编辑器视觉大改造（激进档）：去除每章节彩色圆圈/淡底/3px 色条/dashed 按钮等色斑；改 mono 编号 + h3 半粗标题 + hairline 分章；输入框 borderless + focus 时 1px indigo 底线 + row hover 浅灰底；AI 自动生成 banner 收敛为顶栏右上 ✨ AI 草稿 chip（tooltip 显时间+模型）；必填红 * 改灰 chip「必填」；整页 max-w-880px 居中；接近 Notion / Linear / Stripe Docs 阅读级编辑器气质 |
| refactor | prd-admin | 「我的周报」从横向 strip 改为响应式 grid：xl 4 列 / lg 3 列 / sm 2 列 / mobile 1 列；卡片宽度由 grid 撑开（去掉 220px 硬编码），移除横向滚动与时间轴细线 |
| refactor | prd-admin | 「我的周报」列表从竖向 grouped 卡片改为左右滑动的历史栏：每张 220px mini 卡显示「周次 W17 + 团队名 + 状态 + 章节进度小点阵 + 进度条 + 时间轴锚点」；底部细线串成时间轴；右侧渐隐遮罩提示「还有更多」 |
| feat | prd-admin | 「我的周报」新增「时间树」视图：筛选栏右侧加 ▣ 卡片 / 📅 时间树 icon 切换；时间树左侧年/月/周三层折叠（默认展开当前年+月）、右侧选中周后展开周报内容预览（状态chip+团队名+各章节items前120字缩略+进度条），点「查看完整」跳详情；sessionStorage 记忆视图偏好 |
| fix | prd-api | 产品评审员 Agent 评分校准：重写 system prompt 分级带（多数合格 75-89、90+ 罕见），加反堆砌/反空话硬规则与 3 段 few-shot 锚定示例；user prompt 加 90+ 必须列三亮点的纪律 |
| fix | prd-api | 产品评审员默认维度权重调整：「表达质量与凝练度」4→10（反堆砌主战场）、「文档规范完整性」14→8（章节齐全不应权重过高），总分仍 100；维度名改为「表达质量与凝练度」并补充凝练度/数据密度/堆砌封顶口径 |
| feat | prd-admin | ShareDock 投放面板上传区改为 1:1 方形，支持「点击选择 / 拖拽」两种上传方式 |
| feat | prd-admin | 网页托管：拖入或点击上传文件后，ShareDock 内联二选一「无密码分享 / 有密码分享」，点选后才创建分享并自动复制链接（有密码自动生成6位）+ 展示访问密码，无需再开上传弹窗 |
| feat | prd-admin | 网页托管：已分享站点在卡片/列表名字前加「已分享」琥珀标签且名字变琥珀黄；分享按钮转为「取消分享」（卡片走 inline 轻确认，只撤该站点单站点分享） |
| feat | prd-admin | ShareDock 投放槽新增「读心」能力：拖已分享站点到分享槽变「取消分享」、拖已公开站点到公开槽变「取消公开」 |
| fix | prd-admin | ShareDock 上传区方框在面板内水平居中（原 aspectRatio + maxHeight 致方框靠左） |
| fix | prd-admin | ShareDock 面板收窄（288→236）、上传区限高 168px、底色加实，修正「太大太透明」 |
| feat | prd-admin | 网页托管右上角新增「按时间 / 按文件夹」分组方式（参考文学创作），与排序并存互不冲突，分节标题展示时间桶（今天/昨天/M月D日）或文件夹名；选择经 sessionStorage 持久化 |
| fix | prd-admin | **历史兼容性修正**：撤回 C3 引入的 ShortLinkRouter 错误 Navigate（workflow → `/share/workflow/` 路由不存在；document_store → `/public/share/` 路由不存在）。改为：workflow 显示 UnsupportedTargetError（与历史一致）；document_store Navigate 到 `/library/share/{token}` 与 DocumentStorePage 创建分享 URL 对齐 |
| fix | prd-api | 撤回 C5 引入的 DocumentStoreController 错误 shareUrl：`/public/share/{token}` → 恢复 `/library/share/{token}`（前端历史 URL，与 DocumentStorePage 一致；事实自查：App.tsx 无 `/public/share/` 路由） |
| feat | prd-admin | 「我的资产」页加「分享」tab（按用户诉求集成而非独立页）：复用 MySharesPage 组件，支持 URL `?tab=shares` 直达，切 tab 同步到 URL（可复制可分享） |
| feat | prd-admin | WebPagesPage ShareDialog 成功提示加「查看所有分享 →」链接，新标签打开 `/assets?tab=shares` |
| docs | doc/debt.share-link-security.md | 记录事实自查发现的历史缺陷：知识库 `/library/share/:token` 前端 SPA 路由不存在（独立缺陷，非本次引入）；工作流分享无专用 ViewPage |
| fix | prd-api | P1 反转（用户反馈方向调整）：4 处分享创建端点默认 URL 恢复带分类前缀长链（`/s/wp/`、`/s/report-team/`、`/public/share/`），不再统一到 `/s/{token}`。原因：分类前缀有语义、利于分享总管理面板按类型分类 |
| fix | prd-api | 同时返回 `unifiedShareUrl=/s/{token}` 字母统一长链作为高级选项；`shortShareUrl=/s/{seq}` 数字超短链保留作为可选；ShortLink 全局索引继续注册（这是"分享总管理"的数据基础） |
| fix | prd-admin | WebPagesPage ShareDialog 同步：默认 `shareUrl`（带前缀长链），用户主动切换才用 `shortShareUrl`；types 更新 `legacyShareUrl` → `unifiedShareUrl` |
| feat | prd-admin | 作品广场卡片增加 reactbits Masonry 风格入场动效（位移 + 缩放 + 模糊淡入 + 列内 stagger） |
| fix | prd-admin | 作品广场有封面卡片占位底从纯黑改为彩色渐变 + 加载呼吸占位，避免图片懒加载前闪黑 |
| refactor | prd-admin | 「管理标签」改为原地编辑模式：按钮 toggle 文案「管理标签 ↔ 保存」；编辑态下原标签条变虚框 + 加左侧 mini 默认勾选 + 右上角 ✕ 删除（仅自定义）+ 整 chip 可拖动 + 双击重命名；展开面板与重复列出的标签内容删除；新增 input 内联到标签条末尾 |
| fix | prd-admin | 团队 Dashboard「团队成员」抽屉用 createPortal 挂到 document.body + z-index 50→100；修复抽屉被父容器 overflow/transform 吞噬导致的「背景透出主列表」「底色不一致」「内容重叠」三大视觉问题 |
| refactor | prd-admin | 周报日期范围格式从「5/18 - 5/24」改为「5.18~5.24」（点 + 波浪号），符合用户习惯。改动单点（utils/weekRange.ts），全 Agent 9 处显示自动统一 |
| refactor | prd-admin | 周报全局周次显示从「2026 年第 21 周」改为「5/18 - 5/24 · W21」格式：日期范围为主、ISO 周次为辅。覆盖顶部筛选下拉、卡片、详情页、编辑器、分享对话框、Markdown 导入、示例 Markdown 等 9 处显示。新增 utils/weekRange.ts 共享 helper（含 getISOWeekStart + formatWeekDateRange + formatWeekLabelWithRange） |

### 2026-05-20

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | 网页托管"快速分享"弹窗默认改用字母长链 /s/wp/{token}（72 bits 熵不可枚举），数字短链折叠到"高级选项"，选择短链时强制启用 ≥12 位强密码（大小写+数字+符号），取消密码时弹 10s 倒计时风险警告 |
| fix | prd-admin | 周报"快速分享"弹窗默认勾选密码保护，弱密码长度从 6 升级到 8（字符集不变，避开 i/l/o/0/1 易混淆字符） |
| feat | prd-api | 新增 `SharePasswordService`：PBKDF2-SHA256 加密 + `CryptographicOperations.FixedTimeEquals` 恒时校验 + per-shareLink 滑动窗口速率限制（1 分钟内 10 次尝试） |
| feat | prd-api | `WebPageShareLink` / `ReportShareLink` 新增 `PasswordHash` / `PasswordSalt` / `RecentAttempts` 字段；旧分享 `PasswordHash` 为空时自动回退明文恒时比对 |
| fix | prd-api | 网页托管 + 周报分享密码校验改用 SharePasswordService：失败响应 HTTP 429 + `Retry-After` header 告知前端倒计时；密码正确清空窗口避免合法用户被自己历史失败拖累 |
| fix | prd-api | 速率限制不绑定客户端 IP —— 反向代理 / 容器 / NAT 局域网 IP 不可靠，且 IP 锁会让公司内一人输错全员遭殃；改按每分享链接独立计窗口 |
| docs | doc | 新增 `doc/debt.share-link-security.md` 记录知识库密码缺失、工作流 ShareLink.Password dead code、数字短链历史链接清理等 5 项后续债务 |
| feat | prd-api | P1 URL 统一：4 处分享创建端点全部走 `/s/{token}` 字母长链；不再使用 `/s/wp/`、`/s/report-team/` 等分类前缀 |
| feat | prd-api | 周报 / 知识库 / 工作流分享创建时同步注册到 ShortLink 全局索引（之前只有网页托管在用），同时返回 `shareUrl=/s/{token}` 和可选 `shortShareUrl=/s/{seq}` |
| feat | prd-api | `IShortLinkService.ResolveByTokenAsync` + `GET /api/short-links/resolve/{slug}` 接受任意 slug（纯数字 → Seq，字母 → Token），统一调度入口 |
| feat | prd-admin | `ShortLinkRouter` 放开"slug 必须纯数字"限制，字母 token 也能命中；网页托管直接 mount 子组件（URL bar 不变），周报/知识库/工作流暂用 Navigate 跳转兼容 ViewPage（待 P1.next 接 tokenOverride prop） |
| fix | prd-admin | WebPagesPage ShareDialog 默认 URL 从 `legacyShareUrl=/s/wp/{token}` 切换到 `shareUrl=/s/{token}`（P1 统一格式），短链选项走 `shortShareUrl` |
| docs | doc | 更新 `doc/debt.share-link-security.md` 加入 P1.next 待办：周报/知识库/工作流 ViewPage 接 tokenOverride 让 URL bar 始终保持 /s/{token}；分享测试器实验室页 |
| feat | prd-admin | 新增"分享链接体检"实验室工具（百宝箱 wip 标记）：粘贴任意 slug（数字 Seq 或字母 Token）→ 后端解析 → 并排展示 3 种 URL 形态（统一长链 / 超短链 / 旧版前缀链）+ 每条带"复制 + 新标签打开"按钮，用于人工验收 P1 URL 统一 |
| feat | prd-admin | 新路由 `/labs/share-link-tester`；注册到 BUILTIN_TOOLS + SHORT_LABEL_MAP |

### 2026-05-19

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 分支「停止」改为只 docker stop 保留容器（不再 docker rm），停止后「重新启动」可秒级 docker restart 唤醒，无需重新部署 |
| refactor | cds | ContainerService 拆分 stop（暂停保留）/ remove（销毁），删分支/重置/孤儿清理/force-rebuild/janitor 等销毁路径改用 remove |
| feat | cds | 主动停止前写入 [CDS-STOP] 哨兵到容器日志末尾，配合 lastStopSource 账本区分「正常停止」与「莫名崩溃」，异常退出现场日志得以保留待查 |

### 2026-05-18

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 容器异常退出（崩溃/OOM）由 auto-restart 巡检留痕：写活动日志 + lastStopReason/Source=crash + stopCount，杜绝"分支莫名其妙停止零日志" |
| feat | cds | janitor 自动回收分支前写活动日志（actor=janitor），分支消失有迹可循 |
| feat | cds | 新增 POST /api/branches/:id/restart 轻量重启（docker restart，不重建代码），与重新部署区分 |
| feat | cds | 新增 GET /api/branches/:id/activity-logs 分支维度系统日志（最新在前） |
| feat | cds | 分支详情抽屉日志页签合一：Webhook/HTTP 并入「日志」，新增「系统日志」pill 展示谁停的/何时/为什么 |
| feat | cds | 分支详情底部按钮一分为二：重新启动（秒级拉起）+ 重新部署（拉新代码重建） |
| feat | cds | 分支卡加宽（2xl 才三列），footer 去掉 commit hash 改为部署时间 |
| feat | cds | CDS 系统设置新增「调度器」页：可视化调节空闲自动下线时长、最大热分支数、启用开关，配置即时生效并在重启后保留 |
| fix | prd-admin | 涌现画布：停止/涌现出错时不再丢弃已到达的持久化节点（落位而非清空缓冲） |
| fix | prd-admin | 涌现画布：渐显未完成前父节点保持锁定，阻止同父重复探索/涌现/整理交错导致乱序落位 |
| fix | prd-admin | 涌现画布：revealNext 与 flushPending 去重逻辑对齐，避免 SSE 重发导致重复节点/nodeCount 多计 |
| fix | prd-admin | 涌现画布：涌现 onDone/onError 清空 emergeAnchorRef，防止陈旧锚点把后续探索节点误导到无槽 key 而孤立 |
| fix | prd-admin | 涌现画布：flushPending 同一批内重复 node 事件也去重（dedupe set 随落位增长） |
| fix | prd-admin | 涌现画布：stopAll 后 SSE 迟到 node 事件丢弃（探索按流身份、涌现按锚点判活），不再孤立已生成节点 |
| fix | prd-admin | 涌现画布：最后一个缓冲节点渐显完后补 buildFlow，立即清掉父节点残留的 isExploring 脉冲/锁定态 |
| feat | prd-admin | 海鲜市场技能卡片可点击打开近全屏详情弹窗（左文件树+右预览，默认 SKILL.md，前端 jszip 解压公开 zip 包） |
| feat | prd-admin | 新增技能公开免登录分享：卡片+详情弹窗分享按钮生成链接，外部经 /s/skill/:token 只读浏览 SKILL.md+文件树 |
| feat | prd-api | 新增技能分享链接（MarketplaceSkillShareLink）+ 创建/匿名公开读端点（仅返回公开字段） |
| fix | prd-admin | 修复技能卡片封面图上文字看不清（新增整卡渐变遮罩 + 提高玻璃面板与标题/描述对比度，明暗主题双修） |
| refactor | prd-admin | 抽离知识库 MarkdownViewer/FilePreview 为共享组件 components/file-preview，详情弹窗与分享页复用 |

### 2026-05-17

| 类型 | 模块 | 描述 |
|------|------|------|
| refactor | prd-admin | 涌现画布布局重构：位置权威 positionsRef + 全量布局仅初始/手动整理触发，流式生成不再全树重排 |
| fix | prd-admin | 涌现生成体验：删除顶部流式横幅，反馈下沉到父节点下单一固定尺寸生成槽，子节点按 ~170ms 节流逐个落位 |
| fix | prd-admin | 涌现父子完整性：孤儿子节点暂存待父出现回收，后端节点只增不删，拖动位置写回权威 |
| refactor | prd-admin | 涌现列表卡片改为极简排版流：固定高度，去轨道粒子 SVG，悬停改为绝对定位淡入（修复悬停撑高挤动整行） |
| refactor | prd-admin | 涌现介绍页推倒重做为 claude-code 式克制排版：去旋转轨道/浮动粒子/玻璃 bento，单焦点 hero + 极简三步 |
| chore | prd-admin | 删除弃用 EmergenceStreamingBar 组件并清理 emergence.css 死动效 |
| feat | prd-api | 作品广场改为热度排序（带时间衰减）+ _id 稳定 tiebreaker，消除翻页重复、新作品自然冒泡 |
| perf | prd-api | Executive 排行榜/团队页改为 MongoDB 服务端 $group 聚合，消除全集合 Find 进内存 + per-user N+1 |
| fix | prd-api | 修正缺陷"已解决"口径：未解决缺陷不再被计入解决数 |
| feat | prd-admin | Executive 统计页缺陷三列合并为单列「缺陷」（提交+解决），每个指标列加问号说明 tooltip（口径/怎么+1/排除异常，文案后端下发） |
| fix | prd-api | 作品广场热度分基准时间按 10 分钟取桶，修复偏移分页跨请求 $$NOW 漂移导致的边界作品重复/漏项 |
| test | prd-api | 新增作品广场热度公式单元测试 + Executive 排行榜聚合交叉验证集成测试 |

### 2026-05-16

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 知识库总访问量按行业做法去重：同一访客 30 分钟窗口内重复打开/刷新同一文档不再 +1，独立访客与总时长基于全量事件聚合 |
| fix | prd-admin | B9 知识库"发布到智识殿堂"按钮由灰色 surface-action 改为 surface-action-accent，明确可点击 |
| fix | prd-admin | B1 知识库文档浏览器去掉额外 px-5 双重内缩，卡片左右与上方 TabBar 边缘对齐，消除左上角空白竖条 |
| feat | prd-api | B4 划词评论支持"不选中也能评论"：SelectedText 为空时按全文评论接受，不再 400，不参与 rebind |
| feat | prd-admin | B4 评论抽屉无选区时也可输入并提交全文评论，卡片展示"全文评论"标签 |
| fix | prd-admin | B6 划词选区改以 selectionchange 为主信号 + dblclick 兜底 + 防抖，双击选行/拖拽选区稳定保留不再瞬间消失 |
| feat | prd-admin | F1 知识库文档预览右侧新增"本页章节"导航（TOC），slug 复用正文规则、点击平滑滚动、IntersectionObserver 高亮当前标题，无标题/窄屏自动隐藏 |
| feat | prd-admin | F2 借鉴文档站观感优化知识库正文排版：更大行距/字号、标题上间距强化层级、列表/引用/代码块留白加大、底部留白；H1/H2/表格/hr 边框由硬编码白改主题 token（修白天主题不可见） |
| feat | prd-admin | F3 知识库左侧文件夹改为"章节分组"样式：加粗放大标题、上下分隔线、折叠箭头移到右侧、子项缩进更清晰；不改拖拽/右键/主文档逻辑 |
| fix | prd-admin | B6 二次修复：选区 offset 定位由"indexOf 失败即丢弃选区"改为分级回退（精确→空白归一化→行首标记剥离→兜底），定位失败也照常产出选区，blockquote/标题/列表项双击或拖拽选中稳定保留且"添加评论"浮层必现，修复划词后浮层不出现的回归 |
| fix | prd-admin | 知识库文档标题/正文/TOC 统一走新增 lib/frontmatter.ts 的 parseFrontmatter：左侧"正文标题"识别 YAML frontmatter 的 title 并去成对引号、无 title 回退首个正文标题；MarkdownViewer 与 TOC 不再把首个 ---/title:/description: 块当正文渲染 |
| fix | prd-admin | 知识库未选中文件时的预览占位图标由 FileText 改为书籍语义 BookOpen（加载中态仍走 MapSectionLoader 不变） |
| fix | prd-api | 知识库上传文件/新建文档时补设 DocumentEntry.LastChangedAt=UtcNow，新条目立即带 NEW 徽标、24h 后自动消失（此前两端点漏设导致 NEW 永不显示） |
| feat | prd-admin | 知识库左侧文件树视觉升级：行 hover/选中改为不贴边的 9px 圆角整块高亮 + 内侧细 accent 条（替代又粗又方的贴边竖条），行距/图标文字间距更舒展，文件夹章节标题改大写小字 muted + 单条细分隔线，搜索框/底部统计轻量化；全部走主题 token，dark+light 双主题适配 |
| feat | prd-admin | 知识库搜索去掉"标题搜索/内容搜索"切换按钮，默认永远同时搜标题+内容；标题未命中仅正文命中的条目加「内容包含」轻量标记，placeholder 统一为"搜索标题或内容…" |
| fix | prd-api | 知识库搜索关键词正则转义(避免 [draft]/v1.0/foo( 误匹配或报错) + 访客停留时长改累加(去重窗口内重开不再覆盖前次时长) |
| fix | prd-api | 知识库访客统计改用 MongoDB $facet 聚合管道在服务端算总访问量/独立访客/总停留时长，不再把该 store 全量 view event 拉回应用层内存（大访问量下内存与延迟不可控），响应结构不变 |
| fix | prd-admin | 知识库 TOC slug 与正文 heading id 统一：抽出共享 headingTextToSlug（剥 markdown 标记 + 剥内嵌 HTML 标签 + HTML 实体解码 + 同一 GithubSlugger），rehypeRaw 渲染含 <kbd>/<span> 的标题点目录可精确跳转 |
| fix | prd-admin | 知识库正文 sanitize schema 移除对所有元素的内联 style 放行（仅保留 className/id 与 KaTeX math），堵住公开知识库经 rehypeRaw 用 position:fixed 钓鱼/background-image 数据外带的 CSS 注入面，代价为内嵌 style 间距失效 |
| fix | prd-api | 知识库替换文件为无可提取正文（图片/音频/扫描 PDF）时，把该条目下非全文划词评论批量置为 Orphaned，避免旧锚点评论变孤儿仍按 Active 高亮（全文评论保持 Active 不动） |
| fix | prd-api | 知识库访问去重窗口改用滚动 LastSeenAt（旧行回退 EnteredAt）而非原始 EnteredAt，长会话多次刷新不再因首次进入时间超窗误判为新访问导致 ViewCount 虚增 |
| fix | prd-admin | 知识库搜索修复竞态：在途搜索响应回来时仅当仍是最新关键词才采纳，否则丢弃；清空搜索框立即回到本地全量树，不再残留上一次扁平搜索结果 |
| fix | prd-admin | 修复 MarkdownViewer 重渲染复用有状态 slugger 致 heading id 漂移、TOC/锚点失配（每次渲染前 reset） |
| fix | prd-admin | 知识库替换当前选中文件后预览不刷新：DocBrowser 内容加载缓存键由 entryId 改为 entryId+updatedAt（内容版本），替换后 updatedAt 变化自动重载新正文，移除 undefined→id 的 setTimeout hack；不影响 useViewTracking 埋点（仍以 entryId 为键） |
| fix | prd-api | 知识库替换文件清理旧 Attachment/ParsedPrd DB 记录，避免每次替换都把上一版正文与附件记录变成永久孤儿（与 DeleteEntry 一致只删 DB 记录、不动共享 blob；CT.None + try/catch 尽力而为，清理失败不影响替换主流程） |
| fix | prd-admin | 划词选区 offset 基于剥离 frontmatter 的正文解析（修复标题等同时出现在 frontmatter 时锚点错位）+ 搜索陈旧响应/异常时 spinner 兜底解除 |
| fix | prd-api | 知识库全文评论：图片/音频/扫描PDF/被无文本文件替换过的条目（DocumentId 为空）此前被"该条目尚未关联正文"400 拦截无法评论；改为仅有锚点评论才强制要求正文，全文评论允许 DocumentId 为空（ContentHash 跳过算并存 null、DocumentId 存 string.Empty） |
| fix | prd-admin | 修复含转义尖括号标题（如 `# Use &lt;T&gt; generics`）rendered 侧 slug 被 HTML 标签剥离正则误删致与 TOC 不一致：headingTextToSlug 增加 alreadyRendered 参数，rendered 路径跳过剥标签/解实体，两侧共用同一 normalize+slugger（SSOT） |
| fix | prd-api | 知识库划词评论 rebind/orphan 过滤由 `!c.IsWholeDocument`（LINQ 译为 `{IsWholeDocument:false}`）改为 `Filter.Ne(IsWholeDocument,true)`，覆盖缺该新增字段的历史评论（false/null/缺字段三态），不再静默漏掉旧评论 |
| fix | prd-admin | 知识库 TOC 切换文档时 activeId 由 `prev ?? 首项` 惰性保留改为重置为新文档首个 heading id，消除切文档高亮闪烁/停在上一篇标题 |
| fix | prd-admin | 修复划词选区 offset 三级回退 step3 的 endOffset 用 strippedText.length（已剥 markdown 标记，偏短甚至越界）：改为优先末词在 raw 中的位置+末词长度，兜底原始可见文本长度，并 clamp 到 [startOffset, raw.length] |
| fix | prd-admin | 知识库正文 sanitize schema 进一步移除对所有元素的 className 放行（仅保留 id 与 KaTeX math 属性），堵住公开知识库经 rehypeRaw 用上传 HTML 携带应用 Tailwind/工具类（fixed inset-0/高 z-index/背景类）伪装或覆盖应用 UI 的钓鱼面；rehypeKatex 在 sanitize 之后运行故数学公式渲染不受影响，正文 markdown class 由 React renderer 赋予同样不受影响 |
| fix | prd-api | 知识库访客离开补写时长改用聚合管道更新（$set + $add + $ifNull）替代 .Inc：历史 view event 文档 DurationMs 可能为 null，对 null 执行 $inc 会报错且经 sendBeacon 调用错误被静默吞致丢时长，$ifNull 视 null 为 0 后累加，旧 null 行也能正确累计 |
| fix | prd-admin | 知识库本地搜索（searchResults 为 null）时「内容包含」标记回退仅迭代根级条目致文件夹内嵌套文件永远拿不到标记：回退集合扩展为 filteredRoots + filteredChildrenMap 所有展开子项，对全部可见条目统一判定，不影响后端搜索结果模式既有行为 |
| fix | prd-admin | 知识库标题闭合式 ATX（`## 标题 ##`）下右侧 TOC 与左侧栏展示文本不一致：抽出共享 parseAtxHeadingLine（SSOT，尾部 `#` 串需前置空白才剥离），markdownToc 与 frontmatter 复用同一函数；`## C# 入门` 等紧贴字母的 `#` 不误删 |
| fix | prd-admin | 知识库编辑当前文档时被左侧"替换文件"覆盖后未退出编辑态致保存会用旧文本覆盖新内容：DocBrowser 监听内容版本键，仅当同一 entry 的 updatedAt 变化（替换/外部更新）时强制 setEditMode(false)+清 editContent，切换文件/正常编辑路径不受影响 |
| fix | prd-api | 知识库替换文件清理旧 ParsedPrd 前增加引用计数守卫：ParsedPrd.Id 由内容哈希派生，解析正文相同的多条目共享同一 DocumentId，原无条件删除会令另一指向它的条目正文/预览全丢；改为仅当无其它 DocumentEntry 仍引用该 DocumentId 才删（Attachment 经 grep 确认上传/替换每次新建独立记录、条目独占，保持直接删并注释依据） |
| fix | prd-admin | 知识库文档正文支持内嵌 HTML 渲染（rehype-raw + sanitize 防 XSS） |
| fix | prd-api | 修复划词评论/访客记录因 User.Id 序列化报错导致"添加失败"与登录用户显示匿名 |
| feat | prd-admin | 知识库文档新增"替换文件"功能，原地替换内容保留标签/主文档/置顶/位置 |
| feat | prd-api | 新增 POST /api/document-store/entries/{id}/replace 原地替换条目文件端点 |
| feat | prd-admin | 作品广场列数随屏宽动态自适应（标准屏5列，带鱼屏6-7列防卡片过大，小屏降至3/2列） |
| feat | prd-admin | 作品广场新增创作者头像筛选行，点击头像只看该创作者作品，切类型标签自动刷新 |
| feat | prd-admin | 作品广场增强极光渐变动效背景（柔和漂移+呼吸，支持 prefers-reduced-motion 降级） |
| feat | prd-api | 投稿 public 列表支持 ownerUserId 过滤 + 新增 public/creators 聚合接口 |
| fix | prd-admin | 创作者头像行隐藏老土滚动条（保留滚动），首页区块移除有色极光背景 |
| fix | prd-admin | 前三名创作者改用金/银/铜彩色光圈（替代看不清的小皇冠） |
| perf | prd-admin | 作品广场封面图视口懒挂载（IntersectionObserver，未滚动到的卡片零请求）+ 首屏批量缩小（首页20→12 / showcase 24→18）+ decoding=async，大幅降低首屏流量 |
| fix | prd-admin | fetchCreators 增加请求令牌防竞态，快速切 tab 时旧创作者响应不再覆盖新 tab |
| fix | prd-admin | 全部 tab 下选中创作者无作品时补空状态提示（避免空白区）；LiteraryCard 复用 waterfall.ts 的 getAspectRatio 消除重复 |
| fix | prd-admin | useWaterfallColumns 改回调 ref + 测量内容盒宽度（扣除 padding，修复带 padding 容器多算一列；条件 remount 后 ResizeObserver 重新挂载） |
| fix | prd-admin | PortfolioShowcasePage 筛选无结果时改显「没有符合条件的作品」+ 查看全部，不再误导用户去创作 |
| refactor | prd-admin | 抽取 useCreatorFilter 共享 hook，消除两个作品广场组件重复的创作者筛选状态/竞态逻辑 |
| feat | prd-admin | 网页托管：来源/排序筛选下拉改用统一 Select 组件，告别原始原生 select |
| feat | prd-admin | 网页托管：拖文件到站点卡片显示"替换此网页"提示，松手后二次确认再覆盖 |
| feat | prd-admin | 网页托管：分享链接复用已有未吊销同类型链接（无密码/有密码各一条），吊销后才重新生成，分享统一走数字短链 |
| refactor | prd-admin | 网页托管：移除卡片"访问"按钮，访问统一走无密码分享链接的字母 token 地址 /s/wp/{token}（与分享数字短链 /s/{seq} 彻底分开、判断独立），来源标签仅非手动上传时展示 |
| fix | prd-admin | 网页托管：分享/访问链接复用尊重所选有效期，复用链接寿命不得超出所选窗口；访问链接仅复用永不过期链接，杜绝过期后 404 |
| fix | prd-api | 网页托管：分享链接「复用 vs 新建 + 有效期刷新」下沉到服务端 CreateShareAsync 单一闭环，不再依赖前端分页列表（杜绝链接数超分页上限后去重失效）；复用时有效期刷新为本次所选窗口，既不"开盖即废"也不超出所选 |
| fix | prd-admin | 网页托管：替换网页 reuploadSite 加 try/catch/finally，网络异常不再永久锁死弹窗按钮；列表视图访问地址与网格视图统一走 /s/wp/{token} |
| fix | prd-api | 网页托管：分享链接新增 Purpose 字段（share/visit），访问便捷链与用户分享物理隔离——访问流程不再复用/篡改用户主动创建的限期分享，visit 链不进分享管理列表；旧记录无字段按 share 兼容 |
| fix | prd-api | 网页托管：复用判定排除已过期链接，杜绝"新建分享复活旧过期 token、持旧 URL 者重获访问权"的安全隐患 |
| fix | prd-api | 网页托管：复用带密码分享时按新密码轮换（旧密码失效），不再静默丢弃用户重设的密码 |
| fix | prd-api | 网页托管：visit 便捷链不再分配可枚举数字短链 /s/{seq}，杜绝攻击者枚举数字访问从未主动分享的私有站点（P1 安全） |
| fix | prd-api | 网页托管：复用分享时同步刷新标题/描述，站点改名或传新 title/description 后不再展示陈旧元数据 |
| refactor | prd-api | 网页托管：ZIP 过滤/计数/限额逻辑抽成单一 PlanZipEntries，ValidateZip 与 ExtractAndUploadZip 共用，结构上保证「校验通过⇔上传成功」不漂移 |
| fix | prd-admin | 网页托管：扫码访问 QrCodeDialog 改走 resolveVisitUrl（visit 隔离池），不再扫 listSiteShares、不再把用户限期分享的有效期覆盖成永久 |
| fix | prd-admin | 网页托管：ShareDialog 创建分享补 catch + 失败 toast，网络异常/后端失败不再静默无反馈 |
| fix | prd-api | 网页托管：重传替换改为「内存校验通过后才写入稳定 siteId 前缀」，畸形/超限 zip 失败时零副作用——旧文件不被覆盖、SiteUrl 不变（既有书签/引用不 404）、无 staging 孤儿残留（P1+P2） |
| fix | prd-admin | 网页托管：卡片操作按钮 hover 显示手型光标，提示可点击 |

### 2026-05-15

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 修复 shared-service 实例发现混入分支服务的问题 |
| fix | cds | shared-service 项目统计不再汇总分支预览容器 |
| fix | cds-web | shared-service 项目卡片跳转到系统远程主机设置而非分支列表 |
| docs | doc | 新增 CDS Agent 运行时架构设计说明 |
| feat | prd-admin | CDS Agent 页新增简洁/专业双模式切换，简洁模式三栏（任务列表/对话/产物），工具调用渲染为中文动作，默认简洁、sessionStorage 记忆，专业模式 JSX 零改动 |
| feat | prd-admin | CDS Agent 简洁模式对话改为消息+事件按时间合并的单一时间线（旧上新下、自动滚底），连续过程事件折叠进「执行过程」块（步数+用时，默认收起，含待审批时强制展开） |
| fix | prd-admin | CDS Agent 发送后清空输入框（修复文本残留），运行中每 3s 自动轮询刷新（消除空白等待），底部显示「Agent 正在执行…已等待 Xs」 |
| feat | prd-admin | CDS Agent 简洁模式右栏新增 Git/PR 上下文卡片（分支/提交/PR 链接）+ 一键生成产物；左侧任务按运行中/已完成分组并加活动指示点；最新 Agent 回复用 StreamingText 流式打字 |
| fix | cds skills | 修正 SKILL.md 中 7 处与真实 cdscli parser 不符的命令示例（Codex review #619 发现）：cds 删除不存在的 key create；cds-deploy-pipeline 修正 project list --human 全局选项位置、branch exec 补 --profile、branch deploy 去掉不支持的 --profile、branch stop/delete 改为 API 直调、branch pull 改为 deploy 内置说明 |
| refactor | cds skills | 三个 CDS 技能按冷/热/核心三层重新定位：cds-project-scan (冷)、cds-deploy-pipeline (热)、cds (核心+分诊器)，触发词域无交集，按 Anthropic 官方最佳实践重写 description (third person + what+when + 反向排除) |
| refactor | cds skills | SKILL.md 总行数从 1755 行降到 498 行 (-71%)，cds-deploy-pipeline 从 930 行远超 500 行红线降到 175 行 |
| chore | cds-deploy-pipeline | 删除陈旧 495 行 cdscli.py stub，三技能共享 cds/cli/cdscli.py 单一物理拷贝 |
| docs | doc/ | 新增 rule.skill-trigger-disambiguation 锁定同族技能去重规则 (动词+方向词 / 反向排除 / slash 一一对应 / 歧义反问 / 物理去重) |

### 2026-05-14

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | CDS Agent 会话新增只读产物采集接口，自动记录仓库状态、diff 和文件树事件 |
| feat | prd-admin | CDS Agent 工作台产物面板新增生成只读产物操作，模型不可用时也可查看仓库可观测信息 |
| fix | prd-admin | 动态 chunk 失效时自动刷新一次，避免部署后旧页面切路由直接停在错误边界 |
| feat | prd-api | CDS Agent 会话新增只读检查接口，固定运行 git status 与 diff stat 并记录命令结果 |
| feat | prd-admin | CDS Agent 产物面板新增运行只读检查按钮，展示命令退出码和输出 |
| fix | prd-admin | CDS Agent 产物动作改为独立按钮区，避免窄面板隐藏只读检查入口 |
| feat | prd-admin | 工作流舱目录补齐 CDS Agent 节点入口，并清理工作流页面可见 emoji |
| fix | prd-admin | 工作流列表、模板和执行历史清理历史 emoji 文案，旧工作流图标自动降级为文本标识 |
| fix | prd-api | 修复 CDS Agent 会话把探活失败误当授权失效的问题，系统级长期授权仅在明确撤销后阻断 |
| fix | prd-api | 修复 CDS Agent 启动时模型配置解密失败不回写会话失败态的问题 |
| fix | prd-admin | 修复 CDS Agent 页面请求失败后按钮长期卡在 loading 且错误不回灌的问题 |
| fix | prd-admin | 在 CDS Agent 模型配置下拉框中标识 API key 无法读取的配置，提示重新保存 |
| fix | prd-admin | CDS Agent 模型配置不可用时禁用新建、启动和发送入口，并直接引导重新保存 API key |
| feat | prd-admin | CDS Agent 会话列表新增搜索与归档入口，运行中会话需停止后才能归档 |
| feat | prd-api | 新增 CDS Agent 会话归档接口，默认列表隐藏已归档会话 |
| feat | cds | 新增 CDS Agent session 最小生命周期与 fake runtime stream 接口 |
| feat | prd-api | 接入 CDS Agent session start/send/stream/logs/tool approval 代理能力 |
| feat | prd-admin | 基础设施服务页新增 CDS Agent 测试台，支持会话、消息、事件和日志查看 |
| fix | prd-api | 后台 CDS sidecar discovery 解密 longToken 失败时不再把刚授权连接误标为 revoked |
| test | prd-api | 同步 DynamicSidecarRegistryTests fake 连接服务签名，覆盖 solution 编译路径 |
| fix | prd-api | CDS paired sidecar 自动发现改为显式开关，默认不读取基础设施连接凭据 |
| fix | prd-api | longToken 解密读取失败不再自动撤销 CDS 连接，连接状态仅由显式探活或授权流程更新 |
| fix | prd-api | CDS 授权完成和近期探活成功作为连接可用性依据，避免异步状态写入阻断 Agent 会话创建 |
| fix | cds | auth 中间件放行 MAP/CDS longToken 调用项目级 agent-sessions 路由，避免 start/send 被全局 AI key 校验拦截 |
| fix | prd-api | start/send/stop 共用连接检查同步近期健康判断，避免创建成功后启动仍被误判不可用 |
| fix | prd-api/cds | CDS Agent fake runtime 补日志事件，MAP 日志读取失败时返回可见诊断快照而非 502 |
| feat | prd-api/prd-admin | 新增 CDS Agent Hook profile API、启动/停止 hook 事件和新建会话配置弹窗 |
| fix | prd-api/cds | 修复 CDS stream 事件序号错位导致工具调用未导入的问题，并补齐危险工具等待审批事件 |
| feat | prd-admin | CDS Agent 工作台工具事件和日志支持复制，并标记危险工具审批提示 |
| feat | prd-api | CDS Agent 增加系统级模型运行配置、长效授权会话启动、真实 Claude SDK sidecar 事件接入、AI 百宝箱和工作流舱调用入口 |
| feat | prd-admin | 新增 CDS Agent 独立用户页面，并在基础设施服务页增加模型运行配置和 Agent 操作台 |
| feat | cds | CDS 配对 long token 调整为系统级长期授权，并在 agent session 中接收 runtime profile、baseUrl、model 和凭据状态 |
| feat | cds | CDS compose 增加 claude-sidecar runtime 服务，并让 MAP API 在 CDS 环境默认路由到 sidecar 容器 |
| fix | prd-api | 修复 CDS 授权回跳地址，回到设置页基础设施服务入口完成连接建立 |
| fix | prd-api | 修复 CDS Agent 模型密钥解密失败时启动会话返回 500 的问题，改为提示重新保存配置 |
| fix | prd-api | 修复历史 CDS 授权密文失效后仍显示已连接、重复授权被旧连接阻塞的问题 |
| fix | prd-api | CDS Agent 发送消息遇到模型上游失败时写入会话失败事件，不再只返回 502 toast |
| fix | prd-api | CDS Agent 日志接口不可用时回退展示本地持久化事件，并向 sidecar 暴露已注册安全工具 |
| feat | prd-api | CDS Agent 新增仓库工具，支持远程 sidecar 读取文件、搜索、写入、运行命令并限制工作目录逃逸 |
| feat | prd-api | CDS Agent sidecar 工具调用改为先等待 MAP 审批再执行，危险仓库工具不得绕过用户确认 |
| feat | prd-api | CDS Agent runtime profile 增加模型连通性测试接口，使用已保存密钥验证 baseUrl/model 是否真的可用 |
| feat | prd-admin | 基础设施服务页展示 CDS Agent 内置仓库工具，并把默认任务调整为 prd_agent 巡检场景 |
| feat | prd-admin | CDS Agent 对话页增加工具调用和命令结果专属渲染，展示 exitCode、stdout、stderr |
| feat | prd-admin | CDS Agent 对话页增加“测试模型”按钮，保存配置后可直接看到上游 HTTP 状态、耗时和错误详情 |
| feat | prd-admin | CDS Agent 对话页增加新模型配置表单，用户可在同一页面保存任意 baseUrl、model 和 API key |
| fix | cds | CDS Agent claude-sdk 会话不再显示 fake worker，也不再向真实 runtime 混入 fake 文本 |
| fix | cds | 为 MAP API 增加 DataProtection 持久化 volume，并修正 CDS 内部 sidecar 与 callback 服务地址 |
| fix | cds | 将 MAP API 的 NuGet 缓存挂载改为项目相对目录，避开只读宿主机缓存路径导致的部署失败，并保留原 DataProtection key volume |
| fix | cds | 将 CDS Agent workspace 挂载为可写 `/repo`，使远程仓库工具具备最小代码巡检和改动能力 |
| docs | doc | 补齐 CDS Agent 用户指南、管理员指南、API 契约、运行手册与完全可用路线计划 |
| feat | prd-api | CDS Agent 新增只读 git status 和 diff 工具，远程 sidecar 可查看分支、变更状态和文本 diff |
| feat | prd-admin | CDS Agent 事件卡片支持渲染 git status、diff stat 和文本 diff，便于巡检代码变更 |
| feat | prd-api | CDS Agent runtime profile 增加协议字段，模型测试支持 Anthropic Messages 与 OpenAI-compatible Chat Completions |
| feat | prd-admin | CDS Agent 模型配置表单增加协议选择，保存和测试时明确显示 Anthropic 或 OpenAI-compatible |
| feat | cds | Claude SDK sidecar 增加 OpenAI-compatible 流式 chat/completions 循环，支持工具调用与审批回调 |
| feat | prd-api | CDS Agent 新增 Bridge 页面工具，支持远程读取预览页状态并经审批执行点击、输入、滚动和导航 |
| feat | prd-admin | CDS Agent 对话页增加 Bridge 页面状态事件渲染，基础设施页展示远程页面操作工具 |
| feat | prd-admin | CDS Agent 对话页增加产物面板，自动汇总文件树、diff、命令输出、浏览器快照和运行日志，并支持复制与下载 |
| feat | prd-api | CDS Agent 会话和事件增加统一 traceId，支持按同一次远程执行串联排查 |
| feat | prd-admin | CDS Agent 页面和基础设施操作台展示 traceId，便于定位远程会话事件链路 |
| fix | cds | 将 DataProtection key ring 改为写入 `/repo/.cds-data`，修复 CDS 将附加 volume 映射到只读 cache 目录导致 API 容器部署失败 |
| fix | cds | 为 MAP API profile 增加 `/health` readiness probe，避免根路径 404 导致 CDS 误判 api 一直 starting |
| feat | prd-admin | 将 CDS Agent 注册到百宝箱内置智能体入口，用户可从智能体页进入远程 sandbox 工作台 |
| fix | prd-admin | 打磨 CDS Agent 模型配置和会话列表显示，明确长期系统级授权、任意 baseUrl/model 配置和失败原因 |
| fix | prd-admin | 修复百宝箱点击 CDS Agent 后地址变化但页面仍停留在百宝箱的问题，入口跳转改为强制到工作台 |
| feat | prd-api | CDS Agent runtime profile 支持从 MAP 系统主模型同步 baseUrl、model 和加密 API key，减少重复配置 |
| feat | prd-admin | CDS Agent 页面增加“从系统主模型同步”按钮，可一键生成默认远程 runtime 配置 |
| fix | cds | 将 MAP Admin 主分支预览默认改为静态 build+serve，避免 Vite HMR 特殊路径在 CDS 代理下黑屏 |
| fix | prd-admin | 移除 public 中指向仓库根目录的第三方参考 symlink，修复 CDS admin 容器静态构建失败 |
| fix | cds | 修正 MAP Admin 静态服务监听参数，兼容 `serve` 的 TCP endpoint 写法 |
| feat | prd-api | 工作流执行、百宝箱运行和 CDS Agent 会话贯通 traceId，审批事件可按同一链路审计 |
| feat | prd-admin | 工作流执行历史和详情页展示 traceId，便于从页面定位远程 Agent 会话 |
| fix | prd-api | 工作流执行 BSON 映射忽略额外字段，避免滚动部署期间新增 traceId 被旧 worker 反序列化失败 |
| fix | prd-api | CDS Agent paired sidecar 工具回调改用 MAP 公网地址，并净化远程模型输出中的符号内容 |
| fix | prd-api | CDS Agent 仓库工具在 release 容器中自动修复断开的 Git worktree 元数据，确保 status/diff/PR 工具可用 |
| fix | cds | MAP API 容器注入 Agent workspace 仓库名和分支，供远程仓库工具按部署分支恢复 Git 上下文 |
| fix | prd-api | CDS Agent 后台 worker 无请求上下文时按 CDS 分支和仓库推导公网回调地址，修复智能体链路工具回调失败 |
| fix | prd-api | CDS Agent 对巡检和 PR 类长任务提高 sidecar 最大回合数，避免真实巡检在提交 PR 前提前中断 |
| fix | prd-api | AI 百宝箱队列按项目和分支隔离，避免旧预览 worker 抢消费 CDS Agent 长任务 |
| fix | prd-api | CDS Agent 在 CDS 未注入仓库环境变量时从 Agent workspace 兜底推导公网回调地址，避免 shared sidecar 工具审批回调走项目内 DNS |
| feat | cds | 项目设置新增「运行生命周期」面板：「运行满 N 分钟自动切发布版」「运行满 N 分钟自动停止」两个独立开关，默认关闭、可配置 1~1440 分钟；以容器进入 running 时打的 lastReadyAt 戳为计时锚点（HTTP 流量不参与刷新），新增 AutoLifecycleService 30s tick。auto-publish 全自动「停源码→重建发布版」（先后替换，无需人工）——复用内部 /deploy 自调（走 resolveEffectiveProfile，不动懒唤醒热路径），失败回滚 override；auto-stop 到点停容器回收 |
| feat | cds | BranchEntry 新增 lastReadyAt 字段（reconcileBranchStatus 在状态切到 running 时打戳），供项目级生命周期调度使用 |
| feat | cds | 卡片「发布版」徽章改为真实态：ServiceState 新增 deployedMode（容器实际启动那刻钉的 deploy mode），summarizeBranchDeployRuntime 改为按运行真相判定 + pendingPublish 标记；配置已切发布版但容器没跟上时显示橙色「发布版·待生效」，杜绝设了 override 就亮绿误导。branchAutoPublishConverged 同步改为按真相收敛（redeploy 静默失败不再误判收敛） |
| fix | cds | 远端执行器重部署传 resolveEffectiveProfile 结果（compute-then-send），修 cluster 下 auto-publish 因 proxyDeployToExecutor 发裸 profile、override 丢失而静默 no-op；graceful shutdown 补 autoLifecycleService.stop()；auto-publish 重部署 SSE 读取加 20min 总超时防全局调度瘫痪 |
| feat | cds | GitHub Webhook 日志 ring buffer 上限从 200 提升到 1000；分支抽屉的 Webhook 日志 tab 支持「加载更早 20 条」分页（每页 20，累计可读到全部 1000） |
| feat | cds | 分支抽屉「部署」tab 重排版面：容器日志作为一等公民提到顶部（宽屏左、窄屏上），阶段树退居次位（宽屏右、窄屏下）；容器日志面板支持多容器 tab 切换 + 一键最大化（跳到「日志 → 容器日志」） |
| docs | cds | 新增 doc/debt.cds-state-json.md 登记 state.json 影子存储债务，规划 4 阶段拆分到 mongo collection |
| fix | cds | 「项目默认运行模式」语义明确为"仅建分支时拷贝一次"（保留旧 UI 承诺「不改已有分支」）：applyProjectDefaultDeployModes 建分支时把项目默认写进 branch.profileOverrides，resolveEffectiveProfile 运行期只认分支 override + baseline，不做实时回退。原方案的实时回退层因会回溯改已有分支、与 UI/类型注释承诺矛盾（Codex P1）按用户决策回退 |
| feat | cds | BranchEntry 新增 lastStoppedAt / lastStopReason / lastStopSource 字段，用户主动停止、调度器空闲降温/容量驱逐、远端执行器停止三类路径均写入；分支抽屉与详情页展示"上次停止时间 + 原因 + 来源"以解释"分支变灰"现象 |
| feat | cds | 项目环境变量待补全横幅新增「我知道了」按钮，弹窗提示去「项目设置 → 环境变量」补填，sessionStorage 按 pendingEnvKeys 指纹关闭，新增缺失变量时横幅自动复活 |
| feat | cds | 分支卡片标题行徽章从来源（Webhook/手动/待配置）切换为运行模式（发布版/源码/混合），与抽屉「本分支运行模式」视觉对齐；原来源徽章降级到正文 chip 行 |
| fix | cds | 调整预览分支静态资源缓存策略，避免最新提交页脚与旧前端 chunk 混用 |
| fix | prd-admin | 为生产静态服务补充资源缓存配置，避免预览页继续使用旧构建 chunk |
| fix | prd-admin | 前端构建产物文件名加入构建 ID，避免同名 chunk 被浏览器或边缘缓存复用 |
| fix | prd-admin | 远端构建显式注入构建 ID，避免无 git 环境下退回固定资源名 |
| feat | prd-api | 为 CDS Agent 会话新增消息列表 API，支持对话页恢复用户与 Agent 消息 |
| feat | prd-admin | CDS Agent 独立页新增对话 transcript 区，区分多轮消息与事件时间线 |
| feat | prd-api | 新增远程仓库 PR 创建工具，允许 CDS Agent 在审批后提交分支并创建 GitHub PR |
| fix | prd-admin | CDS Agent 会话按钮按状态显示启动、重试和继续，避免失败会话直接发送到旧 runtime |
| fix | prd-api | CDS Bridge 远程导航默认拦截 localhost、内网、链路本地和 metadata 地址 |
| feat | prd-admin | CDS Agent 事件时间线新增回放模式，支持按步骤复盘远程执行事件 |
| feat | prd-api | CDS Agent 系统级模型配置支持覆盖更新，避免重复创建临时配置 |
| feat | prd-admin | CDS Agent 页面新增更新当前模型配置入口，重新保存 API key 后长期复用 |
| feat | prd-admin | CDS Agent 工作台新增会话、失败、事件、工具和产物指标条，提升运行可观测性 |
| feat | prd-admin | CDS Agent 工作台新增审计摘要，展示会话用户、连接、模型配置、工具策略和凭据暴露状态 |
| feat | prd-api | CDS Agent 新增事件 schema 清单接口，稳定 status/text/tool/log/error/done/hook/file/diff/browser 事件契约 |
| feat | prd-admin | CDS Agent 审计摘要展示当前会话事件类型覆盖，便于工作流和智能体消费事件 |
| feat | prd-admin | CDS Agent 对话输入区新增文件路径、网页地址、项目文档和知识库上下文入口 |
| feat | prd-api | CDS Agent 会话新增人工接管状态和人工输入接口，暂停自动发送时仍可持久化操作记录 |
| feat | prd-admin | CDS Agent 工作台新增人工接管面板，支持暂停 Agent、记录人工输入并继续工具审批 |
| feat | prd-api | CDS Agent 模型配置新增 CPU、内存、超时、网络策略和自动清理资源边界并固化到会话 |
| feat | cds | CDS Agent 会话记录 MAP 下发的资源策略，并在事件、日志和会话视图中返回 |
| feat | prd-admin | CDS Agent 模型配置表单新增资源边界设置，并在审计摘要中展示会话固化策略 |
| feat | prd-api | CDS Agent 停止会话时新增 stopping 中间态和状态事件，便于刷新恢复与审计 |
| feat | cds | CDS Agent 停止接口补充 stopping 状态事件和日志，与 MAP 会话状态机对齐 |
| fix | prd-api | CDS Agent 停止会话接口补齐业务异常映射，避免授权撤销等失败被包装成 500 |
| feat | prd-admin | CDS Agent 工作台展示远程页面安全边界和 Bridge 工具拦截规则 |
| feat | prd-admin | CDS Agent 工作台展示 Git 状态、diff 和创建 PR 工具的审批规则 |
| feat | prd-api | 工作流运行器将 CDS Agent 节点纳入长任务事件透传，运行页可收到远程会话阶段事件 |
| feat | prd-api | CDS Agent 智能体执行器改为边执行边输出阶段事件，并回填事件时间线与运行日志产物 |
| fix | prd-api | 统一 CDS 连接有效状态判断，避免列表显示可用但会话创建仍按已撤销拒绝 |
| fix | prd-api | CDS Agent 运行配置读取忽略未知字段，避免历史/未来配置字段阻断智能体执行 |
| fix | prd-api | CDS Agent 智能体执行器在远程会话失败时保留日志产物并将 run 标记为失败 |
| fix | prd-api | CDS Agent 智能体执行器复用系统运行配置服务读取默认模型，避免绕过服务层触发 BSON 兼容问题 |
| fix | prd-api | CDS Agent 智能体执行器增加运行配置 BSON 兜底读取，保证历史字段异常时仍能继续远程会话链路 |
| fix | prd-api | CDS Agent 智能体执行器在创建远程会话前输出配置解析阶段并包装早期失败原因 |
| feat | prd-api | 百宝箱 run 在每个步骤开始后输出实际调度的智能体适配器名称，便于远程执行诊断 |
| fix | prd-api | PRD Agent API 的 DataProtection key ring 改存 MongoDB，避免系统级 CDS 长期授权在容器重建后失效 |
| fix | cds | CDS 连接 accept 回调改为一次性 pairing token 鉴权路径，避免 MAP 粘贴授权被 CDS 登录态拦截 |
| fix | prd-api | 百宝箱 CDS Agent 执行队列切到 v2，避免旧预览 worker 抢消费后提示未找到 cds-agent |
| feat | cds | CDS shared-service 实例发现支持返回分支服务 baseUrl，用于系统级 sidecar pool |
| feat | prd-api | CDS Agent sidecar 改为通过长期授权连接动态发现系统级 sidecar pool |
| fix | prd-api | Agent 工具回调鉴权接受 CDS 系统级 sidecar pool 的共享 token |
| fix | cds | 系统级 sidecar 实例发现兼容 CDS 前缀域名环境变量，避免 MAP 回退到不可达容器名 |
| fix | prd-api | 模型平台列表区分 API key 缺失、不可读和已配置，避免空密钥显示为已保存 |
| fix | prd-admin | 模型平台 API key 输入框按真实密钥状态显示重新保存提示 |
| feat | prd-api | CDS Agent 会话新增远程页面快照动作，可用长期 CDS 授权调用 Bridge 并写入浏览器产物事件 |
| feat | prd-admin | CDS Agent 产物面板新增读取页面快照按钮和 CDS 分支输入，便于无模型 key 时验证远程 Web 操作 |
| fix | cds | Bridge API 接受 MAP/CDS 系统连接 long token 的 instance:read 授权，避免远程页面快照被 401 阻断 |
| feat | prd-api | CDS Agent 会话新增远程页面动作接口，可从 MAP 触发 Bridge click/type/scroll/navigate/evaluate 并沉淀 browser 事件 |
| feat | prd-admin | CDS Agent 产物面板新增远程页面动作控件，支持最终用户从页面执行 Bridge 操作并观察结果 |
| feat | prd-api | CDS Agent 会话新增危险工具审批卡创建接口，用于验证审批刷新恢复和审计结果 |
| feat | prd-admin | CDS Agent 事件时间线新增生成审批卡按钮，便于最终用户测试允许/拒绝流程 |
| fix | prd-api | CDS 长期授权连接的有效性改按 long token 生命周期判断，避免成功探活后超过 10 分钟又显示已撤销 |
| feat | prd-api | 工作流 CDS Agent 节点新增危险工具审批暂停模式，继续执行时自动写入审批结果并恢复下游节点 |
| feat | prd-admin | 工作流列表新增执行历史入口，并补齐暂停状态筛选、徽标和节点进度展示 |
| fix | prd-admin | 修复周报海报列表摘要与详情类型混用导致前端类型检查失败 |
| fix | prd-admin | 工作流执行详情历史日志正确显示暂停状态，避免误报为取消 |
| fix | prd-admin | 工作流继续执行后立即刷新历史日志，确保完成状态与日志一致 |
| feat | .claude | 新增老王智能体技能（laowang），用米多解决问题五步法主动拆解困境任务，副作用：50% 概率追加延伸任务 |
| fix | prd-api | 网页托管分享 PDF 时后端额外返回 pdfAssetUrl 直链，避免前端走「壳子 + 嵌套 iframe」结构 |
| fix | prd-admin | ShareViewPage 检测到 PDF 包装站时直接 iframe 真实 PDF 链接（移除 sandbox），让浏览器原生 PDF Viewer 接管，修复 Chrome「此页面已被 Chrome 屏蔽」 |
| fix | prd-admin | 网页托管 PDF 站点卡片改用 PDF 设计占位（红色 PDF 徽记 + 大小标签），不再走嵌套 iframe 导致空白破图 |
| fix | prd-api | PublicProfile API 新增 isPdfWrapper / totalSize 字段，前端可识别 PDF 包装站 |
| fix | prd-admin | 公开个人页 PDF 站点卡片同步走 PdfThumbnail 占位；PdfThumbnail 接口改为接收 sizeBytes，解耦 HostedSite 类型依赖 |
| fix | prd-api | HostedSite 加 WrappedAssetType marker，CreateFromZipAsync 接收并持久化；PDF 包装站识别只看 marker 不看 ZIP 文件形状，避免误判用户上传的"index.html + .pdf"两文件 ZIP（Codex P2 #612） |
| fix | prd-admin | isPdfSite 改读后端 wrappedAssetType marker；HostedSite 类型加 wrappedAssetType 字段 |
| test | prd-api | 补 LongTokenExpiresAt 让 HasRecentHealthyProbe 测试跟上 main 871ab45 改动 |
| fix | prd-api | 收紧 PDF 包装站识别条件（entry=index.html + 恰好2文件 + 一个 index.html + 一个根目录 .pdf），避免把含 PDF 子文件的正常 ZIP 站误判为包装站（Codex P2 #612） |
| fix | prd-admin | 前端 isPdfSite 同步严格匹配 wrapper 形状 |
| feat | prd-api | 产品评审员 Agent 新增「申诉」工作流：评审完成后 3 小时窗口内可发起申诉（富文本理由 + 图片粘贴上传），由持 `ReviewAgentAppealReview` 权限的管理员审理（通过/驳回 均需附 ≥5 字意见）。通过后允许提交人重新上传 md 触发新评审；排行榜通过率公式调整为「有效通过 / (有效通过 + 有效未通过)」，申诉成功的评审不计入分子分母 |
| feat | prd-api | `ReviewSubmission` 加 `AppealStatus / LatestAppealId / AppealResolvedAt` 三字段；新增 `review_appeals` 集合 + `ReviewAppeal` Model；新增权限 `review-agent.appeal-review`（默认所有角色不持有，需管理员显式分配） |
| feat | prd-api | `ReviewWebhookService` 新增 `NotifyAppealEventAsync` 支持 `appeal_submitted / appeal_approved / appeal_rejected` 三事件；新增图片上传端点 `POST /api/review-agent/appeals/upload-image`（5MB 上限，复用 `IAssetStorage`） |
| fix | prd-admin | 打磨工作流自动化入口文案，避免缩写符号挤压和重复按钮文本 |

### 2026-05-13

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 优化分支卡运行态文案和预览按钮样式，避免可预览分支被误解为部署未成功 |
| fix | cds | 将分支搜索命中提示改为稳定选中态，避免短暂闪烁后用户找不到目标卡片 |
| fix | cds | 分支列表首屏使用缓存态快速渲染，后台再同步 Docker 实时状态 |
| fix | cds | 分支列表首屏快路径跳过 worktree git log，进一步缩短首屏等待 |
| fix | cds | 扩大提交实时流记录点击热区，并为提交标签增加状态图标 |
| fix | cds | 优化提交实时流面板信息密度，折叠态显示最新分支与精确更新时间 |
| fix | cds | 优化分支提交通知面板的信息层级，突出分支、更新内容和更新时间 |
| fix | cds | 同步修复 forwarder 上游异常时模块资源请求误返回 HTML 等候页的风险 |
| fix | cds | forwarder 转发上游请求时剥离 hop-by-hop 头，恢复 keepalive 连接复用 |
| fix | cds | 提升浅色模式项目卡片图标对比度，并收窄提交实时流折叠态宽度 |
| fix | cds | 修正浅色模式部署状态面板网格背景过重的问题 |
| feat | prd-api | MAP 基础设施连接新增 CDS 地址授权流：start 生成跳转 URL，complete 用授权 code 换 longToken 并复用实例发现 |
| feat | cds | CDS 连接协议新增授权页与 token 端点，支持 MAP 跳转授权后回调建立 shared-service 连接 |
| fix | cds | CDS 授权码入口加入鉴权放行名单，避免生产 GitHub/basic 鉴权模式下授权页被 401 拦截 |
| feat | prd-admin | 基础设施服务页新增“输入 CDS 地址授权连接”，保留配对密钥粘贴作为兜底路径 |
| fix | prd-admin | 基础设施服务页说明文案改为 CDS 地址授权优先，避免视觉验收时仍显示旧配对密钥主流程 |
| fix | prd-admin | CDS 授权发起时以前端当前 origin 作为 MAP 地址，避免 CDS 授权页显示反代内网地址 |
| fix | prd-api | CDS 授权 start 接口接收并签名浏览器侧 MAP 地址，回跳地址不再从 API 内网 Host 推导 |
| fix | prd-admin | 设置页顶部 Tab 增加“基础设施服务”入口，避免只能通过直达路由访问 CDS 连接面板 |
| fix | cds | 实例发现接口识别 CDS 连接 long token，并校验 projectId 与 instance:read scope，修复 MAP 探测 401 |
| fix | prd-api | 持久化 DataProtection key ring，避免 CDS 授权凭据在 API 重启后无法解密 |
| fix | cds | 同一 MAP 重新授权时撤销旧 CDS 连接并旋转 long token，避免旧凭据失效后无法重连 |
| fix | prd-api | CDS 连接探活成功时恢复为已连接状态，避免“对端可达但已撤销”的矛盾显示 |
| fix | prd-admin | CDS 连接列表拆分可用连接与失效连接，避免已撤销连接继续出现在已建立列表并允许探活 |
| fix | cds | 将项目卡片 Nacos 单字母标识改为更清晰的 Na 专用标识 |
| fix | cds | 修复预览等待页误把模块资源请求返回为 HTML 导致 MIME 报错的问题 |
| fix | cds | 修复失败分支访问预览页会反复触发自动部署的问题，并同步失败服务与错误信息到分支卡片 |
| fix | cds | 统一分支页项目切换器显示口径，优先展示项目名并保留 slug 辅助识别 |
| fix | cds | 使用 React Bits ShinyText 优化左侧 CDS 标识，加入克制的银白扫光动效 |
| fix | cds | 统一 CDS 等待、错误和部署面板背景，接入 React Bits ShapeGrid 动效 |
| fix | cds | 将预览等待页接入 React Bits MagicRings 风格动效，并统一为 CDS 深色低饱和视觉 |
| fix | cds | 允许 pnpm 在非交互部署中构建 esbuild，修复新增前端依赖后的远端构建阻塞 |
| feat | prd-admin | 更新中心"历史发布"子 tab 重命名：CHANGELOG → 已发布；本周碎片 → 待发布；GitHub 日志 → 实时日志 |
| feat | prd-admin | "实时日志" tab icon 上叠加绿色呼吸点（animate-ping），强调内容近实时 |
| fix | prd-admin | ShareDock：移除 useDockDrag.onPointerDown 里无条件的 preventDefault，避免吞掉非按钮可点击子元素（如 `<h3 onClick>`）的 click 事件。文字框选保护改由 onMove 跨过 threshold 后 preventDefault + userSelect=none 双重兜底（Codex PR #598 review） |
| feat | prd-admin | 知识库：右键菜单新增"重命名"，弹窗修改文档条目标题（updateDocumentEntry 仅传 title） |
| fix | prd-admin | 知识库：网页托管转存进来的引用条目（无 attachment / document）预览不再显示"暂无可预览"，自动 iframe 嵌入 metadata.sourceUrl，顶部带"新窗口打开" |
| feat | prd-admin | 网页托管"转存到知识库"弹窗新增标题输入框，默认拿站点标题，转存前可改名 |
| fix | prd-admin | 网页托管：修复上一轮"hasLoadedOnceRef 设置时机过早导致首屏所有卡片被判为新增、全部播放滑入+光环动效"的回归。改用 baselineSettledRef 推迟一帧，确保首屏只记 baseline 不触发动效（Cursor Bugbot PR #598 review） |
| refactor | prd-admin | 网页托管：彻底重写"新上传卡片动效"机制 — 砍掉 sites diff，改为 onSaved 回调直接把新 site ID 推入 freshIds。修复 Cursor PR #598 review：筛选/排序变化误触发动效、首屏全部卡片误触发、首屏空时无动效等三个 diff 路径的连锁 bug |
| fix | prd-admin | 知识库：reference 类条目（转存自网页托管）右键菜单不再显示"再加工"，避免后端读不到正文必失败的误触 |
| fix | prd-api | 安全：BuildMarkdownWrapper 启用 Markdig `.DisableHtml()`，阻止用户上传的 .md 文件透传原始 `<script>` 块执行 XSS（Cursor PR #598 review） |
| fix | prd-api | 网页托管不支持类型错误消息补全：增加 .markdown / .m4v / .ogg / .ogv，与后端 VideoExtensions + MarkdownExtensions 实际接受范围一致 |
| fix | prd-admin | 修复右下角教程面板与通知卡重叠：TipsDrawer 广播 dock 高度，通知卡随 drawer 展开动态上移 |
| fix | prd-admin | 通知卡固定最小高度(minHeight:110px)并限制消息区高度(maxHeight:72px 可滚动)，防止批量点击时面板忽大忽小 |
| feat | prd-admin | 通知卡新增消息总量徽章（最大 999+）、一键全部处理、一键全部忽略三个操作 |
| fix | prd-admin | 修复打开应用时通知逐条弹出的无限循环：超时自动消失改为一次性批量 dismiss 全部 |
| feat | prd-admin | handleNotification 加乐观更新，点击按钮 count 即时 -1 不等接口返回 |
| fix | prd-admin | 按钮新增 active:scale + brightness 动效与 loading spinner，解决点击无反馈问题 |
| fix | prd-admin | 全局 count 徽章由 9+ 升级为 999+ 格式 |
| perf | prd-api | 周报海报列表接口排除 TranscriptCues 字段，响应从 5MB 降至预期 |
| fix | prd-admin | 海报页面侧边栏"已完成"状态改用实心 Check icon 替代文字 badge |
| fix | prd-admin | 海报设计页过滤 URL 污染的字面量 "undefined"/"null"，加载失败时清理 search param，避免反复 404 |
| fix | prd-api | autopilot SSE 流改用 Connection:close + Response.CompleteAsync，解决流结束后代理复用脏连接导致的 400 |
| fix | prd-api | 海报列表投影加兜底全量查询，防止 BsonSerializationException 被 ExceptionMiddleware 转为 400 |
| fix | prd-admin | refreshList 失败时 console.error 完整诊断信息，便于排查 400 根因 |
| fix | prd-api | autopilot SSE Emit 显式 camelCase 序列化（默认 JsonSerializer 是 PascalCase，导致前端 poster.id 为 undefined → ?id=undefined / 漏图 / 重复检测错误） |
| fix | prd-admin | autopilot onDone 显式校验 poster.id，缺失时报错并打印诊断信息 |
| fix | prd-api | autopilot ParseAccumulatedContent：PageHeaderPattern 颜色值改为可选，兼容省略颜色的模型输出 |
| fix | prd-api | autopilot max_tokens 从 2400 提升至 4000，避免 6 页内容被截断 |
| fix | prd-api | autopilot 解析失败时日志记录模型名、text chunk 数量、完整输出前 1000 字；空输出与格式错误分开报告 |
| fix | prd-admin | 删除 public/thirdparty/ref 断链符号（Docker 构建失败根因：../../../thirdparty/ref 在容器内超出文件系统根） |
| fix | prd-api | resolve-models 接口不再对空/未注册 appCallerCode 整批 400，改为跳过并返回 null |
| fix | prd-admin | ModelAppGroupPage resolveItems 构建跳过 appCode 为空的 caller，避免传 '' 触发后端 400 |
| fix | prd-admin | 海报侧边栏页面状态 badge 全部改为 icon-only 20px 圆形（pending/generating-image/failed），消除中文换行 |
| fix | prd-admin | autopilot 预览卡片网格从 auto-fit 改为固定 3 列，避免卡片数量少时出现忽大忽小跳变 |
| feat | prd-admin | 知识库"再加工"抽屉 picking 阶段按钮顺序调整：「开始加工」放左、「取消」放右；其它阶段保持原样 |
| feat | prd-admin | 资源详情面板支持多类型预览（音频播放器/视频播放器/网页iframe/PDF嵌入/图片），网格卡片附件类型显示对应图标 |
| fix | prd-api | 产品评审员 Agent 打分稳定性加固：`temperature` 降至 0、由 `submissionId` 派生稳定 `seed`，同一份方案重复评审结果一致；输出格式解析失败时自动重试 1 次（重试时换 seed 并追加严格 JSON 输出要求），仍失败则标记 `Status=Error` 提示用户「重新评审」，不再误判为 0 分未通过 |
| fix | prd-api | 产品评审员 Agent 修复"分数与文字解释自相矛盾"：在 prompt 中加叙事一致性硬要求（不涉及=合规通过，禁止描述为 0 分）；系统按 truth table 重算清单类维度分数后，同步用模板覆盖 `comment` 字段；顶层 `summary` 末尾追加`[系统结论] 最终得分 X/100，已通过/未通过` 权威结论行，企微/钉钉 webhook 通知文案同步对齐 |
| feat | prd-api | 产品评审员 Agent 新增排行榜聚合端点 `GET /api/review-agent/leaderboard?startMonth=&endMonth=&groupBy=submitter\|document`，按自然月区间统计评审数 / 通过率 / 一次性通过率；新增 `ReviewSubmission.RerunCount` 字段（rerun 时自增） |
| feat | prd-admin | 产品评审员「全部评审提交」页新增「排行榜」视图（提交人 / 方案 两个维度），支持自然月区间 + 快捷时段（本月 / 近 3 月 / 近 6 月 / 今年）+ 三指标可排序 + 前三名奖牌图标；顺手把页面布局修复为 `h-full min-h-0 flex flex-col` 满高滚动（修复 full-height-layout 规则违规） |
| feat | prd-api | 新增管理员短链管控：GET /api/admin/short-links（跨用户列表 + targetType/search 筛选）、POST /admin/short-links/:seq/revoke（强制吊销，同时让 /s/{seq} 和 /s/wp/{token} 失效）、POST /admin/short-links/repair-counter（counter 同步到 max(seq)） |
| feat | prd-api | 新增 short-links.manage 管理员权限（默认 admin 角色继承） |
| feat | prd-api | ShortLinkService 增加 Seq 自愈：unique(Seq) 撞车时最多重试 16 次跳过已占用号段，仍失败则触发 counter 自动修复 |
| fix | prd-api | ShortLinkCounter._id 映射 bug（Key→Id），运维误删 counter 后能通过 RepairCounterAsync 一键恢复 |
| feat | prd-admin | 系统设置新增「分享短链」管理 Tab：表格视图（seq/类型/标题/作者/访问/浏览/创建时间/token）、按 targetType 筛选、按 seq 或 token 搜索、强制吊销、修复 counter |
| feat | prd-admin | 网页托管「分享管理」对话框每行展示 #seq 徽章（老分享显示「长链」徽章） |
| feat | prd-api | 新增统一短链基础设施（short_links 集合 + ShortLinkService + GET /api/short-links/{seq}），所有分享系统将共用 /s/{seq} 数字短链 |
| feat | prd-api | 网页托管分享接入统一短链：CreateShare 自动分配 Seq，POST /api/web-pages/share 返回 shareUrl=/s/{seq}（兼容字段 legacyShareUrl=/s/wp/{token}） |
| feat | prd-admin | 新增 /s/:slug 统一短链路由 + ShortLinkRouter 组件，数字 slug 解析后渲染对应分享视图；老链接 /s/wp/:token 继续兼容 |
| feat | prd-admin | 网页托管分享 UI 改为优先展示短链 /s/{seq}（分享创建、复制、预览、快速分享弹窗），无短链时退回老 /s/wp/{token} |
| fix | prd-admin | EmergenceNode 修复"填满又清空"闪烁 — 丢弃 tail 滑窗, 直接喂全文 liveText (offset key 才稳定) |
| fix | prd-admin | SkillAgentPage 创建技能对话气泡 (msg.content) + 自动试跑 (autoTestResult) 补齐 StreamingText 接入 (之前只改了 testResult) |
| feat | prd-admin | StreamingText 新增 cursorContent prop ('bar' \| 'dot' \| ReactNode), 支持业务自定义 cursor |
| feat | prd-admin | 新增 <MapCursor /> 品牌 cursor 组件 (M 字母 + 发光, 与首页 MAP loader 同源) |
| feat | prd-admin | Literary 创作 rawMarkerOutput cursor 切换为 <MapCursor size={12} /> 作为定制示例 |
| docs | doc | rule.streaming-text.md 补充 cursor 定制使用方式 |
| feat | prd-api | 新增 AiStreamingHelpers (Services/Streaming) — 通用 AI SSE 写出器, 一次封装 phase/model/thinking/typing/done/error + 心跳 + writeLock |
| feat | prd-api | 新增 DefectPolishService — 缺陷描述润色 SSE 流式服务 (与 DefectAgentController 共享 prompt) |
| feat | prd-api | 新端点 POST /api/defect-agent/defects/polish/stream — 与 useAiPreviewStream + AiPreviewModal 配对; 旧 /defects/polish 保留 6 个月做向后兼容 |
| feat | prd-api | AppCallerRegistry 新增 DefectAgent.Polish.Stream = "defect-agent.polish-stream::chat" |
| feat | prd-admin | 新增 useAiPreviewStream hook — 一次性 AI 端点流式升级的统一前端入口 (text/thinking/model/streaming/start/apply/regenerate/cancel) |
| feat | prd-admin | 新增 AiPreviewModal — 通用 AI 预览弹窗 (createPortal + 80vh inline + StreamingText + MapCursor + ESC) |
| feat | prd-admin | DefectSubmitPanel AI 润色切换到流式版 (Blur focus 词级动画 + 思考过程展示 + 重新生成) |
| refactor | prd-admin | DailyLogPolishPopover 收编到 AiPreviewModal — 从 234 行降到 65 行薄壳, 复用通用 modal |
| docs | doc | rule.streaming-text.md 新增"把一次性 AI 端点升级为流式"完整 Migration 手册 (后端 Service + Registry + Helper, 前端 hook + modal, 兼容期 6 月) |
| fix | prd-admin | EmergenceNode 修复"父节点不见了" — 上轮把 tail 滑窗换成全文导致每节点几千个 span + CSS 动画堆积, ReactFlow 重排扛不住把父节点挤飞。改回尾部窗口, 但 token key 用绝对 offset 防止滑窗闪烁 |
| feat | prd-admin | StreamingText 新增 maxTailChars prop — 通用尾部窗口能力, 内部 tokenize 走 offsetBase 让 React key 全局唯一 (滑窗时既不爆炸也不重复动画) |
| refactor | prd-admin | SseTypingBlock 内部预 slice 改用 maxTailChars 委托, 消除 substring 预切导致的 key 漂移 |
| test | prd-admin | 新增 5 个 StreamingText DOM 单测 (renderToStaticMarkup): 覆盖 maxTailChars cap / 省略符 / CJK / 短文本不裁切 |
| feat | prd-admin | 新增 StreamingText 统一流式文本动效组件（默认 Blur focus，4 种 mode，遵守 prefers-reduced-motion） |
| feat | prd-admin | Arena 大模型竞技场实时回答接入 StreamingText，消除每 chunk markdown 重渲染 reflow |
| feat | prd-admin | 工作流 AI 对话面板（WorkflowChatPanel）接入 StreamingText |
| feat | prd-admin | PR Review SummaryPanel 预览接入 StreamingText |
| feat | prd-admin | 新增 /_dev/streaming-text-lab 实验场用于 4 mode 对照演示 |
| chore | prd-admin | 清理死代码：AiChatPage / PrdAgentTabsPage / prdAgentStore / PrdAgentSidebar（已脱离路由）+ OpenPlatformPage / StatsPage（无任何引用） |
| docs | doc | 新增 doc/rule.streaming-text.md 流式文本动效统一规范 |
| feat | prd-admin | 批次二 — PR AlignmentPanel 正文 + ThinkingBlock 接入 StreamingText |
| feat | prd-admin | 批次二 — DailyLogPolishPopover 正文 + 思考过程接入 StreamingText |
| feat | prd-admin | 批次二 — ai-toolbox ToolDetail 对话正文接入 StreamingText |
| feat | prd-admin | 批次二 — literary-agent 图文配图 思考过程接入 StreamingText |
| feat | prd-admin | 批次二 — QuickCreateWizard 流式输出接入 StreamingText |
| refactor | prd-admin | SseTypingBlock 内部委托 StreamingText（保留 tailChars 调试语义） |
| docs | doc | rule.streaming-text.md 新增第 5 条：thinking 块禁裸文本强制规则 |
| feat | prd-admin | 批次三 final — QuickCreateWizard polishedPrompt (提示词润色弹窗) 接入 StreamingText |
| feat | prd-admin | 批次三 final — WeeklyPoster TypingPanel (周报生成终端日志) 接入 StreamingText |
| feat | prd-admin | 批次三 final — PosterDesigner TypingPanel (海报设计实时输出) 接入 StreamingText |
| docs | doc | 缺陷润色 (DefectSubmitPanel) 为一次性 fetch 非流式, 接入需要后端先支持 SSE, 不在本批次范围 |
| feat | prd-admin | 批次三 partial — 文学创作 OUTPUT 主输出区 (rawMarkerOutput) 接入 StreamingText |
| feat | prd-admin | 批次三 partial — SkillAgentPage 2 处测试结果接入 StreamingText (含 markdown) |
| feat | prd-admin | 批次三 partial — document-store ReprocessDrawer streamedText 接入 StreamingText |
| feat | prd-admin | 批次三 partial — lab-desktop DesktopLabTab chatText + guideLog 接入 StreamingText |
| feat | prd-admin | 批次三 partial — emergence EmergenceNode liveText 接入 StreamingText |
| feat | prd-admin | 网页托管：上传 Markdown 时自动用文件名（去扩展名）作默认标题 |
| feat | prd-admin | 网页托管卡片始终保留描述行（无描述时显示浅色占位），所有卡片底部高度对齐 |
| feat | prd-admin | 网页托管卡片公开按钮固定在左上：私有"设为公开" / 公开"公开"（悬浮变"取消公开"），位置不再跳动 |
| feat | prd-admin | 网页托管新上传卡片入场动效：360ms 滑入 + 1.2s 柔和点亮光环（尊重 prefers-reduced-motion） |
| feat | prd-admin | 网页托管卡片悬浮工具栏新增"转存到知识库"按钮（仅公开站点可见），弹窗选目标库后以引用条目方式入库 |
| fix | prd-api | 网页托管：视频/PDF 上传未填标题时，后端用文件名（去扩展名）兜底，不再统一存为"未命名站点"（Codex PR #598 review） |
| fix | prd-admin | 网页托管：用专用 hasLoadedOnceRef 判断首屏加载，修复首次加载返回空列表时上传第一个站点没有入场动效（Cursor Bugbot PR #598 review） |
| fix | prd-api | 网页托管：HostedSiteService.MaxExtractedSize 由 200MB 提到 500MB，与控制器 MaxSingleFileSize 一致；之前 200-500MB 的视频/PDF 上传过得了控制器但被服务层解压时拒掉 |
| fix | prd-api | 网页托管：视频/PDF wrapper 的 `<source src>` / `<iframe src>` / `<a href>` 改用 Uri.EscapeDataString 百分号编码资产文件名，修复含 `#` `?` 等 URL 元字符的文件名（如 `demo#1.pdf`）预览被浏览器解读成 fragment/query 而 404 |

### 2026-05-12

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 修复分支卡片时间语义不清和应用代码错误被误判为 CDS 故障的问题 |
| fix | cds | 提交通知信箱仅在全局更新徽章可见时上移堆叠，单独显示时贴近底部 |
| fix | cds | 修复 CDS 自更新和分支同步时未统一注入 GitHub 凭据导致私有仓库 fetch/ls-remote 失败的问题 |
| fix | cds | 修复 CDS 分支列表 project 参数只按 id 过滤导致 slug 查询分支为空的问题 |
| fix | cds | 修复 CDS 自更新成功后 active-update 幽灵状态仍锁定更新按钮的问题 |
| fix | cds | 修复预览页 widget 无法解析来源项目时暴露跨项目构建配置，并按当前分支 projectId 二次过滤更新按钮 |
| feat | cds | 分支详情页新增运行提交、GitHub 目标提交、最近拉取前后版本对照，便于确认部署是否真正更新 |
| fix | cds | 修复独立 forwarder 的预览 API 转发未携带来源 host/branch，导致数据面仍无法按项目隔离的问题 |
| fix | cds | 项目卡片基础设施节点改为按 MongoDB、Redis、MySQL、RabbitMQ、Nacos、MinIO 识别的品牌化图标 |
| fix | cds | 为基础设施服务增加 project/system 作用域，系统存储不再参与项目级隔离口径 |
| fix | cds | 分支卡片和详情抽屉增加来源判断，区分 Webhook、手动操作和待配置分支 |
| fix | cds | Webhook 日志空状态增加原因解释和下一步操作，避免灰色面板来源不明 |
| fix | cds | 远程分支接口返回 Git 默认分支并在选择列表置顶标记，避免误把 master 项目按 main 部署 |
| fix | cds | 项目持久化 Git 远程默认分支，新建项目、clone 完成和自动部署统一使用真实默认分支 |
| docs | doc | 新增 CDS 三种部署方式教程和 Railway 式体验补齐计划 |
| fix | cds | 项目卡片状态移入预览画布，放大服务与基础设施图标，并压缩底部操作区高度 |
| fix | cds | 精简项目卡片底部信息，只保留运行状态与容器在线数，移除仓库、默认分支和分支运行统计 |
| fix | cds | 项目卡片节点改为统一视觉 token，收敛图标尺寸与节点间距 |
| fix | cds | 收敛项目卡片预览区服务图标尺寸，并降低左侧导航图标视觉重量 |
| fix | cds | 项目列表过滤 CDS 自身状态 Mongo，避免系统基础设施混入 MAP 项目卡片 |
| fix | cds | 收窄项目列表工作区并增加主内容留白，缓解三列卡片贴边拥挤感 |
| feat | cds | 新增 Railway 式一键部署向导，支持创建项目时选择运行环境和基础设施 |
| feat | cds | 扩充一键部署运行环境模板，新增 Go、Rust、PHP、静态站点和 Dockerfile 模式 |
| feat | cds | 一键部署支持同时创建前端服务和后端服务，并分别生成 BuildProfile |
| feat | cds | 基础设施预设新增 RabbitMQ，并补充全栈基础设施冒烟样例 |
| feat | cds | 项目卡片按 Railway 风格展示分支容器与基础设施服务节点 |
| feat | cds | 拓扑页支持手动新增 MongoDB、PostgreSQL、MySQL、Redis 或自定义基础设施 |
| docs | doc | 更新 CDS 三种部署方式指南并新增 Railway 式部署向导设计 |
| fix | cds | 项目页侧栏改为 Railway 风格宽菜单，项目卡片服务节点改用 GitHub 图标并放大基础设施图标 |
| fix | cds | 修复 CDS 自更新在前端构建失败时仍显示成功的问题 |
| fix | prd-admin | 修复左侧 sidebar 菜单数量与「我的导航」设置页数量不一致的问题 |
| fix | prd-admin | navRegistry: /document-store 权限从 access 改为 document-store.read，与后端 Controller 守卫对齐 |
| fix | prd-admin | 导航顺序页：范围切换控件移入「我的导航」标题行，消除标题行上方空白区域 |
| fix | prd-admin | navRegistry: /web-pages 路由守卫回退为仅 web-pages.read，写权限用户无法实际加载页面 |
| fix | prd-admin | 恢复「设置」页面在侧边栏和「可添加」池中的可见性，移除错误的三重隐藏封锁（SIDEBAR_HIDDEN_APPKEYS + launcherCatalog 过滤 + 未入 DEFAULT_NAV_ORDER）|
| fix | prd-api | AdminMenuCatalog: settings 条目标签从「数据运维」更正为「设置」，图标从 Server 改为 Settings |
| fix | prd-admin | 移除 NavLayoutEditor 孤立条目检测的守卫条件，首次加载（无 navOrder）时也正确追加新上线条目，修复侧边栏与导航编辑器数量不一致 |
| fix | prd-api | 为 web-pages/document-store/emergence 添加 personal 分组，使知识库/网页托管/涌现探索出现在侧边栏和默认导航顺序 |
| fix | prd-admin | 修复资源图标（FolderOpen→FolderHeart），新增 Library/Sparkle 图标到 AppShell iconMap |
| fix | prd-admin | 删除导航编辑器顶部冗余提示文字，为图标区域释放可见空间 |
| test | prd-admin | 更新 navMenuSync 护栏测试以匹配新孤立检测逻辑（无守卫条件） |
| test | prd-api | 补充知识库字幕豆包异步 ASR 回归测试，锁定 JSON audio_data 请求路径 |
| fix | prd-api | 收敛 Exchange ASR SSE 控制器异常输出，避免向前端暴露异常类型和堆栈 |
| fix | prd-admin | 修复 Exchange Test Panel 收到 SSE error 后清空既有转写结果的问题 |
| fix | prd-admin | 清理 17 个前端 lint error，恢复主分支前端质量门禁 |
| docs | doc | 标记资源存储债务 X-1 已还并记录验收方式 |
| docs | doc | 标记资源存储债务 X-2 已还并记录验收方式 |
| docs | doc | 标记资源存储债务 X-5 已还并记录验收方式 |
| fix | prd-admin | 修复 ShareDock 拖拽卡片时浏览器把卡片文字框选成蓝色的 bug（统一在拖拽过程中禁用 body user-select） |
| feat | prd-admin | 网页托管页"上传站点"按钮升级为主按钮样式 |
| feat | prd-admin | ShareDock 新增顶部"拖文件到此上传"区域（OS 文件拖入），槽位横向紧凑布局，整体接近正方形 |
| feat | prd-api | 网页托管支持上传 Markdown / PDF / 视频（mp4/webm/mov/m4v/ogv），后端自动生成 index.html 壳子并打包托管 |
| feat | prd-api | 网页托管单文件大小上限从 50MB 提升到 500MB（适配视频文件） |

### 2026-05-11

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | 优化缺陷提交标题提取和列表标题展示，避免模板前缀或截图编号污染标题 |
| fix | prd-api | 强化缺陷 AI 润色提示词和标题清洗兜底，保证第一行可作为有效标题 |
| fix | prd-api | 修复缺陷评论和标记解决接口未启用 AI Access Key 直连认证的问题 |
| feat | prd-admin | 缺陷分享弹窗支持创建 1 天临时密钥，并把评论与标记修复接口写入提示词 |
| fix | prd-api | Agent API Key scope 白名单新增缺陷修复权限，支持缺陷分享临时授权 |
| fix | prd-api | 周报海报一键生成默认周次改为中国时区，并将单页生图保存改为原子更新避免并发覆盖 |
| fix | prd-admin | 周报海报一键生成默认周次按中国时区计算，并在批量生图后回读服务器最终状态 |
| fix | prd-admin | 将缺陷修复临时密钥入口补到批量分享缺陷弹窗，确保线上实际入口可见 |
| feat | prd-api | 新增 /api/v 与 /api/version 版本接口，便于确认线上发布的 commit 和构建信息 |
| fix | ci | main 分支推送时总是构建 Admin Dashboard 和 Web Latest，避免前端上次失败后被后续后端提交永久跳过 |
| fix | ci | main 分支推送时所有关键检查和发布构建全量运行，develop 与 PR 继续按路径跳过 |
| feat | prd-api | 周报海报批量背景图改用 ImageGenRunWorker 后台任务，生成完成后按页回填 ImageUrl |
| feat | prd-admin | 周报海报编辑器新增一键生成背景图按钮，创建服务端后台任务并轮询展示回填进度 |
| fix | prd-api | 兼容缺陷分享临时 AgentApiKey 通过 X-AI-Access-Key 或 Authorization 调用评论与标记完成接口 |
| fix | prd-admin | 缺陷分享提示词在创建临时密钥时改为输出可直接使用的 Authorization 认证头 |
| fix | prd-admin | 提交缺陷未选择提交用户时增加明确提示，避免点击提交后像无响应 |
| docs | doc | 新增缺陷管理标签体系设计，明确 AI 正在跟进等协作标签的枚举、权限、展示和桌面端同步方案 |
| feat | prd-desktop | 桌面端更新成功后的首次启动新增版本更新内容面板，按版本只展示一次 |
| feat | scripts | recent-updates.json 增加最新发布版本的用户更新项，供桌面端更新成功面板展示 |
| fix | prd-desktop | 清理桌面端失效的 eslint-disable 注释，让 pnpm lint 恢复可执行 |
| chore | doc | 修复 doc/ 命名违规 2 个（无前缀/非法前缀），重命名为合规的 report.* / guide.* |
| chore | doc | 补齐 doc/index.yml 缺失 53 个文档条目（spec×4 / design×17 / guide×16 / rule×6 / plan×6 / debt×2 / report×5 / renamed×2） |
| chore | doc | 补齐 doc/guide.list.directory.md 缺失 57 个文档条目，更新日期至 2026-05-11 |
| chore | CLAUDE.md | 修正 MongoDB 集合数量描述 115→118，补充 qa-ledger / createzzdemo / entropy-cleanup 至技能表 |
| feat | .claude/skills | 新增 entropy-cleanup 技能，支持五维度文档一致性扫描与自动补齐（/entropy 触发） |
| chore | doc | 补齐 design.defect-agent.md 缺失的分享链接/外部 Agent 接口/临时密钥章节（§6.6/§6.7）及场景 3 更新 |
| chore | doc | 更新 design.skill-marketplace-open-api.md scope 白名单说明，补充 defect-agent:fix |
| chore | rules | 更新 codebase-snapshot.md 补充缺陷临时密钥/桌面更新面板/版本接口至已完成列表 |
| feat | prd-admin | 周报详情页右栏新增「版本记录」卡，按时间倒序展示提交/审阅通过/退回/编辑事件，仅显示时间不含变更内容 |
| feat | prd-api | WeeklyReport 模型新增 VersionHistory 数组；SubmitReport / ReviewReport / ReturnReport 三个端点写入对应事件；UpdateReport 在已提交状态下被再次编辑也记入 edited 事件 |
| feat | prd-admin | 百宝箱新增「最近使用」横条：点击工具后自动记录，最多展示 6 条，sessionStorage 持久化 |
| feat | prd-admin | 百宝箱新增「工具类型」筛选（全部类型/智能体/工具），与权属 Tab 正交叠加 |
| feat | prd-admin | 百宝箱卡片 Tag 可点击过滤，搜索栏同步显示活跃标签芯片，支持一键清除 |
| refactor | prd-admin | 海鲜市场卡片重设计为封面流布局：封面图/渐变背景+类型图标、底部信息叠加层、去掉 emoji，改用 ShieldCheck 图标表达官方身份 |
| fix | prd-admin | 「接入 AI」弹窗「我的 Key」Tab 底部黑色空白：移除强制 h-88vh，改为内容自适应高度 |

### 2026-05-10

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | AppCaller 启动同步：默认 chat 绑定改为只选 ModelType=chat 且含模型的组；剔除失效 ModelGroupId 后自动回填 |
| fix | prd-api | PaAgent 流式失败提示收紧为 ModelGroup 类关键词，静默退出诊断文案去掉泛 AppCaller 字样 |
| fix | prd-api | 恢复 AppCallerRegistrySyncService 启动同步，自动注册 pa-agent.chat::chat |
| fix | prd-api | PaAgent 聊天失败时单独提示「应用未注册」及重启/初始化应用操作 |
| fix | prd-api | AppCallerRegistrySyncService 增强：已存在 AppCaller 的 chat 模型组绑定为空时自动回填首个可用模型组（防御性，幂等），解决 CDS 新分支沿用旧空绑定导致毒舌秘书 LLM 调用失败 |
| fix | prd-api | PaAgentController 错误信息细化：把 ModelGroup/AppCaller/401/429 等关键词分别翻译为可操作的用户提示，前端不再只看到「AI 服务暂时不可用」 |
| merge | prd-admin | 自 origin/main 新建分支合并 PA Agent：App.tsx 保留 main 结构，`/pa-agent` 注册到 NAV_REGISTRY |
| merge | prd-api | BuiltInSystemRoles 合并 main 的 emergence-agent.use 与 pa-agent.use |
| merge | doc | 解决 guide.list.directory / spec.pa-agent 与 main 的合并冲突 |
| fix | prd-api | PaAgent System Prompt 注入用户姓名：弃用 string.Format，改用 `__PA_USER_DISPLAY_NAME__` 占位符 Replace，避免与 JSON 示例花括号冲突导致 `FormatException`（用户曾见 `Input string was not in a correct format` / offset 1474） |
| feat | prd-api | PA Agent 升级为「毒舌秘书」：替换 SystemPrompt 为 MBB 风格 + 五条信条 + 毒舌输出风格，运行时注入用户姓名 |
| feat | prd-api | AppCallerRegistry.PaAgent 显示名改为「毒舌秘书-对话」（Caller Key `pa-agent.chat::chat` 不变） |
| feat | prd-admin | PaAgentPage 品牌、侧栏、回退标题、空状态文案改为「毒舌秘书」，剥离遗留 emoji |
| feat | prd-admin | PaAssistantChat 空状态、Placeholder、快捷指令毒舌化；任务 toast 与建议按钮新增「毒舌一句」 |
| feat | prd-admin | PaTaskBoard 象限标题改为 立刻干/计划干/快速干/养着干，列头加毒舌副标题，剥离 emoji 用 lucide 图标替代 |
| feat | prd-admin | 百宝箱 builtin-pa-agent 名称改为「毒舌秘书」 |
| docs | doc | 新增 doc/spec.pa-agent-savage-upgrade.md（落地版，已剥离 emoji 适配 CLAUDE.md 第 0 条） |

### 2026-04-18

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 新增私人助理 Agent（pa-agent）：PaTask/PaMessage/PaSession 实体、MongoDb 集合注册、PaAgentController（SSE流式对话+四象限任务CRUD+幂等去重）、pa-agent.use 权限点 |
| feat | prd-admin | 新增私人助理 Agent 前端：PaAgentPage/PaAssistantChat/PaTaskBoard 组件、paAgentService.ts API 封装、路由注册、百宝箱注册（wip:true） |


## [1.9.0] - 2026-05-11

> **用户更新项**
> - CDS 多项目预览完成真实业务回归：MAP、mdimp、mytapd 的预览隔离、部署守卫和运维入口更稳定。
> - 数据库初始化入口更清晰：SQL 基础设施项目会显示初始化提醒，向导能识别 MySQL / PostgreSQL 环境。
> - 更新中心口径修正：本周更新会合并待发布碎片和 CHANGELOG 日期块，未发布计数显示来源与范围。
> - cdscli 升级到 0.6.x：增强 Maven、多模块、Nacos、init SQL、pnpm 与 no-http-readiness 扫描能力。
> - CDS 自更新与 forwarder 架构收口：业务预览流量与控制面进一步隔离，恢复能力更强。
> - 周报与海报链路增强：W19 周报补齐主干变更，周报海报和多平台内容流继续完善。

### 2026-05-11

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 更新中心 current-week 合并同周 changelogs 碎片与 CHANGELOG 日期块，并用北京时间计算周范围 |
| fix | prd-admin | 历史发布计数文案改为明确显示 CHANGELOG 未发布块 / 版本块及筛选数与总数 |
| fix | scripts | release 脚本版本提交信息改为中文，满足主仓库提交规则 |
| docs | doc | 补齐 2026-W19 周报中 5 月 9 日后半与 5 月 10 日的 CDS 多项目收口内容 |
| fix | scripts | assemble-changelog 兼容 macOS Bash 3，并移除脚本输出中的 emoji |
| fix | scripts | release-prepare 变量插值兼容 macOS Bash 3，避免中文标点后变量名解析异常 |
| fix | ci | Server Deploy 移除已废弃的 prd-video Docker build context，修复 CI checkout 中不存在该上下文导致的镜像构建失败 |
| fix | ci | macOS Desktop Release 默认只做签名构建，Apple notarization 改为通过 MACOS_NOTARIZE 变量显式开启，避免开发者协议过期导致 release 构建失败 |

### 2026-05-10

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | EnvSetupDialog 的 SQL 上传卡片现在识别 `CDS_MYSQL_*` `CDS_POSTGRES_*` `DATABASE_URL` 等 cdscli 命名,并叠加 infra services 镜像信号(mysql/postgres/mariadb),mdimp 类项目卡片不再消失 |
| fix | cds | OpsDrawer 改为 non-modal 侧栏:移除全屏 overlay、`aria-modal`、`document.body.overflow=hidden`,打开运维抽屉时 BG 仍可点击与滚动,关闭走 ESC 键或 header 的 X 按钮 |
| fix | cds | BranchListPage 数据库初始化 banner 加条件,仅项目 services 含 mysql/postgres/mariadb/mongo 时显示,避免在 MAP 等纯前端项目误展示 |
| feat | cds | 分支列表 / 拓扑详情新增「数据库初始化(schema.sql)」入口 chip,deep-link 到项目设置 #env tab,解决用户找不到初始化数据库入口的问题 |
| fix | cds | OpsDrawer 增加防御性 body.overflow 兜底 + dev console 日志,解决用户反复反馈的"运维抽屉关了 overlay 还在挡按钮"问题 |
| security | cds | 统一 /_cds/ bypass scope 守卫：任何带 branchId/profileId 的 path 自动按 source-project 校验 (AG/AH/AI) |
| security | cds | widget /_cds/api/build-profiles 按 sourceProject 过滤，杜绝其它项目 service 出现在浮窗（Bug AB） |
| fix | cds | widget bypass 项目详情接受 slug 而非仅 hash id，修复 main-{slug}.miduo.org 下 GET /api/projects/{slug} 误 403（Bug AD） |
| fix | cds | 修复 widget 浮窗跨项目泄漏与跨项目部署：`/_cds` 代理透传原始 host，bypass 中按 host 解析源项目，对 `/api/branches`、`/api/projects` 响应做项目过滤；`POST /api/branches/:id/deploy*` 重新放行但增加 sourceProject 与 branch.projectId 校验，跨项目返回 403 forbidden_cross_project_deploy |

### 2026-05-09

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | .claude/skills | 新增 auto-fix-issues 技能：agent 间 issue 反馈/修复/复测协议（三档标签 + 4 套模板 + PR 收尾强制清单） |
| docs | CLAUDE.md | 注册 auto-fix-issues 到主流程技能表（/audit 触发词） |
| docs | cds/SKILL.md | 增加反馈缺口章节，引导 cdscli 用户通过 /audit 走标准化反馈链路 |
| refactor | cds | 删除蓝绿(blue-green)所有相关代码,改由独立 forwarder 进程承载业务流量切换。删除 16 个文件 + 简化 topology 聚合器为单 master 模型 |
| docs | doc | 新增 guide.cds-cli-swarm 操作手册：多 agent 并行优化 cdscli 的协议（3 反馈+1 修复+1 协调），含 5 段可复制 prompt |
| fix | cds | clone 端点对旧项目缺失 repoPath 自动 backfill（#551 a），不再返回 no_repo_path 让用户重建项目 |
| fix | cds | 启动时把 stale building/starting/restarting 分支收敛为 error 并写明 errorMessage（#551 c）|
| fix | cds | branch logs 端点在无 OperationLog 但状态为 error 时返回合成 fallback 记录暴露 errorMessage（#551 d）|
| feat | cds | 401 响应新增 hint + acceptedHeaders，并兼容 ai-access-key / Authorization Bearer 别名（#552 CDS-CLI-005）|
| feat | cds | GET /api/projects/:id 对半成品/未 clone 项目返回 recovery.nextActions 提示 Agent 下一步（#552 CDS-CLI-007）|
| fix | cds | 修复 Vite 端口识别误判：忽略 server.hmr.port 且过滤无效端口 |
| fix | prd-api | 注册更新中心 AI 总结的 AppCallerCode（prd-admin.changelog.ai-summary::chat），修复点击「AI 总结」报「appCallerCode 未注册」的运行时错误 |
| fix | prd-api/tests | 加强 AppCallerCodeRegistryGuardTests 正则覆盖 camelCase 字面量并新增 kebab-case 命名规范测试，防止再次出现 #504 那种用 camelCase 绕过守卫的情况 |
| feat | prd-admin | 更新中心右侧周报预览升级为长文阅读排版（reading 变体）：约束阅读宽度 72ch、恢复标题层级（h1 22px 带细线、h2 18px、h3 15.5px）、段距 16px / 行距 1.85、表格仅留水平细线 + hover 斑马、blockquote 紫色细线 + 软底色、HR 渐变细线、inline code 和链接走克制紫色调；MarkdownContent 新增 variant 选项，默认 compact 不影响其它消费方 |
| fix | prd-api | 收紧重置密码、应用注册中心与出站 URL 安全校验 |
| fix | prd-admin | 修复工作流产物预览中的不可信 HTML/Markdown 执行风险 |


### 2026-05-09

| 类型 | 模块 | 描述 |
|------|------|------|
| docs | doc | debt.asset-storage 补 X-5：ExchangeController ASR 失败时 result+error 双事件，前端 error handler 覆盖 sseResult 丢转录数据（历史代码，本 PR 范围外）|
| fix | prd-api | LocalAssetStorage TryRead/Delete 加 IsHex 校验防止 glob 注入：sha 含 * / ? 时 Directory.GetFiles 会解释为通配符，可能匹配/删除非预期文件 |
| docs | doc | debt.asset-storage 补 X-4：DocumentStoreAgentWorker 错误消息 1500 截断切断 JSON 中段（历史代码，本 PR 范围外） |

### 2026-05-08

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | DoubaoStreamAsrService 新增 AsrDiagnostic：每次调用记录 wsUrl/resourceId/requestId/appKey 预览/accessKey 预览/audioInfo，握手失败时翻译 401/403/5xx 为人话 + 排查 checklist + wscat 等价命令 |
| fix | prd-api | SubtitleGenerationProcessor 取消硬编码 doubao-asr-stream 白名单，改为三路分发（doubao-asr-stream / doubao-asr / Whisper-via-Gateway），whisper-large-v3 等 OpenAI 兼容模型现在可直接用于字幕生成 |
| fix | prd-api | SubtitleAsrException 携带 diagnostic，DocumentStoreAgentWorker 透传到 SSE error 事件与 run.errorMessage，前端从两个路径都能拿到诊断 |
| fix | prd-api | ExchangeController.TestStreamAsrSse 的 SSE error/result 事件附带 diagnostic + exchange 元数据，控制器层异常也带异常类型与堆栈头部 |
| fix | prd-admin | SubtitleGenerationDrawer 失败时展示完整诊断块（wsUrl/headers/audioInfo/握手状态码/异常链/友好错误），含「复制 wscat 命令」「复制完整诊断 JSON」按钮 |
| fix | prd-admin | ExchangeTestPanel 测试结果 GlassCard 增加 ASR 诊断块，与字幕面板字段一致，wscat 一键复制即可在本地复现 WebSocket 握手 |
| fix | prd-api | SubtitleGenerationProcessor 调度策略改为通用「OpenAI 兼容优先」: 列举 ASR 池所有候选，按 PlatformId != "__exchange__" 自动选第一个 Healthy 模型作为 expectedModel —— 不再硬编码 whisper-large-v3，任何 whisper-1 / whisper-large-v3-turbo / 未来新平台模型都自动接入。池中无 OpenAI 兼容模型时降级默认调度，不破坏豆包用户 |
| fix | prd-api | SubtitleGenerationProcessor / ContentReprocessProcessor 创建 newEntry 时填 LastChangedAt = UtcNow，前端 DocBrowser 自动给新条目加「24 小时内更新」角标 |
| feat | prd-api | ContentReprocessProcessor 支持「模板 + 补充指令」组合：选模板时若 customPrompt 非空，自动拼到 systemPrompt 末尾作为额外用户指令，不再强制「模板 OR 自定义」二选一 |
| feat | prd-admin | ReprocessDrawer 补充指令输入框永远可见：选模板时作为「补充指令（可选）」叠加，选「自定义」时作为主 prompt（必填）；输入框 placeholder 文案随模式切换 |
| fix | prd-admin | ReprocessDrawer / SubtitleGenerationDrawer footer paddingBottom 加大到 80px，让主操作按钮避开屏幕右下角的全局通知/帮助气泡，避免被遮挡；按钮 size 从 xs 提升到 sm/md，主按钮视觉权重更醒目 |
| fix | prd-admin | DocumentStorePage 字幕生成 / 再加工 onDone 改为「立即刷新 + 1.5s 后兜底再刷一次」，兼容 DB 写入与列表读取间的微小延迟，确保新条目出现在左侧文件树 |
| fix | prd-api | LocalAssetStorage.MimeToExt 补全 audio/video mime 映射；以前 audio/m4a 等被 fallback 到 .png，导致 CDN 按图片处理音频文件、跨域 decode 失败 |
| fix | prd-admin | AudioWavePlayer 静默 fallback：wavesurfer decode 失败时不再展示红字提示，直接回退原生 audio 元素 |
| feat | cds | Phase B'.5 self-update / self-force-sync 接入 blue-green supervisor + UI chip — 新增 blue-green-bootstrap 装配 supervisor + gracefulShutdown,decideShouldUseBlueGreen 判定函数读 CDS_ENABLE/DISABLE_BLUE_GREEN env,蓝绿成功 daemon 不重启业务流量 0 中断,失败自动 fallback 老 process.exit + spawn 路径 |
| feat | cds-web | MaintenanceTab self-update 历史 chip 新增 'blue-green' 档位(青绿色 + tooltip),GlobalUpdateBadge done event mode='blue-green' 走 triggerManualRefresh 不进 restarting 全屏 overlay |
| test | cds | tests/integration/self-update-blue-green.test.ts + rollback-paths.test.ts 32 个 it.todo 转 it() 实测全 pass,覆盖 C-1.6 / C-1.7 / C-2.1 / C-2.2 / C-2.4 / C-2.7 / C-3.1 / C-3.2 / C-6.1 / C-6.6 / C-8.3 / C-8.4 / C-8.5 |
| refactor | prd-admin | hexToRgba 合并到 lib/themeComputed.ts —— 把原版（脆弱：无长度校验、无 #RGB 简写、非法时崩）替换为 robust 版（支持 #RGB / 非法 fallback / trim），WeeklyPosterModal 改 import 不再本地复制 (Bugbot Low) |
| chore | prd-admin | 删除三个未消费的调度服务函数 listWorkflowSchedules / updateWorkflowSchedule / deleteWorkflowSchedule + 对应 contract 类型；目前只有 createWorkflowSchedule 在 AutoPublishDialog 用，剩余三个属未来用途的死代码，CLAUDE.md 规则禁止 (Bugbot Low) |
| fix | cds | cds-forwarder.service ReadWritePaths 改为 /opt/prd_agent/cds(原父路径未被 install-forwarder 的 sed 替换,导致 systemd 报 mount namespacing 失败拒启) |
| fix | cds | install-forwarder 增加父路径 sed 替换 + 自动写 CDS_USE_FORWARDER=1 到 /etc/cds/env(让 master 重启后启动 publisher) + reset-failed 清失败窗口 |
| refactor | cds | 取消 master workerPort listener 的 CDS_USE_FORWARDER 门控:master 5500 与 forwarder 9090 不冲突,bootstrap 期间双活作 defense in depth |
| fix | cds | publisher /api/ convention 总是写 prefix route(原 apiSvc !== defaultProfile guard 在 api == default 时跳过,Cursor Bugbot Medium 提议为对齐 master detectProfileFromRequest 无条件行为 + 防 resolver 行为变化导致路由分叉)|
| fix | cds | forwarder-main handleDiagnostic 用 path 部分(去 query string)匹配端点,原 url === '/path' 不匹配 cache-busting `?v=1` 让监控/LB 看 forwarder 不健康,Cursor Bugbot Low |
| fix | cds | forwarder respondWaiting Content-Type 自动检测 HTML(以 < 开头视为 HTML 用 text/html,否则 plain text)。原本固定 text/plain 导致 forwarder-main 默认传的 HTML 等候页被浏览器当文本显示 + auto-reload script 不执行,Cursor Bugbot 抓到 |
| fix | cds | publisher pickDefaultProfile 严格对齐 master detectProfileFromRequest:case-sensitive includes(原 /i regex)+ 删多余 nonApi fallback(['api','reporting'] 分支 master 选 api,publisher 误选 reporting,Cursor Bugbot Medium)|
| fix | cds | publisher api convention 也用 case-sensitive includes,与 master 严格一致 |
| chore | cds | 删除未被调用的 ForwarderRoutePublisher.getStats(dead code,Cursor Bugbot Low)|
| fix | cds | forwarder-main /__forwarder/{routes,stats} 端点 isLoopback 检查同时校验 socket remote + Host header(原检查在 nginx 后永远 true,公网用户能 dump 路由表泄露 branchId/branchName/upstreamPort,Cursor Bugbot Medium 安全 bug)|
| fix | cds | forwarder ProxyHandler /_cds/* passthrough 不再 mutate req.url/req.headers,改用本地变量 outgoingPath/extraHeaders;forward 日志显示原始 path 而非 strip 后路径,journalctl 能直接关联客户端真实请求(handle + handleUpgrade 两路径都修,Cursor Bugbot Low)|
| fix | cds | publisher buildRoutes 移除 updatedAt 字段(每次 buildRoutes 生成新时间戳让 dedup 永远失效,每 2s 强制写盘 + forwarder fs.watch 风暴,Cursor Bugbot 抓到。mongo change-stream 用的 updatedAt 是 design 文档预留,JSON file 模式不需要) |
| fix | cds | forwarder ProxyHandler injectWidgetAndSend 给 upstreamRes 挂 'error' 监听(原只挂 decompressor stream,upstreamRes 自身 mid-stream ECONNRESET 没 listener → EventEmitter 抛 uncaughtException 整个 forwarder 进程崩,Cursor Bugbot Medium 抓到的真 crash bug,gzip 是生产常见路径)|
| fix | cds | forwarder ProxyHandler 加 `/_cds/api/*` passthrough(对齐 master proxy.ts:360-373):widget script 通过此前缀回调 master REST API,strip /_cds 前缀 + 加 x-cds-internal header + 转发到 master 端口 9900;否则 widget badge 显示但内部 fetch 全部 404 |
| feat | cds | ProxyHandler 增加 masterPassthroughHost / masterPassthroughPort 配置项(默认 127.0.0.1:9900),forwarder-main 通过 CDS_MASTER_PASSTHROUGH_HOST / CDS_MASTER_PASSTHROUGH_PORT / CDS_MASTER_PORT env 注入 |
| test | cds | 新增 2 个 ProxyHandler 测试:_cds/* path strip + 转 master / 普通 path 不被 passthrough,验证分流正确,1505 全绿 |
| fix | cds | publisher 默认 fallback route 加 branchName 字段(原本只有 path-prefix routes 有,/ 路径 widget 不注入,Codex P2 + Cursor Bugbot High 同时报)|
| fix | cds | publisher unchanged-skip 改用真 JSON 内容比对(原 records.length:json.length 在 port 41000→41001 同 length 时误判 unchanged 不写盘,forwarder 保留 stale 路由,Codex P1 + Cursor Bugbot Medium 同时报)|
| test | cds | 新增 2 个回归测试覆盖 Codex/Bugbot 找到的 bug,1509 全绿 |
| feat | cds | forwarder ProxyHandler 加 widget injection(HTML 200 解压 gzip/br/deflate + 在 </body> 前注入 buildWidgetScript)对齐 master 行为,左下角分支 badge 恢复显示 |
| feat | cds | forwarder ProxyHandler 加 cookie cache control(cds_branch cookie 存在时响应头加 cache-control=no-store + Vary=Cookie),对齐 master proxy.ts:971-973 |
| feat | cds | forwarder upstream 错误响应分流:浏览器(Accept: text/html)返回友好 HTML 自动刷新页,API 返回 JSON{error,code,hint};对齐 master proxy.ts:1074-1092 |
| feat | cds | forwarder 增加每请求 console.log forward 日志 + 错误码 hint(ECONNREFUSED 等翻译为可读中文),debug 真相之源 |
| feat | cds | forwarder handleUpgrade(WebSocket)对齐 handle() 的 X-Forwarded-{Proto,Host} 设置,行为一致性 |
| feat | cds | RouteRecord 加 branchName 字段(原始 git 分支名),供 widget injection 显示;publisher 写入分支 entry.branch |
| test | cds | 新增 5 个 ProxyHandler 测试:cookie cache / widget injection (基础+无 branchName 跳过) / gzip 注入 / brotli 注入,1503/1503 全绿 |
| fix | cds | forwarder ProxyHandler 把 Host header 改写为 upstream hostname:port(对齐 master ProxyService 行为),原始域名走 X-Forwarded-Host;之前透传外部域名导致容器内 vhost 不识别全部 404 |
| fix | cds | publisher 复刻 master detectProfileFromRequest 的 path-based profile 选择(BuildProfile.pathPrefixes 优先 / `/api/*` → api/backend convention / 默认 admin/web/frontend),否则前端 / 路径会被路由到 api 容器返回 404 |
| fix | cds | install-forwarder 注入 nvm/asdf 的 node bin 路径到 systemd PATH(原默认 PATH 找不到 nvm 装的 node,forwarder 启动 status=127/n/a 拒启) |
| fix | cds | install-forwarder 三层探测 node 路径(sudo 下 `command -v node` 找不到 nvm 时,fallback 到 master service 的 PATH 与 /root/.nvm 标准位置) |
| feat | cds | forwarder route=null 时 fallback 转给 master worker 端口(默认 5500),保留原 Host → master 用 ProxyService.serveStartingPageV2 等丰富等候/错误页处理(分支 building/error/stopped 状态用户看到友好页面而非 plain 503) |
| feat | cds | RouteRecord 加 preserveHost 字段:fallback 路由设 true 跳过 Host 改写,master 才能 detectBranch |
| test | cds | 新增 2 个 ProxyHandler 测试:unknown host fallback 转 master 保 Host / 没配 fallback 走原 503 plain page,1507 全绿 |
| feat | cds | 新增独立 forwarder 进程(cds-forwarder.service)替代蓝绿部署 — 业务流量与 self-update 物理隔离,daemon 重启 *.miduo.org 不再抖动 |
| feat | cds | 新增 ForwarderRoutePublisher,daemon 周期把 running 分支表写到 .cds/forwarder-routes.json,forwarder 进程 fs.watch 增量加载 |
| feat | cds | exec_cds.sh 新增 forwarder-run + install-forwarder 子命令,sudo 一次即可安装 systemd unit + 开机启动 |
| feat | cds | nginx 模板 cds_worker upstream 在 CDS_USE_FORWARDER=1 时切到 forwarder 端口(默认 9090) |
| refactor | cds | 蓝绿改为 opt-in:默认禁用 supervisor;需要重启用蓝绿设置 CDS_USE_BLUE_GREEN=1(原 CDS_DISABLE_BLUE_GREEN=1 仍兼容) |
| feat | cds | 「下载技能包」改为弹窗,提供技能口令(推荐)/海鲜市场/技能压缩包三种取技能方式 |
| fix | cds | 修复「Agent Key 已签发」弹窗中长 key 文本溢出对话框边界(项目级 + 全局级两个弹窗) |
| feat | cds | 「下载技能包」AI 口令补充版本去重指令 + 接入引导,弹窗增加跨 Tab「下一步」段落指引去拿 Agent Key |
| feat | cds | 新增系统级网络拓扑 API `GET /api/cds-system/network-topology`(B'.6),返回 domains / nginxUpstreams / forwarder / adminDaemons / containers / edges 完整图,前端 ReactFlow 可直接消费;每节点带 dataSource 标识(config / mongo / nginx-conf / process-self / http-probe / docker / file)便于运维定位 |
| feat | cds | TopologyAggregator 一致性检查覆盖 mongo-vs-forwarder / forwarder-vs-docker / active-color-mismatch / nginx-vs-admin 四种漂移,任一不一致 payload 顶层 `healthy=false` + `inconsistencies[]` 列具体差异 |
| feat | cds | Dashboard 顶栏新增 BuildShaChip:显示 `build: <8位 sha> · <color>` + 30s 轮询 /api/self-status,支持 normal / standby / switching / drift / offline 五种状态;gitHead 与 activeDaemonSha 不一致时变红 + 闪烁 + tooltip 漂移信息,点击跳转 `/cds-settings#maintenance` |
| test | cds | 新增 `tests/topology/network-topology-api.test.ts`(20 case)+ `tests/topology/build-sha-chip.test.ts`(12 case)覆盖 C-1.8 / C-6.2 / C-6.3 / C-7.1 / C-7.5 验收点 |
| fix | cds | cdscli preflight：onboard 前检查 reposBase，避免创建不可部署的半成品项目（issue #537） |
| feat | cds | 新增 cdscli preflight 独立命令：检查 CDS_HOST/认证/reposBase 全套前置条件 |
| feat | cds | 新增 cdscli import 命令：将已有 compose 文件直接提交 CDS，不重新扫描（issue #538/#539） |
| fix | cds | 修复 approveUrl 双 scheme bug（CDS_HOST 已含 https:// 时再拼接导致 https://https://...） |
| fix | cds | verify 对 CDS_*_PORT/_HOST/_URL 等运行时变量降级为 INFO，不再误报 ERROR（issue #538） |
| feat | cds | verify 支持直接传入文件路径（如 cdscli verify cds-comose.yml），不再要求标准文件名 |
| feat | cds | verify PyYAML 缺失时自动尝试安装，失败时给出平台特定手动命令 |
| feat | cds | scan 支持 Java/Maven/Spring Boot 多模块项目识别，生成 spring-boot:run 命令 |
| feat | cds | scan 自动读取 vite.config.ts/js 中的 server.port，不再把所有 Vite 服务硬编码为 3000 |
| feat | cds | scan 生成 YAML 自动填充 x-cds-project.repo（从 git remote get-url origin 读取） |
| fix | cds | project list/show 默认脱敏（customEnv/agentKeys 等），加 --include-sensitive 显示全部 |
| fix | cds | 删除 _emit_scan_result 中重复的 apply_to_cds 死代码块 |
| fix | prd-admin | 海报弹窗 1.5s 自动 markSeen 不再关闭 modal —— 之前 dismiss(id) 同时把 id 加入 closedIds 导致 shouldShowCurrent 变 false，modal 立刻消失。改为 markSeen 静默写后端 SeenBy + sessionStorage，dismiss 仅在用户主动  时调用 (Codex P1) |
| fix | prd-api | CronEvaluator 现在按 schedule.Timezone 解释 cron 字段（默认 Asia/Shanghai），cron "0 9 * * *" 真正落在 09:00 CST = 01:00 UTC 而非 09:00 UTC = 17:00 CST。Controller create + WorkflowScheduleWorker 的 next 计算路径都串通 timezone 参数 (Codex P2) |
| test | prd-api | WorkflowSchedule_DefaultValues 断言适配新 nullable CronExpression：Assert.Empty → Assert.Null + 增加 Mode 默认值断言 |
| fix | prd-api | CronEvaluator dom/dow 改为 Vixie/POSIX OR 语义 — `0 9 1 * 5` 现在按"每月 1 号 OR 每周五 9 点"匹配（之前是 AND，要求同时满足，导致漏触发）(Bugbot Low) |
| fix | prd-api | CronEvaluator 跳过 DST spring-forward gap — `tz.IsInvalidTime(t)` 命中时 skip 这一分钟而不是抛 ArgumentException（避免 worker 永久禁用调度 + controller 误报"Cron 不合法"）(Bugbot Medium) |
| test | prd-api | 新增 5 个 CronEvaluator 单元测试：timezone 转换、UTC 默认、dom/dow OR 语义、DST gap 不抛、字段校验 |
| fix | prd-api | doubao-asr 异步字幕生成路径走 JSON body (audio_data base64)，不再传空 multipart；DoubaoAsrTransformer 只读 standardBody，之前 100% 失败 |
| fix | prd-admin | DocumentStorePage 用 AnimatePresence 包裹字幕/再加工 Drawer，让 Wave 1 加的 motion exit 动画（spring 滑出 + backdrop 淡出）能正常播放 |
| feat | cds | self-update + self-force-sync 接 body.force=true,跳过 no-op fast-path 让"重复测试同一版本更新"成为可能 |
| feat | cds | "强制更新"按钮真的强制 — POST {force:true} + 文案说明会跳过 no-op 短路 |
| chore | cds | Phase A web-only 路径端到端验证 commit — 只改 MaintenanceTab tooltip 一个词("不重启"→"持续在线"),期望 force-sync mode=web-only daemon 不重启 |
| feat | cds | self-update / force-sync 新增"零停机·前端"档位 — 改动全部在 cds/web/src/** 时只重 web/dist + atomic rename,daemon 不重启 nginx 不动,刷新页面立即生效 |
| feat | cds | GlobalUpdateBadge SSE 解析 done.mode,零停机档不再触发"CDS 重启中"全屏 overlay |
| feat | cds | 维护页历史区新增 web-only / doc-only 两个 chip + tooltip,运维一眼分得清"前端零停机 vs 后端重启" |
| fix | cds | 紧急修:nginx 主模板已切到 include cds-active-upstream.conf,但 docker compose volumes 新加的 mount 必须重启容器才生效。改用 docker cp 把 host 文件注入运行中的 cds_nginx 容器,无需重启容器,业务流量不断。bootstrap 启动也立即 cp 一次 + reload,确保任何 nginx reload 链路安全 |
| fix | cds | C-4.1 严重漏洞修复:/api/_internal/promote 公网可调 — nginx 反代下 socket.remoteAddress 永远是 127.0.0.1,IP 校验完全失效。改用 token 双因子认证(随机 256-bit secret 落 .cds/internal-token 0600,timing-safe 比对) |
| feat | cds | 蓝绿默认开启 — 去掉 CDS_ENABLE_BLUE_GREEN 开关,supervisor 实例化即默认走蓝绿。CDS_DISABLE_BLUE_GREEN=1 仍是紧急熔断。运维零额外配置 |
| feat | cds | nginx 主模板用 `include cds-active-upstream.conf` 替代 inline upstream — 蓝绿 reload 切流的物理基础;首次启动 exec_cds.sh 自动创建该文件 |
| feat | cds | bootstrap 启动 ensure cds-active-upstream.conf 存在 + 写当前 active 端口 — 兜底 nginx 容器 mount 到不存在的文件路径 |
| feat | cds | 蓝绿失败 fallback 时流水带 blueGreenAttempted/Reason/Stage 字段;UI 历史区显示红色 "蓝绿失败 → 已回退" 副 chip + 维护页顶部红色告警横幅(近 1 小时内才显示) |
| feat | cds | Phase B' 控制面/数据面分离 + 蓝绿部署 — 7 阶段累计 +202 测试 / 1484 全绿 / 6747 行新代码 |
| feat | cds | admin daemon --standby 模式 + /api/_internal/promote 激活 + 严格回环 IP 校验(B'.2,a007f467) |
| feat | cds | nginx-upstream-writer 原子写 + nginx -t + reload + 回滚(B'.4,4fc24d5e) |
| feat | cds | graceful-shutdown SIGTERM drain SSE/worker/mongo flush + 30s 兜底 — 已接入 SIGTERM,单进程旧路径也立即受益(B'.3,8293107f) |
| feat | cds | forwarder 4 模块 — route-resolver / mongo-watcher+JSON fallback / HTTP+SSE+WebSocket 反代 / 诊断接口(B'.2-fwd,2aff8680) |
| feat | cds | blue-green-supervisor 编排器 — spawn → healthz → nginx → promote → shutdown + 自动熔断 + 锁文件防并发(B'.3+,8c80dabb) |
| feat | cds | network-topology API + Dashboard build-sha chip + 漂移检测(B'.6,57a596a0) |
| feat | cds | self-update / force-sync 接入 supervisor + UI mode='blue-green' chip(B'.5,0299eddc),CDS_ENABLE_BLUE_GREEN=1 启用,默认零退化 |
| docs | cds | doc/guide.cds-blue-green-rollout.md 上线运维手册 + Step 1-6 + 1 行回退 + 8 条 UAT 验收 |
| docs | cds | Phase B' 控制面/数据面分离 + 蓝绿设计文档 doc/design.cds-control-data-split.md |
| docs | cds | Phase B' MECE 8 维度验收清单 doc/spec.cds-blue-green-mece-acceptance.md |
| test | cds | TDD 测试 spec 骨架 12 套(186 个 it.todo),与 MECE 用例 ID 一一对应,作为 sub-agent 实现契约 |
| feat | prd-api | WeeklyPosterAnnouncement 加 SeenBy: List<string>（已看过的用户ID）；GET /current 过滤掉当前用户已读，新增 POST /api/weekly-posters/:id/mark-seen 端点（AddToSet 去重） |
| feat | prd-admin | 海报弹窗"已读"改走后端持久化：weeklyPosterStore.dismiss 调 markWeeklyPosterSeen API；用户登录看过一次后跨会话/跨设备都不再弹，发布了新海报（不同 id）时所有用户再弹一次 |
| fix | prd-api | ControllerIdentityExtensions 补 GetUserIdOrNull 扩展（替代 WeeklyPosterController 用过但未声明的 helper） |
| fix | prd-admin | 修复 Cmd+K 命令面板「最近使用」区同一项重复出现的问题（v2/v3 ID 规范化迁移残留 + 服务端脏数据合并）；新增 v3→v4 migrate 与 loadFromServer 写入前去重 |
| fix | prd-api | 根治存储后缀错误：SaveAsync 新增可选 fileName/extensionHint 参数，优先用原始扩展名而非 mime 反推；3 套 storage 实现（Local/COS/R2）默认 fallback 从 .png 改 .bin |
| fix | prd-api | DocumentStoreController 上传时把 file.FileName 传给 SaveAsync，解决 .m4a 等被强存为 .png 导致 CDN 按图片处理 |
| fix | prd-admin | AudioWavePlayer 改用 MediaElement 模式（套 HTMLAudioElement），跨域音频不再走 fetch+CORS；onTimeUpdate 用 ref 隔离避免反复重建重复 fetch |
| fix | prd-api | LocalAssetStorage 用文件系统通配 {sha}.* 取代硬编码扩展名列表，支持 ResolveExtension 决定的任意后缀（mp3/m4a/pdf/bin 等），不再把新格式文件读不到/删不掉 |
| docs | doc | debt.asset-storage 登记三套 storage helper triplicate（S-1）+ 历史 .png 错存对象迁移（S-2/S-3）+ scope 外 P1/P2 bug（X-1/X-2/X-3）|

### 2026-05-07

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | actor-resolver 新增 X-CDS-Trigger header 识别(优先级最高) — 内部 webhook/slash 触发的 localhost 自调能自标 'system:webhook',前端 chip 区分手动 vs 自动部署 |
| fix | cds | GitHub branch delete event 现在同时返 stopRequest + branchDeleteRequest — webhook 主路由收到后 stop 容器 + 3s 延迟后 DELETE entry/worktree,根治"分支已删但 CDS 端没清理"+ 后续 deploy 拉不到 origin/<ref> 报 fatal |
| feat | cds | 项目活动日志 actor 改 chip 渲染:GitHub Webhook(蓝)/PR 指令(蓝)/AI(紫)/用户(绿)/系统(灰),原文 hover 提示 |
| fix | cds | "CDS 不可达 Ns" banner 点击主体不再 no-op,改为主动调 triggerManualRefresh,SSE fallback polling 卡死时用户能手动 reset banner 状态 |
| fix | cds | 主题切换浮动按钮从 z-[70] 右上角 → z-[5] 右下角,不再遮挡 TopBar 的「运维 / 设置」等 nav 按钮(用户反馈"右上角按钮被皮肤挡住") |
| fix | cds | runInProcessWebBuild fast-path 命中时清理残留 .build-error，避免 transient 失败留下的 stale 错误被新一次"成功复用"压不掉（Codex P2 报告） |
| fix | prd-admin | SkillAgentPage 的 showToast 加 useRef 缓存 timer 句柄 + clearTimeout，连续触发时新 toast 不会被旧 setTimeout 提前关掉；卸载时统一清理（Bugbot Low 报告） |
| feat | cds | BranchCard 还原标签 chips + 单标签 add/remove + 顶部过滤栏（旧 legacy 已有，新栈 React 漏迁） |
| fix | cds | 修复 validateBuildReadiness 的 tsc telemetry：tscCdsStart / tscWebStart 原本都在 Promise.all 之前同步取，导致 tsc_cds_ms 和 tsc_web_ms 都等于 wall-clock max(cds, web) 而非各自耗时。改用 timed() helper 在每个 promise 内部各自起点，反映真实并行耗时（Bugbot d5ad90f 报告） |
| feat | cds | 部署 tab 失败步骤内联展示真实容器日志：当 deploy / verify 阶段失败时，PhaseTree 在错误提示下方直接渲染失败服务的 docker logs 末尾内容，无需点击"查看完整日志"跳转 |
| fix | cds | 一次性启动迁移：扫描所有 BuildProfile，hotReload.mode === 'dotnet-watch' 全部升级为 'dotnet-run'，根治"worker 跑 24h 前旧字节码"问题（举报报告所述） |
| fix | cds | 修复 POST /api/build-profiles/:id/hot-reload 的 type union 漏 dotnet-run / dotnet-restart 选项，前端 dropdown 现在能合法提交这两个模式 |
| feat | cds | CDS 系统设置「更新与重启」UI 简化:删「预检」按钮 + 删右侧「预检结果」卡片(预检逻辑保留在更新内自动跑) |
| feat | cds | 「强制同步」按钮改名「强制更新」,提示文案去技术黑话,改用通俗语言 |
| feat | cds | 自更新历史 entry 新增「完整步骤」展开:点击折叠按钮看当时跑的每一步 SSE 日志 + 时间戳 + level 颜色,根治"尚未执行更新"幻觉 |
| fix | cds | 最后检查发现「强制同步」3 处文案残留(trigger 标签映射 + history label)+ 后端 API label,统一改成「强制更新」 |
| fix | cds | 运维抽屉彻底去 useState toggle,直接显示运维内容 — 用户反馈"还是灰色"根因消除 |
| feat | cds | OpsDrawer 顶部加「清理孤儿」按钮 — 调 POST /api/cleanup-orphans 扫描 origin 远端,清掉本地有但远端已删的分支 worktree + 容器 + entry |
| fix | cds | Webhook 日志「忽略」chip 加 tooltip,详细解释 5 类 dispatchAction 含义;后端 dispatchReason 文案"未订阅"改成"不在 CDS 处理范围(只处理 push/pull_request 等 10 类)" |
| fix | cds | 分支卡命中高亮 pulse 时长 5000ms → 9000ms,节奏从 4 次脉动加到 5 次明显脉动 + 22% 慢淡出尾段,根治"还是看不清"反复反馈 |
| fix | cds | pulse 高亮 transition 冲突修复 — BranchCard 自身 `transition-[box-shadow] duration-150` 拦截 animation 每帧导致退化成 200ms 闪烁,加 `transition:none!important` 让 9s 动画完整播放 |
| fix | cds | flashBranchCard 用 flushSync 强制 commit null 后再设 branchId,根治"第二次点同一分支没效果"(React 跳过同 value setState 让 CSS class 不变 animation 不重启) |
| fix | cds | 分支卡 tag chips 行加 pb-3,标签距底部 horizontal divider 留出 12px 透气空间 |
| fix | cds | 卡片闪烁高亮从 1.6s 拉长到 5s，关键帧重排让"看清"的时段（峰值 + 双脉动）维持 8-78%，避免一瞬间就闪没 |
| fix | cds | 标签删除前增加 confirm 弹窗，防止 hover ×误点 |
| perf | cds | self-update 后端/前端 tsc 各加一层 .tsc-input-sha 子树锚点 fast-path：相关子树未变就跳过 tsc，命中时省 5-30s |
| fix | cds | 顶部搜索框粘贴分支名后不再跳转到详情页：已跟踪命中走 pulse 高亮卡片（橙色光晕 1.6s + 滚动到中央），未跟踪走"添加 + 高亮"，与旧版保持一致 |
| fix | cds | self-update 路由切完 git 后必须 in-process 重编 cds/dist/ — 复用 force-sync 同款 esbuild + atomic dist.next rename 模式,失败时旧 dist 保留 daemon 不重启,根治 PR #529 后 connections/issue 永远 404 + actor 永远 unknown |
| perf | cds | self-update lockfile-hash fast-path：cds + cds/web 的 pnpm-lock.yaml + package.json 哈希命中 stamp 时跳过 pnpm install，单次 self-update 节省 30-50s |
| perf | cds | 自更新弹窗 healthz 轮询从 1.5s ×40 改为 0.5s ×60，密度 ×3，daemon 起来后 perceived 检测延迟从 750ms 平均降到 250ms；OK 后 reload 延迟从 600ms 缩到 200ms |
| fix | cds | self-update 进度状态从内存搬到磁盘(.cds/active-update.json),修复 actor=unknown / 卡 web-build 看不见日志 / 进程重启后状态消失三大幻觉 |
| test | cds | 新增 13 个 active-update-store 集成测试,实测跨进程读盘恢复 / stale pid 探测(用 spawnSync 取真死 pid)/ logTail ring buffer / 幂等保护 |
| chore | docs | CLAUDE.md §8.1 新增"自测优先"强制规则:AI 必须先穷尽集成测试 / cds-deploy / bridge / WebFetch 四条自测路径,禁止把校验责任先交还给用户 |
| feat | cds | self-update 加每段实际耗时埋点：runPnpmInstallWithCache 返回 _timing.ms，validateBuildReadiness 返回 timings 字典（install_cds_ms / install_web_ms / tsc_cds_ms / tsc_web_ms / total_ms 全含 _skipped 标记）；route handler 通过 SSE 'timings' 事件 + step 'validate-timings' 把毫秒喷到自更新弹窗 |
| fix | cds | 修复访问预览域名总是触发"销毁并重建容器"的 bug：自动构建路径在 entry.status==='running' 且所有服务都在跑时跳过 docker rm -f && docker run，仅刷新 lastAccessedAt 后直接发 complete |
| fix | cds | 删除分支列表左上角"X 分支 · X 运行 · X/X 容器"概览数字（占位且分散注意力） |
| fix | cds | 分支抽屉未运行时显示提示文案 + footer 多出"重新部署"主按钮，解决"停止莫名其妙、没有启动按钮"的体验断点 |
| feat | cds | systemd unit 自动同步：daemon 启动时如果检测到 /etc/systemd/system/cds-master.service 与 repo 模板 drift（且当前是 root），自动重写 + systemctl daemon-reload + 备份旧文件，UI drift banner 永远不再要求用户手动 sudo |
| docs | cds | 新增 report.cds-self-update-timing-audit.md — 用户卡 1 小时痛点 10 天审视报告 + 业界对照 + 三阶段方案 |
| feat | cds | Phase 1 落地:CdsState.daemonReadyAt 字段 + index.ts server.listen 后盖戳 + recordSelfUpdate 回填上一条 totalElapsedMs |
| feat | cds | 历史抽屉 entry 显示双值 "X.Xs 流程 + Y. Ys 重启" — title 鼠标悬停看分解。SelfUpdateRecord.totalElapsedMs 后端 + 前端类型同步 |
| fix | cds | tsc-input-sha 子树锚点把 cds/pnpm-lock.yaml 与 cds/web/pnpm-lock.yaml 加进 git log path，覆盖"pnpm update 改 lockfile 但不改 package.json"导致 .d.ts 类型变化但 tsc 仍 skip 的边角（Bugbot Low 报告） |
| feat | cds | wave 1.1 — OpsDrawer 内 details 改 useState,运维抽屉点击不响应根因修复 |
| feat | cds | wave 1.2 — 项目活动日志 entry 可点击展开看完整字段 + failed/error/aborted 三类状态彩色高亮 |
| feat | cds | wave 1.3 — 容量超限交互式选择停哪个分支 + 自动重试部署(legacy checkCapacityAndDeploy 三件套迁) |
| feat | cds | wave 1.4 — ClusterTab 调度策略可切换(capacity-aware / least-branches / random)走 PUT /api/cluster/strategy |
| feat | cds | wave 2.1 — BranchTopologyPage 加全屏 toggle 按钮(Maximize2,toggle requestFullscreen/exitFullscreen) |
| feat | cds | wave 2.3 — 新增 ConfigSnapshotsTab(列表/创建/回滚)+ CdsSettingsPage 注册到「运行时」组,后端 /api/config-snapshots 已齐 |
| feat | cds | wave 2.4 — 分支页 Tag filter bar 从只显示激活态 → 列出所有 tags 横排,点 chip 切换过滤,激活态高亮 |
| feat | cds | wave 3.2 — GlobalUpdateBadge restarting 状态超过 5s 显示全屏半透 backdrop + spinner + 倒计时,点 backdrop 立即重试 |
| feat | cds | wave 3.3 — CommandPalette STATIC_ACTIONS 从 2 项扩到 12 项(覆盖 CDS 系统设置全部 tab + 维护操作),中文关键词模糊匹配 |
| chore | cds | wave 2.2 + 3.1 — AI 占用 feed / 代理日志 modal 因后端缺字段(aiOccupant)/缺端点(nginx access log)阻塞,已在 plan 文档标 |
| perf | cds | self-update web build 增第二级 fast-path：通过 `git log -1 -- cds/web` 锚点判断 cds/web 子树自上次构建以来是否变过，未变则复用 dist + 滚动 .build-sha 到当前 HEAD，纯后端改动的自更新省掉 30-90s vite build |
| feat | cds | CDS 系统设置新增「GitHub Webhook 日志」tab — 列表展示每次 hook 投递,点击展开看 deliveryId / 耗时 / 验签状态 / dispatch 决策 / payload(截断 4KB);ring buffer 200 条上限 |
| feat | cds | 后端 GET /api/cds-system/github/webhook-deliveries + state.recordGithubWebhookDelivery + github-webhook 路由 res.on('finish') 监听写日志(成功失败均记录) |
| feat | cds | BranchListPage kebab 菜单新增「重新生成」按钮 — 调已有 force-rebuild 端点遍历分支所有 profile 重建,适用 vite 卡住等异常状态 |
| feat | prd-api | 博主作品订阅胶囊扩展支持 5 平台（TikTok / 抖音 / B 站 / 小红书 / YouTube），按 platform 分发到 5 个 normalizer 输出统一 schema |
| feat | prd-api | 新增 media-rehost 胶囊，items 数组里的视频/封面/头像 URL 下载到 COS 替换为稳定直链，绕开 CDN 防盗链 403 |
| feat | prd-api | weekly-poster-publisher 新增 feed-card 版式（presentationMode），并把 page schema 扩到 7 个新字段：authorName / avatar / platform / durationSec / hashtags / stats / transcriptCues |
| feat | prd-api | video-to-text asr 模式从豆包 ASR utterances 抽取毫秒级时间戳写入 item.transcriptCues，给前端字幕浮层用 |
| feat | prd-api | 5 个 normalizer 全部透出 author / avatar / duration / stats / hashtags 字段（TikTok statistics、B 站 length 字符串、小红书 interact_info 等）|
| feat | prd-admin | PosterFeedCardView 组件实现抖音/小红书风格 9 信息单元布局：头像 + @ 用户 + 平台 chip + 时长 + 视频 + 互动 chip + 字幕浮层 + 标题 + 标签 |
| feat | prd-admin | feed-card 模态视频比例自适应：检测 videoWidth/Height 三档切换 9:16 (460px) / 4:3 (760px) / 16:9 (920px) |
| feat | prd-admin | 海报弹窗 X 按钮重定义为「收起到右下角胶囊」，胶囊上的  才彻底 dismiss。仿 Slack PiP / 抖音 reminder 模式 |
| feat | prd-admin | feed-card 视频播放时挂 timeupdate listener，二分查找 currentTime 命中的 cue，渲染半透明字幕浮层 |
| feat | prd-admin | 多平台模板加 PLATFORM_OPTIONS / PLATFORM_CTA_LABELS / PLATFORM_ID_HELP 共享常量，两个工作流模板都自动支持 5 平台下拉切换 |
| feat | prd-admin | 工作流模板默认插入 media-rehost 节点（fetch → rehost → publish），rich-text 模板里 rehost 在 ASR 之前防止短期签名 URL 二次过期 |
| fix | prd-api | WeeklyPosterPageDto 同步透出 7 个新字段 + TranscriptCues，否则 GET /api/weekly-posters/* 永远返回 null |
| docs | doc/ | 新增 guide.poster-feed-card 用户教程；plan.emergence-1 加 §3 Phase 3 已交付段；debt.workflow-agent 升 v2.0：Phase 2 留尾 7 项 paid + 5 项 Phase 3 新债 |
| feat | prd-api | 新增 InfraConnection model + InfraConnectionService + /api/infra-connections Controller，落地 spec.cds-map-pairing-protocol MAP 端：剪贴板配对密钥解析、调对端 CDS accept、IDataProtector 加密 longToken 落库 |
| feat | prd-admin | 基础设施服务页面从占位升级为真实功能：连接 CDS 弹窗（粘贴+实时预览 base URL 钓鱼防护）+ 已连接列表（探活/删除）+ 状态 chip + 路线图卡片 |
| feat | prd-api | AppSettings 新增 MapInstanceId 字段（首次配对时 lazy 生成，spec §3.2 mapId 协议字段） |
| fix | cds | routes/cds-system-connections.ts accept 端字段映射 bug：MAP 端发 mapId/mapName/mapBaseUrl，但 routes 之前读 partnerXxx，导致配对永远失败报 partner_info_missing。修后兼容两种命名（mapXxx 优先），13 个 pairing 单测继续全绿
| docs | doc | 新增 doc/guide.infra-sandbox-agent.md 主篇（基础设施建设 - 沙箱 Agent SSOT），含设计思路 / 历程决策表 / 架构图 / 组件位置 / 操作步骤 / 预计结果 / 测试方法 / 链路追踪 / 已知问题 / 后续路线 / 关联文档 / 历史背景
| docs | doc | 删除已被主篇消化的 3 个冗余文档：plan.cds-shared-service-extension.md（决策已并入主篇 §1.3+§2）/ plan.sidecar-server-management.md（备用方案历史已并入 §2）/ report.cds-shared-service-mvp-runthrough.md（沙箱实测已并入 §7.2）
| feat | prd-admin | 海报编辑页新增「新建自动发布」入口：选工作流 + 填变量（博主id/视频个数）+ 选 presentationMode/templateKey/品牌色，支持立即执行 / 定时一次 / 循环 (Cron) 三种调度 |
| feat | prd-api | 新增 `/api/workflow-agent/schedules` CRUD 端点 + `WorkflowScheduleWorker` 后台轮询，按 once/cron 触发工作流；内置极简 5 字段 Cron 解析器 |
| feat | prd-api | WeeklyPosterPublisher capsule 的 templateKey/presentationMode/accentColor 现在支持 `{{var}}` 模板和 variables 兜底，让海报页对话框不必改工作流配置即可覆盖版式 |
| fix | prd-api | WeeklyPosterPublisher 找不到 items 字段时新增 TikHub raw 响应路径兜底（data.aweme_list / itemList / list / vlist 等），并在错误信息里列出顶层字段帮助用户排查 |
| feat | prd-admin | 横屏视频卡尺寸放大约 17%（feed-card 16:9 920→1100、ad-4-3 960→1120），并在 feed-card 模式给视频卡加 accent 色描边 + 顶部 4px 品牌色细带 + 有色光晕，让短视频卡看起来像「海报里嵌的视频」而不是「光秃秃的视频」 |
| fix | prd-admin | 海报编辑页 76% 缩放预览下标题溢出修复：把 PosterAdPageView / PosterRichTextPageView / WeeklyPosterPageView 的字号从 vw 改成 cqw（容器查询单位），字号跟随容器宽度自适应而非 viewport，缩放预览不再溢出 |
| fix | prd-admin | 9:16 竖屏首页弹窗也加大到 540px（+17.4%），4:3/16:9/ad-4-3 视口预算从 80px 缩到 40px 让 cap 在 1080p 屏上能用满 |
| fix | prd-admin | 海报编辑页缩放预览改用 transform:scale 而非缩小容器宽度，内部 DOM 永远在 1200×628 设计稿尺寸下渲染（vw 字号在容器内永远准确），76% 缩放下不再溢出也不再"更丑"；回滚上一轮的 cqw 改动 |
| fix | prd-admin | 海报缩略图（页面列表 / 素材卡 / 生成页卡）禁用 autoPlay loop，改用 preload="metadata" 仅取首帧当封面，多卡同屏不再消耗大量 CPU/GPU |
| fix | prd-admin | 海报编辑页主画布大图视频也改 preload="metadata"，避免编辑页一直在后台播放视频 |
| feat | prd-admin | 首页海报弹窗改为"每会话只弹一次"：弹出 1.5s 后自动登记已看过到 sessionStorage，同会话再进主页不重弹；浏览器关闭后下次登录视为新会话 |
| feat | prd-admin | AutoPublishDialog 立即执行后会轮询执行状态最多 60 秒，把首个失败节点的错误（节点名 + 错误信息）直接 toast 给用户，不再"秒过黑盒" |
| fix | cds | PR #529 Bugbot HIGH + Codex P2：sidecar-deployer 修复 SSH 命令注入 — image 用 isSafeDockerImage 正则白名单（[a-zA-Z0-9._-/:@] + 长度 ≤256）+ shellQuote 包裹；containerName / port 同步加守卫；routes/remote-hosts.ts 入口提前校验 image 合法性
| feat | cds | PR #529 Codex P1：新增 GET /api/projects/:id/instances 路由（spec.cds-map-pairing-protocol §3.2 instanceDiscoveryUrl 之前指向但未实现）；按 (hostId, latest startedAt) 聚合 ServiceDeployment.status='running' 实例返回 host:port + healthy + version；对应 server.ts 加中文 label「列出项目实例」
| fix | cds | PR #529 Bugbot MEDIUM：/api/cds-system/connections/issue 响应体不再单独返回 pairingToken 明文，仅返 connectionId / clipboardText / expiresAt（pairingToken 已嵌在 clipboardText 内），减少 access logs / proxy logs / devtools 中的足迹
| fix | cds | PR #529 Bugbot LOW：@types/ssh2 从 dependencies 移到 devDependencies，避免生产 install 拉入 @types/node + undici-types
| test | cds | sidecar-deployer-utils 单测增加 isSafeDockerImage / isSafeContainerSlug 两组（共 5 个新 case），覆盖 shell 元字符全集、空/超长/非字符串边界
| fix | cds | PR #529 二轮 Bugbot HIGH：上一轮自留的 sealed-secret round-trip bug —— remote-host-service 用 `typeof sealed === 'string' ? sealed : JSON.stringify(sealed)` 把 SealedSecret 折成 JSON 字符串，unsealToken 的 string 短路分支会原样返回，永远拿不回明文。改 `RemoteHost.sshPrivateKeyEncrypted/sshPassphraseEncrypted` 类型为 `string \| SealedSecret`，直接存对象；types.ts 顶部 import SealedSecret
| fix | cds | PR #529 二轮 Bugbot LOW：createSharedServiceProject 旧代码从 raw `acceptBody.partnerName` 读名字，但 controller 入口已把 `body.mapName \|\| body.partnerName` 映射进局部 partnerName 变量，新协议（MAP 发 mapName）下 acceptBody.partnerName 永远 undefined，project description 缺名。改成把已映射的 partnerName 字符串作为参数传进去
| fix | cds | PR #529 二轮 Bugbot LOW：cds/web ConnectionsTab `IssueResponse` 类型仍含 `pairingToken: string` 字段，但后端响应已删，改成只含 connectionId / clipboardText / expiresAt + 注释说明 token 嵌在 clipboardText 里
| test | cds | remote-host-service 新增 sealed-round-trip 测试：手工 set CDS_SECRET_KEY 触发 sealToken 走加密路径，断言 `sshPrivateKeyEncrypted` 是 `__sealed:true` 对象（不是 JSON 字符串），且 decryptRemoteHostSecrets 能拿回原明文
| fix | cds | PR #529 三轮 Bugbot MEDIUM：deploy-sidecar 路由只校验 `body.env` 是 plain object，没逐键校验 value 是 string；`null/number/object` 落到 `shellQuote` 调 `v.replace(...)` 会 TypeError。但 HTTP 202 已经发出，错误只能落到 SSE 部署日志。修：路由层 `Object.entries(env)` 逐个 typeof 校验，遇非字符串直接 400；并给 `shellQuote` 加 typeof guard 抛 TypeError（defense-in-depth，防止内部调用绕过）。新增 1 个单测覆盖 null/undefined/number/object 入参
| fix | claude-sdk-sidecar | PR #529 三轮 Bugbot LOW：`_check_token` 用 `!=` 比较 bearer token，存在 timing side-channel 风险。改用 `hmac.compare_digest(presented.encode("utf-8"), SIDECAR_TOKEN.encode("utf-8"))` 做 constant-time 比对；import 顶部加 `hmac`
| fix | claude-sdk-sidecar | PR #529 四轮 Bugbot MEDIUM：`run_agent` 里 `AsyncAnthropic` 客户端（内部含 httpx 连接池）从未 close，每次调用泄一份 fd / connection。把整段循环包到 try/finally，覆盖所有 yield/return 退出路径 + 调用方 aclose() 提前关闭场景，finally 里 `await client.close()`（异常 logger.exception 但不抑制原异常）
| fix | cds | PR #529 四轮 Bugbot LOW：删除 dead code `StateService.getEnabledRemoteHosts()`（PR 里新增但无任何调用方，调度路径都是 `getRaw()` 后内联检查 `host.isEnabled`）
| fix | cds | PR #529 四轮 Bugbot LOW：`GET /api/projects/:id/instances` 路由把 `(hostId, latest startedAt)` dedup 改为复用 `StateService.getLatestDeploymentsByProject()`（SSOT），消除路由 vs state.ts 两处同样聚合逻辑的维护风险
| fix | cds | PR #529 五轮 Bugbot MEDIUM：env keys 之前从未校验，含 `=` / 空格 / shell 元字符的 key 即使被 shellQuote 包裹，docker 端也会拿到 `-e 'KEY WITH SPACES'='val'` 这种非法语法。新增 `isSafeEnvKey` 工具（POSIX `[A-Za-z_][A-Za-z0-9_]*`，1-128 字符），路由层 + `renderEnvFlags` 双卡（route 给 400，render 抛 Error）。配套 4 组 isSafeEnvKey 单测 + renderEnvFlags 反例
| fix | cds | PR #529 五轮 Bugbot MEDIUM：deploy-sidecar 路由的 slug 推导原本是 `name.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 32)`，会产生 leading/trailing `-`、连续 `--`，且两个名字只差一个被 strip 的字符（`test!` vs `test@`）会算出同一 slug → 第二次 deploy 静默 `docker rm -f` 第一台 host 的容器。重构成 `deriveContainerSlug(name, hostId)`：折叠连续 `-` + trim 首尾 `-` + 截 22 字 + 始终追加 host.id 前 8 字保证唯一性；`isSafeContainerSlug` 也补强 reject 首尾 `-` 和 `--`。新增 7 个 deriveContainerSlug 单测（独立 tests/routes/remote-hosts-helpers.test.ts）+ isSafeContainerSlug 拒首尾 `-` 单测
| fix | cds | PR #529 五轮 Bugbot LOW：`gcExpiredPairingConnections` 用 ISO 字串 lexicographic 比较过期时间，虽然两边都是 `toISOString()` 输出 `Z` 后缀实际能跑通，但若外部源写入非 `Z` ISO（如 `+00:00`）就会静默错误。改用 `Date.parse(...).getTime()` 数值比较，NaN 时视作格式坏直接 GC 掉
| fix | cds | PR #529 六轮 Bugbot MEDIUM：`deriveContainerSlug` 的 `slice(0, 22)` 在 trim 之后做，会把诸如 `my-production-sandbox-server` 卡在尾部 `-`，与 idSuffix 拼成 `--` 被 `isSafeContainerSlug` reject → 部署直接 throw。修：slice 后再做一次 `replace(/-+$/g, '')` 二次 trim。新增 2 组单测覆盖具体边界 + 多种 slice 卡 `-` 场景
| fix | cds | PR #529 六轮 Bugbot LOW：`redactCmd` 的 `[^\s]+` 在 shell-quoted value 含空格时（如 `-e 'KEY'='hello world'`）只能捕到 `'hello`，后段 `world'` 仍泄漏。重构成两段 pipeline：Pattern 1 专门匹配 shell-quoted 形态（`'KEY'='VAL'`，VAL 用 `'(?:[^']|'\\'')*'` 匹配 shell escape），整段替换为 `'***'`；Pattern 2 匹配裸 key（POSIX env name 规范）单 token 值。POSIX key 限定让 Pattern 2 不会重复处理 Pattern 1 已替换的形态。新增 2 个单测：含空格的 quoted value 全屏蔽 + 含 `'\\''` 转义的 quoted value 全屏蔽
| fix | cds | PR #529 七轮 Bugbot LOW：service-deployments SSE `flush()` 每 500ms 轮询都无脑发 `status` 事件，多分钟部署（如慢 docker pull）积上千条同样的 status 事件。改成 `lastEmittedStatusKey` 幂等比较：用 `status/phase/message/seq` 拼 key，只在变化时 emit，初始快照仍正常发送
| feat | prd-admin | 技能创建助手「我的技能」Tab 恢复卡片级 SKILL.md 下载按钮（hover 显示），并新增 .md 导入弹窗（拖拽 / 选择文件 / 粘贴文本三通道） |
| feat | prd-admin | 新增 services/real/skillAgent.ts:exportPersonalSkillMd / importPersonalSkillMd 包装现有 /api/prd-agent/skills/{key}/export 与 /api/prd-agent/skills/import 端点 |
| feat | prd-admin | 我的技能 Tab 顶部新增「导入 .md」「创建技能」工具栏 + 全局 toast 反馈下载/导入结果，遵守 zero-friction-input.md 双通道原则 |

### 2026-05-06

| 类型 | 模块 | 描述 |
|------|------|------|
| perf | cds | self-force-sync cold path 不再重复跑 tsc — Bugbot 858bca04 (Medium):validateBuildReadiness 已跑过 tsc --noEmit,build-backend 阶段只跑 esbuild,节省 5-30s。hot path 仍并行 tsc(validate skipTsc=true) |
| fix | cds | /api/self-status catch fallback 补 activeSelfUpdate + systemdUnitDrift — Bugbot 50e705cf (Low):git fetch 偶发失败时 MaintenanceTab 跨 tab 同步 + drift banner 不再消失。drift 检测抽到顶层 helper detectSystemdUnitDrift,两路共用 |
| fix | cds | 修复 Cursor Bugbot 两条 Low Severity：SSE client 加进池移到 snapshot 写入之后（保证 snapshot → update 顺序）；config.ts 的 githubApp/publicBaseUrl 回归 module-level eager（与其它 env 字段一致，import './load-env.js' 已 spec 保证求值顺序），删 lazy 路径 |
| fix | cds | self-update / self-force-sync 路由顶层补 finally,Bugbot 31da8d97 (HIGH):recordFailure 自身抛错时 activeSelfUpdate 标记不再卡住 — 所有 tab 不再看到永久"自更新中"幽灵态。新增 `stateService.clearSelfUpdateActive()` 幂等清空 |
| perf | cds | self-force-sync 改动全是文档/changelogs 时改走 doc-only fast-path,Bugbot 7749d6f8 (Medium):写新 commit 的 .build-sha 后直接 return,跳过 validate + esbuild + tsc + atomic swap + restart(节省 ~70-95s) |
| fix | cds | exec_cds.sh master-run pnpm install 失败时 fail-fast(exit 78 EX_CONFIG)— Bugbot 982b38ca (Medium):lockfile 漂移 / pnpm store 损坏 / 磁盘满时不再静默继续启动 stale node_modules |
| fix | cds | self-force-sync doc-only fast-path 必须 irrelevantPaths > 0 — Bugbot da715c3c (Medium):空 diff(fromSha == newHead 但 .build-sha 缺失/不匹配)不再误命中 fast-path 写假 SHA,改走冷路径重新 build |
| fix | cds | self-status SSE 透传 activeSelfUpdate — Bugbot 59568cb0 (Medium):GlobalUpdateBadge 收到 SSE 后 dispatch CustomEvent,MaintenanceTab 监听后实时跨 tab 同步,不再依赖 30s 轮询 |
| fix | cds | 修复 Codex P2 review：computeSelfStatusPayload 给 currentBranch 加 isSafeGitRef shell injection 守卫；self-force-sync in-process build 改 atomic dist swap（编译到 dist.next/ → 验证 → 原子三步替换 → 清备份），任何阶段失败旧 dist 完好 |
| feat | cds | spec.cds-map-pairing-protocol.md v1：剪贴板配对密钥协议（base64url JSON + 一次性 pairingToken + 长效 cdsLongToken），定义 issue / accept / authenticate 三段 handshake + 安全模型 + MAP↔CDS 责任划分 + 未来非标 executor 扩展点
| feat | cds | types.ts 加 CdsConnection（pending-pairing/active/revoked 状态机）；CdsState.cdsConnections 集合
| feat | cds | services/connection/pairing-service.ts：CdsPairingService（issue + accept + authenticateLongToken）+ encodeClipboard/decodeClipboard/sha256Hex 纯函数；token 仅存 SHA256，明文不出库
| feat | cds | routes/cds-system-connections.ts：5 端点（POST /issue + /accept + /:id/revoke、GET 列表/单条、DELETE）；accept 自动创建 shared-service Project；server.ts resolveApiLabel 同步 6 条中文 label
| feat | cds | CDS 系统设置 → 运行时 → 「对接 MAP」tab：列表 + 创建密钥 dialog + 一键复制到剪贴板 + 已连接 status chip + 撤销/删除按钮
| feat | prd-api | InfraConnection model + IInfraConnectionService + InfraConnectionService（IDataProtector 加密 longToken / probe / paste 调 CDS accept），InfraConnectionsController 提供 /api/infra-connections/{paste,list,probe,delete}
| feat | prd-api | AppSettings.MapInstanceId 首次 paste 时 lazy 写入 prd_agent_meta，让对端知道 MAP 实例标识
| feat | prd-admin | InfraServicesPage 从 wip 占位改造为真实功能：「连接 CDS」按钮 + 粘贴 dialog（实时显示解析出的 CDS BaseUrl 防钓鱼）+ 列表 + 探活/删除；navRegistry 移除 wip:true
| test | cds | tests/services/connection/pairing-service.test.ts 13 个：encode/decode round-trip、issue/accept 状态机、token 错误码（not_found/expired/used）、authenticateLongToken
| docs | doc | 新增 doc/report.cds-shared-service-mvp-runthrough.md：本机零污染端到端 MVP 演示报告（注入 deployment 绕过 SSH，验证协议契约 + sidecar 真流式 LLM 调用，输出"柳絮轻飘，花开满径。"）
| feat | cds | 新增 cds/scripts/mvp-demo.ts：tsx 跑的一次性脚本，临时 state.json + mini express + 直连 sidecar 端到端验证；隔离设计（mkdtemp + 9991 端口避开正式 9900），跑完自动清理；不进 npm scripts 不进 server.ts，零侵入
| feat | cds | SidecarDeployer 重构：以 RemoteHost + SidecarSpec 为部署单位（不绑 Project），公开 testConnection 用于真实 SSH 连接验证
| feat | cds | 新增 POST /api/cds-system/remote-hosts/:id/deploy-sidecar 端点：异步启动 5 阶段部署，返回 deployment id 与 streamUrl
| feat | cds | 新增 GET /api/cds-system/remote-hosts/:id/instance（主系统消费）+ /deployments（历史）+ /service-deployments/:id + /service-deployments/:id/stream（SSE 流式日志，断线续传 afterSeq）
| feat | cds | POST /api/cds-system/remote-hosts/:id/test 接入真实 SSH echo，结果写入 host.lastTestedAt / lastTestOk
| feat | cds | RemoteHostsTab 新增「测试连接」「部署 sidecar」「查看实例」按钮 + SSE 进度抽屉（5 阶段日志实时滚动 + 状态 chip）
| feat | prd-api | 新增 IDynamicSidecarRegistry + DynamicSidecarRegistry：合并 appsettings 静态 Sidecars[] 与 CDS 实例发现 API 返回的远程主机
| feat | prd-api | 新增 CdsSidecarSyncService（HostedService）：周期 GET CDS /remote-hosts + /instance，自动把 CDS 部署的 sidecar 加入路由池
| feat | prd-api | ClaudeSidecarRouter / ClaudeSidecarHealthChecker 改读 IDynamicSidecarRegistry，PickInstance 静态 + CDS 动态合并
| feat | prd-api | ClaudeSidecarOptions 增加 CdsDiscovery 配置段（Enabled/BaseUrl/RefreshIntervalSeconds/SharedSidecarToken/CdsAuthHeader）
| test | cds | 新增 21 单测：sidecar-deployer-utils（redactCmd 脱敏、shellQuote 防注入、renderEnvFlags）+ remote-host-service（创建/更新/口令清空/test 结果记录）
| feat | cds | 新增 ProjectKind 'shared-service'：长生命周期共享基础设施服务（如 claude-sdk sidecar）的部署目标
| feat | cds | types.ts 新增 RemoteHost / ServiceDeployment / ServiceDeploymentLogEntry 接口；Project 新增 serviceImage / servicePort / releaseTag / targetHostIds / serviceEnv 字段
| feat | cds | StateService 新增远程主机 CRUD + ServiceDeployment append-only 历史，SSH 凭据走 sealToken（AES-256-GCM）加密
| feat | cds | 新增 /api/cds-system/remote-hosts CRUD（系统级，符合 scope-naming.md §3）；resolveApiLabel 同步补 6 条中文 label
| feat | cds | 新增 SidecarDeployer 5 阶段部署引擎骨架（connecting / installing / verifying / registering / running），ssh2 npm 依赖
| feat | cds | CdsSettingsPage 新增「远程主机」tab（运行时分组），列表 + 录入表单 + 启用/禁用切换
| docs | cds | 详见 doc/plan.cds-shared-service-extension.md
| feat | claude-sdk-sidecar | 支持上游切换：env 全局 / per-request baseUrl+apiKey / 命名 profile yaml 三档配置，覆盖 cc-switch / DeepSeek / Kimi / GLM / 自建网关
| feat | claude-sdk-sidecar | 新增 profiles.example.yaml + profiles.py 加载器（PyYAML，${VAR} env 占位符替换），文件不存在静默跳过
| feat | prd-api | SidecarRunRequest + ExecuteCliAgent_ClaudeSdkAsync 增加 profile / baseUrl / apiKey 字段，节点 JSON 透传到 sidecar
| feat | docker | docker-compose.dev.yml 暴露 ANTHROPIC_BASE_URL + DEEPSEEK_API_KEY 等供应商 env，加 host.docker.internal 别名让容器能回宿主访问 cc-switch
| docs | doc | guide.claude-sdk-quickstart.md 增"切换其他模型 / 上游"章节（4 表格 + 3 档配置 + 实测证明）
| feat | prd-admin | 周报海报新增 ad-rich-text 版式（左侧 9:16 动态封面 + 右侧 hook 大字 + bullets，点 Play 切回全屏视频） |
| feat | prd-api | weekly-poster-publisher 胶囊 presentationMode 选项追加 ad-rich-text |
| docs | prd-api | WeeklyPosterAnnouncement.PresentationMode 注释同步实际支持的三种模式 |
| feat | prd-api | video-to-text 胶囊新增 asr 模式：下载视频 → ffmpeg 抽音 → 豆包流式 ASR → 可选 LLM 提炼 hook + bullets，输出兼容数组/单对象 |
| feat | prd-api | AppCallerRegistry 新增 video-agent.video-to-text::asr 入口供 ASR 模型池绑定 |
| feat | prd-api | weekly-poster-publisher 渲染 page 时优先使用上游 item.hook / item.body 字段，未提供时走原 @author+#aweme+desc 兜底 |
| feat | prd-admin | 新增模板「TikTok / 抖音 博主订阅 → 首页图文混排海报 (ASR)」，4 节点串联手动触发 / 拉视频 / ASR + hook / 发布 ad-rich-text |
| feat | prd-admin | 新增「基础设施服务」占位入口 (/infra-services, wip=true)：claude-sdk sidecar 等共享服务的实例分布、路由策略与业务监控的未来归属，目前仅展示责任划分与路线图
| docs | doc | 新增 doc/plan.sidecar-server-management.md（冻结主系统自建 SSH 部署方案为备查计划）
| docs | doc | 新增 doc/plan.cds-shared-service-extension.md（提议 CDS 扩展 ProjectKind=shared-service，承担部署/编排/健康/升级，主系统只做消费侧路由）
| fix | scripts | release-prepare CHANGELOG 重写：当 [未发布] 上一行非空时，分隔空行误用 append 加到了下方（应在上方）。改为 insert(0, '')。当前 CHANGELOG 格式不触发但写错了。修复 PR #528 Bugbot review |
| refactor | prd-admin | AiChatPage 删除 RAF 攒批重构后残留的死 ref：liveTailByMessageRef / flushTimeoutRef / lastStreamingAssistantIdRef，三个都只剩 set/clear 没有 read。修复 PR #528 Bugbot review |
| refactor | prd-admin | error 路径删除多余的 flushPendingChunks 调用，由后续 stopStreaming 内置 flush 统一负责（避免 done/error 路径不对称导致难以理解）。修复 PR #528 Bugbot review |
| fix | prd-admin | deleteSession "双击取消"分支补 setActiveSessionId 恢复逻辑，与 toast undo 对称；之前删了当前活跃会话再双击取消，活跃态保持空白。修复 PR #528 Bugbot review |
| fix | prd-desktop | 登录页 EyeOff SVG 路径错画成 y=12 横线（应为右上到左下斜划线）。改为对齐 lucide-react EyeOff 的 4 段路径。修复 PR #528 Bugbot review |
| fix | prd-admin | AiChatPage 增加 useEffect unmount cleanup，组件卸载时清掉所有 pendingDeleteTimers。避免用户在 5 秒撤销窗口内切走，timer 仍触发 DELETE + toast 在别的页面弹出的问题。修复 PR #528 Bugbot review |
| fix | prd-admin | 撤销 toast 真删后会话短暂闪回修复：finalize 成功路径加 setSessions 本地直接 filter，避免 pendingDeleteIds 先清但 sessions 未刷新中间帧 visibleSessions 渲染回已删会话。修复 PR #528 Bugbot review |
| fix | prd-admin | flushPendingChunks 顶部改为主动 rafCancel 已排程 RAF（之前只无条件清 ref，stop/done/error 直调时留下孤儿 RAF）。修复 PR #528 Bugbot review |
| fix | prd-admin | RelativeTime 修复未来跨午夜时间点掉到 "MM-DD HH:mm" 格式（应为 "X 小时后"）。"小时"分支对 future 不再要求 isSameDay。修复 PR #528 Bugbot review |
| fix | prd-admin | 撤销 toast 修复在用户 5 秒 undo 窗口内切换到别的会话时，撤销按钮强制还原为已删会话的 bug。改用函数式 setActiveSessionId(current => current === '' ? id : current)，仅在 active 仍为空时还原。修复 PR #528 Bugbot review |
| fix | scripts | release-prepare 检测到工作区有非 changelog 改动时直接 abort（之前是警告但继续，导致后续 ./quick.sh release 因 dirty tree 拒绝执行，把用户卡在中间）。修复 PR #528 Codex review |
| fix | prd-admin | stopStreaming 补上 flushPendingChunks 调用，避免用户点停止按钮时把 RAF 缓冲里那一帧（~16ms）已 stream 但未刷屏的 token 静默丢弃。修复 PR #528 Bugbot review |
| feat | scripts | 新增 scripts/release-prepare.sh：合并 changelogs/ 碎片 + 把 CHANGELOG.md `[未发布]` 包裹成 `[X.Y.Z] - 日期` + 插入"用户更新项" bullet + commit，把发版"备料"环节从 5 步手工合并为 1 条命令 |
| feat | scripts | quick.sh 新增 `release-prepare` 入口（包装 release-prepare.sh）+ 补齐 `release` 入口（旧函数存在但未挂到 case 分发，导致 `./quick.sh release X.Y.Z` 之前根本跑不起来） |
| refactor | skills | 重写 release-version SKILL.md：流程从 7 阶段压到 7 阶段（每阶段一句话），强制走 ./quick.sh release-prepare 备料，禁止 AI 用 Edit/sed 直接改 CHANGELOG.md 结构。新增触发词"发布版本：X.Y.Z"——给版本号即跳过推荐 |
| fix | doc | CHANGELOG.md 清理 1.7.0 / 1.8.3 版本头的 rocket emoji，对齐 CLAUDE.md 规则 #0 禁止 emoji 的全局约束（历史明细行内 emoji 暂保留，作为遗留债务） |

### 2026-05-05

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 修复 GitHub App config 永远 undefined 的"幽灵 webhook 503"bug —— 抽 load-env.ts 独立模块，让 config.ts 顶部 side-effect import；self-loader 语义改为"空字符串占位也覆盖"，消除 self-update spawn 透传 stale 空值导致的二次失效 |
| fix | cds | self-force-sync 改 fail-safe 顺序 + 主动 in-process backend build：validate 先做（不动 dist），通过才清 dist + 跑 npx tsc 重建。consequences：validate 失败时 dist 完好 cds 继续跑；validate 通过时 dist 立刻就位无需 systemd ExecStartPre 兜底，杜绝"force-sync abort 后 cds 起不来需要 SSH 救场" |
| fix | cds | auto-build 路径补 v3 / v2 预览 slug 反向解析，子域名首次访问也能从 host 还原带 / 的真实分支名（如 `audio-upload-asr-tgr1f-claude-prd-agent` → `claude/audio-upload-asr-TGR1f`），不再误报"远程仓库中未找到分支" |
| test | cds | WorktreeService.findBranchByPreviewSlug 单测覆盖 v1/v2/v3 三档 + 多项目候选 + git 失败兜底，共 7 条用例 |
| feat | cds | self-status 改事件驱动：新增 SSE 端点 /api/self-status/stream（snapshot/update/keepalive 三类事件 + 25s 心跳）+ webhook push 事件触发 broadcastSelfStatus + 删除 60s server cache，回归"诚实"查询 |
| feat | cds | GlobalUpdateBadge 改用 EventSource 订阅 SSE，删除 30s/5s 双档自动轮询，新增"立即检查更新"手动刷新按钮（spin 动画 + 主题 token）；EventSource 不可用时回落 60s 兜底 polling |
| fix | cds | startInfraService 改为幂等：共享 mongo/redis 等 long-lived infra 容器在 deploy 时不再被 docker rm -f 强删（保护用户正在使用的连接），running 直接复用、stopped 改用 docker start 唤醒、不存在才创建 |
| perf | cds | /api/self-status?probe=remote 加 60 秒 in-process 缓存，前端 GlobalUpdateBadge 反复轮询不再每次触发 git fetch（之前 5-10 秒导致页面整体卡） |
| fix | cds | 修正 deploy 流程对 infra 的处理：默认共享模式（init 时一次性建好，所有分支共用 mongo/redis）下，deploy 不再触碰 infra（不重启、不 health 阻塞），杜绝"共享 mongo 被强删"+"deploy 因 infra healthcheck 等待变慢"两类故障。新增 Project.infraIsolation 字段，'per-branch' 才走原启动链路 |
| feat | prd-api | 新增 CLI Agent 执行器 claude-sdk，通过 Python sidecar 调用 Anthropic Agent SDK，支持本地 / docker-compose / 跨服务器 sandbox 三种部署形态
| feat | prd-api | 新增 IClaudeSidecarRouter 多实例路由（健康检查 + 标签 + 粘性 + 加权），暴露给 CapsuleExecutor.ExecuteCliAgent_ClaudeSdkAsync 使用
| feat | prd-api | 零配置自启：检测到 ANTHROPIC_API_KEY 环境变量后 PostConfigure 自动注入 default sidecar 并启用执行器，docker compose up 即可
| feat | prd-api | 新增 IAgentToolRegistry + 内置工具 echo / current_time，AgentToolsController 提供 /api/agent-tools/{list,invoke}，sidecar 可反向调主服务工具
| feat | prd-api | ExecuteCliAgent_ClaudeSdkAsync 写 llmrequestlogs（StartAsync / MarkFirstByte / MarkDone / MarkError），账单页可见 claude-sdk 调用
| feat | claude-sdk-sidecar | 新建 Python FastAPI 服务，提供 /v1/agent/run SSE 流式接口和 /healthz /readyz 探针，多轮 tool_use 循环 + ToolBridge 反向调用主服务
| feat | docker | docker-compose.dev.yml 增加 claude-sidecar service，默认包含（无 profile），随 compose up 一起启动
| docs | doc | 新增 doc/guide.claude-sdk-quickstart.md（三步无脑配置）+ design / debt 文档同步更新到 v0.2
| feat | prd-desktop | 登录页新增"记住用户名"勾选、密码显隐切换、大写锁定实时提示，输入框补 autoComplete 让系统密码管家可介入 |
| feat | prd-admin | 登录页新增"记住用户名"勾选、密码显隐切换、大写锁定实时提示 |
| perf | prd-admin | 聊天流式输出去掉 flushSync 改用 requestAnimationFrame 攒批，长回答与长会话显著降低卡顿 |
| feat | prd-admin | 新增统一 RelativeTime 组件（刚刚 / X 分钟前 / 昨天 HH:mm / 自动每分钟刷新），PRD Agent 侧边栏会话列表展示最近活跃时间 |
| feat | prd-admin | toast 库新增 action 按钮支持，会话删除改为"撤销 toast"模式（5 秒内可撤销，替代 window.confirm） |
| fix | prd-admin | toast 退出动画延迟与 duration 联动，修复非默认 duration 时退出动画时机错位 |
| feat | prd-api | 工作流新增 tiktok-creator-fetch 胶囊（调 TikHub 拉博主视频列表，输出标准化 items 数组 + firstItem 快捷字段）
| feat | prd-api | 工作流新增 homepage-publisher 胶囊（下载媒体并写入 HomepageAsset，slot/objectKey 规则与 HomepageAssetsController 对齐）
| feat | prd-admin | 工作流模板新增「TikTok 博主订阅 → 首页海报」：填 secUid + API 密钥 → 抓最新视频 → 直发首页槽位
| refactor | prd-admin | TikTok 博主订阅模板瘦身：必填项从 5 项砍到 2 项（API 密钥 + secUid，secUid 默认填 TikHub 官方示例），默认发封面图到 card.showcase 槽位避开 tt_chain_token 复杂度
| fix | prd-api | TikTok 端点改用 app/v3（/api/v1/tiktok/app/v3/fetch_user_post_videos），web 端点上游 TikTok 实测 400（连官方示例 secUid 也失败）。app/v3 稳定可用，响应结构 data.aweme_list 与抖音对齐
| fix | prd-api | TikTok coverUrl 改优先取 video.dynamic_cover（WebP）。TikTok 默认的 video.cover/origin_cover 实际返回 HEIC，浏览器无法直接显示
| feat | prd-api | 工作流新增 weekly-poster-publisher 胶囊：把上游条目数组写入 WeeklyPoster 集合并发布，登录后首页轮播弹窗即时显示。每条 item 对应海报一页（title/body/imageUrl），imageUrl 前端自动识别视频/图片
| feat | prd-api | tiktok-creator-fetch 标准化输出新增 shareUrl 字段（拼 https://www.tiktok.com/@unique_id/video/aweme_id），便于海报 CTA 直跳 TikTok
| refactor | prd-admin | TikTok 模板改名「订阅 → 首页弹窗海报」，发布节点改用 weekly-poster-publisher，count 默认 4（弹窗 4 页轮播），CTA 自动跳到 TikTok 视频页
| fix | prd-api | WeeklyPosterController 补 [Authorize] 装饰器，AI Access Key 等 non-cookie 认证才能正常通过（之前缺这个标记，AdminPermissionMiddleware 直接拦在未登录分支返回 401）
| fix | prd-admin | 移除 WeeklyPosterModal 用户端误传的 metaLabel="1200 × 628 · 发布"（编辑器调试残留），用户登录看到的弹窗右下角不再有这条提示
| feat | prd-admin | isVideoUrl 扩展识别 TikTok / 抖音 CDN URL（路径含 /video/tos/ 或 host 含 tiktokcdn 等），无 .mp4 扩展名也能命中，被识别后走 <video autoplay loop> 自动播放
| refactor | prd-api | weekly-poster-publisher 优先取 videoUrl（真实 mp4，前端直接 <video> 播放），fallback 到 coverUrl。海报弹窗由"模糊静图"升级为"自动播放视频"
| feat | prd-admin | TikTok 订阅模板新增 platform 二选项（TikTok / 抖音），选抖音时走 sec_user_id + douyin web 端点
| feat | prd-admin | 海报弹窗新增 ad-4-3 展示模式：4:3 比例 + 全 bleed cover/video + 中央 Play 按钮 + 用户主动点击播放（借鉴 Apple 产品视频弹窗 / Netflix 预告 modal / Twitch 视频卡片，autoplay 容易吓跑用户）。修改 WeeklyPosterModal.tsx 根据 presentationMode 切换 aspectRatio 和 PageView 组件
| feat | prd-api | weekly-poster-publisher 暴露 presentationMode 配置（默认 ad-4-3）；视频 URL 时同步把 cover 写到 SecondaryImageUrl 作为 video poster 海报，pause 状态显示静图，点击后切到真视频
| refactor | prd-admin | TikTok / 抖音订阅模板默认 presentationMode='ad-4-3'，CTA 文案随平台切换（"去 TikTok 看完整视频" / "去抖音看完整视频"）
| fix | prd-admin | 修复 ad-4-3 弹窗左上角破图占位符：cover 改用独立 <img> 层渲染（带 onError 静默隐藏 + accentColor 渐变兜底），<video> 元素仅在用户点 Play 后才挂载并 autoplay。彻底避开 <video poster=动图webp> 在部分浏览器渲染破图的问题
| fix | prd-admin | 收紧 isVideoUrl 检测：去除 host-only 匹配（tiktokcdn 等主机同时服务 cover 静图与 video，不应仅按 host 判定），仅认路径模式 /video/tos/ 与 /aweme/v{N}/play/。修复 weekly-poster-publisher fallback 到 coverUrl 时被误判为视频 → 渲染破图问题（Codex P2 / Bugbot Medium）
| fix | prd-api | homepage-publisher MIME 残留 octet-stream 问题：CDN 返回 application/octet-stream 时用 ext 反推真实 mime（image/png / video/mp4 等），避免 COS 上对象 mime 错误导致前端拒绝渲染（Bugbot Medium）
| docs | doc | 新增 plan.emergence-1-tiktok-douyin-poster.md：交接文档给下一智能体接 Phase 2（视频转文字 + 图文混排海报版式），含完整 Phase 1 教程、踩坑记录、Phase 2 子任务分解、关联文件

### 2026-05-04

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 修复 [CDS 系统设置] /api/self-status 顶层 handler 暴露在 auth middleware 之前导致 commit SHA / 自更新历史无认证可读(Codex P2):移到 auth + agent key 之后、所有 /api router 之前,鉴权生效仍抢在 router 链前 |
| fix | cds | 修复 ?probe=remote 完整版 self-status 漏检 webBuildError 导致 GlobalUpdateBadge 在 build 失败时角标不亮(Bugbot Medium):branches.ts bundleStale 同时检 .build-error 文件,与轻量版保持一致 |
| fix | cds | 修复 GlobalUpdateBadge restarting 状态秒数 5s 跳一次造成"卡死"错觉(Bugbot Low):state.kind === 'restarting' 时启 1s setInterval 强制 re-render |
| fix | cds | 删除 GlobalUpdateBadge 中无用的 RefreshCw import + dummy export(Bugbot Low):死代码 |
| fix | cds | ConfirmAction onConfirm 抛异常兜底(Bugbot Medium):popover 已关 + 调用方未 try/catch 时不再 unhandled rejection,console.error 让开发可见 |
| fix | cds | 修复 BranchDetailDrawer metrics tab 网络速率永远为 0:setInterval 闭包捕获首次 loadMetrics 引用,state 更新后新闭包不会被定时器调用,改用 useRef 同步保存上次响应快照 |
| fix | cds | 修复 GlobalUpdateBadge "有更新"角标永远不亮:server.ts 顶层 /api/self-status handler 无条件抢答 router 版,带 ?probe=remote 时下放给 branches.ts 完整版做 git fetch + ahead 计算,前端轮询切到 ?probe=remote |
| fix | cds | 修复 Variables tab 项目级覆盖被误判为全局:env-classifier 用值比较 rawGlobal[k] !== v 推断 source,当项目 override 写入和全局相同的值时被错误归类为 global,改用 getCustomEnvScope(projectId) 直接读 raw bucket |
| chore | cds | 删除 self-update handler 里未引用的 startedIso 变量(Bugbot Low) |
| fix | cds | 修复 WorktreeService 构造测试的错误参数(Bugbot Medium):multi-project-e2e + view-parity.smoke 都传了非签名要求的额外位置参数,仅靠 JS 运行时容忍(extra args 丢弃)。统一为单参数 (shell) 与 src/services/worktree.ts:70 的 `constructor(private readonly shell: IShellExecutor)` 对齐 |
| fix | cds | 修复 [项目环境变量] deploy 路径 getMergedEnv 仍允许 customEnv 覆盖 CDS_PROJECT_ID/SLUG(Bugbot Medium):view 路径 Round 9 已加 RESERVED_CDS_KEYS 保护,deploy 没跟进 — 用户在 _global 写 CDS_PROJECT_ID=evil,Variables tab 显示 cds-derived 安全,实际部署到错的项目 ID。projectEnv spread 改在最后,与 view 一致 |
| fix | cds | 修复 bundleStale 检查在 short SHA 边角误判(Bugbot Medium):headSha(short 7-8)与 webBuildSha(可能 full 40 或 legacy short)startsWith 单方向不安全。改双向 startsWith — 任一方向匹配即视为同 commit |
| fix | cds | 修复 runInProcessWebBuild 的 install 失败路径不写 .build-error(Bugbot Low):/api/self-status 看不到失败原因。与 build 失败路径一致写 .build-error + 完整 stdout/stderr 落 cds/.cds/web-build.log |
| fix | cds | 修复 [项目环境变量] /api/branches/:id/effective-env 返回 secret 明文导致网络面板/截图泄露(Bugbot Medium):服务端默认 redact secret 值为 "••••" + 末 4 位,新增 GET /api/branches/:id/effective-env/reveal?key=X 端点按需取明文,前端 reveal/复制按钮改走该端点 |
| fix | cds | 删除 /effective-env 里 dead code 的 customEnv = stateService.getCustomEnv(projectId) 调用(Bugbot Low):Round 1 改 source 推断后这个 flat merge 已不再被读 |
| fix | cds | 修复 [项目环境变量] /api/branches/:id/effective-env/reveal 缺 assertProjectAccess 导致项目隔离绕过(Bugbot High security):项目 A 的 cdsp_xxx key 能 reveal 项目 B 的 secret 明文,redact 设计被绕开。补加 assertProjectAccess 与 list 端点同级 |
| fix | cds | 修复 docker stats 容器名拼接命令注入(Bugbot Medium):JSON.stringify 不是 shell-safe(双引号串里 $(...)/反引号仍展开),改 [a-zA-Z0-9][a-zA-Z0-9_.-]* 白名单 regex 拒绝任何不合法名字 |
| fix | cds | 修复切分支时 in-flight metrics 请求污染新分支 ring buffer(Bugbot Medium):loadMetrics 起点 capture branchId,resolve 时对 branchIdRef.current 校验,不一致直接丢弃 |
| refactor | cds | reveal 与 list 端点 env 合并逻辑共享 buildBranchEnvMap helper(Bugbot Medium):共用 builder 杜绝两端 source 判定漂移 |
| fix | cds | 修复 self-update web build skip 永远不触发(Bugbot Medium):existingWebSha === newHead 永远 false — newHead 是 short SHA(7-8 字符),existingWebSha 是 v6 fix 后写入的 full SHA(40 字符),改 startsWith 容忍长短差异。每次 self-update 不再多 1-2 分钟无谓重 build |
| chore | cds | 删除 shell.exec env 的 process.env 冗余 spread(Bugbot Low):shell-executor 已自动 merge,调用方只需传 override 部分。validateBuildReadiness + self-update web install/build 共 3 处清理 |
| fix | cds | 修复 metrics polling useEffect 缺 loadMetrics 依赖导致 setInterval 未来可能捕获 stale 闭包(Bugbot Medium):删除 eslint-disable,把 loadMetrics 加入 deps;metricsState 用函数式 setter 杜绝 stale state 读 |
| fix | cds | 修复 GlobalUpdateBadge inline 立即更新触发 SSE 端点不消费流 + 缺 body(Bugbot Medium):/api/self-update 是 SSE,initSSE 先写 200 后续失败时 r.ok 仍为 true。改读 SSE 第一个事件块判 error/accepted,abort 后让 30s 角标轮询接管显示;补 body 防 req.body 解构 TypeError;5s 兜底 abort |
| fix | cds | 修复 GlobalUpdateBadge "立即更新" 触发后 30s 看不到反馈(Bugbot Medium):成功读到第一个非 error SSE 事件后立刻 setState({kind:'restarting'})+ fastPollUntilRef 拉满 90s,用户当场看到 spinner 不再怀疑"按了没用" |
| fix | cds | 修复 effective-env 排序与覆盖优先级反向(Bugbot Low):sourceOrder 之前 mirror=2 排在 cds-derived=3 前,但 cds-derived 实际覆盖 mirror。改 cds-derived=2, mirror=3,显示顺序与 winner-first 语义一致 |
| fix | cds | 修复 cds/web pnpm build 不再做类型检查(Bugbot Medium):Round 1 因 vite 渲染 OOM 删了 tsc -b,但同时也丢了类型守卫。改 build 为 "tsc --noEmit && vite build" — tsc --noEmit 内存比 tsc -b 低 3x,顺序执行不叠加 vite 内存压力 |
| fix | cds | 修复 [项目环境变量] CDS_PROJECT_ID/CDS_PROJECT_SLUG 可被 _global / project customEnv 覆盖(Bugbot Medium):新增 RESERVED_CDS_KEYS 集合,buildBranchEnvMap 在 merge 末尾强制还原系统派生值 |
| fix | cds | 修复 [CDS 系统设置] /api/self-force-sync 跳过 in-process web build 导致"已 force-sync 但前端没变"(Bugbot Medium):抽取 runInProcessWebBuild helper,self-update 与 force-sync 共用,保证 web/dist 一致刷新 |
| fix | cds | **修复 /api/* 缺失端点返 HTML 让前端崩溃的根因** — `installSpaFallback` 的 legacy 兜底 `app.get('*')` 之前没有 skip /api/* 的守卫,任何不存在的 /api/... 路径会被 sendFile legacy index.html(200 + HTML),前端 apiRequest 解析失败但不报错,把 string 当对象用 → `data.bySource.project` 等访问崩溃。新加 skip-/api guard + `app.use('/api', json-404)` defense-in-depth,API 端点永远返 JSON,前端 apiRequest 能正确抛 ApiError(404) |
| fix | cds-web | VariablesPanel 增加响应 shape 校验 — 即使后端返回非预期格式(老版本 CDS / 中间代理改包),也给出明确错误「请先 self-update CDS 到最新分支」,而不是 property access 崩。同样守卫加到 MetricsPanel + 现有 bySource 渲染加 `?? 0` 兜底 |
| feat | cds-web | **分支卡片重设计(用户反复反馈的 3 个问题)**: |
| feat | cds-web | 1. 预览=重点色:running 态的 Eye 按钮去掉 `variant="secondary"`,走默认 primary 主橙色,真正"重点动作"。**完全删除卡片右下的 Play 部署按钮** — 部署有副作用,改走"打开抽屉 → 设置 tab → 重新部署",防止误点 |
| feat | cds-web | 2. 卡片大小一致 + 全部 tag inline:删除 `slice(0,1) + +N` 折叠逻辑,所有有 hostPort 的 service 全部显示,卡片 wrap 自动换行;status chip 改成 wrap 不 nowrap |
| feat | cds-web | 3. "未运行" 不再显示 chip,改成**整卡 opacity-60 暗示** — 用户视觉一眼能区分 running / idle,不需要额外 label;hover 时 opacity 恢复 100;异常和中间态(building/starting/...)保持正常亮度因为需要醒目 |
| test | cds | `tests/routes/server-integration.test.ts` 更新「OLD bug regression」用例 — 反映新的 JSON 404 行为(原本是 HTML 200),增加 `expect(parsed.error).toBe('not_found')` 断言 |
| feat | cds | 新增 `GET /api/branches/:id/effective-env` — 返回该分支 deploy 时真实生效的环境变量集合,按 source 分类(`project / global / mirror / cds-derived / cds-builtin`),敏感 key(PASSWORD/SECRET/TOKEN/...)标记 `isSecret: true` 让前端按需 redact;响应含 `bySource` 计数 + 排序好的 `variables[]`(project 在前) |
| feat | cds-web | 分支详情抽屉「变量」tab 落地(Phase A) — VariablesPanel 组件:实时读 effective-env、按 source 着色 chip(项目=绿/全局=蓝/镜像=橙/CDS=灰)、敏感值默认 `••••<last4>` 显示,单条 Eye/EyeOff 切换;搜索框过滤 key;头部「编辑」按钮跳转项目设置 env tab(用户场景:在分支抽屉里发现 env 不对 → 点编辑直接去改) |
| test | cds | 新增 `tests/routes/multi-project-e2e.test.ts`(6 tests)审计多项目隔离不变量:branch id 走 projectSlug 前缀消歧、container 名跨项目唯一、customEnv 严格按 scope、`/api/branches?project=` 不泄漏跨项目数据、activity logs scoped、slug 唯一性强制。**全 tests: 1127 passed (1121 → 1127)** |
| chore | cds | `server.ts` 补 `[/^GET \/branches\/[^/]+\/effective-env$/, '查看生效环境变量']` API label |
| feat | cds | `ContainerService.getServiceStats(names[])` 批量取一组容器的 docker stats —— 单次 `docker stats --no-stream --format "..."` 调用,parseDockerSize 解析 GiB/MiB/KiB/B 单位,容器不存在 / 已停时缺席不抛错。新增 `ContainerStats` interface 暴露 cpu/mem/net/blockIO/pids 字段 |
| feat | cds | 新增 `GET /api/branches/:id/metrics` —— 仅对 status=running 的 service 调 docker stats(避免拉所有容器),返回 `{ ts, services[], runningCount, totalCount }`,前端按 ts 算两次响应间 delta 得 rx/tx 速率 |
| feat | cds-web | 分支详情抽屉「指标」tab 落地(Phase B)—— MetricsPanel:5s 自动轮询 + 立即刷新按钮;每个 service 一张卡(状态 chip + container name + CPU/Mem 双进度条带颜色梯度<65%绿/<85%橙/>=85%红 + Net rx/tx 瞬时速率 + CPU 5min SVG sparkline);零 chart 库依赖(纯 SVG polyline ~30 行)关抽屉自动停 polling |
| test | cds | 新增 `tests/services/container-stats-parser.test.ts`(5 tests):空数组短路、单容器解析、批量 2 容器、docker fail 静默返空、GiB/kB/B 多单位混合。**全 tests: 1132 passed (1127 → 1132)** |
| chore | cds | `server.ts` 补 `[/^GET \/branches\/[^/]+\/metrics$/, '查看分支指标']` API label |
| feat | cds-web | 分支详情抽屉「设置」tab 落地(Phase C)— SettingsPanel 组件,把分散在卡片 hover / kebab 菜单 / 详情页脚部的 per-branch 操作收口到一个面板:重新部署 / 拉取最新 / 停止运行(grid 3 列主操作)+ 重置异常(仅 error 状态显示)+ 元信息(分支/项目/服务数)+ 配置入口跳转(项目设置 / env / 构建 / 路由)+ 危险操作分组(删除分支带二次确认弹窗)。复用现有 endpoint 不引入新 API |
| feat | cds-web | `BranchDetailDrawer` 新增 `onToast` + `onActionComplete` props,设置 tab 操作完成后通过父页面 setToast 反馈 + 触发 refresh;delete 操作完成自动 onClose,deploy/pull/stop/reset 操作后立刻重拉 branch 详情;BranchListPage 注入 setToast + refresh 回调 |
| chore | cds-web | 删除 `plannedLabel` 函数(不再有 placeholder),tab 定义里 variables/metrics/settings 不再带 `planned: true` 标记 |
| fix | cds-web | **ConfirmAction popover 点击「执行」后不关闭** — 之前是 `await onConfirm()` 完才 setOpen(false),但 self-update / force-sync 这类 SSE 长任务的 onConfirm 会跑几十秒甚至重启进程,popover 期间一直挂着挡视线。改为先关 popover 再后台跑 onConfirm,错误反馈走 toast。影响所有用 ConfirmAction 的地方(分支卡删除/部署确认 + self-update/force-sync 确认) |
| fix | cds | **`/api/self-status` 永远返 200 不再 400/500** — 旧版用单一 outer try/catch 包住所有 git 命令,任何一步失败就 500;遇到 nginx/middleware 异常还会变 400。重构为**逐个 safeExec + degraded 字段**:每条 git 命令独立 try/catch + 失败收集 reason,响应永远是结构完整的 JSON,只是字段填默认/空值。新增 `degraded: { reasons: string[] } \| null` 让前端识别"数据有缺但接口活着" |
| fix | cds-web | **「显示已提交重启,但实际未重启」根因 — 缺 verification + 不自动 reload** — SSE 'done' 只代表后端发起了 process.exit + spawn detached,**不**代表新进程真起来了。新增 `waitForRestartAndReload`:等 1.5s 让老进程释放端口 → 轮询 /api/self-status 直到 commit hash 变化(60s 超时)→ 自动 `window.location.reload()` 加载新 bundle。超时则 toast「重启可能未生效,请手动刷新 + 检查 ./exec_cds.sh logs」,不再静默挂起 |
| feat | cds | 新增 `GET /api/self-status` 自更新可见性接口 — 返回 `currentBranch + headSha + headIso`、`remoteAheadCount/localAheadCount`、`remoteAheadSubjects` (前 5 条远端领先 commit 摘要)、`lastSelfUpdate` 与 `selfUpdateHistory` (最多 20 条);fetch 远端 ref 带 10s 超时,远端不可达走 fetchOk=false 优雅降级 |
| feat | cds | `POST /api/self-update` 与 `POST /api/self-force-sync` 全程埋点 `stateService.recordSelfUpdate` — 所有 abort 路径记 `failed`、预检失败记 `aborted`、即将 process.exit 前记 `success`,带 fromSha/toSha/duration/actor/error,落到 `CdsState.selfUpdateHistory` ring buffer (cap 20) |
| feat | cds-web | 「CDS 系统设置 → 维护 → CDS 更新」面板顶部新增自更新可见性区: GitHub 领先/同步状态 chip + 上次更新 chip(可点击) + 远端领先时展开前 5 条新 commit 列表;新增「CDS 自更新历史」对话框展示最近 20 条流水(状态徽标 + 触发源 + 分支 + sha 跳变 + 报错截断) |
| feat | cds | `cds/src/types.ts` 新增 `SelfUpdateRecord` 类型与 `CdsState.selfUpdateHistory?: SelfUpdateRecord[]` 字段(append-only,Optional,无 schema migration);`server.ts` 补 `GET /self-status` 中文 label「获取自更新状态」 |
| fix | cds | **`/api/self-status` 顶层挂载,绕开所有 router/middleware** — 之前在 createBranchRouter 内,挂在 11+ 个 `/api` router 后面,任何上层 middleware 抢答都会让请求 4xx/5xx,根本到不了 handler。现在在 server.ts 顶层 `app.get('/api/self-status', ...)` 注册,挂在所有 router 之前,无论后面挂了什么都先被这个 catch。同时 outer try/catch 兜底任何意外都返 200(degraded 字段标明哪步失败)— 杜绝再现 "GET /api/self-status → 400" 的 banner |
| feat | cds-web | **GlobalUpdateBadge 全局更新状态徽章(浮动左下角,所有页面可见)** — 30s 一次轮询 /api/self-status,5 种状态可视化:`updated`(后端 SHA 与页面打开时不同 → 绿色"已更新,点击刷新")、`updateAvailable`(GitHub ahead > 0 → 橙色"GitHub 有 N 个新 commit,点击查看")、`restarting`(self-status 不可达 → 蓝色 spinner"CDS 正在重启",自动 5s 重连共 90s)、`bundleStale`(后端 SHA != web bundle SHA → 红色"前端 bundle 比后端旧")、`idle`(隐藏)。hover 展开横向 chip,X 按钮 1 小时内不再提示。点击各状态跳转对应操作页 |
| feat | cds | `/api/self-status` 响应新增 `webBuildSha`(读 `web/dist/.build-sha`)+ `webBuildError`(读 `web/dist/.build-error`)+ `bundleStale` 布尔字段,用于前端 GlobalUpdateBadge 检测构建漂移 |
| fix | cds | **`exec_cds.sh build_web` 失败不再静默 return 0** — 之前 `pnpm build || { warn ...; return 0; }` 一句话吞 error,操作员看不到根因 → 后端跑新代码但 UI 是老的(用户反馈"已更新但页面不对"的真因)。改为:把 build 输出写到 `.cds/web-build.log`,失败时 err 日志 + tail 30 行打到终端 + 写 `web/dist/.build-error` 标记文件(含时间/sha/exit/log path/tail)→ /api/self-status 把这个 surface 给前端 → GlobalUpdateBadge 显示红色提示 |
| feat | cds | `validateBuildReadiness` 扩展 — 除后端 cds/ 的 `pnpm install + tsc --noEmit` 外,新增 `cds/web/` 的同样校验(if web/package.json exists)。返回类型新增 `'web-tsc' \| 'web-build'` stage。这样 self-update 在 process.exit **之前**就能拦截"前端 TypeScript 错误",避免 build_web 在新进程里失败导致 bundle 漂移 |
| feat | cds | UX 优化批次:主题按钮挪右上(行业标准位置 + 修左下与 GlobalUpdateBadge 重叠) |
| feat | cds | 顶栏容量加 tooltip + 单位说明:"7/186 容量" → "7/186 容器" + 详细 tooltip 解释槽位含义 |
| feat | cds | 失败/异常分支卡置顶(超越收藏优先级)+ 红色 ring + 红色染色,接班场景一秒看到异常分支 |
| feat | cds | 失败 drawer 智能默认 tab:status === error 时自动开"日志"+ 自动选中失败 service,0 click 看错误 |
| feat | cds | 删除分支二次确认增强:具体说明会停几个服务 + "不可恢复" 警示 + git 历史不受影响声明 |
| feat | cds | 失败 card 内联诊断:错误归类 chip(端口冲突/OOM/依赖缺失/进程异常退出/健康检查超时/镜像拉取)+ 责任侧 chip(代码侧/配置侧/CDS 侧)+ 最后 5 行 stderr + 查看完整日志 CTA |
| feat | cds | 新增 GET /api/branches/:id/failure-diagnosis 端点:从 docker logs 读最后 30 行 + regex 模式归类 |
| feat | cds | GlobalUpdateBadge 加 inline "立即更新" 按钮(updateAvailable 状态),不再跳 settings 页再点一次 |
| feat | cds | GitHub 关联卡片新增 "最近自动部署" mini-list:从 branch.githubInstallationId 推断,按 lastDeployAt 排序,证明 webhook 在工作 |
| feat | cds | 新增 GET /api/projects/:id/recent-auto-deploys 端点 |
| feat | cds | 顶栏右上"刷新"按钮替换为 SSE 在线状态点(绿色静止 = 实时连接中),仅在 SSE 中断时露出黄色 RefreshCw 兜底,消除"暗示数据不新鲜"的视觉噪音 |
| fix | cds | **Hotfix:**`validateBuildReadiness` 的前端 tsc 校验在 production 1G 内存机器上 OOM,导致 self-update 全部 abort(`stage: 'web-tsc'`)。修复:**前端 tsc 失败改为 warning 不阻断**(后端 tsc 才阻断,理由:后端起不来 = CDS 死翘必须 abort;前端起不来 = 老 dist/ 继续 serve + GlobalUpdateBadge 红徽章自动报警)。同时加 `NODE_OPTIONS=--max-old-space-size=4096` + 改 `tsc -b` 为单 tsconfig `tsc --noEmit`(少用 2-3x 内存) |
| feat | cds | `ExecOptions` 新增 `env?: Record<string, string>` 字段 — 调用方可局部覆盖子进程环境变量(典型场景:tsc/vite 加 NODE_OPTIONS 防 OOM 不污染主进程)。`ShellExecutor.exec` 提供时合并 `process.env`(后写覆盖) |
| feat | cds | `/api/self-update` SSE 流新增 `web-warning` 事件 — 当前端 tsc 失败但 self-update 继续时,SSE 流推一条 warning 通知前端 UI 在日志面板里区分 " 后端通过 /  前端可能不更新"。`/api/self-update-dry-run` 响应里也加 `webWarning` 字段(成功 200 + 软告警,而非 422) |

### 2026-05-03

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds-web | 项目设置「GitHub 关联」摘要新增「关闭/开启自动部署」inline 按钮 + 状态用绿点 chip 区分,不用再切到 GitHub tab 才能关掉自动部署(用户反复要求过) |
| fix | cds-web | 分支卡片预览(Eye, running)与部署(Play, 非 running)按钮颜色区分:预览走 secondary(蓝灰)被动语义,部署保持 default(主橙)主动语义,不再两个按钮都是橙色让用户分不清 |
| fix | cds-web | 分支卡片异常态布局简化:删掉旧的红色横幅 + [详情] [重置] 内嵌按钮(导致网格高度跳变 + 卡片对不齐),改为一行极简 hint「错误消息 · 点击查看详情」,操作入口统一收到详情抽屉 + BranchMoreMenu |
| fix | cds-web | DropdownMenu 改用 createPortal + 视口坐标定位,popover 渲染到 document.body,不再被外层 `overflow-hidden` 卡片裁剪("..."菜单只显示一截"问题); scroll/resize 时自动重算位置 |
| perf | cds | `GET /api/branches` 容器状态对账批量化 — 一次 `docker ps --format {{.Names}}` 拿到全部运行中容器,per-service 走 Set 成员检查;旧路径每个 (branch × service) 跑一次 `docker inspect` (~50–150ms),20 分支 × 5 服务 = 5+ 秒首屏阻塞,典型场景降到几百毫秒 |
| feat | cds | `/healthz` 升级为深度探针 — 除原有 state + Docker 检查外,新增 4 项:`reactDist` / `legacyFallback` 文件存在性、`spaServable` 综合判定、`routesRegistered` 校验 `/project-list` `/branch-list` `/cds-settings` 在 Express router 上已挂(防止 `installSpaFallback()` 漏调或被覆盖);任一失败返 503 + JSON 详情。`?probe=routes` 模式额外 loopback HTTP 探活每条关键 SPA 路由(1s 超时,接受 2xx/3xx),catch 中间件顺序错乱与 Content-Type 回归 |
| feat | cds | `exec_cds.sh restart`/`start` 启动后强制自我探针 — 端口 bind 后 curl `/healthz?probe=routes`,失败立即报 "保活探针失败" + 回显 JSON 详情并 `return 1`(不假装"启动成功"),避免"进程在跑但所有页面 404"这类静默故障再次蒙混过关。新增 `./exec_cds.sh healthz` 子命令供手动诊断 |
| fix | cds | F18: dropdown「从 GitHub 选仓库」改为直接弹 GithubRepoPickerDialog（之前要先开新建表单再点一次），少一次手动操作；CreateProjectDialog 加 autoOpenPicker prop 在挂载后自动 setRepoPickerOpen(true) |
| feat | cds-skill | F13: cdscli verify 新增 INFO 规则 `infra-init-script-detected` — 扫到 `./*.sql:/docker-entrypoint-initdb.d/*` 类挂载时给出确认提示（同 service 多脚本聚合一行），让用户可见 cdscli 已识别到 init.sql |
| fix | cds-skill | F14: `schemaful-db-no-migration` WARNING 收敛 — 任意 infra 已挂 init script 到 /docker-entrypoint-initdb.d/ 时不再误报，fix 文案同时给 ORM migration 与 init.sql 两条路径；mysql/postgres demo 走 init.sql 不再被当成漏配 ORM |
| feat | cds | F12: 新增 `POST /api/projects/:id/files` 端点 + ProjectFilesService — 接受 `{branch, files:[{relativePath, content}]}` 写入 worktree（路径白名单 / 单文件 ≤256KB / 单次 ≤1MB / ≤50 个文件）；EnvSetupDialog 检测 mysql/postgres infra 时新增「上传 init.sql」卡片，省掉「git push 才能跑 demo」的步骤 |
| feat | cds | F11: `POST /api/projects` 新增沙盒模式 — 接受 `{composeYaml, projectFiles[]}` 不需 gitRepoUrl，后端在 reposBase 本地 `git init -b main` + 写文件 + commit + 自指 origin（让后续 worktree 走 `origin/main` 路径不需特判）；ProjectListPage dropdown 新增「从 YAML 沙盒新建」入口 + SandboxProjectDialog（粘贴 yaml + 加额外文件） |
| fix | cds-web | Bug A: BranchListPage 加载体验 — 取消远程分支冷启动 force-fetch 兜底（之前每次都跑 30s git fetch 阻塞首屏），改成手动「拉取远程」按钮；loading 文案从「加载分支与远程引用」改为「加载项目与本地分支列表」消歧 |
| fix | cds-web | Bug B: 状态 chip「运行中 vs 未运行」视觉差强化 — 运行中 font-semibold + 实心绿点 + 微光环；未运行/已停止 opacity-60 + 空心灰圈，扫一眼可区分；同步改 BranchListPage 与 BranchDetailDrawer 两套 statusClass |
| fix | cds-web | Bug C: 服务详情面板「左 220px 列表 + 右日志」改为「顶部 tab 横排 + 下方日志全宽」，腾出横向空间显示完整 docker logs，不用拖横向滚动条 |

### 2026-05-02

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | F9: 新增 GET /api/branches/:id 端点返回单分支详情（带 ProjectKey 越权 403 守卫），修复 React 分支面板因端点缺失导致的 HTML fallback 空白页 |
| feat | cds | F10: GET /api/branches/:id/logs 返回值新增 liveStreamHint 字段指向 /api/branches/stream SSE 通道，告诉 UI / cdscli 在部署进行中如何订阅实时步骤事件（旧 logs 字段保持兼容，仅在 deploy 完成后填充） |
| fix | cds | F15 (HIGH severity): /api/branches/:id/container-exec 与 container-logs 输出现在默认 mask 敏感 env（GITHUB_PAT/MYSQL_PASSWORD/JWT_SECRET/Authorization Bearer 等）；admin 可用 ?unmask=1 显式取消（响应体 masked 字段标记当前模式） |
| feat | cds | F17: 预览按钮过渡页从纯文本「CDS is preparing the preview」升级为 CDS 品牌动画（双圈旋转 + CDS 字样 + 进度条 + 主题感知），符合「非文字 / CDS 专属动画」用户契约第 31 条 |
| feat | cds | cdscli 补齐 project create / clone / delete + branch create + onboard 子命令(F3+F7 friction 收敛),env set 新增 --key/--value 形式,VERSION → 0.3.0 |
| test | cds | 新增 test_cdscli_project_branch_phase16.py(15 case 覆盖 happy path + 错误场景,monkeypatch 不打真 HTTP) |

### 2026-05-01

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | resolveEnvTemplates 加 fixed-point 嵌套展开:cdsVars 自身含 ${VAR} 引用时,先把 cdsVars 展开到稳定再替换 env。修复 dev 模式应用 env 拿到 `mongodb://${MONGO_USER}:${MONGO_PASSWORD}@host` 字面量的 bug。最多 8 次迭代防循环引用 |
| fix | cds | startInfraService 接收 customEnv 参数,展开 service.env 的 ${VAR} 引用 — mongodb / mysql / postgres 等 infra 容器拿到的 USERNAME/PASSWORD 是真实值。所有调用方(index.ts reconcile / branches.ts startInfraWithPortRetry / branches.ts /api/infra POST / executor RPC /infra/start)都同步传 stateService.getCustomEnv(projectId) |
| test | cds | compose-parser.test.ts 新增 8 个 case 覆盖 resolveEnvTemplates:简单展开 / 默认值 / 嵌套引用(${A} 引用 ${B} 引用 ${C}) / fixed-point / 循环防死锁 / 已展开值不变 |
| feat | cds | Phase 2.5 — 抽出 deploy 自动起 infra 决策为纯函数 `computeRequiredInfra`(services/deploy-infra-resolver.ts),便于跨项目 / stale state / Layer 1+2 综合场景单测 |
| feat | cds | 新增 cdscli `verify` 子命令:在部署前对 cds-compose.yml 跑 6 类静态检查(workDir 存在 / ports 必填 / infra image 必填 / ${VAR} 解析闭环 / schemaful DB migration / depends_on 提示 / 密码 URL 安全),三级严重度输出 + 退出码语义 |
| docs | cds | 新增 doc/spec.cds-compose-contract.md — cds-compose 完整契约 SSOT(字段表 + 7 类常见漏洞 + verify 校验规则 + 实现索引) |
| docs | cds | SKILL.md 加「7 类常见漏洞 + 自检清单」段,把 geo 实战根因黑名单化,防后续 agent 重复踩坑 |
| test | cds | 3 个新测试:tests/services/discover-infra-cross-project.test.ts(锁住 Map key 改 containerName 修复)+ tests/services/deploy-auto-infra.test.ts(Layer 1+2 决策)+ tests/services/state-vs-docker-sync.test.ts(stale state vs docker 实际状态) |
| docs | cds | plan.cds-mysql-readiness.md § 三 Phase 2.5 全部勾选 + § 五进度日志追加一行 |
| feat | cds | deploy 路由(`/api/branches/:id/deploy`)兜底自动启动项目下所有未运行的 infra,无论 BuildProfile 是否声明 dependsOn。判断标准是 docker 容器实际状态(通过 `discoverInfraContainers` 取),不信赖 stale state — 解决"state 写 running 但容器实际 Exited"导致 deploy 跳过 infra 的 bug |
| fix | cds | `discoverInfraContainers` Map key 从 `cds.service.id` 改为 `containerName`(跨项目唯一)。原实现下,project A 和 B 都有 svc.id='mongodb' 时,Map.set 互相覆盖,reconcile / deploy 检查会拿到错的容器。containerName(`cds-infra-{slug}-{id}`)全局唯一 |
| fix | cds | `index.ts` reconcile 路径同步用 `svc.containerName` 查 discovered map(配合上面的 key 改动) |
| fix | cds | deploy 流"启动依赖 infra"循环不再用 `infra.status === 'running'` 跳过 — requiredInfraIds 已经过 docker 实际状态过滤,这里再 check stale state 会漏 |
| docs | cds | `doc/plan.cds-mysql-readiness.md` Phase 2 章节勾选完成 + 进度日志追加 |
| feat | cds-skill | Phase 3 — cdscli scan 输出 yaml 全字段 carry-over:infra `volumes`(尤其 init.sql 和命名 volume)+ 应用 `volumes` / `working_dir` / `command` / `depends_on` 全部从 docker-compose 完整携带,补齐 CDS 识别"应用 service"必需的相对 mount(`hasRelativeVolumeMount` 判定) |
| feat | cds-skill | Phase 3 — 应用 command 命中 schemaful DB(mysql/postgres/sqlserver/mongodb/redis/rabbitmq)时,自动前缀 `until nc -z <host> <port>; do sleep 1; done && ...` wait-for 探活,Phase 2 兜底起 infra 后应用不再抢跑;幂等不重复添加(原 command 已含 `nc -z` / `wait-for` / `dockerize` 跳过) |
| feat | cds-skill | Phase 3 — 应用 `containerPort` 自动推断:无 ports 段时按"webpack devServer.port → vite server.port → package.json scripts `--port N` → .NET appsettings.Kestrel.Endpoints.Url → launchSettings.applicationUrl"顺序探测,输出 yaml 标注端口来源,杜绝 webpack 监听 8000 而 ports 写 3000 的"connection refused"陷阱 |
| feat | cds-skill | Phase 3 — `_gen_password` 移除 `!` 后缀,改用纯 `secrets.token_urlsafe(16)` 出 22 字符仅含 `A-Za-z0-9_-`,杜绝 url-encode 不到位的连接串解析失败;新增 `_url_encode_password` helper 给手改密码后的 url-encode 用 |
| feat | cds-skill | Phase 3 — `_parse_compose_services_regex`(无 PyYAML 兜底版)补 volumes/environment/working_dir/command/depends_on 解析,与 yaml.safe_load 主路径输出对齐 |
| test | cds-skill | 5 个 pytest fixture(.claude/skills/cds/tests/test_scan_phase3.py):cds-compose.yml SSOT 直读 / mysql + init.sql 完整 carry-over / wait-for 幂等不重复 / 密码 url-safe 无需 escape / 缺 ports 时 webpack 端口自动推断 |
| docs | cds | plan.cds-mysql-readiness.md § 五进度日志加 Phase 3  一行 |
| feat | cds-skill | Phase 4 — cdscli scan 新增 6 种 ORM 自动识别(prisma / ef-core / typeorm / sequelize / rails / flyway),命中后把 migration 命令注入应用 command 启动前缀,链式 `<wait-for-db> && <migrate> && <用户原 command>` |
| feat | cds-skill | Phase 4 — `_wrap_with_migration` helper:幂等检查(原 command 已含 prisma/ef/sequelize 等关键词不重复注入)+ flyway 等无注入 ORM 跳过 |
| feat | cds-skill | Phase 4.3 — 自动生成 `x-cds-deploy-modes`:支持 seed 的 ORM(prisma/sequelize/rails)输出 dev / prod 双模式,默认 prod(无 seed,不污染数据库),用户在 CDS UI 切 dev 启用 seed |
| feat | cds-skill | Phase 4 — scan 输出新增 `signals.orms` / `signals.schemafulInfra` / `signals.deployModes` 三字段,_emit_scan_result 摘要里也带 ORM 注入提示 |
| docs | cds | 新增 doc/guide.cds-orm-support.md:6 种 ORM 支持矩阵 + 用户使用方法 + 维护者扩展指南 + 6 条不要做的事 + 与 Phase 1-6 关系图 |
| test | cds-skill | 9 个 pytest fixture(.claude/skills/cds/tests/test_orm_phase4.py):5 种 ORM 识别 + 无 ORM 返回 None + _wrap_with_migration 幂等 + e2e Prisma+MySQL 完整链路 + 无 ORM 项目无 deploy-modes |
| docs | cds | plan.cds-mysql-readiness.md § 五 Phase 4  一行 |
| feat | cds | Phase 5 — BuildProfile 加 `dbScope: 'shared' \| 'per-branch'` 字段(默认 shared 不破坏现有行为);BuildProfileOverride 同步加,允许单分支覆盖 |
| feat | cds | Phase 5 — 新增 services/db-scope-isolation.ts(applyPerBranchDbIsolation / slugifyBranchForDb / previewPerBranchDbDiff)。per-branch 模式自动给 MYSQL_DATABASE / POSTGRES_DB / MARIADB_DATABASE / MONGO_INITDB_DATABASE 等白名单 env key 后缀 `_<branchSlug>`,实现"同一 DB 实例下每分支独立 database"。幂等 + 白名单制度,杜绝意外破坏 |
| feat | cds | Phase 5 — container.ts runService 在 mergedEnv 收集完毕、resolveEnvTemplates 之前注入隔离,${MYSQL_DATABASE} 引用自动跟随。shared 模式 noop 保证现有项目零行为变化 |
| docs | cds | 新增 doc/guide.cds-multi-branch-db.md:开启方式 / env 白名单 / 连接串引用规范 / 已知边界 / 模式选择决策表 / 实现索引 |
| test | cds | 17 个新单测(tests/services/db-scope-isolation.test.ts):slugify / shared noop / per-branch 各 DB 类型 / 幂等 / 多分支隔离 / 不动非白名单 / preview diff |
| docs | cds | plan.cds-mysql-readiness.md § 五 Phase 5  一行(MVP:核心隔离机制 done;UI 切换 / 自动建库 / GC / migration 冲突警告 留给 Phase 5.5+) |
| feat | cds | Phase 6 准备 — 新增 tests/integration/phase6-yaml-contract.smoke.test.ts:把 cdscli scan(Python)输出喂给 CDS parseCdsCompose(TS)做契约测试,合成 Prisma+MySQL + 普通 Node 两场景验证 Phase 1-5 全链路字段被正确解析 |
| fix | cds | Phase 6 契约测试发现真 bug:cdscli 给 mysql infra 加 `./init.sql:/docker-entrypoint-initdb.d/...` 单文件挂载,被 hasRelativeVolumeMount 误判为 app source 挂载,导致 mysql 被错分类为 app。修 compose-parser.ts:isAppSourceMount 排除 INIT_SCRIPT_TARGET_PREFIXES + CONFIG_FILE_EXT_RE 类挂载 |
| docs | cds | 新增 doc/guide.cds-mysql-validation-runbook.md(Phase 6 真人实战 runbook):候选项目 5 个 + 推荐评分 + Step 1-7 操作清单 + 完成判定 + 已知风险表 + 失败回填流程 + 接力 AI 启动模板 |
| docs | cds | plan.cds-mysql-readiness.md § 五 Phase 6 加  准备阶段(代码 + 文档 done,真实 repo 验收待用户挑选) |
| feat | cds | ContainerService 接入项目级 docker network: `runService` / `startInfraService` 用 `entry.projectId` / `service.projectId` 通过 ProjectNetworkResolver 查 `project.dockerNetwork`,实现跨项目容器网络隔离(`cds-proj-<id>`),老项目 dockerNetwork 字段缺失时自动 fallback 到 `config.dockerNetwork` 共享网络保持向后兼容 |
| feat | cds | StateService 新增 `migrateProjectDockerNetworks()` 启动时 backfill: 给非 legacy 项目缺失的 `dockerNetwork` 字段补 `cds-proj-<id>`,legacy default 项目跳过 backfill 以保护其下 pre-P4 容器在共享网络的现有连接 |
| refactor | cds | ContainerService 构造函数新增可选 `ProjectNetworkResolver` 参数(轻量适配器,不直接依赖 StateService 避免循环导入);label `cds.network=` 跟随实际使用的网络名;`discoverInfraContainers` / `discoverAppContainers` 不再 filter `cds.network=` 以发现跨项目容器,关联仍走 service.id / branch.id |
| test | cds | 新增 `tests/services/container-network-isolation.test.ts` 覆盖 6 个场景:项目 A 用 cds-proj-A 网络、项目 B 用 cds-proj-B、老项目走 config 兜底、无 resolver 向后兼容、ensureNetwork 创建项目专网、infra 容器同样按 service.projectId 选 network |
| fix | cds | Phase 6 实战 — Twenty CRM 真实部署暴露 + 修 2 个真 bug:`bash -c` 改 `sh -c`(B9,所有 alpine 镜像受益)+ singlePassResolve 容忍非 string env value(B9.1,yaml 数字字符串解析问题)|
| feat | cds-skill | cdscli `_yaml_from_compose_services` + dev mode command 都改用 sh -c(POSIX 通用,不依赖 bash) |
| docs | cds | plan.cds-mysql-readiness.md § 八 Phase 7 backlog 扩到 14 条,新增 B9-B14(Twenty 实战暴露的 docker entrypoint / readiness probe / dependsOn healthy / env API 设计等真盲区)|
| docs | cds | plan § 九 Phase 6 进度表加一行 — Twenty 完整实战暴露 6 个新 bug,确认机制层面 Phase 1-5 全 work,卡点是 CDS 后端能力(BuildProfile entrypoint / no-http-readiness / wait-for-healthy 都待加)|
| feat | cds | Phase 7 — 9 个真 bug 全修(B9 已修 + B9.1-B17 本次):Twenty CRM 端到端跑通,Nest application successfully started + http 200 |
| feat | cds | B10 BuildProfile.entrypoint + container.ts docker run --entrypoint(支持预构建镜像清空 wrapper ENTRYPOINT,Twenty 用) |
| feat | cds | B11 ReadinessProbe.noHttp + container.ts waitForReadiness 跳过 HTTP probe(后台 worker / job runner 不监听 HTTP);compose label `cds.no-http-readiness` 触发 |
| feat | cds | B12 deploy 路由起完 infra 后等所有 healthcheck 配置的 infra healthy(60s 超时不阻塞;Twenty server entrypoint 假定 db service_healthy) |
| feat | cds-skill | B13 cdscli 不 rename infra service 名,保留用户原 service name(避免引用断,如 `db` 引用不到) |
| feat | cds | B14 PUT /api/env 同时接受 body.scope 和 ?scope= query;剔除 scope 元字段不污染 env(避免被当成 env var)|
| feat | cds | B15 docker run 加 `--network-alias <service.id>`,让 cds-compose 短名(如 db / redis)能被同 network 内 DNS 解析 |
| feat | cds | B16 env self-reference fixed-point 死循环修复:resolveEnvTemplates 用 customEnv 作 vars(而不是 mergedEnv 自身),profile.env 引用 ${X} 直接拿 customEnv.X 完全展开值 |
| feat | cds | B17 BuildProfile.prebuiltImage 字段 + container.ts 跳过 srcMount(预构建镜像不应被仓库源码 mount 覆盖 image 自带文件);compose label `cds.prebuilt-image` 触发 |
| docs | cds | plan.cds-mysql-readiness.md § 五 加 Phase 7  一行,完整记录 9 个 bug + Twenty CRM 端到端跑通的证据 |
| feat | cds-skill | Phase 8.8 命名规范 — cdscli 自动生成的所有 env 一律 CDS_* 前缀(参考 Railway 的 RAILWAY_*),12 类 infra 模板全量改名:CDS_MONGO_USER / CDS_MONGO_PASSWORD / CDS_MONGODB_URL / CDS_POSTGRES_USER / CDS_POSTGRES_PASSWORD / CDS_DATABASE_URL / CDS_MYSQL_* / CDS_SQLSERVER_* / CDS_CLICKHOUSE_* / CDS_REDIS_* / CDS_RABBITMQ_* / CDS_AMQP_URL / CDS_ELASTIC* / CDS_S3_* / CDS_NATS_URL / CDS_MEMCACHED_URL / CDS_JWT_SECRET。容器内部 env 名(MONGO_INITDB_ROOT_USERNAME / POSTGRES_USER 等)不变,只是 value 引用从 ${MONGO_USER} 改为 ${CDS_MONGO_USER},容器行为零变化 |
| feat | cds-skill | _rewrite_env_value_with_infra_aliases 改用 CDS_MONGODB_URL / CDS_DATABASE_URL / CDS_REDIS_URL / CDS_AMQP_URL,docker-compose 里硬编码连接串自动重写为 ${CDS_*} 引用 |
| feat | cds-skill | AI_ACCESS_KEY 保留无前缀(用户必填,且 cdscli 直接读此名做认证) |
| test | cds-skill | test_scan_phase3 / test_env_meta_phase8 同步断言 CDS_* 前缀,20 个 pytest 全绿 |
| test | cds | tests/integration/phase6-yaml-contract.smoke.test.ts 断言 CDS_DATABASE_URL,951 vitest 全绿 |
| feat | cds | Phase 8 — env 三色契约 + 强制配置弹窗 + 行云流水部署:导入项目即引导用户填必填项,配完自动跳分支页 + 部署 |
| feat | cds-skill | Phase 8.1 cdscli scan 输出 x-cds-env-meta 段(每 env 标 kind=auto/required/infra-derived + hint),自动从应用 service env 引用的 ${VAR} 识别用户必填密钥(SMTP/OAUTH 等) |
| feat | cds | Phase 8.2 BuildProfile 旁挂 EnvMeta 类型;Project 加 envMeta + defaultEnv 字段;compose-parser 读 x-cds-env-meta 段(kind 大小写不敏感,未知值兜底为 auto);PendingImport.summary 暴露三色分类 |
| feat | cds | Phase 8.3 POST /branches/:id/deploy 检测 envMeta 中 required 项是否全填,缺失返回 412 Precondition Failed + missingRequiredEnvKeys + hints,?ignoreRequired=1 query 提供降级逃生口 |
| feat | cds | Phase 8.4 Project.defaultEnv 模板化:GET /env 项目级 scope 同时返回 envMeta + missingRequiredEnvKeys;PUT /env 同步写 customEnv + defaultEnv;新分支创建时自动从 defaultEnv 继承(避免每个分支重填 SMTP) |
| feat | cds | Phase 8.5 EnvSetupDialog 组件:clone 完成后自动弹窗,顶部"必填项"输入区(amber 强调) + "CDS 自动生成"折叠区 + "基础设施推导"折叠区,必填全填才 enable「完成,开始部署」按钮 |
| feat | cds | Phase 8.6 行云流水:env 配完跳转 /branches/:projectId,sessionStorage 信号触发自动部署默认分支(default → 第一个),用户从导入到第一个分支起来零手工 |
| feat | cds | Phase 8.7 docker-compose.yml 直接消费:即使没 cds-compose.yml,只要 docker-compose 含相对 mount 就当 CDS Compose 解析,用户带原项目过来不强制先生成 cds-compose.yml |
| test | cds | env-meta-phase8.test.ts(6 case)+ env-meta-state-phase8.test.ts(9 case);test_env_meta_phase8.py(6 case)。共 21 个 Phase 8 新单测全绿,cds 后端 951 全绿,pytest 20 全绿 |
| docs | cds | plan.cds-mysql-readiness.md § 五 加 Phase 8  一行 |
| feat | cds | Phase 9.1 EnvSetupDialog 必填密钥旁加「生成」按钮(crypto.getRandomValues + base64url 24 字节,等价 cdscli token_urlsafe(24)),一键填充 + 自动 reveal |
| feat | cds | Phase 9.2 EnvSetupDialog 顶部加「上传 .env」按钮,支持 KEY=VALUE 批量填充(覆盖现有 + 新增,带 N 项匹配反馈) |
| feat | cds | Phase 9.3 ProjectSettingsPage 项目环境变量 tab 加「打开向导」入口,用户后续可重新打开 EnvSetupDialog 三色分组弹窗 |
| feat | cds | Phase 9.4 EnvSetupDialog 密钥字段(SECRET / PASSWORD / TOKEN / KEY / PRIVATE 命中)默认 type=password 脱敏,加 Eye/EyeOff 按钮 reveal |
| feat | cds | Phase 9.5 env 修改审计日志:Project.envChangeLog ring buffer ≤ 200,记 op + keys(不记 value 防泄漏)+ actor + source。PUT /env / PUT /env/:key / DELETE /env/:key 自动追加,GET /api/env/audit?scope=<projectId> 读取 |
| feat | cds | Phase 9.6 BranchListPage 顶部加「必填环境变量缺失,deploy 会被 block」rose-color banner,点「立刻填写」直跳 /settings/:projectId#env;比 pendingEnvKeys 的 TODO 占位检测更准(读后端 envMeta) |
| test | cds | env-audit-phase9.test.ts 5 case(append + ring buffer + 项目隔离 + 不存在项目 noop + ts 自动加),vitest 956 全绿 |
| feat | cds | BranchListPage 面包屑「项目名」后挂项目切换 dropdown(ChevronDown trigger):列出最近 8 个项目 + "查看全部"链接,1 步切换;比之前"返回项目列表 → 找项目 → 进分支页"3 步缩短到 1 步 |
| feat | cds | AppShell `Crumb` 组件支持 `dropdown` slot,任意面包屑段都可挂下拉,不破坏既有 hover/链接行为 |
| feat | cds-skill | cdscli scan 加 12 种基础设施模板(Railway-style):mongodb / redis / postgres / mysql / sqlserver / clickhouse / rabbitmq / elasticsearch / minio / nats / memcached / nginx。命中 image 时自动:(1) 切换到推荐 stable image (2) 加初始化 env(account/password 引用 ${VAR})(3) 用 secrets.token_urlsafe(16)+! 生成强随机密码 (4) 把账号密码 + 连接串(MONGODB_URL/DATABASE_URL/REDIS_URL/...)写到 x-cds-env,让基础设施容器和应用容器共享同一连接串 |
| fix | cds-skill | docker-compose 优先级排序 bug:无后缀 docker-compose.yml 被错排到最后。改为先剥 .yml/.yaml 再剥 docker-compose 前缀,正确取 stem |
| fix | cds-skill | docker-compose `build: ./api` 简写形式被误当作 dict 导致 AttributeError 静默 fall through 到 monorepo-scan。加 isinstance(build, str) 分支处理简写 |
| docs | cds-skill | x-cds-env 文案改为"项目级环境变量(本项目独占,不会跨项目泄漏 / 污染其它项目)",彻底去掉"全局共享"的误导 |
| feat | prd-api | 海鲜市场上传 API 加幂等覆盖语义:`MarketplaceSkill` 加 Slug + Version 字段;Upload action 接受 form fields `slug`/`version`/`replaceMode`,默认 `auto` 模式按 (ownerUserId, slug) upsert,避免 AI 反复上传堆积重复条目。slug 兜底从 SKILL.md frontmatter `name:` 提取,version 兜底从 frontmatter `version:` 或自动 patch++ |
| feat | prd-api | OpenApi controller 加 `DELETE /api/open/marketplace/skills/:id`(仅作者),让 AI 上传错时能自助清理;响应字段 ToDto 暴露 slug/version |
| feat | prd-api | SkillZipMetadataExtractor 解析 SKILL.md frontmatter 的 name/version;ParseFrontmatter public 化便于单测;新增 8 个 xunit 测试覆盖正常/引号/缺字段/前导空行/大小写/空内容/畸形等边界 |
| docs | prd-api | findmapskills 模板 bump 1.0.0 → 1.1.0:上传段说明默认走幂等覆盖,加 AI 决策树("不要问用户用什么 slug / 下一版本号"),iconEmoji 示例去掉以符合根 §0 |
| chore | cds-skill | cds 技能去 emoji:SKILL.md / cli/cdscli.py / reference/{diagnose,maintainer,smoke,auth}.md 共 6 文件,符号化(→[OK]/→[FAIL]/→[WARN]/→(zip), 删除);frontmatter 加 `version: 1.1.0`;新增"AI 决策规则"段落让 AI 用 cdscli scan 时不反复询问用户 |

### 2026-04-30

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | BranchDetailDrawer 接入 ActiveDeployment 的 onResetError / onRetryDiagnosis 两个 callback:reset 调 `POST /api/branches/:id/reset` 清除分支异常状态;retry 调 `POST /api/branches/:id/verify-runtime/:profileId`(优先选中服务 → 异常服务 → 第一个服务)。Week 4.7 留下的"deploy/verify 失败时按钮不渲染"真实缺口至此闭环 |
| perf | cds | BranchListPage refresh 拆分:已跟踪分支 + 项目 + 配置先到 ok 状态(几十毫秒),远程分支独立 lazy load,首次走 `?nofetch=true` 拿后端 cache,空时再 force fetch。彻底根治"加载分支与远程引用"卡 30 秒的首屏体验 |
| feat | cds | BranchSearchDropdown 在远程分支加载中时显示「远程分支加载中…」chip,主链路不再等远程引用 |
| feat | cds | 分支卡 footer 三按钮(预览/部署/详情)收成单个上下文主按钮:running 时显示「预览」;中间态(building/starting/restarting/stopping)显示 loading + disabled;其它状态(idle/stopped/error)显示「部署」。"详情"按钮去掉,整张卡片已经可点打开 Drawer。低频操作仍在右上角更多操作菜单 |
| feat | cds-skill | `cdscli scan` 升级为四级优先识别:仓库根 cds-compose.yml 直读(SSOT)→ docker-compose.*.yml 解析(PyYAML 优先,正则降级,自动分 infra/app)→ monorepo 子目录扫描(node/dotnet/go/rust/python)→ 骨架兜底。从前的"骨架级 80% 要手改"升级到"装 CDS 前先 scan,大多数项目直接可用" |
| fix | cds-skill | 正则版 docker-compose 解析的 ports 字段去引号顺序错位,补 lstrip 在 strip quote 之前 |
| fix | cds-skill | path-prefix 标签的 TODO 注释从 quoted string 内挪到注释行(yaml 语法正确性) |
| feat | cds | BranchDetailDrawer 状态卡区在 running 状态时显示 production URL chip:绿色边框 + ExternalLink icon + 域名(去掉 https:// 前缀)+ 复制按钮(点击 1.5s 反馈"已复制")+ 整行点击在新窗口打开。失败/未运行时不渲染。彻底解决用户反馈"运行中绿点旁边没有 URL,只能去部署 tab 找"的痛点 |
| perf | cds | `/api/remote-branches` 加 5 分钟 git fetch cache + `?nofetch=true` 参数,避免 BranchListPage 首屏被 git fetch 拖到 30 秒;响应额外字段 `fetched` / `cachedAt` 让前端能展示同步时间。配合下一刀前端 refresh 拆分根治"加载分支与远程引用"卡顿 |
| test | cds | branches.test.ts 补 3 个 case 覆盖 cache 命中、cache miss、`?nofetch` 跳过 fetch |
| feat | cds | 分支详情抽屉部署 tab 升级到 Railway 心智：顶部一张「当前部署」大卡承载 4 阶段状态树（拉取代码 / 构建镜像 / 启动服务 / 健康检查），剩余历史折叠成 5 行 + 「显示全部」 |
| feat | cds | 部署失败按阶段定位：build 缺 BuildProfile → 主按钮「修复构建配置」直跳项目设置；deploy / verify 阶段失败给出「重置异常」「重新诊断」「查看完整日志」 outline 入口 |
| feat | cds | 新增 `cds/web/src/lib/deploymentPhases.ts` 纯函数：日志 + 终态 + 错误信息归纳为阶段状态树，保守降级（短日志单 build 占位）+ 失败传播 + errorMessage 注入 |
| feat | cds | 新增 `PhaseTree / ActiveDeployment / HistoryRow` 组件，颜色全走 Tailwind token + cds-surface 系列，禁止暗色字面量 |
| refactor | cds | BranchDetailDrawer 部署 tab 旧 `DeploymentCard / LegacyDeploymentCard` 函数保留为 export 顶层声明，不再被默认渲染；新通道经 `legacyLogToDeploymentItem` 把 OperationLog 投影成统一 BranchDeploymentItem 后渲染 |
| docs | cds | 更新 `doc/plan.cds-web-migration.md` Week 4.7 章节 + 进度日志；同步 `doc/guide.cds-web-migration-runbook.md` 第 7 节 |

### 2026-04-29

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | stack-detector 三大修复：(1) 优先识别仓库根目录的 `cds-compose.yml`，命中后直接调用 parseCdsCompose 创建全部 BuildProfile + InfraService + 项目环境变量，无需再走启发式扫描；(2) 新增 `detectModules()` monorepo 感知扫描——根目录无 manifest 时自动遍历一级子目录，每个模块产生独立 profile（解决 prd_agent 这种 monorepo 被误判为 unknown 的根因）；(3) 兜底：仓库根只有 Dockerfile / docker-compose.* 时也建占位 profile，避免用户陷入"尚未配置构建配置"的死循环 |
| feat | cds | 分支卡「详情」按钮不再跳转 `/branch-panel/<id>` 整页，改为右侧 BranchDetailDrawer 抽屉就地打开；抽屉显示状态 / 服务列表 / 最近构建日志 + 「打开完整页面」转义；按 Esc / 点蒙版 / 点 X 关闭 |
| feat | cds | BranchFailureHint 在失败原因为「尚未配置构建配置」时，主操作改为「添加构建配置」（primary 色），直接跳到 `/settings/<projectId>` |
| fix | cds | 搜索分支 / 选择远程分支不再自动开新窗口跳到 "CDS is preparing the preview..." 占位页；改为静默后台部署 + toast 提示「已添加 X，正在后台部署」；用户在分支卡看 BUILDING 状态并自行决定何时点预览 |
| fix | cds | 去掉 BranchDetailDrawer / OpsDrawer / CommandPalette 蒙版的 backdrop-blur，避免点详情后整个页面变模糊（用户反馈很难受）；蒙版改用 `bg-black/40` ~ `bg-black/50` 纯遮挡 |
| feat | cds | 分支页顶部新增「项目环境变量待补全」横幅：检测项目环境变量含 TODO / 请填写 / placeholder / FILL_ME / change_me 等占位时主动提示；横幅显示前 5 个 key + 总数；右侧主按钮「前往填写」一键跳转 `/settings/<projectId>#env` |
| feat | cds | 新增 AppShell / TopBar / Workspace 共享布局组件，统一所有 React 页面的左侧导航条、顶部面包屑和工作区宽度 |
| feat | cds | 引入 surface 三档视觉系统（base / raised / sunken）与 hairline 边框 token，替代过去 `bg-card border-border` 的灰底灰边堆叠 |
| refactor | cds | ProjectListPage 主链路收敛：顶部「粘贴 Git URL」hero 表单成为唯一主操作；项目卡改为 Railway-style 极简卡片（状态点 + 标题 + 仓库 + 内联指标 + 进入按钮）；自动化工具（技能包 / 全局 Key / Agent 申请记录）下沉到二级折叠面板 |
| refactor | cds | ProjectListPage 顶部统计移到 TopBar 内联 `cds-stat`，不再占据独立卡片层级；`MetricTile` 在该页面退役为局部使用 |
| feat | cds | 新增 Cmd/Ctrl+K 命令面板：全局快速搜索项目 / 分支 / 操作；空查询展示常用入口（所有项目 / CDS 系统设置 / 前 6 个项目 / 收藏分支）；输入文字按 startsWith / includes 排序；Enter 跳转、上下方向键浏览、Esc 关闭；Project/Branch List 页 TopBar 增加「搜索 ⌘K」chip 入口 |
| refactor | cds | Surface tokens 重新调优：dark 模式 raised vs base 高度差从 4% 拉到 7%（卡片不再"贴在背景上"），加入轻微蓝色调让深色不至于太中性；hairline-strong 暗色 16% → 26% 提供更清晰的 hover 边界；light 模式 sunken/hairline 同步精修 |
| refactor | cds | BranchDetailPage 把 6 个并列的 DisclosurePanel（容器日志 / 有效配置 / Bridge / 最近提交 / HTTP 转发日志）折叠成 4 个语义 tab：日志（容器日志 + HTTP 转发日志）/ 配置（有效配置）/ 历史（最近提交）/ Bridge；首屏只剩状态卡 + 服务卡 + 主操作 + 预览别名，诊断细节按需切换 |
| feat | cds | ProjectListPage 卡片大气化（向 Railway 看齐）：卡片高度 ~280px，标题 17px，中间是 dot-grid 工作区画布带 GitHub / GitBranch / 状态图标 glyphs，底部「运行中 · 0/3 服务在线 · owner/repo」状态行；卡片网格 gap 拉到 5（=20px），workspace 改 wide（1360px），hero 上下 padding 加大到 28px，主操作按钮 size=lg |
| refactor | cds | BranchListPage 顶部彻底重做：移除左侧 320px「跟踪 + 远程」两栏列表（用户反馈日常用不到）。改成顶部一个搜索框：focus 时下拉显示已跟踪 + 远程分支建议；点击跟踪行直接切到主区；点击远程行触发部署预览；输入文字过滤；Enter 直接走粘贴预览路径 |
| refactor | cds | BranchListPage 主区域改为全宽独享：选中分支的 BranchCard 占满 1360px 工作区，未选中时大空状态引导用户用顶部搜索；运维 / 容量 / 主机 / 执行器 / 批量等保持在 OpsDrawer 抽屉里 |
| refactor | cds | BranchCard 内部重建：去掉左侧巨大的 1px status rail；改为状态点 + 标题 + 状态 pill 单行 header；预览/部署/详情主操作行；服务横向 pill 列表；底部 ghost 图标按钮组（拉取/停止/收藏/调试/标签/重置/删除），不再用 details 折叠 |
| feat | cds | 全局微动效果：所有 a/button/卡片/Surface/Panel/Hero 加 150ms ease-out transition；OpsDrawer 加 cubic-bezier 滑入动画 + 蒙版淡入；项目卡 hover lift 0.5px + shadow-md |
| refactor | cds | ProjectListPage TopBar「新建项目」按钮改 outline + sm，避免与 hero「创建并克隆」竞争主链路视觉权重 |
| feat | cds | BranchListPage 改造为 Railway 风格 service-canvas：左侧 320px 资源列表（跟踪分支 + 远程分支两组），右侧主工作区显示选中分支的状态、服务、操作和日志；首次进入自动选中"最近运行"分支 |
| feat | cds | 新增 OpsDrawer 组件：右侧滑入抽屉承载容量、主机健康、执行器、批量运维、活动流等低频运维操作；TopBar 增加「运维」按钮触发；Esc / 点遮罩关闭 |
| refactor | cds | 删除 BranchListPage 中央"分支卡瀑布"布局；分支列表改为单行可点击的紧凑行（状态点 + 名称 + 状态文 + 服务 + 时间）；批量复选框右移、密度切换不再需要（master view 默认舒适） |
| refactor | cds | 远程分支列表从右侧运维栏挪到左侧资源列表，紧贴跟踪分支下方，保持一键部署链路最短 |
| refactor | cds | CdsSettingsPage 把 7 个并列 tab 重组为 3 个语义大类（接入 / 运行时 / 维护）：接入 = 概览 + 登录与认证 + GitHub 集成；运行时 = 存储后端 + 集群 + CDS 全局变量；维护 = 更新与重启。TabsList 在 trigger 之间渲染分组标题，用户 3 秒内能找到要改的设置 |
| refactor | cds | ProjectSettingsPage 把 8 个并列 tab 同样重组为 3 大类（接入 / 运行时 / 危险区）：接入 = 基础信息 + GitHub + 评论模板；运行时 = 项目环境变量 + 缓存诊断 + 统计 + 活动日志；危险区 = 删除项目 |
| refactor | cds | 全局视觉残留清理：所有页面里 `rounded-md border border-border bg-card` / `bg-muted/{20,30,40}` 等"灰底灰边堆叠"统一替换为 `cds-surface-raised cds-hairline` / `cds-surface-sunken cds-hairline`，与新视觉语言保持一致 |
| refactor | cds | BranchListPage / BranchDetailPage / BranchTopologyPage / ProjectSettingsPage / CdsSettingsPage 全部切到统一的 AppShell + TopBar + Workspace 共享布局；左侧导航条、顶部面包屑、刷新/返回按钮、内联统计样式不再各页各搞一套 |
| refactor | cds | 删除 5 个页面里重复的"自建 56px nav + cds-breadcrumb + cds-page-title 块"代码；改用 `<Crumb items=[...]>` 与 `<TopBar left={...} right={...} />` 显式声明 |
| refactor | cds | 统一移除每个页面顶部的"小图标按钮 / 项目设置 / 刷新"长按钮排，改成 ghost icon 按钮 + tooltip，避免次要操作压过主链路视觉权重 |
| refactor | cds | 项目设置 + CDS 系统设置的 TabsList 与内容区改用 `cds-surface-raised cds-hairline` 替代 `border border-border bg-card/75 shadow-sm` 灰底灰边堆叠 |
| refactor | cds | Toast 提示统一用 surface-raised + hairline 边框，与新视觉语言一致 |
| feat | cds | TopBar 新增 `center` 中间插槽 + `centerWide` flag，允许页面把核心交互内联到导航栏（粘贴 Git URL / 搜索分支），把工作区让给主内容 |
| feat | cds | 新增 DropdownMenu / DropdownItem / DropdownDivider / DropdownLabel 轻量下拉菜单组件，点击外部 / Esc 关闭，z 层级 30 |
| refactor | cds | ProjectListPage 全屏化：移除「接入仓库」hero 卡片与「自动化工具」折叠面板；Git URL 输入框内联到 TopBar 中间，自动化工具（下载技能包 / 全局 Agent Key / Agent 申请记录）进右上角「新建」下拉菜单；Workspace 只剩项目卡网格 |
| refactor | cds | BranchCard 重写为紧凑网格 BranchTile：~360px 宽，状态点+分支名 header、commit/服务/时间元信息行、服务 pills、底部 [预览]+[部署]+[详情] 三按钮固定位置（保留 legacy 用户心智），更多操作（拉取/停止/收藏/调试/标签/重置/删除）收进右上角 kebab 下拉菜单 |
| refactor | cds | BranchListPage 全屏化：移除「预览分支」hero 卡片；分支搜索 + autocomplete 下拉内联到 TopBar 中间；选中跟踪分支跳转分支详情页，选中远程分支触发部署预览；移除单分支 master view，主区改为 BranchTile 3 列网格（按收藏 → 最近活跃排序） |

### 2026-04-28

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 将分支列表主入口迁到 React：新增 `/branches/:projectId`，旧 `/branch-list?project=<id>` 兼容进入同一页面；项目卡片“进入项目”改走新语义路径 |
| feat | cds | React 分支页围绕快速预览重做主链路：右侧远程分支点击一次即可创建跟踪分支、SSE 部署并按当前预览模式打开 URL；点击时先打开占位标签，部署完成后跳转，避免浏览器拦截异步弹窗；已跟踪分支支持预览、部署/重部署、拉取、停止 |
| feat | cds | React 分支卡片补齐高频管理操作：收藏、tag 编辑、调试标记、错误状态重置、删除分支；删除会先弹确认，再消费后端 DELETE SSE 流并刷新列表 |
| feat | cds | 分支列表补齐多分支操作效率：同一搜索框同时筛已跟踪与远程分支，收藏分支置顶，新增运行/忙碌/异常/收藏快筛、排序、紧凑模式，以及批量部署、批量拉取、批量停止运行中、批量收藏、批量重置异常、批量删除一次确认 |
| feat | cds | 新增 React 分支详情页 `/branch-panel/:branchId`：展示服务状态、构建日志、容器日志、有效 profile 配置和最近提交；支持单服务重部署、运行时诊断、强制干净重建确认 |
| feat | cds | React 分支详情页的有效配置卡片支持常用 profile override 编辑：覆写命令、镜像、端口、路径前缀，以及恢复公共配置；保存后提示重新部署生效 |
| feat | cds | React 分支详情页补齐运维入口：预览别名编辑、历史 commit 固定/恢复、当前分支 HTTP 转发日志；会改变 worktree 指向的固定/恢复操作都先弹确认 |
| feat | cds | React 分支详情页新增 Bridge 面板：可激活/结束会话、查看 Widget 连接状态、读取页面状态；不暴露任意 click/type 遥控命令 |
| feat | cds | `/branch-panel` 接管为 React 详情页时曾临时保留 `/branch-topology?project=<id>` 拓扑入口，后续继续迁入 React 以避免能力断层 |
| feat | cds | `/branch-topology?project=<id>` 已迁到 React 简化拓扑，展示应用服务、基础设施、分支运行状态、依赖和跳转入口 |
| test | cds | 扩展 server-integration 路由契约：确认 `/branches/:projectId`、`/branch-list`、`/branch-panel`、`/branch-topology` 都由 React 接管，`/api/*` 不被 shadow |
| test | cds | 修正分支 API 测试的 default 前提：legacy default 行为由测试显式 seed，不再依赖 fresh install 自动创建空 `default` 项目 |
| docs | cds | 新增 Week 4.5 功能差距收敛计划：删除旧前端前先借鉴 legacy 分支页/拓扑页的必要运维能力，且删除 `web-legacy/` 必须等待用户明确确认 |
| refactor | cds | 调整 React 分支页功能层级：快速预览支持粘贴任意分支名，容量状态和批量运维移到右侧面板，单分支低频操作收进“更多操作”，并在部署前加入容量超限确认 |
| fix | cds | 优化分支页桌面布局：`lg` 起固定右侧运维栏，分支卡片保持单列，`2xl` 才恢复双列，避免功能层级正确但位置掉到页面下方 |
| fix | cds | 分支部署动作新增耗时和最近 SSE 步骤；部署流正常结束但分支进入异常时，卡片显示失败摘要，不再误报“部署完成” |
| polish | cds | 异常分支卡片新增可操作失败建议：突出失败服务，直接提供“看详情”和“重置异常”，避免只显示红色状态让用户猜下一步 |
| feat | cds | 分支页右侧新增“最近活动”，订阅 `/api/activity-stream` 展示 CDS/Web/API 事件，先替代旧页悬浮 Activity Monitor 的核心排错信息 |
| feat | cds | 分支页右侧运维状态新增容量预估：勾选分支后提前显示预计新增容器与剩余容量，容量不足时在批量部署前明确提示 |
| feat | cds | 分支页右侧新增“执行器”状态卡，读取集群模式、在线节点、空闲容量和主执行器；轮询带 `X-CDS-Poll` 避免污染活动流 |
| feat | cds | 分支页右侧运维栏补主机健康与容量腾挪：读取 `/api/host-stats` 展示 CPU/内存/uptime，容量不足时可一键停止较旧运行分支腾出容量 |
| feat | cds | 分支页执行器卡升级为节点列表，展示每个执行器的分支数、CPU、内存，并提供带确认的排空与移除入口 |
| feat | cds | 分支页 Activity Monitor 补 API/Web/AI 筛选和“复制摘要”，排查自动化触发、预览访问和 API 失败时不用再翻旧悬浮面板 |
| feat | cds | 分支页 Activity Monitor 补按具体分支筛选和内联详情面板，可查看 method/path/status/duration/source/branch/profile/body 并复制摘要 |
| refactor | cds | 右侧栏顺序调整为快速预览 → 远程分支 → 运维状态 → 执行器 → 批量运维 → 最近活动，避免一键预览入口被运维信息压低 |
| feat | cds | 分支详情页新增“失败诊断”：异常分支首屏汇总失败服务、配置缺失和最近错误步骤，并给出补命令、看日志、运行诊断、重部署入口 |
| fix | cds | 分支详情页运行时诊断改为可读摘要；后端在容器不存在或未运行时返回明确 400，避免 `No such container` 被包装成“诊断完成” |
| fix | cds | `exec_cds.sh` 的后端/前端构建缓存不再只看 Git HEAD；本地源码或 web 源码有未提交改动时会重新构建，避免预览服务继续使用旧 dist |
| feat | cds | 分支详情页提交历史补搜索、最新/当前/已固定标识；当前提交不可重复固定，固定状态下最新提交提供“恢复最新”入口 |
| feat | cds | 分支详情页动作日志区分运行中/完成/失败并支持复制；force rebuild 部分失败时显示失败状态和重试/重部署建议 |
| feat | cds | 分支详情页 HTTP 转发日志改为订阅 `/api/proxy-log/stream` 实时追加当前分支记录，并补筛选、异常/慢请求摘要、upstream/耗时/提示展示 |
| feat | cds | React 拓扑页应用服务节点详情补 `详情 / 分支 / 路由 / 变量` tab，并加载项目路由规则展示服务相关入口 |
| feat | cds | React 拓扑页分支选择器补搜索；无匹配时提供“创建/部署分支”入口回分支列表主链路，保留共享视图/单分支视图切换 |
| polish | cds | React 拓扑页补第一轮控制台视觉打磨：顶部摘要条、分支上下文工具条、节点状态图标/运行计数/路由标签、sticky 详情面板和默认节点选中，降低“无 CSS 感” |
| feat | cds | React 拓扑页应用服务节点详情新增“日志 / 提交”tab：单分支视图复用分支详情 API 读取构建事件、容器日志和最近提交，日志可复制，提交固定/恢复仍跳分支详情页处理 |
| polish | cds | React 拓扑页补第二轮信息层级：分支选择同步 URL，新增当前视图状态条和预览/详情入口，服务节点补运行覆盖条，详情 tabs 在窄栏下保持规整 |
| fix | cds | `exec_cds.sh init` 不再询问是否启用 MongoDB；新初始化自动启用 `mongo-split`，Mongo 启动失败直接失败，不再静默退回 JSON/state.json |
| polish | cds | `/branches/:projectId` 首屏改为“分支控制台”：统计、粘贴分支预览、项目/设置/拓扑入口统一放到顶部，右侧栏从远程分支开始，分支卡改为行式操作卡并复用 `MetricTile` |
| polish | cds | `/branches/:projectId` 视觉第二轮：顶部合并为一键预览控制台，分支卡固定为“身份 / 指标 / 操作”三栏，主按钮不再在桌面窄宽下错位换行 |
| polish | cds | 举一反三修复 React 迁移版“未完成品感”：移除全屏网格背景，分支页取消宽屏双列假响应式；项目页、分支页、分支详情、拓扑、项目设置和系统设置页收敛到居中控制台工作区，并把标题、工具条、表单和列表行纳入同一视觉层级 |
| polish | cds | `/branches/:projectId` 默认视图减负：筛选/排序/批量、容量、主机、执行器和活动流默认折叠；分支卡移除独立指标列，只保留预览、详情、部署和更多操作 |
| polish | cds | `/branch-panel/:branchId` 默认视图减负：构建日志、容器日志、有效配置、Bridge、提交历史和 HTTP 转发日志收进折叠面板，默认只暴露服务状态和主操作 |
| polish | cds | `/branch-topology` 节点详情减负：取消默认六 tab 详情面板，改为摘要、状态、主操作和统一折叠的配置/分支/路由/变量/日志/提交 |
| polish | cds | `/cds-settings#maintenance` 默认聚焦自更新主链路，SSE 日志、镜像外观和危险操作默认折叠 |
| refactor | cds | 新增共享 `DisclosurePanel`，分支详情、拓扑节点详情和维护页统一折叠面板样式，避免后续页面继续复制局部 details 结构 |
| polish | cds | `/project-list` 首屏继续减负：顶部只保留新建/刷新/待处理 Agent 申请，技能包、全局 Key、Agent 记录收进“自动化工具”；项目列表从横向长行改为卡片网格，设置、Agent Key 和删除默认折叠到项目卡“管理” |
| polish | cds | 分支部署排错闭环第一轮：部署动作卡展示阶段、耗时、最近步骤、失败建议和可复制排错摘要；分支详情动作日志失败时同步给下一步建议 |
| polish | cds | `/branch-topology` 补粘贴分支预览入口，提交后跳回 `/branches/:projectId?preview=<branch>` 复用分支控制台的一键创建、部署和打开预览链路 |
| feat | cds | 将 CDS 系统设置页迁移到 React：`/cds-settings` 接入 `MIGRATED_REACT_ROUTES`，新增 Radix Tabs 包装和 7 个系统设置 tab，所有新页 API 调用走 `apiRequest()`；删除 legacy `cds-settings.html/js`，并把旧入口统一改到干净路径 |
| feat | cds | 在 React `/cds-settings#github` 补齐 GitHub Device Flow：展示配置/连接状态、设备码登录轮询、复制代码、打开 GitHub、断开连接确认，并保留 GitHub App webhook/check-run 配置面板 |
| fix | cds | 修复本地初始化与预览启动：`exec_cds.sh init` 在 `sh` 调用时自动切回 bash，并修正 MongoDB 启动提示中的变量边界；后台启动端口检测增加 macOS `lsof` fallback，避免没有 `ss` 时误判 CDS 未启动 |
| feat | cds | `/cds-settings#maintenance` 补齐 React 自更新控制台：展示当前源码分支/commit、目标分支选择、自更新预检、更新重启、强制同步确认和可复制 SSE 日志 |
| feat | cds | `/cds-settings#global-vars` 改为可编辑环境变量表：支持新增、编辑、删除、搜索、密钥遮蔽/显示/复制，并保留全局变量一键整理到项目的 dry-run 预览 |
| feat | cds | `/cds-settings#storage` 展示 mongo-split 目标状态、Mongo 健康、`.cds.env` 注入诊断，以及 `cds_projects / cds_branches / cds_global_state` 集合计数 |
| feat | cds | `/cds-settings#cluster` 从只读节点列表升级为集群控制台：展示主机健康、调度策略、执行器详情，支持签发连接码、粘贴加入主节点、退出集群、排空/移除节点 |
| feat | cds | `/cds-settings#auth` 补统一认证状态与退出入口；basic/GitHub 模式可直接退出登录，disabled 模式明确显示本地开发状态 |
| fix | cds | 补齐 host-stats、activity/state stream、cluster/executor、AI pairing 和 Bridge API 的中文 label，避免启动日志和 Activity Monitor 出现无意义空标签 |
| fix | cds | 修复 React 设置页 hash 深链：同一页面内切换 `#storage/#maintenance/#global-vars` 时 tab 内容会跟随 URL，不再停留在旧 tab |
| fix | cds | CDS 真实运行时默认存储改为 `mongo-split`；未配置 `CDS_MONGO_URI` 会要求先运行 `./exec_cds.sh init`，只在测试或显式兼容模式继续使用 JSON |
| refactor | cds | 大重命名：`cds/web/` 改为 React 工程（原 `web-v2/`），`cds/web-legacy/` 收纳老前端（原 `web/`），URL 不再带 `/v2/` 前缀 |
| refactor | cds | server.ts 重构 `installSpaFallback`：删 `/v2/*` 挂载，改为 `MIGRATED_REACT_ROUTES` 显式枚举已迁移路由（目前 `['/hello']`），其余请求 fall through 到 `cds/web-legacy/` |
| refactor | cds | `exec_cds.sh` `build_web_v2()` 重命名为 `build_web()`，构建输出从 `cds/web-v2-dist/` 改为 Vite 默认 `cds/web/dist/` |
| test | cds | 重写 server-integration 测试：守卫「React 仅服务已迁移路由 + `/api/factory-reset` 复活接口永远可达 + 未迁移路径 100% 走 legacy」三层契约 |
| docs | doc | `plan.cds-web-v2-migration.md` → `plan.cds-web-migration.md`，全文刷新去除 `/v2/` 表述，记录新架构「web/ + web-legacy/」 |
| docs | cds | `cds/CLAUDE.md` 目录结构段刷新：明示新栈 `cds/web/` 与老栈 `cds/web-legacy/` 并存；`scope-naming.md` 路径示例同步更新 |
| feat | cds | 将 `/project-list` 接入 React 项目列表基础版：列表、空状态、新建、删除、进入项目、legacy default 迁移/残留清理都走 `apiRequest()`；fresh install 保持 0 项目，不再展示空 `default` 横幅；存储默认路径收敛到 MongoDB `mongo-split` 多 collection |
| feat | cds | 在 React 新建项目 Dialog 中加入 GitHub 仓库选择器：读取 `/api/github/repos?page=N`，支持搜索、加载更多、选中后自动填充 clone URL；未连接 Device Flow 时引导到 `/cds-settings#github` |
| feat | cds | 在 React 项目列表加入 clone progress：pending/error 项目可开始或重试克隆，新建 Git 项目后自动打开 SSE 进度 Dialog，展示 `/api/projects/:id/clone` 流式日志 |
| feat | cds | 将 clone 后自动配置下沉到后端：`POST /api/projects/:id/clone` 成功后自动检测技术栈并创建默认 BuildProfile，减少“创建项目后还要手填 profile”的步骤 |
| feat | cds | 用 GitHub clone URL 创建项目时自动记录 `githubRepoFullName` 并默认开启 push 自动部署；首次 webhook 会回填 installation id，让 repo picker 到 webhook 自动化连成一条链 |
| feat | cds | 在 React 项目卡片加入项目级 Agent Key 管理：只读列出现有 key，签发前确认并仅显示一次明文，吊销前二次确认 |
| feat | cds | 将 Agent pending import 审批迁入 React 项目列表：`/project-list?pendingImport=<id>` 自动打开记录，可预览 YAML、批准应用或拒绝留痕 |
| feat | cds | 在 React 项目列表 header 加入“下载技能包”和“全局通行证”：技能包直连 `/api/export-skill`，全局 Key 支持签发、列表、吊销并保留二次确认 |
| polish | cds | 新建项目流程简化：粘贴 Git 仓库 URL 即可自动推导项目名，项目名称不再是创建仓库项目前的必填阻塞项 |
| polish | cds | 重排 `/project-list` 首屏信息层级：项目控制台统一承载统计、安装技能包、全局 Key、Agent 记录、快速 Git URL 创建与项目行操作，项目卡从大卡片改为横向操作行 |
| refactor | cds | 抽出共用 `MetricTile` 信息块，替换项目列表、项目设置统计、分支详情和集群设置里的重复 `Metric/Stat` 小组件 |
| test | cds | 更新 pending-import 路由测试，不再假设 fresh install 自动存在 `default`；legacy default 兼容测试改为显式 seed |
| test | cds | 更新 global-agent-keys 路由测试，项目级 key 权限边界用显式 seed 的 legacy default 项目验证 |
# 2026-04-28 Project Settings React Migration

## Changed

- Added React `/settings/:projectId` project settings page with general settings, project stats, branch stats, and recent activity logs.
- Added project-level GitHub settings with App status, repo binding picker, linked repo controls, auto-deploy toggle, and per-event webhook policy toggles.
- Updated project-level auto-deploy toggles to write GitHub event policy directly, so repo-only projects created from GitHub clone URLs can enable/disable push automation before installation id is known.
- Added project-level GitHub PR preview comment template editing with variable insertion and sample preview.
- Added project-level environment variable management at `/settings/:projectId#env` with add/edit/delete/search, secret masking, reveal, and copy controls.
- Added cache diagnostics in React with cacheMount status, warnings, repair, export, import, and purge confirmation controls.
- Added the project danger zone in React with protected legacy projects and a confirmation dialog before project deletion.
- Reworded CDS startup storage output so Mongo split mode reports `State store` instead of a misleading `State file`.
- Redirected `/settings.html?project=<id>` to `/settings/<id>` and updated project settings links to the semantic path.
- Fixed hash deep-link syncing so `/settings/:projectId#env` and other tabs render the matching tab even when navigating inside the same React page.
- Updated CDS migration runbook and plan docs so future agents have the current commands, validation checklist, and next migration tasks.

## Validation

- `pnpm --prefix cds/web typecheck`
- `pnpm --prefix cds/web build`
- `pnpm --prefix cds build`
- `pnpm --prefix cds exec vitest run tests/services/stack-detector.test.ts tests/routes/projects.test.ts tests/routes/github-webhook.test.ts tests/integration/multi-repo-clone.smoke.test.ts`
- `pnpm --prefix cds exec vitest run tests/routes/server-integration.test.ts tests/routes/projects.test.ts tests/routes/legacy-cleanup.test.ts tests/services/state-projects.test.ts`
- `pnpm --prefix cds exec vitest run tests/routes/server-integration.test.ts tests/routes/projects.test.ts tests/routes/comment-template.test.ts tests/services/comment-template.test.ts`
- `pnpm --prefix cds exec vitest run tests/routes/storage-mode.test.ts tests/routes/server-integration.test.ts`

### 2026-04-27

| 类型 | 模块 | 描述 |
|------|------|------|
| refactor | prd-admin | 统一 appCaller 命名 — 撤回 FE-内部 `appCallerKey` 历史漂移，改回与后端 wire-level 概念一致的 `appCallerCode`：`AppCallerKeyIcon` → `AppCallerCodeIcon`，`parseAppCallerKey` → `parseAppCallerCode`，`ParsedAppCallerKey` → `ParsedAppCallerCode`，`AppGroup.items[].appCallerKey` → `appCallerCode`。`groupAppCallers` ingest 阶段保留 `appCallerKey` 兼容读取（防止任何残留调用方传旧字段），其余产出/消费一律 `appCallerCode`。无数据库改动 |
| fix | cds | cds-compose.yaml api 服务加 Node.js 20 + 系统 Chromium 安装 + 挂载 /prd-video + node_modules/apt 缓存卷，让 Remotion 单镜渲染能在 CDS 容器里执行（之前裸 dotnet/sdk 镜像没 npx，分镜渲染必报 Win32Exception "No such file or directory"）|
| fix | cds | 部署错误日志缺失 — POST /api/branches/:id/deploy 的 post-layer 阶段（自动 smoke / GitHub check-run finalize）抛出异常时只 sendSSE('error') + 设 entry.errorMessage，但**没写入 opLog.events**，导致 GET /api/branches/:id/logs 看到全部 events 都是 done 但 entry.status=error，GitHub Checks 只显示 "Deploy failed" 没有阶段信息。现在：(1) maybeRunAutoSmoke 单独 try/catch，失败时 logEvent step='auto-smoke' status='error' 含 stack trace；(2) checkRunRunner.finalize 同上 step='check-run-finalize'；(3) 外层 catch 第一行加 logEvent step='deploy' status='error'，错误信息 + stack 写入 opLog.events；(4) 兜底 finalize 二次失败也单独 try/catch，不让 throw 冒泡破坏 finally。同时把 smoke summary 的  emoji 改为「通过/失败」中文（CLAUDE.md §0 禁 emoji） |
| feat | cds | 新增 ./exec_cds.sh migrate-env 子命令，默认仅扫 .cds.env（不串 ~/.bashrc / shell env，避免 PNPM_HOME / NVM_DIR 等开发工具变量被误归项目级），按 CDS canonical / CDS legacy / 项目级 三类分流，自动写 .cds.env 与 migration-project-env.txt，末尾询问是否立刻 restart；用 --from FILE 追加额外源、--verbose 看变量名明细 |
| feat | cds | Dashboard 环境变量弹窗（全局 tab 下进入具体项目时）顶部新增「一键整理 → 此项目」按钮：调 POST /api/env/categorize 用 known-env-keys 字典分类。CDS canonical (CDS_*) 留全局；CDS legacy（JWT_SECRET / PREVIEW_DOMAIN 等历史无前缀名，syncCdsConfig 真的从 _global 读它们）**复制一份到项目**（CDS 读全局副本，项目读项目副本，两边独立隔离）；其他项目级变量（GITHUB_PAT / R2_* 等）从全局移到项目。撞名（项目里已有同名且值不同）以项目原值为准不覆盖。先 dryRun 预览四类分组 → 用户确认 → 执行 |
| feat | cds | 新建 cds/web/cds-settings.html「CDS 系统设置」独立页：7 tab（概览 / 登录与认证 / GitHub 集成 / 存储后端 / 集群 / CDS 全局变量 / 维护），把原本散落在 4 处（项目列表  / 分支页  / 拓扑左栏 / settings.html 误归项目级）的所有系统级配置集中。settings.html 保持项目级语义但删除 storage/github 两个 tab（它们影响整个 CDS 实例，已搬到 cds-settings），命中时自动 redirect。settings.html 必带 ?project=<id>，否则 redirect 到 project-list 配 toast 解释 |
| feat | cds | 新增 .claude/rules/scope-naming.md 强命名规范：锁死 4 个唯一术语（CDS 系统设置 / CDS 全局变量 / 项目设置 / 项目环境变量），禁用裸「设置」「用户设置」「全局设置」「CDS 全局设置」。cds/CLAUDE.md 速查表加引用。配 URL / API / UI / 状态字段 / commit message 全套规范 |
| refactor | cds | 入口大整理（按 scope-naming）：① 项目列表页 user popover 把"GitHub 设置"改为「CDS GitHub 集成」+ 加「CDS 系统设置」入口；② 项目列表  菜单顶部加「CDS 系统设置」醒目入口，移除散落的预览模式/镜像加速/标签名开关（已收进系统设置维护 tab）；③ 分支页  菜单分两段「项目级 / 系统级」，"环境变量"改名「项目环境变量」；④ 拓扑左栏拆「项目设置」+「系统」两个独立图标；⑤ project-list.html  title 改「CDS 系统设置」 |
| feat | cds | 新增 RESTful per-project API：GET/PUT /api/projects/:id/preview-mode + GET/PUT /api/projects/:id/comment-template；老路径 /api/preview-mode 和 /api/comment-template 保留兼容，但响应加 Deprecation: true + Link 头指向新路径，让外部 Agent 调用方平滑迁移 |
| feat | cds | 启动时识别 .cds.env 中的 CDS legacy 旧名（JWT_SECRET / AI_ACCESS_KEY / PREVIEW_DOMAIN / ROOT_DOMAINS / MAIN_DOMAIN / DASHBOARD_DOMAIN / SWITCH_DOMAIN）并打 deprecation warning，引导跑 migrate-env，仍兼容读取 |
| refactor | cds | 新增 cds/src/config/known-env-keys.ts 作为内置环境变量字典 SSOT；getCdsAiAccessKey() 优先读 CDS_AI_ACCESS_KEY，fallback 旧名 AI_ACCESS_KEY |
| fix | cds | runSmokeForBranch 不再用 `...process.env` 整体透传 host 环境给冒烟脚本，改为 PATH/HOME/LANG 等 shell 必需 + SMOKE_* 显式参数的白名单，杜绝 CDS_GITHUB_APP_PRIVATE_KEY 等密钥泄漏到子进程 |
| refactor | cds | 分支卡片右上角操作图标整合：收藏星标 + 复制分支名 + 打开预览 + 拉取更新 + 调试灯泡统一并入 .branch-card-toolbar，分支名独占整行不再被 hover 弹出的 quick-actions 挤占；删除已废弃的 .branch-quick-actions 容器与 hover 展开 50px 的过渡逻辑；绿色状态点保留在分支名前原位；is-favorite 卡片工具栏常驻可见 |
| refactor | cds | 加载页极简化 — 删除 .cds-loading-aura（光晕）+ .cds-loading-core 含 ::before/::after（双层圆环）+ .cds-loading-ring（第三层圆）+ .cds-loading-axis（横轴线）+ .cds-loading-hint（"正在同步分支视图" 中文文案），只保留 CDS 三字母呼吸 wordmark + 一条 140×1px 扫光线（参考 Linear / Vercel / Stripe 风格）。同步删除 4 个无引用的 keyframes（cds-loader-aura / orbit / orbit-reverse / axis / cds-hint-in）+ light theme 对应选择器；HTML / app.js 注入 fallback 都同步精简 |
| refactor | cds | PR_A: 全局态迁移到 Project model — Project 新增 customEnv / defaultBranch / previewMode / commentTemplate 4 字段；StateService 加 getDefaultBranchFor / getPreviewModeFor / getCommentTemplateFor / setProjectXxx helpers；getCustomEnv() 自动 4 层叠加（global → state[projectId] → project.customEnv，后者覆盖前者）；scheduler.isPinned / janitor.isBranchProtected / 自动 smoke env / GitHub webhook commentTemplate 全部走 per-project 读取；PUT /preview-mode 与 PUT /comment-template 接受 projectId 参数；启动时新增 migrateGlobalsToProjects() 一次性把旧 state 字段 seed 到所有项目；旧 state 字段加 @deprecated JSDoc，灰度期保留写入兼容老 fallback |
| feat | cds | PR_B.4-B.6: 新增 mongo-split 存储模式 — projects 与 branches 拆到独立 collection（cds_projects / cds_branches），其余字段集中在 cds_global_state 单文档。新增 MongoSplitStateBackingStore + RealMongoSplitHandle；保持 sync load() / write-behind save() 契约让 StateService 完全无感；自带 seed-from-json（首次切换时一次性把 state.json 导入新 collection 结构）；新增 CDS_STORAGE_MODE=mongo-split 选项（opt-in，默认仍 json，旧 mongo 单文档模式保留）；branches collection 自动建 projectId 索引以支持 per-project 查询 |
| refactor | cds | PR_B.1: routingRules / buildProfiles / infraServices / branches 的 projectId 类型从 optional 变为必填；migrateProjectScoping() 改为以 legacyFlag 项目的真实 id 为准（不再硬编码 'default'）+ 同时回收孤儿引用（projectId 指向不存在项目的条目自动 retarget 到 legacy）；composeDefToInfraService 改为必传 projectId 参数；executor/scheduler stub branch 创建时显式传 projectId |
| feat | cds | PR_C.1-C.3: 项目+分支运营计数 + 活动日志 — Project / BranchEntry 加 deployCount / pullCount / stopCount / aiOpCount / debugCount + lastDeployAt / lastAiOccupantAt 字段；新增 ProjectActivityLog 类型 + state.activityLogs[]（per-project ring buffer，上限 200 条，后期可迁独立 collection）；StateService 加 incrementBranchStat / stampBranchTimestamp / appendActivityLog / getActivityLogs helper（branch 自增同步刷 project 计数）；埋点覆盖 5 个热点：POST /branches/:id/pull / deploy（success/failed 分别记）/ stop / PATCH 切 isColorMarked / Bridge start-session + end-session（AI 占用）；新增 GET /api/projects/:id/activity-logs 端点（limit/since query）+ resolveApiLabel 注册「获取项目活动日志」 |
| feat | cds | PR_D.1-D.4: per-project GitHub 事件 policy — Project 加 githubEventPolicy 字段（5 个独立 toggle: push / delete / prClose / prOpen / slashCommand），webhook dispatcher 在每个 handler 入口加 isEventEnabled() 门禁短路关闭的事件类型；老 githubAutoDeploy 字段标 @deprecated 但仍作为 push policy 的 fallback 保证向后兼容；PUT /api/projects/:id 接受 githubEventPolicy partial patch；Settings GitHub Tab 新增「GitHub 事件处理」section 渲染 5 个 toggle，按 toggle 自动 PUT 同步到 project，失败回滚 |
| fix | cds | PR #509 review fix batch 2 — (1) Codex P1 XSS：settings.js stats tab 活动日志 + 分支详细计数表的 branchName / note / actor / typeLabels[type] / branch 字段全部走 escapeHtml，恶意 branch 名/note 不再能注入 HTML；(2) Bugbot Medium：setProjectDefaultBranch / setProjectPreviewMode / setProjectCommentTemplate 不再无条件覆盖 state.X 全局字段，改为「仅当 state 字段 == null 时填一次起步值」，避免多项目下 last-writer-wins 把别的项目的全局兜底覆盖；(3) Codex P2：项目自动初始化 main 分支为 default 时不再 AND state.defaultBranch 全局检查（多项目环境下经常被别的项目设过，新项目永远拿不到 defaultBranch）；(4) Bugbot Low：抽出 services/actor-resolver.ts 共享 resolveActorFromRequest，branches.ts 与 bridge.ts 不再各写一份；(5) Bugbot Low：mongo-split-store.ts save() 把 for-loop replaceOne 改为 bulkWrite + deleteMany，N 个项目 / 分支从 N 次 round-trip 收敛到一次 bulk |
| fix | cds | PR #509 review fixes — vitest 3 个失败修复（getLegacyProject 改回严格语义只看 legacyFlag，新增 private resolveOrphanFallbackProject 专用于 orphan projectId 回收 + addBranch/Profile/Rule/Infra 兜底；migrateProjectScoping 的 retarget 收紧到「projectId='default' 字面值 且 'default' 项目不存在」单一场景，不再激进 retarget 任意 orphan）；Bugbot Medium 修复 failedNames 用 activeServices 过滤，zombie service 不再混进 completeMsg / activity log note；Bugbot Low 修复 bridge recordAiActivity 加 actor 参数（X-AI-Impersonate / X-AI-Access-Key / cookie 三档解析）；Codex P1 修复 getCustomEnvRaw 投影 project.customEnv 进 raw 视图（避免 PUT /env?scope=projectId 后 GET 返 stale）+ getCustomEnvScope 同样 project 优先；CLAUDE.md / cds/CLAUDE.md / .claude/rules/cds-theme-tokens.md 标题里的 emoji 删除（自违反 §0），加 §0 自我例外条款明确 inline code 字面量可保留作反例 |
| fix | cds | 修复非 legacy 项目预览子域名进入"刷新即重建"死循环：proxy 的 routeToBranch / handleUpgrade 加 canonical id 兜底（`${projectSlug}-${slug}`），裸 slug 子域名（如 `claude-redesign-foo.miduo.org`）不再 miss 项目作用域下的 entry 反复触发 auto-build。补 3 条回归用例（vitest 832 → 832 全绿） |
| refactor | cds | 重写 auto-build transit 页（`buildTransitPageHtml`）：硬编码 `#0d1117/#161b22` 暗色字面量替换为 inline CSS token + `prefers-color-scheme: light` 双主题；步骤改为左侧时间轴；日志默认折叠；完成态由"3 秒倒计时自动刷新"改为「 预览环境已就绪 + 「前往预览」按钮 + 兜底提示」——避免 SSE complete 与上游真正接管端口之间的窗口期触发 Chrome HTTP ERROR 400 |
| refactor | cds | 项目卡片改简约设计（参考 Railway 风格）— 删除 chips 行（13 分支 / 20 运行中 / 最近部署 / GitHub repo 4 个 chip）+ 删除「进入分支 →」CTA；GitHub repo 移到 header 标题右侧 mini-link（小 icon + 短名 + hover 高亮），分支数 + 最近部署时间放 footer tooltip；footer 收成单行 `● production · X services · Y running`，绿色 dot 通过 ::before 渲染，运行中数字用绿色加粗强调；标题字号 16→17px + letter-spacing 收紧 |
| refactor | cds | 项目卡右上角 3 按钮（下载 / 授权 / 删除）尺寸 28→26px，svg 内边距收紧到 13px；header padding-right 36→100px 给三按钮让位 |
| feat | cds | 新增 cds/web-v2/ 工程（Vite + React + TS + Tailwind + shadcn/ui），挂载在 /v2/ 路径，老页面与复活接口零影响 |
| feat | cds | server.ts installSpaFallback 支持可选 v2DirOverride，缺失时 warn 不阻塞启动 |
| test | cds | server-integration 新增 2 个测试守卫 /v2 挂载边界 + POST /api/factory-reset 不被 shadow |
| docs | doc | 新增 plan.cds-web-v2-migration.md 含 Week 2-5 迁移路线图与交接说明 |
| fix | cds | 部署"假阴性"失败修复 — entry.services 里残留的 zombie service（旧 buildProfile 已删/改名但 service entry 还停在 status='error'）会让本次部署的 hasError 计算为 true，进而把 opLog.status / GitHub check-run conclusion 设为 'failure'，但 events 里没有这个服务的任何痕迹（因为本次 startup-plan 根本不包含它）。修复：post-layer 计算 hasError 时只考虑本次 deploy 的 active profiles（profilesData 里的 ids），zombie services 单独走 logEvent step='zombie-service' status='warning' 含 profileId / status / containerName，让运营能立即从事件流发现孤儿条目并手动清理 |
| fix | prd-admin | 「/executive」短标签从「执行」改为「统计」（页面实际是总裁面板/统计看板，icon 也是柱状图） |
| fix | prd-admin | Cmd+K 命令面板（AgentSwitcher）智能体/百宝箱去重：launcherCatalog 在 dedup 阶段加 route 维度，buildAgentItems 早于 buildToolboxItems，相同 route 的视觉/文学/缺陷/视频不再在两个分组重复 |
| feat | prd-admin | Cmd+K 命令面板新增「其他菜单」分组：launcherCatalog 接收可选 menuCatalog，把 launcher 没注册的后端菜单项（海报/技能/执行等）作为 group='menu' 并入；同 route 用 menu.appKey 改写 id 兼容历史 navOrder |
| feat | prd-admin | 周报 Agent「今日打点」日期选择器优化：点击日期文字直接弹出原生日期选择器，支持跨周/跨月任意日期跳转，原 ←/→ 与「今天」按钮保持不变 |
| fix | prd-admin | 修复"有团队却默认进周报 Tab"的 bug — ReportAgentPage 增加首次进入页面后的一次性 Tab 校准:有任意团队成员关系(Leader 或成员)默认进「团队」Tab,无关系才进「周报」Tab |
| fix | prd-admin | 周报详情页左侧「本周周报」侧栏在审阅/退回后状态实时翻面 — 之前只有 TeamDashboard 团队列表会实时更新,详情页内部侧栏没订阅 store 事件,要刷新才看到变化 |
| fix | prd-api | 修复知识库卡片"暂无内容"与 documentCount 不一致：recentEntries 改为按 store 维度独立查询，避免单次全局 sort+limit 导致活跃度低的 store 被抢占额度 |
| refactor | prd-admin | 免提交开关从「团队周报列表 → 成员 drawer」迁移到「设置 → 团队管理 → 成员行」(非高频动作不应在主页面打扰),drawer 内仅保留状态展示 |
| chore | prd-admin | 团队管理成员行隐藏「身份映射」图标(暂不具备使用条件,等多平台绑定流程完善后再开放) |
| fix | prd-admin | 文本输入控件焦点环改为 inset，杜绝被父容器/邻居遮挡 — `globals.css` 全局 `:focus-visible` 规则用 `outline-offset: 2px`（外环），紧贴父容器边时会被裁。新增 `input/textarea/select:focus-visible { outline-offset: -2px }` 把 outline 画在 border 内侧，全站文本输入框焦点环不再越界。按钮/卡片等保持外环不变（不影响 a11y 反馈） |
| feat | prd-admin | 周报主页改为"每次从外部进入(路由变化)都按团队成员关系强制落地 Tab" — 有团队关系永远进「团队」Tab,无关系进「周报」Tab;用 location.key 跟踪进入事件,会话内主动切换不影响 |
| fix | prd-admin | 修复"有团队仍落地周报 Tab"残留 bug — 旧逻辑用 store.loading 判定数据稳态,但 loadReports 内部会抢先把 loading 置 false,导致 ReportAgentPage 在 teams 未到位时就抢跑,hasTeamWorkspace=false 锁死到 report;新增 teamsLoaded 显式标志,等 listReportTeams 真正完成才校准 |
| chore | prd-api | ListReports 端点加 try/catch + logger.LogError 详细日志,500 错误响应中携带 ex.Message,便于排查根因(之前空白「服务器内部错误」无法定位) |
| feat | prd-admin | 应用搜索框扩大匹配范围 — 现在除了 appName / appCode 外，也会扫描每个 appCallerKey 和 displayName，让用户能直接搜 `visual-agent.image.text2img` 这类完整 code 定位到对应分组 |
| fix | prd-admin | 补全 appCaller 中文显示名映射表 — 新增 channel-adapter / system / transcript-agent / review-agent / pr-review / document-store / emergence-explorer / skill-agent / prd-agent 的中文标签。同步在表头加 TODO 注释，标记其违反 frontend-architecture.md SSOT 原则的架构债（同样问题存在于 getFeatureDisplayName） |
| fix | prd-api | AppCallerRegistry.cs 补全 System 和 SkillAgent partial class 的 `AppName` 常量（其他 partial class 都有，只有这两个漏了） |
| feat | prd-admin | 模型池管理页左侧栏顶部加 ModelTypeFilterBar — 用户可按 13 种模型类型 (chat/intent/vision/generation/...) 快速过滤池列表 |
| refactor | prd-admin | 模型池管理页右侧操作区重构 — 删除「预测调度」按钮（用户认为多余），新增显眼的「+ 添加模型」主按钮直接跳过编辑表单弹模型 picker，confirm 后直接 PATCH 池。复制/编辑/删除保持小图标但置于主按钮右侧。删除 PoolPredictionDialog / handlePredict / Radar / predictNextDispatch 在本页的所有引用 |
| refactor | prd-admin | 模型池展开区改为紧凑模式 — 每个模型池一行（名称 + 数量徽章 + 数+ 眼睛按钮），点击卡片/眼睛展开池内模型详情；徽章仅在 >1 模型时显示，模型数量超过 5 时不再被强制平铺，信息密度大幅提升 |
| refactor | prd-admin | 模型池布局再优化 — 改为响应式卡片网格（sm 2 列 / lg 3 列），充分利用横向空间；移除上方重复的 inline 池名标签（与下方卡片重复）；移除池行的  非健康摘要徽章（避免与"报错"误读，健康详情在展开后查看） |
| refactor | prd-admin | 模型池卡片改为「总览即详情」模式 — 移除眼睛/折叠交互，模型直接平铺在卡片体内，对齐 OpenRouter / OpenAI Platform / Anthropic Console 同类设计。卡片永不显示空白，卡片高度按池内模型数自然伸缩（CSS Grid 行高自适应） |
| fix | prd-admin | ModelListItem 模型名 `truncate` 单行省略改为 `line-clamp-2 break-all`，长模型 ID（如 `gpt-image-2-all`）允许跨行显示，hover 仍有完整 tooltip |
| refactor | prd-admin | 模型池卡片体改为自有两行布局，不再复用 ModelListItem（避免 mid-word 折叠"牛皮癣"现象）：第 1 行模型名占满整行（无截断、无 break-all 强行断字），第 2 行小字展示「平台名 · 统计」。Healthy 状态不再展示"健康"chip，无统计时不再展示"暂无统计"占位，显著降噪。同时撤销 ModelListItem 的 line-clamp 改动（不影响其他调用方） |
| feat | prd-admin | 模型池卡片复用 LegacySingle "模型池降级"警示条的视觉语言：池内任一 Unavailable → 卡片整体换黄色虚线边框 + 池名前置  图标；全部 Unavailable → 红色虚线边框；模型行 Unavailable → 红色文字 + 删除线 + 红底；模型行 Degraded → 黄色文字 + 黄底（不删除线，仍可用）。状态信息无需阅读即可在视觉边缘看到 |
| fix | prd-admin | 周报 Agent「我的记录」过滤 Tags 数组里混入的系统分类键（development/meeting 等），避免与顶部中文分类徽标重复显示 |
| fix | prd-admin | 修复 phantom 路由：launcherCatalog 写的 /prompts 在 App.tsx 实际不存在（点击 404）已删除；/models 实际是 /mds，已纠正 |
| fix | prd-admin | infra:my-assets 路由从查询字符串别名 `/visual-agent?tab=assets` 改为真实路由 `/my-assets` |
| feat | prd-admin | 新增 navCoverage.test.ts 自动化护栏：CI 扫描 App.tsx 所有 Route，每条必须在 launcherCatalog 注册 / 在 ALLOW_LIST 显式豁免 / 是参数化子路由；同时检测 phantom 路由（catalog 注册了但 App.tsx 没有），未通过测试直接 fail CI |
| docs | rules | 重写 .claude/rules/navigation-registry.md：明确 SSOT 模型 + 三类注册位置（agent/toolbox/utility-infra）+ 后端 menuCatalog 自动并入 + 自动化测试用法 |
| fix | prd-admin | 「恢复默认」+ NavLayoutEditor fallback 改为与 AppShell sidebar 完全一致：按 menuCatalog group=tools/personal/admin 分段，不再用前端自创的 agent+toolbox+infra 布局，避免「我的导航」strip 与左侧 sidebar 不同步 |
| feat | prd-admin | 新增 getMenuGroupedDefaultOrder 单一来源，撤销 getHardcodedDefaultNavOrder 自创布局 |
| fix | prd-admin | 「恢复默认」不再把所有项推到导航上：默认布局只放智能体 + 百宝箱，实用工具/基础设施/其他菜单留在「可添加」池供按需追加 |
| feat | prd-admin | 「可添加」分组标题样式与 Cmd+K 命令面板一致：图标 + 标题 + 副标题 + 数量徽标，但芯片本体仍保留小尺寸 |
| fix | prd-admin | 「可添加」分组错位修复：unifiedNavCatalog 改为 launcher 先 push、menu 补充，工作流/市场/模型/团队等正确归到「基础设施」组而非「其他菜单」 |
| fix | prd-admin | 「恢复默认」按钮始终可点（除非保存中），点击后写入硬编码推荐布局：智能体 + 百宝箱 + 核心基础设施（市场/知识库/网页/模型/团队），不再受 admin defaultNavOrder 影响 |
| feat | prd-admin | 新增 getHardcodedDefaultNavOrder 工具函数，作为系统推荐布局的单一来源 |
| refactor | prd-admin | 全改造导航 SSOT：新建 src/app/navRegistry.tsx 集中声明所有用户可见路由 + nav 元数据；App.tsx <Routes> 通过 .map() 渲染 NAV_REGISTRY；launcherCatalog 改为薄派生层。加新 Agent / 页面 = 在一处写一行 entry，路由+导航+Cmd+K 自动同步 |
| feat | prd-admin | 新增 src/app/RouteGuards.tsx 提取 RequireAuth/RequirePermission 守卫，供 navRegistry 和 App.tsx 共享 |
| feat | prd-admin | 新增 src/pages/MyAssetsPage.tsx，把 App.tsx 内联的移动/桌面分流逻辑独立出来 |
| feat | prd-admin | 强化 navCoverage 测试：5 项校验（path 唯一 / shortLabel ≤4 字 / icon 非空 / path 以 / 开头 / App.tsx 字面量路由全部在 ALLOW_LIST 或 registry） |
| fix | docs | CLAUDE.md 顶部 + cds/CLAUDE.md 顶部新增 §0「禁止任何 emoji（最高优先级）」规则 — 适用于所有项目的代码字面量、UI 文案、文档、commit 信息、PR 描述、AI 回复正文 |
| refactor | cds | 分支卡上的 stats chips 被移除（违反禁 emoji 规则）；运营计数迁到「项目设置 → 统计」专门 tab：项目汇总卡（7 个指标）+ 分支详细计数表 + 最近 50 条活动日志，全部纯文字 + SVG icon，无 emoji |
| fix | cds | Settings GitHub Tab 事件 toggle 移除 emoji icon（push/delete/prOpen/prClose/slashCommand），改为完整中文标签描述 |
| feat | prd-admin | 团队周报列表「已过截止 MM-DD HH:mm」chip 改为「超时 N」chip,鼠标悬停弹出超时成员列表 popover(头像 + 姓名 + 截止时间) |
| refactor | prd-admin | ModelPoolPickerDialog 重构为 master-detail 布局 — 移除「平台/大模型」tab 切换，改为「左栏平台列表 + 右栏模型」一体化视角。左栏顶部有「全部」聚合入口，每个平台条目显示模型数 + 加载/失败状态徽标。右栏：搜索框、刷新（清当前选中的缓存）、全选过滤结果、9 类标签 chip 过滤、模型行（行内显示模型名 + 标签图标 + 平台来源 chip 仅在「全部」视角下显示）。新增 per-platform 缓存（同 dialog 会话内不重复拉取，切换平台命中即刻返回），刷新按钮显式失效缓存。`maxWidth` 从 720 → 920。零后端、零数据库、零既有调用方影响 |
| fix | prd-admin | 修复 ModelPoolPickerDialog 滚动跑出 + 内容少时折叠 — ① modal 高度从只设 `max-h` 改为通过 `contentStyle` 钉死 `height: 70vh`，避免内容少时 modal 塌缩；② 中栏从 grid 改 flex（grid 默认 row=auto 让 `flex-1` 高度链断裂，导致内层 `min-h-0 overflow-auto` 失效，整个 Dialog 内容槽接管滚动），现在 master-detail 走 flex 横向拉伸，模型列表的 `flex-1 min-h-0 overflow-auto` 正确生效，滚动只发生在模型列表内部，左栏与头部不再被滚走 |
| feat | prd-admin | ModelPoolPickerDialog 新增「平台 / 大模型」双视角切换 — 平台 tab 保留原"按平台批量添加"流程；新增「大模型」tab 跨平台聚合所有可用模型，顶部一排标签 chip（推理/视觉/生图/视频/工具/联网/嵌入/重排/免费）按能力快速过滤，并带搜索框（模型名/显示名/平台模糊匹配）。标签来源：后端 AvailableModel.tags 优先，否则走前端 inferPresetTagKeys 启发式（基于 modelName/providerId regex），零持久化、零后端改动 |
| refactor | prd-admin | 全面统一模型/池操作弹窗 — 删除 ModelAppGroupPage 老式"编辑模型池"表单 dialog（120 行）+ groupModels* 4 个 state + saveGroupModels/toggleDraftModel/keyOfGroupModel 三个 helper + Select/PlatformAvailableModelsDialog/ModelListItem 三个旧引用。`[+ 添加模型]` 按钮（编辑现有池模型）现在路由到统一的 ModelPoolPickerDialog 进入新的 editPool 模式：picker 自动预选当前池模型，无 Tab 切换，确认即走 updateModelGroup 替换该池模型列表。其他池字段（名字/策略/优先级）保留不变。零后端、零 DB 改动。全站从此只剩**一个**模型/池选择 dialog，五个入口（配置模型/升级为模型池/选择已有池/管理模型池/编辑现有池）共用 |
| feat | prd-admin | ModelPoolPickerDialog 加「选择已有池」Tab，卡片式池列表 — 通过新增可选 prop `bindingMode` 启用第二 Tab：左 Tab「新建/升级」（原 master-detail）、右 Tab「选择已有池」（卡片网格自适应 1/2/3 列，最佳适配池绿色标签置顶）。卡片显示池名 + 默认池/最佳适配徽章 + 模型数 + 优先级 + Code，点击切换选中。底部"已选 N · 确认绑定"独立提交 |
| refactor | prd-admin | ModelAppGroupPage 合并按钮入口 — 删除独立的"绑定专属模型池"弹窗（160 行），改为路由到统一的 ModelPoolPickerDialog。功能行按钮简化：未配置 → `[配置模型]` 一个按钮（弹窗内自由切 Tab）；LegacySingle → `[升级为模型池]`；已绑定 → `[+ 添加模型]` + `[管理模型池]`。删除冗余的 `[选择已有池]`/`[绑定模型池]` 二级按钮，所有"选择已有池"诉求都走主按钮+Tab 切换 |
| refactor | prd-admin | 解决 NavSection 类型同名冲突：navRegistry.tsx 的 NavSection（4 段：agent/toolbox/utility/infra）重命名为 RegistrySection；unifiedNavCatalog.ts 的 NavSection（7 段：含 home/shortcut/menu）保留。launcherCatalog 跟随更新 import |
| chore | prd-admin | 删除 getHardcodedDefaultNavOrder dead code（@deprecated 标记的兼容壳，实际无任何调用方） |
| fix | prd-admin | /library 智识殿堂恢复为公开访问（refactor 前无守卫，匿名访客可看），不再被 fullscreenGuarded 强制要求登录+access 权限 |
| fix | prd-admin | v7 launcher ID 格式变化的兼容层：新增 migrateLegacyNavId 把旧前缀 ID（agent:visual-agent / utility:logs / infra:document-store 等）透明转换为新格式；findLauncherItem 自动 fallback 旧 ID；navOrderStore 加载时迁移 navOrder/navHidden 并落库；agentSwitcherStore 升级到 v3 + migrate hook 把 pinnedIds/recentVisits/usageCounts 一起迁移 |
| chore | prd-admin | 删除 dead code：navRegistry.tsx 的 getNavRegistryWithMeta 和 unifiedNavCatalog.ts 的 findNavItemByKey 都未被引用 |
| refactor | cds | 预览 URL 公式升级到 v3：`{tail}-{prefix}-{projectSlug}.miduo.org`（重要的靠前——分支主特征 → agent 前缀 → 项目名）。例如 `claude/fix-foo` + 项目 `prd-agent` → `https://fix-foo-claude-prd-agent.miduo.org/`。新增 `cds/src/services/preview-slug.ts` 作为唯一来源，全栈所有生成端（PR 评论、Settings preview、check-run summary、冒烟测试 base、"分支已下线"页活跃分支链）统一过 `buildPreviewUrl(host, branch, projectSlug)`。proxy 解析端三档兼容：① v3 前向匹配（首选）→ ② v1 裸 slug → ③ v2 `${projectSlug}-${branchSlug}`，旧链接全部继续可用 |
| docs | rules | CLAUDE.md 规则 #9 + #11 + `.claude/skills/preview-url/SKILL.md` 同步到 v3 公式：bash 生成脚本改为按第一个 `/` 切 prefix/tail，case 分支处理无 `/` 的分支名（如 `main`），文档保留 v1/v2 公式演化与"重要的靠前"设计动机 |
| fix | cds | dashboard 预览按钮 + URL hint 漏改：之前直接用 `entry.id` 拼 URL（仍是 v2 格式），用户点击跳到旧链接。后端 `GET /api/branches` 多返一个 `previewSlug` 字段（v3 公式），前端 `previewBranch()` 与卡片 hint 都改成读这个字段——dashboard 全部归一到唯一来源 |
| fix | cds | dashboard 分支卡 toolbar 改为 hover-only：默认 toolbar 透明 + `padding-right: 8px`，hover 才浮出并让出 60px 给两个按钮（更新拉取 + 颜色标记）。常驻状态例外——`.has-updates`/`.is-ai-occupied`/`.is-busy`/`.is-deploying` 的卡片永远显示 toolbar，避免重要状态被 hover 隐藏。触摸设备 (`@media (hover: none)`) 保留旧常驻行为 |
| fix | cds | 分支卡分支名右侧大片空白真正修复：根因不是 padding，是 (1) `.branch-name` 没设 `flex:1 min-width:0`，flex item 默认只占内容宽度→右边自然留白；(2) `.branch-quick-actions` 用 `visibility:hidden` 默认隐藏但仍吃 ~46px 行内空间。改为 `flex:1` 撑满 + `width:0` 真隐藏，hover 才扩到 50px |
| feat | prd-admin | 应用模型池管理新增「+ 配置模型」一键流（流程 A）— 用户在功能行点该按钮 → picker 选模型 → 系统自动建池（auto 命名/默认 FailFast 策略/优先级 50）+ 自动绑定到该 AppCaller。前端编排既有 createModelGroup + updateAppCaller 两个 API，绑定失败时自动 deleteModelGroup 回滚孤儿池。零后端改动、零数据库改动、零既有数据/日志/调度影响 |
| feat | prd-admin | LegacySingle 行新增「升级为模型池」按钮（流程 B）— 把当前直连的单模型预选进 picker，用户可继续添加备用模型，确认后自动建池+绑定到 AppCaller。原有 LegacySingle 的 LLMConfig 不动（保留作实验直连通道），但本 AppCaller 的调度优先级会因新池的存在而走专属池路径 |
| refactor | prd-admin | 应用模型池管理「绑定模型池」按钮文案调整 — 未配置时改为「选择已有池」（次操作，主操作让位给「+ 配置模型」），降低新用户认知负担 |
| refactor | prd-api | 视频生成 Agent 彻底砍掉 Remotion 拆分镜路径，只保留 OpenRouter 视频大模型直出。VideoGenRunWorker 从 2473 行简化到 ~250 行；VideoGenModels/IVideoGenService/VideoGenService 同步精简；VideoAgentController 删除分镜/渲染相关端点 |
| refactor | prd-admin | 视频 Agent 前端去掉分镜编辑 UI，VideoAgentPage 改为 VideoGenDirectPanel + HistoryDrawer 薄壳；删除 UnifiedInputHero、videoModeDetect.ts 和 contracts 中所有 scene/RenderMode 类型 |
| chore | repo | 删除整个 prd-video/（Remotion 项目）和 prd-video-renderer/（短暂存在的过渡微服务）目录 |
| chore | infra | cds-compose.yaml + docker-compose.yml + docker-compose.dev.yml 撤掉 video-renderer service + VideoRenderer__Url 注入；prd-api/Dockerfile 已无 prd-video 嵌入 |
| fix | prd-admin | 修复周报 Agent 浅色模式下硬编码深黑阴影与白色文字对比度问题，弹窗/抽屉/popover 切换为暖咖啡色羽化阴影 |
| feat | prd-admin | 浅色模式按钮系统完整改造：Button 组件接入 useDataTheme，4 个 variant 浅色版（primary 暖橙实色 #CC785C / secondary 纯白卡片+hairline / danger 柔红 / ghost 透明），暗色保持原视觉 |
| fix | prd-admin | 周报 Agent ZoomControl/ThemeControl segment 切换器选中态浅色下走 var(--accent-claude)，替代原硬编码蓝色 rgba(59,130,246,.15) |
| fix | prd-admin | GlassCard 浅色下阴影从 rgba(0,0,0,0.5) 纯黑改为 var(--shadow-card) 暖咖啡微影,移除浅色下无效的白色 inset 高光,纸感更轻盈 |
| refactor | prd-admin | 周报详情页(panel + 独立 page)tab 选中态去除背景填充,从"加粗+背景+下划线"3 层信号收敛为"加粗+下划线"2 层；删除 tab 上无意义的评论数徽章 |
| refactor | prd-admin | 周报独立详情页删除每个 section 标题右侧的彩色短色条,章节色记忆点统一集中到数字徽章上(实色 + 暖色软阴影),与面板版徽章实现对齐 |
| fix | prd-admin | 全局 Dialog 组件浅色适配:不再依赖 glassPanel(themeComputed 性能模式下会用暗色覆盖 --glass-bg-start/end),浅色直接走纯白卡片+暖咖啡羽化阴影+浅灰 modal-overlay;SystemDialog 的 prompt input 浅色下走 var(--bg-input) 替代硬编码 rgba(6,6,7,1) |
| fix | prd-admin | 修复浅色弹窗仍是黑底:globals.css 中 .prd-dialog-content 用 !important 强制暗色 background 盖过 Dialog inline style,新增 [data-theme="light"] scope 同样以 !important 反向覆盖回纯白 |
| fix | prd-admin | 浅色 WCAG 合规 P0:--text-muted alpha 0.58→0.68(4.2:1→4.8:1 达 AA);全局 :focus-visible 在浅色下走 Claude 橙 outline 替代蓝色;.prd-field 浅色 placeholder/focus ring 走 Claude 橙体系 |
| feat | prd-admin | 浅色精修 P1:状态徽章背景 alpha 0.10→0.15 提升对比度;新增浅色 ::selection 用 Claude 橙轻染;新增浅色 ::-webkit-scrollbar-thumb 走 slate 半透;新增 .hover-bg-soft 工具类替代 9 处 hover:opacity-XX 隐形反馈反模式(报详情/周导航/设置/模板管理) |
| feat | prd-admin | 浅色三级背景层级:tokens.css 新增 --bg-nested(浅色 rgba(15,23,42,0.025) / 暗色 rgba(255,255,255,0.025)),解决 GlassCard 内"白上加白"看不出层级问题;ReportDetailPanel/ReportDetailPage 的 issue 卡片、TeamIssuesPanel 用户分组卡片、ReportEditor 内嵌编辑卡片 4 处消费新 token |
| feat | prd-api | 周报 Agent 日常记录列表接口升级：新增关键词搜索（匹配工作内容/标签）、分类与标签筛选、分页参数（page/pageSize），响应增加 total/hasMore，旧调用方保持兼容 |
| feat | prd-admin | 周报 Agent「日常记录」入口新增「我的记录」子菜单：按天分组卡片、关键词搜索、时间范围筛选（最近 7/30/90 天/全部/自定义）、分类与自定义标签筛选、20 条/页分页 |
| fix | prd-api | 修复编辑模板「保存」时返回 500 — 把 UpdateMany + PullFilter(closure lambda) 改为 PullAll(values),避开 MongoDB.Driver 在某些版本下对 List.Contains closure 表达式的翻译异常;同时对 UpdateTemplate 加全量 try/catch + 详细 logger,后续问题可在容器日志直接定位 |
| fix | prd-api | 团队人数统计包含负责人与免提交成员(从 activeMembers.Count 改为 allMembers.Count),反映真实团队规模;已提交/待提交/超时 仍仅算活跃成员 |
| feat | prd-admin | 导航栏自定义和 Cmd+K 命令面板共用一份统一目录（unifiedNavCatalog），新增功能注册一次两处生效 |
| feat | prd-admin | Cmd+K 列表项支持「 加到导航」按钮 + 右键 + ⌘/Ctrl+Enter 一键加入左侧导航 |
| feat | prd-admin | 补齐缺失条目：智识殿堂 /library + 知识库/网页托管/更新中心/海鲜市场/工作流引擎/模型/团队 等 infra 全部可见 |
| fix | prd-admin | 侧栏短标签强制 ≤ 4 字，杜绝「自动化规」等被截断的尾巴 |
| feat | prd-video-renderer | 新建 Remotion 单镜渲染微服务（独立 prd-video-renderer/ 项目）：Express :5001 + 系统 Chromium，POST /render/scene 和 /render/full 端点；用 npx remotion render 内部 fork，5 分钟超时兜底，stderr 摘要返回 |
| refactor | prd-api | VideoGenRunWorker 不再 fork npx remotion 子进程；改为 HttpClient POST 到 video-renderer 容器，分镜预览（/render/scene）和最终导出（/render/full）走同一个微服务 |
| refactor | prd-api | Dockerfile 撤掉 Node.js + Chromium + prd-video 嵌入（之前为了 Remotion 加的），api 镜像恢复纯 dotnet/aspnet:8.0 干净基座，体积减重 ~250MB |
| feat | cds | cds-compose.yaml 撤掉之前给 api 容器灌 nodejs 的临时 hack，新增 video-renderer 服务（node:20-bullseye-slim + 挂载 prd-video + chromium 安装），独立运行 |
| feat | infra | docker-compose.yml + docker-compose.dev.yml 新增 video-renderer service，api 注入 VideoRenderer__Url 指向内网 :5001 |
| fix | prd-admin | 视频 Agent 自动恢复任务时，sessionStorage 里 stale runId 已被删除/过期的情况下不会再卡住，会继续 fallback 选最近一条任务（之前 ref 提前置 true 把回退分支拦了） |
| fix | prd-api | 视频 Agent 导出守卫修正：所有分镜都通过 per-scene 覆盖切到「直通大模型」时也会显式失败，不再静默走 Remotion 拼接产出空视频 |
| fix | prd-api | 视频 Agent 分镜级 RenderMode 加白名单校验，与 run 级别保持一致；客户端传错字（如 "vidogen"）直接报错而非默默落库 |
| fix | prd-admin | 视频 Agent 切到 selectedRunId 后 mode fetch 失败（任务被删/网络错/字段缺失）不再无限「加载任务中…」死锁，统一退回作品架并 toast 提示；loading 面板也加了「返回作品架」逃生按钮 |
| fix | prd-admin | 高级创作页轮询：run 终态后用户继续点单镜「渲染」/「重新设计」时自动重启轮询；轮询是否运行同时考虑 run.status 与任意 scene 是否处于 Generating/Rendering 过渡态，scene 跑完才停 |
| fix | prd-admin | 视频 Agent 直出面板提交后不再重复 fetch + 双轮询：createVideoGenRunReal 成功后只调 onRunCreated 通知外层切换 selectedRunId，由 externalRunId useEffect 统一接管首次 fetch 与轮询，消除竞态 |
| fix | prd-api | 视频 Agent 直出模式：上传文件/粘贴文本时自动从 articleMarkdown/附件提取作为 directPrompt，不再因 prompt 为空创建失败 |
| fix | prd-api | 视频 Agent Remotion 单镜渲染加 5 分钟超时 + 失败原因落到 scene.ErrorMessage（含 stderr/stdout 摘要），避免 Worker 挂死和"渲染失败"无原因可查 |
| fix | prd-api | 视频 Agent 单镜直出失败时 errorMessage 持久化到分镜，刷新页面后仍能看见原因（之前只走 SSE 一次性事件） |
| fix | prd-api | 视频 Agent 修复 OpenRouter 提交后 DirectVideoModel 被无条件回写导致的"粘性 per-scene 覆盖"，仅在用户已显式选择时才回写 |
| fix | prd-api | 视频 Agent applyToAll 切换默认模式时改为清除所有 per-scene RenderMode 覆盖（设 null），与"已存在的单镜模式覆盖会被清除"UI 文案一致 |
| fix | prd-api | 视频 Agent 最终导出加守卫：检测到混合模式（部分分镜走 Remotion + 部分走直通大模型）时显式失败而非静默丢掉直出场景，错误信息含具体分镜编号 |
| fix | prd-admin | 视频 Agent 直出模式 chip 选择 + 上传文件时也把 articleMarkdown/attachmentIds 一起传给后端，让后端兜底生成 prompt |
| fix | prd-admin | 视频 Agent 修复 run.renderMode='videogen' 但有分镜时被 VideoGenDirectPanel 抢占场景编辑器的 bug，仅在 scenes 为空时才视为单镜直出任务 |
| feat | prd-admin | 视频 Agent 进入页面自动选中"最值得继续的"任务（进行中优先 > 最近完成）+ selectedRunId 持久化到 sessionStorage，告别"每次进来空白要重新开始"的体验 |
| fix | prd-admin | 视频 Agent 分镜模型下拉去重：原本同一模型 id 在 VIDEO_MODEL_TIERS 和 OPENROUTER_VIDEO_MODELS 两边各出现一次，下拉里有重复项 |
| fix | prd-admin | 视频 Agent「+ 创作」下拉菜单 portal 到 body，避免被父 GlassCard 层级遮挡，第二项「大模型直出」不再被下方面板盖住 |
| feat | prd-admin | 高级创作弹窗改为零摩擦上传：拖拽/点击上传 .md/.txt 文档，「或粘贴文本」可选回退；移除手填标题输入框（标题由 AI 自动从内容取） |
| feat | prd-admin | 高级创作弹窗风格改为 8 个预设胶囊（电影级光影/3D 卡通/写实纪录片/像素风/水墨国风/赛博朋克/极简插画/复古胶片）+ 「AI 自动选」默认项，禁止用户瞎填 |
| feat | prd-api | storyboard 拆分镜 LLM prompt 改为返回 `{title, scenes}` 包装对象，AI 自动给整段视频取中文标题（≤14 字）写回 ArticleTitle；解析器兼容旧的纯数组格式 |
| feat | prd-api | `ReportTeam.WeeklyDeadline` 团队级周报截止时间字段(默认 "sunday-23:59" UTC+8),Create/Update 端点接受配置 |
| feat | prd-api | `GetTeamReportsView` 用 `ResolveWeekDeadline` 按团队配置解析(替代之前硬编码周日 23:59) — 支持 monday/tuesday/.../sunday + HH:mm |
| feat | prd-admin | 团队设置新增「周报提交截止时间」下拉(周五 12/18/20、周六 12/18、周日 18/23:59、下周一 09/10) — 解决之前用户无法配置截止时间的问题 |
| fix | prd-admin | 周报主页默认 Tab 由旧 key `my-reports` 改为 `report`,初次进入直接落在「周报」(原本依赖 useEffect 旧→新映射,现去掉一层间接) |
| fix | prd-admin | 周报详情页审阅/退回成功后通过 store 事件总线 `lastReportMutation` 通知 TeamDashboard,后者监听并局部 mutate `reportsView.items / members` 与 per-week 缓存,返回团队列表立即看到状态翻面,无需手动刷新 |
| refactor | prd-admin | 「团队问题」从「周报」Tab 顶部分段切换迁移到「团队」Tab 内的 segmented control,统一在团队周报列表卡片头部「周报 / 问题」切换;新增独立 `TeamIssuesPanel` 组件复用筛选+分组渲染,删除旧 `TeamIssuesView` 组件 |
| feat | prd-api | `ReportTeamMember` 新增 `IsExcused` 字段(默认 false),`UpdateTeamMember` 端点接受 `isExcused` 用于设置免提交标记 |
| feat | prd-api | `GetTeamReportsView` 实时计算逾期(本周日 23:59 中国时区已过 → Draft/NotStarted 视图层 map 为 Overdue,不修改 DB);响应新增 `submissionDeadline` + `isPastDeadline` 字段 |
| feat | prd-api | 团队周报列表统计排除 Leader 与 Excused 成员 — `totalMembers/submittedCount/pendingCount` 仅算活跃成员;成员管理 drawer 仍展示完整列表(每行带 `isExcused`) |
| feat | prd-admin | 团队周报列表头部新增「截止于/已过截止 MM-DD HH:mm」chip,逾期红色提示;成员管理 drawer 每行新增「免提交/取消免提交」按钮(Leader 行隐式锁定免提交,不可关闭) |
| feat | prd-admin | 团队周报列表「待提交 N」chip 鼠标悬停弹出待提交成员 popover(头像 + 姓名 + 副负责人徽章) |

### 2026-04-26

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | AI 竞技场 Battle View 输入框 placeholder 从「继续提问...」改为「提出新问题（盲评模式 · 每轮独立、不带历史）」，避免暗示多轮对话；prompt bar 增加「盲评 · 单轮」标签（hover 解释为何不带上下文）；RETRY 按钮 title 同步说明 |
| docs | doc | design.ai-arena.md 新增 12.1 小节解释 v1 不做多轮的设计取舍（盲评公平性）；guide.arena.md 在功能表格和 FAQ 增加单轮说明，对应用户反馈「Arena 没有上下文」 |
| fix | cds | exec_cds.sh cert 子命令在缺少 crontab 的系统(Amazon Linux 2023 / 最小化 RHEL)上会卡在 acme.sh 安装的 Pre-check 失败:新增 ensure_crontab 自动安装 cronie/cron + 启用服务,失败时回退到 --force,并校验 acme.sh 真实落盘 \$HOME/.acme.sh/acme.sh,避免后续盲目调用不存在的二进制 |
| fix | cds | nginx_up 失败时把 docker compose up -d 的真实输出打到 stderr 而不是吞掉,cert_cmd 在 nginx 无法启动时直接退出而不是继续走 HTTP-01 (注定失败) |
| fix | cds | detect_os 识别 amzn / amazon (Amazon Linux),按 RHEL 系处理 |
| fix | cds | 子域名 auto-build 错误处理与锁清理: catch 块按 canonicalId 查 entry (而非 bare finalSlug),非 legacy 项目部署失败时 entry 不再卡死在 building; finally 块迭代 lockKeys Set 清理所有注册过的 build lock,杜绝内存泄漏
| fix | cds | legacy-cleanup/cleanup-residual 拒绝在 customEnv['default'] 仍有非空键时执行,避免静默丢失用户密钥
| fix | cds | 修复初始化 bootstrap 路径仍用裸 mainSlug 作为分支 id 的问题, 与 POST /branches / 子域名 auto-build / webhook 公式对齐 (legacyFlag false 时加 ${slug}- 前缀), 顺带 setDefaultBranch 也用同 id; 避免 rename-default 后再跑 init 产生 main + ${slug}-main 双胞胎
| fix | cds | 子域名 auto-build resolveProjectForAutoBuild 返 undefined 时改为 throw 进 catch 而非 res.end()/return, 让 lockPromise 通过 rejectLock 正常 settle, 杜绝并发 SSE 监听者 (line 917 的 .then/.catch 等待) 永久挂起
| fix | cds | initialize bootstrap 路径容器名补丁: cds-${mainSlug}-${profile.id} → cds-${entry.id}-${profile.id}, 与 index.ts auto-build 路径对齐, 避免多项目场景下两个项目同时 init main 撞同一个 docker 容器名
| fix | cds | initialize bootstrap Phase 4 用 getBuildProfilesForProject(entry.projectId) 替代 getBuildProfiles(), 多项目场景下不再把别项目的 profile 部署到 owner 项目下
| fix | cds | resolveProjectForAutoBuild step 3 改为只在恰好一个项目无 repoPath 时返回, 多个共享时返回 undefined 让调用方拒绝, 杜绝静默错误归属
| fix | cds | legacy-cleanup/status 把非空 customEnv['default'] 重新归类为 needsMigration 而非 residualOnly,避免 UI 显示永远 409 的"清理残留"按钮; 残留按钮改为只在仅剩工作目录时出现, 真有未迁移密钥时统一走"迁移 →"路径以确保 rename-default 把它们 copy 到新项目 scope
| fix | cds | resolveProjectForAutoBuild step 2 (repoPath 匹配) 改为同 step 3 的歧义检测: 多个项目共用同一 repoPath → 返回 undefined 让调用方拒绝, 杜绝跨项目误归属
| fix | cds | 集群执行器 /exec/deploy 的 getMergedEnv 用 entry.projectId 替代请求侧的 resolvedProjectId, 保持"现存 entry 的 projectId 是真理"不变量, 避免老 master 缺 projectId 时 fallback 解析失误把别项目的 env 注入容器
| feat | prd-api | DailyTip 加 Version 字段 + User.LearnedTips,新增 POST /api/daily-tips/{id}/mark-learned 端点;visible 过滤按 (SourceId, Version) 判定,管理员升 Version 时已学会用户重新看到 |
| feat | prd-admin | TipsDrawer 顶栏左侧加「我已学会」按钮,Tour 走完最后一步自动 markLearned;右下抽屉 store 新增 markLearned action |
| feat | prd-api | 内置 seed 重写:删除「大全套 11 步」,新增 6 条真流程引导(自定义导航顺序排第一 + 涌现首颗种子 + 上传首个技能 + 写首份周报 + PR 审查 + 视觉创作首图) |
| feat | prd-admin | NavLayoutEditor / EmergenceNode 探索按钮 / Marketplace 上传技能按钮 / PrReview URL 与提交按钮 / Visual prompt 与开始按钮 都补齐 data-tour-id |
| chore | prd-api | AdminDailyTipsController.Seed 端点支持自动清理 deprecated seed(showcase-all-features) |
| feat | doc | 新增 doc/ 第 7 类前缀 `debt.*` 技术债务台账：模块级未还工程债（已知边界/后续可补/留尾风险），命名规则 v3.1 |
| feat | doc | 创建首个债务台账 doc/debt.video-agent.md，录入分镜级模式覆盖功能交付时声明的 4 条 open 债务（CDN 7 天过期 / ffmpeg normalize / 心跳文案 / 成本预估） |
| fix | prd-admin | tokens.css 补齐 4 个缺失 token: --bg-primary/secondary/tertiary + --border-primary/secondary,在 :root(暗色) 和 [data-theme="light"] 同时定义。修前周报 Agent 122 处 var(--bg-secondary) 等使用全部 fallback 到 unset/transparent,浅色下面板看起来"灰蒙蒙不通透"——这是浅色 UX 问题最大的根因 |
| fix | prd-admin | DailyLogPolishPopover 移除暗色硬编码 bg-[#0f1014] + border-white/10 + 半透明白叠加,改用 var(--bg-elevated)/var(--border-primary)/var(--bg-secondary);model 名 alpha 从 rgba(255,255,255,0.4)(对比度 2.1:1)改为 var(--text-muted) |
| fix | prd-admin | MarkdownImportModal 删除 9 处 var(--xxx, fallback) 中的白色/暗色 fallback,token 缺失时不再走错误兜底色(违反 cds-theme-tokens.md 第 1 条) |
| fix | prd-admin | ReportDetailPage 浅色 bulletClr 从 rgba(15,23,42,0.7)(对比度 3.5:1,不达 WCAG AA)改为 rgba(15,23,42,1) |
| feat | prd-admin | 新增 hooks/useStatusChipConfig.ts —— 周报状态 chip 颜色 SSOT。MyReportsList/ReportMainView/ReportDetailPage/WeekNavRail 4 套各自实现的 statusConfig 统一收口,alpha 从 0.08/0.10/0.12/0.4/0.5 混用收敛到 getSemantic() 规范(浅色 1.0/0.10/0.22 暗色 0.9/0.08/0.15);MyReportsList NotStarted P0 contrast(浅色 alpha 0.5)被该 hook 自动修复 |
| fix | prd-admin | UsageGuideOverlay/ReportDetailPage/DailyLogPanel 共 4 处 hover 用 rgba(255,255,255,0.X) 半透明白(浅底上看不见),改用 var(--bg-secondary) |
| fix | prd-admin | 浅色 --bg-card 从 rgba(26,26,31,0.05)(米底上视觉差 < 4% L,卡片"浮"不起来)改为纯白 #FFFFFF + hairline 描边,Anthropic Claude.ai 同款层级处理 |
| fix | prd-admin | 浅色 shadow 全栈替换为暖色调 rgba(89,65,50,X) 咖啡棕系 — 米底 #FAF9F5 配冷色调 rgba(15,23,42,X) 阴影色相不和。新增 --shadow-card-sm/--shadow-card-active token,8 处 inline shadow 收口到 token |
| fix | prd-admin | 状态 chip eyebrow 排版收紧 — 字号 10px → 9px,tracking 0.04em → 0.08em,font-medium → font-semibold,删除浅色 1px border(顶级做法只用 bg + color,不叠 border 制造视觉噪音) |
| fix | prd-admin | 浅色模式禁用所有非 modal 的 backdrop-filter blur(12px) — 米底上 blur 无意义反耗渲染。MyReportsList/HistoryTrendsPanel(MetricCard)/PersonalSourcesPanel/TemplateManager 4 处卡片改纯白 + hairline,只有 modal overlay 保留 blur(4px) |
| fix | prd-admin | 进度条配色克制化 — 进行中从 Claude 橙 / 蓝改为 rgba(15,23,42,0.32) slate hairline,只在 100% 时上 sage 完成色。避免"未完成 = 警告"误读,Linear/Notion 同款 |
| feat | prd-admin | TeamDashboard / TemplateManager 4 处大字号标题统一上 var(--font-serif) + letter-spacing -0.01em,与 ReportDetailPanel/ReportMainView 已有 serif 标题保持一致,editorial 风更纯粹 |
| fix | prd-admin | ReportEditor 在 getWeeklyReport 失败时不再静默白屏(report=null + isNew=false → 整个组件 return null,所有按钮看似消失);改为显式 toast.error + 渲染失败 fallback 卡(含返回列表按钮),用户始终能感知错误 |
| fix | prd-admin | reportAgentStore 的 loadTeams/loadTeamDetail/loadTemplates/loadUsers 在 res.success=false 时不再静默,显式 set error 触发顶部红条(避免 templates=[] 假象让「写周报」按钮被错误 disable) |
| fix | prd-admin | ReportEditor 顶部 toolbar 增加 flex-wrap + shrink-0 + ml-auto,窄屏 / zoom 放大 / 多按钮(autosave + AI 生成 + 保存 + 提交 + 删除)场景下「提交」按钮不再被挤出可视区 |
| fix | prd-admin | ReportMainView「写周报」按钮 disabled 时,在按钮下方追加可见的小字提示(「团队未配置模板，请联系负责人」),替代仅 title tooltip 的方案(移动端 / 触屏不可达) |
| fix | prd-admin | ReportEditor 状态枚举防御:当周报 status 不在任何 can* 集合时,DEV 模式下打印 console.warn,便于后续新增枚举值忘记同步前端时定位"按钮全部消失"问题 |
| fix | prd-api | 修复 Server Deploy 镜像构建因 NuGet cache mount 缺包导致 publish 失败 |
| feat | prd-api | VideoGen 分镜级渲染模式覆盖：VideoGenScene 新增 RenderMode/DirectPrompt 等字段，Worker 按 effective mode 分发 Remotion 或单镜直出 |
| feat | prd-api | 新增 PUT /api/video-agent/runs/:id/render-mode 端点：任务级默认模式切换 + 可选同步覆盖全部分镜 |
| feat | prd-admin | UnifiedInputHero 把"生成方式"3 选 1 chip 从「高级设置」折叠区提到主区常驻，零摩擦可见 |
| feat | prd-admin | VideoAgentPage 分镜编辑页顶部新增"默认渲染模式"工具条 + 每张分镜卡片单独的模式 chip + 直出参数（Prompt/模型/时长/宽高/分辨率）面板，支持任意分镜单独切到 Remotion 或大模型直出，可混合渲染 |
| fix | prd-video | 修复 VideoGen 分镜渲染失败：Remotion 4.x 没有 setChromiumExecutablePath 方法，改用 setBrowserExecutable |

### 2026-04-24

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 涌现探索器从 admin 模块（emergence.read/write）改造为智能体级权限（emergence-agent.use），普通用户（operator/viewer/agent_tester）默认开放，修复管理员被拒 403 问题 |
| fix | prd-admin | 导航栏自定义面板按权限过滤可添加项，禁止"看得到加得进点开 403"——viewer 用户不再能误添加无权限的导航条目 |
| fix | prd-admin | 移除 PRD 解读智能体 Web 端所有入口（百宝箱、命令面板 Cmd+K、移动端浮层、落地页 Agent 网格、提示词测试跳转、路由），统一桌面端体验，老书签自动重定向首页 |
| fix | prd-admin | 用户列表新增「权限」列，独立显示 systemRoleKey，与业务角色（PM/DEV/ADMIN…）解耦，避免"名义管理员实际无权限"的鬼状态 |
| fix | prd-admin | 修复导航自定义"自动化规则"标签被截断为"自动化规"——shortLabel 增加前缀剥离逻辑，命中 SHORT_LABEL_MAP 后再用 |
| security | prd-api | 凭证加密改用 IDataProtector（独立密钥环），不再复用 Jwt:Secret，避免单点密钥泄露风险 |
| fix | prd-api | 外部授权 UpdateAsync 合并 partial patch 与已存储凭证，避免部分更新清空未填字段导致授权失效 |
| fix | prd-api | 外部授权类型元信息接口移除 AllowAnonymous，需登录后访问 |
| fix | prd-admin | 整改 CSV 解析 header 检测改用关键词特征匹配，兼容自定义列名 |
| chore | prd-admin | 删除未引用的 storyHtmlTemplate.ts / inspectionHtmlTemplate.ts 死代码文件 |
| fix | prd-admin | 外部授权列表 formatTime 兼容未来时间，expiresAt 显示「N 天后」而非「刚刚」 |
| chore | prd-admin | 删除未使用的 getAuthorization 服务函数 |
| security | prd-api | ResolveCredentialsAsync 拒绝非 active 状态的授权，expired/revoked 一律返回 null，避免工作流用已失效凭证静默失败 |
| security | prd-admin | 委员会月报 HTML 模板新增 esc/escUrl 函数，所有用户来源字段（TAPD标题/处理人/客户名/缺陷/CSV/LLM分析）HTML 转义，URL 属性限 http(s) 协议防 XSS |
| security | prd-api | TAPD/语雀 handler MaskCredentials 对短凭证也脱敏，不再因长度<=16/8 就完全回显明文 |
| fix | cds | 修复子域名代理 auto-build 路径硬编码 projectId=default 导致 legacy-cleanup 改名后生成孤儿分支（UI 报 "加载项目失败 HTTP 404" + "检测到遗留 default" 横幅持续出现）
| fix | cds | PUT/DELETE /api/build-profiles/:id 与 /api/routing-rules/:id 补 assertProjectAccess 校验,堵住项目级 Agent Key 跨项目改/删别项目数据的安全漏洞,同时禁止通过 PUT body.projectId 偷偷搬家
| fix | cds | 集群执行器 getMergedEnv 按 resolvedProjectId 取 customEnv,不再静默丢弃项目级覆盖
| fix | cds | GET /api/export-config 支持 ?project= 过滤导出指定项目的 profiles/infra/rules/env,避免单项目导出泄露全部项目配置
| fix | cds | 修复项目 legacyFlag 翻转后 webhook 会为同一 git 分支生成幽灵重复条目的问题（同仓同分支出现两张卡 `main` 和 `<slug>-main`）
| fix | cds | 前端 CURRENT_PROJECT_ID 不再 fallback 到字面量 'default'。无 ?project= 查询时自动跳 /project-list;?project= 指向不存在项目时也跳走,根除 legacy-cleanup 改名后旧书签产生的"加载项目失败 HTTP 404"
| fix | cds | 集群执行器 /exec/deploy 路径不再硬编码 projectId='default',接受 master 传入 projectId 并兜底用 resolveProjectForAutoBuild,杜绝远端 executor 创建孤儿分支
| fix | cds | 待审核 compose 导入(pending-import)写入 infra 时按 legacyFlag 公式给容器名加项目前缀,避免两个项目都导入 mongodb 时 docker 容器名冲突
| fix | cds | 项目初始化 bootstrap (initialize main 分支) 用 resolveProjectForAutoBuild 替代硬编码 'default',防止 rename-default 后再次走 init 流程产生孤儿
| feat | cds | 遗留 default 清理横幅区分「需要迁移」与「仅剩残留目录」两种状态,后者新增一键清理接口,彻底消除已迁移用户看到"遗留 default"的困惑
| fix | prd-admin | 「产品专业委员会月报」工作流模板统计脚本增加字段兼容层：支持 TAPD stories 原始英文字段（name/current_owner/status/priority_label/created/id）、bugs 未映射的 优先级/严重程度/产品线分类（module），URL 字段缺失时自动按 workspace+id 拼接 |
| fix | prd-api | 修复桌面更新加速「domain 不支持：desktop」错误：在 AppDomainPaths 白名单添加 desktop 域 |
| feat | prd-api | 新增外部授权中心后端（M1）：Model + Service + Controller + TAPD/语雀/GitHub 三个 IAuthTypeHandler 实现 + TAPD 采集器支持 stored authMode |
| feat | prd-admin | 新增「外部授权中心」面板（开放平台新增 Tab），支持 TAPD/语雀授权的 CRUD + 验证；GitHub 走只读映射 |
| feat | prd-admin | 工作流 TemplatePickerDialog 新增 auth-picker 输入类型 + AuthPicker 共享组件 |
| refactor | prd-admin | 「产品专业委员会月报」模板改用 auth-picker 引用 TAPD 授权，不再要求用户每次粘贴 Cookie |
| fix | prd-api | ListTemplates 对普通成员放宽可见性 — 之前仅返回「系统+自己创建」,导致 Member 看不到团队关联模板,前端 hasTemplate=false 让「写周报」按钮消失。现改为系统∪自己创建∪自己所在任何团队关联的模板(编辑/删除仍由 CanManageTemplate 守卫,无权限降级) |
| fix | prd-admin | 「写周报」按钮常驻显示,无模板时 disabled + tooltip 指引联系团队负责人,避免按钮神秘消失 |
| fix | prd-api | GetReport 返回新增 canReview 字段（Leader/Deputy/全局 ReportAgentViewAll → true） |
| fix | prd-admin | ReportDetailPage「审阅通过/退回」按钮权限守卫 — 依赖后端 canReview + 防自审(userId 不等于当前用户),解决「成员竟然能审核别人周报」bug;后端 Review/Return 端点本来就有权限校验,本次只是补前端 UI 层 |
| feat | prd-admin | 周报 Agent 浅色模式全面 Anthropic 化：引入 Claude 橙 `#CC785C` accent + Source Serif 4 衬线标题 + 全局文字色加深到 slate-900（对比度从 2.5:1 提升至 7:1） |
| refactor | prd-admin | ReportMainView/MyReportsList/HistoryTrendsPanel 状态 chip & 进度条硬编码 rgba 迁移到 `getSemantic()`，解决草稿/未开始等 chip 文字 alpha 0.5 导致的"发虚"问题 |
| feat | prd-admin | 周报详情页/编辑器/侧栏/Markdown 渲染器的标题字号提升 + 应用衬线字体，具备编辑性气质 |
| refactor | prd-admin | 周报浅色模式精修二轮：章节 header 去大色块（纯白 + 3px 左侧色条 + hairline），AI 生成 banner 去紫色面板改单竖线，必填标签改单字符 `*`，编号徽章改 slate-900 单色数字，项目符号改深色 |
| feat | prd-admin | 周报卡片按完成率三色分级（完成=moss 柔绿 / 进行=amber 琥珀 / 未填=slate 灰），进度条 100% 改柔和墨绿 `#5A8F5E`，卡片团队名提到 20px serif 并新增 eyebrow status tag 位于标题上方 |
| feat | prd-admin | 全部/本周/上周筛选改 segmented control 风（单轨道 + 白 thumb + hairline）；TabBar 浅色下选中态 thumb 改实色白面板替代透明玻璃，解决米底上看不见的问题 |
| refactor | prd-admin | 浅色模式底色从 `#f1ece5` 改 Anthropic 官方暖白 `#FAF9F5` — 降饱和 13%→3% + 提亮 92%→97%，解决"底色太黄"问题；同步轻化 shadow + hairline，避免黑框感 |
| feat | prd-api | 周报模板新增 `IssueList` 章节类型（问题）：章节级预设 `IssueCategories` / `IssueStatuses`；`WeeklyReportItem` 扩展 `IssueCategoryKey` / `IssueStatusKey` / `ImageUrls` 三个字段 |
| feat | prd-api | 新增端点 `GET /api/report-agent/teams/{id}/issues` — 按周聚合团队所有成员已提交周报的 IssueList 条目，支持 `categoryKey` / `statusKey` 筛选；权限规则对齐 `GetTeamReportsView`（全局 ViewAll / Leader-Deputy / ReportVisibility=AllMembers 的成员 → 看全员，否则仅看自己） |
| feat | prd-admin | 模板编辑器新增「问题」章节类型：选中后内嵌分类 / 状态预设编辑器（标签追加/删除），首次切换自动填入默认分类（技术/产品/流程/资源）+ 默认状态（新增/跟进中/已解决/阻塞） |
| feat | prd-admin | 周报编辑器新增 `IssueItemCard` 组件：富文本 textarea + 粘贴图片（走 markdown 嵌入，复用现有上传通道） + 分类/状态下拉选择 |
| feat | prd-admin | 周报详情页和侧栏详情弹窗展示 IssueList 章节：卡片化条目 + 分类/状态 chip |
| feat | prd-admin | 周报主视图新增顶部 segmented control「我的周报 / 团队问题」，新增 `TeamIssuesView` 组件 — 按周选择 + 分类/状态 segmented 筛选 + 按成员分组聚合展示 |
| refactor | prd-admin | 周报海报 `/weekly-poster` 工作台按奥卡姆剃刀原则收敛为三栏：页面列表、宽版预览、当前页编辑/发布；隐藏左侧二级工具栏、重复编辑区和不确定渠道说明，保留导入生成、空白创建、图文/视频编辑、预览与官网发布主路径 |
| feat | prd-api | 周报管理 Agent 新增 POST /reports/import-markdown 端点：上传 Markdown 周报后 LLM 按模板章节结构化，失败自动降级为 H2 标题匹配的规则兜底；issue-list 章节强制留空分类/状态；支持同周 draft 覆盖（带二次确认） |
| feat | prd-admin | 周报编辑器新增「从 Markdown 文件导入」次级入口与弹窗：拖拽/点击上传 .md（≤512KB）、基于当前模板下载推荐格式样本、阶段文案可见（读取→AI 映射→写入）、覆盖确认流程 |
| fix | prd-api | 修复 Markdown 导入周报弹"Serializer for User does not have a member named Id"——User.Id 是历史兼容字段已 UnmapMember，主键应查 UserId；顺手修复 GenerateAsync / GenerateForMemberV2Async 同根因潜在 bug |

### 2026-04-23

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 修复 Docker 镜像构建失败 — Dockerfile 之前 COPY `tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj` 并 restore 整个 sln，但 `.dockerignore` 排除了 `**/tests`，导致 CI `Build & Push Docker Image` 长期失败；改为仅 restore API 项目（测试不需要进生产镜像） |
| feat | prd-api | 新增 IImageGenGateway 接口及 ImageGenGateway 实现（Phase 2 图片生成网关统一入口） |
| feat | prd-api | LiteraryAgentImageGenController 新增 GET resolve-model 端点，预查询生图调度模型（ILlmGateway.ResolveModelAsync） |
| feat | prd-admin | ArticleIllustrationEditorPage 无专属模型池时预解析并显示自动调度模型，解锁一键生图按钮 |
| feat | prd-api | LiteraryAgentImageGenController 新增 GET resolve-chat-model 端点，预查询提示词模型 |
| feat | prd-admin | ArticleIllustrationEditorPage 提示词模型无可用池时同样预解析并显示"自动: {model}"只读标签 |
| fix | prd-admin | 修复预解析触发条件：监听 enabledImageModels.length / enabledChatModels.length，覆盖全部模型不健康的场景 |
| refactor | prd-api | 清理 ResolverDebugController 废弃字段注入（_gateway 已无端点引用） |
| feat | prd-api | GatewayModelResolution 新增 ApiKey / ExchangeAuthScheme / ExchangeTransformerConfig 发送阶段字段 |
| feat | prd-api | LlmGateway 新增 SendRawWithResolutionAsync 跳过二次 Resolve，实现 compute-then-send 原则 |
| refactor | prd-api | OpenAIImageClient 改用 SendRawWithResolutionAsync 消除二次 Resolve |
| refactor | prd-api | 迁移剩余 6 处 SendRawAsync 调用并从接口彻底删除旧方法 |
| fix | prd-api | TranscriptRunWorker 修复 ModelResolutionResult → GatewayModelResolution 类型转换（.ToGatewayResolution()） |
| fix | prd-api | ImageGenModelAdapterConfig 新增 SupportsResponseFormat 标志，gpt-image-1.5/gpt-image-2-all 设为 false 修复 apiyi 平台 unknown_parameter 错误 |
| fix | prd-api | AppCallerRegistry 注册 prd-agent.guide::chat，修复 AppCallerCodeRegistryGuardTests 14 处失败 |
| fix | prd-api | ILlmGateway XML 注释示例改为已注册 code（prd-agent.skill-gen::chat），消除 guard test 扫描告警 |
| fix | prd-api | GatewayModelResolution 三个凭据字段加 [JsonIgnore]，阻止 ApiKey 序列化到外部 API 响应（P1 安全修复） |
| fix | prd-api | SendRawWithResolutionAsync round-trip 补全 OriginalPoolId / OriginalPoolName / OriginalModels，修复 llmrequestlogs 降级溯源丢失 |
| fix | prd-api | OpenRouterVideoClient.GetStatusAsync 缓存 SubmitAsync 解析结果，消除每次轮询重复查 DB |
| docs | prd-api | 新增 design.llm-gateway-refactor.md（compute-then-send 完整设计），更新 design.llm-gateway.md 补充两阶段调用规范，更新 codebase-snapshot 架构模式 |
| fix | prd-api | 修复 LLM Gateway SendRawAsync 二次 Resolve 导致"选 A 给 B"的模型调度 bug |
| refactor | prd-api | 删除 ExpectedModelRespectingResolver 补丁装饰器，GatewayRawRequest 新增 ExpectedModel 字段 |
| feat | prd-admin | 周报 Agent 团队视图重构：左侧新增按周垂直导航（当前周默认展开成员、历史周折叠、懒加载累加）+ 顶部周号/日期快速跳转，右侧点击成员就地嵌入周报详情 |
| feat | prd-admin | 周报 Agent 团队视图左侧导航升级：新增「年」分组层（【YYYY】 – 团队名）+ 周支持独立展开/收起，周名改为「N月第M周」中文命名；顶部跳转输入框替换为年/周双下拉选择器；每周成员列表仅显示已提交者（按提交时间倒序） |
| feat | prd-admin | 周报 Agent 左侧导航交互精简：周下拉去掉「W17 ·」冗余前缀只保留中文周名；选择周即跳转（移除独立"跳转"按钮）；折叠状态改为 allow-list 语义（默认仅展开当前选中周+当前 ISO 年），保证「加载更早 8 周」新进来的周全部默认折叠 |
| refactor | prd-admin | 周报 Agent 左侧导航移除「跳回本周」按钮，顶部精简为年/周双下拉一行 |
| feat | prd-admin | 周报 Agent 头部新增三档字号缩放（标准/大/特大，缩放比 1.0/1.15/1.3），用 CSS zoom 同步放大字体与图标；偏好存 sessionStorage，仅作用于周报 Agent 内容区，TabBar 和控件本身保持标准尺寸 |
| feat | prd-admin | 周报详情改为三栏布局：新增右侧 280px Rail（点赞段 + 已阅段），已阅从右上角按钮+Popover 改为常驻列表、点赞从底部浮动栏迁到右栏内竖向显示，嵌入模式与独立路由模式共用 |
| refactor | prd-admin | 周报详情右栏顶部对齐正文：Return banner 移至三栏容器上方，右栏前增 aria-hidden 占位 Tabs，保证缩放/banner 出现时右栏仍与中栏正文 GlassCard 顶边对齐 |
| feat | prd-admin | 周报 Agent 头部新增"暗色/浅色"主题切换（默认暗色），通过 scope 化 [data-theme="light"] 覆盖 tokens.css 里的 --bg-*/--text-*/--border-*/--glass-*/--shadow-card 变量，仅在周报 Agent 容器内生效；偏好存 sessionStorage |
| fix | prd-admin | 修复周报 Agent 浅色模式整体视觉未切换：AppShell 的 <main> 在 ReportAgentPage scope 外，背景 var(--bg-base) 取到仍是暗色。改为进入周报 Agent 时把 data-theme 同步挂到 documentElement，组件卸载/切回暗色时清除，保证整个视口跟随切换且不污染其他页面 |
| fix | prd-admin | 再次修复浅色模式：根因是 src/lib/themeApplier.ts 把 17 个 CSS 变量作为 inline style 写到 <html> 上（特异性 1,0,0,0），完全压制 [data-theme="light"] 规则。给 tokens.css 里浅色块所有变量加 !important（作者 !important 高于无 !important 的 inline style），并补齐 --nested-block-*、--list-item-*、--table-* 等 themeApplier 管理但之前漏覆盖的变量 |
| feat | prd-admin | 周报 Agent 浅色模式视觉精修：新增 useDataTheme hook（MutationObserver 监听 documentElement.dataset.theme），让 inline style 能感知主题；ReportEditor 的 sectionThemes 整宽色条、AI banner、退回 banner、已提交 banner、必填徽章、source badge（AI/MAP 等）在浅色模式下 alpha 调低 + border 加深，避免大色块喧宾夺主；ReportDetailPage 的 Return Dialog overlay、退回 banner、评论 chip 同步浅色化 |
| fix | prd-admin | 修复从团队列表"查看"进入周报详情独立路由后浅色模式失效：ReportDetailPage 在独立路由模式（无 reportIdOverride）下也读 sessionStorage 的 color-scheme，主动同步 data-theme 到 documentElement |
| refactor | prd-admin | 周报 Agent 头部移除"使用指引"按钮 + UsageGuideOverlay 关联代码，控件区精简为 ZoomControl + ThemeControl 两个右对齐控件 |
| fix | prd-admin | TeamDashboard 浅色精修：statusConfig 改为 buildStatusConfig(isLight) 函数，浅色 chip 底色 alpha 0.08→0.12；scope tab 选中态文字采用更深的蓝/绿确保对比度（rgba(29,78,216) / rgba(21,128,61)）；统计 chip 已提交/待提交文字色浅色下加深；成员抽屉 overlay 浅色下从 black/50 改为 slate-900/20 |
| feat | prd-admin | 周报 Agent 浅色模式第三波系统精修——卡片层次 + 对比度 + 一致性：(1) tokens.css 浅色 GlassCard 提亮到接近纯白 + 阴影加强，让卡片层次清晰浮在米色底上;(2) 新增 lightModeColors.ts 单一数据源,定义 9 种语义色 600/700 色阶;(3) 新增 --modal-overlay CSS 变量,8 处 modal portal 蒙层一改全改;(4) HistoryTrendsPanel/WeekNavRail/MyReportsList/DailyLogPanel/TeamDashboard 的 status/category config 全面改为 buildXxxConfig(isLight) 函数化,浅色统一用 600/700 色阶 alpha 1.0,WCAG AA 对比度全员达标 |

### 2026-04-22

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 新增 dotnet-run 热更新模式（增量+快）作 .NET 默认；dotnet-restart 降为疑难兜底 |
| feat | cds | deploy 下拉改二级菜单：按服务分组 + 每服务 hover 展开（部署/清理/核验/编辑命令） |
| feat | cds | 新增「 构建命令」编辑面板：用户自定义每个 profile 的多个 deployMode 命令，带预设模板（dotnet run / publish / pnpm dev） |
| fix | cds | agent-key-modal reminder borderTop 删除暗色 fallback（遵守 cds-theme-tokens.md 规则 #1：fallback 必须主题中性色） |
| perf | cds | renderHostStats 不再每 5 秒 innerHTML 重建 6 个 DOM 节点，改为首次建结构后仅更新 textContent + data-tier（消除 DOM churn + 屏幕阅读器反复重读） |
| feat | cds | `resolveApiLabel()` 补全 60+ 条中文 label（/me /status /tab-title /scheduler/* /storage-mode/* /data-migrations/* /workspaces/* 等），Activity Monitor 不再显示裸 URL |
| feat | cds | 新增 `auditApiLabels()` 启动时扫 Express 路由表，对缺失 label 的 /api/* 打 `[api-label]` warning，开发 + 生产日志均可见 |
| docs | cds | cds/CLAUDE.md 新增规则 0.1「API label 全量覆盖」：新增路由必须同步补 label，命名风格动词开头中文≤6 字 |
| feat | prd-api | Dockerfile 改用 BuildKit cache mount（NuGet + pnpm），restore 换服务器后也能秒级复用 |
| feat | cds | 新增缓存诊断/修复/跨服务器迁移（Settings → 缓存诊断） |
| fix | cds | migrateCacheMounts 现在合并缺失的 NuGet/pnpm 挂载（老的 skip-if-any 逻辑会让混合 profile 永远拿不到 nuget） |
| feat | cds | 顶部新增  全局转发日志面板，专门排查「页面正常但 API 502 没日志」 |
| feat | cds | 新增配置快照系统 —— 每次 import-config 前自动拍 + 手动拍 + 一键回滚 |
| feat | cds | 新增破坏性操作审计 + 30 分钟内撤销窗口（顶部  按钮） |
| feat | cds | /api/import-config 新增 cleanMode (merge/replace-all) + branchPolicy (keep/restart-all/clean) |
| feat | cds | 数据库一键备份下载 + 上传恢复（mongodump / redis BGSAVE / tar） |
| feat | cds | BuildProfile.hotReload：容器里跑 dotnet watch / pnpm dev，改代码自动重编译不重启 |
| feat | cds | 遗留 default 项目迁移：banner 提醒 + /api/legacy-cleanup/rename-default |
| fix | cds | 新建项目禁止使用 id='default'（保留给迁移占位） |
| feat | cds | 分支卡构建动效改为沿边框环绕的理发店灯柱高光，替代原顶端 2px 横条，视觉反馈更明显 |
| fix | cds | 分支卡构建计时器从右上角移到右下角，避免挡住工具栏按钮（灯泡/AI 标记） |
| feat | cds | 热更新新增 dotnet-restart 模式：kill+clean+no-incremental+重跑，对付 MSBuild 增量误判 |
| fix | cds | .NET profile 启用热更新默认用 dotnet-restart（watch 改为「不推荐」可选项） |
| feat | cds | 新增「 强制干净重建」：停容器 + rm -rf bin/obj，破除文件系统缓存 |
| feat | cds | 新增「 运行时字节码核验」：比对源码/DLL/进程启动时间，诊断是否在跑老字节码 |
| feat | cds | AI 操控指示器加「 结束」按钮，一点即调 /api/bridge/end-session 结束 Bridge session |
| feat | cds | 新增「 全局构建命令」面板：按镜像类型(.NET/Node/Python/手选)批量覆盖所有 profile 的 deployModes |
| feat | cds | POST /api/build-profiles/bulk-set-modes 后端：merge/replace 策略 + 自动拍 ConfigSnapshot 便于回滚 |
| fix | cds | Agent Key modal 白天模式显示问题：关闭按钮移除边框 + 底部分隔改 solid 避免在浅色背景看不见 |
| feat | cds | Header 工具栏精简：移除独立的"自动更新"按钮（入口已在  菜单），钥匙图标从 emoji 换成 stroke SVG 统一风格 |
| feat | cds | 默认视图从"列表"改为"拓扑"，header 列表/拓扑 segmented toggle 隐藏，切换入口迁移到  菜单 |
| feat | cds | Activity Monitor 收起态移除 "Activity" 文字（冗余），宽度改为自适应 |
| fix | cds | 修复项目列表页手机端顶部大片空白 —— .cds-sidebar-collapsible 作为 flex 子元素默认 min-height:auto 阻止 max-height:0 真正收缩，显式设 min-height:0 |
| fix | cds | 放大手机端  菜单按钮和图标比例到 55%（40×40 按钮 + 22×22 svg），不再"发虚" |
| docs | cds | 新增 cds/CLAUDE.md 把反复出现的按钮 icon 尺寸比例规则（≥55%）、flex 折叠 min-height:0、主题 token 双写等约束汇总落地 |
| fix | cds | 白天主题下彻底消除暗色背景残留：--bg-terminal 在 light 从 #1f1d2b 改为 #efe7df（和 --bg-base 对齐）；self-update 进度日志、agent-key 代码块、projects.js yaml 预览、cds-clone-log 全部走 var(--bg-terminal) + var(--text-primary) 让主题自动翻转 |
| docs | rules | .claude/rules/cds-theme-tokens.md 顶部加最高原则：白天主题禁止任何暗色背景 + 黑名单字面量（#0a0a0f / #0b0b10 / #1f1d2b / #e8e8ec / #cbd5e1）+ 提交前检查清单 |
| docs | cds | cds/CLAUDE.md 新增规则 0（最高优先级）把"白天禁暗底"钉死，反复踩 10+ 次的坑显式禁止 |
| feat | cds | 手机端增加  菜单导航：分支列表 header 只留  右靠（其他按钮收到 settings menu），标题和  一行；项目列表 sidebar 顶部默认收起， 展开 |
| fix | cds | 分支列表 header-actions 在手机端从左靠改为右靠（用户反馈图 2）|
| feat | cds | 分支列表 header 在 ≤640px 下换行（修复 Cloud Dev Suite 标题被列表/拓扑 toggle 盖住）+ 次要元数据小屏隐藏 |
| feat | cds | 项目列表页 ≤640px 下侧栏压成紧凑顶部条（logo + 工作区 + 导航 chip + 用户头像），主标题行换行防止「新建项目」CTA 被裁掉 |
| feat | cds | 项目卡技术栈图标在小屏从 120px 压扁到 64px，释放元信息/操作区垂直空间 |
| feat | cds | Activity Monitor 小屏下改为贴底全宽横条，展开限高 50vh |
| fix | cds | Modal 在 ≤380px 极小屏收紧 padding，输入框字号 ≥16px 防止 iOS Safari 自动放大 |
| fix | cds | 所有页面 viewport 移除 maximum-scale=1.0 与 user-scalable=no，允许双指缩放（可访问性） |
| refactor | cds | 项目列表  设置菜单去 emoji + SVG 图标 + 切换开关，和分支列表  菜单完全统一风格（之前两边分开开发，项目列表是 emoji + 内联样式，分支列表是 SVG + CSS class）|
| feat | cds | 顶部 Capacity (169/186) + MEM/CPU 两个胶囊合并为一个 .host-combined-badge 统一容器，一条分隔线区分两侧 |
| refactor | cds |  菜单移除「批量编辑环境变量」入口 —— 环境变量弹窗内已有「批量编辑」按钮，避免两处入口混淆 |
| refactor | cds |  菜单合并「一键导入配置」和「一键导出配置」为「一键导入 / 导出配置」—— 导入弹窗本就含导出按钮 |
| fix | cds | Agent Key modal 代码块在白天模式不再纯黑（走 --bg-terminal token 而非硬编码 #0b0b10 fallback） |
| fix | cds | self-update modal 输入框/进度日志在白天模式正确显示（删除所有 var(--bg-base, #darkColor) 硬编码 fallback，token 在两个主题统一定义） |
| fix | cds | self-update 分支下拉点击不消失的 bug —— 选中后 input.focus() 触发 focus 监听重新展开，加 _suppressFocusOpen 标志拦截 |
| fix | cds | CDS 重启 overlay z-index 从 9000 提到 10050，不再被 self-update modal 遮挡 |
| fix | cds | 分支列表加载图标从左上角改为页面居中（grid-column: 1/-1 + min-height: 50vh） |
| docs | rules | 新增 .claude/rules/cds-theme-tokens.md，规定 token 必须双主题同步 + 禁止暗色 fallback + z-index 分层表 |
| fix | cds | 宿主机实时负载 modal 白天模式修复：定义 10+ 个僵尸 token（--bg-card-2 / --fg / --text / --surface 等）为规范 token 的 alias，一劳永逸 |
| feat | cds | MEM/CPU 指标合并到顶部 header 胶囊（.host-pulse-badge），移除右下角浮动的 host-stats 浮窗 |
| feat | cds | 分支列表按"默认分支 → 收藏 → 其他"分组，每组内按最近使用时间倒序（新的靠前）|
| fix | prd-admin | 命令面板 hover 持续高亮 follow-up：将鼠标 hoveredId 从键盘 selectedId 彻底分离——鼠标进出只写 hoveredId、键盘方向键清 hoveredId，视觉 activeId = hoveredId ?? selectedId。前一版残留的"mouseEnter 也 setSelectedId"被移除，离开卡片高亮立即熄灭 |
| fix | prd-admin | 命令面板鼠标离开卡片后"跳转"到最近项的视觉 bug：默认 selectedId 指向 flatList[0]（常是"最近使用"第一张），hover 清掉后 activeId 回落到它导致高亮瞬移。新增 keyboardEngaged flag，仅在用户真正按过方向键 / 有搜索词时才渲染键盘态高亮，否则无 hover 即完全无高亮 |
| fix | prd-admin | 命令面板（Cmd+K）取消按权限过滤入口：请求日志 / 提示词 / 实验室 / 自动化规则 / 模型中心 / 团队协作等条目不再因当前用户缺少细粒度权限而完全隐藏，改由目标页自行校验 authz |
| fix | prd-admin | 命令面板卡片鼠标移出后 hover 高亮立即消失：拆分本地 isHovered 与键盘 selectedId，视觉取两者或，不再卡住在上次停留的卡上 |
| fix | prd-admin | 命令面板搜索框聚焦改为圆角矩形：包一层 label 容器承载 focus-within ring（圆角 + 紫色描边），input 本体加 no-focus-ring 压掉全局 :focus-visible 直角 outline |
| fix | prd-admin | 修复管理员隐藏的导航项会泄露到用户个人导航的问题 |
| fix | prd-admin | 修复 removeFromNav 将管理员隐藏项固化到用户偏好的问题 |
| fix | prd-admin | 修复用户显式添加到 navOrder 的项仍被隐藏的问题 |
| fix | prd-admin | 修复用户只有 navHidden 时回退到系统默认顺序失效的问题 |
| refactor | prd-admin | 移除未使用的 getDefaultNavLayout 函数（死代码清理） |
| fix | prd-admin | 修复直接打开页面时网络波动导致误注销问题（App.tsx 仅在 UNAUTHORIZED 时注销，DISCONNECTED/SERVER_UNAVAILABLE 不再触发 logout） |
| fix | prd-api | 修复生图消息记录中泄漏系统前缀的问题（ImageGenRunWorker 存储 [GEN_DONE]/[GEN_ERROR] 时统一剥离 "Generate an image based on the following description:" 前缀） |
| fix | prd-api | 修复参考图风格提示词泄漏到消息记录的问题（ImageGenRunPlanItem 新增 DisplayPrompt 字段保存用户原始 prompt，ImageGenController 和 LiteraryAgentImageGenController 在追加风格提示词前先保存原始 prompt） |
| fix | prd-api | Dockerfile 安装 Node.js 20 + pnpm，嵌入 prd-video 源码及依赖，修复 Remotion 渲染 npx 找不到问题 |
| fix | docker-compose | 构建上下文改为仓库根，新增 VideoAgent__RemotionProjectPath=/prd-video 环境变量 |
| fix | ci | server-deploy.yml 构建上下文改为仓库根，触发路径加入 prd-video/** |
| fix | prd-admin | 修复全局 `.font-mono` 被 VT323 像素字体劫持导致小字号文本字距异常/拉伸的问题：tokens.css 中的 `--font-mono` 改名为 `--font-terminal`（避免与 Tailwind v4 同名 theme token 级联冲突），所有 landing/arena/login 的 retro 文本引用同步迁移到新变量 |
| fix | prd-api | ModelResolver 在 expectedModel 命中候选池时优先尊重前端指定的模型，避免 DedicatedPool 静默换模型 |
| feat | prd-api | 新增「自适应模型」适配类型 SizeConstraintTypes.Adaptive + SizeParamFormats.None：尺寸由 prompt 决定，请求体不注入 size/n/quality/aspect_ratio |
| feat | prd-api | 注册 gpt-image-2-all（自适应）、gpt-image-1.5（标准 size 白名单）、nano-banana-2（aspectRatio 驼峰参数）三个新生图模型适配 |
| feat | prd-api | ImageGenRunWorker SSE runStart / imageDone 事件加上实际调度结果（modelId、modelGroupName、isAdaptive、resolutionType），前端可用此覆盖原本"前端选中的模型"展示 |
| feat | prd-admin | 视觉创作生图卡片显示后端实际使用的模型（来自 SSE），不再误显示前端 picker 选中的模型；自适应模型尺寸标签显示"自适应"而非"1K · 1:1" |
| feat | prd-admin | 模型适配信息（getVisualAgentAdapterInfo / getModelAdapterInfo*）返回 isAdaptive 字段，组合面板的尺寸 chip 在自适应模型下展示"自适应" |
| fix | prd-api | ModelResolver 尊重 expectedModel 的搜索范围扩大：候选池未命中时继续在同类型所有池 + LLMModels 直连里查找，避免"用户选的模型不在 AppCaller 绑定池"时被静默换成池默认项 |
| fix | prd-admin | 自适应模型（gpt-image-2-all 等）下 composer 两处尺寸 chip 改为静态展示，不再打开会暴露无关尺寸选项的 popover，消除"自适应但弹出 1:1/16:9 选项"的矛盾感 |
| fix | prd-api | ImageGenRunWorker.ResolveModelGroupAsync 新增"用户显式选择优先"短路：当 run.ModelId + run.PlatformId 都有值（Controller 已强校验必须提供），直接标 DirectModel 并跳过 scheduler，仅旁路查出该模型所属池名用于展示。彻底根治"picker 选了 gpt-image-1.5，后台被 scheduler 换成 gpt-image-2-all"的问题——前端 picker 里能选的必然能用，能用就不该再"尝试匹配" |
| fix | prd-api | 撤回 round3 的"跳过 scheduler"短路。零信任原则下 scheduler 是防御验证层不能省略。真正根因修在匹配本身——picker 发送 pool Code 作 modelId（如 "gpt-image-1-5" 带横线），旧匹配在"池所有模型被标 Unavailable"时整池跳过→回落到第一个池；另外 "gpt-image-1-5" vs "gpt-image-1.5" 命名差异也需兜底 |
| feat | prd-api | FindPreferredModel 增强：新增 Tier4 归一化匹配（去点/横线/下划线后比较），同档位池命中时不再因"模型 Unavailable"整池跳过（尊重"能选就代表能用"原则，真实请求失败时再让上游降级）；每档写详细 info/warn 日志便于未来定位命名不一致问题 |
| fix | prd-api | FindPreferredModel 撤回 Tier4 归一化匹配（命名由系统自动填充不会漂移，无需兜底）；Tier3 恢复严格健康守门，池内全部 Unavailable 时返回 null，让前端做明确的用户引导 |
| feat | prd-admin | 视觉创作新增"智能切换"偏好（默认开启，sessionStorage 持久化）：picker 里选的模型被判为不可用时前端弹窗三选一（切换到可用模型/仍使用原模型/取消），禁止后端静默换模型；关闭开关进入严格模式，直接按用户选择发送不弹窗 |
| feat | prd-admin | 用户消息气泡下方新增「用户期望：xxx」紫色徽标，来自 @model token，让用户发送后直观看到自己期望使用的模型 |
| fix | prd-api | ImageMasterController / ImageGenController 创建 run 时立即标 ModelResolutionType=DirectModel，让 Worker.ResolveModelGroupAsync 走早返回分支，不再调用 scheduler 覆盖用户显式选择的 modelId。这是 round1-5 的最终落脚点：Controller 层尊重用户选择，彻底断绝 DedicatedPool scheduler 把 picker 选择换成 candidateGroups[0] 的行为（即之前用户看到的"选 gpt-image-1.5 给 gpt-image-2-all"问题） |
| chore | prd-api | ModelResolver.cs 撤回诊断代码（_diag_resolver 集合写入 + DIAG-* LogError），恢复 round5 的干净实现 |
| fix | prd-api | 新增 ExpectedModelRespectingResolver 装饰器（Api.dll，能正常部署），包裹 Infrastructure.dll 里"改了无法生效"的 ModelResolver。所有 ResolveAsync 调用先在 Api 层做 Tier1/2/3 匹配（精确 ModelId → 前缀 → 池名/Code），命中就返回 FromPool，未命中才委派内部老 resolver。解决 Round 6 遗留的"OpenAIImageClient 内部调度仍然换模型"问题 |
| feat | prd-api | 新增 /api/debug/resolver/test 调试端点：不跑生图，直接接收 {appCallerCode, modelType, expectedModel}，返回候选池快照 + 每档匹配过程 + 实际 resolver 返回值。让"选 A 给 B"问题可独立、快速、反复测试，不用每次都跑真实生图 |
| feat | prd-api | 配套 /api/debug/resolver/inspect 只读端点：列出某 AppCaller 的绑定池、健康状态、模型列表（健康状态整数值也一并返回便于排查） |
| feat | prd-admin | 移动端首页第二轮苹果 Today 复刻对标：Hero 只保留"今日"单词（扔问候/姓名/日期/副标）；头像挪回 AppShell 右上角 header；Featured 改 3:4 海报级全屏轮播（5 张 snap-x）；视频背景（AGENT_VIDEO_DEFAULTS） + poster 图兜底 + mesh 渐变三级 fallback；只激活张自动播放省带宽；底部小点 page indicator；卡片副标限 1 行，Section caption 全部删除 |
| feat | prd-admin | 移动端首页页面级复刻苹果 App Store Today：新增 appStoreTokens 设计体系（字号 9 档 + 间距阶梯 + iOS Dark Mode 系统色 + SF Pro 字体栈），新增 mobile/appStore 组件集（Hero / Featured / Shelf / RankedList / SectionHeader / Pill / AppIcon / Section） |
| feat | prd-admin | MobileHomePage 重写：Hero 大标题（日期 eyebrow + 34px 粗体问候 + 头像带通知红点）、Featured 大卡（今日推荐 Agent，复用 AGENT_COVER_DEFAULTS 封面图）、智能体横滑卡片（iOS Dark Mode 系统色 Accent 搭配每个 Agent）、工具 Top 榜单（编号 + 细分隔线）、极简 4 卡近 7 日统计、通知 / Feed 榜单风 |
| refactor | prd-admin | AppShell 移动端首页 header 透明化：隐藏中间标题与右侧铃铛（已由 Hero 头像红点承担），避免和页面内 Hero 标题视觉冲突 |
| fix | prd-admin | 修复移动端登录后黑屏：新增 MobileSafeBoundary 错误边界（渲染异常不再静默卸载整棵树），MobileHomePage 改用 Promise.allSettled 避免单个 API 失败导致整页空白 |
| fix | prd-admin | AppShell 根容器补 min-height:100dvh，修 iOS Safari 地址栏收缩引发的高度抖动/黑带 |
| fix | prd-admin | 修复 ChangelogBell 窄屏下无限 re-render + 请求风暴：selectRecentEntries 每次返回新数组触发 useSyncExternalStore 循环，改为组件侧 useMemo 派生 |
| feat | prd-admin | 全局 window.error / unhandledrejection 自动捕获到 sessionStorage 环形缓冲，/_dev/mobile-audit 新增诊断视图（自动扫所有路由黑屏/JS 报错，客户端错误面板实时刷新） |
| feat | prd-admin | 新增 mobileCompatibility 注册表 + MobileCompatGate：limited 页顶部黄色 banner 提示受限，pc-only 页中央门槛卡（继续/复制链接），full 页无感知 |
| fix | prd-admin | 修复系统通知弹窗按钮被挤成竖排单字：卡片窄屏改竖排，按钮列 shrink-0，按钮文字 whitespace-nowrap |
| fix | prd-admin | 移动端隐藏 AppShell 右下通知浮球（顶栏已有 Bell，避免与 MobileTabBar "+" 重叠） |
| feat | prd-admin | MobileHomePage 重构首页：快捷入口 → 智能体 + 工具两个横滑卡片区（苹果 App Store 风），数据来自 BUILTIN_TOOLS；卡片右上角自动标记 pc-only/limited 徽章，首页即可触达所有内置 Agent |
| feat | prd-admin | 移动端首页：静态封面图作为 iOS app icon（AGENT_COVER_DEFAULTS），Featured 底部 glass bar + 智能体 Shelf 卡片全部改走封面图，无图 agent fallback Lucide + 渐变底 |
| feat | prd-admin | 移动端 Featured Carousel 切换水波纹动效：点击底部小点触发 View Transition API，clip-path circle 从点击坐标扩散（520ms），复用系统皮肤切换同款技术栈；手指滑动保持原生 snap 手感；Safari < 18.2 降级为 scroll-behavior smooth |
| fix | prd-admin | 修 Cursor Bugbot 提的 3 个 PR #475 review:<br>① **High**:`normalizeAutoAction` 的 step 映射漏掉了 `navigateTo` 字段,导致管理员编辑含跨页 Tour 的 tip 再保存会**静默丢失**所有 `navigateTo`。补上 `navigateTo: s.navigateTo?.trim() ? trim() : null`<br>② **Medium**:`SpotlightOverlay` 的 `expand` / `prefill` 逻辑放在依赖 `stepIndex` 的 effect 里,每次「下一步」都会 re-fire — **把折叠面板点回关、覆盖用户已输入内容**。拆成独立 effect 只依赖 `payload`,用 `setupRanForPayloadRef` ref 确保同一 payload 内只执行一次<br>③ **Low**:`writeSpotlightPayload` 的 `if (!selector && !tip.autoAction) return` 和 `if (!selector) return` 逻辑矛盾 — autoAction-only 的 tip(只有 autoClick/prefill 没 selector)提前返回不写 payload,`dispatchEvent` 也没发。改为统一要求至少一个 selector,纯 autoAction 没 selector 的场景直接 skip(overlay 无法定位光圈) |
| fix | prd-admin | 修 Cursor Bugbot 在 commit 0ca40f5 后提的 3 个新问题(PR #475):<br>① **Medium**:`autoClick` 定时器跟 `expand/prefill` 同病 —— 在依赖 `rect/stepIndex` 的 effect 里,多步 Tour 每切一步 rect 更新就启动新 timer,1.2s 后 click + dismiss,**打断整个 Tour**。修:加 `autoClickFiredForPayloadRef` ref 确保每 payload 只点一次;且**多步 Tour 完全忽略 autoClick**(语义冲突 — 用户手动推进 vs 自动点击)<br>② **Low**:`scrollIntoView({ behavior: 'smooth' })` 后立刻 `getBoundingClientRect()` 拿到滚动前的 stale 位置,光圈先闪到屏外再靠 scroll 事件滑回来。改 `behavior: 'auto'` 同步滚动,rect 读到的永远是正确位置;淡入动画已足够自然,不需要 smooth scroll<br>③ **Low**:`setDockCollapsed` 里手动写 sessionStorage + dispatch 一次,然后 `setHiddenByUser` 触发 `useEffect` 又写 + dispatch 一次,AppShell 收到**两次**相同事件。简化:`setDockCollapsed` 只 `setHiddenByUser`,持久化和广播由 `useEffect` 统一处理 |
| fix | prd-admin | 修 Cursor Bugbot 在 commit 50676e5 后提的 3 个新问题(PR #475 round 3):<br>① **Medium**:多步 Tour 保留旧 rect 防闪烁的副作用 —— 超时后 `seekTimedOut=true` 但 `rect` 仍是上一步的值,`!rect && seekTimedOut` 永远不成立,橙色失败卡片**永不显示**,用户在跨页 navigateTo 场景光圈会卡在旧页的位置且没跳过按钮。修:失败卡片条件从 `!rect && seekTimedOut` 简化为 **`seekTimedOut`**,不管 rect 是否非空都显示<br>② **Medium**:AppShell 铃铛召回后 TipsDrawer 不同步 —— AppShell 发 `FLOATING_DOCK_EVENT(collapsed:false)` 但 TipsDrawer 只发不订,书仍贴边。修:TipsDrawer 新增监听器 `setHiddenByUser((prev)=> prev === detail.collapsed ? prev : detail.collapsed)`,值不同才更新避免循环;AppShell onClick 删掉手动 removeItem,只 dispatch event 统一走 TipsDrawer 的 useEffect 清理持久化<br>③ **Low**:`FLOATING_DOCK_COLLAPSED_KEY` 导出但 AppShell 用字符串字面量 'floatingDockCollapsed' 3 处。修:`TipsDrawer` 新增 `FLOATING_DOCK_EVENT` 导出,AppShell `import { FLOATING_DOCK_COLLAPSED_KEY, FLOATING_DOCK_EVENT }` 全部用常量,防止两侧字符串漂移 |
| fix | prd-api | 放宽 5 处所有权闸门 — GetItem/RunItem/CreateSession/TriggerWorkflow/DirectChat 允许自己创建的或 IsPublic=true 的条目（抽取 FindVisibleItemAsync helper）；编辑/删除/发布依然严格仅限创建者。用户公开发布后，别人从此能真正运行原版而不是被迫 Fork |
| fix | prd-api | 新增 EnrichCreatorInfoAsync helper — GetItem / ListItems / ListPublicItems 返回前按 Users 集合批量回填 CreatedByName / CreatedByAvatarFileName（只填缺失字段）。老数据从此不再显示"匿名用户"，作者名和头像正常可见 |
| fix | prd-admin | 点别人公开的卡片不再偷偷创建副本 — ToolCard/ToolDetail 都把 marketplace 卡片点击改为打开详情抽屉；「创建副本」必须在详情页或右下角按钮显式点击并二次 confirm 才会触发，彻底消除"反复误复制"的反人类流程 |
| fix | prd-admin | BUILTIN 官方工具误挂「施工中」徽章 — isOwnCustomCard / isCustom 两处判定收紧，硬排除 type='builtin'，不再用 createdByName 兜底（因为 BUILTIN普通版硬编码 createdByName='官方'，之前所有用户都看到「施工中」标记） |
| fix | prd-admin | BUILTIN 官方工具用 MAP 品牌徽标代替首字母圆形块 — 之前容易被误认为"某个用户的头像"；同时 authorAvatarUrl 对 BUILTIN 强制返回 null，杜绝意外展示当前登录用户头像 |
| fix | prd-admin | 详情顶部「来自社区」chip 改为显示真实作者名 `由 {name} 发布`；meta 信息行对 isOthersPublic 强制渲染作者字段（即使没有 createdByName 也显示 `用户 #xxxxxx`）；卡片上"匿名用户"fallback 同步替换为 `用户 #xxxxxx` |
| feat | prd-admin | 百宝箱首页从 5 tab 改为 3 权属筛选（全部 / 我的 / 别人的）+ 收藏；loadItems 一次性合并 BUILTIN + /items + /marketplace，按 ownership 字段区分；公开发布的智能体立即出现在所有用户的「全部 / 别人的」里 |
| feat | prd-admin | 别人 7 天内发布的公开条目卡片左上角加红底脉动 NEW 徽章（基于 createdAt 计算，窗口期常量 NEW_BADGE_WINDOW_MS = 7 天） |
| refactor | prd-admin | ToolCard/ToolDetail 4 处 window.confirm 与 confirm 全部替换为 systemDialog.confirm（含 tone='danger'/confirmText/cancelText）；与项目统一的模态风格一致，不再出现浏览器原生弹框 |
| chore | prd-admin | ToolboxItem 类型声明补上 createdByUserId（与后端 camelCase 对齐）和 ownership 字段；旧的 createdBy 保留仅为兼容历史调用点 |
| refactor | prd-admin | 百宝箱卡片从 3:4 竖板改 4:3 横板，网格最小宽度 180→240px，对齐首页 AgentGrid 视觉语言；删除"定制版"徽章；BUILTIN 卡片底部不再显示 MAP/官方/作者等特殊标记，仅保留使用次数 + 收藏星，保持"默认智能体样子" |

### 2026-04-21

| 类型 | 模块 | 描述 |
|------|------|------|
| refactor | prd-admin | 统一智能体/工具/基础设施三桶分类:`ToolboxItem` 新增 `kind?: 'agent' \| 'tool' \| 'infra'`;BUILTIN_TOOLS 9 项标 `kind: 'agent'`(PRD 解读/视觉创作/文学创作/缺陷管理/视频创作/周报/AI 竞技场/产品评审/PR 审查),6 项标 `kind: 'tool'`,更新中心与工作流引擎下放基础设施 |
| refactor | prd-admin | `AgentLauncherPage` 首页新增「基础设施」分组:知识库 / 我的资源 / 海鲜市场 / 模型中心(mds.read)/ 团队协作(users.read)/ 工作流引擎 / 网页托管 / 更新中心,与智能体/实用工具并列展示,支持权限门控 |
| refactor | prd-admin | `launcherCatalog.ts` 新增 `buildInfraItems()` + `LauncherGroup` 扩 `'infra'`;涌现探索划归 `group: 'agent'`;`AgentSwitcher` 浮层同步新增「基础设施」分区 |
| refactor | prd-admin | 统一智能体命名:`智能助手` → `智能体`;内联短名 Agent → 智能体(视觉 Agent → 视觉创作智能体 等)统一到 authzMenuMapping / homepageAssetSlots / landing mocks / 页面标题(ReviewAgentPage / PrReviewPage / VideoAgentPage / MobileHomePage) |
| refactor | prd-admin | `ProjectDialog` placeholder `智能助手` → `智能体` |
| refactor | prd-api | `AdminPermissionCatalog` 权限标签统一改为智能体后缀(PRD 解读智能体/视觉创作智能体/文学创作智能体/缺陷管理智能体/视频创作智能体/AI 竞技场智能体/周报智能体/产品评审智能体/PR 审查智能体/转录智能体/数据迁移智能体/技能引导智能体) |
| refactor | prd-api | `AiToolboxController` 兜底 systemPrompt `智能助手` → `智能体` |
| feat | prd-api | 更新中心 POST `/api/changelog/ai-summary`：经 `ILlmGateway` + `prd-admin.changelog.aiSummary::chat` 生成摘要，`LlmRequestContext` 含 UserId |
| feat | prd-admin | 更新中心「AI 总结」改为调用上述接口，移除本地规则拼装与假延迟 |
| fix | prd-admin | handleRefresh 拉 GitHub 日志补 `.catch()`，避免未处理 Promise 拒绝（Bugbot） |
| fix | prd-api | TryReadGitLogsAsync 并行读完 stdout/stderr，避免重定向管道死锁（Bugbot） |
| fix | prd-admin | GitHub 日志主拉取 effect 恢复依赖 `loadingGitHubLogs`，修复预取进行中切 tab 后预取失败不触发正式拉取的卡死（Bugbot PR#468） |
| fix | prd-admin | 更新中心：GitHub 日志拉取失败不再无限重试；后台预取仅调度一次；AI 总结按子 tab 独立 runId 避免永久 loading |
| fix | prd-api | ChangelogReader 本地 git log 时间由 %aI 改为 %cI，与 GitHub API committer.date 对齐 |
| feat | prd-api | UserPreferences 新增 NavHidden 字段 + PUT /api/dashboard/user-preferences/nav-hidden 与 PUT /api/dashboard/user-preferences/nav-layout 端点（布局一次性保存，减少往返） |
| feat | prd-admin | 设置页"导航顺序"改版为横向双区拖拽 UI：上方"我的导航"长条 + 下方"可添加"候选池，支持拖拽重排、隐藏、添加分隔横杆（"---"哨兵），右上角"恢复如初"按钮清空自定义。分组横杆仅作视觉分隔，不绑定业务语义 |
| fix | prd-admin | 修复跨用户导航污染：logout 显式重置 navOrderStore + agentSwitcherStore 内存态，避免同一浏览器切换账号后旧用户布局残留 |
| refactor | prd-admin | navOrderStore 抽出 NAV_DIVIDER_KEY 常量与 reset 方法；AppShell 在存在自定义顺序时按"---"切段渲染，兜底追加新上线菜单防止"消失" |
| fix | prd-admin | 设置页首次进入已显示默认分隔横杆（currentOrder 默认在 NAV_GROUPS 切换处注入 NAV_DIVIDER_KEY），不再需要用户点击"恢复如初"才出现分段；"恢复如初"对未自定义过的用户视觉无变化 |
| feat | prd-admin | 设置页候选池从仅 menuCatalog 扩展到完整 Cmd+K 启动目录（Agent / 百宝箱 / 实用工具），按分组显示；AppShell 侧边栏同步支持 launcher id 形式的 navOrder token（agent:/toolbox:/utility:）回退解析，从候选池拖入的条目可正常渲染 |
| refactor | prd-admin | 抽取 getShortLabel + SHORT_LABEL_MAP 到 lib/shortLabel.ts，AppShell 与设置页「我的导航/候选池」芯片共用同一份短标签规则，保证侧栏折叠态文字与设置页显示一致（如统一显示「百宝箱」而非一处「AI 百宝箱」一处「百宝箱」） |
| fix | prd-admin | 修复「加分隔」按钮点击无反应：原逻辑追加分隔符到末尾后被 collapseDividers 当作无意义尾部剥掉。改为在最后一个条目之前插入分隔符，用户可立即看到新横杆并拖动到任意位置 |
| refactor | prd-admin | 设置页「我的导航/候选池」芯片样式改为 56×~50 紧凑竖排瓷砖（图标 28×28 + 10px 短标签），与侧栏折叠态完全一致，不再是宽大水平胶囊；DividerChip 高度由 32px → 48px 对齐；首页作为不可拖/不可移的固定领头芯片展示在"顶部"标识之后（从候选池移除，因为侧栏已恒常固定） |
| fix | prd-admin | 设置页所有可拖芯片（NavItemChip / DividerChip / PoolItemChip）补齐 onDragEnd 回调：按 Esc 或拖到无效位置取消时，`dragSource` / `dragOverNavIndex` / `dragOverPool` 及高亮动画立即复位，避免"拖拽遗留光圈"视觉残影 |
| refactor | prd-admin | 清理 navOrderStore 死代码：移除未被任何文件引用的 `isDivider()` 导出（所有调用点直接对比 `NAV_DIVIDER_KEY` 常量） |
| refactor | prd-admin | 清理 user-preferences services 死代码：移除前端 `updateNavHidden` 链（UpdateNavHiddenContract + updateNavHiddenReal + withAuth 导出），navOrderStore 统一走 `updateNavLayout` 一次性保存；后端 PUT /api/dashboard/user-preferences/nav-hidden 端点保留供外部 API 用 |
| fix | prd-admin | 修复自定义导航的 launcher 分支绕过 navHidden：AppShell `groupedNav` 在按 navOrder 重排时，launcher id（agent:/toolbox:/utility:）走的是 `launcherById.get(token)` 回退分支，之前未经过 `visibleItems` 的隐藏过滤，导致"既在 navOrder 又在 navHidden"的 launcher 条目仍会在侧栏渲染。现在在 token 循环内显式 `hiddenSet.has(token)` 短路，menuCatalog + launcher 两条路径统一受 navHidden 约束；useMemo 依赖数组同步补齐 `navHidden` |
| refactor | prd-admin | 清理 navOrderStore 剩余死代码：移除未被任何组件调用的 `setNavOrder` / `setNavHidden` 独立 setter（navOrderStore 对外只暴露 `setNavLayout` 一次性保存）与 `mergeNavOrder` 通用合并函数（AppShell 已自己实现按"---"切段逻辑），缩减 store 对外暴露的 API 面 |
| fix | prd-admin | 修复 launcher 条目在 AppShell 侧栏显示为通用 Cpu 图标：launcher 目录（agent:/toolbox:/utility:）的图标名是前端自定义枚举，`Library`/`Sparkle`/`Video`/`Palette`/`PenTool`/`FileBarChart` 等未被静态 `iconMap` 覆盖，之前全部回退为 Cpu，与 SettingsPage 的动态 `(LucideIcons as any)[name]` 查找视觉不一致。现在 launcher 分支加一层 lucide-react 命名空间动态查找兜底，两边图标保持一致 |
| refactor | prd-admin | 清理前端 `updateNavOrder` 死代码链（UpdateNavOrderContract + updateNavOrderReal + withAuth 导出），与此前移除 `updateNavHidden` 同属一个清理方向——navOrderStore 已经统一走 `updateNavLayout` 一次性保存；后端 PUT /api/dashboard/user-preferences/nav-order 端点保留供外部 API 使用 |
| fix | prd-admin | 修复 logout 异步重置竞态：原 `useAuthStore.logout` 用 `void (async () => { dynamic import ... })()` 是 fire-and-forget，`sessionStorage.clear() + set(INITIAL_STATE)` 不等 dynamic import resolve 就直接同步执行——同一浏览器切换账号时，下个用户的 `loadFromServer()` 会被 stale `loaded: true` 标志 early-return，旧用户自定义导航残留。改为在 authStore 模块级维护 `logoutResetCallbacks` 注册表 + 导出 `registerLogoutReset(fn)`，navOrderStore / agentSwitcherStore 在自身模块装载时调用 `registerLogoutReset(reset)` 注册同步回调；logout 内同步 `for (const fn of callbacks) fn()` 执行，保证在 `sessionStorage.clear` 前 `loaded` / `serverLoaded` 已归位。绕开 `authStore → navOrderStore → @/services → authStore` 循环引用的方式变为"反向注册"（authStore 不 import 任何 store，由 store 主动登记） |
| refactor | prd-admin | AppShell 的 `groupedNav` 切段循环把硬编码字符串 `'---'` 替换为从 navOrderStore import 的 `NAV_DIVIDER_KEY` 常量，与设置页、store 内部保持单一真相源（之前 navOrderStore 已导出常量，AppShell 是唯一遗漏点） |
| feat | prd-api | 新增每日小贴士(DailyTip)后端:Model + 两个 Controller(用户侧 `/api/daily-tips/visible` + 管理侧 `/api/admin/daily-tips` 增删改查),Controller 内置 fallback 种子,DB 空时兜底 8 条内置 tips;缺陷闭环桥接:缺陷被修复时自动生成定向 tip 推送给原始提报人 |
| feat | prd-admin | 新增每日小贴士前端:右上角 `TipsDrawer` 悬浮铃铛 + 定向 tip 徽章 + session 维度关闭,首页副标题 `TipsRotator` 轮播,跳转后 `SpotlightOverlay` 在目标 DOM 上播放脉冲光圈(via `data-tour-id`) |
| feat | prd-admin | 新增全局命令面板(⌘/Ctrl + K):统一搜索智能体 + 后端菜单目录 + 快捷操作(首页/百宝箱/设置/更新中心),键盘上下导航 Enter 进入,`createPortal` 渲染遵守 frontend-modal 3 硬约束 |
| feat | prd-admin | 设置页新增「小技巧」Tab:管理员 CRUD 表单(文本/卡片/聚光灯三种类型),显示来源(manual/seed/defect-auto),支持定向到特定用户 |
| fix | prd-admin | 超宽屏 4 个快捷链接卡过大问题:限制单卡最大宽度,避免 1920+ 显示器下横向铺满 |
| feat | prd-admin | 新增可复用 DOM 标记 `data-tour-id`:首页副标题/搜索框/4 个快捷入口,供 tip spotlight 系统定位 |
| feat | prd-api | DailyTip 新增 `AutoAction` 字段(Scroll/Expand/Prefill/AutoClick/AutoClickDelayMs/Steps),默认 seed tips 全部填上真实 tour 动作:toolbox 预填「周报」、defect 自动点「提交缺陷」、report 多步 Tour、emergence 自动点「种下第一颗种子」 |
| feat | prd-admin | SpotlightOverlay 重写,按 AutoAction 依次执行:展开折叠面板 → 预填输入框(native setter + input event 触发 React onChange)→ 脉冲光圈 + 气泡卡片 → 多步 Tour「下一步」或延迟自动点击;用 createPortal 挂 body,支持 ESC/点击蒙版关闭 |
| feat | prd-admin | TipsDrawer / TipsRotator 通过新增的 `writeSpotlightPayload` 把完整 tip(title/body/ctaText/autoAction)写入 sessionStorage,SpotlightOverlay 读取后可在落地页渲染气泡卡片,旧的 selector-only 行为保留做向后兼容 |
| feat | prd-admin | 7 个目的页补齐 `data-tour-id` 锚点:marketplace-category-tabs / library-create / changelog-latest / toolbox-search / defect-create / report-template-picker / emergence-seed-input,让跳转后的高亮真的有地方落 |
| feat | prd-admin | DailyTipsEditor 表单新增「高级自动引导」分组,支持可视化编辑 AutoAction 的所有字段,含多步 Tour 的增删改,前端统一 `normalizeAutoAction` 规整空值 |
| refactor | prd-admin | 小技巧管理 PushDialog 扩到 `min(960px,100%)` 两栏布局(左推送表单 / 右投递列表),列表页加 `maxWidth: 1180` 改善宽屏留白;修复之前「跳转后除了打开页面一点作用都没有」的体验缺陷 |
| fix | prd-admin | 小贴士抽屉触发按钮从右上角铃铛改到右下角 Lightbulb(48px 圆形 + 紫色渐变 + hover 上浮),避免跟 AdminNotification 的 Bell 图标撞风格;抽屉从底部向上弹出,卡片阴影收紧、渐变边框更柔 |
| feat | prd-api | AdminDailyTips 新增 `POST /api/admin/daily-tips/seed` 一键幂等植入 8 条内置默认 tip(按 SourceId 去重),用于新环境 / 清空后让管理员把 seed 变成真实数据;返回 insertedCount/skippedCount/totalDefaults |
| feat | prd-admin | 小技巧管理页工具栏新增「一键植入默认」按钮;空状态改为 Sparkles 大图标 + 说明文案 + 两个 CTA(一键植入 / 从零新建),不再只是干瘪的「暂无」提示 |
| feat | prd-api | 每日小贴士新增定向推送 + 交互统计(奥卡姆剃刀方案):`DailyTip` 内嵌 `Deliveries: List<DailyTipDelivery>` 记录(UserId / Status: pending/seen/clicked/dismissed / ViewCount / MaxViews / PushedAt / LastSeenAt / ClickedAt / DismissedAt),不新开集合 |
| feat | prd-api | AdminDailyTips 新增 `POST /{id}/push`(推送给用户,支持 reset 重置) + `GET /{id}/stats`(汇总 + 每用户状态 + 展示名),DailyTips 新增 `POST /{id}/track`(seen/clicked/dismissed,seed-* 自动忽略) |
| feat | prd-api | DailyTips/visible 过滤器扩展:有 Deliveries 的 tip 只对列表内且未 dismissed、未超过 MaxViews 的用户可见;被投递用户视为定向置顶,返回 `deliveryStatus/viewCount/maxViews` |
| feat | prd-admin | 小技巧管理:每条 tip 新增「推送」按钮 → `PushDialog` 挑用户 + 设置展示上限 + 重置开关,同屏展示投递列表(头像占位 / 状态徽章 / 展示次数 / 最后查看时间 / 汇总 chip) |
| feat | prd-admin | TipsDrawer 打开时自动 `track(seen)`,CTA 点击 `track(clicked)`,用户关闭 `track(dismissed)`;TipsRotator 点击 `track(clicked)`,补齐后台统计链路 |
| feat | prd-api | 海鲜市场「技能」新增封面图 + 预览地址（external URL / hosted_site）字段、上传流程、删除清理 |
| feat | prd-api | 技能详情自动兜底链升级：用户输入 → 规则提取 SKILL.md → LLM 30 字摘要 → 标题 |
| feat | prd-admin | 重设计海鲜市场技能卡片（封面图为主视觉 + 预览地址快捷入口 + 收藏按钮行内化） |
| feat | prd-admin | 技能上传弹窗新增封面图上传区 + 预览地址三 Tab（不设置 / 托管站点 / 外部 URL） |
| fix | prd-admin | 首页 Quick Links 四卡改为左对齐 + 全宽铺满:移除 `mx-auto` / `maxWidth: 1440` / `justifyContent: center` / 单卡 320px 上限,改用与下方 Agent 卡相同的 `repeat(auto-fit, minmax(260px, 1fr))`,在宽屏上和 AGENTS 分组对齐 |
| feat | prd-api | 新增 `AgentApiKey` 模型 + `agent_api_keys` 集合 + `IAgentApiKeyService`：为 AI / Agent 提供带 scope 的长效 M2M API Key（默认 365 天 + 7 天宽限期 + UI 续期），明文仅创建时返回一次 |
| feat | prd-api | `ApiKeyAuthenticationHandler` 扩展：识别 `sk-ak-` 前缀走 AgentApiKey 路径，附带 scope claim + 过期/宽限期响应头（`X-AgentApiKey-ExpiringSoon` / `X-AgentApiKey-Expiring`） |
| feat | prd-api | 新增 `RequireScopeAttribute` 端点级 scope 授权过滤器 |
| feat | prd-api | 新增 `/api/open/marketplace/skills/*` 开放接口（list / 详情 / tags / fork / upload / favorite），scope = `marketplace.skills:read` 或 `marketplace.skills:write` |
| feat | prd-api | 新增 `/api/agent-api-keys` 用户管理接口：list / create / PATCH / renew（续期一年）/ revoke / delete |
| feat | prd-admin | 海鲜市场顶部新增「接入 AI」按钮 + `SkillOpenApiDialog`（我的 Key / 新建 Key / 使用指南 三 Tab），支持 scope 勾选、TTL 选择、明文一次性展示、curl/TS/Python 代码样本 |
| feat | prd-admin | 百宝箱新增条目「技能市场开放接口」（`builtin-skill-marketplace-openapi`，`wip: true`） |
| feat | . | 新增 `.claude/skills/findmapskills/SKILL.md`：让 AI 通过开放接口搜索并下载本平台海鲜市场的技能（与 `find-skills` 搜公共生态互补） |
| feat | prd-api | 新增 `/api/official-skills/{skillKey}/download`：平台官方技能包动态 zip 端点，匿名可访问；内置 `marketplace-openapi` 客户端技能（SKILL.md + README，{{BASE_URL}} 运行时替换） |
| feat | prd-admin | 「接入 AI」面板改用液态大玻璃效果（线性渐变 + blur(40px) saturate(180%) + 内光反射）呼应项目设计语言 |
| feat | prd-admin | 「接入 AI」面板首次打开自动下载官方技能包 + Guide/Keys/Create Key 三处均可见显式「下载技能包」按钮；消除"没技能包不知道怎么用"的认知缺口 |
| feat | prd-admin | CreateKeyTab 明文展示态新增「复制给智能体使用」按钮：一段完整提示词，粘贴到 Claude Code / Cursor 后 AI 自动 `export` 环境变量 + 下载解压官方技能包 |
| feat | prd-api | P3 基础设施：新增 `AgentOpenEndpoint` Model + `agent_open_endpoints` 集合 + `/api/admin/agent-open-endpoints` Admin CRUD —— 每个 Agent 可登记 HTTP 开放接口（路径、方法、所需 scope、白名单） |
| feat | prd-api | P3：`AgentApiKeysController` scope 白名单扩展为"固定 + 动态"：固定 `marketplace.skills:*`，动态接受正则 `agent.{key}:{action}` 且 scope 必须已被某条 `AgentOpenEndpoint` 登记 |
| feat | prd-api | P3：`MarketplaceSkill` Model 新增 `ReferenceType` (`zip` \| `open-api-reference`) + `ReferenceEndpointId` 字段，为"Agent 开放接口自动桥接到海鲜市场技能引用"铺路（自动桥接逻辑待后续实现） |
| refactor | prd-admin | 「接入 AI」弹窗 Tab 重构为 [新建接入 / 我的 Key / 使用指南] 三页：落地页只有两个大卡片（手动接入 → 跳使用指南；智能体接入 → 切 Keys Tab + 自动展开带 agent 模式的新建表单，主 CTA 变为"复制给智能体使用"）。合并原"新建 Key"独立 Tab 到"我的 Key"内联展开。移除首次打开自动下载行为（改为纯手动点击）|
| refactor | prd-api | 官方技能包 key 由 `marketplace-openapi` 重命名为 `findmapskills`，SKILL.md 模板整合为海鲜市场全操作手册（搜索/下载/上传/收藏/订阅/Key 过期处理一揽子），对应 `GET /api/official-skills/findmapskills/download` |
| refactor | prd-admin | 「复制给智能体使用」提示词精简并加固安全：仅 3 步 —— 把 Key 写进 `~/.zshrc`/`~/.bashrc`（不入仓）+ 一行 curl 下载 findmapskills 到 `~/.claude/skills/` + 让 AI 读 SKILL.md 自学；移除原 verbose 版多步骤说明 |
| fix | prd-admin | 「新建接入」落地页样式调优：推荐卡片从高饱和紫色改为青蓝半透明（和液态玻璃面板融合），新增「3 步时间线」+「安全 & 生命周期双栏」填充下半部空白，消除"大面板底部黑洞"视觉缺陷 |
| docs | . | 补齐交接清单 P1 文档：`doc/rule.data-dictionary.md` 追加 `agent_api_keys` + `agent_open_endpoints` 两集合 · 新建 `doc/design.skill-marketplace-open-api.md` 覆盖架构/scope 契约/Key 生命周期/P3 演进路线 · `.claude/rules/codebase-snapshot.md` 集合数 115→117 + 功能注册表补条 |
| feat | prd-api | findmapskills 官方技能接入版本号机制：新增 `FindMapSkillsVersion=1.0.0` + `FindMapSkillsReleaseDate=2026-04-21` 常量；SKILL.md / README 模板顶部加版本号 header + 底部新增「如何更新此技能」章节（3 种触发信号 + 重装 curl 命令）；下载端点自动替换 `{{VERSION}}` / `{{RELEASE_DATE}}` 占位符；`.claude/skills/findmapskills/SKILL.md` 仓库版与后端模板同步 |
| feat | prd-api | findmapskills 虚拟注入到海鲜市场列表：新增 `OfficialMarketplaceSkillInjector` 静态 helper；`MarketplaceSkillsController.List` + `MarketplaceSkillsOpenApiController.List` 在筛选命中时把 `official-findmapskills` 条目 Prepend 到首位；Fork / GetById 端点按 `official-` 前缀特判、不查 DB / 不 +1 count，直接返回 `/api/official-skills/findmapskills/download` 官方下载 URL |
| feat | prd-admin | MarketplaceCard 识别 `ownerUserId === 'official'` 条目，标题右上角展示「 官方」青蓝描边徽章（替代普通类型标签），视觉上和普通 zip 技能做区隔 |
| fix | prd-api | 安全加固：`AgentApiKeyService.GenerateApiKey` 改用 `RandomNumberGenerator.GetBytes(16)` (CSPRNG) 取代 `Guid.NewGuid()`（UUIDv4 规范上不保证密码学随机性），保留 32 hex char/128 bit 熵；`OfficialSkillTemplates` 新增 `FindMapSkillsReleaseDateUtc` 静态 DateTime 常量，消除 `OfficialMarketplaceSkillInjector` 在每次列表请求里 `DateTime.Parse` 引入的文化敏感性与性能损耗 |
| chore | prd-admin | hygiene：删除 `downloadOfficialSkill.ts` 中的死代码 `hasDownloadedOfficialSkill` / `markOfficialSkillDownloaded` / `FIRST_DOWNLOAD_KEY`（reader 0 处使用），同步清理 3 个 Tab 的 import 与调用点 |
| refactor | prd-api | 统一全站 ResolveBaseUrl：三个 Controller（`OfficialSkillsController` / `MarketplaceSkillsController` / `MarketplaceSkillsOpenApiController`）原本各自重复的 base URL 解析逻辑全部替换为 `HttpRequestExtensions.ResolveServerUrl(IConfiguration)`；`OfficialMarketplaceSkillInjector.BuildFindMapSkillsDto` / `BuildForkResponse` 增加接收 `HttpRequest + IConfiguration` 的重载，删除自家的 `ResolveBaseUrl` 方法，消除代码重复 + 对齐全站 header 优先级规则 |
| refactor | prd-api | 抽取共享常量 `PrdAgent.Core.Helpers.AgentScopeFormat.Pattern`：合并 `AgentApiKeysController.DynamicAgentScopePattern` 与 `AgentOpenEndpointsController.ScopePattern` 两份相同正则，避免未来"Endpoint 登记通过但 Key 创建失败"的 hidden schema drift |
| fix | prd-api | 官方虚拟技能条目 favorite/unfavorite 兜底：`MarketplaceSkillsController` 与 `MarketplaceSkillsOpenApiController` 的四个端点在 `OfficialMarketplaceSkillInjector.IsOfficialId(id)` 时直接返回未变化的虚拟 DTO（幂等 no-op），消除之前"点收藏返回 404 技能不存在"的困惑 UX |
| fix | prd-api | List 虚拟注入不超限：`MarketplaceSkillsController` / `MarketplaceSkillsOpenApiController` 的 List 端点在注入官方条目时，DB 查询预先 `Limit(resolvedLimit - 1)`，保证响应长度严格 ≤ 用户传入的 `limit`。修复 AI Agent 按 limit 分页时每页收到 `limit + 1` 条的 API 契约违反问题 |
| refactor | prd-admin | 「接入 AI」弹窗按日式极简广告原则重排视觉层级：一屏一个主 CTA。StartTab 去掉内嵌「开始」按钮（整张卡片可点）+ 辅助信息压缩为一行灰字足注 + 垂直居中让留白成为构图；CreateKeyTab 表单态与明文态的主按钮都放大为青蓝渐变全宽按钮，次要操作（只复制明文 / 下载技能包 / 返回列表 / 取消新建）全降为灰色文字链；KeysListTab 顶部保留"新建 Key"主按钮（同款渐变），「下载技能包」改为透明描边的幽灵按钮，避免两个同色按钮抢视线 |
| feat | prd-admin | 新增「演示视频」通用基础设施：`homepageAssetSlots.DEMO_VIDEO_SLOTS` 注册表 + `demoVideoSlot()` + `useDemoVideoUrl(id)` hook + AssetsManagePage 对应上传分区（复用 HomepageAsset 后端，无需建新集合）。任何模块只需 1 行登记 + 1 个 hook 就能在 UI 关键步骤嵌入实拍/录屏演示；未上传时前端自动回退静态占位卡，不阻断功能 |
| refactor | prd-admin | 「接入 AI」弹窗布局三处细节调整：StartTab 改为顶 / 中 / 底三段式（标题 + 两卡片 + 横版 3 步流程条）撑满 88vh 空间；CreateKeyTab 表单态 Key 名称默认随机生成（`接入 YYYY-MM-DD HH:MM · xxxx`）+ 旁边" 换一个"链接 + 删除「备注」字段；权限范围从纵向长条改为 2 列卡片选择器（icon + 标题 + 描述 + 右上圆勾）；明文展示态在 Key 与主 CTA 之间嵌入演示视频（autoplay muted loop）或"待上传"占位卡 |
| feat | prd-api | DailyTip seed 从 2 条扩展到 **5 条多步 Tour 全链路演示**,严格遵守「≥ 2 步」规则:<br>1) `defect-full-flow` 4 步(已有)<br>2) `shortcut-cmd-k` 2 步(已有)<br>3) **`shortcut-cmd-b` 2 步**:首页提示按 ⌘+B 唤起全局缺陷对话框<br>4) **`changelog-weekly` 2 步**:最新版本 → 按模块筛选<br>5) **`library-publish` 3 步**:上传文档 → 发布到智识殿堂 |
| feat | prd-admin | 补 3 个 `data-tour-id` 锚点配合新演示:`changelog-filter`(ChangelogPage 筛选栏)、`document-upload`(DocumentStorePage 上传按钮)、`document-store-publish`(DocumentStorePage 发布按钮) |
| refactor | .claude/skills | 技能 `create-tour-demo` 重命名为 `createzzdemo`(目录 + frontmatter + 文档内所有引用),用户"创建 XX 演示" / "/createzzdemo" 都能触发 |
| docs | doc | `design.daily-tips.md` 把技能名引用同步为 `createzzdemo` |
| fix | prd-admin | 教程小书**永远显示**:之前 `tips.length === 0 && !pinned` 会 return null 导致入口消失,改为始终渲染,空状态也能点开看到提示文案 |
| fix | prd-admin | 教程小书挪到 AppShell 通知铃铛**上方**(bottom 20+48+12=80),之前和 `AppShell.tsx:485` 的 toast notification 按钮位置完全重叠被压在下面;hidden 时右边缘留 28px 书脊,看得见也点得到 |
| fix | prd-admin | 推送降临自动展开按 **tip.id 集合**记忆,取代之前「session 内只弹一次」的死锁,管理员在同一 session 再推新 tip 也能再弹一次 |
| feat | prd-admin | dailyTipsStore 新增 60s 轮询 + visibilityChange 监听,标签页从隐藏变可见时立刻刷新;store.load 增加 `force` 参数区分首次加载与强制重拉,让管理员推送能在 1 分钟内到达用户 |
| feat | prd-admin | 新增 `components/daily-tips/TipCard.tsx` 共享教程卡片组件,借鉴文学创作锚点教程气泡样式(MapPin 图标 + emerald accent + 知道啦 CTA);支持 `bubble` / `card` 两种 variant、`ack` 模式(「知道啦」按钮)、自定义 accent / 图标 / 关闭 |
| refactor | prd-admin | `TipsDrawer` 抽屉内的每条 tip 改用 `TipCard` 组件渲染,视觉跟文学创作锚点教程统一;非定向 tip 默认绿色 accent,定向(isTargeted)用红紫 |
| refactor | prd-admin | `ArticleIllustrationEditorPage` 的「手动指定配图位置」锚点教程气泡改用 `TipCard` 组件,不再硬编码玻璃面板样式;彻底合并两个独立的教程 UI 实现 |
| feat | prd-admin | 悬浮组整体折叠:TipsDrawer 书图标 hover 时左侧出现「EyeOff」小把手,点一下把书 + AppShell 通知铃铛一起收到屏幕右边缘(只露半截 + 半透明);鼠标贴右下 140×200px 区域自动滑回,点任一按钮也召回 |
| feat | prd-admin | 新用户兜底自动弹:本 session 首次访问且有任意 tip 时,书自动展开一次抽屉,让用户第一次看到就知道是什么;用 `tipsBookFirstVisitShown` sessionStorage 记忆 |
| feat | prd-admin | AppShell 订阅 `floating-dock-collapsed-changed` 自定义事件 + `floatingDockCollapsed` sessionStorage,toast 通知按钮跟随折叠状态改变位置与透明度,两个悬浮按钮实现「整体折叠」联动 |
| fix | prd-admin | 教程抽屉改**轮播模式**:头部显示 `‹ 2/5 ›` 分页器,一次只渲染当前 tip 一张卡片;`maxHeight` 从 `calc(100vh - 180px)` 降到 `min(360px, calc(100vh - 180px))`,不再挡住页面其他内容 |
| feat | prd-admin | TipsDrawer 抽屉卡片新增**步骤提示徽章**:` N 步 · 跳转 → 高亮 → 点击`,让用户一眼看到教程深度 |
| fix | prd-admin | SpotlightOverlay 找不到目标元素时不再静默失败:6s 超时后显示**橙色友好失败卡片**,说明原因(当前页面还没数据 / 目标元素不可见)+ Selector + 「跳过这一步」+「关闭引导」两个按钮;解决「点 library-publish / changelog-weekly 跳转后没反应」的困惑 |
| perf | prd-admin | SpotlightOverlay 轮询频率 150ms × 50(7.5s)改成 250ms × 24(6s),tick 次数减半;TipsDrawer seen 上报从「一次性打全量 tips 的 N 条 API」改成「轮播切换时只打当前一条」,减少列表推送时的一次性 API 风暴 |
| fix | prd-admin | 撒花从屏幕中心改为**从用户刚点的按钮位置**喷出:SpotlightOverlay「完成 」按钮 onClick 读 `e.currentTarget.getBoundingClientRect()` 传给 `fireConfetti({ originX, originY })`,视觉位置跟用户操作一致 |
| feat | prd-api | seed 新增「大全套」演示 `showcase-all-features`(displayOrder=5,最靠前):跳 `/ai-toolbox` → autoAction.prefill 自动填「周报」→ 3 步 Tour(搜索框 → 首页搜索 → 命令面板 input),作为**回归测试锚点**,覆盖 scroll + prefill + 多步 + 最后撒花 4 大能力 |
| docs | .claude/skills | `createzzdemo` 触发词增加主推「**帮我创建一个小技巧 XX**」;工作流从 2 阶段扩为 **3 阶段**,新增「**阶段 3 立即演示**」章节,引导管理员入库后点 Play 按钮试播 + 最后一步点「完成 」验证撒花从按钮喷出 |
| feat | prd-admin | TipCard 布局重排:`[icon] [title] [tag]` 一行(title 溢出截断),body 和 CTA 另起新行,不再挤在一列 |
| feat | prd-admin | TipCard 新增 `onDismissForever` prop +  BellOff 按钮:点击永久关闭该 tip(和 X 本 session 关闭并列);TipsDrawer 调用新的 `/dismiss-forever` API |
| feat | prd-api | DailyTipsController 新增 `POST /api/daily-tips/{id}/dismiss-forever`:幂等往 `User.DismissedTipIds` 追加 id;`/visible` 端点新增过滤逻辑,包括 seed-* 兜底时也按这个排除 |
| feat | prd-api | User 模型新增 `DismissedTipIds: List<string>?` 字段记录用户永久不再提示的 tip id |
| fix | prd-admin | 点 tip CTA 跳转后不再自动关闭抽屉:用户需要边跟 Spotlight 引导边对照步骤 / 决定是否「不再提示」,抽屉保留打开由 5s 无 hover 定时器自然 collapse |
| feat | .claude/skills | 新增 `create-tour-demo` 技能:用户说「创建缺陷管理演示」等自然语言时,自动套用内置 5 种模板(缺陷管理全链路 / Ctrl+B / Ctrl+K / 周报 / 知识库发布)生成完整 DailyTip JSON + 多步 Tour autoAction,输出 curl 让用户一键植入;也支持自然语言自定义 |
| feat | prd-admin | TipsDrawer 重构成右下角悬浮书状态机:`collapsed`(默认显示书) / `expanded`(抽屉) / `hidden`(收到屏幕右边缘只露半截书脊) / `edge-peek`(鼠标贴右下 140px 区域时滑出),书图标改为 BookOpen,定位「教程总管」 |
| feat | prd-admin | TipsDrawer 抽屉头部新增「钉一下」(Pin / PinOff)按钮,锁定后小书永远完整显示、不会自动 collapse / hide;关闭按钮在非锁定时把书收到边缘,锁定时只关抽屉 |
| feat | prd-admin | TipsDrawer 推送降临(出现 isTargeted 定向 tip)时自动 expanded,5s 内用户无 hover/点击则自动 collapsed(徽章保留);pinned/hidden 状态用 sessionStorage 持久化(关闭标签页重置) |
| refactor | prd-admin | 小贴士后台 AutoActionEditor 改成「模板模式」:5 个引导模板分段控件(不引导 / 高亮 / 高亮+自动点击 / 高亮+预填 / 多步 Tour),选中后只显示该模板需要的字段,「高级配置」开关兜底完整字段(scroll / expand);大幅降低运营心智 |
| fix | prd-api | 修复「把你的知识发布到智识殿堂」演示跑不起来:旧 seed 的 Step 1-3 selector 都是空间**详情页**的元素(`document-upload` / `document-store-publish`),但 actionUrl=`/document-store` 是**列表页**。用户跳转到列表页后找不到详情页的 upload 按钮,显示橙色失败卡片。<br>修复:改成 2 步,都用列表页稳定元素 `document-store-create`(新建空间按钮),Step 2 用文字指导"打开空间后怎么用";不再依赖无法预测的空间详情页 URL |
| feat | prd-admin | DocumentStorePage 列表页「+ 新建空间」按钮补 `data-tour-id="document-store-create"` 锚点 |
| feat | prd-admin | SpotlightOverlay 在「等待元素」的 6 秒内不再啥都不显示:右下角弹出**蓝色「正在定位第 X / N 步…」** 的胶囊 toast(带 Sparkles 旋转图标),rect 找到就自动消失切到真 spotlight,6s 超时则切到橙色失败卡片。避免用户点跳转后以为"没反应" |
| refactor | prd-admin | 小技巧列表按 `/ui-ux-pro-max` 技能「Data-Dense Dashboard」建议重新设计,修复 4 处视觉问题:<br>1) **列间留白** — 去掉 `order=#N ml-auto` 导致的中间留白;#N 现在贴右列按钮 minWidth:24 right-align<br>2) **chips 挤一行** — 场景类型改为**左侧 34×34 小色块 + icon**(代替一整个 pill chip),空间感立刻出来;其余 meta(步数/kind/已关闭/为你)改成**行内 `·` 分隔 mono 文字**,紧凑不占 chip 位<br>3) **body 短卡高** — 卡片高度**完全由内容决定**:单行 title + 单行 meta ≈ 58px;有 body 时拼在 meta 行前,`· → /url` 兜底;全部 `whiteSpace: nowrap + ellipsis`<br>4) **操作按钮 opacity 60** — 去掉 `opacity-60 group-hover:opacity-100`,按钮始终 100% 可见<br>其他:圆角 16→14、padding 14×16→12×14、选中态 gradient→纯色背景 + 紫色边框(不浮夸)、hover 只换 background/border 不变 transform(稳定无跳动) |
| feat | prd-api | `DailyTipTourStep` 新增 `NavigateTo?: string` 字段:每一步可独立 navigate 切路由,支持真正的跨页 Tour。`NormalizeAutoAction` / `TipUpsertRequest` 同步 |
| feat | prd-admin | `SpotlightOverlay` 在「下一步」前检测 `nextStep.navigateTo`,有则 `useNavigate(navigateTo)` 切路由再 poll selector。失败卡片上的「跳过这一步」也同样生效 |
| feat | prd-api | 大全套 `showcase-all-features` seed 扩到 **11 步跨页面 Tour**:预填百宝箱搜索 → 首页 → 海鲜市场 → 智识殿堂 → 文档空间 → 更新中心(2 步)→ 周报 → 缺陷 → 涌现 → 回首页撒花。一次验证 scroll + prefill + 跨路由 + 按钮位撒花所有能力 |
| feat | prd-api | `TipUpsertRequest.SourceType` 字段落入 Create / Update 路径,默认 `manual`;前端 `DailyTipUpsert` 同步 |
| feat | prd-admin | 小技巧管理页新增**多选 + 批量推送**:每行左侧圆形 checkbox、顶部全选 chip、选中后浮现紫色批量操作栏(选用户 / 按角色 / 全体一键推);用户下次轮询立即收到。支持一次对 N 条 tip 执行 push |
| feat | prd-admin | 新增**场景分类** `SourceType` 下拉(新功能 / 技巧 / 缺陷修复 / 新手教程 / 手建);列表每条卡片显示彩色场景 chip(带图标 Rocket/Lightbulb/Wrench/Sparkles/Pencil),取代原本单色 `order=N` 标签 |
| refactor | prd-admin | 小技巧列表重新设计为**苹果风**:卡片圆角 12 → 16、内边距 14×16、hover `translateY(-1)` 微动、chip 全部改为 pill 形(圆角 999),移除死板的 `#N` 标签(移到右上角作为 mono 小字)。选中态走 gradient + 紫色阴影 |
| docs | .claude/skills | `createzzdemo` 技能补 `navigateTo` 跨页能力说明 + SourceType 场景分类必问项 |
| fix | prd-admin | 修复「播放按钮跑不了」bug:AppShell 里 `<SpotlightOverlay key={location.pathname} />` 让每次路由切换 unmount 组件,Play 流程中 navigate 前 Overlay 已消费清理 sessionStorage,navigate 后新 Overlay 再读就是空的。改为单例,`readAndStart()` 在事件/mount 时重置 state |
| feat | prd-admin | Ctrl+K 2 步 Tour 加入 seed(home-search 唤起 → command-palette-input 输入);CommandPalette 的 input 补 `data-tour-id="command-palette-input"` 锚点 |
| feat | prd-api | AdminDailyTips `/push` 端点支持 `scope` 参数:`all` 或 `role:PM/DEV/QA/ADMIN`,后端按 UserStatus=Active 展开 userIds,与手动选的取并集。解决「没法一键群发」缺口 |
| feat | prd-admin | PushDialog 新增「批量推送(按范围)」分区:一排按钮一键推给全体 / PM / DEV / QA / ADMIN,带 `window.confirm` 二次确认避免误触 |
| feat | .claude/skills | `create-tour-demo` 技能 description 加「增加教程 / 增加引导」触发词;执行流程第 3 步强制产出「打断风险分析」(步骤清单 + 可能被打断的节点 + 缓解方案),让 AI 主动告诉用户哪些步可能卡住 |
| docs | doc | 新增 `doc/design.daily-tips.md` 原理文档(11 节,含产品定位 / 用户场景 / 数据模型 / 组件拓扑 / 引导动作流水线 / 架构决策 / 接口设计 / 扩展指南 / 已知约束);同步更新 `doc/index.yml` + `doc/guide.list.directory.md` |
| feat | prd-admin | TipsDrawer 抽屉**每次打开随机选一条 tip** 展示,避免用户停留在固定 index 看同一条;若当前页面 URL 匹配某条 tip 的 actionUrl(完整匹配 / 路径前缀),优先选它 |
| feat | prd-admin | 当前页面有匹配 tip 时,右下角小书图标**红色脉冲**(`tipsBookPulse` 2s 呼吸 + 红色 drop-shadow),提示用户「这页有教程」 |
| feat | prd-admin | 新增 `components/daily-tips/fireConfetti.ts` 轻量撒花工具:emoji + CSS animation,~80 行,无第三方库,尊重 `prefers-reduced-motion` |
| feat | prd-admin | SpotlightOverlay 多步 Tour 走到最后一步,点「完成 」按钮:撒花 + 调用 `dismissTipForever(tip.id)` 永久不再提示;单步模式仅显示「知道了」不撒花。`SpotlightActionPayload` 新增 `id` 字段透传,seed-* id 自动跳过 |
| docs | doc | 新增 `doc/plan.daily-tips-scenarios-and-staleness.md`(交接文档,1.5 人天):**阶段 A** 三场景统一(SourceType 规范化 + 缺陷修复闭环回执 + 管理界面分类)、**阶段 B** 过时检测自动化(锚点扫描 + 90 天低参与度 + 后台 IHostedService 每天扫描 + 管理界面批量清理);同步 `doc/index.yml` |
| fix | prd-admin | 撒花特效从 emoji + CSS animation 改为**真 canvas 粒子动画**:复用 `SuccessConfettiButton` 的 `initBurst` + `startRender` 算法(28 个 confetto + 14 个 sequin,紫蓝色系,DPR 适配,gravity/drag/terminalVelocity 物理参数 100% 对齐),从屏幕底部 75% 位置往上喷;粒子全落出视口自动清理,5s 兜底 timer 防卡死。`fireConfetti(opts)` 接受可选 `originX/Y/count` 参数 |
| refactor | prd-api | 删除 `shortcut-cmd-k` / `shortcut-cmd-b` 两条 seed。键盘快捷键是 Figma/VSCode 式"任意页面可用"的全局能力,强制跳到首页演示反直觉;Ctrl+B/K 应走静态 key-hint(UI 挂 `⌘+K` 提示)而非多步 Tour |
| fix | prd-admin | `changelog-latest` 锚点 bug:原实现 `releaseIdx === 0` 在第一个 release 被 matchFilter 过滤为 null 时锚点跟着消失,导致更新中心演示 6s 超时。改用闭包 `firstVisibleAssigned` 标志,确保锚点落在**第一个实际渲染的 release** |
| fix | prd-admin | SpotlightOverlay 超时阈值 6s → 10s(250ms × 40),给慢服务器 + 慢网络 + 懒加载页面余地;用户实测线上服务器慢会触发 changelog 假超时 |
| feat | prd-api | 用户永久 dismiss 按 **SourceId + Id 双维度存**,`/visible` 按双维度过滤。管理员「清空并重建」后 tip.Id 变但 SourceId 不变,用户点完过的 seed 重建后不再骚扰;解决「重建打扰已完成用户」问题。`seed-{x}` 式 id 自动 extract x 一并存入 |
| feat | .claude/skills | `createzzdemo` 技能升级为**两阶段工作流**:(1) 枚举 A-F 6 类候选步骤让用户挑组合,(2) 按选中输出 JSON。新增**角色智能推荐表**(PM/DEV/QA/ADMIN 各自刚需的教程清单),支持 `targetRoles` 定向;明确标注"键盘快捷键不适合本技能" |
| docs | doc | `design.daily-tips.md` §11 补键盘快捷键 / SourceId dismiss 约束;§12 新增跨版本更新通知策略(待实现)。`plan.daily-tips-scenarios-and-staleness.md` 增加**阶段 C**:Version 机制(DailyTip.Version + User.DismissedTipKeys 结构化)+ §9 已落地/未完成清单,工时 1.5 → 2 人天 |
| fix | prd-admin | 在落地页同 URL 点 tip CTA 没反应:`navigate('/defect-agent')` 同路由 React Router 不 re-mount 导致 SpotlightOverlay 不重读 sessionStorage。`writeSpotlightPayload` 写完后广播 `spotlight-payload-updated` CustomEvent,SpotlightOverlay 监听后立即重读 + 重启 |
| fix | prd-admin | 多步 Tour 点「下一步」面板瞬间消失:旧逻辑会 `setRect(null)` 然后等 3s 找新 selector,modal 还没打开就超时。修复:点「下一步」时先帮用户 `click()` 当前 step 的可交互元素(按钮/链接),再前进;同时**保留旧 rect**,光圈停在原处直到新元素出现,无闪烁 |
| fix | prd-admin | SpotlightOverlay 选择器轮询上限从 3s 提到 8s(150ms × 50),覆盖大部分 modal / 面板异步打开场景 |
| refactor | prd-api | DailyTip seed 进一步精简到只保留 `defect-full-flow`(4 步全链路);删除 `report-agent`(1 步)和 `toolbox`(0 步,只 prefill),严格遵守用户规则「单步 tip 不需要教学」。其他多步演示由管理员通过 `/create-tour-demo` 技能按需生成 |
| feat | prd-api | AdminDailyTips 新增 `POST /api/admin/daily-tips/reset`:删除全部 DailyTip + 用 BuildDefaultTips 重新植入,用于 seed 规则迭代后一次性同步;返回 `deletedCount/insertedCount` |
| feat | prd-admin | DailyTipsEditor 工具栏新增「清空并重建」按钮(RotateCcw 图标),点击触发后端 `/reset`;前端 confirm 二次确认避免误操作 |
| fix | prd-admin | 点教程小书或展开抽屉时立刻 `load({force:true})`,不再等 60s 轮询;管理员推送后用户下一次点书就能看到新 tip,修复「推送了还是 3」的延迟感 |
| refactor | prd-api | 精简 DailyTip seed:删掉 5 条只有单步 scroll 的短 tip(search/marketplace/library/updates/emergence);保留 3 条真流程(defect 4 步全链路 / report 多步 / toolbox prefill),让 seed 每条都是「完整演示」 |
| feat | prd-api | DailyTip `defect-full-flow` seed 扩展成 4 步 Tour:打开提交面板 → 写标题+描述 → 选负责人 → 点提交;对应前端 DefectSubmitPanel 新增 `defect-description / defect-assignee-picker / defect-submit` 3 个 data-tour-id 锚点 |
| feat | prd-admin | DailyTipsEditor 每条 tip 操作栏新增 `Play` 试播按钮:不走推送,直接在当前账号触发一次 `writeSpotlightPayload + navigate`,管理员保存后立刻看效果,消除「改完不知道对不对」的焦虑 |
| feat | prd-admin | PushDialog 新增「推给我自己」快捷按钮:一键把 tip 推给当前登录账号,每次重置 delivery 状态方便反复测;补齐管理员端到端自测闭环 |
| docs | .claude/skills | `create-tour-demo/SKILL.md` 补「和 CDS Bridge 联动」章节:说明 bridge 的 snapshot/click/type 动作词表和我方 autoAction 同源,可用 bridge 录制再导出成 `autoAction.steps`;强调借鉴不合并,保持两套数据结构独立 |
| feat | prd-api | 新增 WeeklyPosterAnnouncement 模型与 /api/weekly-posters 接口，支持周报海报草稿/发布流 |
| feat | prd-admin | 登录后主页新增周报海报轮播弹窗（WeeklyPosterModal），末页 CTA 跳转完整周报；session 内关闭不再弹出 |
| feat | prd-admin | 百宝箱新增「周报海报编辑器」（wip 施工中），支持多页编辑、配图提示词一键复制跳转视觉创作 |
| docs | skills | weekly-update-summary 技能新增 Phase 8「海报化」+ reference/poster-pages.md 规则 |
| feat | prd-api | 周报海报新增 AI 向导后端：PosterTemplateRegistry 4 模板 + PosterAutopilotService 读数据源+结构化 JSON，新增 /autopilot /templates /pages/:order/generate-image 三个端点 |
| feat | prd-admin | 百宝箱「AI 周报海报工坊」向导页：选模板+数据源+点一次 → autopilot 自动写文字 + 并发生图 + 预览 + 发布；原编辑器移至 /weekly-poster/advanced 做高级模式 |
| docs | skills | weekly-update-summary Phase 8 重写为「引导用户去工坊」，减少技能手工调 API 的冗余步骤 |
| fix | prd-api | AppCallerRegistry 补齐 ReportAgent.WeeklyPoster 子类（Autopilot/Image 两个常量），修复「appCallerCode 未注册」错误 |
| test | prd-api | 新增 AppCallerCodeRegistryGuardTests：CI 扫描源码中所有 AppCallerCode 字面量，缺失注册即失败（彻底堵住同类 bug） |
| refactor | prd-admin | AI 周报海报工坊换皮：全页改用系统 Surface System（.surface 液态玻璃），去掉过饱和紫色渐变与强光晕，减少 AI 生成仪表盘风观感 |
| feat | prd-api | 周报海报新增 SSE 流 `/autopilot/stream` — 逐阶段推送 phase/source/model/page/done 事件，替代一口气 10s+ 的同步调用；扩展 4 种数据源（changelog / github-commits / knowledge-base / freeform）+ 新增 `/knowledge-entries` 文档选择接口 |
| feat | prd-admin | AI 海报工坊改名去「周报」绑定；向导页接入 useSseStream，生成过程实时滚动阶段文案 + 模型 chip + 页面卡逐张 fade-in 材质化，彻底消除 10s 空白等待；新增 GitHub 最近提交与知识库文档两个数据源入口 |
| fix | prd-admin | 向导预览弹窗一闪而过 bug — 重构 WeeklyPosterModal 为无状态 PosterCarousel 组件（props 驱动），去掉 store.subscribe 副作用导致的立即关闭；主页用 WeeklyPosterModal 薄封装复用 |
| fix | prd-admin | 高级编辑器页顶部加「← 返回工坊」按钮，解决从工坊跳过来回不去的问题 |
| feat | prd-api | 海报工坊真·LLM 流式：PosterAutopilotService 暴露 StreamLlmChunksAsync(IAsyncEnumerable) + ParseAccumulatedContent；Controller 在 /autopilot/stream 内逐 chunk 透传 model/chunk/thinking 事件给前端 |
| feat | prd-admin | 向导页打字机面板：订阅 chunk SSE 事件实时拼接 typingText，按钮下方渲染终端风滚动输出（mono + 字数 ticker + 闪烁光标），LLM 写文案 5-15s 期间用户能看到 AI 一字一字吐出来，彻底履行 CLAUDE.md #6「禁止空白等待」 |
| refactor | prd-api | 海报 LLM 输出改 Markdown 分段（`## Page N · 标题 · #色` + 正文 + `[IMG] prompt`）替代 JSON，对 LLM 更友好 + 可流式增量解析 + 支持 markdown 预览；ExtractClosedPagesSoFar 在每次 chunk 到达后提取新闭合 page 立即 emit，卡片逐张冒出不再等整坨完成 |
| feat | prd-admin | 预览弹窗 body 改用 MarkdownContent 组件渲染（支持 **加粗**/列表/表格/代码块），正文视觉效果升级 |
| fix | prd-admin | 向导结果区 poster.pages 访问加 `?? []` 守卫 + ResultPageCard key 降级 fallback，修复「Cannot read properties of undefined (reading 'length')」运行时错误与 React key 警告 |
| feat | prd-admin | 海报工坊服务器权威化:用户选择(templateKey/sourceType/kbEntryId/freeformContent) + 当前草稿 posterId 都写 sessionStorage,刷新页面自动从后端 getWeeklyPoster 恢复,草稿不再丢 |
| refactor | prd-admin | 海报工坊从「百宝箱」移除,改挂到「我的资源 → 海报设计」tab(资源产物的归属更合理);资源管理页新增 PosterDesignSection 列出所有海报,卡片点击回工坊继续编辑,支持撤回/删除 |
| feat | prd-admin | 「我的资源 → 海报设计」改为三栏设计器内嵌渲染：左侧海报列表/新建 modal，中间图文页编辑与上传/粘贴/AI 重生图，右侧 Markdown 文案与 CTA 自动保存；/weekly-poster 深链同步指向新设计器，旧向导保留在 /weekly-poster/wizard |
| fix | prd-admin | 登录态持久化从 sessionStorage 切到 localStorage，并增加旧登录态迁移；同一预览域名下新开标签页/重新打开后台地址不再重复登录（跨子域 SSO 仍待 CDS 支持） |


## [1.8.3] - 2026-04-20

> **用户更新项**
> - 更新中心「周报」tab 支持多来源（全员可加/改/删），mermaid 代码块自动渲染成图
> - 历史发布条目加 icon、等宽字体时间、秒级 GitHub commit 时间
> - CDS 多项目 + GitHub Webhook 自动部署；push 即预览，预览就绪三层兜底消灭 502
> - 视觉创作、视频 Agent、涌现探索器、文档空间、PR 审查工作台 V2、缺陷分享外部 Agent 等主线持续推进

<!-- 以下两个日期块（2026-04-20 / 2026-03-28）原应在 1.8.3 发版时随 release-prepare 合并，但 1.8.3 发版时未跑 assemble-changelog；W19 周报技能（2026-05-09）补登记时无差别归集到 [未发布]，被 codex review (#549) 指出错位风险（next release-prepare 会把这部分已发版内容当成新版本再发一遍）。已于 2026-05-09 移到此处归位。-->

### 2026-04-20 (补登记 2026-05-09 — 1.8.3 发版漏合并)

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | UserPreferences 新增 AgentSwitcherPreferences（pinnedIds / recentVisits / usageCounts）+ PUT /api/dashboard/user-preferences/agent-switcher 端点，命令面板置顶 / 最近 / 常用改为云端同步 |
| feat | prd-admin | agentSwitcherStore 新增 loadFromServer + flushToServer + resetServerSync，mutation 后 800ms debounce 自动回写；AppShell 登录后拉取、登出时重置。换分支 / 浏览器不再丢数据 |
| feat | prd-admin | 文章配图标记新增"位置策略"选择器：自动 / 每大标题一张 / 每小标题一张 / 尊重用户锚点（文章内 `[IMG]` 占位符） |
| feat | prd-admin | 文章编辑阶段新增段落 gutter 加锚点 + 段落右键菜单「在上方/下方插入配图」 + 相邻锚点绿色边框视觉反馈 |
| feat | prd-admin | 首次进入文章配图编辑页时展示锚点教程气泡，每账户一次，点「知道啦」后永不再弹 |
| feat | prd-api | `LiteraryAgentPreferences` 新增 `AnchorTutorialSeen` 字段，记录配图锚点教程是否已看过 |
| feat | prd-admin | 位置策略切换到「尊重用户锚点」时若当前不在「预览」tab，自动跳过去便于打锚点；切到「每大/小标题」时 toast 引导 |
| feat | prd-admin | 「预览」页按策略展示同尺寸配图占位（1:1 dashed box），锚点和 per-h1/per-h2 策略都能看到"配图会落到这里"的直观反馈 |
| feat | prd-admin | 「尊重用户锚点」启用但还没打锚点时，预览页顶部出现脉冲引导横幅，明确告知如何打点 |
| fix | prd-admin | 配图位置策略的大/小标题检测改为自适应：扫全文取所有 heading 中最小 level 当"大标题"，解决整篇 `##` 或整篇 `###` 的文章无法匹配的问题 |
| docs | doc/design.literary-agent.md | 新增"配图位置策略——手动干预原理"章节，完整记录 4 档策略、自适应标题判定、3 种锚点打点路径、框框反应视觉约定、教程持久化 |
| fix | prd-api | ChangelogReader 的 commit 时间归属逻辑改为「近似向后匹配」：按 CN(UTC+8) 计算 commit 的日期，为每个 ### YYYY-MM-DD 段找「首个 commit.cnDate >= 段日期」的 commit。解决历史 CHANGELOG 段日期和 commit 日期几乎从不相等、导致秒级时间永远不生效的问题 |
| feat | prd-admin | 历史发布条目接入 NEW 徽章（复用更新中心 lastSeenAt 的 cutoff）：entry.commitTimeUtc > endOfDay(lastSeenAt) 时在行首展示绿色 NEW，位置在类型徽章之前 |
| feat | cds | 新增可自定义 GitHub PR 预览评论模板（/api/comment-template + Settings 面板「评论模板」Tab），支持 {{branch}}/{{previewUrl}}/{{prUrl}}/{{prReviewUrl}} 等 9 个动态变量；{{prReviewUrl}} 从当前分支预览地址自动拼接 /pr-review 路径，无需配置独立域名 |
| feat | prd-admin | PR 审查页支持深链自动发起审查（?prUrl=&autoStart=1），配合 CDS 默认模板的 {{prReviewUrl}} 实现从 GitHub 评论一键跳转 + 自动添加 PR |
| fix | prd-admin | PR 审查深链去重等列表加载完成后再判定，避免空列表漏判导致的"自动发起失败"误报 |
| fix | cds | {{dashboardUrl}} webhook 与 preview 共用 buildDashboardUrl，publicBaseUrl 为空时统一返回空串，不再产生悬挂相对路径 |
| feat | prd-desktop | 文档右键菜单扩展：主文档新增"更换 PRD"，资料文档新增"替换文件"+"删除"（自研 ConfirmDialog 二次确认）|
| feat | prd-desktop | 更新通知弹窗新增"最近更新"列表，展示最近 1 个月 prd-desktop 条目（≥3 条），可展开查看全部 |
| chore | scripts | 新增 build-recent-updates.mjs：从 CHANGELOG.md 生成 recent-updates.json 供桌面端读取，绑定到 dev/build/tauri:dev/tauri:build pre-hook |
| fix | prd-admin | 更新中心 + 周报 tab 底部留白修复：根容器 `h-full min-h-0 flex flex-col`，去掉 `calc(100vh - 160px)` 魔数，走 flex 链撑满视口 |
| rule | doc | 新增 `.claude/rules/full-height-layout.md`：宽屏页面必须撑满视口可用高度，禁止魔数高度，滚动发生在最近内容层（5 条硬约束 + 5 类反面案例）|
| feat | prd-api | 新增海鲜市场「技能」板块后端：MarketplaceSkill Model + marketplace_skills 集合 + MarketplaceSkillsController（zip 上传/列表/标签/下载/收藏/删除），SKILL.md 自动走 LLM 生成 30 字摘要 |
| feat | prd-admin | 海鲜市场新增「技能」Tab：卡片式海报预览 + 按标签筛选 + 上传技能弹窗（zip 拖拽 + 标题/详情/emoji/标签，全部可空走兜底） |
| feat | prd-admin | 自定义 → 资源管理 新增「海鲜市场背景」Tab，可上传整页大气海报（默认深海蓝渐变兜底） |
| feat | prd-api | 海鲜市场新增 `GET /api/marketplace/skills/favorites` 端点，返回当前用户收藏的技能列表 |
| feat | prd-admin | 我的空间 banner 下新增「我收藏的技能」区块：一键下载 / 取消收藏 / 跳去海鲜市场 |
| refactor | prd-admin | 用户菜单：把「我的空间」上移到顶部入口，删除原「账户管理」入口；SettingsPage 新增「账户管理」Tab 承载头像替换与账户信息 |
| fix | prd-desktop | 修复 PRD 预览中 Word 转换产生的 base64 图片不显示的问题（react-markdown 默认 urlTransform 会剥离 data:image 协议）；空 src 与加载失败时降级为可见占位提示 |
| feat | prd-api | 新增 PATCH /api/v1/documents/{id}/title 重命名接口（复用 groupId/sessionId 双通道鉴权） |
| feat | prd-desktop | 知识库文档支持重命名：侧边栏与知识库管理页右键弹自定义菜单（暂只含"重命名"），点击后弹自研模态窗（ui-glass-modal + createPortal）完成改名，全程不使用浏览器原生 prompt/alert |
| fix | prd-admin | 修复周报 Agent「团队周报」从详情页返回时周次/团队/视角被重置为当前周的问题（改用 URL search params 做 SSOT） |
| feat | prd-admin | 周报 Agent 详情页新增左侧本周成员列表，支持在不返回列表的情况下高效切换查看同团队同周的其他周报 |
| feat | prd-api | 周报评论新增编辑接口 PUT /reports/:id/comments/:commentId，作者或管理员可改 |
| feat | prd-admin | 周报评论支持作者/管理员直接编辑（悬停笔形图标内联改、⌘↩ 保存、已编辑角标） |
| fix | prd-api | 修复周报模板管理严重的数据隔离缺陷：列表/详情按可见性过滤（系统 ∪ 自己 ∪ 所在团队），更新/删除强制作者权属校验；系统模板不可修改 |
| feat | prd-api | 周报模板"默认"概念拆解：IsDefault 仅保留系统级语义，新增个人偏好集合 user_report_template_preferences + GET/PUT/DELETE my-default 接口；seed 接口支持一键迁移历史 IsDefault=true 到对应用户偏好 |
| feat | prd-admin | 周报模板管理 UI 重做：scope 徽章（系统/我创建/团队/其他）、创建人展示、非作者隐藏编辑删除、每卡片"设为我的默认"、新建周报时自动预填个人默认模板 |
| feat | prd-api | 周报模板支持多团队关联 + 团队默认：ReportTemplate 新增 TeamIds / DefaultForTeamIds；一个团队全局只能被一个模板关联（写入时静默接管）；新增 GET /templates/team-default?teamId=X；seed 接口叠加单字段 TeamId → 多字段迁移 |
| fix | prd-api | 模板管理权限收窄：只有任一团队的 Leader/Deputy 可创建/修改/删除；系统权限 ReportAgentTemplateManage 不再提供跨团队后门；系统模板不可改 |
| feat | prd-admin | 模板管理入口收窄：SettingsPanel 对非 Leader/Deputy 隐藏"模板管理"菜单；Dialog 改为多团队多选 chips + 每团队星标切换为该团队默认；新建周报时选团队后联动拉取团队默认模板（优先级：团队默认 > 我的默认 > 系统默认） |
| feat | prd-api | 周报模板编辑/删除放宽：关联团队的 Leader/Deputy 也可操作，不再限作者本人 |
| feat | prd-admin | 模板卡片编辑/删除按钮对关联团队的 Leader/Deputy 同样显示 |
| feat | prd-api | review-agent 新增「全局规则检查清单」默认评审维度（权重 30%，18 项检查点覆盖安全/权限/组件/业务/边界/数据），配合等比下调 7 项原维度使总分维持 100 |
| feat | prd-admin | review-agent 评审结果页按分类渲染清单表格（不涉及/已包含/涉及·缺失三态），维度配置弹窗新增「插入全局规则清单模板」快捷入口与清单检查项只读预览 |
| refactor | prd-api | 全局规则检查清单语义修正：LLM 不再自己判断涉及/包含，而是读取用户在方案表格里的实际勾选（involvedChecked/coverageChecked），「涉及=是 且 包含=是」时再做反作弊正文核查（solutionFound），最终 passed 由系统按 truth table 派生 |
| refactor | prd-admin | 评审结果清单表格改为四列「检查项 / 是否涉及 / 方案是否包含 / 评审判定」，分别展示用户勾选与系统判定，失败原因细分（未勾选/涉及未声明/自认未包含/勾了但找不到） |
| perf | prd-admin | 周报 tab 合并上两行：来源 chip 栏 + 添加按钮挪进 TabBar 的 actions 槽（与「更新中心/周报」同一行），删除冗余的 LIVE 信息条（知识库名/关键词通过「周报列表」header 的 tooltip + chip 悬停查看） |
| refactor | prd-admin | 抽出 WeeklyReportSourcesProvider Context（sources / activeId / stores / CRUD handlers 统一管理），供 TabBar actions 与 WeeklyReportsTab 共享；页面从 3 行压缩为 1 行顶栏 + 主体 |
| perf | prd-admin | 周报文件列表展示优化：不再显示 `spec.xxx.md` 文件名，而是懒加载文档内容抽出首个 H1 / H2 或首行有效文本作为列表标题（最长 80 字符），文件名收进 tooltip；并发 6，切换来源时清缓存 |
| fix | prd-admin | 周报 NEW 徽章逻辑改为「以上次打开更新中心那一天的 23:59:59 为 cutoff」：条目更新时间严格晚于 cutoff 才标 NEW；首次进入（lastSeenAt 为 null）一律不标。mount 时冻结 cutoff，不受当次 markAsSeen 影响 |
| perf | prd-admin | 周报 tab 启用液态玻璃：来源 chip 栏 + LIVE 信息条走 glassBar，主两栏容器走 glassPanel，与更新中心视觉权重对齐，不再「太暗」 |

### 2026-03-28 (补登记 2026-05-09 — 1.8.3 发版前的旧碎片)

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 新增「产品专业委员会月报」工作流模板：TAPD需求分析+产品缺陷分析+月度巡检+专项整改，4章节合一，AI自动生成分析与启发 |

### 2026-04-20

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | ChangelogReader 拉取 CHANGELOG.md 的 GitHub commit 历史（单次 commits API 调用），按日期聚合，给每个 day 块附上该日最晚一次 commit 的秒级 UTC 时间 |
| feat | prd-api | ChangelogDayDto 新增 commitTimeUtc 字段（ISO 8601），供前端渲染秒级时间 |
| perf | prd-admin | 筛选 chip 增加图标（feat→Sparkles、fix→Wrench、perf→Gauge 等 11 类），条目内模块/类型徽章同步带 icon 更易识别 |
| perf | prd-admin | 条目右侧时间升级为 "YYYY-MM-DD HH:mm:ss"（基于 GitHub commit 时间，tabular-nums 等宽），降级到纯日期时保留 tooltip 说明 |
| perf | prd-admin | 更新中心历史发布行字号放大：类型徽章 12px、模块胶囊 12px tabular-nums、日期头 13px 胶囊化；条目右侧新增提交日期（tabular-nums）；描述过长 truncate 不再挤掉右侧时间 |
| feat | prd-api | 新增 ChangelogReportSource 模型 + changelog_report_sources 集合 + /api/changelog/sources CRUD API，周报来源配置全员共享 |
| feat | prd-admin | 周报 tab 重构为多来源模型：支持全员添加/编辑/删除，从数据库加载，替代原来只在 sessionStorage 里每人各自保存的设置 |
| feat | prd-admin | 新增 MermaidDiagram 组件（懒加载 mermaid 主包），MarkdownContent 对 mermaid 代码块自动渲染图表，不再暴露源码 |
| refactor | prd-admin | 更新中心移除「本周更新」冗余 section，保留历史发布；周报改由「map周报」tab 承载 |
| perf | prd-admin | 周报来源选择采用 chip 栏 + hover 内联编辑/删除，视觉与 Surface System 对齐 |
| refactor | prd-admin | 更新中心顶部 tab「map周报」改名为「周报」，去掉 map 前缀更通用 |
| chore | doc | scripts/assemble-changelog.sh 合并 203 个碎片到 [未发布]，按日期去重（2026-03-22 / 03-28 / 03-29 重复头消除） |

### 2026-04-19

| 类型 | 模块 | 描述 |
|------|------|------|
| chore | rules | 新增 `.claude/rules/cds-auto-deploy.md` — 明确 push 即部署的知识: 对已 link GitHub 的项目不再提示用户手动跑 `/cds-deploy-pipeline`,交付文案用"commit 已推送,CDS 收到 webhook 后几分钟内 `<url>` 就位"替代旧的"需要真人在预览域名验收(我这边无法)"。`CLAUDE.md` 架构规则索引同步补一行;`codebase-snapshot.md` 追加 PR #450 后状态条目 |
| feat | cds | 分支卡标题 icon 按来源区分: 手工添加分支走原 git-branch icon,GitHub webhook 自动触发的分支(`branch.githubRepoFullName` 非空)走 GitHub Octocat icon,tooltip 注明"来自 <org/repo>",一眼分辨"手工加 vs 自动建"。commit SHA chip 去掉重复的 GitHub logo 变纯 hash(tooltip 仍然标注来源),避免两处重复 |
| feat | cds | 新增 `ICON.githubMark` 到 app.js ICON 注册表 + `.branch-name svg.gh-branch-mark` CSS (dark / light 两版颜色) — 紫色调提示"GitHub 源"并与普通分支保持一致占位宽度,标题行布局不抖 |
| fix | cds | Bugbot #450 第六轮 LOW: handleCheckRun 补 head_sha 格式校验(与 handlePush 一致) — malformed SHA 在 updateBranchGithubMeta + .slice() 路径会炸 |
| feat | cds | 分支卡片 chip 布局重构 — github chip(去 "from GitHub" 文字只留图标+7位 SHA)、端口 chips、pinned 历史提交 chip 合并到同一行 branch-card-chips flex wrap,所有分支卡片高度/结构从此一致 |
| feat | cds | 分支列表页改用 CSS column-count 瀑布流布局,消除网格行高对齐造成的视觉空洞(不同卡片 tag/徽章数量差异导致的断层) |
| fix | cds | 项目列表卡片 GitHub chip 渲染为大蓝圆修复: 原本是 `<a>` 嵌套在 `<a class="cds-project-card">` 里 (HTML 非法),浏览器自动关外层 `<a>` 导致布局崩。改用 `<span onclick>` 打开新窗口 |
| fix | cds | 高危: webhook branchName 和 commitSha 接入 shell 前强制校验(HIGH + MEDIUM) — isSafeGitRef 严格白名单 `[A-Za-z0-9._/-]` + 长度/`..`/尾字符检查;commit SHA 必须 7-40 hex。覆盖 push/PR/delete/self-update/self-force-sync 5 个注入面 |
| fix | cds | defaultLocalhostDeploy 把 commitSha 透传到 /deploy body (MEDIUM),并行 push 之间的 entry.githubCommitSha 竞态因此消除。deploy 路由按「body → entry → worktree HEAD」三级回退 |
| fix | cds | 删 shouldDispatchDeploy / renderGithubBadge 两个死代码(LOW),清理重复注释 |
| feat | cds | CheckRunRunner.reconcileOrphans(): CDS 启动时扫描所有带 checkRunId 但不在 building 的分支,PATCH 到 conclusion=neutral + 清 id,修复 self-update/restart 打断后 GitHub commit 常年「准备状态」的 bug |
| feat | cds | 新增 POST /api/github/webhook/self-test 自测端点: 传 {eventName, payload} 直跑 dispatcher,返回「如果真实 webhook 这么来」会触发什么 side-effect。用于确认 Issue comment 事件是不是真到达 CDS,无需 GitHub 真实发送 |
| feat | cds | 项目 Settings → GitHub 标签页新增"GitHub 自动部署 (Check Runs)"区块:可视化展示 App 配置状态、一键跳转 GitHub 安装/管理、当前项目绑定卡片、自动部署开关 |
| feat | cds | 「绑定 GitHub 仓库」引导式 modal:选 installation → 选仓库 → autoDeploy checkbox → 确认绑定,全程无 curl |
| feat | cds | 项目列表卡片为已绑定项目追加 GitHub badge(仓库名 + 绿色/灰色表示 autoDeploy 开关),点击直达 github.com |
| feat | cds | 分支卡片加"from GitHub <sha7>"徽标,点击跳 commit 页面,让 webhook 触发的分支一眼可辨 |
| feat | cds | Check run 阶段性 PATCH: pull/每层 layer 启动时推送进度到 GitHub, PR Checks 面板实时显示"构建第 X/Y 层 (services...)"而不是全程一条不变的"Deploying to CDS…" |
| feat | cds | Check run finalize 注入 output.text 日志尾部: 部署最后 80 条事件拼成 markdown code block,GitHub Checks 面板「Show more」展开后可直接看失败原因,不用再切回 CDS |
| feat | cds | pull_request.opened/reopened 事件 → bot 自动在 PR 贴 Railway 风格预览地址评论( Preview / Branch / Dashboard 三项 + 分支 SHA),后续 push 触发的 deploy 会原地 PATCH 同条评论,不污染 PR 时间线 |
| feat | cds | pull_request.closed (merged or not) 事件 → 自动 POST /api/branches/:id/stop 停掉预览容器,节省资源 |
| feat | cds | GitHubAppClient 新增 createIssueComment + updateIssueComment 方法(PR comments 走 issues API) |
| feat | cds | BranchEntry 加 githubPrNumber + githubPreviewCommentId 两字段,让 webhook dispatcher 能关联 PR + 复用 bot 评论 id |
| feat | cds | PR 评论 slash 命令:`/cds redeploy` 强制重部署、`/cds stop` 停预览容器、`/cds logs` 回复最近 40 条部署日志、`/cds help` 显示帮助,所有命令 bot 自动回复确认 |
| feat | cds | GitHub 删分支(delete 事件) → CDS 自动 POST /branches/:id/stop 清理对应预览容器,防止孤儿 |
| feat | cds | GitHub repo 被重命名/转移/删除(repository 事件) → 自动解绑 Project 的 github 链接,避免 webhook 打到错的项目 |
| feat | cds | release 事件 acknowledged(占位实现,为未来 release tag → 生产部署预留钩子) |
| feat | cds | dispatcher +19 测试用例(slash 命令 8 条、delete 3 条、repository 3 条、release 1 条)覆盖 |
| feat | cds | 新增预览就绪探测（TCP + HTTP）与分支 `restarting` 状态；容器存活但未监听端口时不再暴露 502，而是持续展示友好等待页直到真正就绪 |
| feat | cds | proxy 层扩大等待页覆盖：building / starting / restarting / 无可用 upstream / ECONNREFUSED 均返回 503 + Retry-After 的友好等待 HTML，前端 2s 自动刷新 |
| feat | cds | nginx 增加 `error_page 502 504 @cds_waiting` 兜底：CDS master 不可达（自升级、崩溃）时回落到 `www/cds-waiting.html` 静态等待页，彻底消除 Cloudflare 502 |
| feat | cds | 已删除分支访问友好页：预览子域名命中本地 + 远端都找不到的分支时，短路显示"预览已下线"404 HTML 页，含活跃分支列表和 15 秒自动返回控制台 |
| feat | cds | `ContainerService.restartServiceInPlace` 支持热重启（docker restart 保留容器），为后续 pull + restart 热加载链路预留入口 |
| fix | cds | 部署流水线在容器存活后进入 `starting`，通过 readiness 探测再转 `running`；探测超时标记 `error` 而非假装成功 |
| style | cds | Dashboard 分支卡片统一配色：非活跃卡片（idle/stopped/error）的端口徽章与技术栈图标转黑白；摒弃蓝色 — 技术栈 SVG 改用 currentColor 继承徽章状态色，port-building 与 status-dot-building 从蓝色改为主题琥珀色；GitHub 标志保留专属视觉 |
| feat | cds | Project 新增 aliasName / aliasSlug 两个可选字段; Settings → 基础信息 新增「显示别名」输入框,项目卡片 / 面包屑 / 删除确认 / Agent Key 签发弹窗全部走 aliasName \|\| name,用于解决「legacy 默认项目 name='prd-agent' 但用户希望显示别的」的显示困扰,不改 id / slug / 分支 id 前缀 |
| feat | cds | PUT /api/projects/:id 接受 aliasName (≤60 字符,空串清除) + aliasSlug (走 SLUG_REGEX,不能等于项目原 slug / 不能与其它 project slug / aliasSlug 冲突,空串清除); aliasSlug 当前仅存储,暂不影响分支 id 前缀,后续 PR 再做可选的 new-branch-prefix 开关 |
| test | cds | projects.test.ts 新增 6 个用例覆盖 alias 接受 / 清除 / 长度 / slug 正则 / 自 slug 冲突 / 跨项目 slug 冲突场景 |
| feat | cds | 新增 POST /api/self-force-sync 自愈端点: git fetch + reset --hard origin/<branch> + 清 dist/.build-sha + 重启,彻底解决本地 git 分叉导致 self-update pull merge 丢远端改动的问题 |
| feat | cds | 项目 Settings → 危险区新增「强制同步 CDS 源码到 origin」卡片: 输入分支名 + 确认 + SSE 实时进度,再也不用 SSH 到服务器敲 git reset |
| fix | cds | self-update 改用 `git reset --hard origin/<branch>` 代替 `git pull`,避免本地分叉时生成 merge commit 静默丢失远端文件变更(实测 settings.js 436 行新增被 merge 策略吞掉导致 UI 不生效) |
| fix | cds | 白天模式「+ 新建项目」按钮背景缺失 —— 选择器从 `.btn-primary-solid` 升级为 `button.btn-primary-solid`,让它与 `[data-theme="light"] button`(specificity 0,1,1) 平局,靠后声明顺序胜出;同时为描边加 1px accent 边框,悬浮色不再被全局 button:hover 盖掉 |
| fix | cds | 分支列表桌面端塌成单列 —— `.branch-list` 的 `display:flex` 让 CSS `column-count:3` 被完全忽略;`@media (min-width:768px)` 内显式翻回 `display:block` + `gap:0`,三/四列流式布局恢复 |
| fix | cds | 分支页顶部 `.view-mode-toggle` 比相邻 icon 按钮高半圈 —— 去掉遗留的 `margin:0 0 10px`,加 `min-height:36px` 对齐 `.icon-btn` 尺寸,整行 header-actions 共享同一条基线 |
| feat | cds | 分支页  菜单补回 6 条被移出去的快捷项(批量编辑环境变量 / 初始化配置 / 预览模式切换 / 镜像加速 / 浏览器标签名 / CDS 自动更新)+ 一键导出配置,并新增「快捷 · CDS 全局开关」分组标签(`.settings-menu-group-label`) —— 让用户在分支页也能触达高频操作,不必每次跳去项目列表 |
| feat | cds | 分支卡 port-badge 改用「语言/框架 icon + 端口号」—— 新增 portNode/portDotnet/portPython/portRust/portGo/portReact/portVue/portDb 语言图标;`detectPortIconKey(profile)` 从 dockerImage/command/id 推断(react > node / dotnet > net / mongo > go);隐藏 `api:` `admin:` 文字,profile 名字只保留在 tooltip(hover 显示) |
| test | cds | Project 别名 PUT 用例新增 6 条(验证 aliasName/aliasSlug 接受 / 清空 / 长度 / 正则 / 自 slug 冲突 / 跨项目 slug 冲突场景),738/738 通过 |
| chore | ci | `.github/workflows/ci.yml` 新增 cds-build job 并纳入 ci-status 聚合门禁 —— Phase 1 单一绿勾覆盖 server + admin + desktop + cds 四个子系统(CDS 仍保留独立 cds.yml 以保持操作员熟悉度,允许微量重复执行换取统一门禁) |
| fix | cds | GitHub webhook 收到非订阅事件(check_suite / workflow_run / pull_request_review / status / star 等)时直接 200 确认并跳过 dispatcher,响应头 X-CDS-Suppress-Activity=1 让 Dashboard 活动流不再被噪声事件淹没 |
| fix | cds | dispatcher 抛错时 webhook 返回 200 (ok:false) 而不是 500,阻止 GitHub 按 8 小时策略重投递触发反复构建;错误仍在服务端日志记录 |
| fix | cds | 同一 (branchId, commitSha) 30 秒内重复 dispatch 自动去重,避免 push + check_run.rerequested + 延迟重投等多路径同 SHA 连续触发两次构建把第一次刚起的容器撕掉 |
| feat | cds | Dashboard 活动流的 GitHub webhook 条目追加事件名标签(如 "GitHub 推送 Webhook · push" / "· check_run" / "· issue_comment"),一眼分辨不同事件类型 |
| docs | doc | 新增 guide.cds-github-webhook-events.md:列出 CDS 必订的 7 个事件(push / pull_request / issue_comment / check_run / installation_repositories / delete / repository)、可选事件(ping / installation / release)、被静默过滤的噪声事件清单(check_suite / workflow_run / pull_request_review 等 20+ 种),以及 GitHub App 后台订阅配置步骤、self-test 验证方法、新增订阅 checklist |
| fix | cds | 删除分支卡 GitHub commit SHA 胶囊(蓝色 7 位 hash): 用户反馈冗余,标题前的 GitHub icon 已经说明来源,commit hash 对运维体验没增加信息,chips row 的视觉空间让给 ports / 时间戳 |
| fix | prd-admin | 修复周报详情页「已阅」浏览记录弹窗样式错乱：改用 createPortal 挂到 body，布局关键尺寸走 inline style，滚动容器补 min-height:0 + overscrollBehavior:contain，新增 ESC 与遮罩点击关闭 |
| fix | prd-admin | 加强周报浏览记录弹窗边界感：硬编码不透明深灰底色 + backdrop-blur(20px) + 强阴影 + 半透明 scrim 遮罩，列表项加细边框与 hover 高亮，header 加分隔线 |
| feat | cds | 新增 `branch-events.ts` 进程级事件总线 (EventEmitter 单例) + 5 种事件类型 (branch.created / status / updated / removed / deploy-step),让 webhook dispatcher + deploy 流 + 手工添加 三条独立路径统一推"分支状态变了"这件事,前端通过 SSE 一条管道消费 |
| feat | cds | 新增 `GET /api/branches/stream` SSE 端点: 订阅时先推一次 snapshot (初始全量, 支持 ?project= 过滤),之后实时推 branchEvents 总线上的每条事件;10s keepalive 心跳;客户端断开自动 off 监听器不泄漏 |
| feat | cds | github-webhook-dispatcher 在 push 事件处理流末尾 emit branch.created / branch.updated,让 Dashboard 打开时能亲眼看到 GitHub push 自动创建的分支出现 |
| feat | cds | branches.ts 部署流程在状态转换点 (building 入口 + 结束时 running/error/starting) + 删除路径 + 手工创建路径 emit 对应事件,和自动触发路径统一走同一总线 |
| feat | cds | 前端 state-stream 处理扩展: 首次见到的分支 id 进 `freshlyArrived` set,renderBranches 给卡片追加 `.fresh-arrival` + (GitHub 来源时)`.fresh-gh` class;5 秒后自动清除,下次重绘回到普通卡片 |
| feat | cds | 新增 `@keyframes cds-card-arrival` (translateY + scale + opacity 滑入) + `cds-card-gh-pulse` (紫色外发光脉冲 x3),叠加勾勒出"GitHub 刚给你建的分支"视觉。遵守 prefers-reduced-motion,无动画用户不触发 |
| test | cds | 新增 tests/routes/branches-stream.test.ts 4 个用例:snapshot 事件 + branch.created 事件路由 + ?project 过滤 + 客户端断开监听器清理(防内存泄漏)。753/753 全绿 |
| feat | scripts | 新增 Phase 2 冒烟测试套件 (scripts/smoke-lib.sh + smoke-health.sh + smoke-prd-agent.sh + smoke-defect-agent.sh + smoke-report-agent.sh + smoke-all.sh) —— 部署后几十秒验证 Health/鉴权 + PRD 会话 Run + 缺陷 CRUD + 周报 CRUD 链路,用 X-AI-Access-Key + X-AI-Impersonate 真实 curl 打 CDS 预览域名,每个子脚本 best-effort 清理自己的测试数据 |
| feat | ci | `.github/workflows/ci.yml` 新增 `smoke-preview` job (workflow_dispatch 手动触发),入参 smoke_host + smoke_skip,走 repo secret AI_ACCESS_KEY 鉴权;Phase 3 再挪到 /cds-deploy 完成 hook 里自动触发 |
| docs | doc | 新增 doc/guide.smoke-tests.md 说明文件清单 / 环境变量 / CI 集成 / 扩展新 Agent 的模板,作为 Phase 2 交接文档 |
| feat | cds | 新增 POST /api/branches/:id/smoke SSE 端点,CDS 就地触发 scripts/smoke-all.sh 跑针对本分支预览域名(https://<branch>.<rootDomain>) 的冒烟测试;AI_ACCESS_KEY 支持 body 传入或从 _global.customEnv 回落,脚本目录走 CDS_SMOKE_SCRIPT_DIR env override;stdout/stderr 每行推 SSE `line` 事件,`complete` 带 exitCode + 耗时 + 通过/失败计数 |
| feat | cds | 分支卡 deploy 下拉菜单(isRunning 时可见)新增「 冒烟测试」项,点开弹出 60vh 流式输出弹窗,SSE 逐行渲染绿/红色,头部显示" 通过 3 项 · 12s"或" 失败 N / 通过 M"汇总;关闭即 abort 当前流(但后端 bash 进程继续跑到结束,遵循 server-authority) |
| test | cds | 新增 tests/routes/branches-smoke.test.ts 6 个用例: 404 / 缺 preview / 缺 key / fallback _global / 缺 script / SSE 流 + 计数抽取,744/744 通过 |
| feat | cds | Project 新增 `autoSmokeEnabled` 字段 + PUT /api/projects/:id 接受布尔值,Settings → 基础信息里新增「部署成功后自动冒烟测试」开关;默认关闭,开启后每次 deploy 成功都会在同条 SSE 流里跑完 scripts/smoke-all.sh(Phase 4) |
| feat | cds | 重构: `runSmokeForBranch(opts)` + `resolveSmokeScriptDir()` 提取为 branches.ts 顶层导出的纯函数,Phase 3 手动端点和 Phase 4 自动 hook 共用同一套 spawn + 计数解析逻辑,避免重复 60 行子进程管理代码 |
| feat | cds | branches.ts 部署 handler 在 deploy `complete` 之后、GitHub check-run finalize 之前调 `maybeRunAutoSmoke(...)`: 仅当 project.autoSmokeEnabled=true + previewDomain 配置 + _global.AI_ACCESS_KEY 存在 + smoke-all.sh 可定位四条全满足才跑;其它情况推一条 `smoke-skip` 事件,不阻断部署(Phase 4) |
| feat | cds | 自动冒烟事件以 `smoke-start` / `smoke-line` / `smoke-skip` / `smoke-complete` 推给 deploy SSE 同一条流,前端 app.js 的 deployBranchDirect 新增 currentEvent 解析,把冒烟日志用  前缀 + `│` 缩进渲染进 inline deploy log,操作员一个视图看到"部署 → 冒烟"完整叙事 |
| feat | cds | GitHub Check Run finalize 融合冒烟结果(Phase 5): conclusion = hasError \|\| smokeFailed ? 'failure' : 'success'; summary 追加 `冒烟 / pass=N fail=M (Xs)` 字段,PR 的 Checks 面板直接反映"部署绿但冒烟红"这类高价值信号 |
| test | cds | 新增 Phase 4/5 单测:projects.test.ts 增 2 条(autoSmokeEnabled 持久化 + 显式设 false);branches-smoke.test.ts 增 2 条(runSmokeForBranch helper 的 env 透传 + resolveSmokeScriptDir 缺脚本检测)。748/748 全绿 |
| feat | e2e | 新增 Playwright E2E 目录 (e2e/) 作为测试金字塔顶层: package.json + playwright.config.ts + tsconfig + utils/auth.ts,覆盖 7 条规格 3 UI 冒烟 (登录页无 console.error / 根路径 2xx / 静态资源就位) + 4 CDS Dashboard 回归保护(白天模式新建项目按钮 accent 背景 / 桌面分支列表 column-count ≥ 2 / toggle 与 icon 按钮同高 /  菜单含关键项) |
| feat | ci | ci.yml 新增 e2e-preview job + workflow_dispatch 入参 e2e_base_url,缓存 Playwright 浏览器,失败自动上传 HTML report + JSON results 到 artifacts(保留 14 天);和 Phase 2/3 的 smoke-preview job 并行独立,UI 崩 vs API 崩 一目了然 |
| docs | doc | 新增 doc/guide.e2e-tests.md:目录结构 / 本地运行命令 / headed / UI 模式 / 失败复盘 / CI 集成 / 写新 spec 模板 / 扩展方向(agent-flow / defect-flow / 跨浏览器 / 视觉回归) |
| fix | cds | CDS 系统更新弹窗下拉框被外层 overflow 裁切 —— dropdown 改用 position:fixed + JS 跟随 input.getBoundingClientRect 定位,挂到 document.body (portal),完全脱离 modal body 的滚动容器,下拉不再被剪。scroll/resize 触发 rAF 节流重定位;close 时同步移除 portal DOM 避免残留 |
| fix | cds | 分支列表栏布局从 CSS `column-count` 多列改为 CSS Grid auto-fill (minmax(340px, 1fr)) —— 旧 column 布局在窗口中等大时产生列间竖向空柱 (image 2 红框),宽屏下卡片 top-bottom-left-right 流动看起来乱 (image 3)。Grid auto-fill 让每行卡片等高对齐,无空柱无错位,窗口缩放自动增减列 |
| feat | cds | 分支卡片右上角新增"最近更新"时间戳: 胶囊样式 margin-left:auto 推到 chips row 末端,优先显示 lastAccessedAt (最近部署时间),缺失时 fallback 到 createdAt 并后缀"创建"二字。调用现有 relativeTime() 辅助,中文输出"刚刚 / N 分钟前 / N 小时前 / N 天前",tooltip 显示完整本地时间。窗口窄时 flex-wrap 折行仍保持右对齐 |
| docs | rules | `.claude/rules/bridge-ops.md` 头部补一张端点 URL 表,明确 `POST /api/bridge/command/:branchId` 的 branchId 必须在 URL path 不在 body —— 旧版知识提到的 `POST /api/bridge/command` (无 :branchId) 是 404 根因。附正反示例 curl,AI Agent 下次遇到 "Cannot POST /api/bridge/..." 能第一时间对表排查 |
| test | e2e | Playwright cds-dashboard 规格从 column-count 断言改为 grid-template-columns track count 断言,匹配新的 Grid 布局 |
| refactor | cds | 合并两套 CDS 系统更新弹窗 —— 新增 cds/web/self-update.js 统一模块,`window.openSelfUpdateModal()` 由 index.html 和 project-list.html 共同加载;app.js `openSelfUpdate()` 和 projects.js `cdsOpenSelfUpdate()` 都退化为 1 行 thin wrapper 调 window 入口,齿轮菜单 / topology popover / cmd-k / 项目列表设置下拉 4 个入口收敛到同一条路径 |
| feat | cds | 统一弹窗汇集两套旧版本的优点: 组合框(可搜索 + 粘贴, 原 app.js 版) + 强制同步 hard-reset 按钮(原 projects.js 版) + 粘性底部工具栏(修复 image 1 底部按钮被截断的问题) + 健康检查轮询(CDS 重启后自动 reload) |
| feat | cds | 分支列表页 header 新增独立  按钮 (#selfUpdateBtn),点击直接打开统一系统更新弹窗 —— 对应用户反馈"原来有,后来在设置里面被删除掉了"(8f85488 删的 header shortcut 恢复),齿轮菜单里的入口同步保留以兼容肌肉记忆 |
| chore | cds | 清理遗留的 openComboDropdown / filterComboItems / selectComboItem / executeSelfUpdate 等只服务于旧 self-update 弹窗的辅助函数为空壳 retire stub,防止缓存客户端残留 onclick 触发 ReferenceError |
| feat | prd-api | 视频 Agent 分镜模式新增 PRD 输入源：CreateVideoGenRunRequest 扩展 inputSourceType + attachmentIds 字段，空 articleMarkdown 时自动从附件 ExtractedText 拼接 markdown |
| feat | prd-api | VideoGenRunWorker Scripting 阶段针对 PRD 输入使用专用 prompt（痛点→方案→功能演示→收益 8-12 镜结构），与技术文章拆分镜模板区分 |
| feat | prd-admin | 视频 Agent 分镜模式输入区新增双通道：Markdown 文章 / PRD 文档，PRD 模式支持 PDF/Word/Markdown 多文件上传，经 /api/v1/attachments 提取文本，附件 chip 展示与移除 |
| feat | prd-admin | 视频 Agent 直出模式模型选择器重构为三档卡片（经济 Wan 2.6 / 平衡 Seedance 2.0 / 顶配 Veo 3.1）+ 折叠「高级」按钮展开 OpenRouter 全量 7 个模型，默认推荐自动档 |
| refactor | prd-admin | 视频 Agent 统一入口：撤掉「分镜模式 / 直出模式」两个 tab，合并为单一输入 Hero（UnifiedInputHero），根据用户输入（有附件 / 文本 > 200 字 → 拆分镜，短 prompt → 一镜直出）自动路由到对应管线 |
| refactor | prd-admin | 视频 Agent 输入字段默认收起：视频标题 / 系统提示词 / 画面风格 / 路由偏好 / 直出模型档 / 时长 / 宽高 / 分辨率 等统一折叠到「高级设置 ▸」，首次进入只暴露输入框 + 示例 chip + 上传按钮 |
| feat | prd-admin | 新增路由判定实时提示 chip（"即将：拆分镜 / 一镜直出"）+ 提交后 2.5 秒吐司显示判定原因，可在高级设置里强制"总是拆分镜 / 总是一镜直出" |
| feat | prd-admin | 新增历史任务抽屉（HistoryDrawer，createPortal 右侧）取代原左下历史列表，顶部应用条暴露「 历史(N)」按钮一键打开，带状态徽章 + 相对时间 |
| refactor | prd-admin | VideoGenDirectPanel 支持 `externalRunId` 纯输出模式：外层已创建的 videogen run 可直接传入，面板跳过内置输入区只做画布 + 进度 + 下载 |
| feat | prd-admin | 输入 Hero 支持拖拽文件（PDF/Word/Markdown/TXT 皆可），小文本文件（.md/.txt < 128KB）走 FileReader 可视，其它走 /api/v1/attachments 后端提取 |
| refactor | prd-admin | 重写 map 周报标签页：弃用 GitHub 订阅流程，改为从任一已有知识库挑选 + 前端文件名关键词过滤，配置存 sessionStorage |
| feat | prd-admin | map 周报标签页进入后自动选中最新的一篇（按 git commit time 倒序，若缺失则回退到同步时间） |
| feat | prd-admin | map 周报列表为本周有新提交的条目显示绿色 NEW 徽标，时间来源区分 "git" vs "同步" |
| feat | prd-api | GitHubDirectorySyncService 同步时从 GitHub commits API 拉取文件最近提交时间，存入 Metadata.github_last_commit_at；历史条目在下次同步命中 skip 分支时自动回填 |
| fix | prd-admin | 修复 DocBrowser 文件树滚动"不跟手"：移除 overscroll-behavior:contain（父级已 overflow:hidden，无需再拦截），TreeNode 的 transition-all 收窄为 transition-colors，避免滚动时 layout transition 造成漂移感 |
| fix | prd-admin | 修复 map 周报页目录树与预览内容联动滚动：改用纯 inline-style 2-pane 布局，强制 minHeight:0 + overflowY:auto 独立滚动 |
| fix | prd-admin | 修复 DocBrowser 强制 minHeight:calc(100vh-160px) 撑破父级导致 AppShell 主滚动的问题 |
| fix | prd-admin | 清理分支上遗留的 TS 编译错误（未用 import、listDocumentEntries 参数个数、EntryPreview 导入路径） |
| chore | doc | 统一 doc/ 命名：3 个 output-*.md 样本文件重命名为 report.skill-eval-sample-*.md，同步更新 report.skill-doc-evaluation / index.yml / guide.list.directory |
| rule | CLAUDE.md | 新增强制规则 #10：doc/ 下所有 .md 必须以 6 类前缀（spec/design/plan/rule/guide/report）开头，禁止 output-*.md / 裸文件名 / 子目录 |
| chore | doc | 批量统一 163 个 md 文件的 H1 标题格式：剥离 37 种混乱后缀（设计方案/设计文档/架构设计/技术设计/设计稿/方案/操作手册/规范/约定/规格说明/实施计划/...），统一追加 ` · 类型`，类型从文件名前缀映射（spec→规格 / design→设计 / plan→计划 / rule→规则 / guide→指南 / report→报告，周报→周报）；已含类型关键词的跳过追加避免重复 |
| fix | doc | 顺手修 2 个 H1 层级不规范文件：rule.doc-maintenance.md 的 `## ` 提升为 `# `，guide.prd-agent-operations.md 保留 YAML frontmatter 不动（H1 正常在 frontmatter 之后） |

### 2026-04-18

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | Agent 徽章改为常驻显示：pendingCount>0 时走黄色高亮 + 新申请到达瞬间 3 次脉冲闪烁；=0 时转为中性色「Agent 记录」入口，点进去看历史 |
| feat | cds | pending-import 审计保留期从 24h 延长到 7 天，抽屉「最近处理」栏显示"近 7 天 · 共 N 条"并在空状态解释提交路径 |
| feat | cds | Agent Key 项目授权:每个项目可签发 `cdsp_` 自描述 key,默认 rw + 一次性显示明文 + 服务端只存 sha256 + 立即吊销。按钮在项目卡片、分支页头部、Key 管理抽屉三处皆可发起。技能 cds-deploy-pipeline 接到 `CDS_PROJECT_KEY=...` 格式文本自动入会话凭证 |
| fix | cds | auto-build（预览子域触发的构建）改用 `getBuildProfilesForProject(entry.projectId)`，不再遍历别的项目的 profile 导致"缺少 command 字段"或跨项目 service 污染 |
| fix | cds | auto-build 创建的分支显式 `projectId: 'default'`，让清理/隔离路径一致对待 |
| feat | cds | pending-import 提交时校验每个 app profile 必须带 command，否则 400 `invalid_profile`，不再让半成品 YAML 混进状态 |
| fix | cds | 分支列表 UI 遍历 service 时过滤掉不在当前项目 buildProfiles 里的条目，防止跨项目或已删 profile 画出鬼影 chip |
| feat | cds | `/api/cleanup-orphans` 支持 `?project=<id>` 或不传 → 按项目逐个 fetch remote 对比本项目分支，不再把 fork 的 main 当孤儿误删 |
| feat | cds | `/api/prune-stale-branches` 同样项目化，每个项目用自己的 repoPath + 自己的已部署分支集合，cloneStatus 未 ready 的项目自动跳过 |
| feat | cds | `/api/cleanup` + `/api/factory-reset` 支持 `?project=<id>`；分支页"恢复出厂/清理全部"默认按当前项目执行，不再误删其他项目 |
| feat | cds | `build_ts` 改用 git HEAD SHA 作为编译缓存 sentinel（替代易误判的 mtime 比较），修复 self-update 后 dist/ 不重建导致新代码不生效的 pre-existing bug |
| feat | skill | 新增 `.claude/skills/cds-deploy-pipeline/cli/cdscli.py` Python CLI 封装 CDS REST API，解决 curl+bash 方案的嵌套 JSON 转义、UA 被 Cloudflare ban、SSE 解析三大痛点 |
| docs | skill | cds-deploy-pipeline SKILL.md 顶部插入 cdscli 首选工具章节，命令清单取代大段 curl 示例 |
| feat | cds | customEnv 支持项目级作用域：{ _global, <projectId> }，部署时 project 覆盖 global，禁止跨项目泄漏 |
| feat | cds | /api/env 全部端点接受 `?scope=_global|<projectId>`，默认 _global 保持向后兼容 |
| feat | cds | 分支页环境变量弹窗新增"全局 / 此项目"切换开关 |
| fix | cds | 删除项目时级联清理其 customEnv 作用域 bucket |
| test | cds | custom-env-scope.test.ts 6 新测试（迁移 + 合并优先级 + 级联） |
| feat | cds | GitHub App webhook 接入：POST /api/github/webhook 接收 push 事件，自动创建/刷新 CDS 分支并触发部署，Railway 式 Check Run 回写到 PR Checks 面板（点击"Details"直达 CDS 预览分支） |
| feat | cds | Project 新增 githubRepoFullName/githubInstallationId/githubAutoDeploy 三元组，支持 POST/DELETE /api/projects/:id/github/link 将项目绑定到 GitHub 仓库 |
| feat | cds | GitHubAppClient 服务：零新依赖（Node 原生 crypto RS256 JWT + HMAC-SHA256 webhook 签名校验）、安装 token 内存缓存、check runs POST/PATCH、installations/repos 列表 |
| feat | cds | 部署流水线挂接 check-run 生命周期：building 阶段 POST status=in_progress,完成后 PATCH conclusion=success/failure 并把 `<分支>.<domain>` 预览 URL 嵌入 summary |
| feat | cds | GET /api/github/app / GET /api/github/installations / GET /api/github/installations/:id/repos 三个辅助端点,给 UI 用于引导操作员安装 App + 挑选仓库绑定 |
| feat | cds | 新增配置项 githubApp {appId, privateKey, webhookSecret, appSlug} + publicBaseUrl,env 优先（CDS_GITHUB_APP_ID/_PRIVATE_KEY/_WEBHOOK_SECRET/_APP_SLUG, CDS_PUBLIC_BASE_URL）,兼容 `.cds.env` 里 `\\n` 字面值的 PEM |
| feat | cds | 新增全局 Agent 通行证 cdsg_*（与 AI_ACCESS_KEY 等权，可跨项目创建/删除）+ 签发/列表/吊销 UI |
| feat | cds | 项目列表页全局设置菜单加入" Agent 全局通行证"入口，签发时弹警告 |
| test | cds | 新增 global-agent-keys.test.ts（4 tests 全绿） |
| refactor | cds | 全局 CDS 设置（主题/自动更新/预览模式/镜像/标签页/集群/恢复出厂/退出登录）从分支页的齿轮菜单迁移到项目列表页头部；分支页保留 project-scoped 项 |
| fix | cds | 基础设施端点 (POST/PUT/DELETE/start/stop/restart/logs /api/infra[/:id...]) 全面项目化：`(projectId, id)` 复合唯一性、按 `?project=<id>` 或自动推断项目上下文、多项目冲突时 400 明示「请带 ?project=<id>」、container name 非 legacy 项目自动加项目 slug 前缀避免 Docker 级冲突 |
| fix | cds | 分支页头部 4 个冗余 shortcut 按钮移除（构建配置/环境变量/基础设施/路由规则），这些都在齿轮菜单里有 |
| feat | cds | `./exec_cds.sh init` Mongo bootstrap 改造：容器名 cds-state-mongo、固定端口 27018、等待 mongosh ping healthy、写 CDS_MONGO_CONTAINER 到 .cds.env |
| feat | cds | `./exec_cds.sh start` 前新增 ensure_cds_mongo_running 函数，自动 docker start 容器 + 等 healthy，解循环依赖 |
| docs | cds | guide.cds-mongo-migration.md v1.1：三种场景分流（新装/老切/bug 受害者）+ systemd 绕过 load_env 故事 + 三种紧急回退 |
| feat | cds | 移除"mongo URI 配了但连不上就退回 JSON"的自动 fallback — 按用户需求 Mongo 成主存储 |
| feat | cds | 连 Mongo 失败时 throw exit 并打印清晰的回退路径（编辑 .cds.env 或 Dashboard "切回 JSON") |
| docs | cds | 更新 initStateService() 行为矩阵注释，6 种 state × mode 组合明确表达 |
| feat | cds | `switch-to-mongo` / `switch-to-json` 端点现在会把 CDS_STORAGE_MODE / CDS_MONGO_URI / CDS_MONGO_DB upsert/remove 到 `cds/.cds.env`，重启自动延续 Mongo 模式，不再退回 JSON |
| feat | cds | 新增 `cds/src/infra/env-file.ts` — 原子 upsert/removeKey 工具（chmod 600 + 转义 " \\ $） |
| test | cds | env-file 9 新测试全绿（创建/替换/保留其他/删除/转义/权限/错误 key） |
| refactor | cds | 三页面语义化重命名：projects.html→/project-list, index.html 列表视图→/branch-list, 拓扑视图→/branch-panel；旧路径 301 永久重定向，书签不失效 |
| refactor | cds | setViewMode 切换视图时同步 URL（pushState）+ 页面 title，分支列表/分支面板有独立可书签地址 |
| refactor | cds | 所有内部导航链接（app.js / projects.js / settings.js / settings.html / index.html）统一换为语义路径 |
| refactor | cds | 登录后跳转默认目标从 /projects.html 改为 /project-list（middleware + auth routes） |
| feat | cds | 项目列表页新增 Agent 配置申请徽标与审批抽屉，支持批准/拒绝 pending-import 并懒加载 YAML 预览 |
| feat | cds | 项目卡片渲染 clone 生命周期进度条（pending/cloning 黄条、error 红条），非终态时每 5s 自动轮询直至就绪 |
| feat | cds | 支持 `?pendingImport=<id>` 深链接自动打开审批抽屉并滚动到指定卡片，配合 cds-project-scan 技能的一键跳转 |
| feat | cds | 新增 pending-import 流程：外部 Agent 可 POST /api/projects/:id/pending-import 提交 CDS 配置，由面板人工批准/拒绝（14 个新测试） |
| feat | cds | 部署 env 注入 CDS_PROJECT_SLUG / CDS_PROJECT_ID，compose YAML 可写 `"${CDS_PROJECT_SLUG}"` 实现多项目数据隔离 |
| chore | cds | "快速开始"按钮改名「初始化构建配置」并更新引导文案，反映新增 cds-compose.yaml 优先读取的行为 |
| feat | cds | 项目列表卡片新增运行态摘要（分支数/运行中服务数/最近部署时间）+ 显式"进入分支 →" CTA |
| feat | cds | `GET /api/projects` 排序改为 legacy → 运行中服务多 → 最近部署新 |
| fix | cds | 新建项目时 slug 冲突自动追加 -2/-3 后缀（仅当 slug 为自动派生时）；显式填写 slug 仍然 409 |
| fix | cds | 项目内"快速开始"按 projectId 隔离构建配置，旧项目的 profile 不再阻塞新项目初始化 |
| fix | cds | 项目列表加载失败时显示后端真实错误信息（替代笼统的 HTTP 400） |
| fix | cds | `/quickstart` 优先读取项目仓库根目录下的 `cds-compose.yaml`/`cds-compose.yml`，用其声明的 buildProfiles + envVars + infraServices 代替硬编码模板，修复 fork 出的项目因缺少 MongoDB/Redis/JWT 环境变量导致的 Redis 连接崩溃 |
| fix | cds | `/quickstart` 合并 cds-compose 的 envVars 时跳过已存在的 customEnv key，不覆盖 legacy 手工配置；infraServices 按 projectId 作用域去重，避免两个项目同名 `mongo` 互相冲突 |
| fix | cds | `/quickstart` 构建配置 id 后缀从 `projectId` 前 8 位十六进制改为项目 slug（如 `api-prd-agent-2`），topology 视图更易辨识；legacy default 项目继续使用无后缀 id 保持向后兼容 |
| docs | cds-project-scan | Phase 8 新增进度可见性硬要求 + 缺失 projectId 兜底流程（禁止 AI 猜 ID） |
| fix | cds | 项目列表页 " 自动更新" 恢复完整 modal（可选分支 + SSE 流式反馈），之前是 v1 占位符只能更新当前分支 |
| feat | skill | cdscli 新增 `update` 命令自升级（带备份+回滚）+ `version` 命令对比本地/服务端版本 |
| feat | cds | `/api/cli-version` 端点读取 cli/cdscli.py VERSION 常量（60s 缓存）|
| feat | skill | CLI 请求带 `X-CdsCli-Version` header，解析响应头 `X-Cds-Cli-Latest` 自动 stderr 提示"有新版" |
| docs | skill | 新增 reference/maintainer.md：维护者工作流（改技能源 → bump VERSION → push → CDS self-update 生效）|
| docs | skill | SKILL.md 顶部加"你是哪种身份"导航：消费方 vs 维护者两条路径分流 |
| feat | skill | cdscli 新增 `sync-from-cds` 命令 — 扫 cds/src/routes/*.ts 对比 CLI+reference/api.md 的端点覆盖，给出 drift 报告 + 修复建议 |
| docs | skill | SKILL.md 加「维护者：我改了 CDS，Agent 帮我同步技能」6 步工作流 + 触发词清单 |
| docs | skill | reference/maintainer.md 加完整 AI 辅助同步示例（plan-first → 改文件 → 自检 → 汇报）|
| fix | skill | 触发词收紧 — 维护者同步工作流只认 "/cds-sync" / "帮我同步 cds 技能" 等带 cds 关键字的显式指令，禁止"同步技能"/"更新技能"泛指令误触发 |
| feat | skill | cdscli sync-from-cds 路径可配置：--routes-dir 参数 + $CDS_ROUTES_DIR env + git root 推断 + cli 相对路径兜底，四级降级应对 CDS 未来独立仓库场景 |
| feat | skill | sync-from-cds 输出加 routesDir / scannedFiles 字段 + stderr 打印扫描路径，杜绝"扫到哪去了"的不透明情况；--quiet 抑制 stderr |
| docs | skill | maintainer.md 说明 CDS 独立仓库后的路径配置方式（CDS_ROUTES_DIR 环境变量）|
| fix | cds | 分支页头部恢复  主题切换按钮（之前误搬走了）；两个页面各自有一把 |
| feat | cds | 项目列表页主题切换接入 View Transition API + clip-path ripple，和分支页视觉一致（之前只是直接翻 data-theme 没动画） |
| feat | skill | 新增统一 `cds` 技能，合并 cds-project-scan + cds-deploy-pipeline + smoke-test 三个技能为单一入口 |
| feat | skill | cdscli 扩展 5 个新命令：init (env 向导) / scan (项目扫描) / smoke (分层冒烟) / help-me-check (自动诊断+根因) / deploy (完整流水线) |
| feat | skill | reference/{api,auth,scan,smoke,diagnose,drop-in}.md 6 份按需加载的进阶文档 |
| feat | cds | /api/export-skill 重构为打包整个 .claude/skills/cds/ (含 cli/ + reference/)，README 指导 drop-in 到其它项目 |
| feat | cds | 项目卡片新增「 下载 cds 技能包」按钮（位于  授权 Agent 左侧），一键 tar.gz 下载 |
| docs | skill | 给 cds-project-scan / cds-deploy-pipeline / smoke-test SKILL.md 顶部加废弃/合并指引，保留向后兼容触发词 |
| docs | cds | 新增 guide.cds-multi-project-upgrade.md 生产环境迁移指南：备份命令 / 自检清单 / 回滚路径 |
| feat | cds | migrateCustomEnv 触发时打印日志 `[state] migrated legacy customEnv into _global scope`，方便运维确认迁移成功 |
| feat | prd-admin | Cmd/Ctrl+K 命令面板重构：从只能切 5 个 Agent 升级为统一命令面板，收录 Agent / 百宝箱 / 实用工具，支持搜索、分组（置顶/最近/Agent/百宝箱/实用工具）、键盘导航、点击星标置顶 |
| feat | prd-admin | 新增「设置 → 我的空间」页：私人使用数据看板，展示置顶工具、最近使用、常用工具 Top 10（按启动次数排序），支持一键取消置顶 / 清空最近 / 重置统计 |
| feat | prd-admin | 用户下拉菜单新增「我的空间」入口，快速跳转到 /settings?tab=user-space |
| refactor | prd-admin | 新增 lib/launcherCatalog.ts 作为 Agent + 百宝箱 + 实用工具的统一目录（命令面板与我的空间共享），按权限自动过滤 |
| refactor | prd-admin | agentSwitcherStore 扩展：recentVisits 新增 id/icon 字段 + 新增 usageCounts / pinnedIds，版本迁移至 v2 兼容老数据 |
| refactor | prd-admin | 命令面板卡片改为紧凑方形（5 列网格，高度 96px，2 行描述），面板最大宽度 1080px，键盘上下移动按列数 5 对齐 |
| fix | prd-admin | 命令面板卡片取消固定高度与截断：描述文字自然换行，卡片按内容增高；同行卡片通过 grid items-stretch 对齐 |
| chore | .cursor/rules | 彻底刷新：以 .claude/rules/ 为唯一事实源，scripts/sync-cursor-rules.sh 自动生成 23 条 .mdc 镜像，修复 doc 路径失效/缺 LlmRequestContext/缺 Run-Worker/缺前端模态框/角色枚举陈旧等全部漂移 |
| docs | .claude/rules/llm-gateway.md | 新增「必须设置 LlmRequestContext」硬规则 + 判定清单 + pa-agent "User not found" 反面案例，把"质量门禁运行时 warning"升级为"规则层必看章节" |
| feat | prd-admin | 周报日常记录：单行 input → 多行 textarea + 粘贴图片自动压缩上传（markdown 内联）+ 折叠态/编辑态/快速添加均渲染图片预览 + 每条  AI 润色按钮（流式预览浮层 + 接受/放弃 + 模型可见） |
| feat | prd-api | 新增 POST /api/report-agent/daily-logs/upload-image（图片上传，复用 IAssetStorage + Attachment）+ POST /api/report-agent/daily-logs/polish（SSE 流式润色：phase/model/thinking/typing/done/error 事件 + 心跳 + CancellationToken.None 服务器权威） |
| chore | prd-admin | 抽取通用图片压缩工具到 src/lib/imageCompress.ts，与 ReportEditor 共用 |
| feat | prd-admin | 周报日常记录自定义标签支持双击就地重命名：chip 上 `title=双击重命名` 提示 + Enter 保存 / Esc / 失焦取消，复用现有校验（空/超长/重名）与乐观更新回滚。系统标签不受影响（仅自定义标签支持）。 |
| fix | prd-api | 缺陷列表接口同时接受 filter/limit/offset 与 mine/page/pageSize，修复前端契约漂移导致 filter=assigned 被静默丢弃、pageSize 回落到默认 20 条使用户看不到自己的缺陷
| fix | prd-api | 缺陷列表 MaxPageSize 提升到 500，支持单次拉取覆盖真实账号全量数据；filter=submitted/assigned/all 直接映射到 ReporterId/AssigneeId 服务端筛选
| fix | prd-admin | 缺陷 store 拉取 limit 从 100 提升到 500 匹配后端新上限，并新增 defectsTotal 字段；列表顶部当 total > 已加载条数时显式提示"共 N 条，请用筛选缩小范围"避免用户误以为数据丢失
| fix | prd-desktop | list_defects Tauri 命令显式传 ?limit=500，修复用户看不到 20 条之外的缺陷
| fix | prd-admin | 缺陷详情弹窗关闭按钮定位到对话框右上角（showChat 时不再卡在 55% 分栏线上） |
| feat | prd-api | `/api/defect-agent/users` 返回 AdminUser 兼容形状并按「已解决缺陷数」降序返回，最积极解决缺陷的人排在最前 |
| feat | prd-admin | 缺陷提交面板（DefectSubmitPanel / GlobalDefectSubmitDialog）统一使用 `UserSearchSelect` 富选择器（头像/角色/活跃时间）替换原始 `<select>`，与「发起数据分享」一致 |
| fix | prd-admin | 缺陷提交按钮允许点击态保留；缺少「提交给」时改为该字段红色闪烁三拍（代替右上角 toast），视觉聚焦到真正需要填写的控件 |
| feat | prd-admin | 智识殿堂（LibraryLandingPage）新增搜索框：支持按知识库名称 / 作者 / 描述 / 标签模糊搜索，含空结果引导 |
| refactor | prd-admin | 统一用户选择器：OpenPlatformPage / AppsPanel / BindingPanel / EmailChannelPanel / IdentityMappingsPage / WhitelistEditDialog / DataSourceManager / TeamManager 全部替换为 `UserSearchSelect`（系统公认的富用户选择组件） |
| fix | prd-desktop | 群组切换不再空白闪烁：messageStore 新增每群快照（LRU 12 群、每群 80 条），切回已访问群秒开，冷启动才等服务端同步
| fix | prd-desktop | 断线提示大重写：移除常驻"未连接"状态点，Header 红色脉冲 banner 改为 ≥4s 防抖的克制琥珀 pill，tauri 层 2s 防抖 markDisconnected 吃掉瞬时抖动，ChatContainer 初始态改 'connecting' 消除打开瞬间红点
| fix | prd-desktop | 群切换时清掉上一群的 SSE error 残留，避免 A 群错误贴到 B 群头部
| fix | prd-desktop | 连接自动探活改为指数退避 5s→60s（不再固定 5s 轮询），避免断网时持续占资源
| fix | prd-api | 修复 DocumentSyncWorker 因 HttpClient 30s 超时抛 TaskCanceledException 被 catch filter 误判为"关机取消"漏掉，最终拖垮整个 Host 导致无法登录的问题 |
| fix | prd-api | HostOptions.BackgroundServiceExceptionBehavior 显式设为 Ignore，避免任一 BackgroundService 未捕获异常时整个进程被停 |
| fix | prd-admin | 修复「管理标签」铅笔按钮进不了编辑态的回归：新增 editingTagSource（manage/quick/editMode）隔离三处入口，避免共用 editingTagIdx 导致 onBlur 连带退出；三处 setEditingTagIdx/Draft 重置统一收敛到 handleCancelInlineEditTag。 |
| feat | prd-api | LLM Gateway 对 OpenRouter 上游自动注入 `HTTP-Referer` + `X-Title` header，把 AppCallerCode 映射到 OpenRouter Dashboard 的应用归属维度；按 ApiUrl 域名隔离，不影响 DeepSeek / 通义 / Claude 等其他上游 |
| fix | prd-api | LLM Gateway 流式请求的传输层异常（HttpClient 超时、连接失败、流中途断连）现在会落 llmrequestlogs 的 statusCode + error，不再被 Watchdog 5 分钟兜底成 `error="TIMEOUT" / dur=300000` 的观测黑洞 |
| fix | prd-api | LLM Gateway 流式请求上游返回 401/4xx 时，先写日志再 yield Fail chunk；避免 caller 收到 Error chunk 立即 return 释放迭代器，导致 MarkError 被跳过、日志滞留 running 最终被 Watchdog 盖成 TIMEOUT |
| fix | prd-api | PRD Agent 遇 PRD 方案仅粗略提及、缺口径/数值/触发条件时，必须标注「未详细说明」并用 `@产品` 发起澄清，禁止用行业惯例/主观推断补全
| fix | prd-api | SystemPromptSettings 新增 SeededVersion 字段：SystemPromptService 检测到旧种子版本时自动用 PromptManager 最新默认值覆盖，解决 snapshot-fallback 陷阱（代码 PR 改了默认提示词，但老环境因首次启动已把旧默认持久化到 MongoDB 而继续返回旧文案）。管理员通过 PUT 保存的 doc 会清空 SeededVersion，永远保留，不被自动升级覆盖
| feat | prd-admin | 百宝箱新增「公开市场」分类 tab，可浏览/搜索/Fork 他人公开发布的智能体到自己的百宝箱 |
| feat | prd-admin | 自定义工具卡片 hover 显示快捷「编辑」按钮，已公开的卡片左下角显示绿色「已公开」徽章 |
| fix | prd-admin | ToolDetail 切换发布状态后立即同步到 store.items，回到 grid 徽章实时刷新（之前需刷新页面） |
| fix | prd-admin | 百宝箱按钮文案去歧义：「自定义副本」→「复制并编辑」、「分享」→「分享对话」、「发布」→「公开发布」，并加 tooltip 说明各自动作和影响 |
| feat | prd-admin | 「公开发布」首次点击时弹原生确认框，避免误把私人智能体公开给所有人 |
| feat | prd-admin | 百宝箱卡片 hover 时右上角直接显示操作浮条：自定义卡片「编辑 / 公开发布 / 删除」，内置可 Fork 卡片「复制并编辑」，不再需要先进详情页 |
| fix | prd-admin | 用户自建工具被误识别为"系统内置"根因修复：后端 ToolboxItem 模型没有 Type 字段，store.loadItems 补归一化 + 多处 fallback 用 createdBy/createdByName 判定，作者头像、编辑按钮、详情页「编辑」等 custom-only UI 恢复正常 |
| feat | prd-admin | 百宝箱卡片 footer 语义重构：定制版显示「定制版」徽章；其它卡片（内置对话/用户自建/公开市场）统一显示作者头像+名字；用户自建工具未公开显示橙色「施工中」、已公开显示绿色「已公开」；「系统内置」徽章移除 |
| fix | prd-admin | 用户自建工具作者显示"未知"兜底优化：后端 GetUserName() 依赖 JWT name claim 可能为空，前端 fallback 改用 authStore 当前登录用户的 displayName/username，最终兜底为"我" |
| feat | prd-admin | 内置对话型智能体（代码审查员/翻译/摘要/数据分析师）统一标记为「官方」作者，与用户自建工具共用 footer 样式 |
| feat | prd-admin | 创建智能体成功后：① toast 明确提示"默认仅你自己可见，点卡片右上角  公开发布" ② 卡片右上角的「公开发布」按钮自动脉动高亮（绿色光环 + 常驻可见），用户点过或成功公开后自动移除，防止用户以为"创建即共享" |
| feat | prd-api | ToolboxItem 新增 CreatedByAvatarFileName 字段，Create 和 Fork 时查 Users 集合写入创建者头像 + DisplayName（之前只存 JWT name claim 可能为空） |
| feat | prd-admin | 百宝箱卡片底部头像从"首字母圆形块"改为真实头像图片：优先用后端返回的 createdByAvatarFileName 经 resolveAvatarUrl 拼 CDN（适用公开市场里别人的卡片），其次 authStore 当前用户 avatarUrl，首字母块仅作最终兜底 |
| feat | prd-admin | 周报编辑器新增草稿自动保存：输入停手 1.5s 后自动落盘，头部实时展示"保存中/已保存·HH:mm/保存失败"状态条，刷新/关闭前未保存内容有浏览器兜底提示 |
| feat | prd-admin | 周报「列表」类型 section 支持键盘流：回车新增下一条（自动聚焦）、空行退格合并到上一条（Notion 同款），并排除 IME 合成态 |

### 2026-04-17

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 涌现探索器新增炫酷介绍入口页,首次进入展示三步流程+三维度样例+手势说明,可通过顶栏「关于涌现」再次查看 |
| fix | prd-admin | 修复涌现画布探索/涌现时新节点堆积在同一位置的 bug(原 `toFlowNodes` 在增量到达时只传入单个节点导致无法计算正确深度),改为整体重新布局 + 基于子树宽度的递归树布局算法 |
| feat | prd-admin | 涌现画布手势对齐视觉创作画布:两指拖动=平移、双指捏合或 ⌘/Ctrl+滚轮=缩放、Space+拖动=临时平移、禁止双击缩放 |
| rule | root | 新增 `.claude/rules/gesture-unification.md` 画布手势统一规则,强制所有 2D 画布遵守同一套 Apple 触控板优先的手势约定,并注册到 CLAUDE.md 规则索引 |
| feat | prd-admin | 涌现画布新增骨架占位卡片:点击「探索/涌现」瞬间下方立即出现 4 张 shimmer 扫光骨架 + 虚线 animated 边,SSE 每到达一个真实节点就消费一个占位槽位并带 0.55s 淡入放大的入场动效,彻底消除 LLM 空白等待 |
| feat | prd-admin | 涌现节点操作按钮拆分为两颗:左「增加灵感」(黄色·Lightbulb,打开对话框写方向)、右「探索」(蓝/紫/黄·Star,直接无提示词发散);灵感对话框带 6 个快速预设+⌘Enter 快捷提交,呼应零摩擦输入原则 |
| feat | prd-api | `POST /api/emergence/nodes/:nodeId/explore` 新增可选请求体 `{ userPrompt?: string }`,Service 层 `ExploreAsync` 接收 `userPrompt` 参数并在 userMessage 尾部追加「用户补充灵感方向」段,LLM 按方向优先发散但仍约束于现实锚点 |
| feat | prd-admin | 涌现树列表卡片重新设计:基于标题哈希派生确定性视觉指纹(色相/轨道粒子数/热度/旋转角),每棵树自带独特花蕾+轨道 SVG 动画(节点数→粒子数/亮度,更新时间→热度火苗)+ 渐变进度条,彻底告别"所有树长得一模一样"的单调感 |
| feat | prd-admin | 涌现画布顶栏新增「整理」按钮(Wand2 图标):调用 `reactFlow.fitView` + 重新递归布局,一键把杂乱节点恢复树状整齐视图,解决"人类微调太累"痛点 |
| feat | prd-admin | 涌现画布「二维涌现 / 三维幻想」两颗按钮合并为单颗「涌现 ▾」Popover:展开后展示两种发散方式的大白话解释(跨系统组合 vs 放飞想象),用户第一次见就知道选哪个,呼应 guided-exploration 的 3 秒规则 |
| feat | prd-admin | 涌现画布流式生成时顶栏增加「停止」按钮(StopCircle 红色):调用 `useSseStream.abort()` 中断当前 LLM 请求、清空占位骨架,用户不再被卡住几十秒空等 |
| feat | prd-admin | 涌现画布每到达一个新节点自动调用 `reactFlow.setCenter` 平滑居中,新节点不再跑到视口外需要手动找;缩放 0.85 + 600ms 过渡,兼顾全局感与聚焦感 |
| fix | prd-admin | 涌现画布左下角图例文字从白色改为与图标同色(维度色相),用户不再"分不清白字在说什么";底色加深+blur,提升对比度和可读性 |
| feat | prd-api | 涌现 `ExploreAsync` / `EmergeAsync` 由一次性 `SendAsync` 改为流式 `StreamAsync` + `onContent` 回调,LLM 输出每到达一个 Text chunk 就实时回传给 Controller,用户不再面对几十秒空白等待 |
| feat | prd-admin | 涌现画布左上角原简陋阶段条替换为 `EmergenceStreamingBar`:左徽章(维度色 spinner+文案)、中间流式文字预览(等宽字体+光标闪烁+横向滚动到最新+JSON 字段抽取可读化)、右侧「已涌现 N 个」,维度色随探索/涌现切换 |
| feat | prd-admin | 涌现画布骨架占位卡片在流式生成时替换 shimmer 为 LLM 实时输出文本(最多 140 字 + 等宽字体 + 光标闪烁),底部文案从「即将涌现…」切到「即将落位…」,用户在等待期间看到 AI 正在思考的内容 |
| feat | prd-admin | 涌现首次进入介绍页重新设计:参照 ui-ux-pro-max 的 Bento Grid Showcase + AI-Driven Dynamic Landing 模式,中央种子 hero 视觉(三环反向旋转轨道 + 呼吸光晕 + 四向光芒 + 28 颗漂浮粒子),非对称 bento 布局(1/1.4/1 列,涌现维度居中放大),编号时间线(1→2→3 带渐变连接线)替代原平铺步骤卡片 |
| fix | prd-admin | 涌现画布树布局参数调整:`LEAF_WIDTH` 320→360、`DEPTH_STEP` 220→340,解决种子节点(含描述+缺失能力警告+标签+操作按钮约 260-280px 高)与下一层子节点视觉重叠的 bug |
| fix | prd-admin | 涌现画布左下角图例改用纯色 rgb 文字(蓝/紫/黄)+ 加深面板底色 `rgba(15,16,20,0.85)` + blur saturate(140%),彻底解决"白色 + 半透明 rgba 看不清"问题 |
| feat | prd-api | 涌现 `ExploreAsync` / `EmergeAsync` 新增 `onThinking` 回调,GatewayRequest 启用 `IncludeThinking=true` + OpenRouter `include_reasoning:true` + `reasoning.exclude:false`,推理模型的 reasoning_content 现在能流式回传 |
| feat | prd-api | `EmergenceController` Explore/Emerge SSE 协议新增 `thinking` 事件:reasoning_content 每片就推一条 `event: thinking\ndata: {text}`,用户首字到达前不再面对几十秒空白等待 |
| feat | prd-admin | 涌现画布顶栏 `EmergenceStreamingBar` 新增 `thinking` 字段:typing 还是空时优先展示 reasoning_content(脑图标 1.4s 脉冲 + 斜体灰字 + 横向滚动到最新),首字到达后无缝切换为正式 typing 渲染 |
| fix | prd-admin | 涌现画布左下角 ReactFlow Controls(+/-/fitView 按钮)彻底暗色化:玻璃面板底 + 半透明白字 + hover 变蓝,不再是刺眼的白底黑字与暗色主题冲突 |
| feat | prd-admin | 涌现探索支持并行:原「单流独占」改为每个节点独立 SSE 流,可同时探索 N 个节点,顶栏显示"N 条并行"+代表性 typing/thinking,停止按钮一键停全部;只有同一节点二次点击才禁用 |
| feat | prd-admin | 涌现节点「探索」按钮增加 per-node loading 态:流式期间显示 MapSpinner + "探索中…" + cursor progress + 禁用 disabled,解决「点一次就全树禁用」的误导 |
| fix | prd-admin | 涌现画布删除 ReactFlow 自带 Controls(+/-/fitView):暗色样式覆盖反复无效,且画布手势已支持双指捏合/⌘+滚轮缩放、Space+拖动平移,顶栏「整理」按钮 = fitView,Controls 完全冗余 |
| fix | deploy | exec_dep.sh 自动下载安装 ffmpeg/ffprobe 静态版到 /opt/ffmpeg-static，修复容器因缺少 ffmpeg 导致视频创作/转录报错 |
| feat | prd-api | 新增 HomepageAsset 实体与 HomepageAssetsController（admin 上传/删除）+ HomepageAssetsPublicController（任意登录用户可读），支持首页四张快捷卡背景与所有 Agent 封面图/视频的动态上传 |
| feat | prd-admin | 设置 → 资源管理新增「首页资源」Tab：4 张快捷卡背景 + 17 个 Agent 封面图/视频上传，一个 slot 一张图/视频，自动映射到 CDN |
| feat | prd-admin | LandingPage（AgentLauncherPage）读取已上传的 card 背景与 agent 封面/视频，优先覆盖默认渐变/CDN 素材 |
| feat | prd-api | HomepageAssetsController BuildObjectKey 新增 hero.{id} 路由 → 老 CDN 路径 icon/title/{id}.{ext}，首页顶部 Banner 可在设置页一键替换 |
| feat | prd-admin | 设置页资源管理「首页资源」Tab 顶部新增「首页顶部 Banner」区块，未上传显示老图 + 默认徽标 |
| feat | prd-admin | LandingPage heroBgUrl 改走 useHeroBgUrl hook（订阅 store + ?v= 缓存爆破），上传即时生效 |
| feat | prd-admin | 个人公开页 `/u/:username` 新增「装修」面板：访问自己的公开页可编辑自我介绍（最多 500 字）与切换 8 种背景主题（极光/日落/森林/深海/紫罗兰/樱粉/极简/墨黑） |
| feat | prd-admin | 公开页各领域卡片新增内容预览：文档显示主条目标题+摘要；提示词显示前 240 字；工作空间显示封面图；涌现显示种子预览；工作流显示节点数+前 5 个节点类型链 |
| feat | prd-admin | 公开页自助撤回：访问自己公开页时每张卡片悬浮「取消公开」按钮，二次确认后调用对应 unpublish/visibility 端点，即时从列表移除 |
| feat | prd-api | User 模型新增 `Bio` + `ProfileBackground` 字段，支持 `PATCH /api/profile/public-page` 更新 |
| feat | prd-api | 公开页聚合接口双批次交叉查询：主 Task.WhenAll 后再批量解析 ImageAsset 封面 + DocumentEntry 主条目，避免 N+1 |
| feat | prd-api | 新增 3 个自助撤回端点：`POST /api/visual-agent/image-master/workspaces/{id}/unpublish`、`POST /api/emergence/trees/{id}/unpublish`、`POST /api/workflow-agent/workflows/{id}/unpublish` |
| feat | prd-admin | 公开页卡片重构为"首页作品广场"风格：统一的 `PlazaCard` 瀑布流 + 哈希渐变兜底 + NotebookLM 底部叠加文字，应用于视觉/文学/文档三域 |
| fix | prd-api | 视觉创作 workspace 封面兜底：当 `CoverAssetId` 未设置时，自动取该 workspace 最近创建的 ImageAsset 作为封面；并返回 `coverWidth/coverHeight` 驱动瀑布流自然比例 |
| fix | prd-admin | 公开页背景主题修复：从仅头部 40% 不透明扩展到全页固定环境光层（55% 不透明），让所有主题色（极光/日落/森林等）实际可见 |
| refactor | prd-admin | ShareDock 通用化：提取到 `components/share-dock/`，支持自定义 MIME + 槽位配置，头部可拖动位置 + 可收起成 36px 竖条，位置/折叠状态持久化到 sessionStorage |
| fix | prd-admin | 投放面板从右上角移到右侧垂直居中，不再遮挡筛选栏 / 视图切换按钮 |
| perf | prd-admin | 卡片拖拽从 HTML5 DnD 改为 Pointer Events（新增 `useDockDrag` hook），解决鼠标漂移/不跟手问题，支持触屏 |
| feat | prd-admin | `GlassCard` 新增 `onPointerDown` 道具支持 Pointer Events 自定义拖拽 |
| fix | prd-admin | ShareDock 槽位 hover 反馈加强：外发光 + 内发光 + 2px 高亮边框 + 1.06 缩放 + 呼吸光晕提示，ghost 缩小并偏移避免挡住 slot 光晕 |
| feat | prd-api | `/api/public/u/:username` 响应结构升级为多领域聚合：新增 skills / documents / prompts / workspaces / emergences / workflows 6 个公开资源列表，并行查询 |
| feat | prd-admin | 个人公开页 `/u/:username` 重写为多 Tab 布局：网页 / 技能 / 文档 / 文学提示词 / 视觉创作 / 涌现 / 工作流，每类独立卡片渲染 |
| feat | prd-admin | 公开技能卡片支持"下载"按钮：导出技能元信息为 JSON 文件（含 skillKey/title/description/tags + fork 导入提示） |
| fix | deploy | exec_dep.sh 优先探测宿主机已有 ffmpeg (/usr/local/bin/ffmpeg 等)，仅在不存在时下载静态版 |
| feat | prd-api | VideoAgent 新增 "videogen" 直出模式：通过 OpenRouter 视频 API 调用 Seedance / Wan / Veo / Sora，保留 Remotion 路径不变 |
| feat | prd-api | 新增 IOpenRouterVideoClient + OpenRouterVideoClient（异步 submit + 轮询，按秒计费） |
| feat | prd-api | VideoGenRun 模型新增 RenderMode / DirectPrompt / DirectVideoModel / DirectAspectRatio / DirectResolution / DirectDuration / DirectVideoJobId / DirectVideoCost 字段 |
| feat | prd-api | VideoGenRunWorker 新增 ProcessDirectVideoGenAsync 分支，不影响原 Scripting/Rendering 流程 |
| feat | deploy | docker-compose.yml + dev.yml 注入 OpenRouter__ApiKey 与 OpenRouter__BaseUrl 环境变量 |
| feat | prd-admin | VideoAgentPage 顶部新增模式切换条（分镜模式 / 直出模式），Remotion 原流程保留不变 |
| feat | prd-admin | 新增 VideoGenDirectPanel 沉浸式直出面板：prompt 输入 + 模型/时长/比例/分辨率选择 + 实时进度 + MP4 内嵌播放 |
| feat | prd-api | VideoGen 加入 BaseTypes（四大分类 → 五大基础类型）|
| feat | prd-api | 新增 AppCallerRegistry.VideoAgent.VideoGen.Generate = "video-agent.videogen::video-gen" |
| refactor | prd-api | OpenRouterVideoClient 改走 ILlmGateway.SendRawAsync，API Key 从平台管理读取，不再依赖 OPENROUTER_API_KEY 环境变量 |
| refactor | prd-api | VideoGenRunWorker.ProcessDirectVideoGenAsync 调用新 client 签名（AppCallerCode 驱动）|
| feat | prd-admin | 模型选择模态框新增「视频」tab，Film 图标，点击过滤出视频生成模型 |
| feat | prd-admin | cherryStudioModelTags 新增 isVideoGenModel 判定 + video_generation tag |
| feat | prd-admin | VideoGenDirectPanel 模型下拉新增「自动（由模型池决定）」选项 |

### 2026-04-16

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | FU-02 新增 MongoAuthStore：CDS_AUTH_BACKEND=mongo 持久化用户 session，重启不掉登录态 |
| fix | cds | LIM-07 补回拓扑视图 "Volume / 持久化卷" + Add 菜单入口，调用 openInfraAddModal() |
| feat | cds | FU-03 完成:stack-detector 加 nixpacks 风格框架推断层,覆盖 Next.js / NestJS / Express / Remix / Vite+React / Django / FastAPI / Flask / Rails 9 种框架,返回 framework/suggestedRunCommand/suggestedBuildCommand 可选字段 + 20 条新测试 |
| refactor | cds | FU-04 完成:WorktreeService 路径从 `<base>/<slug>` 改为 `<base>/<projectId>/<slug>`(两个项目同名分支不再碰撞),新增启动期 symlink 迁移(fallback rename) + state.worktreeLayoutVersion 幂等守卫 + 7 条新测试,保持 multi-repo-clone smoke 绿色 |
| feat | cds | GAP-11:拓扑 Details 面板 Deploy 按钮在多 profile 分支下变成 split-button,▾ 下拉列出每个服务,点击调 `deploySingleService(branchId, profileId)` —— 之前只能整分支部署 |
| feat | cds | GAP-12:分支 `status === 'error'` 时显示 Reset 按钮(琥珀色,刷新图标),点击调 `resetBranch(branchId)` 清除错误标记 |
| feat | cds | GAP-13:拓扑 Details "备注" tab 的标签从只读变为可编辑 —— 每个 tag 带 × 删除按钮调 `removeTagFromBranch`,末尾 "+ 标签" 调 `addTagToBranch`,"批量编辑"按钮调 `editBranchTags`。未选分支时回退只读 |
| feat | cds | GAP-14:拓扑 Details 面板新增"提交历史"按钮,弹出 portal 模态框展示 `/branches/:id/git-log` 返回的 15 条提交,点任一提交调 `checkoutCommit` 切换到该 commit 重建 |
| feat | cds | GAP-15:拓扑 Settings tab 的"部署模式"区块从只读列表变为可点击菜单 —— 每条模式行点击调 `switchModeAndDeploy(branchId, profileId, modeId)`,当前激活模式前加绿色  |
| feat | cds | GAP-16:拓扑顶栏新增手动刷新按钮(位于 "列表\|拓扑" 切换 pill 前),点击调 `refreshAll()` + 本地 `.spinning` class 让 svg 旋转反馈,不用等 5 秒轮询 |
| docs | cds | 新增 `doc/design.cds-fu-02-auth-store-mongo.md` —— FU-02 MapAuthStore mongo 后端的独立设计稿:接口 / 数据模型(cds_users + cds_sessions)/ 启动时按 CDS_AUTH_BACKEND 分发 / memory→mongo 迁移策略(接受一次重登)/ 测试计划 / 回滚路径。下一棒可直接按此稿实施,不需要先设计 |
| docs | cds | 新增 `doc/report.cds-railway-alignment.md` —— 逐条对齐 Railway 范式的 7 大类 + 我们独有的 10 个护城河特性 + 完成度量化:日常可用性 92% / 按功能权重 73%。明确下一步建议 FU-02 → P5 → P6 顺序推进,不要反过来 |
| docs | cds | 新增 `doc/report.cds-handoff-2026-04-16.md` —— 本 session 完整交接报告(8 章):commit 时间线 / UF×22 GAP×16 L10N×3 FU×4 TEST×2 交付清单 / 关键文件:行号索引 / 已知限制 / 人工验收 11 步清单 / 下一棒优先级建议 / 关联文档地图 |
| docs | cds | 更新 `doc/plan.cds-roadmap.md` v1.0 → v1.2 —— 把"本次迭代"改为"已完成";Phase 0/1 全部 ;Phase 2 多项目  + 模板库  未启动;Phase 3  未启动 |
| docs | cds | 更新 `doc/plan.cds-multi-project-phases.md` P5/P6 注记 —— P5 前置依赖明确为 FU-02(不能并行);P6 和 Phase 3 release agent 作用域边界需独立评审 |
| docs | cds | tighten `doc/guide.cds-view-parity.md` §5 smoke runbook —— 每个步骤加 "操作 · 预期 · 失败判定 · 失败回归的 UF 编号" 四栏;新增 §5.5 出错回报模板(给下一棒填空);新增 §5.6 已知未覆盖角落(iPad / Windows / 大仓库 / key 轮换) |
| fix | cds | 替换所有 emoji 为 SVG 图标（topology 面板、infra 选择器、分支列表、提示文本等 40+ 处） |
| fix | cds | 修复项目卡片 READY 徽章与删除按钮重叠：删除按钮移入 flex header，去除绝对定位 |
| fix | cds | 孤儿分支清理由串行 for-of 改为 Promise.all 并行，缩短多分支清理耗时 |
| fix | cds | build-profiles 接口不再要求 command 字段非空（auto-detect 场景 command 可为空字符串） |
| fix | cds | topology 拓扑图：节点布局改为上下方向（入口在上，数据库在下），新增应用虚线分组框，左侧导航新增视图切换图标，右侧面板添加/关闭按钮不再重叠 |
| fix | cds | 新增 .topology-app-group 和 .topology-fs-leftnav-label CSS 类，修复未定义样式导致渲染异常 |
| fix | cds | 修复 topology 布局：admin(app)被错放底部 infra 行，改用强制 2 层布局确保所有 app 节点在顶部 |
| feat | cds | topology 节点可拖拽：鼠标拖动单个节点，边线实时跟随；复位按钮清除拖拽偏移 |
| feat | cds | topology 分组框增加 GitHub+Apps 标签；初始缩放从 1.5x 降为 0.75x，加大 margin |
| feat | cds | topology 左侧设置图标改为打开系统设置菜单（含导出/自动更新/清理），不再跳转 settings.html |
| fix | cds | 隐藏 topology 全屏模式下面板标签栏的原生横向滚动条（scrollbar-width: none） |
| feat | cds | Activity Monitor 整合入右侧面板：全屏模式隐藏浮动 Activity，左侧导航新增「活动」入口，右侧面板新增「活动」标签展示 CDS/Web 实时日志，新事件自动推送到面板 |
| refactor | cds | topology 左侧导航重构：弃用单一「设置」弹出菜单，改为分段 icon 按钮（导航 / 项目级工具 / 系统级工具），每个功能直接可点 |
| fix | cds | 右侧面板关闭按钮（X）：图标扩大为 18px，边框改为 text-muted 颜色，字色改为 text-primary，确保在任何背景下清晰可见 |
| fix | cds | topology 画布添加 touch-action:none 防止系统触控惯性干扰自定义拖拽；左侧导航添加分段分隔线 |
| feat | cds | topology 聚合视图新增每分支独立虚线框：每列（每个分支）用带分支名 label 的虚线圆角框圈出 api+admin，移除冗余的卡片内 @branchLabel 标签，TOPO_SECTION_GAP_Y 调大至 84 以容纳 label pill |
| fix | cds | 修复 topology/列表 4 处 onclick 静默失效：JSON.stringify 产生未转义双引号破坏 HTML 属性解析（topology 可添加/手动添加/Enter 键、列表手动添加、提交日志 checkoutCommit），统一改为 .replace(/"/g,'&quot;') |
| fix | cds | topology 点击"可添加"分支后新增 _topoAddAndSelect：关闭下拉 + addBranch + 自动切换视图到新分支（原来 addBranch 成功后仍停在共享视图） |
| feat | cds | topology 聚合视图（共享 B 型）改为分组换行布局：超过 4 个分支时自动折行（MAX_AGG_COLS=4），最大画布宽度固定为 4 列，_layoutTopologyAggregated 返回预计算 positions/svgW/svgH，_renderTopologySvg 双路支持；_topologyFit 自动适应视口 |
| perf | cds | topology 拖拽丝滑度对齐 VisualAgent：mousemove/pointermove 写 transform 改为 requestAnimationFrame 合帧（`_scheduleTopologyTransform`），一帧最多一次 DOM 写入；画布 `will-change:transform + contain:layout style` 上 compositor 层；mouse 事件全量迁移 pointer 事件 + `setPointerCapture` 修复 1cm→5cm 漂移 + 指针离窗后失联 |
| fix | cds | 面板关闭按钮 SVG 改为  文字字符，彻底消除 fill:currentColor 继承透明的顽疾 |
| refactor | cds | topology 左侧导航主次分离：刷新（最高频）移入项目级区段，导入/更新/清理/项目列表折入「设置」系统级 popover；移除 topbar 多余刷新按钮 |
| fix | cds | CSS 强制 `.topology-fs-leftnav-icon svg { width:20px; height:20px }` 覆盖任意 HTML 属性，彻底根治 icon 偏小反复出现问题 |
| fix | cds | topology window 级 pointer 监听改为一次性绑定（`_topologyWindowListenersBound` 防止每次 renderTopologyView 叠加句柄），长会话无句柄泄漏 |
| fix | cds | topology 状态点动画去掉 `transform:scale(1.25)` — SVG `<circle>` 不遵守 CSS `transform-origin:center`，scale 导致橙色圆点溢出卡片边界抖动；改为纯 opacity 呼吸动画 |
| feat | cds | 共享视图（B 型聚合）：无分支选中 + 有已追踪分支时，展示所有分支 × 所有 BuildProfile 实例，共享同一套基础设施；每张卡片右上角显示 @branchId 标签；点击任一实例自动切换至对应分支并打开服务面板 |
| fix | cds | 宿主机 CPU/MEM 浮动气泡在拓扑全屏模式下隐藏，改为嵌入顶部 topbar 的内联 pill（`topology-fs-hoststats`），不再遮挡画布内容 |
| fix | cds | topology 单分支 DAG 视图的 Apps 框改为显示当前分支名 `@branchId`，与聚合视图保持一致 |
| fix | cds | 刷新页面进入共享视图后打开分支下拉不再自动切换到主分支（删除 _topologyAutoSelectPending 逻辑） |
| fix | cds | topology 部署日志 tab 不再被 updateInlineLog 强制跳回详情 tab（仅在已处于 details tab 时才重渲染） |
| fix | cds | modal z-index 从 100 提升至 500，彻底解决 topo-sys-popover（z-index:200）遮盖弹窗的重叠问题 |
| fix | cds | CDS 系统更新弹窗简化：默认直接更新当前分支，移除分支切换下拉（改为 <details> 折叠的高级选项），清理误导性"更新所有"按钮 |
| fix | cds | 移除"网络流"tab（eBPF/tcpdump 未实现的占位符），避免用户看到无内容页面以为功能异常 |
| fix | cds | topology 节点拖拽双重叠加 bug：_topologyNodeDragStart 的 group transform 改为仅含当前帧增量（ddx,ddy），不再重叠已嵌入坐标的 baseOffset，拖拽实时跟手 |
| fix | cds | 去除 .topology-node 的 transform transition（0.12s ease），消除 SVG 节点拖拽时的动画延迟；环境变量面板眼睛图标颜色由 text-muted 改为 rgba(255,255,255,0.35)，hover 态增强至 0.65，svg 固定 14×14 确保清晰可见 |
| fix | cds | 共享视图单击节点不再跳转到单分支 4 节点视图：引入 _topologyKeepSharedView 标志，点击聚合节点只打开面板（含分支上下文），用户须通过顶部 chip 显式切换分支 |
| fix | cds | 项目卡片服务图标替换为 Simple Icons 准确品牌 SVG（Nginx N 字路径、Node.js 官方 hexagon、MongoDB 叶子、Redis 几何图形），颜色对齐官方品牌色 |
| fix | cds | detect-stack 失败（400/500）由抛错改为非阻断警告，链条继续进入「手动配置」路径，不再显示恐慌性红色 [chain-error] |
| feat | cds | exec_cds.sh init 新增 Phase 3 MongoDB 初始化：交互式询问是否启动 Docker MongoDB 8 容器，自动追加 CDS_MONGO_URI/CDS_STORAGE_MODE=mongo/CDS_AUTH_BACKEND=mongo 到 .cds.env，一键完成持久化数据库配置 |
| fix | cds | topology 添加分支后不跳转：_topoAddAndSelect 改为同步设置 _topologySelectedBranchId + await _topologySelectBranch + 调用 _topologyFit()，确保添加后立即切换到新分支单视图；_topologySelectBranch 对 profile-overrides 404（新分支无覆盖属正常）不再弹错误 toast |
| fix | cds | 项目卡片删除按钮彻底修复：button-in-anchor 是无效 HTML（部分浏览器点击导航而非删除）；改为 cds-project-card-wrapper div 包裹，删除按钮移至 <a> 外侧，position:absolute top:12 right:12，hover 触发器改为 .wrapper:hover，card-head 增加 padding-right:36px 避免标题与按钮重叠 |
| fix | cds | 删除按钮第三轮修复：projects.js 注入 CSS patch（兜底两种选择器应对浏览器 JS/HTML 版本缓存错位）；SVG fill 改为硬编码 #f43f5e 消除 currentColor 继承透明；server.ts HTML 文件返回 Cache-Control: no-store；projects.html script 标签改用 document.write 方式彻底 cache-bust |
| feat | cds | 顶部导航栏新增快捷配置按钮：构建配置 / 环境变量 / 基础设施（运行时绿点状态）/ 路由规则，无需打开齿轮菜单直接点击访问 |
| feat | cds | projects.html 侧边栏 logo 行新增主题切换按钮（亮/暗模式），解决浅色主题下按钮不可见问题 |
| fix | cds | topology 右侧面板"公开地址"和"DEPLOYED VIA GIT"修复：displayBranch 优先使用已选分支而非第一个运行中分支，解决添加新分支后面板仍显示 main.miduo.org 的问题 |
| fix | cds | topology 切换分支时若右侧面板已打开则自动重渲染面板内容，解决分支切换后面板信息不同步的问题 |
| fix | prd-admin | 模型管理页显示虚拟中继平台下的模型列表：从 Exchange.models 合成虚拟 Model 条目，修复"0 个模型 / 暂无模型"展示错乱 |
| fix | prd-admin | 模型管理页检测到虚拟中继平台时隐藏 添加模型 / 管理 / 删除平台 / 内联编辑，提示用户到「模型中继」页编辑 |
| fix | prd-admin | 模型管理页右侧面板：虚拟中继平台隐藏 API 密钥/地址内联编辑，改为可点击的「前往编辑」跳转按钮 |
| fix | prd-admin | 模型管理页右键菜单：虚拟中继平台显示「在「模型中继」页编辑」代替编辑/删除选项 |
| fix | prd-admin | 模型管理页启用切换 / 右侧启用 toggle：虚拟中继平台调用正确路径（跳转至中继管理 tab），不再错误调用真实平台 API |
| fix | prd-admin | 模型管理页底部操作栏：将静态提示文案改为可点击跳转「在「模型中继」页编辑」按钮（含 Link2 图标） |
| fix | prd-admin | 模型管理页左侧平台列表：宽度 256px → 320px，启用按钮加 shrink-0，修复按钮被挤出容器被裁剪的问题 |
| fix | prd-admin | 模型管理页操作按钮组：Exchange 合成模型屏蔽「设为主/意图/识图/生图」按钮（静默失败回源的根因），点击提示"通过应用模型池绑定" |
| fix | prd-api | 修复模型探针对 generation 类型永远失败的设计缺陷，跳过图片生成池探活，默认间隔调整为 180s/600s |
| feat | prd-api | 团队排行榜新增视觉生图、文学配图、上传参考图三个用量维度（image_gen_runs + upload_artifacts） |
| feat | prd-admin | 排行榜前端新增 image-gen-visual / image-gen-literary / image-upload 三列维度展示 |
| fix | prd-api | 探针后台服务默认关闭；PoolHealthTracker 内建 Half-Open 熔断器（5分钟冷却后由真实用户请求自动探活，零后台线程）|
| feat | prd-admin | GAP-10 Phase 1：将画布状态色（running/completed/failed/paused）、边框色、连线色、动画时长抽成 CSS 自定义属性，追加到 tokens.css；workflow-canvas.css 消费新变量，不再硬编码 rgba 颜色值 |
| feat | cds | P5 Phase 1：新增 CdsWorkspaceMember / CdsWorkspaceInvite 域类型；AuthStore 接口扩展成员/邀请方法；MemoryAuthStore + MongoAuthStore 实现；新增 WorkspaceService；新增 /api/workspaces 路由（CRUD + 成员管理 + 邀请流程）；Project 类型新增 workspaceId 字段；前端工作区 pill 从 /api/workspaces 动态加载 |
| fix | cds | IAuthMongoHandle 新增 membersCollection / invitesCollection；RealAuthMongoHandle 实现对应集合 |
| feat | prd-admin | 网页托管页右上角新增"投放面板"（ShareDock），拖拽站点卡片到 公开 / 分享 / 回收站 三个槽位即可一键操作，交互参考 macOS Dock 安装隐喻 |
| feat | prd-admin | 新增 `/u/:username` 个人公开主页（无需登录），聚合展示用户所有 Visibility=public 的托管网页，支持封面、浏览量、标签展示 |
| feat | prd-api | HostedSite Model 新增 `Visibility`（private/public）+ `PublishedAt` 字段；新增 `PATCH /api/web-pages/:id/visibility` 端点切换可见性 |
| feat | prd-api | 新增 `PublicProfileController.GetProfile`（`GET /api/public/u/:username` `[AllowAnonymous]`），按用户名聚合公开托管站 |
| feat | prd-api | 新增 `InboxItem` Model 骨架 + `inbox_items` 集合注册（跨系统数据导入通道，Controller/Service/Device Flow 留待下次迭代开发） |

### 2026-04-15

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | UF-02 回归:`bootstrapMeLabel()` 改为幂等可重入,Device Flow ready 后主动刷新左下角徽章;未解析状态 tooltip 带诊断字符串指向哪个 probe 失败;HTML placeholder 从"未登录"改"加载中…"避免 initial flash 误导 |
| feat | cds | UF-09:Topology Variables tab 支持继承+覆盖 —— 按 branchId 拉 `/profile-overrides`,每行左侧眼睛 toggle(闭眼=继承,开眼=覆盖,橙色=CDS 基础设施锁定),右侧 value input 400ms debounce PUT 写回 branch override;共享视图回退只读 + 提示"选分支切可覆盖模式" |
| fix | cds | UF-10:拓扑视图点"编辑"不再跳回列表 —— `_topologyPanelOpenEditor`/`_topologyPanelOpenLogs`/`_topologyChooseAddItem` 三处删除 `setViewMode('list')`,全部 in-place 调用 `openProfileModal`/`openRoutingModal`/`openInfraModal`/`openLogModal`;同时替换不存在的 `renderBuildProfiles`/`renderRoutingRules` 遗留符号 |
| feat | cds | GAP-04:Topology Details 面板新增"路由"tab,按 profileId 过滤 `routingRules` 展示所有命中规则,编辑按钮 in-place 调 `openRoutingModal` |
| feat | cds | GAP-05:Topology Details 面板 Settings tab 新增"部署模式"区块,遍历 `entity.deployModes` 展示每条策略 |
| feat | cds | GAP-06:Topology Details 面板 Settings tab 新增"集群派发"区块,遍历 `executors` 展示主/远端节点 |
| feat | cds | GAP-07:Topology Details 面板新增"备注"tab,渲染 `entity.notes` + `entity.tags` 自由文本,编辑按钮 in-place 打开 profile 编辑器 |
| feat | cds | GAP-08:Topology 节点卡片右下新增可交互端口 pill,单击复制 `host:port` + toast,双击已选分支时走 `previewBranch`,否则开新标签访问 raw `host:port` |
| feat | cds | GAP-09:拓扑视图预览入口风格与列表对齐 —— 端口 pill 承担 Quick Action 角色,hover 切 accent 色 + 图标反馈 |
| feat | cds | L10N-02:`app.js` 中 Railway 术语汉化 —— "Service is online"→"服务运行中","PUBLIC URL"→"公开地址","CONNECTION STRINGS"→"连接串","SERVICE INFO"→"服务信息","Service Variables"→"环境变量","Host view/Container view"→"宿主机视角/容器视角","GitHub Repository/Database/Docker Image/Routing Rule/Empty Service"→"GitHub 仓库/数据库/Docker 镜像/路由规则/空服务";Details 面板 7 个 tab 全部改中文标签 |
| feat | cds | L10N-03:`projects.html` 汉化 —— 页面 title、"Projects/New/Dashboard/System/Personal"→"项目列表/新建项目/控制台/系统/个人工作区","Sort by: Recent Activity"→"按最近活跃排序" |
| feat | cds | FU-01:Repo Picker 分页 —— `fetchUserReposPage(token, page)` 新增,解析 GitHub `Link` header 的 `rel="next"`;`/api/github/repos?page=N` 路由返回 `{repos, hasNext, page}`;前端 Repo Picker 末尾渲染"加载更多(第 N 页)"按钮,点击追加下一页 |
| feat | cds | FU-05:Device Flow token AES-256-GCM 加密 —— 新增 `cds/src/infra/secret-seal.ts` 提供 `sealToken`/`unsealToken`,从 `CDS_SECRET_KEY` 环境变量派生密钥(支持 64-hex / base64 / SHA-256 passphrase 三种格式);`state.ts setGithubDeviceAuth` 写入前密封,`getGithubDeviceAuth` 读取时透明解密;未设置密钥时回退明文(向后兼容旧 state.json) |
| test | cds | 新增 `tests/infra/secret-seal.test.ts` 16 条单元测试,覆盖密封/解封/round-trip/tamper-detect/key-rotation/passphrase 派生/向后兼容路径;测试总数 543 → 560 |
| fix | cds | UF-14: 修复控制台反复刷屏 `SyntaxError: Unexpected end of JSON input` —— `api()` 从 `await res.json()` 改为 text-first + JSON.parse + 明确的 `isTransient` 错误标记,204/205/304 直接返 `{}`;`loadBranches` 轮询期间的瞬态错误静默吞掉,服务重启/代理 502 不再污染 console |
| fix | cds | UF-15: 修复拓扑顶栏"列表\|拓扑"切换被"+ Add"按钮遮挡 —— `.topology-fs-topbar` 的 `right` 从 16px 改为 132px,为右上角的 + Add 浮动按钮预留空间,两个控件不再共享同一 x 坐标区间 |
| feat | cds | UF-16: 拓扑 Details 面板 Deploy/Stop/Delete 按钮实时反馈 —— 点击后按钮立即变 disabled + 旋转 spinner + 文字改"部署中…/停止中/删除中",状态横幅变琥珀色 + 脉冲呼吸,横幅下方滚动最近 8 行实时日志预览(点击展开完整 modal),SSE 每块 chunk 到达都更新 DOM,列表视图和拓扑视图共用同一个 `inlineDeployLogs` Map,任一视图发起的部署在另一视图也能看到进度。新增 `_topologyRefreshIfVisible(id)` 助手,在 deploy/stop/remove 开始和结束时主动刷新拓扑面板,不用等 5 秒轮询 |
| fix | cds | UF-17: 修复拓扑顶栏在列表视图也显示(重叠) —— 上一轮 UF-15 为了防止 + Add 覆盖而给 `.topology-fs-topbar` 加了 `display:flex !important`,无意中把 `display:none` base rule 也干掉了,导致列表视图也能看到漂浮的 `列表\|拓扑` toggle ghost UI。现在去掉该 !important,依赖 `body.cds-topology-fs` 作用域;同时独立 scope `.topology-fs-view-toggle` 以防未来再出类似问题 |
| fix | cds | UF-18: 修复控制台继续报 `HTTP 400 空响应` —— 之前只有轮询的 transient 错误静默,非轮询(如 deploy 后的 `loadBranches()` refresh)仍然 log。现在 `err.isTransient` 标记所有 4xx/5xx 空响应,`loadBranches` 对 isTransient 错误静默并自动 1.5s 后重试一次,不再污染 console |
| fix | cds | UF-19: 修复拓扑 Details 面板无法关闭 —— 原因是 `+ Add` 浮动按钮(z-index 70)覆盖了面板右上角的关闭 X(panel z-index 68)。现在:(1) 面板打开时 `+ Add` 自动隐藏;(2) ESC 键关闭面板;(3) 点击画布空白处关闭面板(Figma/Miro 式);(4) 关闭按钮换用带边框的方形按钮,hover 红色强调,不再是透明小图标 |
| fix | cds | UF-20: 修复部署日志 tab 显示原始 HTML 源码 —— 根因是客户端用 `GET /api/branches/:id/container-logs?profileId=X`,但服务器只暴露 `POST /api/branches/:id/container-logs`(profileId 在 body)。GET 没有匹配路由就掉到 Express 的静态文件 SPA fallback,返回 `index.html` 当"日志"渲染。现在改为正确的 POST + `{profileId}` body,同时加 defensive guard:若 content-type 是 HTML,直接显示"服务器返回了 HTML"错误提示而不是渲染源码 |
| feat | cds | UF-21: 拓扑节点卡片图标升级 —— 废弃 emoji( 等),换成 7 个真实 SVG brand logo:GitHub(应用服务统一用)、MongoDB(绿叶 + 根茎)、Redis(多层立方体)、PostgreSQL(蓝色象)、MySQL(海豚混合)、Nginx(绿 N)、Kafka(节点图)、通用 DB 兜底。应用服务一律显示 GitHub 图标(匹配 Railway 参考图),具体栈语言在镜像 tag 行体现。底部 volume 槽的  也换成矢量硬盘图标(2 个 LED 灯加水平分割线) |
| feat | cds | UF-22: 拓扑节点卡片在部署中的实时动画 —— 当分支处于 building/starting 状态或 `busyBranches.has(id)` 为真时,节点卡片边框变琥珀色 + 呼吸脉冲光晕,状态圆点也同步脉冲放大。错误态固定红色边框不动(和部署中的琥珀脉冲区分开)。`_topologyNodeStatus` 也加强了:分支级 `status='building'` 就返回 building,不再等 per-service 状态出来才显示(第一个 chunk 前就有反馈) |
| fix | cds | UF-01: 修复私有仓库 clone 时 `could not read Username` 英文报错无引导 —— 新增 clone 预检(github.com URL + 未登录 Device Flow 时 UI 警告)、git 错误翻译(映射认证失败为中文可操作提示),并加固 `setGithubDeviceAuth` 通过 mongo 写回 flush 防止持久化静默失败 |
| fix | cds | UF-02: 左下角用户徽章增加 GitHub Device Flow 用户识别 —— `bootstrapMeLabel()` 在 `/api/me` 返回空时降级查 `/api/github/oauth/status`,已完成 Device Flow 的用户会看到 GitHub login 和头像 |
| fix | cds | UF-03: Topology 视图节点自动居中 —— 首次渲染调用 `_topologyFit()` 自适应缩放+居中,用户交互(滚轮/拖拽/缩放按钮)后切入手动模式不再自动修正,"1:1 复位"改为重新居中而非归零 |
| feat | cds | UF-04: 分支选择器支持手动输入/粘贴分支名 —— 按 Enter 直接创建,下拉框底部常驻"+ 手动添加"入口(不依赖 git refs 列表),placeholder 改为"搜索或粘贴分支名,按 Enter 添加" |
| test | cds | 新增 12 条单元测试覆盖 `_isGithubHttpsUrl` + `_mapGitCloneError` 两个新助手函数(projects-url-helpers.test.ts 从 15 增至 27),测试总数 529 → 541 全绿 |
| refactor | cds | UF-05: Topology 卡片样式对齐参考图(图1) —— 卡片几何从 236×110 → 280×150,统一圆角 18px,主体只留"图标+名称"和"状态圆点+状态",移除 image/port/deps 三行文字降低视觉密度;infra 服务附加底部 volume 槽(分割线 +  + 卷名);连线从三次贝塞尔曲线改为正交 HVH 路径 + 8px 圆角拐点 |
| feat | cds | UF-06: Topology 画布两指手势对齐 Mac 触控板标准 —— wheel 事件按 `ctrlKey/metaKey` 分流,有修饰键(捏合/Ctrl+wheel)走缩放,无修饰键(两指滑动)走平移。手势契约从 `prd-admin/src/pages/ai-chat/AdvancedVisualAgentTab.tsx:3267-3281` 移植,保证 CDS Topology 和 VisualAgent 操作手感一致。缩放公式改为指数平滑 `Math.exp(-deltaY * 0.01)` 不再受触控板 deltaY 绝对值影响 |
| feat | cds | UF-07: Topology 分支选择器替换原生 `<select>` 为自定义 combobox,支持输入/粘贴分支名 Enter 添加,下拉分区展示"已添加/可添加/手动添加",共用列表视图的 `addBranch()` 实现,保证两个视图的添加行为 1:1 一致 |
| feat | cds | UF-08: Topology 顶栏新增"列表 \| 拓扑"segmented control 视图切换 pill,删除 leftnav 中标签为"日志"但实际是视图切换的暗门图标;`setViewMode()` 同步两套 toggle 按钮的 active 状态 |
| feat | cds | GAP-01: Topology Details 面板动作栏加 Stop 按钮,点击调用共享 `stopBranch(id)`,无需切回列表视图就能停容器 |
| feat | cds | GAP-02: Topology Details 面板动作栏加 Delete 按钮,点击调用共享 `removeBranch(id)`(红色强调),无需切回列表视图就能删分支 |
| docs | cds | GAP-03: 确认 Topology Details "Variables" tab 本就在 P4 Part 7 完整实现了,矩阵标 resolved-prior,无代码改动 |
| feat | cds | L10N-01: Settings 页面汉化 30+ 英文残留,覆盖项目基础信息、存储后端、GitHub 集成、危险区四个 tab,按照规则保留 Docker/GitHub/URI 等技术术语不译 |
| test | cds | TEST-01 + TEST-02: 在 `tests/routes/github-oauth.test.ts` 新增两条 UF-01 回归 E2E —— (1) backing store save 抛异常时 device-poll 必须返回 500 不是假 ready,(2) 成功持久化后 `getGithubDeviceAuth()?.token` 能被 clone 路径读到。测试总数 541 → 543 |
| test | cds | 新增 `tests/integration/view-parity.smoke.test.ts` 端到端 smoke test —— 14 条断言真实启动 Express app + 命中列表视图和拓扑视图共用的所有 API 路径(/branches、/build-profiles、/infra、/routing-rules、/branches/:id/profile-overrides GET/PUT/DELETE、/github/oauth/status、/projects)。跑下来实际抓出 3 个假设错误(build-profiles 会 mask secret-like key / infra 响应是 `{services:[...]}` / POST /branches 需要真 git 仓库),全部已修,现在 574/574 绿 |
| docs | cds | 新增 `doc/guide.cds-view-parity.md` —— 列表视图 16 个动作 × 拓扑视图 9 个 tab + 11 个外壳元素的功能对齐全表;标出 6 个剩余 gap(GAP-11..16)留给未来对齐 |
| feat | prd-api | 新增 ChangelogController（GET /api/changelog/current-week + /releases），从仓库内的 changelogs/*.md 碎片和 CHANGELOG.md 解析代码级周报，支持 ?force=true 绕过服务端缓存 |
| feat | prd-api | 新增 IChangelogReader / ChangelogReader 服务：解析"| type | module | description |"表格行 + 版本块 + 用户更新项 highlights，本地源 5 分钟 / GitHub 源 24 小时双 TTL 缓存 |
| feat | prd-api | 更新中心数据源双通道：本地优先（dev 模式从 ContentRootPath 向上递归查找 changelogs/）+ GitHub 兜底（生产 Docker 用 Contents API 列目录 + raw.githubusercontent.com 下载内容，1 次 API 请求 + N 次 raw 下载，符合 60/h 匿名限流） |
| feat | prd-admin | 新增「更新中心」页面（/changelog）：本周更新 + 历史发布双区块，带类型/模块筛选 chip、时间轴布局、刷新按钮、数据源徽章（GitHub/本地仓库 + 「N 分钟前拉取」相对时间） |
| feat | prd-admin | 新增顶栏 ChangelogBell（ 图标 + 红点徽章 + popover），展示最近 5 条更新，"查看全部"跳转 /changelog；移动端顶栏挂载，桌面端用户头像下拉菜单新增"更新中心"项 |
| feat | prd-admin | 新增 changelogStore (Zustand persist)：lastSeenAt 时间戳持久化到 sessionStorage，selectUnreadCount/selectRecentEntries 选择器；遵守 no-localstorage 规则 |
| feat | prd-admin | 更新中心刷新按钮通过 ?force=true 透传到后端，触发后端缓存绕过 + 重新拉取 GitHub（用户主动刷新时立即看到最新数据） |
| feat | prd-admin | 百宝箱 BUILTIN_TOOLS 注册"更新中心"卡片（带 wip:true 施工中徽章），符合 navigation-registry 规则 |
| fix | prd-api | ChangelogReader 解析 CHANGELOG.md 时跳过 markdown 代码栅栏（``` / ~~~），避免把"维护规则"章节里的 ## [1.7.0] / ## [未发布] 文档示例当成真版本头解析（CDS 验证发现） |
| chore | .claude/rules | 新增 cds-first-verification.md 规则：本地无 SDK ≠ 无法验证，必须用 /cds-deploy 兜底，禁止把验证负担转嫁给用户 |
| feat | prd-admin | 首页 AgentLauncher 顶部快捷区从 3 张扩展为 4 张，新增「更新中心」卡片（带未读徽章），用 /home Hero 同款青/橙渐变 + 右上角光晕 + hover 辉光边框，层次感和点击预期显著增强 |
| refactor | prd-admin | 首页 Hero 重写：新增 eyebrow 标签（MAP · 米多智能体生态平台）、标题放大到 34px、用户名应用 /home Hero 的青→紫→玫红渐变、背景加 aurora 光晕，解决"缺乏层次感"问题 |
| refactor | prd-admin | 首页 section 标题统一为 SectionHeader 组件：eyebrow（大写标签）+ 主标题（18px）+ subtitle（描述文案）+ accent 渐变短横，取代原先 11px 灰色 uppercase 单行标签，引导感更强 |
| refactor | prd-admin | 用户头像下拉菜单大扫除：删除「修改头像」（与账户管理合并）+ 删除动态 menuCatalog 面板（网页托管/知识库/涌现/提示词/实验室/自动化/快捷指令/PR审查/请求日志等），只保留账户/系统通知/更新中心/数据分享/提交缺陷/退出 |
| feat | prd-admin | 首页实用工具区新增 4 个权限门控条目：提示词管理（prompts.read）、实验室（lab.read）、自动化规则（automations.manage）、请求日志（logs.read），承接从用户菜单迁出的工具类导航 |
| feat | prd-admin | 首页新增 HomeAmbientBackdrop 环境光层：3 个巨大 radial-gradient 色块（紫/青/玫红 8% 透明度 + blur 60px）+ 顶部 50vh 白色椭圆聚光 2.5% + 全局 SVG feTurbulence film grain 3% opacity mix-blend overlay，解决"首页阴沉死黑、缺乏透气感"问题（纯 CSS，0 JS，0 动画） |
| feat | prd-admin | 首页 AgentLauncher 新增进场动效：复用 /home Reveal 组件但 duration 减半到 1000ms（2x 快），按视线顺序编排 — Hero eyebrow→标题→subtitle→search (0/50/100/150ms) → 4 张快捷卡 50ms cascade → AGENTS section header (430ms) → Agent 卡片 35ms cascade → UTILITIES (800ms) → Utility 卡片 25ms cascade → SHOWCASE (滚到视口触发)，总长 ~1800ms |
| feat | prd-admin | 新增 NavigationProgressBar 顶栏路由切换进度条：解决 dev 模式下点击侧栏导航后 Suspense fallback 被 React 18 transition 语义吞掉导致的"卡住 2 秒无反应"问题。通过 useLocation 监听路由变化（不依赖 Suspense），location 变更瞬间立刻显示 3px 高渐变条（青→紫→玫红 + glow），爬升曲线 15%→40%→60%→80%→90%（总计 2s 爬到 90% 卡住），requestIdleCallback 检测浏览器空闲时完成到 100% 并淡出，4s 超时兜底。mount 在 App.tsx 根部，全局生效 |
| fix | prd-admin | NavigationProgressBar 根因修复：useLocation() 在 React Router v6 非 data router 模式下受 React 18 transition 语义影响，navigate() 时新 location 被 hold 直到 lazy import 完成，导致 useEffect 根本没在 t=0 fire。改为 monkey-patch window.history.pushState / replaceState 在原生 API 层拦截，dispatch 'map:navstart' 自定义事件，进度条监听该事件 —— 早于 React 任何 render 逻辑获得信号，修复"进度条落后于页面加载"的时序问题 |
| fix | prd-admin | NavigationProgressBar 两个视觉 bug 修复：(1) requestIdleCallback 在 React hold transition 期间浏览器空闲立刻 fire 导致 finish() 过早触发 → 增加 MIN_DURATION=1500ms 硬下限，idleReceived + minReached 双条件才真 finish；(2) 完成后 setProgress(0) 重置触发 width 反向动画在 opacity 淡出期间可见 → 完成后停在 100% 永不反向，下次 navstart 时用 animating=false 瞬时 snap 到 0%（在 opacity 为 0 时不可见）。修复"一瞬间过去然后退回来"的诡异动画 |
| refactor | prd-admin | 全量迁移老式加载指示器到 @/components/ui/VideoLoader 统一组件体系：30 个文件批处理，16 处 block-level（原先是 flex-center 容器 + MapSpinner/Loader2 + "加载中..."文案）统一替换为 MapSectionLoader（展示 MAP 品牌字母扫光动效），28 处 inline（按钮/行内 icon）从 lucide-react Loader2 统一替换为 MapSpinner；清理 16 个残留的 Loader2 import。涉及工作流（WorkflowAgentPage 等 3 个）、技能创建助手（SkillAgentPage 12 处）、PR 审查（7 个文件）、评审 Agent（3 个）、涌现探索、智识殿堂、LLM 日志、数据管理、转录工作台、百宝箱直连对话等 |
| fix | prd-api | ExchangeController 修复 JsonSerializerOptions 未指定 TypeInfoResolver 导致 JsonArray 原始类型序列化抛异常（原因：project 启用了 AOT source-gen，裸 `new JsonSerializerOptions { WriteIndented = true }` 缺失 resolver） |
| feat | prd-api | ModelExchange 新增 Models:List<ExchangeModel> 字段，中继升级为"虚拟平台"：一条 Exchange = N 个模型 |
| feat | prd-api | PlatformsController GET /api/mds/platforms 返回合并列表（真实平台 + 虚拟中继平台, kind:"real"\|"exchange"） |
| feat | prd-api | PlatformsController GET /{id}/available-models 同时支持 Exchange.Id 查询，返回其 Models 列表 |
| feat | prd-api | ModelResolver 新增按 Exchange.Id 查找分支，同时保留"__exchange__" 旧路径，向后兼容 |
| feat | prd-api | ExchangeController 新增 POST /exchanges/{id}/models/{modelId}/try-it 一键体验端点 |
| feat | prd-api | ExchangeController /for-pool 返回真实 Exchange.Id 作为 platformId，不再是硬编码 __exchange__ |
| feat | prd-api | gemini-native 模板预置 5 个结构化模型（chat + generation 混合） |
| feat | prd-admin | 中继管理页重构：表单新增"模型列表"区域（ModelId / 显示名 / 类型 / 启用），取代扁平的别名文本框 |
| feat | prd-admin | 中继卡片展示模型表格，每行一个"一键体验"按钮（调用 try-it 端点）|
| feat | prd-admin | Platform 类型新增 kind/isVirtual 字段；ModelPoolManagePage 不再硬编码合成 "__exchange__" 虚拟平台 |
| fix | prd-admin | PlatformAvailableModelsDialog 通过 platform.kind 识别虚拟中继，不再依赖 "__exchange__" 魔术字符串 |
| feat | prd-api | ModelExchange 新增 ModelAliases 字段，支持一个中继承接多个模型（Provider 级别） |
| feat | prd-api | ModelExchange.TargetUrl 支持 {model} 占位符，LlmGateway 在调度时自动替换为实际模型 ID |
| feat | prd-api | 新增 GeminiNativeTransformer，支持 Google Gemini 原生协议（OpenAI↔Gemini 请求/响应互转 + 文本/图像双模态） |
| feat | prd-api | LlmGateway 认证方案新增 x-goog-api-key（Google Gemini 原生认证头） |
| feat | prd-api | ExchangeController 新增 Gemini 原生协议导入模板（预填 URL 模版 + 5 个 Gemini 模型别名） |
| feat | prd-api | ModelResolver Exchange 查找同时匹配 ModelAlias 与 ModelAliases 列表 |
| feat | prd-admin | Exchange 管理页新增「附加模型别名」输入框 + URL {model} 占位符提示 |
| feat | prd-admin | Exchange 卡片展示附加别名列表（可点击复制） |

### 2026-04-14

| 类型 | 模块 | 描述 |
|------|------|------|
| docs | doc | 刷新「Agent 开发入门指南」：覆盖 3-27 至 4-14 的 532 个提交带来的能力变化——新增阶段 -1（涌现发散）和阶段 5（完工总结）、补齐 8 个新技能（`/emerge` `/plan-first` `/uat` `/dev-report` `/create-executor` `/bridge` `/deep-trace` `/fix-surface`）、新增"涌现思维"章节阐述反向自洽与三维涌现模型、Agent 速览补 review-agent + pr-review + 转录工作台、铁律从 5 条扩展到 7 条（导航注册默认百宝箱 + 无根之木禁令）、术语表新增 12 个新概念 |
| fix | prd-api | docker-compose.yml / docker-compose.dev.yml 的 api 服务补上 GitHubOAuth__ClientId / ClientSecret / Scopes 三个环境变量映射（docker compose 不会自动转发宿主机 env，必须显式声明），修复 PR Review Agent 提示 "尚未配置 GitHub OAuth App" 的问题 |
| fix | prd-admin | GitHubConnectCard 未配置提示改写：补充 .env 文件写法 / .bashrc 改完需重开终端 / 需要重跑 exec_dep.sh 的操作指引 |
| fix | deploy | exec_dep.sh 独立部署模式修复 nginx 502：新增 deploy/nginx/conf.d/branches/_standalone.conf (内容同 deploy/nginx/nginx.conf 的 /api → api:8080 反代)，exec_dep.sh 每次部署都幂等重建 default.conf → branches/_standalone.conf 的 symlink，修复纯净机器首次部署后所有 /api/* 都被仓库默认的 _disconnected.conf 拦成 {"error":"No active branch connected"} 的问题 |
| docs | docker-compose.yml | gateway 服务注释补齐三种部署模式（standalone/cds/disconnected）下 default.conf symlink 的指向规则，避免下一位部署者再次踩坑 |
| feat | prd-admin | 首页品牌更新：顶栏/底栏/Hero HUD 品牌名统一为「米多智能体生态平台」(Midoo Agentic Platform)，Hero 副标题替换为 MAP 官方定义，传递「企业级数字劳动力平台 · 碳硅共生」的核心定位 |
| fix | prd-admin | 首页 Hero 副标题排版收敛：容器 max-w-2xl → max-w-3xl、字号 clamp(0.95rem,1.2vw,1.125rem) → clamp(0.85rem,0.95vw,1rem)，解决长段定义换行产生尾行孤字、视觉权重压过 CTA 的问题 |
| fix | prd-admin | 智识殿堂文档阅读器（LibraryDocReader）补齐 remark-breaks 插件，保留单行换行符，避免纯文本/排版文档被 markdown 合并成一整段 |
| fix | prd-admin | 文档空间 /document-store 的 DocBrowser 同步补齐 remark-breaks 插件，修复 ASCII 框图/步骤箭头被压成一段的问题 |
| fix | prd-admin | 修复 LibraryDocReader/DocBrowser 代码块判断逻辑：原代码用 `language-` 类名判断 inline，导致未指定语言的 fenced code block（架构图/树形结构等）被错当成 inline 渲染成一颗颗药丸。改为按"内容含换行"判断块级 |
| fix | prd-admin | LibraryDocReader/DocBrowser 无语言 fenced 代码块跳过 Prism，改用纯 `<pre>` 渲染，消除 ASCII 框图上 Prism token 背景叠加导致的"多余背景色块"；同步 override `pre` 为 fragment 避免双重包裹 |
| fix | prd-admin | 举一反三：MarkdownContent（共享组件，周报/技能页等 5 处消费）和 ai-toolbox ToolDetail 的 AssistantMarkdown 存在同构 Bug A+B，同步修复（含 `pre` fragment override） |
| fix | prd-admin | 补齐 `remark-breaks` 插件：ArticleIllustrationEditorPage（7 处）、ConfigManagementDialog、VideoAgentPage、SubmissionDetailModal、RichTextMarkdownContent、GroupsPage、DefectDetailPanel、AiChatPage、ArenaPage、LlmRequestDetailDialog、LlmLogsPage、marketplaceTypes，统一单行换行行为 |
| fix | prd-desktop | KnowledgeBasePage 补齐 `remark-breaks` 插件，与管理端统一 |
| feat | prd-admin | 技能广场详情页 breadcrumb 新增「复制 MD」「下载 .zip」按钮，与「我的技能」详情页风格一致（小图标 + 切换反馈，1.8s 自动复位） |
| feat | prd-admin | 我的技能详情页 breadcrumb 同步新增「复制 MD」「下载 .zip」，与广场同构，按钮顺序按破坏性递增（复制 → 下载 → 发布 → 删除） |
| feat | prd-api | 新增 GET /api/skill-agent/skills/{skillKey}/export/zip 端点；GetSkillMd 放开已发布个人技能的非作者访问；内部拆出 ExportSkillAsZipAsync 共享 zip 打包逻辑 |
| feat | prd-api | 周报 Agent 新增团队周报分享链接：团队负责人/副负责人可为某团队+某周生成分享链接（支持密码保护与过期时间），非成员需输入密码方可访问 |
| feat | prd-admin | 「团队」Tab 新增「分享」按钮，参考网页托管的快速分享对话框；新增 /s/report-team/:token 公开查看页，未登录提示登录、非团队成员需密码、团队成员免密码 |
| fix | prd-admin | 重做「使用指引」弹窗：原来是侧栏右侧半浮层（没有遮罩、位置错乱）。改为标准居中 Dialog（深色遮罩 + createPortal + ESC/点击蒙版关闭），保留三张操作卡片与推荐流程提示 |
| fix | prd-api | SkillAgent 保存改为幂等 upsert，"需要调整"后再次保存不再静默失败或产出重复记录 |
| fix | prd-admin | 技能创建页右侧预览栏宽度改为 flex 4:6，与"测试技能"详情页一致；保存失败时显式提示原因；按钮文案在首次/再次保存间区分；移动端底部栏允许反复保存 |
| feat | prd-api | 新增 `GET /api/skill-agent/sessions/drafts` 列出当前用户未保存（SavedSkillKey 空）的会话；响应裁剪，不下发 Messages 全量 |
| feat | prd-api | ISkillAgentSessionStore 新增 ListDraftsAsync，按 LastActiveAt 倒序，利用 `UserId + LastActiveAt` 复合索引 |
| feat | prd-admin | 「我的技能」Tab 顶部新增"未完成的草稿"区；点"继续"复用 sessionStorage + CreateTab.initSession 恢复整条会话；点"删"走既有删除端点；0 条不渲染 |
| fix | prd-api | 个人技能列表端点补齐 IsPublic/AuthorName/AuthorAvatar/PublishedAt 字段，修复"发布到广场后返回详情页按钮又变回未发布"的显示错位 |
| fix | prd-api | SkillAgentController Publish/Unpublish 校验 MatchedCount、区分 404/403/400 错误码，日志记录全路径便于排查 |
| fix | prd-admin | 技能详情页"发布到广场"按钮增加操作结果反馈（成功/失败条 2.5s 自动消失），不再静默失败 |
| fix | prd-api | PublishSkill 查询作者信息时 `u.Id` 改为 `u.UserId`，修复 MongoDB Serializer 异常（User.Id 已在 BsonClassMapRegistration 中 UnmapMember，真正主键是 UserId） |
| fix | prd-admin | 技能广场卡片与详情页作者头像用 `resolveAvatarUrl` 拼接 CDN 前缀，修复直接把 AvatarFileName 当 URL 导致头像加载失败 |
| feat | prd-api | SkillAgent 会话（Messages/Intent/SkillDraft/CurrentStage/SavedSkillKey）现在持久化到 MongoDB `skill_agent_sessions` 集合：进程重启 / 2h 空闲 / 用户刷新都能恢复中间态 |
| feat | prd-api | 新增 ISkillAgentSessionStore（内存 miss 时 DB 兜底加载 + upsert 持久化 + 用户隔离过滤），Controller 的 SendMessage/AutoTest/Save/Get/Delete/ExportMd/ExportZip 全部改走 ResolveSessionAsync |
| feat | prd-api | SkillAgentSession + SkillAgentMessage 迁移到 PrdAgent.Core.Models（避免 Core 层接口反向依赖 Infrastructure） |
| feat | prd-admin | 技能创建页把 sessionId 存入 sessionStorage，页面打开时优先恢复上次会话；handleReset 会清 sessionStorage |
| docs | doc | 新增 `skill_agent_sessions` 集合的 MongoDB 索引建议（UserId+LastActiveAt 复合 + 7 天 TTL） |

### 2026-04-13

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | P1 多项目外壳：新增 `/api/projects` 路由（4 个端点，向下延伸到 P4 创建/删除）+ `projects.html` 项目列表着陆页 + `GET /` 302 重定向到 `/projects.html`，Dashboard header 加"← 项目"返回链接 |
| test | cds | 新增 `tests/routes/projects.test.ts` 6 条单测覆盖 GET/POST/DELETE 路径 (298/298 绿) |
| docs | cds | 对齐 `design.cds-multi-project.md` + `plan.cds-multi-project-phases.md` 的 P1 交付清单，说明前端是纯 HTML 而非 React |
| feat | cds | P2 GitHub OAuth 认证：新增 `CDS_AUTH_MODE=github` 模式 + `/api/auth/github/*` 路由 + session middleware + `login-gh.html` 着陆页，默认 `disabled` 保留向下兼容 |
| feat | cds | 新增 `AuthStore` 接口 + `MemoryAuthStore` in-memory 实现（P3 将替换为 MongoDB 后端），定义 `CdsUser` / `CdsSession` / `CdsWorkspace` domain 类型 |
| feat | cds | 首登自举：第一个 OAuth 成功的用户自动成为 system owner 并获得 personal workspace |
| test | cds | 新增 33 条 P2 单测（memory-store 13 + auth-service 13 + routes 7），全量 `pnpm test` 298 → 331 零回归 |
| docs | cds | 更新 `doc/plan.cds-multi-project-phases.md` P2 交付清单，说明"MongoDB 延迟到 P3，P2 先走 in-memory 接口"的策略调整 |
| refactor | cds | P3 Part 1：抽出 `StateBackingStore` 接口 + `JsonStateBackingStore` 实现，把 `StateService` 的 atomic write / `.bak.*` rotation / recovery 逻辑从 `state.ts` 搬到独立模块；`StateService` 改为通过 `backingStore.load()/save()` 委托持久化。为 P3 Part 2 接入 MongoDB 准备接缝 |
| feat | cds | 新增 `CDS_STORAGE_MODE` 环境变量（默认 `json`）。`mongo`/`dual` 值会在启动时抛出明确错误指向 Part 2/3，避免 .cds.env 误配置静默降级 |
| test | cds | 新增 `tests/infra/json-backing-store.test.ts` 9 条单测直测 backing store，全量测试 331 → 340 零回归 |
| feat | cds | P4 Part 1 数据模型：`CdsState` 新增 `projects?: Project[]` 字段 + `Project` 类型；`StateService` 新增 `getProjects / getProject / getLegacyProject / addProject / removeProject / updateProject` 方法 + `migrateProjects()` 启动迁移，冷启动时自动创建 legacyFlag 默认项目 |
| refactor | cds | `cds/src/routes/projects.ts` 移除 P1 时代的 `buildLegacyProject()` 硬编码，改为读 `stateService.getProjects()` 真实数据；POST/DELETE 501 响应的 `availablePhase` 更新为 `'P4 Part 2'` |
| feat | cds | P2.5 Dashboard header 加入 GitHub 用户徽章：`#cdsAuthWidget` 包含 avatar + login + 登出按钮，`bootstrapAuthWidget()` 探测 `/api/me` 后自动显隐；basic/disabled 模式下保持隐藏（零视觉回归）|
| test | cds | 新增 `tests/services/state-projects.test.ts`（13 条测 migration + CRUD + legacy 保护）；更新 `tests/routes/projects.test.ts`（6 条对齐 P4 Part 1 语义）；全量测试 340 → **353 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 改为三 Part 拆分描述，Part 1 交付清单 + 验收标准全部勾选 |
| feat | cds | P4 Part 2 真项目创建：`POST /api/projects` 接受 name/slug/gitRepoUrl/description，调 `docker network create cds-proj-<id>` 并持久化（带 rollback）；`DELETE /api/projects/:id` 幂等删除 docker 网络 + 项目条目，legacy 项目 403 保护 |
| feat | cds | `Project` 类型新增 `dockerNetwork?` 字段，`createProjectsRouter` 新增 shell + config 依赖注入 |
| feat | cds | 前端 `projects.html` 新增创建项目对话框（name/slug/gitRepoUrl/description 四字段 + 内联错误 + ESC 关闭），项目卡片 hover 出现删除按钮（legacy 项目除外），删除前弹 confirm 确认 |
| test | cds | 新增 9 条 POST/DELETE 单测（成功路径、4 档 400 校验、409 duplicate、500 docker 失败 + rollback、幂等网络创建、legacy 403、未知 id 404），全量测试 353 → **362 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 Part 2 交付清单勾选 |
| feat | cds | P4 Part 3a 数据层 project scoping：`BranchEntry` / `BuildProfile` / `InfraService` / `RoutingRule` 四个接口新增 `projectId?` 字段 |
| feat | cds | `StateService.migrateProjectScoping()` 在 load 时把 pre-P4 entries 全部标为 `'default'`；`addBranch` / `addBuildProfile` / `addInfraService` / `addRoutingRule` 在 projectId 缺失时自动填 `'default'`，保证运行时不变量：每个 entry 必有 projectId |
| feat | cds | 新增四个 read-only helper：`getBranchesForProject(id)` / `getBuildProfilesForProject(id)` / `getInfraServicesForProject(id)` / `getRoutingRulesForProject(id)`，为 Part 3b 的 project-scoped 路由铺路 |
| test | cds | 新增 `tests/services/state-project-scoping.test.ts` 13 条（迁移幂等性 + add*() 自动填充 + helpers 过滤正确性 + defensive fallback），全量测试 362 → **375 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 section 更新为 Part 1/2/3a 已落地 + Part 3b 待办 |
| feat | cds | P4 Part 3b 后端 project scoping：`GET /api/branches` / `/api/routing-rules` / `/api/build-profiles` / `/api/infra` 新增 `?project=<id>` 查询过滤；`POST /api/branches` 接受 `projectId` 入参并校验项目存在 |
| feat | cds | P4 Part 3b 前端 project scoping：`app.js` 新增顶部常量 `CURRENT_PROJECT_ID`（从 URL `?project=` 读），`api()` helper 自动给 scoped GET 请求注入 `?project=<id>` 过滤；创建分支时在 body 里带上 projectId；Dashboard header 链接自动显示当前项目名 |
| test | cds | 新增 3 条 branches 路由过滤测试（?project= 过滤、POST unknown projectId 400、POST 正常 stamp），全量测试 375 → **378 零回归** |
| docs | cds | `doc/plan.cds-multi-project-phases.md` P4 整体完成：Part 1/2/3a/3b 全部勾选，新增"P4 完成意义"章节总结端到端多项目能力 |
| feat | cds | P4 Part 4 Railway-fidelity UI 升级：`projects.html` 完全重写为「左侧窄 sidebar (260px) + 主内容区」布局，sidebar 含工作区切换 pill / Projects 导航高亮 / Templates/Usage/People/Dashboard 链接 / 底部用户卡；主内容区含 "Projects" 大标题 + "+ New" 主操作按钮 + 工具栏（计数 + 排序 + 视图切换）+ 项目卡网格 |
| feat | cds | 项目卡片 Railway 风格：顶部标题 + legacy badge；中间 120px 高 dotted-canvas 服务图标条（最多展示 4 个品牌图标 + N 个溢出）；底部 `production · X services` 环境与统计行；hover 浮起 + 红色删除按钮（legacy 项目除外）|
| feat | cds | `projects.js` 服务图标自动识别：内联 12 个品牌 SVG（MongoDB/Redis/Postgres/MySQL/Node/Dotnet/Python/Nginx/Git/GitHub/Docker/RabbitMQ/Elasticsearch），按 dockerImage 子串匹配；并行 fetch `/api/build-profiles?project=<id>` + `/api/infra?project=<id>`（复用 P4 Part 3b 过滤），渐进式渲染卡片（先骨架后填图标）|
| feat | cds | 用户卡位 `bootstrapMeLabel()` 从 `/api/me` 自动填充 avatar + github login；新建项目对话框样式对齐 Railway（圆角 16px、阴影加深、focus 发光） |
| feat | cds | P4 Part 5 全屏拓扑画布：`setViewMode('topology')` 现在给 `<body>` 加 `cds-topology-fs` class，CSS 隐藏 dashboard 的 header / 搜索 / 分支栏 / tag bar 等所有 chrome，把 `#topologyView` 提升到 `position: fixed; inset: 0` 占满整个视口，`.topology-card` 失去边框 + radius 和 `topology-canvas-wrap` flex:1 撑满 |
| feat | cds | 全屏模式新增浮动顶栏 `topology-fs-topbar`：左侧 ← Projects 返回 + 项目名（从 `/api/projects/:id` 异步拉取）；右侧"列表视图"切换按钮 + 主题切换；浮动底部提示条 `topology-edit-hint`："点击节点直接编辑配置·拖拽空白处平移·滚轮缩放" |
| feat | cds | 节点点击交互重做：选中分支后**单击**应用节点直接打开 override modal（原本要双击），更直观；shift+click 仍是边高亮（escape hatch）；单击 infra 节点切回列表视图并自动打开基础设施面板（infra 编辑器目前在那里）|
| docs | cds | legend 提示文案动态化：未选分支时显示"先选择上方分支，再点击节点编辑"，已选分支时显示"点击节点直接编辑该分支配置" |
| feat | cds | P4 Part 6 全屏拓扑 Railway-fidelity 改造：新增 44px 左侧 icon sub-nav（拓扑/指标/日志/设置）、顶部 breadcrumb pill（项目名 + production env + 分支下拉）、浮动 + Add 按钮 + 6 项菜单（GitHub Repo / Database / Docker / Routing / Volume / Empty Service）、右侧 460px 服务详情滑入面板含 4 个标签页（Deployments / Variables / Metrics / Settings） |
| feat | cds | 节点单击行为重做：app/infra 节点单击都打开右侧滑入详情面板（Deployments tab 显示 ACTIVE pill + image + 状态，Settings tab 显示 service info + "在编辑器中打开"按钮跳转到 override modal），shift+click 仍是边高亮 |
| feat | cds | 进入拓扑模式时自动从 branches 列表挑 main/master 作为默认分支 stamp 到下拉框，单击节点立即可编辑（不再要求用户先手动选分支） |
| feat | cds | + Add 菜单的 6 项各自路由到现有 CDS 创建流程：Database/Docker → 切回列表 + 打开 infra modal；Routing → 打开 routing-rules 配置；Empty Service → 打开 build-profiles 配置；Volume/GitHub → 友好 toast 占位 |
| docs | cds | legend 提示文案动态化 + 顶部老 chip bar / legend 在 fs 模式下完全隐藏 |
| feat | cds | P4 Part 7 — 拓扑面板 Variables tab Railway-style 表格：网格布局（key 列 + value 列 + 复制按钮列）、敏感字段（含 secret/password/token/key）值自动遮罩为 ••••••••、点 ⧉ 复制原值、空状态卡片含图标 + 引导文案、顶部 "Service Variables N" 计数 + "编辑全部" 按钮路由到 override modal |
| feat | cds | P4 Part 8 (MECE A5) — 全新空项目 Dashboard 三步引导 CTA：当 buildProfiles + infraServices 都为空时 `renderEmptyBranchesState` 返回新版本（"欢迎！开始添加你的第一个服务" + 三个按钮：进入拓扑画布 / 从 Compose 导入 / 添加构建配置 + 推荐文案）|
| feat | cds | P4 Part 8 (MECE R4) — error 状态分支卡片改为富文本失败预览块：红色边框卡片含  图标 + "部署失败" 标题 + "查看日志" / "重置" 内联按钮 + `<pre>` 块显示 b.errorMessage 最后 6 行 + "还有 N 行" 溢出标识，用户无需点击日志按钮就能看到错误内容 |
| feat | cds | P4 Part 9 (MECE B4) — BuildProfile 添加表单顶部新增"快速开始"模板栏：5 个一键模板按钮（Node.js / .NET / Python / Go / Static），点击自动填充 id+name+icon+image+workDir+port+install+build+run 全部字段，含 install/build 命令时自动展开高级选项，活跃模板按钮高亮，用户从 7+ 字段填写降为 1 click + 微调 |
| fix | cds | 修复 Auto-Update 重启后 5 秒硬超时直接 `location.reload()` 导致 502 的缺陷：新增 `waitForCdsHealthy` 轮询 `/healthz`（每秒一次、最长 120s、先等 down 再等 up），替换 `setTimeout(reload, 5000)` |
| chore | repo | `.gitignore` 补齐 CDS 运行时产物：`/.cds/`、`/.cds-worktrees/`、`cds/.cds.env.bak`、`cds/.cds.env.*.bak`，消除 `git status` 的无用噪声 |

### 2026-04-12

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 分支级 BuildProfile 覆盖（继承 + 扩展）：每分支可独立定制 dockerImage/command/env/resources/activeDeployMode 等，未设置的字段继承公共基线 |
| feat | cds | 新增 `BuildProfileOverride` 类型 + `BranchEntry.profileOverrides` 字段 |
| feat | cds | 新增 `applyProfileOverride()` 与 `resolveEffectiveProfile()`，合并顺序：baseline → branch override → deploy mode |
| feat | cds | 新增 REST 端点：GET/PUT/DELETE `/api/branches/:id/profile-overrides[/:profileId]` |
| feat | cds | Dashboard 部署菜单新增「容器配置 (继承/覆盖)」入口 + 模态框（公共默认展示 / 字段级继承徽章 / 环境变量合并预览） |
| feat | cds | 部署日志里增加 `(分支自定义)` 标签与 `branchOverrideKeys` 详情，便于追溯 |
| test | cds | 新增 11 个单元测试覆盖合并逻辑（env 键级合并 / 优先级顺序 / 空覆盖 / deploy mode 切换） |
| feat | cds | 分支容器覆盖模态新增「保存并立即部署」按钮，一键完成保存→关闭→重部署 |
| fix | cds | `GET /api/branches/:id/profile-overrides` 的 `effective.env` 现在包含 CDS_* 基础设施变量，与运行时实际注入保持一致（新增 `cdsEnvKeys` 字段标识来源） |
| fix | cds | 覆盖模态的公共默认 env 预览从纯文本 `<pre>` 改为可点击列表，CDS_* 变量橙色标注，每行带「→ 编辑」按钮可一键复制到覆盖区 |
| fix | cds | `_collectOverrideFromForm` 正确识别 `KEY=` 空值（保留为空字符串），不再被误判为「继承」 |
| fix | cds | 保存覆盖前检测 CDS_* 变量覆盖，弹出二次确认防止误伤 MongoDB/Redis 等基础服务连接 |
| fix | cds | 保存时跟踪环境变量解析行数，有跳过时 toast 提示「已识别 N 条，跳过 M 条格式错误行」 |
| fix | cds | `PUT /api/branches/:id/profile-overrides/:profileId` 后端拒绝 `containerPort <= 0`，前端 number input 加 `min="1"` |
| fix | cds | 保存/重置请求进行中时禁用所有按钮，防止重复提交 |
| fix | cds | 后端 `env` 字段校验改为排除 null 和数组（`typeof x === 'object'` 陷阱） |
| fix | cds | 后端过滤掉 env 中非字符串值，避免 `undefined`/数字泄漏到 Docker env-file |
| feat | cds | 分支子域名别名（Subdomain Aliases）：每个分支除默认 `<slug>.<rootDomain>` 外可额外挂 N 个稳定别名 |
| feat | cds | 新增 `BranchEntry.subdomainAliases?: string[]` 字段 + state 层 get/set/findBranchByAlias/findAliasCollisions |
| feat | cds | ProxyService.extractPreviewBranch 先查别名，命中则路由到对应分支；未命中才退回 slug 兜底。别名总是胜过同名 slug |
| feat | cds | 新增 REST 端点：GET/PUT `/api/branches/:id/subdomain-aliases`，带 DNS 合法性校验 + 保留字拦截（www/admin/switch/preview/cds/master/dashboard）+ 跨分支冲突检测（409） |
| feat | cds | 容器配置 modal 新增独立的 ` 子域名` 标签页（分支级，不属于任何 profile）：chip 列表 + 单行添加 + 即点即删 + 每个别名的预览 URL 直达 |
| feat | cds | 别名保存立即生效，无需重新部署（代理层级改动，非容器启动时合并） |
| test | cds | 新增 9 个 state 单元测试（set/get/findBranchByAlias/findAliasCollisions 的 slug 冲突、alias 冲突、case-insensitive、自引用豁免） |
| test | cds | 新增 6 个 proxy 单元测试（extractPreviewBranch 别名命中、大小写不敏感、别名胜过同名 slug、非 rootDomain 返回 null、端口号剥离） |
| feat | cds | 拓扑视图（画板模式）：列表/拓扑切换按钮 + 分层 DAG 图（SVG） + 分支选择器 + 依赖线（弯曲贝塞尔 + 箭头） |
| feat | cds | 画板节点自动布局：Kahn 算法按 depends_on 分层，infra 在最左侧 / app 按依赖链向右 |
| feat | cds | 分支级覆盖徽章：选中一个分支后，所有被该分支自定义的 profile 节点显示  + 绿色高亮边框，hover 显示被覆盖的字段列表 |
| feat | cds | 节点点击直达：点击 app 节点 → 自动打开容器配置 modal 并定位到对应 profile tab（`openOverrideModal` 新增 `preferredProfileId` 参数） |
| feat | cds | 基础设施节点 = 圆角胶囊形（rx=22），应用节点 = 矩形（rx=8），视觉差异化 |
| feat | cds | 拓扑视图与列表视图共享同一数据源（已有的 polling）——切换到拓扑不需额外 fetch，依赖分支覆盖的 override 集合按需懒加载并缓存 |
| feat | cds | View mode 持久化到 sessionStorage（`cds_view_mode`），遵守 CDS "禁止 localStorage" 规则 |
| feat | cds | 拓扑视图大修：向 Railway 对齐（rich cards + pan/zoom + toolbar + click-focus edge highlight） |
| feat | cds | 列表/拓扑 toggle 移到 header 右上角（靠近主题/设置按钮），符合用户反馈 |
| feat | cds | 节点卡片翻倍信息密度 236×110：服务图标 + 名称 + 状态点(运行中/构建中/错误/待命 彩色) + 镜像缩写 + 端口 + 依赖数 +  自定义 pill |
| feat | cds | 根据镜像名/服务 ID 自动选图标：mongo→ / redis→ / postgres→ / node→ / dotnet→ / python→ / rust→ 等 |
| feat | cds | 画布背景改为 grid-dot radial-gradient（`background-size: 22px 22px`），替代旧的 dashed border，观感接近 Railway |
| feat | cds | Pan/zoom：鼠标滚轮以光标为中心缩放 (0.3x–2.5x)，拖拽平移，cursor 状态联动 grab/grabbing |
| feat | cds | 底部左下工具条：放大 / 缩小 / ⊡ 自适应缩放 / ◉ 1:1 复位 + 右上角缩放百分比指示器 |
| feat | cds | 单击节点 → 聚焦（高亮所有相连的边 + 其他节点灰显）；双击节点 → 打开容器配置 modal 并定位到对应 profile tab |
| feat | cds | 从 `branch.services[profileId].status` 读实时状态，驱动节点状态点着色（running=绿 / building=琥珀 / error=红 / idle/stopped=灰） |
| feat | cds | 依赖连线改为虚线 + 箭头 + 聚焦时高亮绿色实线；无依赖的服务不再孤立显示为问题，而是明确表达"独立服务" |
| refactor | cds | 节点尺寸常量抽成 `TOPO_NODE_W/H/GAP_X/Y/PAD`，后续调优无需改多处 |
| fix | prd-admin | 修复首页 ProductMockup 在首屏加载时因 IntersectionObserver 阈值不满足而不显示的问题 |
| fix | prd-admin | 修复 FeatureDeepDive 各 mockup 示意文案未跟随语言切换（hardcoded 中文），现已全部接入 i18n |
| fix | prd-admin | 修复周报 ReportMockup 柱状图因 flex 子元素缺少 h-full 导致百分比高度为 0、柱子不显示的问题 |
| fix | prd-admin | CompatibilityStack 中文平台名（阿里通义/智谱/百度/字节）切换英文时显示国际品牌名 |
| feat | prd-api | 支持多对象存储 Provider 切换（tencentCos / cloudflareR2），通过 ASSETS_PROVIDER 环境变量选择 |
| refactor | prd-api | 补全 IAssetStorage 接口（TryDownloadBytesAsync、ExistsAsync），消除 14 处 TencentCosStorage 类型耦合 |
| feat | prd-api | 新增 CloudflareR2Storage 实现（S3 兼容 API，AWSSDK.S3），支持 Cloudflare R2 对象存储 |
| refactor | prd-api | Base64 扩展方法改为基于 IAssetStorage 接口，不再绑定具体存储实现 |
| feat | prd-api | 新增 asset_registry 资产登记簿，每次存储操作自动登记（scope: system/user/generated/log） |
| feat | prd-api | RegistryAssetStorage 装饰器：透明包裹真实存储，零改调用点即可启用登记 |
| fix | prd-admin | PR 审查卡片折叠态直接显示具体错误原因，无需展开即可看到 |

### 2026-04-11

| 类型 | 模块 | 描述 |
|------|------|------|
| refactor | prd-admin | ArenaPage 沿用 Linear × Retro-Futurism 风格：新增 StaticBackdrop `mode='absolute'` 支持 AppShell 内嵌页使用（避免 `fixed` 穿透侧边栏），Arena 根容器改为 `relative` + `<StaticBackdrop mode="absolute" />` 六层静态背景；侧边栏/顶栏/底栏全部改为玻璃化背板（`rgba(10,14,22,0.52-0.62) + blur(10-12px)`）；"新建对战"和"发送"按钮换成 `HERO_GRADIENT` 渐变药丸；顶栏新增渐变 Swords 徽章 + `BLIND · LIVE` HUD chip；空态欢迎页换成 `Reveal` 阶梯进场 + `BLIND · ARENA` eyebrow + Space Grotesk 慢呼吸标题（`arena-title-pulse`）；对战面板改成带 labelColor 发光边框的玻璃卡 + Space Grotesk 字母徽章；底栏进度环 conic-gradient 从单色 indigo 改为签名三色渐变；保留所有 SSE/Run 业务逻辑、handler、state 不变。 |
| refactor | prd-admin | `StaticBackdrop` 增加 `mode?: 'fixed' \| 'absolute'` prop：默认 `fixed` 保持 LoginPage / LandingPage 行为不变；新增 `absolute` 模式专供 AppShell 内 Outlet 页使用（如 ArenaPage），仅填满最近的 `relative` 父容器，不会穿透左侧导航和顶栏。 |
| docs | - | 更新 `doc/rule.landing-visual-style.md` R2 章节：新增两种挂载模式的使用表格（独立全屏页走默认 `fixed`，AppShell 内 Outlet 页走 `mode="absolute"`），加入"禁止在 AppShell 内 Outlet 页使用默认 fixed 模式"的反面规则。 |
| feat | cds | 设置菜单新增「退出集群」快捷入口，hybrid/executor 角色直接一键退出，无需再进入集群弹窗 |
| fix | cds | 单节点 scheduler 模式电池徽章恢复为本地容器槽视图（不再卡在「集群 …」占位），仅在实际有远端执行器时切换为集群视图 |
| fix | cds | 首次加载分支列表不再闪现「暂无分支」过渡文案，初始保留 CDS 加载动画直到数据就绪，空状态升级为带插图+CTA 的设计态 |
| fix | cds | DELETE/停止分支现在会识别 entry.executorId 并代理到远端执行器 /exec/delete /exec/stop，不再只清掉主节点状态而留下僵尸容器 |
| feat | cds | scheduler 启停改为 UI 开关：新增 PUT /api/scheduler/enabled + SchedulerService.setEnabled + state.json 持久化，容量弹窗内 on/off 切换，状态通过 state-stream 广播 |
| feat | cds | 执行器状态页加入详细的「为什么没有 Dashboard」解释（避免 split-brain / 运维成本 / 控制平面单一），并指引使用主节点的退出集群按钮 |
| chore | cds | 单节点模式隐藏多余的「执行器集群 1/1 在线」面板，header 电池徽章已充分展示容量 |
| perf | cds | restart 重排为 "先 build 再 stop"：tsc 在旧进程还在服务时就写出 dist，停掉旧进程到新进程绑端口的空窗从 10-16s 收缩到 2-4s，消除 Cloudflare 502 Bad gateway 体感 |
| perf | cds | tsconfig 开启 incremental + tsBuildInfoFile，warm 构建从 5s 降到 3s（小 VM 收益更明显） |
| feat | cds | 前端新增重启检测遮罩：SSE 中断时展示"CDS 正在重启"卡片，轮询 /healthz，后端恢复后自动刷新页面，替代原本的 Cloudflare 502 硬错 |
| refactor | prd-api | 新建 GitHub 基础设施层 `PrdAgent.Infrastructure.GitHub`，参照 LlmGateway 的"独立组件"定位，供 PR 审查工作台、未来的日报/检测等多应用复用同一套 GitHub REST 封装 |
| refactor | prd-api | 抽取 `IGitHubClient` 接口 + 把 `GitHubPrClient`（899 行）从 `Services/PrReview/` 迁移到 `Infrastructure/GitHub/`，实现接口；业务层通过接口注入，和凭证来源（per-user OAuth/per-app PAT/GitHub App token）完全解耦 |
| refactor | prd-api | 抽取 `IGitHubOAuthService` 接口 + 把 `GitHubOAuthService`（Device Flow RFC 8628 + HMAC 签名 flow_token）从 `Services/PrReview/` 迁移到 `Infrastructure/GitHub/`，实现接口 |
| refactor | prd-api | 把 `PrUrlParser`（SSRF 白名单 + URL 解析）从 `Services/PrReview/` 迁移到 `Infrastructure/GitHub/`，作为通用 GitHub PR URL 工具类 |
| refactor | prd-api | 新建 `GitHubException` 基类持有通用 GitHub 错误码（NotConnected/TokenExpired/RepoNotVisible/RateLimited/OAuth/DeviceFlow 等 13 个工厂方法）；`PrReviewException` 改为继承自 `GitHubException`，只保留 PR 审查应用专属的 `ItemNotFound`/`Duplicate` |
| refactor | prd-api | `PrReviewController` 改用 `IGitHubClient` + `IGitHubOAuthService` 接口注入；9 处 `catch (PrReviewException)` 改为 `catch (GitHubException)` 基类捕获（多态兼容），行为零变化 |
| refactor | prd-api | `Program.cs` DI 注册改为接口→实现形式：`IGitHubClient → GitHubPrClient`、`IGitHubOAuthService → GitHubOAuthService`；HttpClient "GitHubApi" 命名客户端配置保持不变 |
| refactor | prd-api | 单测 `PrUrlParserTests.cs` 的 `using` 从 `PrdAgent.Api.Services.PrReview` 改为 `PrdAgent.Infrastructure.GitHub`，测试代码本身无改动 |
| docs | doc | 新增 `doc/design.github-infrastructure.md`，记录 GitHub 基础设施层的分层结构、与 LlmGateway 的异同、per-app 授权模型、未来扩展路径（Commits/Issues/CheckRuns 操作按需追加） |
| refactor | prd-admin | 首页 /home 去紫（减少"AI 紫"套路感，参照 linear.app）：StaticBackdrop 顶部紫色径向光晕改为 slate/冷白 + 微弱 teal；Hero HUD chip 紫边改 slate-300 边 + 绿色 live dot；Hero 主标题 text-shadow 去紫改为 slate + 青；Hero Tron 地板紫色竖线改 slate-300；FeatureDeepDive section header accent 从 #a855f7 改 #cbd5e1（slate-300） |
| feat | prd-admin | Hero 新增 TechLogoBar：CTA 组下方加"POWERED BY"大模型文字 logo 条（GPT-5 · Claude 4.6 · Gemini 2.5 · Grok 4 · Llama · DeepSeek V3 · Kimi K2 · Qwen 3 · GLM 4.6 · Wenxin），灰度 display 字体 + 圆点分隔，hover 亮起；解决"首屏有点单调"问题 |
| feat | prd-admin | 新增 ThreePillars 幕：对标 linear.app 的"A new species of product tool"编辑式 3 列布局，放在 StatsStrip 和 FeatureDeepDive 之间。顶部 eyebrow + 大编辑式标题 + 副标；3 列带 fig 01.1 / 01.2 / 01.3 标签 + wireframe 线框示意（Layers/Network/Monitor 图标 + grid pattern + 角标 tick）+ h3 + 描述，列间竖向分割线 |
| fix | prd-admin | FeatureDeepDive 容器从 max-w-6xl (1152px) 拉宽到 max-w-[1240px]，列间距从 md:gap-20 拉到 md:gap-28，px 内边距增加 md:px-10；解决"挤在中间了"问题 |
| feat | prd-admin | i18n 字典新增 hero.techBarLabel + hero.techItems + pillars 全量双语字段 |
| refactor | prd-admin | FeatureDeepDive 瘦身（解决"过大而非大气"）：容器 max-w-[1440px] → max-w-[1200px]；title clamp(2.25,5vw,4.5rem) → clamp(1.875,3.6vw,3.25rem)；mockup 砍掉 grid pattern 背景 + xl margin labels；mockup 外层 padding px-28 → px-10；block 间距 space-y-44/56 → space-y-32/40；描述/bullets 字号收紧；每块目标 ≈ 1 视口 |
| feat | prd-admin | 新增 WorkflowCanvas 幕（对标 linear.app "Move work forward / Understand progress at scale"）：上半 eyebrow + 大标题 + 描述 + chapter marker（2 列），下半 canvas mockup 全宽带 5 节点 workflow pipeline（触发器 → PRD 分析师 → 视觉设计师 → 文学创作者 → 发布），节点含 done/running/pending 三态，边 progress 填充 + pulse 动画 + status footer。严格遵循"一屏一个视觉语言"原则。插入 FeatureDeepDive 和 Cinema 之间 |
| feat | prd-admin | i18n 字典新增 workflow 全量双语字段（eyebrow / title / description / chapterMarker / canvasTitle / runLabel / nodes[5] / status.{running,elapsed,eta,trace}）|
| refactor | prd-admin | 首页 /home 全面重构为九幕 Linear.app 风结构：Hero → StatsStrip → FeatureDeepDive → Cinema → HowItWorks → AgentGrid → CompatibilityStack → FinalCta → Footer |
| feat | prd-admin | 新增 StatsStrip 幕：极简大数字横条（15+/14/98/99.9%），无卡片无图标 |
| feat | prd-admin | 新增 FeatureDeepDive 幕：六大核心 Agent（视觉/文学/PRD/视频/缺陷/周报）左右交替深度展示，每段配专属几何 mockup（2×2 生成图网格 / 润色文本 / PRD 缺口标注 / 视频分镜时间线 / 缺陷 triage 卡片 / 周报对比条形图） |
| feat | prd-admin | 新增 HowItWorks 幕：三步流程（提问 → Agent 选型 → 流式输出），带步骤间连接渐变线 |
| feat | prd-admin | 新增 AgentGrid 幕：从 toolboxStore.BUILTIN_TOOLS 真实驱动 15 个 Agent 卡片，4 列网格，每卡独立 accent color + hover 光晕，Dedicated/Assistant 分类徽章 |
| feat | prd-admin | 新增 CompatibilityStack 幕：12 家 LLM Provider 文字 logo 矩阵（OpenAI/Anthropic/Gemini/DeepSeek/Kimi/通义/GLM/文心/豆包 等），区域标签 |
| feat | prd-admin | 新增 FinalCta 幕："现在，轮到你了" 收束 CTA，稀缺渐变第二次也是最后一次出现 |
| feat | prd-admin | 新增 MinimalFooter 幕：极简单行页脚（logo + GitHub + 版权） |
| refactor | prd-admin | LandingPage 重写：九幕 SCENE_COLORS 场景色编排，Starfield 降到 18% 不透明度作材质，顶栏导航改为 产品/Agent/片花/流程/兼容/文档 |
| fix | prd-admin | 删除六个旧 section（LibrarySection 克莱风空壳 / FeatureBento / SocialProof / AgentShowcase / DownloadSection / CtaFooter）+ 三个孤儿组件（CountUpNumber / GlowOrb / ParticleField），首页目录从 10 个 section 精简到 9 个全新 section |
| feat | prd-admin | 首页 /home Hero 新增 Aurora 极光渐变背景（4 层彩色 blob 用 mix-blend-mode: screen 叠在 Starfield 之上，形成星云质感） |
| feat | prd-admin | 首页 Hero 新增 4 张浮动 Agent 活动卡（视觉/文学/PRD/视频），frosted glass + 进度条 + pulse dot + 鼠标视差 + 呼吸漂浮，让首屏"活起来" |
| fix | prd-admin | 修复 Hero 主标题在宽屏下"呼吸"两字被截断换行的 bug — 标题拆为"让创造 / 自由呼吸"两行，字重与字号错落（300 / 500），视觉节奏更强 |
| feat | prd-admin | Hero 中心内容加入鼠标微视差（CSS 变量驱动，零 React re-render） |
| refactor | prd-admin | 首页 /home Hero 全面重写为 Linear.app 风格：删除 AuroraBackground 极光 mesh、FloatingAgentCards 浮动假卡、BlurText 每字扫光、鼠标视差，杜绝"2024 AI 创业公司"视觉套餐 |
| feat | prd-admin | 新增 ProductMockup 组件：真实感 MAP 应用壳（浏览器 chrome + icon 侧栏 + 对话列表 + 视觉 Agent 生成 4 张候选图的流式场景），作为首屏 CTA 下方的产品证据，替代之前的假浮动卡 |
| refactor | prd-admin | Hero 背景改为 Linear 签名动作：单一顶部径向光晕（紫→透明），LandingPage 把 Starfield 降到 22% 不透明度作材质 |
| refactor | prd-admin | Hero 主标题改回单行"让创造，自由呼吸"，单字重 medium + 负字距 -0.035em + max-width 16ch，editorial 感取代双行字重差 drama |
| refactor | prd-admin | Hero 动效改为一次性 CSS fade-up（hero-fade-up + mockup-rise），移除 BlurText 每字扫光动画 |
| feat | prd-admin | 首页 /home 新增中英文切换器（仅首页，顶栏右上角 `中/EN` 胶囊 toggle） |
| feat | prd-admin | 新建 i18n/landing.ts 双语字典（涵盖 nav/hero/stats/features/cinema/how/agents/compat/pulse/download/cta/footer 全部可见文案），结构化 TranslationShape interface |
| feat | prd-admin | 新建 contexts/LanguageContext.tsx：LanguageProvider + useLanguage hook，sessionStorage 记忆语言选择，同步更新 `<html lang>` |
| feat | prd-admin | 新建 components/LanguageToggle.tsx：中英切换 pill，当前语言高亮 + 霓虹边框 |
| feat | prd-admin | 全部 9 个 section（Hero/Stats/FeatureDeepDive/Cinema/HowItWorks/AgentGrid/CompatibilityStack/CommunityPulse/DesktopDownload/FinalCta/MinimalFooter）接入 useLanguage，文案从字典读 |
| feat | prd-admin | FeatureDeepDive 段落感升级：每个 feature block 内部 7 级 stagger reveal（chapter 号 → eyebrow → title → desc → bullets 逐条 → learn-more → mockup），让页面"徐徐前进地拼凑出来" |
| feat | prd-admin | FeatureDeepDive 新增 chapter 编号分段符 `CHAPTER 01 / 06`（VT323 mono + 霓虹发光），每段开头出现，作为"新段落开始"的明确视觉信号 |
| refactor | prd-admin | FeatureDeepDive block 间距从 space-y-32/44 拉大到 space-y-44/56，header mb 从 32/40 拉大到 36/48，gap 从 md:gap-16 拉到 md:gap-20 —— 解决 "六个专业 Agent，一个工作台" 上下挤感 |
| refactor | prd-admin | 首页 /home Hero 精简到"一屏一主角"（删除 10+ 堆料元素，保留超大显示标题 + 单行副标 + 双 CTA + scroll 提示） |
| feat | prd-admin | 新增 SignatureCinema 幕（全宽 16:9 电影位），预留视频 src 入口，缺失时降级为径向渐变 poster + 播放图标 + "即将上线"签名 |
| feat | prd-admin | LandingPage 接入 IntersectionObserver 滚动场景编排：Hero/Showcase/Cinema/Library/Features/Evidence/Download/CTA 八幕各自对应一种 Starfield themeColor，粒子宇宙随叙事流动 |
| feat | prd-admin | 引入 Space Grotesk + Inter 作为品牌显示/正文字体（Google Fonts 非阻塞加载，新增 --font-display / --font-body CSS tokens） |
| refactor | prd-admin | 顶栏导航增加「片花」入口，删除「案例」，观看片花 CTA 现在滚到 #cinema 与标签语义一致 |
| fix | prd-admin | 修复 StatsStrip 后方诡异"银色金属条"伪影：StaticBackdrop 的 synthwave 地平线/太阳/Tron 地板从 fixed 全屏搬到 HeroSection 本地，避免 fixed 42% 位置穿透后续 section |
| feat | prd-admin | 新增 useInView hook + Reveal 组件：Intersection Observer 驱动的 fade-up 滚动进场动效，prefers-reduced-motion 尊重，触发一次不重复 |
| feat | prd-admin | 新增 SectionHeader 共享组件：统一所有 section 头部版式（Lucide icon HUD chip + VT323 eyebrow + h2 + 可选 subtitle），内置 Reveal 分步进场 |
| feat | prd-admin | 全站 section chip 的 Unicode 符号  ► »   替换为真 Lucide 图标：Sparkles / Users / Workflow / Zap / Star / Radio / Download |
| fix | prd-admin | Hero CTA 重做对称两按钮：h-12 + rounded-full + icon 前置，消除之前一个实 pill 一个纯文字的视觉不平衡 |
| fix | prd-admin | FeatureDeepDive 头部间距：pt-10 + mb-32→40，六段之间 space-y-32→44，修复"六个专业 Agent"章节上下挤感 |
| fix | prd-admin | StatsStrip 去掉 border-y 金属条效果，改为纯留白 + 每数字独立 Reveal stagger |
| feat | prd-admin | Hero 主标题加 ambient neon pulse（5s 呼吸发光）+ 终端 HUD chip 同步 pulse |
| feat | prd-admin | 所有 section 内容接入 Reveal：Hero 分 5 级 delay（chip→title→subtitle→CTA→mockup），其他 section stagger 80-120ms |
| feat | prd-admin | ProductMockup 内容接入 i18n：左侧 5 条对话列表（标题 + meta）、"新对话"按钮、顶部标题栏标题和状态、分享/继续生成按钮、用户消息气泡、Agent 回复、生成进度、输入框 placeholder —— 全部双语 |
| fix | prd-admin | 顶栏英文溢出修复：nav gap 从 gap-8 缩到 gap-5/lg:gap-7；品牌文字 "Midor Agent Platform" 从 `sm:inline` 改为 `xl:inline`（英文较长时移到大屏才显示）；容器从 max-w-7xl 拉到 max-w-[1440px]；nav 链接加 whitespace-nowrap |
| feat | prd-admin | FeatureDeepDive 布局彻底重做成 Linear 图 2 风格（解决"挤在中间了"）：<br>· 容器 max-w-[1240px] → max-w-[1440px] 且 md:px-12<br>· 抛弃 2-col 左右交替，改为**上 Eyebrow 横条 + 中 2-col (大标题 1.3fr + 描述/bullets 1fr) + 下 full-width mockup display window**<br>· 大标题 clamp(1.75-3.25rem) → clamp(2.25-4.5rem) 编辑式放大<br>· Mockup 全宽容器带 48px grid pattern 背景 + 顶边 accent scanline + xl 屏左右 margin 里的 fig/id/version 标签（模仿 Linear 技术注释风）<br>· mockup 本体宽度保持 980px 居中，两边留大量呼吸空间（使用 padding 而非强拉伸）|
| feat | prd-admin | 首页 /home 融合 retro-futurism gaming 元素（ui-ux-pro-max 推荐的 Retro-Futurism + Synthwave 风格，参照 App Store Style Landing 模式） |
| feat | prd-admin | StaticBackdrop 重构：新增 Tron 透视地板网格（CSS 3D perspective 62° 紫青双向 40px 格 + mask fade）+ Synthwave 地平线光带 + 合成太阳光斑 + CRT 横向扫描线 overlay（0.025 opacity, mix-blend-overlay） |
| feat | prd-admin | 接入 VT323 终端字体（Google Fonts），新增 --font-mono token，全站 section eyebrow/HUD 标签统一用 VT323 + 霓虹 text-shadow |
| feat | prd-admin | Hero chip 改为终端 HUD 状态条：SYSTEM ONLINE + 绿色 pulse dot + MAP 标识，紫色发光边框 |
| feat | prd-admin | Hero 主标题"让创造，自由呼吸"加 neon text-shadow（紫 + 青 + 玫瑰三层发光） |
| feat | prd-admin | FeatureDeepDive / AgentGrid / HowItWorks / CompatibilityStack / FinalCta section eyebrow 全部升级为 VT323 mono HUD chip（带 scanline 式发光符号  ► »  ） |
| feat | prd-admin | AgentGrid 每张卡片新增 LV.XX 游戏等级徽章（Dedicated = LV.99, Assistant = LV.42） |
| feat | prd-admin | 新增 CommunityPulse 幕：LIVE·PULSE HUD 标签 + 4 张大号 stat（ACTIVE AGENTS / CONVERSATIONS 24H / TOKENS / MEDIA）+ Weekly Leaderboard Top 5 Agent 排行榜 |
| feat | prd-admin | 新增 DesktopDownload 幕：DESKTOP CLIENT HUD 标签 + 3 张平台卡（macOS / Windows / Linux）+ Tauri 2.0 原生客户端介绍 + 系统托盘/快捷键 bullet |
| refactor | prd-admin | LandingPage 从 9 幕扩展到 11 幕，导航改为 产品/Agent/片花/社区/下载/文档 |
| refactor | prd-admin | 首页 /home 背景彻底改为静态：新增 StaticBackdrop 组件（纯 CSS，零动画零粒子零 canvas），参照 Linear.app + Vercel.com 做法 |
| feat | prd-admin | StaticBackdrop 五层：#050508 纯底 / 32px 点阵网格（顶浓底淡 mask）/ 顶部紫色径向光晕 / 底部玫瑰微光 / 细噪点 overlay |
| refactor | prd-admin | 删除 StarfieldBackground.tsx（WebGL 粒子连线 shader），LandingPage 移除场景色编排 IntersectionObserver 逻辑（静态背景无需切换色温） |
| refactor | prd-admin | HeroSection 移除本地顶部径向光晕，统一由 StaticBackdrop 提供，避免两层叠加 |
| feat | prd-admin | FeatureDeepDive VisualMockup 内部加分步进场动画（克制版）：4 个生成图 grid 接入 useInView，每格 stagger 120ms 入场（opacity 0→1 + scale 0.94→1 + translateY 14→0），done 2 格的绿色对勾延迟 pop-in 带弹性 overshoot（cubic-bezier 0.34, 1.56, 0.64, 1），generating 2 格叠加 shimmer 横扫（延迟在自身入场后开始），prefers-reduced-motion 尊重。只作用于 Visual 一段强化"生成中"叙事，不影响其他 5 个 mockup。 |
| refactor | prd-admin | LoginPage 沿用 PR #405 首页的 Linear × Retro-Futurism 视觉语言：StaticBackdrop 六层静态背景 + Hero 局部 retro 装饰（synthwave 地平线 / 合成太阳 / Tron 地板）+ HERO_GRADIENT 主 CTA pill + HUD chip eyebrow + Space Grotesk 呼吸标题 + VT323 mono 表单 label + Reveal 阶梯进场，替换原 RecursiveGridBackdrop + prd-login-card 老玻璃样式；业务逻辑（login/首次登录重置密码/权限拉取）保持一致。 |
| docs | - | 新增 doc/rule.landing-visual-style.md 沉淀首页/登录页共用的 10 条视觉语言规则（签名渐变、StaticBackdrop、字体三件套、Reveal、HUD chip、对称 CTA、neon pulse、去紫、玻璃卡片、i18n），作为后续扩展新页面时的统一风格权威。 |
| feat | prd-api | PR Review V2 档 3 对齐度检查：新增 PrAlignmentService，通过 ILlmGateway 流式调用 LLM，对比 PR 描述 vs 实际代码变更 + 关联 issue，输出 Markdown 对齐度报告（遵守 llm-gateway.md 规则） |
| feat | prd-api | GitHubPrClient 扩展：新增 files（前 80 个，每 patch 截断 4KB）+ body（截断 20KB）+ 关联 issue（Closes #N 解析，body 截断 8KB）的拉取，防 MongoDB 单文档膨胀与 LLM 上下文爆炸 |
| feat | prd-api | PrReviewItem + PrReviewSnapshot 新增 Body / Files / LinkedIssue* / AlignmentReport 字段，承载档 3 所需的 AI 上下文与结果 |
| feat | prd-api | PrReviewController 新增两个端点：GET /items/{id}/ai/alignment（读缓存）+ GET /items/{id}/ai/alignment/stream（SSE 流式，按 phase/typing/result/error 事件推送） |
| feat | prd-api | PrAlignmentService prompt 强约束 Markdown 输出结构（对齐度% + 总结 + 已落实 + 没提但动了 + 提了没见到 + 关联 Issue 对齐 + 架构师关注点），后端同时解析出 Score + Summary 落库 |
| feat | prd-admin | 新增 AlignmentPanel 组件：基于 useSseStream 订阅 SSE 流，四态切换（idle / running / done / error），支持中止、重新分析、缓存展示，打字机预览 + 阶段文案遵守 llm-visibility 规则 |
| feat | prd-admin | AlignmentPanel 结构化渲染：解析 markdown 章节为色彩化卡片（emerald/amber/red/violet 对应 已落实/没提但动了/提了没见到/架构师关注点），头部展示对齐度分数徽章 + 重跑按钮 |
| feat | prd-admin | prReview 服务层新增 getPrReviewAlignment / getPrReviewAlignmentStreamUrl；usePrReviewStore 新增 setAlignmentReport 方法同步流完成后的结果；PrItemCard 展开态嵌入 AlignmentPanel |
| feat | prd-api | PR Review V2 后端：新增 PrReviewErrors 统一错误码与 PrReviewException 领域异常，消灭 404 歧义（REPO_NOT_VISIBLE vs PR_NUMBER_INVALID） |
| feat | prd-api | PR Review V2 后端：新增 GitHubOAuthService，用 HMAC(Jwt:Secret) 签名 state 实现无状态 CSRF 防护，支持 code→token 兑换与 /user 信息拉取 |
| feat | prd-api | PR Review V2 后端：新增 GitHubPrClient，happy path 单次调用 + 404 两步探测（先查 /pulls 失败再探 /repos 区分仓库可见性） |
| feat | prd-api | PR Review V2 后端：新增 PrReviewController 十端点（auth status/start/callback/disconnect + items CRUD/refresh/note），严格按 userId 隔离 |
| feat | prd-api | AdminPermissionCatalog 新增 pr-review.use 权限位，与旧 pr-review-prism.use 并存 |
| refactor | prd-api | PR Review V2 切换到 GitHub Device Flow (RFC 8628)，取代 Web Flow。原因：CDS 动态域名（<branch>.miduo.org）与 Web Flow Callback URL 预注册机制不兼容，Device Flow 无需 callback，本地/CDS/生产共用一套代码 |
| refactor | prd-api | GitHubOAuthService 重写：StartDeviceFlowAsync + PollDeviceFlowAsync + HMAC 签名的无状态 flowToken（base64url(deviceCode|userId|expiry|hmac)，FixedTimeEquals 防时序攻击） |
| refactor | prd-api | PrReviewController 新增 POST /auth/device/start 与 POST /auth/device/poll，删除 /auth/start、/auth/callback、ResolveBaseUrl、BuildCallbackUrl 等 Web Flow 遗留 |
| refactor | prd-api | PrReviewErrors 新增 DEVICE_FLOW_TOKEN_INVALID / DEVICE_FLOW_EXPIRED / DEVICE_FLOW_ACCESS_DENIED / DEVICE_FLOW_REQUEST_FAILED；移除 state 相关错误码 |
| refactor | prd-admin | services/real/prReview.ts 替换 startPrReviewOAuth 为 startPrReviewDeviceFlow + pollPrReviewDeviceFlow，新增 PrReviewDeviceFlowStart/Poll 类型 |
| refactor | prd-admin | usePrReviewStore 重写授权路径：startConnect → open verificationUriComplete → 自动轮询循环，按 slow_down 响应动态调大间隔，支持本地倒计时超时 |
| refactor | prd-admin | GitHubConnectCard 重写为 Device Flow UX：授权码大字展示 + 一键复制 + 打开 GitHub 按钮 + 倒计时进度条 + 终态提示（expired/denied/failed） |
| refactor | prd-admin | PrReviewPage 移除 ?connected=1 query 处理（Device Flow 无 redirect），简化主页面逻辑 |
| docs | doc | design.pr-review-v2.md / spec.srs.md §4.24 全面更新，反映 Device Flow 架构与 CDS 动态域名适配决策 |
| fix | prd-api | PR Review V2：在 AppCallerRegistry 登记 pr-review.summary::chat 和 pr-review.alignment::chat。首次部署时 LLM Gateway 报 APP_CALLER_INVALID，因为新 AppCallerCode 没有写入代码侧注册表，管理端同步时检测不到 |
| fix | prd-api | PrSummaryService.ParseHeadline / PrAlignmentService.ParseAlignmentOutput 的正则 `[^\n#]+` 会在 LLM 输出中遇到 `#` 时截断（例如 "Fix #123"），改为 `[^\n]+` 抓整行并在业务层限长 |
| fix | prd-api | PrReviewController 档 1/3 的 StreamSummary / StreamAlignment 增加空输出防御：LLM 返回空内容时写入 Error 字段并推 error 事件，不再当成"成功但空白" |
| fix | prd-api | PrReviewController 补 using System.Text（首次部署时 StringBuilder 两处 CS0246 编译错误） |
| feat | prd-api | PR Review V2 基础：新增 GitHubUserConnection / PrReviewItem / PrReviewSnapshot 模型，奠定 per-user OAuth 审查路径 |
| feat | prd-api | PR Review V2：新增 PrUrlParser（owner/repo/number 抽取 + SSRF 白名单），伴随 30+ 单测覆盖协议/host/路径逃逸/编码绕过/非法编号/字符越界 |
| feat | prd-api | PR Review V2：在 MongoDbContext 注册 github_user_connections 与 pr_review_items 集合 |
| feat | doc | 新增 doc/design.pr-review-v2.md：以 OAuth 为根的 PR 审查工作台顶层设计，定义 MVP 边界、错误分类、下线计划 |
| feat | prd-admin | PR Review V2 前端：新增 /admin/pr-review 页面，严格 SSOT + 无 localStorage，整页拆成 5 个组件（200 行主页面取代 1781 行巨石） |
| feat | prd-admin | PR Review V2 前端：GitHubConnectCard 组件——OAuth 整页跳转连接 GitHub，展示已连接 login/头像/scopes，支持一键断开 |
| feat | prd-admin | PR Review V2 前端：AddPrForm 粘贴 PR URL 同步拉取，失败提示保留错误码分类 |
| feat | prd-admin | PR Review V2 前端：PrItemCard 折叠式卡片——基本信息/详情/Markdown 笔记失焦自动保存/刷新/删除 |
| feat | prd-admin | PR Review V2 前端：PrItemList 列表 + 分页 + 空态/加载态区分 |
| feat | prd-admin | PR Review V2 前端：usePrReviewStore（Zustand）严格 SSOT，乐观 UI + 回滚机制 |
| feat | prd-admin | PR Review V2 前端：新增 services/real/prReview.ts 类型化 API 层，注册至 services/index.ts |
| feat | prd-admin | App.tsx / authzMenuMapping 新增 pr-review 路由和权限位 |
| fix | prd-api | **关键幽灵 bug**：RegisterAppSettings 缺少 SetIgnoreExtraElements(true)，导致 MongoDB 残留的 PrReviewPrismGitHubTokenEncrypted 字段反序列化 AppSettings 时抛 BSON 异常，被 LlmRequestLogWriter.StartAsync 的 silent catch 吞掉，表现为**所有 LLM 调用都不写 llmrequestlogs**（新旧功能都受影响） |
| fix | prd-api | LlmRequestLogWriter.StartAsync 的 catch 块日志级别从 Debug 提升到 Warning，避免类似"所有日志静默丢失"的幽灵故障难以排查 |
| feat | doc | 新增 rule.ai-model-visibility + .claude/rules/ai-model-visibility 原则：中大型 AI 功能必须在 UI 最顶部展示当前调用的模型名 {model} · {platform}，数据来自后端 Start chunk，禁止前端硬编码 |
| feat | prd-api | PrReviewModelInfoHolder（新）：服务层 → Controller 的模型信息传递载体，让 IAsyncEnumerable 流式方法能把 Start chunk 捕获到的 ActualModel / ActualPlatformName / ModelGroupName 带出来 |
| feat | prd-api | PrSummaryService / PrAlignmentService StreamXxxAsync 新增 modelInfo 参数，在 Gateway Start chunk 时填充 |
| feat | prd-api | PrReviewController 在 SSE 流中新增 model 事件（Start 捕获后立即推送），同时把模型名持久化到 AlignmentReport.Model / SummaryReport.Model 字段 |
| feat | prd-admin | AlignmentPanel + SummaryPanel 新增 ModelBadge 组件：顶部低饱和度小字展示 "● {model} · {platform}"，流式阶段从 SSE model 事件获取实时值，完成后从 Report.Model 获取缓存值 |
| fix | prd-api | 新增 StreamLlmWithHeartbeatAsync 心跳：LLM 首字延迟（qwen/deepseek 等推理模型可达 10~90s）期间每 2s 推送 phase=waiting 事件带 elapsed 秒数，首字到达时切换到 phase=streaming。彻底消除用户盯着静态文案等几十秒的"空白等待"体验 |
| feat | prd-api | 新增 GET /api/pr-review/items/{id}/raw 端点：返回 PR 完整原文（body 未截断 + files[] 含 diff patch），独立端点避免把 100KB 数据塞进列表接口 |
| feat | prd-admin | 新增 PrRawContentModal 组件 + PrItemCard"查看原文"按钮：完整展示 PR 描述、关联 issue、变更文件列表（可折叠 diff patch，diff 带 +/-/@@ 彩色高亮） |
| fix | prd-api | **根因**：PrSummaryService / PrAlignmentService 只处理 GatewayChunkType.Text，把 Thinking chunk（推理模型 reasoning_content）silently dropped，导致 qwen-thinking 50 秒思考被当成"空白等待"（日志 firstByteAt=1.8s 但 SSE 首字 52s）。新增 LlmStreamDelta record struct 区分 Thinking / Text，两个 service 都 yield 双类型 |
| feat | prd-api | StreamLlmWithHeartbeatAsync 新增 SSE thinking 事件推送 + phase=thinking/streaming 阶段区分 |
| feat | prd-admin | 新增 PrMarkdown 共享组件（ReactMarkdown + remarkGfm + remarkBreaks + 深色主题），用于 PR 面板所有 markdown 场景：oneLiner、keyChanges bullets、impact/reviewAdvice 章节、AlignmentPanel 三栏 bullets、PrRawContentModal 的 PR body 与 linkedIssueBody |
| feat | prd-admin | SummaryPanel + AlignmentPanel 新增 ThinkingBlock 组件：流式渲染推理模型思考过程，正文开始后自动折叠 |
| fix | prd-api | 心跳 phase 文案分三级：0-15s "AI 正在思考"；15-40s "上游首字延迟较高（{model}），已等待 20s"；40s+ " 上游响应异常缓慢，建议中止重试"。根因是 qwen/qwen3.6-plus 走 OpenRouter 是 fake-streaming——chunk #1 @ 4.4s 只是 Start metadata，chunk #2 第一个真正的文本 token @ 52s |
| fix | prd-api | OpenRouter 不默认转发 reasoning 的根因修复：在 request body 里加 `include_reasoning: true` + `reasoning: {exclude: false}`，修复后 thinking 事件从 1.9s 开始流式到达（从前是 52s 空白）。同步 OpenAIGatewayAdapter 支持 `reasoning` 字段（OpenRouter 归一名）和 `reasoning_content`（上游原生名） |
| feat | doc | 新建 `doc/rule.llm-gateway.md` + 扩展 `.claude/rules/llm-gateway.md`，沉淀 5 个流式 LLM 陷阱：firstByteAt 指标歧义 / OpenRouter 必须显式开 reasoning / reasoning 字段名不统一 / fake streaming 只能 UX 降级 / 诊断 3 个信息源交叉验证。附 8 项 checklist |
| feat | prd-api | 新增 GET /api/pr-review/items/{id}/history 端点，并行拉取 6 个 GitHub REST API（commits / reviews / review-comments / issue-comments / timeline / check-runs），每个子请求失败不致命 |
| feat | prd-admin | PrItemCard 右上角新增"历史"悬浮按钮 + PrHistoryModal 弹窗（5 个 tab：时间线 / 提交 / 评审 / 评论 / CI 检查）。时间线 tab 支持 committed / reviewed / commented / labeled / assigned / merged / force_pushed / renamed / ready_for_review 等 20+ GitHub 事件类型，每种事件独立图标 + 颜色 + 中文描述 |
| fix | prd-admin | PrHistoryModal 修复两个问题：(1) 用 createPortal 挂到 document.body，修复被 PrItemCard 外层 overflow-hidden 裁剪导致的超出屏幕无法滑动；(2) 改为按 tab 懒加载，打开弹窗只拉 timeline（~400ms），切 tab 时才拉对应类型。第一版打开立即并行拉 6 个 endpoint 需 2-3s |
| fix | prd-api | PrReviewController /history 端点支持 `?type=timeline&page=1&perPage=30` 懒加载模式，GitHubPrClient 拆出 FetchHistorySliceAsync 按类型分派。每个 tab 独立分页，hasMore 由 items.count>=perPage 推导 |
| fix | prd-admin | PrHistoryModal + PrRawContentModal 改用 inline style 强制高度（`height:90vh, maxHeight:90vh`），绕过 Tailwind v4 Oxide 引擎对 arbitrary value 的偶发失效；同步给 PrRawContentModal 补上 createPortal（第一轮漏了） |
| feat | doc | 新建 `doc/rule.frontend-modal.md` + `.claude/rules/frontend-modal.md`，沉淀模态框 3 硬约束：inline style 走布局关键属性 / createPortal 到 body / flex 滚动容器必须 min-h:0。附标准实现模板 + 提交前 Checklist |
| refactor | prd-api | 下线旧 PR审查棱镜：删除 PrReviewPrismController (1211 行)、GitHubPrReviewPrismService (501 行)、PrReviewPrismSnapshotBuilder、PrReviewPrismSubmission 模型 |
| refactor | prd-api | 下线旧 PR审查棱镜：删除集成测试 (1087 行) + 单元测试 (145 行)，由 PrUrlParserTests 覆盖新 V2 路径 |
| refactor | prd-api | 下线旧 PR审查棱镜：从 MongoDbContext 移除 PrReviewPrismSubmissions 集合与索引；AppSettings 删除 PrReviewPrismGitHubTokenEncrypted 字段 |
| refactor | prd-api | 下线旧 PR审查棱镜：AdminPermissionCatalog / BuiltInSystemRoles / AdminMenuCatalog 移除 pr-review-prism.use，替换为 pr-review.use |
| refactor | prd-admin | 下线旧 PR审查棱镜：删除 pages/pr-review-prism (1781 行) + services/real/prReviewPrism.ts + PrReviewPrismCardArt，由 /pr-review V2 页面替代 |
| refactor | prd-admin | 下线旧 PR审查棱镜：从 App.tsx / authzMenuMapping / AgentLauncherPage / MobileHomePage / toolboxStore 移除所有 pr-review-prism 引用 |
| refactor | ci | 删除 .github/pr-architect/* 整个目录（README / manifests / review-rules / design-sources / decision-card-template）与 5 个 workflow、5 个 Python 脚本、PULL_REQUEST_TEMPLATE.md |
| refactor | skills | 删除 .claude/skills/pr-prism-bootstrap 与 scripts/bootstrap-pr-prism.sh / init-pr-prism-basis.sh |
| refactor | doc | 下线 doc/guide.pr-prism-bootstrap-package.md / guide.pr-prism-onboarding.md；spec.srs.md 第 4.24 节从 PR 审查棱镜改写为 PR 审查工作台 V2；rule.data-dictionary.md / rule.app-identity.md 同步更新 |
| chore | doc | 清理未发布的 V1 历史 changelog 碎片：2026-04-08_map-home-pr-review-prism.md、2026-04-09_pr-review-prism-complete.md（V1 从未发版，清理避免 CHANGELOG 出现从未面世的功能） |
| feat | prd-api | PR Review V2 档 1 变更摘要：新增 PrSummaryService，通过 ILlmGateway 流式生成"一句话/关键改动/主要影响/审查建议"四段式 Markdown，AppCallerCode=pr-review.summary::chat |
| feat | prd-api | PrReviewItem 新增 SummaryReport 字段，存 markdown + headline + 耗时 + error |
| feat | prd-api | PrReviewController 新增 GET /items/{id}/ai/summary（读缓存）+ GET /items/{id}/ai/summary/stream（SSE 流式，复用与 alignment 相同的 phase/typing/result/error 事件协议） |
| refactor | prd-api | 抽出 EnsureSnapshotReadyAsync + PrepareSseHeaders 私有 helper，alignment 与 summary 两个 SSE 端点共享快照刷新与响应头设置，消除重复 |
| feat | prd-admin | 新增 SummaryPanel 组件：四态 SSE 生命周期（idle/running/done/error），空态按钮 / 打字机预览 / 结构化渲染（关键改动 · 主要影响 · 审查建议） |
| feat | prd-admin | PrItemCard 展开态依次嵌入 SummaryPanel（档 1，sky 色调）+ AlignmentPanel（档 3，violet 色调），摘要在前因为运行更快更适合先看 |
| feat | prd-admin | prReview 服务层新增 PrSummaryReportDto 类型、getPrReviewSummary / getPrReviewSummaryStreamUrl；usePrReviewStore 新增 setSummaryReport 方法 |

### 2026-04-10

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 头部新增容量压力电池图标: 实时显示 runningContainers/maxContainers 比率,四色分层(绿<60%/蓝<80%/橙<100%/红超售),超售时呼吸灯动效,点击打开弹窗显示 scheduler 状态 + hot/cold 分支列表 |
| feat | cds | 新增 `./exec_cds.sh connect/disconnect/issue-token/cluster` 子命令，一条命令加入 CDS 集群 |
| feat | cds | 主节点 standalone → scheduler 自动热升级，首个 executor 注册时触发，无需重启 |
| feat | cds | 新增 `GET /api/executors/capacity` 端点，总容量（分支槽/内存/CPU）随执行器加入自动扩充 |
| feat | cds | 主节点作为 `role=embedded` 执行器自注册，容量汇总包含主机自身资源 |
| feat | cds | Bootstrap 两段式 token 机制：一次性 token（15 分钟过期）换永久 executor token |
| feat | cds | 新增 `cds/src/services/env-file.ts` 原子读写 `.cds.env` 工具模块 |
| docs | cds | 新增 `doc/guide.cds-cluster-setup.md` 集群扩容运维手册（含前置检查、5 种排错、安全建议） |
| docs | cds | `./exec_cds.sh help` 大改造：分区呈现、表情符号导航、新手 FAQ、命令解释假设零基础用户 |
| fix | cds | `./exec_cds.sh connect` 拒绝明文 HTTP URL（loopback 例外），防止 bootstrap token 被中间人截获 |
| fix | cds | `./exec_cds.sh connect` 网络探测按 curl exit code 分类（DNS/连接/超时/TLS/HTTP），给针对性修复建议 |
| fix | cds | `./exec_cds.sh connect` 注册超时从 20 秒延长到 60 秒，每 5 秒打印进度避免冷启动机器误报 |
| fix | cds | `./exec_cds.sh connect` 失败时区分 "Token 拼写/过期/已被消费" 三种场景，给具体修复步骤 |
| fix | cds | scheduler/routes 拒绝包含控制字符或长度 > 64 的 executor id，防止日志注入 |
| fix | cds | scheduler/routes 在 bootstrap token 已被消费时返回特定错误信息，引导用户重新 issue-token |
| fix | cds | scheduler/routes 把 "首个 executor" 判定从闭包标志改为基于 registry 状态，避免主进程重启后冗余触发 |
| fix | cds | executor-registry 拒绝把 embedded 节点降级为 remote（防恶意远程节点冒充主节点 id 静默禁用 embedded 部署路径）|
| fix | cds | executor-registry 自动回收离线超过 24 小时的远程节点（embedded 永远保留）|
| fix | cds | env-file 备份文件 `.cds.env.bak` 显式 chmod 0600，避免 copyFileSync 沿用 umask 默认权限暴露 token |
| fix | cds | env-file 持久化失败时打印 LOUD 警告框 + 广播到 dashboard activity stream |
| feat | cds | Dashboard 新增"集群设置"面板（设置菜单 → 集群），支持一键生成连接码、粘贴加入、热切换进入 hybrid 模式、UI 退出集群 |
| feat | cds | 新增 `/api/cluster/issue-token` + `/api/cluster/join` + `/api/cluster/leave` + `/api/cluster/status` 四个端点，作为 CLI 的补充 UI 入口 |
| feat | cds | 集群连接码格式：`base64(JSON{master,token,expiresAt})`，一个字符串自包含所有字段，便于复制粘贴 |
| feat | cds | 加入集群为进程内热切换（不重启），Dashboard 继续可用；UI 显式警告下次重启会进入纯 executor 模式 |
| feat | cds | BranchDispatcher 真正接入部署流程：POST /api/branches/:id/deploy 支持 targetExecutorId 参数，自动/手动派发到远程 executor，通过 HTTP SSE 代理回传日志 |
| feat | cds | Dashboard 分支卡片展示"on: 执行器短名"徽章，实时显示每个分支跑在哪台节点 |
| feat | cds | Dashboard 集群模态新增节点管理区：每个节点独立卡片 + 排空/踢出按钮 + 内存/CPU/分支槽负载条 |
| feat | cds | Dashboard 新增调度策略切换 UI（radio）：least-load（推荐）/ least-branches / round-robin，运行时生效 |
| feat | cds | Dashboard 顶部容量徽章在集群模式自动切换为"N/M 节点 · 空闲/总槽"显示，单击查看调度器详情 |
| feat | cds | 分支部署下拉菜单新增"派发到..."子菜单，可手动指定目标执行器或选"自动（按策略）" |
| feat | cds | state-stream SSE 广播扩展为 executors + mode + capacity，Dashboard 集群变更秒级同步无需刷新 |
| fix | cds | Executor 心跳自动把远程分支同步到 master 分支列表，解决"B 的自带分支在 A 上看不见"问题 |
| fix | cds | Executor 离线时自动把其拥有的分支标记为 error + "请重新部署"，用户可点部署按钮触发 dispatcher 重派 |
| fix | cds | CPU 核数从 os.cpus().length 改为 os.availableParallelism()，尊重 cgroup v2 CPU 限制 |
| fix | cds | 部署下拉菜单溢出窗口底部时自动向上翻转或约束高度 + 内部滚动，不再被视口裁掉 |
| feat | cds | 数据迁移支持跨 CDS 密钥一键直连：新增「CDS 密钥管理」面板，可复制本机访问密钥、注册远程 CDS，源/目标均可选择密钥，HTTPS 流式传输，无需 SSH 或复杂配置 |
| feat | cds | 数据迁移重构为流式管道（mongodump \| mongorestore），彻底去除临时文件，使用 `--archive --gzip` 单流传输，修复大库迁移 `use of closed network connection` 断连问题 |
| feat | cds | SSH 迁移改用命令模式而非端口转发：`ssh jump "mongodump --archive --gzip" \| mongorestore`，加入 ServerAliveInterval=30 保活，长时间 dump 不再断流 |
| feat | cds | SSH 隧道新增「测试隧道」按钮，直接验证 ssh 连通性与远端 mongodump 可用性，不再被迫等到「无法获取数据库列表」才发现问题 |
| feat | cds | SSH 隧道新增「docker 容器名」字段，支持 `ssh jump "docker exec <container> sh -c 'mongodump...'"` 模式，兼容远端 mongo 仅以容器形态存在的场景 |
| feat | cds | 数据迁移任务卡片新增「编辑」按钮，可修改名称、源/目标、集合选择（运行中禁用）；新增 PUT /api/data-migrations/:id |
| fix | cds | 修复「新建数据迁移」对话框输入框溢出问题：主机+端口改为严格 flex 约束（mc-input / mc-host / mc-port），port 固定 68px，其他字段 `min-width:0` 防止溢出 |
| feat | cds | 新增对等 CDS 端点：/my-key /peers CRUD /peers/:id/{test,list-databases,list-collections} /local-dump /local-restore /test-tunnel，均复用现有 X-AI-Access-Key 鉴权 |
| feat | cds | MongoConnectionConfig 新增 `type: 'cds'` 与 `cdsPeerId` 字段，CdsPeer 存储于 state.json（加载时自动迁移旧状态） |
| docs | doc | design.cds.md 升级到 v3.2：新增 §7.5 运维入口与 Nginx 渲染章节（为什么只留一个脚本 / 多根域名路由规则 / 渐进式 TLS / 幂等渲染 / 与跨机 dispatcher 的边界），更新 §1 Quickstart 和 §6 环境变量体系为 .cds.env + CDS_ROOT_DOMAINS 4 变量方案 |
| docs | doc | design.cds-resilience.md §八 Layer 3 加入与 design.cds §7.5 单节点入口的边界说明；§九 单节点 runbook 更新为新的 init/start 流程 |
| feat | cds | 后端 GET /api/host-stats: 返回宿主机内存使用率、CPU loadavg、CPU 核数、运行时长,public 无 auth 5s 一次 |
| feat | cds | Dashboard 右下角(Activity Monitor 上方)新增宿主机实时负载小窗: MEM/CPU 双 bar + 百分比标签,4 色分层(< 50/75/90/>=90%),双指标 >= 90% 时呼吸灯告警动效 |
| feat | cds | 点击负载小窗弹出详情: 内存使用 GB / CPU 1分钟loadavg / 系统运行时长 + loadavg 1m/5m/15m 历史 |
| fix | cds | exec_cds.sh init 交互式 prompt 修复：read_default / read_secret 的 printf 被 $() 命令替换捕获导致脚本假死，改为 >/dev/tty 输出提示、</dev/tty 读取输入 |
| fix | cds | exec_cds.sh 的 nginx 渲染改为内容对比后才写盘 (write_if_changed)，避免每次 start 都误打印"配置已生成"噪音，自更新时 docker compose 真正感知到"无变化"而不重启容器 |
| feat | cds | 当 cds-site.conf / nginx.conf 发生变化且容器已在运行时，自动 nginx -t 校验 + nginx -s reload 热重载，用户新加的根域名立刻生效且无停机 |
| feat | cds | `./exec_cds.sh init` 现在自动检查并交互式安装依赖 (Node/pnpm/Docker/curl/openssl/python3)，缺失项给复制粘贴的安装命令 |
| feat | cds | 新增发行版检测 (Ubuntu/Debian/CentOS/Fedora/Arch/Alpine/macOS)，按发行版给对应的 apt/yum/dnf/pacman/apk/brew 安装命令 |
| feat | cds | Docker 检测区分"未安装"和"已安装但无权限"两种情况，后者给 `usermod -aG docker + newgrp docker` 修复步骤 |
| feat | cds | 依赖检查幂等：跑两次、跑到一半 Ctrl+C 再跑都能继续 |
| docs | project | 新增 `.claude/rules/quickstart-zero-friction.md` 原则：快启动必须大包大揽，假设使用者是小白，注册到 CLAUDE.md 规则索引 |
| feat | cds | Phase 2 cgroup 限制: BuildProfile.resources + compose-parser 支持 x-cds-resources / deploy.resources.limits 双源,container.runService 追加 --memory / --memory-swap / --cpus 标志 |
| feat | cds | Phase 2 JanitorService: 周期性扫描 lastAccessedAt > worktreeTTLDays 的分支并通过 callback 删除,跳过 pinned/defaultBranch/colorMarked,同时做磁盘水位告警(statfsSync) |
| feat | cds | Phase 2 Master 容器化: Dockerfile.master (multi-stage + docker CLI + healthcheck) + systemd/cds-master.service (Restart=always + security hardening) |
| feat | cds | Phase 2 GET /healthz 健康检查端点: state 可读 + docker 可达双检查,返回 200/503,public 无 auth 供 Docker/systemd/Nginx 主动探测 |
| feat | cds | Phase 3 BranchDispatcher: 读取每个 executor 的 /api/scheduler/state,按 capacityUsage.current/max 比率做 capacity-aware 派发(fallback 到 least-branches) |
| feat | cds | Phase 3 POST /api/executors/dispatch/:branch: 调度 API 支持 capacity-aware / least-branches 两种策略 |
| feat | cds | Phase 3 Nginx 模板生成器: generateUpstreamBlock + generateBranchMap + generateFullConfig,支持 draining → backup、offline → 排除、proxy_buffering off (SSE 支持) |
| docs | doc | design.cds-resilience.md v2.0: 扩展 Phase 2/3 章节 + 3 层分布式架构图 + 职责切分矩阵 + 集群部署 runbook + 单机 vs 集群决策树 |
| docs | doc | plan.cds-resilience-rollout.md: Phase 2/3 checkbox 全打勾,记录 60 个新单测覆盖,标注待运维部署项 |
| docs | doc | design.cds.md §8: 补 v3.1/v3.2/v3.3 三阶段状态表 + 核心理念三层 |
| refactor | cds | 合并 exec_cds.sh / exec_setup.sh / nginx/init_domain.sh / nginx/start_nginx.sh 为单一入口 cds/exec_cds.sh，命令收敛为 init/start/stop/restart/status/logs/cert |
| feat | cds | start 默认后台运行（nohup + PID 文件），--fg 进入前台；新增 init 交互式初始化写入 cds/.cds.env 并自动渲染 nginx 配置 |
| feat | cds | CDS_ROOT_DOMAINS 支持逗号分隔多根域名，每个根域名 D 自动生成三条路由：D → Dashboard、cds.D → Dashboard、*.D → Preview，miduo.org 与 mycds.net 可同时使用 |
| feat | cds | nginx 配置改为每次启动根据 .cds.env 重新渲染（cds/nginx/cds-site.conf），存在 certs/<domain>.crt 自动启用 HTTPS，缺省 HTTP-only 兜底 |
| refactor | cds | 根目录 exec_cds.sh 改为转发器，所有业务逻辑集中在 cds/exec_cds.sh；删除 host-env.example.sh 等遗留配置入口 |
| docs | doc | 更新 guide.cds-env.md 和 guide.quickstart.md 对齐新脚本接口，移除 .bashrc / exec_setup.sh / CDS_SWITCH_DOMAIN 等废弃表述 |
| fix | cds | exec_cds.sh 新增 --background 参数别名（等同于 daemon），修复 self-update 静默失败导致 CDS 整体宕机 |
| fix | cds | self-update spawn 改为规范 daemon 参数 + 子进程 stdout/stderr 重定向到 .cds/self-update-error.log，失败不再无声 |
| feat | cds | deploy 端点启动时检测 maxContainers 容量超售，超售发送 SSE capacity-warn 事件 + 写入 deploy log |
| docs | doc | plan.cds-resilience-rollout.md 补 Phase 1.5 pipeline 验证记录 + 3 个 pre-existing bug 根因 + Phase 2 优先级调整 |
| refactor | prd-api | 划词评论重锚定算法抽取到 `PrdAgent.Infrastructure.Services.DocumentStore.InlineCommentRebinder` 纯函数类，便于单元测试覆盖；同步新增 20 个 xunit 测试覆盖唯一命中/多处消歧/失锚/空输入/边界情况 |
| fix | prd-api | 知识库级联删除补齐三张表：删除 Store 时同步清理 `document_store_view_events` / `document_inline_comments` / `document_store_agent_runs`；删除 Entry/Folder 时按 `EntryId`/`SourceEntryId` 清理对应记录，避免孤儿数据 |

### 2026-04-09

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 新增分支温池调度器 (SchedulerService)：LRU 驱逐 + idleTTL 自动休眠 + 四源 pinning，用 maxHotBranches 为小服务器提供容量预算与故障隔离 |
| feat | cds | GET/POST /api/scheduler/{state,pin,unpin,cool}:slug 四个端点，Dashboard 可观测并手动干预温池 |
| feat | cds | 代理命中分支后自动 scheduler.touch 更新 LRU（15s 节流持久化） |
| fix | cds | StateService.save 改为原子写 + 滚动备份（state.json.bak.<ts> 保留 10 份），载入时从最新备份恢复损坏 state |
| docs | doc | 新增 design.cds-resilience.md（小服务器负载均衡设计）、plan.cds-resilience-rollout.md（可续传进度追踪），design.cds.md 补核心思想 + 文档地图 + HA 章节 |
| feat | prd-admin | 知识库卡片支持重命名：hover 时在标题右侧显示铅笔按钮，弹窗内编辑即可保存（复用 PUT /api/document-store/stores/{id}） |
| feat | prd-admin | 知识库页新增「我的空间 / 我的收藏 / 我的点赞」标签切换；收藏/点赞 tab 下点击卡片跳转 /library/{id} 公开详情页（若收藏的是自己创建的空间则进入编辑视图） |
| feat | prd-api | DocumentStoreController 新增 GET /api/document-store/likes/mine；同步增强 GET /api/document-store/favorites/mine 返回最近 3 个文档预览、店主信息及 isOwner 标记，与 stores/with-preview 卡片结构对齐 |
| feat | prd-admin | 知识库卡片支持打标签：编辑弹窗内可输入标签（回车/逗号添加，最多 10 个、单个 ≤20 字），卡片标题下展示前 4 个 # 标签 chip，超出显示 +N（复用现有 PUT /api/document-store/stores/{id} tags 字段，无需后端改动） |
| fix | prd-api | 删除知识库/文档时级联清理 document_sync_logs、ParsedPrd 正文、attachments 附件、likes/favorites/share_links；删除文件夹或 GitHub 目录订阅时递归清理子条目 |
| fix | prd-admin | 删除知识库/文档/文件夹前弹出液态玻璃二次确认（systemDialog），明确列出将清除的数据范围 |
| fix | prd-admin | 修复智识殿堂文档内锚点链接 bug：锚点/站内链接不再强制新开标签页，改为 SPA 内 scroll；外链保留 target=_blank |
| fix | prd-admin | 智识殿堂支持从 URL hash 深链：复制 `/library/{id}#章节` 打开后自动滚动到对应章节 |
| fix | prd-admin | 修复相对路径链接被错误解析为路由导航导致跳到错误知识库：相对路径如 `design.visual-agent` 现在先在当前知识库 entries 里查找匹配文档，命中则在 reader 内切换；未命中时显示删除线 + tooltip 警告"未找到文档"，不再触发错误跳转 |
| refactor | prd-admin | LibraryDocReader 链接处理改用 react-router useNavigate()，替换 pushState+PopStateEvent 的 hack |
| feat | prd-admin | 智识殿堂 LibraryDocReader 新增：顶部搜索框（标题+正文第一行模糊匹配）、标题显示模式切换（文件名 ↔ 正文第一行） |
| feat | prd-admin | DocBrowser 与 LibraryDocReader 的 Markdown 渲染器升级：支持 KaTeX 数学公式、heading 带稳定 slug ID、任务列表专属样式 |
| fix | prd-admin | 智识殿堂 Hero 卡片改为真实数据驱动：使用当前排序下的 #1 知识库（名称/作者/篇数/点赞/阅读），用 likes+views/5 的渐近曲线计算「热度」%，按钮跳转真实详情页；空数据态显示「等待第一卷藏书」引导发布 |
| feat | prd-admin | 智识殿堂阅读器（LibraryDocReader）右上角新增「全屏阅读」按钮，点击切换 fixed 全屏覆盖；ESC 退出，全屏期间锁定 body 滚动 |
| feat | prd-admin | 周报团队添加成员支持批量多选+搜索，新增 UserMultiSearchSelect 组件 |
| feat | prd-api | 周报团队新增批量添加成员 API（POST teams/{id}/members/batch） |
| fix | prd-api | AI生成周报时MAP平台工作记录严格按用户实际行为输出，零数据指标不再传入提示词 |
| fix | prd-api | 周报文档编辑统计修复用户归属：原查询遗漏UserId过滤导致统计全站文档，改用Groups.OwnerId关联，指标重命名为"创建PRD项目" |
| fix | prd-api | 周报LlmCalls自噬循环修复：排除report-agent.*的AppCallerCode，避免报告生成自身的LLM调用被统计为用户行为 |
| fix | prd-api | 周报AI生成提示词强化严格约束条款，禁止AI凭空编造、语义漂移或捏造修饰语 |
| feat | prd-api | 新增技能引导 Agent（skill-agent），5 阶段对话式引导用户创建技能 |
| feat | prd-api | 技能引导 Agent 支持导出 SKILL.md 和 ZIP 包（含 README + 使用示例） |
| feat | prd-admin | 技能管理页面新增「AI 创建」入口，打开对话式技能创建助手 |
| feat | prd-admin | 知识库订阅详情：新增订阅详情抽屉，展示状态卡（上次/下次同步、错误信息）、调整同步间隔、暂停/恢复、立即同步，并以时间线呈现"最近变化记录" |
| feat | prd-admin | 文件树为最近 24 小时内有更新的订阅文件标记 (new) 徽标，订阅条目右侧增加同步状态彩点指示器 |
| feat | prd-admin | 文档预览顶栏对订阅来源文件展示版本徽标（GitHub 类显示 #shortSha），点击直接打开订阅详情 |
| feat | prd-api | 新增 document_sync_logs 集合，订阅同步只在内容真正变化或出错时落库（无变化只更新 LastSyncAt），避免日志膨胀 |
| feat | prd-api | URL 订阅同步使用 If-None-Match / If-Modified-Since 条件请求 + ContentHash 兜底，避免被源站封控 |
| feat | prd-api | 新增 GET /entries/{id}/sync-logs 与 PATCH /entries/{id}/subscription 端点，支持查看变化日志 + 暂停/调整间隔 |
| feat | prd-api | DocumentEntry 增加 IsPaused / LastChangedAt / ContentHash / LastETag / LastModifiedHeader 字段 |
| refactor | prd-api | GitHubDirectorySyncService.SyncDirectoryAsync 改为返回 GitHubDirectoryDiff，由 Worker 决定是否落变更日志 |
| feat | prd-api | 知识库 Agent：一键生成字幕（音视频直译带时间戳字幕 + 图片 Vision 识别），输出为新 DocumentEntry `{原文件名}-字幕.md` |
| feat | prd-api | 知识库 Agent：文档再加工（4 个内置模板：摘要 / 会议纪要 / 技术博文 / 学习笔记 + 自定义 prompt），流式 LLM 输出到新 entry |
| feat | prd-api | 新增 `document_store_agent_runs` 集合 + DocumentStoreAgentWorker（BackgroundService，轮询 queued 任务，遵循服务器权威性：CancellationToken.None + Worker 关机标记失败） |
| feat | prd-api | DocumentStoreController 新增端点：`GET reprocess-templates`、`POST generate-subtitle`、`POST reprocess`、`GET agent-runs/{id}`、`GET entries/{id}/agent-runs/latest`、`GET agent-runs/{id}/stream`（SSE + afterSeq） |
| feat | prd-api | AppCallerRegistry 新增 `DocumentStoreAgent.Subtitle.Audio/Vision` 和 `DocumentStoreAgent.Reprocess.Generate` 三条调用标识 |
| feat | prd-admin | DocBrowser ContextMenu 新增"生成字幕"和"再加工"选项（按 entry contentType 显示） |
| feat | prd-admin | DocBrowser 预览顶栏对音视频/图片 entry 显示「 生成字幕」按钮，对文字 entry 显示「 再加工」按钮 |
| feat | prd-admin | 新增 SubtitleGenerationDrawer：状态卡 + 进度条 + 阶段指示 + SSE 实时刷新，完成后自动跳转到新生成的字幕文档 |
| feat | prd-admin | 新增 ReprocessDrawer：模板卡片选择 + 自定义 prompt 输入 + 流式 LLM 实时打字预览 + 完成后跳转 |
| ops | — | docker-compose.dev.yml 补上 ffmpeg / ffprobe volume 挂载（与生产 docker-compose.yml 对齐，用于视频抽音频） |
| feat | prd-admin | 百宝箱卡片支持 `wip` 字段，未正式发布的 Agent 在卡片左下角显示橙色"施工中"徽章 |
| feat | prd-api | 知识库新增观察者统计：`document_store_view_events` 集合 + 埋点端点（log/leave/list），支持同一用户多次访问、匿名访客 session token、停留时长 |
| feat | prd-api | 知识库新增划词评论：`document_inline_comments` 集合 + CRUD 端点；文档正文更新时基于 SelectedText + 上下文前后 50 字的重锚定算法（active / orphaned 状态） |
| feat | prd-admin | 新增 `useViewTracking` hook：进入文档时埋点 + visibilitychange/beforeunload 发 sendBeacon 补时长，作用于 DocBrowser 和 LibraryDocReader 两个 viewer |
| feat | prd-admin | 知识库详情页新增「访客」按钮，打开 ViewersDrawer 显示总访问量 / 独立访客 / 总停留时长 + 最近 50 条访问时间线 |
| feat | prd-admin | DocBrowser 文档阅读时支持划词评论：选中正文后浮现"添加评论"按钮，点击打开 InlineCommentDrawer，支持发表评论、定位引用原文、删除评论；文档更新后失锚评论单独分组展示 |

### 2026-04-08

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | 新增 Bridge 握手流程（用户同意握手后才激活会话） |
| feat | cds | Widget 新增 claymorphism 风格的握手审批面板（左下角弹出） |
| feat | cds | 后端新增 /bridge/handshake-request, /handshake-requests/:id/approve, /handshake-requests/:id/reject, /handshake-status/:id 端点 |
| refactor | prd-admin | LibraryLandingPage 完全重设计为 claymorphism 教育平台风格（Fredoka + Nunito 字体，奶油色背景，厚边框 + 硬投影卡片） |
| refactor | prd-admin | LibraryStoreDetailPage 同步改为 claymorphism 风格（白卡 + 厚边框 + 橙色/绿色/粉色高亮互动按钮） |
| refactor | prd-admin | 首页 LibrarySection 改为 claymorphism 风格，与 landing 页视觉一致 |
| docs | .claude | bridge skill 文档新增 Phase 1 握手流程 + Phase 1B 直接激活备用流程，明确用户邀请场景必须用握手 |
| fix | cds | 预览模式改为服务器权威：默认值改为「子域名」，切换后落库共享，移除 localStorage 独立存储（修复分享链接打开后总是默认 `simple` 模式、误触 `set-default` 污染 defaultBranch 的问题） |
| feat | prd-admin | 新增「智识殿堂」公共知识库浏览页 (/library)，支持热门/最新/高赞/高阅排序 |
| feat | prd-admin | 新增公开知识库详情页 (/library/:storeId)，宏伟的图书馆主题（径向光晕 + 浮动星辰背景） |
| feat | prd-admin | 知识库详情页右上角新增「发布到智识殿堂」开关，一键切换公开/私有 |
| feat | prd-admin | 知识库新增分享对话框：公开直链 + 自定义短链（永不/1/7/30/90 天过期 + 撤销 + 复制 + 浏览统计） |
| feat | prd-admin | 公共知识库支持点赞/收藏/复制链接互动 |
| feat | prd-admin | 首页新增 LibrarySection 板块，展示最热的 6 个公共知识库（替代原 TutorialSection） |
| feat | prd-admin | AgentLauncher 入口替换：「使用教程」→「智识殿堂」 |
| refactor | prd-admin | 删除 TutorialsPage / TutorialDetailPage / tutorialData / TutorialSection 及 /tutorials 路由（注意：tutorial-email 系统未受影响） |
| feat | prd-api | DocumentStore 新增 LikeCount/ViewCount/FavoriteCount/CoverImageUrl 字段 |
| feat | prd-api | 新增 DocumentStoreLike / DocumentStoreFavorite / DocumentStoreShareLink 模型 + 3 个 MongoDB 集合 |
| feat | prd-api | 新增公开端点：GET /api/document-store/public/stores、/public/stores/{id}、/public/stores/{id}/entries、/public/entries/{id}/content（[AllowAnonymous]）|
| feat | prd-api | 新增互动端点：POST/DELETE /stores/{id}/like、POST/DELETE /stores/{id}/favorite、GET /favorites/mine |
| feat | prd-api | 新增分享链接端点：POST/GET /stores/{id}/share-links、DELETE /share-links/{id}、GET /public/share/{token} |
| feat | prd-api | GET /public/stores/{id} 自动累加 ViewCount 浏览数 |
| chore | scripts | 新增 scripts/migrations/ 目录，提供 replace-cdn-domain.js 和 verify-cdn-domain.js，用于将 MongoDB 中残留的旧 CDN 域名 pa.759800.com 批量替换为 map.ebcone.net（递归子串替换所有集合的字符串字段，默认 dry-run） |

### 2026-04-07

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 文档浏览器支持多文档置顶（pin），右键上下文菜单替代直接设为主文档 |
| feat | prd-admin | 文件树标题显示切换：默认使用正文第一行，可切换为文件名 |
| feat | prd-admin | 搜索支持文档内容搜索（可选开关），后端存储 ContentIndex 到 MongoDB |
| fix | prd-admin | 修复知识库详情页刷新后丢失状态的 bug（sessionStorage 持久化 storeId） |
| feat | prd-admin | 知识库卡片显示最近文档预览列表，增大卡片高度 |
| feat | prd-api | DocumentStore 新增 PinnedEntryIds 字段，支持多文档置顶 |
| feat | prd-api | DocumentEntry 新增 ContentIndex 字段，上传和同步时自动截取前 2000 字存入 |
| feat | prd-api | 新增 PUT /stores/{storeId}/pinned-entries 置顶/取消置顶端点 |
| feat | prd-api | 新增 GET /stores/with-preview 端点，返回空间列表含最近文档预览 |
| feat | prd-api | ListEntries 端点新增 searchContent 参数，支持内容搜索 |
| fix | prd-admin | 文档列表左侧留白过大，非文件夹项移除空白占位符 |
| feat | prd-admin | 支持拖拽文件到文件夹（HTML5 drag & drop） |
| feat | prd-admin | 右键菜单新增删除选项（文件/文件夹） |
| feat | prd-admin | 文档在线编辑：预览面板新增编辑模式（Markdown textarea + 保存） |
| feat | prd-admin | 加号按钮改为下拉菜单：文档/上传文件/新建文件夹（已实现）+ 模板/AI写作/链接（置灰待实现） |
| feat | prd-admin | 每个文件夹允许独立设置主文档（存储在 folder.metadata.primaryChildId） |
| feat | prd-admin | 本地搜索同时匹配 title/summary/正文第一行，开启内容搜索时自动触发回填 |
| feat | prd-api | 新增 PUT /entries/{entryId}/move 移动文档条目端点 |
| feat | prd-api | 新增 PUT /entries/{entryId}/content 文档内容在线编辑端点 |
| feat | prd-api | 新增 PUT /entries/{folderId}/primary-child 设置文件夹主文档端点 |
| feat | prd-api | 新增 POST /stores/{storeId}/rebuild-content-index 回填内容索引端点 |
| fix | prd-admin | 修复拖拽文件树条目时误触发右侧上传遮罩（仅响应外部 Files 拖入） |
| feat | prd-admin | 文档浏览器左侧导航支持鼠标拖拽调整宽度（200~560px，sessionStorage 持久化） |
| feat | prd-admin | 文档浏览器左侧导航应用液态玻璃效果（backdrop-filter blur + saturate） |
| feat | prd-admin | 新建 src/lib/fileTypeRegistry.ts 文件类型注册表（PPT/Word/Excel/Code/Image 等 15 种类型） |
| fix | prd-admin | DocBrowser 文件图标从硬编码 switch 改为 FILE_TYPE_REGISTRY 查询，修复 PPTX 显示为文本图标的 bug |
| fix | prd-api | 上传端点 MIME 推断增加 .ppt/.pptx/.xls/.xlsx 支持 |
| fix | prd-api | 上传文档标题保留扩展名（便于前端按扩展名识别文件类型） |
| rule | .claude | frontend-architecture.md 新增「注册表模式」强制规则，禁止组件内硬编码 switch 类型判断 |
| fix | prd-admin | DocBrowser/DocumentStorePage 所有 Loader2 替换为统一的 MapSpinner/MapSectionLoader |
| rule | .claude | frontend-architecture.md 新增「统一加载组件」强制规则，禁止直接使用 lucide-react Loader2 |
| feat | prd-admin | 文档预览支持图片/视频/音频/PDF 直接渲染（按 fileTypeRegistry.preview 字段路由） |
| feat | prd-admin | 二进制文件兜底显示文件图标 + 下载按钮，不再"无文本内容"裸露提示 |
| feat | prd-admin | 编辑按钮仅对可编辑文本类型（md/txt/code/json/yaml/csv 等）显示 |
| fix | prd-admin | 修复一键分享缺陷时数量与列表不一致（前端传递可见缺陷 ID 列表） |
| fix | prd-api | 批量分享支持接收前端传入的 defectIds，确保分享内容与用户当前视图一致 |
| refactor | prd-admin | 分享管理用两个复制按钮替代一键分享+AI评分，直接导出用户原话+评论+VLM内容 |
| feat | prd-admin | 缺陷列表行显示缺陷编号(defectNo) |
| feat | prd-admin | 缺陷列表新增搜索框，支持按编号、标题、内容模糊搜索 |
| feat | prd-admin | 分享面板支持勾选缺陷+三种复制模式（含原图base64/含图链/含VLM描述），图片以 图1/图2 代称引用 |
| fix | prd-api | 新增缺陷附件代理端点，解决前端 base64 模式下跨域 CORS 失败 |
| fix | prd-admin | 复制内容补回 AI 工作流提示词（修复计划/评论API/标记完成 等阶段说明） |
| feat | prd-api | 新增 GitHub 目录同步功能：自动拉取指定仓库目录下所有 .md 文件到文档空间，支持 SHA 增量去重 |
| feat | prd-api | DocumentSyncWorker 支持 github_directory 源类型路由 |
| feat | prd-admin | 订阅对话框新增 GitHub 目录模式（URL 订阅 / GitHub 目录双模式切换） |
| feat | prd-api | 文档空间新增主文档功能（PrimaryEntryId + PUT /primary-entry 端点） |
| feat | prd-admin | 新增 DocBrowser 可复用组件：左侧文件列表 + 右侧 Markdown 渲染预览 |
| refactor | prd-admin | 文档空间详情页从卡片列表重构为左右分栏文档浏览器布局 |
| feat | prd-api | 知识库支持多层文件夹（DocumentEntry.ParentId + IsFolder + 创建文件夹端点） |
| feat | prd-admin | DocBrowser 升级为递归文件夹树（展开/折叠 + 面包屑导航 + 搜索自动展开） |
| refactor | prd-api | 文档空间改名为"知识库"，菜单移到首页实用工具区 |
| feat | prd-admin | 首页实用工具区新增知识库和涌现探索入口 |
| feat | prd-admin | TAPD缺陷采集与分析模板新增1p规则，AI技术服务费纳入技术专业委员会月度简报并支持逐月统计分析 |
| feat | prd-admin | 工作流脚本代码输入框升级为大尺寸编辑器，支持全屏编辑与高亮预览 |
| feat | prd-admin | 月报1p区块补充费用依据链接展示（可点击），并保留逐月统计分析表格 |

### 2026-04-06

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 文档空间文件上传存盘：串联 IAssetStorage + FileContentExtractor + DocumentService，文件真实存储到 COS/本地 |
| feat | prd-api | 文档空间内容读取 API：从 ParsedPrd 或 Attachment.ExtractedText 获取文档文本 |
| feat | prd-api | 文档订阅源：支持添加 RSS/网页 URL 作为订阅，设定同步间隔 |
| feat | prd-api | DocumentSyncWorker 后台同步引擎：PeriodicTimer 扫描到期条目，自动拉取外部 URL 内容 |
| feat | prd-api | DocumentEntry 新增同步字段：SourceUrl、SyncIntervalMinutes、LastSyncAt、SyncStatus、SyncError |
| feat | prd-admin | 文档上传改用真实 multipart 上传端点（文件落盘，不再只存元数据） |
| feat | prd-admin | 文档详情面板增加「查看文档内容」预览功能 |
| feat | prd-admin | 新增订阅源对话框（输入 URL + 选择同步间隔） |
| feat | prd-admin | 订阅源条目用 RSS 图标区分，详情面板显示同步状态 + 手动同步按钮 |
| feat | prd-api | 新增 Workspace 工作空间模型（MongoDB workspaces 集合），支持 CLI Agent 持久化多轮对话 |
| feat | prd-api | 新增 WorkspacesController（创建/列表/详情/对话/删除），对话接口 SSE 流式响应 |
| feat | prd-api | 新增工作空间读写权限（workspaces.read / workspaces.write） |
| docs | doc | 新增 design.workspace.md 工作空间设计文档 |

### 2026-04-04

| 类型 | 模块 | 描述 |
|------|------|------|
| refactor | prd_agent | 重构质量保障技能链：修复流程链缺失/编号跳跃/描述不清，分类为主流程/辅助/专项修复/文档/元技能五类，用途改为"输入→输出"格式 |
| feat | prd_agent | 新增技能百科全书 doc/guide.skill-catalog.md：35 个技能完整索引 + 合并记录 + 调用链路图 + 维护指引 |
| refactor | prd_agent | 重写 README.md 为英文版，对齐 CLAUDE.md 内容结构，补充技能链和架构模式说明 |
| refactor | prd_agent | 合并 documentation-writer + technical-writing + user-guide-writing → technical-documentation（Diátaxis + 8 模板） |
| fix | prd_agent | 修复 deep-trace 触发词从 /trace 改为 /deep-trace，避免与 flow-trace 冲突 |
| feat | prd-admin | 新增文档空间前端页面（空间列表、空间详情、文档上传、搜索、删除） |
| feat | prd-admin | 文档空间空状态引导（三步引导 + CTA 按钮 + 拖拽上传） |
| feat | prd-admin | 文档 → 涌现流转入口：文档条目可一键跳转涌现探索器，自动预填种子内容 |
| feat | prd-admin | 涌现创建对话框支持从 URL 参数预填种子（文档空间跳转来时自动打开） |
| feat | prd-admin | 新增文档空间路由 /document-store，注册到 App.tsx |
| feat | prd-admin | 新增 documentStore 前端 service 层（contracts + real + api routes + index exports） |
| feat | prd-api | 新增涌现探索器后端（EmergenceTree + EmergenceNode 模型、EmergenceService、EmergenceController） |
| feat | prd-api | 涌现探索器支持三维涌现：一维系统内探索 + 二维跨系统涌现 + 三维幻想涌现 |
| feat | prd-api | 涌现核心设计：反向自洽原则（每个节点必须有现实锚点 + 桥梁假设 + 可回溯引用链） |
| feat | prd-api | 涌现探索/涌现端点支持 SSE 流式推送，节点逐个生长到画布 |
| feat | prd-admin | 新增涌现探索器前端页面（React Flow 画布、三维度自定义节点、工具栏） |
| feat | prd-admin | 涌现树列表 + 新建对话框 + 导出 Markdown |
| feat | doc | 新增 Page Agent Bridge 技术设计文档（编码 Agent 网页操控通道） |
| feat | cds | Page Agent Bridge：编码 Agent 通过 CDS Widget 读取页面 DOM 和执行操作 |
| feat | cds | Bridge HTTP 轮询服务 + REST API（/api/bridge/*）|
| feat | cds | Widget DOM 提取器（简化文本格式供 LLM 消费）|
| feat | cds | Widget 操作执行器（click/type/scroll/navigate/spa-navigate/evaluate）|
| feat | cds | 导航请求 UI（Agent 申请 → 用户点击打开 → 自动建立连接）|
| feat | cds | Console 错误和网络异常拦截上报 |
| feat | cds | 鼠标轨迹动画（渐变蓝光标 + 旋转光环 + 目标高亮 3s 淡出）|
| feat | cds | 操作面板（Badge 上方展开，步骤列表实时状态）|
| feat | cds | 按需激活（start-session/end-session 生命周期管理）|
| feat | cds | spa-navigate 四级策略（React Link → 注入 <a> → 文字匹配 → pushState）|
| fix | cds | 命令队列从单槽改为 FIFO 数组，防止连发丢命令 |
| fix | cds | URL 变化检测去除 WebSocket 残留引用 |
| fix | cds | end-session 改为 Widget 响应后清理（非固定延迟）|

### 2026-04-03

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 新增文档空间基础设施（DocumentStore + DocumentEntry），支持文档存储、知识库内容管理 |
| feat | prd-api | 新增文档空间 CRUD API（空间创建/列表/详情/更新/删除 + 条目管理） |
| feat | prd-api | 新增 document-store.read / document-store.write 权限点与菜单入口 |
| feat | 技能 | 新增 document-emerge 涌现技能（/emerge），基于竞品矩阵驱动文档空间功能演进 |

### 2026-04-01

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 周报 Agent 支持 Webhook 通知推送（企微/钉钉/飞书/自定义），6 种事件自动外发 |
| feat | prd-admin | 团队设置新增 Webhook 通知面板，支持 CRUD 和测试连通性 |
| feat | prd-api | 产品评审员 Agent 支持 Webhook 通知推送，评审完成后自动推送评分结果到企微/钉钉/飞书 |
| feat | prd-admin | 产品评审员页面新增「通知配置」弹窗，支持 Webhook CRUD 和连通性测试 |

### 2026-03-31

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | CDS 设置新增数据迁移功能，支持 MongoDB 实例间一键迁移，含 SSH 隧道、SSE 实时进度、迁移工具自动安装 |
| feat | cds | 数据迁移支持集合级选择迁移，可勾选指定集合或全库迁移 |
| feat | cds | 数据迁移 UX 优化：数据库下拉自动加载、目标库名自动同步、任务名自动生成、连接失败降级手动输入 |
| feat | cds | 数据迁移任务卡片展示源→目标链路、集合信息、耗时、SSH 标识，支持克隆/重新执行 |
| feat | cds | 新增 list-databases / list-collections API，支持前端下拉选择 |
| fix | prd-admin | 修复 surface-row 选中态被 hover !important 覆盖，新增 data-active CSS 选中态 |
| fix | prd-admin | 修复转录工作台预览/编辑切换按钮对比度不足，改为 pill toggle 高对比样式 |
| fix | prd-admin | 修复编辑模式 textarea 无边框无法辨识，增加 border + ring 视觉区分 |
| fix | prd-admin | 修复预览模式用 pre 标签渲染，改为 ReactMarkdown 渲染 |
| fix | prd-admin | 修复 SegmentRow 编辑入口无视觉提示，增加 hover 下划线和 cursor-text |
| fix | prd-admin | 修复侧边栏三级列表层级不清，增加工作区字重、图标色、树线可见度 |
| fix | prd-admin | 修复 GenerateDialog 模板选中态 inline style 冲突，迁移到 data-active |
| fix | prd-admin | 统一状态图标颜色从 green-500 到 emerald-400 语义 token |
| fix | prd-admin | 修复轮询死循环（items 在依赖数组导致无限 re-render），改用 useRef |
| fix | prd-admin | 修复 Segment 编辑无防抖每次击键触发 API，增加 500ms debounce |
| fix | prd-admin | 修复 selectedItem 状态冗余，改为 selectedItemId + useMemo 派生 |
| feat | prd-admin | 文案编辑支持保存，新增"保存"按钮和未保存提示 |
| feat | prd-api | 新增 PUT /api/transcript-agent/runs/{runId}/result 文案编辑保存接口 |
| feat | prd-api | 新增 TranscriptRunWatchdog，自动清理卡在 processing 超 30 分钟的任务 |
| fix | prd-api | SSE 进度流增加每 10 秒 keepalive 心跳，防止连接超时断开 |
| fix | prd-api | Worker 关闭时将处理中的 run 标记为 failed，防止孤儿任务 |
| fix | prd-api | RenameItem DB 写操作从 HttpContext.RequestAborted 改为 CancellationToken.None |
| fix | prd-api | SSE 轮询 DB 查询改用客户端 ct，客户端断开后立即停止轮询 |
| feat | prd-admin | 首页实用工具区新增网页托管入口 |
| feat | prd-admin | 侧边栏导航恢复显示网页托管入口 |
| feat | prd-admin | PageHeader 支持显示标题和描述，网页托管页顶部导航栏展示页面标题 |
| feat | prd-admin | 我的资源网页 tab 支持 iframe 缩略预览图，提取 SitePreview 共享组件 |

### 2026-03-30

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-admin | 修复 TypeScript 编译错误：移除未使用的导入和变量，修正 CreateImageGenRunInput 类型标注 |
| feat | prd-api | 视觉创作工作区列表接口支持 skip 分页参数和 hasMore 标记 |
| feat | prd-admin | 视觉创作工作区列表支持无限滚动，滑动到底部自动加载更多项目 |

### 2026-03-29

| 类型 | 模块 | 描述 |
|------|------|------|
| refactor | prd-api | 重构 CLI Agent 执行器为多执行器分发架构（builtin-llm/docker/api/script），支持自由扩展新执行器类型 |
| feat | prd-api | 新增 builtin-llm 执行器，无需 Docker 直接调用 LLM Gateway 生成页面，支持多轮迭代修改 |
| feat | prd-api | 新增 api 执行器，支持调用外部 HTTP API（OpenHands/Bolt 等）生成页面 |
| feat | prd-api | 注册 page-agent.generate::chat AppCallerCode |
| feat | prd-api | 新增 create-executor 技能，引导创建和接入新的执行器类型 |
| feat | prd-admin | Exchange 测试面板支持 doubao-asr-stream 流式模式，SSE 逐帧显示识别进度 |
| feat | prd-admin | Exchange 卡片新增「一键添加到模型池」按钮，预填模型类型和别名 |
| feat | prd-api | ExchangeController 新增 SSE 流式 ASR 测试端点 (带认证，替代 AllowAnonymous 端点) |
| feat | prd-api | TranscriptRunWorker 支持 doubao-asr-stream 流式 ASR 路径（自动检测 Exchange 类型） |
| fix | prd-api | 流式 ASR segment 去重，从最后一帧 utterances 提取带时间戳的精细分段 |
| feat | prd-admin | 转录工作台 UI 重构：双栏持久化布局（左栏素材+右栏编辑） |
| feat | prd-admin | 音频播放器组件（播放/暂停/进度/倍速/文字联动） |
| feat | prd-admin | 段落可编辑（点击即编辑，失焦自动保存） |
| feat | prd-admin | SSE 转录进度条组件（阶段+百分比+实时反馈） |
| feat | prd-admin | 拖拽上传组件 + 文案生成面板独立组件 |
| feat | prd-api | 新增 GET /transcript-agent/runs/{id}/progress SSE 端点 |
| docs | doc | guide.doubao-asr-relay.md 补充 AppCallerCode 接入指南和 Gateway 统一讨论 |
| feat | prd-api | 新增 lobster 龙虾测试执行器（两阶段 LLM：先规划结构再生成），验证执行器接入范式 |
| refactor | prd-api | 重写 create-executor 技能为全自治模式，Claude 自动读代码+生成+注册+自测 |
| fix | cds | Badge 弹窗面板自适应宽度，避免内容折叠 |
| feat | cds | 日志弹窗模态框，支持一键复制和文本选择 |
| perf | prd-api | CDS API 容器添加 GC 堆限制(256MB)、分层编译、NuGet/build 缓存卷，内存限制 384M |
| perf | prd-admin | CDS Admin 容器添加 Node.js 堆限制(192MB)、pnpm store 缓存卷，内存限制 256M |
| perf | prd-api | CDS MongoDB 限制 WiredTiger 缓存 150MB、关闭诊断数据采集，内存限制 256M |
| perf | prd-api | CDS Redis 限制 maxmemory 32MB + allkeys-lru 淘汰策略，内存限制 48M |
| feat | prd-api | CDS 部署模式切换：支持 dev(热重载) / static(编译部署) 两种模式，通过 x-cds-deploy-modes 配置 |
| feat | cds | CDS 分支卡片标签行新增编辑图标，支持批量编辑标签 |
| feat | cds | 预览页新增 AI 操控蓝色边框效果，与 Dashboard 一致的视觉反馈 |
| feat | cds | resolveEnvTemplates 支持从宿主机 process.env 读取环境变量 |
| refactor | prd-api | 清理 12 个未使用的 AppCallerCode 注册项（Desktop 5 个、VisualAgent 1 个、LiteraryAgent 1 个、AiToolbox 2 个、VideoAgent 1 个、ReportAgent 1 个、Admin.Prompts 1 个），从 91 个精简至 79 个 |
| docs | doc | 新增 design.review-agent.md：产品评审员完整技术设计文档 |
| feat | prd-admin | 转录工作台加入百宝箱 BUILTIN_TOOLS |
| feat | prd-api | 新增豆包 ASR (doubao-asr) Exchange 转换器，支持异步 submit+query 模式 |
| feat | prd-api | 新增 IAsyncExchangeTransformer 接口，LlmGateway 支持异步轮询中继 |
| feat | prd-api | 模型中继新增导入模板功能，内置 3 个模板（豆包ASR/流式WebSocket + fal.ai） |
| feat | prd-admin | 模型中继管理页面新增「从模板导入」入口和对话框 |
| feat | prd-api | 新增 DoubaoAsr 认证方案，支持豆包双 Header 认证模式 |
| feat | prd-api | Exchange 测试端点支持音频文件上传测试 (test-audio) |
| feat | prd-admin | Exchange 测试面板新增音频模式，支持文件上传和 URL 测试 |
| feat | prd-api | 新增 DoubaoStreamAsrService，实现豆包 WebSocket 二进制协议流式语音识别（含 PCM 自动重采样） |
| feat | prd-api | 新增 doubao-asr-stream 转换器标记和导入模板 |
| fix | prd-api | 修复流式 ASR 音频格式声明 (wav→pcm) 和结果提取 (result 对象兼容) |
| feat | prd-api | DoubaoStreamAsrService 自动重采样 + ffmpeg 转换（MP3/M4A/OGG/FLAC/WebM/MP4/24bit WAV） |
| feat | prd-api | 流式 ASR SSE 端点 (/api/test/stream-asr/sse)，逐帧推送识别结果 |
| fix | prd-api | 修复 24bit WAV 和截断 WAV 的边界处理 |
| feat | prd-api | Dockerfile + cds-compose.yml 自动安装 ffmpeg |

### 2026-03-28

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 新增 CLI Agent 执行器胶囊（cli-agent-executor），支持调度 Docker 容器中的 CLI 编码工具生成页面/项目，支持多轮迭代修改 |
| feat | prd-admin | 前端注册 CLI Agent 执行器胶囊类型，含图标和 emoji 映射 |
| fix | prd-api | ParseReviewOutput 新增多策略解析：JSON 解析失败时自动用正则兜底提取 key/score 对 |
| fix | prd-api | ParseReviewOutput 现记录详细 parseError 诊断信息，存入 ReviewResult.ParseError |
| fix | prd-api | 处理 LLM 返回空内容的情况，以诊断信息标记而非静默产生 0 分 |
| feat | prd-admin | 评审结果页：当所有维度 0 分时显示诊断面板，含解析错误原因和原始 AI 输出 |
| fix | prd-api | 修复 ReviewAgent AppCallerCode 注册失败：将 ReviewAgent 类移入 AppCallerRegistry 内部，使反射扫描能发现它 |
| fix | prd-admin | 修复评审列表"未通过"误显示（null isPassed 历史记录现显示"已完成"） |
| feat | prd-admin | 评审列表新增"失败"筛选 Tab |
| feat | prd-admin | 全部提交页面新增状态筛选 Tab，与用户筛选联动 |
| refactor | prd-api | 评审提交筛选参数统一为 filter 字符串（passed/notPassed/error） |
| feat | prd-api | ReviewSubmission 新增 IsPassed 快照字段，评审完成时写入，重跑时清除 |
| feat | prd-api | 新增 GET /api/review-agent/submitters 端点，返回去重后的提交人列表 |
| feat | prd-api | GetMySubmissions 支持 isPassed 过滤参数 |
| feat | prd-admin | ReviewAgentPage 新增全部/已通过/未通过筛选 Tab、搜索栏和分页（50条/页） |
| feat | prd-admin | ReviewAgentAllPage 新增返回按钮和用户标签筛选（可展开/收起） |
| feat | prd-admin | ToolCard 新增 review-agent 封面图和封面视频路径映射 |
| feat | prd-admin | reviewAgent 服务新增 getSubmitters 函数，getMySubmissions 支持 isPassed 参数 |
| fix | prd-api | 修复 TryExtractJsonBlock 非贪婪正则导致嵌套 JSON 截断问题，改为先剥离 fence 再用 IndexOf/LastIndexOf 匹配最外层花括号 |
| feat | prd-api | 新增 POST submissions/{id}/rerun 端点，允许重置历史评审结果并重跑 LLM |
| feat | prd-admin | 评审结果页新增"重新评审"按钮，已完成或失败状态均可触发重跑 |
| feat | prd-api | 产品评审员 LLM 提示词严格化：明确评分原则、扣分依据、comment 扩展到100字 |
| feat | prd-admin | 评审维度配置支持编辑明细要求（description），点击展开编辑 |
| feat | prd-admin | 评审结果页维度展开时显示明细要求（蓝色标注区域） |
| feat | prd-api | 新增产品评审员 Agent（review-agent）后端：ReviewAgentController、ReviewSubmission/ReviewResult/ReviewDimensionConfig 模型、7 维度默认评审配置、SSE 流式评审输出、评审完成通知 |
| feat | prd-api | 新增 review-agent 权限常量（use/view-all/manage）及 AppCallerCode 注册 |
| feat | prd-api | MongoDbContext 注册 review_submissions、review_results、review_dimension_configs 三个集合 |
| feat | prd-admin | 新增产品评审员前端：ReviewAgentPage（列表）、ReviewAgentSubmitPage（上传提交）、ReviewAgentResultPage（SSE 实时评审结果）、ReviewAgentAllPage（全部提交，权限门控） |
| feat | prd-admin | toolboxStore.ts 首页新增"产品评审员"卡片（第三排第二位），authzMenuMapping.ts 注册三个权限点 |

### 2026-03-27

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | doc | 新增 Agent 开发入门指南 (guide.agent-onboarding.md)，面向产品经理的 30 分钟全景阅读 |
| feat | .claude/skills | 新增 agent-guide 引导技能 (/help)，支持阶段式新手教程和跨会话进度跟踪 |
| feat | .agent-workspace | 新增 Agent 开发工作区目录，每个 Agent 独立文件夹管理进度 |
| feat | .claude/skills | 新增 scope-check 技能 (/scope-check)，提交前分支受控检查，检测越界修改 |
| feat | prd-api | 新增 transcript-agent 后端骨架（Controller/Models/权限/菜单/AppCaller/MongoDB） |
| feat | prd-admin | 新增 transcript-agent 前端页面（工作区/素材/转写/模板文案/导出） |
| fix | prd-admin | 修复登录跳转（hash URL 兼容 + returnUrl 回跳） |
| fix | prd-admin | 修复上传响应解析、JSON 双重序列化、res.ok→res.success 等前端问题 |
| refactor | prd-admin | 转录工作台 UI 重设计（三栏→导航式渐进深入） |
| fix | prd-api | 修复非团队成员可在团队管理页看到所有团队的权限漏洞：ListTeams 改用 ReportAgentTeamManage 判断全量可见性，而非 ReportAgentViewAll |
| fix | prd-api | 修复 GetTeam 详情端点缺少访问控制的安全漏洞，补充成员/负责人/管理员权限校验 |
| feat | prd-admin | 文学创作支持双模型切换（提示词模型 + 生图模型），与视觉创作体验一致 |
| feat | prd-api | 文学创作新增统一生图模型池端点 + 对话模型池端点 |
| feat | prd-api | 新增文学创作 Agent 偏好设置（双模型选择持久化） |
| feat | prd-api | Gateway CreateClient 支持 expectedModel 参数，用于模型切换调度 |
| refactor | prd-admin | 文学创作头部移除 T2I/I2I 双标签，改为提示词模型+生图模型双下拉菜单 |
| refactor | doc | design 文档模板重构：新增管理摘要、受众分层（前四节禁代码）、技术章节代码 ≤30% + 上下文说明 |
| refactor | doc | 37篇 design 文档批量优化：补管理摘要(30篇)、统一头部格式(21篇)、修正过时状态(8篇)、标注废弃概念(6篇) |
| feat | doc | 新增涌现篇 design.system-emergence.md：四层架构叙事 + 5个涌现场景 + 现实→幻想三维度 |
| feat | doc | 新增 design.visual-agent.md：VisualAgent 统一主文档，15项能力 + 4场景 + 12集合 |
| feat | doc | 新增 design.report-agent.md：周报 Agent 架构，13项能力 + 4场景 + 11集合 |
| feat | doc | 新增 design.rbac-permission.md：权限系统设计，40+权限项 + 5内置角色 |
| feat | doc | 新增 design.marketplace.md：配置市场设计，注册表模式 + Fork机制 |
| feat | doc | 新增 design.llm-gateway.md：LLM Gateway 架构，三级调度 + 6种池策略 |
| refactor | doc | 重写 design.literary-agent.md：从配图扩展为完整Agent全貌，5阶段状态机 + 4场景 |
| refactor | doc | 深化 design.defect-agent.md：补充4个涌现场景（Vision协同、分享、通知） |
| refactor | doc | 深化 design.workflow-engine.md：更新管理摘要 + 补充4个涌现场景 |
| fix | doc | 删除废弃文档 design.im-architecture.md（已被 Run/Worker 替代） |
| fix | doc | 合并 design.literary-agent-v2.md 到 literary-agent.md 后删除 |
| refactor | doc | 结构重排：所有新文档故事靠前设计靠后，接口字段放末尾 |
| refactor | doc | 写作规则固化：故事靠前/永远替换/按应用归属 三条原则写入 doc-types.md |

### 2026-03-25

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 放大作品广场爱心图标，使其接近头像大小 |
| fix | prd-admin | 生图意图前缀 "Generate an image based on the following description:" 不再泄漏到画布元素和投稿展示 |
| fix | prd-api | 后端存储 ImageAsset.Prompt 和画布占位时自动剥离生图意图前缀 |

### 2026-03-24

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | cds | Activity 面板移除放大缩小控件，改为可拖拽边框调整窗口大小（左边、上边、左上角） |
| feat | cds | Activity 面板新增放大缩小控件 |
| feat | cds | 预览时隐藏右上角绿色人形图标，左下角眼睛图标改为眨眼动效 |
| fix | prd-admin | 修复视觉创作智能模式下生图提示词缺少英文前缀的问题 |
| feat | cds | 标签页标题功能：设置 tag 时用 tag 更新标题，无 tag 时默认用分支短名（去掉/前缀），设置菜单新增开关（默认开启） |
| fix | prd-admin | 智能优化模式默认关闭，仅用户手动开启才生效，禁止程序自动变更 |
| fix | prd-admin | 修复模型选择被自动覆盖的竞态：模型池未加载完时不再误判用户选择 |
| fix | prd-admin | 修复 _disconnected.conf 缺少静态资源处理，CSS/JS 文件被 SPA fallback 以 text/html 返回导致模块加载失败 |
| feat | cds | CDS proxy 在服务启动中 (starting) 时展示 loading 页面，避免请求打到半就绪的 Vite 导致 CSS MIME 错误 |
| feat | cds | Vite 默认构建配置添加 startupSignal，等待 Vite 完全就绪后才路由流量 |
| fix | prd-admin | 修复 VideoLoader 未使用变量、toast 缺少 loading/dismiss 方法、SuggestedQuestions 图标类型不兼容等 TypeScript 编译错误 |
| feat | prd-api | 新增生图提示词澄清端点 POST /api/visual-agent/image-gen/clarify，自动将用户自由文本改写为明确的英文生图提示词 |
| feat | prd-admin | 视觉创作生图流程集成提示词澄清，直连模式下自动优化提示词，降低生图失败率 |
| fix | prd-api | 修复 Gemini 通过 OpenAI 兼容网关代理时生图响应解析失败：增加响应体 candidates 特征检测，不再仅依赖 platformType |
| fix | prd-api | 修复 Google 生图 COS 上传失败时错误被吞为"响应解析失败"：COS 异常不再阻断生图，回退 base64 内联返回 |
| fix | prd-admin | 修复 imageDone URL 为空时的幽灵状态：既不显示图片也不显示错误，现在明确报错并允许重试 |
| feat | prd-admin | 新增生图 watchdog：每 15s 检查卡住超过 2 分钟的 running 项目，自动查询后端恢复图片或标记失败 |
| fix | prd-api | 初始化应用改为增量同步（upsert），保留专属模型池绑定和调用统计 |
| fix | prd-admin | 同步结果弹窗从满屏红色列表改为数字摘要卡片+可折叠详情 |
| refactor | prd-admin | 模型池管理页改为左右分栏 master-detail 布局，减少视觉噪音 |
| fix | prd-api | 修复文学创作预览图片无法显示：GetAssetFile 端点缺少 literary-agent 域搜索路径 |
| fix | prd-api | 修复文学创作工作区详情缺少 AssetIdByMarkerIndex 过滤，导致配图资源无法正确匹配 |
| fix | prd-api | 修复文学创作工作区详情缺少 TrySyncRunningMarkersAsync，导致卡住的配图标记无法自动恢复 |
| fix | prd-api | 修复旧数据配图回填：markers 存在但无 asset 关联时，按时间顺序自动建立关联 |
| feat | prd-admin | 文学配图卡片：图片区改为 4:3 宽高比，prompt 文字默认半可见(2行) hover 全可见(3行)，参考 Pinterest/Dribbble 渐进展示 |
| feat | prd-admin | 统一加载组件体系：PageTransitionLoader(页面级) + MapSectionLoader(区块级) + MapSpinner(行内级)，替代散落 80+ 处的 Loader2 animate-spin |
| refactor | prd-admin | 30 个文件批量迁移到统一加载组件，移除冗余 Loader2 引用 |
| fix | cds | 将 .cds/state.json 从 Git 跟踪中移除并加入 .gitignore，防止敏感环境变量（JWT Secret、云存储密钥等）泄露到仓库 |
| fix | cds | API 端点 GET /build-profiles 和 GET /env 返回值中对敏感字段进行脱敏处理 |
| feat | prd-admin | 页面跳转/懒加载期间播放 CDN 视频加载动画，替代空白等待 |
| fix | prd-admin | 修复视觉创作智能优化/解析模式面板颜色反转（AUTO徽章和橙色边框之前显示在错误的模式上） |
| fix | prd-admin | 生成新图/添加图片时视角只缩小适应不再放大，避免用户反复手动缩小视野 |
| refactor | prd-admin | 「解析模式」重命名为「直连模式」，移除直连模式的 planImageGen 调用，直接将原始输入发给生图模型 |
| feat | prd-admin | 作品广场改为瀑布流布局，图片按原始宽高比展示 |
| feat | prd-admin | 作品广场滚动到底部自动加载下一页（替代手动加载更多按钮） |

### 2026-03-23

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | 构建时锤子图标改为闪烁 + 按钮边缘发光，替代旋转动画 |
| fix | cds | branch-card 支持 server-driven 构建状态动画，外部触发的部署也能联动 |
| fix | prd-api | 修复机器人头像不显示：AvatarUrlBuilder 使用 User 重载以正确解析 BotKind 默认头像 |
| fix | prd-api | 修复用户发送消息时附件ID未保存到 Message 实体，导致图片丢失 |
| fix | prd-api | MessageResponse 和 GroupMessageStreamMessageDto 新增 AttachmentIds 字段 |
| fix | prd-desktop | 用户消息气泡支持渲染图片附件 |
| fix | prd-desktop | 发送消息时保留本地附件信息，SSE 合并时不丢失 |
| fix | prd-api | 修复文学创作投稿只显示 5/8 张图：不再过滤 ArticleInsertionIndex 为 null 的图片，简化为 Space 整体查询 |
| refactor | prd-api | Worker 更新 AssetIdByMarkerIndex 改用 MongoDB 原子 $set，消除并发竞争 |
| fix | prd-desktop | 修复服务器选择下拉框样式错乱，改用自定义下拉组件适配 Glass UI |
| fix | prd-desktop | 更新按钮样式更醒目（实色背景+阴影），提升可发现性 |
| feat | prd-desktop | macOS 更新安装后弹窗提示用户手动退出重启，不再依赖无效的自动重启 |
| fix | prd-desktop | 菜单"检查更新"对话框从无用的 OK 按钮改为"立即更新/稍后"确认框，点击立即更新直接下载安装 |
| feat | prd-desktop | Header 标题右侧显示版本号（v1.x.x），mono 字体偏右下角，亮/暗主题自适应 |
| feat | prd-api | 后端启动自动种子 18 个内置引导提示词到 skills 集合（PM/DEV/QA 各 6 个） |
| refactor | prd-desktop | 服务器选择改为三卡片布局（主站/测试站/备用 + 其他自定义），移除"我是开发者"开关 |
| fix | prd-api | 修复总裁面板排行榜 AppCallerCode 别名未归一化，导致 prd-agent-desktop 等作为独立维度泄漏 |
| fix | prd-api | 修复 Agent 统计端点缺少 report-agent 和 video-agent 的路由前缀和已知 key |
| refactor | prd-api | 提取 ExecutiveController 共享的别名映射和归一化逻辑为类级别方法，消除重复 |
| fix | prd-admin | 修复同项目作品缩略图右侧生硬截断，添加 mask 渐隐提示可滚动 |
| fix | prd-admin | ToolCard hover 缩放从 110% 降为 104%，减少圆角溢出感 |
| fix | prd-admin | 修复文学创作投稿时为每张配图创建独立 visual 投稿导致首页刷屏的问题，改为仅创建一个 workspace 级别的 literary 投稿 |
| fix | prd-admin | 文学创作手动投稿增加配图检查，无配图时提示先生成 |
| feat | prd-admin | 首页作品广场卡片增加管理员悬浮撤稿按钮 |
| feat | prd-api | 新增管理员撤稿 API (DELETE /api/submissions/{id}/admin-withdraw) |
| feat | prd-api | 新增历史数据清理端点 (POST /api/submissions/cleanup-literary-visual)，清除文学创作误建的 visual 投稿 |
| fix | prd-api | 修复文学创作投稿详情只显示 1 张图的问题：Worker 保存图片时未设 ArticleInsertionIndex 且未更新 AssetIdByMarkerIndex |
| fix | prd-api | 修复投稿详情兜底查询将所有无索引图片分到同一组只取 1 张的问题 |
| feat | doc | 新增投稿画廊展示规格文档 (spec.submission-gallery.md)，明确视觉创作单图投稿 vs 文学创作 Space 投稿的粒度差异 |
| feat | prd-admin | 文学创作页新增按时间/按文件夹视图切换，偏好保存到 sessionStorage |
| feat | prd-admin | 文学创作工作区卡片改为 NotebookLM 风格（有配图则显示最新配图，无则用渐变背景） |
| feat | prd-admin | 文学创作卡片按时间视图左上角显示文件夹名，按文件夹视图不显示 |
| feat | prd-admin | 作品广场改为统一等高网格布局（16:10 比例），替代瀑布流，视觉/文学卡片风格统一 |
| feat | prd-admin | 作品广场网格自适应列宽，视窗越宽显示越多列 |
| feat | prd-api | 文学创作列表接口新增 latestIllustrationUrl 字段（每个工作区最新生成的配图 URL） |
| feat | prd-admin | 首页作品广场文学创作专属卡片（LiteraryCard），区分视觉/文学展示风格 |
| feat | prd-admin | 文学创作列表页改为时间线布局，同一文件夹内按天分组陈列 |
| fix | prd-api | 修复 28 个 Controller 的 GetAdminId/GetUserId 回退到 "unknown" 的安全隐患，统一使用 GetRequiredUserId 扩展方法 |
| fix | prd-admin | 全站 localStorage 替换为 sessionStorage，关闭浏览器即清空缓存，部署后强制重新登录 |
| refactor | prd-api | 禁用 MongoDB 自动建索引，改为 DBA 手动执行（doc/guide.mongodb-indexes.md） |
| feat | prd-api | 文件上传自动检测文本/二进制：已知格式用提取器，其他尝试 UTF-8 解码，通过 null 字节和控制字符比例判断 |
| feat | prd-desktop | 三阶段文件上传体验：已知格式直接放行、已知二进制立即拒绝、未知格式标记"探测中"后上传并反馈结果 |
| feat | prd-desktop | 逐文件上传进度面板，实时显示每个文件的状态（排队/检测/上传/成功/失败） |
| feat | prd-admin | 附件和追加文档支持三阶段检测：已知放行、已知拒绝、未知格式客户端快速探测 null 字节 |
| refactor | prd-desktop | 移除文件格式白名单和 read_text_file 命令，所有文件统一走 upload 接口 |
| feat | prd-api | 对话完成后自动生成推荐追问（轻量模型，5秒超时，失败静默） |
| feat | prd-admin | 新增推荐追问 UI 组件，支持点击自动发送 |
| feat | prd-api | Message 模型新增 SuggestedQuestions 字段，支持历史回放 |
| fix | prd-api | 修复 UTF-16 编码文件被 null 字节检测误判为二进制的问题（支持 UTF-16 LE/BE 和 UTF-32 LE BOM 检测） |
| fix | prd-admin | 追加文档和附件上传增加 20MB 前端文件大小校验，避免大文件浪费带宽后被后端拒绝 |

### 2026-03-22

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 成本中心：ModelGroupItem 新增定价字段（InputPricePerMillion/OutputPricePerMillion/PricePerCall），模型统计 API 返回成本估算 |
| feat | prd-admin | 成本中心：新增预估成本 KPI、成本构成面板、明细表增加图片数和预估成本列 |
| fix | prd-api | 移除 LlmRequestLogs/ApiRequestLogs 的 TTL 自动删除机制，改为普通索引，保留全部历史数据 |
| feat | prd-admin | 日常记录新增 Todo 系统标签与下周/下下周目标周选择，Todo 输入提示改为“计划做些什么？”，并支持编辑与展示计划周 |
| feat | prd-api | 日常记录条目新增 planWeekYear/planWeekNumber，Todo 条目保存时强制校验 ISO 周 |
| feat | prd-api | 周报生成在“下周计划”章节优先读取目标周匹配的 Todo 条目（读取所有命中目标周）并作为 AI 与规则兜底的数据源 |
| fix | prd-admin | 日常记录系统标签改为 Todo 与其它系统标签互斥（快速录入与编辑态一致） |
| fix | prd-api | 保存日常记录时增加 Todo 与其它系统标签互斥兜底校验，拦截非法组合 |
| feat | prd-admin | 周报页新增可交互“使用指引”面板：默认收起，支持管理员/成员视角切换与一键跳转操作 |
| feat | prd-admin | “使用指引”升级为全局蒙版模式：仅保留顶部按钮开关，覆盖周报/团队/设置模块，最小化干扰正式页面 |
| fix | prd-admin | 修复全局指引浮层在侧边导航场景下的遮挡与对齐问题，并下调蒙版透明度与浮层高度提升轻量质感 |
| fix | prd-admin | 周报相关界面用户可见文案将“打点”统一调整为“记录”（含提示文案与趋势标签） |
| feat | prd-api | 周报详情新增“浏览记录”能力：记录每次查看事件（精确到秒），提供去重人数与总浏览次数汇总，并按用户标记“常来”（浏览次数>5） |
| feat | prd-admin | 周报详情页头部新增“已阅 N”轻量标签，支持查看浏览明细（秒级最近浏览时间、个人浏览次数与“常来”标识） |
| fix | prd-api | Mongo 索引初始化补齐 channel_tasks 的 CreatedAt TTL 自愈升级，兼容历史普通索引避免部署启动崩溃 |
| fix | prd-api | Mongo 索引冲突识别补充 Code/Message 兜底，避免 CodeName 缺失时未进入 TTL 自愈分支 |
| fix | prd-admin | 修复首页作品广场瀑布流布局空隙问题，从 CSS Grid 改为 CSS columns |
| feat | prd-admin | 统一文学创作和视觉创作的投稿图标为 Send |
| feat | prd-admin | 新增手动投稿按钮，支持将当前页面已生成内容一键投稿（文学创作 + 视觉创作） |
| feat | prd-admin | 实验室新增工具箱 Tab，支持历史素材批量迁移投稿（幂等） |
| fix | prd-admin | 创建用户对话框角色选项从硬编码4个改为使用 ALL_ROLES 动态渲染全部12个角色 |
| fix | prd-desktop | 同步 UserRole 类型定义，补全 HR/FINANCE/RD/TEST/COPYWRITER/CSM/SUPPORT/SALES 8个新角色 |
| fix | prd-admin | 缺陷评论区支持 Markdown 渲染，修复加粗/列表等格式显示为原始标记的问题 |
| fix | prd-api | 修复作品广场水印预览图始终显示"无预览"，PreviewUrl 为运行时计算字段未持久化 |
| fix | prd-api | 已驳回的缺陷不再出现在驳回人（指派人）的列表中，只对提交人可见 |
| fix | prd-admin | 修复缺陷详情面板严重程度下拉菜单被对话框 overflow-hidden 遮挡的问题 |
| fix | prd-admin | 综合排行榜 report-agent 列显示为中文"周报" |
| fix | prd-admin | 维度排行榜长条改为以最高值为100%的相对比例渲染 |
| feat | cds | 分支搜索无匹配时自动在线刷新远程分支，显示搜索中状态 |
| fix | prd-admin | 综合排行榜进度条分母上限封顶30天 |
| refactor | prd-api, prd-admin | 排行榜移除冗余维度(消息/会话/群组/开放/对话)，新增图片生成/工作流/竞技场/周报Agent/视频Agent |
| feat | prd-admin | 维度排行榜卡片按使用人数倒序排列 |
| fix | prd-api | 修复 DefectSeverity 枚举不匹配：后端新增 Trivial 常量，更新 validSeverities 使用 All 数组（DEF-2026-0037） |
| fix | prd-api | 修复清理上下文后消息仍显示：GetGroupMessages 端点新增 reset marker 过滤（DEF-2026-0049） |
| fix | prd-api | 新增 AiScoreWatchdog 后台服务，自动检测并标记超时的 AI 评分任务为失败（DEF-2026-0018） |
| fix | prd-api | 修复水印预览不显示：移除预览端点所有权限制 + 新增自愈重新渲染机制（DEF-2026-0062） |
| fix | prd-api | 修复新用户无模板：ListTemplates 接口在用户无模板时补充内置默认模板（DEF-2026-0020） |
| fix | prd-admin | 修复 AuthUser.role 类型与 UserRole 枚举不一致的 TS 编译错误 |
| fix | prd-admin | 新增 tutorialData.ts 模块，修复 TutorialDetailPage 缺失模块导入错误 |
| fix | prd-admin | 清理 TutorialDetailPage 未使用的导入和变量 |
| fix | prd-admin | 未登录访问根路径默认跳转公开首页(/home)而非登录页，退出登录显式跳转到登录页(/login) |
| fix | prd-admin | 修复下载弹窗卡片内文件名文字重叠 |
| fix | prd-admin | 修复缺陷管理图片预览关闭后残留幽灵遮罩层（灯箱缺少z-index） |
| fix | prd-admin | 修复系统弹窗（驳回/完成缺陷等）被缺陷详情面板盖住的根因，Dialog组件新增zIndex prop |
| feat | prd-api | 新增 POST /api/users/force-expire-all 接口，一键过期所有用户令牌 |
| feat | prd-admin | 用户管理页新增"一键过期"按钮，强制全员重新登录 |
| fix | prd-admin | 修复缺陷管理图片预览弹窗无法关闭且层级错误，改用独立 Radix Dialog 嵌套 |
| fix | prd-admin | 修复切换用户登录后侧边栏头像显示为默认头像（impersonate 未传递 avatarFileName） |
| feat | prd-admin | 首页和 AI 百宝箱智能助手卡片点击后弹窗引导下载桌面端（含缓存+直接下载） |
| fix | prd-admin | 修复 SubmissionCard 中 HeartLikeButton 点赞动效未触发的问题 |
| fix | prd-api | 文学创作投稿详情和工作区详情仅展示当前版本配图，隐藏重新生成的旧版本 |
| feat | prd-admin | 新增作品广场独立全屏页面，替换首页缺陷管理快捷入口 |
| feat | prd-admin | 投稿水印 Tab 复用海鲜市场 MarketplaceWatermarkCard 组件，支持"拿来吧"Fork |
| feat | prd-api | 新增 POST /api/submissions/{id}/fork-watermark 从快照 Fork 水印（不要求原配置公开） |
| feat | prd-api | 投稿详情水印数据补充 forkCount、创建者名称/头像、预览图 URL |
| fix | prd-api | 水印创建者名称兜底：空字符串 → 投稿者名称；旧快照 → submission.OwnerUserName |
| fix | prd-api | fork-watermark 端点 nullable double → non-nullable 类型默认值 |
| feat | prd-admin | 新增 HeartLikeButton 心型点赞特效组件（心跳+粒子+波纹），注册到特效专区 |
| feat | prd-api | 投稿列表接口补充 viewCount 字段 |
| feat | prd-admin | SubmissionCard 观看数圆角胶囊样式，万级自动缩写 |
| feat | prd-admin | SubmissionDetailModal 点赞按钮替换为 HeartLikeButton 特效 |
| feat | prd-api | 水印快照存储完整配置（大小/透明度/位置/偏移/图标/边框/背景/圆角） |
| feat | prd-admin | 投稿详情水印 Tab 使用 WatermarkDescriptionGrid 组件展示完整配置 |

### 2026-03-21

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | cds | SSE 端点添加 30s keepalive 心跳，修复 Cloudflare 524 超时导致 pairing-stream 反复断连 |
| feat | cds | CDS Activity 面板每条记录前显示来源分支 ID（截取最后一段），方便定位请求来源 |
| feat | prd-api | 扩展 UserRole 枚举，新增行政/财务/研发/测试/文案/客成经理/客服/销售 8 个业务角色 |
| feat | prd-admin | 新建 roleConfig.ts 统一角色元数据（中文标签、专属图标、颜色），全站角色显示中文化 |
| refactor | prd-admin | 消除角色颜色定义散落（UserSearchSelect/UsersPage/ExecutiveDashboard），统一引用 ROLE_META |
| fix | prd-admin | 广场排序：CSS columns 改 CSS grid，修复 API 返回顺序被打乱的问题 |
| fix | prd-admin | 详情页增加「参考图」「水印」tab，提示词 tab 包含风格词和系统提示词 |
| fix | prd-admin | 详情页右下角增加同项目作品扇形输出列表 |
| feat | prd-api | 投稿新增 GenerationSnapshot 快照：创建时采集完整输入配方（模型、提示词、参考图、水印），详情 API 返回 4 Tab 完整数据 |
| feat | prd-api | 新增 backfill-snapshots 回填端点，为已有投稿补充生成快照 |
| fix | prd-api | 修复文学配图对技术文档类文章拒绝生成的问题，增加不可拒绝约束和技术文档风格推断 |
| fix | prd-admin | 文学创作单张生成也触发自动投稿（之前只有批量一键导出才触发） |
| fix | prd-api | COS 上传超时从默认 45s 提升到 120s，解决大图上传超时问题 |
| feat | prd-api | 文学投稿改为公开 workspace 模式：广场封面动态取最新资产，新图自动出现 |
| fix | prd-admin | 修复作品广场图片不显示问题(display:none+lazy loading冲突) |
| fix | prd-admin | 修复文学创作tab切换后整个面板消失 |
| feat | prd-admin | 作品广场瀑布流布局重构为Lovart风格有机布局 |
| feat | prd-api | 作品广场排序改为点赞数+时间双降序 |
| feat | prd-api | 作品详情API返回生成参数(模型/图生图/涂抹/系统提示词) |
| feat | prd-admin | 详情弹窗左侧加宽+阴影渐隐，右侧新增生成参数标签 |
| feat | prd-api | 新增文学创作workspace批量迁移投稿端点 |
| feat | prd-api | 新增作品投稿系统：Submission + SubmissionLike 模型、SubmissionsController（公开列表/创建/点赞/取消点赞/自动投稿） |
| feat | prd-admin | 首页新增作品广场瀑布流展示区（ShowcaseGallery），支持分类筛选和分页加载 |
| feat | prd-admin | 视觉创作生图完成后自动投稿到作品广场 |
| feat | prd-admin | 文学创作配图完成后自动投稿到作品广场 |
| feat | prd-admin | 投稿卡片展示：头像+用户名（左下）、爱心+点赞数（右下） |
| feat | prd-admin | 作品详情弹窗：视觉创作（大图+提示词+同项目作品）、文学创作（缩略图列表+大图+正文/提示词tab） |
| feat | prd-api | 作品详情 API（GET /api/submissions/{id}）：含关联资产、文章内容、浏览计数 |
| feat | prd-api | admin 用户历史图片迁移接口（POST /api/submissions/migrate） |
| feat | prd-api | Submission 模型新增 ViewCount 浏览计数字段 |
| feat | prd-api | 百宝箱消息反馈（点赞/踩）API 端点 |
| feat | prd-api | 百宝箱对话分享链接 API（创建+查看） |
| feat | prd-api | 直接对话 SSE 流返回 token 用量 |
| feat | prd-admin | 消息反馈持久化（thumbs up/down） |
| feat | prd-admin | 对话分享功能（生成公开链接） |
| feat | prd-admin | 键盘快捷键（Ctrl+Shift+N/E/Backspace, Esc） |
| feat | prd-admin | 系统提示词可视化（左侧面板折叠展示） |
| feat | prd-admin | 助手消息显示 token 用量 |
| fix | prd-admin | 修复工具箱重发功能：不再重复用户消息，正确携带原始图片附件 |
| feat | prd-admin | 工具箱会话标题自动从首条消息生成，前端实时同步 |
| feat | prd-admin | 内置 Agent 支持"自定义副本"，一键 fork 为可编辑的自定义智能体 |
| feat | prd-admin, prd-api | 会话支持双击重命名（新增 PATCH sessions/{id} 端点） |
| feat | prd-admin, prd-api | 聊天面板展示当前使用的模型名称 |
| feat | prd-admin | 内置 Agent 注册系统提示词，便于 fork 时预填 |
| feat | prd-api | 百宝箱会话搜索：支持按标题模糊匹配 (MongoDB regex) |
| feat | prd-api | 百宝箱会话排序：支持 lastActive/created/messageCount/title |
| feat | prd-api | 百宝箱会话归档：切换归档状态，默认排除已归档 |
| feat | prd-api | 百宝箱会话置顶：切换置顶状态，置顶始终排在最前 |
| feat | prd-admin | 会话列表搜索输入框，防抖300ms |
| feat | prd-admin | 会话排序下拉菜单 (最近活跃/创建时间/消息数/标题) |
| feat | prd-admin | 会话归档按钮 + "显示已归档"开关，归档会话降低透明度 |
| feat | prd-admin | 会话置顶按钮，置顶会话显示 Pin 图标 |
| feat | prd-api | 百宝箱 DirectChat 启用 IncludeThinking 并透传 thinking SSE 事件 |
| feat | prd-admin | 百宝箱对话展示大模型思考过程（可折叠，复用 SseTypingBlock） |
| feat | prd-admin | 文件上传预验证（类型+大小 20MB 限制），拒绝不支持的文件 |
| feat | prd-admin | 上传进度改为逐文件显示文件名和大小，增强附件预览样式 |

### 2026-03-20

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api | 团队新增“AI分析Prompt”配置能力：`/api/report-agent/teams/{id}/ai-summary-prompt` 支持获取/更新/重置，团队汇总生成链路改为“团队已提交周报 + 生效 Prompt”驱动，并增加团队级默认 Prompt 常量与 `ReportTeam.TeamSummaryPrompt` 持久化字段 |
| feat | prd-admin | 设置页管理区新增“团队周报AI分析Prompt”模块（填充第三列空位），交互对齐“AI生成周报Prompt”（系统默认只读 + 团队自定义可保存/恢复默认 + 状态标识 + 团队切换）并打通对应前端 contracts/api/service 调用链 |

### 2026-03-19

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | ModelResolver 强制校验 AppCallerCode 必须已注册到 `llm_app_callers`，未注册时直接报错而非静默回退默认池 |
| fix | prd-api | 移除启动时自动同步 AppCallerRegistry 的 HostedService，改为仅通过管理后台手动「初始化应用」触发 |
| fix | prd-admin | 修复应用模型池管理页分页 Bug（默认 pageSize=50 导致仅加载前 50 条，report-agent 等应用不可见），改为一次加载全部 |
| feat | prd-admin | 初始化应用结果改为模态框展示删除/孤儿清理/新建的完整列表，替代原来的 toast 通知 |
| fix | prd-admin | 补全应用显示名称映射（report-agent、video-agent、workflow-agent 等）；统一周报设置页个人设置与管理设置卡片网格，确保两个模块尺寸与排列一致对齐；“添加扩展源”入口改为敬请期待提示并隐藏具体添加界面；在“我加入的团队”视角隐藏并禁用“团队周报AI分析”入口，仅负责人/副负责人可操作；调大“AI生成周报Prompt”页系统默认 Prompt 只读输入区默认高度，并同步拉长自定义 Prompt 区域默认高度（rows + minHeight 双保险） |
| refactor | prd-admin | 废弃提示词管理页，功能统一迁移至技能管理页：新增魔法棒、拖拽排序、系统指令 Tab |
| refactor | prd-admin | 技能编辑器分简洁/高级模式：核心区只显示名称+角色+提示词，其余字段折叠到「高级配置」 |
| refactor | prd-api, prd-desktop, prd-admin | 彻底移除旧提示词系统：删除 IPromptService/PromptService/PromptStagesController/PromptStagesOptimizeController/PromptSettings 模型、Desktop get_prompts 命令及 PromptClientItem 类型、Admin PromptStagesPage 及 prompts 服务层；SkillParameter 迁移至 Skill.cs；SkillService 移除迁移代码和 IPromptService 依赖 |
| fix | prd-admin | 修复右侧编辑器面板不撑满高度的布局问题；移除无用的文学创作 Tab |
| fix | prd-desktop | 移除旧 get_prompts 5 分钟轮询（技能统一后 ChatInput 已走 get_skills 事件驱动） |
| fix | prd-api | 提示词迁移技能时 SkillKey 从标题生成有意义的名称，替代 legacy-prompt-N-role 格式 |
| fix | prd-api | 全面审计并修复 AppCallerRegistry 一致性：补注册 `prd-agent.skill-gen::chat`、`prd-agent.arena.battle::chat`、`video-agent.video-to-text::chat`、`video-agent.text-to-copy::chat`、`channel-adapter.email::classify`、`channel-adapter.email::todo-extract` 共 6 个缺失 appCallerCode；修复 Controller 中错误类路径引用；移除 AppJsonContext 中 4 个不存在的类型引用 |
| refactor | prd-admin | useSseStream hook 增强：支持 POST/body/headers/动态 URL 覆盖 + connectSse 服务层工具 |
| refactor | prd-admin | 8 个 SSE 组件迁移至 useSseStream/connectSse 基础组件（PromptStagesPage、QuickActionConfigPanel、DesktopLabTab、WorkflowChatPanel、imageGen、literaryAgentConfig、ExecutionDetailPanel、ArenaPage） |
| refactor | prd-admin | ArenaPage handleRetry/handleSend 去重，提取 launchBattle 公共方法 |
| fix | prd-api | ViewShare agentInstructions URL 修复：读取 X-Forwarded-Host/Proto 避免返回容器内部地址 |
| fix | prd-admin | AI 评分 SSE 404 修复：闭包陷阱导致 fetch('') 请求页面路径 |
| enhance | prd-admin | AI 评分面板改为表格布局：表头排列严重度/难度/影响/综合分，点击行展开理由，色块徽章替代进度条 |
| fix | prd-api | 缺陷分享 3 个外部端点(view/report/fix-status)添加 AiAccessKey 认证方案，修复 X-AI-Access-Key 403 |
| fix | prd-admin | 分享复制提示词 X-AI-Impersonate 改为当前用户名，增加 Bearer Token 备选认证方式 |
| feat | prd-api | AI 评论端点 POST share/view/{token}/comments：外部 AI Agent 可在缺陷对话中发表评论 |
| feat | prd-api, prd-admin | DefectMessage 新增 Source/AgentName 字段，前端 AI 消息展示蓝色 AI 徽章 |
| enhance | prd-api | fix-status 端点增强：自动标记 IsAiResolved + ResolvedByAgentName |
| enhance | prd-admin | 分享复制提示词重写为 6 阶段工作流（列清单→评论→报告→修复→验收→标记完成） |
| feat | 技能 | 新增 ai-defect-resolve 技能：AI 辅助缺陷修复标准工作流 + 安全协作规则 |
| feat | prd-api, prd-admin | 附件持久化 AI 图片描述：AddAttachment 接受 description 参数，提交缺陷时保存 Vision 解析结果 |
| enhance | prd-api | ViewShare 返回增强：附件按类型分组(screenshots/logs/files) + 携带 AI 描述 + 消息历史 + 分析优先级指引 |
| feat | cds | CDS 自动更新小组件：proxy 动态注入 vanilla JS widget 到 HTML 响应（零侵入前端项目），支持单服务/全量更新按钮（SSE 实时进度），`/_cds/api/*` 透传路径，可拖拽浮窗 |
| fix | cds | 删除卡片内联部署日志框（挤压布局），部署日志改为仅通过工具栏日志按钮查看 |
| fix | cds | 白天模式日志/终端面板配色修复：改用暖色系浅背景，文字颜色跟随主题变量 |
| fix | cds | Widget 注入修复（/verify 交叉验证）：非 HTML 资源保留压缩传输、支持 gzip/br/deflate 解压注入、304 直接透传、SSE reader 加 catch |
| fix | cds | 白天模式刷新闪烁修复：theme 初始化移至 head 内联脚本，CSS 加载前生效 |
| fix | cds | 自动更新分支选择改为自定义 combobox（可输入+下拉列表），修复 ID 冲突/下拉裁剪/icon 过小/widget 401 认证 |
| feat | cds | 新增"清理非列表分支"功能：一键删除不在 CDS 部署列表中的本地 git 分支（保护 main/master/develop/当前分支） |
| fix | prd-api, prd-admin | LLM 日志用户信息增强：列表和筛选元数据接口补充 DisplayName 字段，前端显示格式改为"姓名 用户名" |
| fix | prd-api | LLM 日志 MECE 全量补全 UserId：覆盖 BeginScope 路径(ArenaRunWorker/DefectAgentController/PreviewAskService/PromptStagesOptimize) + GatewayRequest 路径(Toolbox 全系适配器/VideoGenRunWorker/VideoToDocRunWorker/WorkflowAiFillService/WorkflowAgentController/ImageMasterController/TutorialEmailController) |
| feat | prd-api | LlmRequestLogWriter 写入时检测 UserId 为空自动输出 Warning 日志，防止未来新增调用路径遗漏 |
| feat | prd-api | 模型池自动探活：新增 ModelPoolHealthProbeService 后台服务，周期性探测不健康端点并自动恢复，支持并发锁、冷却期、可配置参数 |
| feat | prd-api | 模型池故障/恢复通知：全池耗尽时创建管理员通知（Key 幂等去重），探活恢复后自动关闭故障通知并发送恢复消息；Gateway 层向请求失败用户发送个人通知 |
| feat | prd-api | 快捷模型池配置 API：新增 POST /api/mds/model-groups/quick-setup 端点，一次性创建带降级链的模型池并可选绑定 AppCaller |
| feat | prd-api | LLM 日志探活标记：LlmRequestLog 新增 IsHealthProbe 字段，探活请求在日志中独立标记，便于管理后台过滤 |
| feat | prd-admin | 工作流创建后直接跳转画布页面，而非编辑器页面（新建、测试模板、导入模板三种入口统一） |
| feat | prd-api, prd-admin | 自定义智能体多格式文件支持：上传 PDF/Word/Excel/PPT 时自动提取文本内容注入 LLM 上下文，新增 IFileContentExtractor 服务（DocumentFormat.OpenXml + PdfPig），Attachment 模型增加 ExtractedText 字段，DirectChat 端点支持 attachmentIds 参数 |
| fix | prd-desktop | 清理冗余桌面图标源 `app-icon.png`，统一仅使用 `icon.png` 生成 `src-tauri/icons/*`，避免替换图标后运行仍显示旧图标 |
| fix | prd-admin | Safari 弹窗显示不全：Dialog 居中方式从 `fixed inset-0 m-auto h-fit` 改为 Overlay flex 居中，修复 Safari 不支持 `height: fit-content` 在 fixed 定位下的布局问题 |
| fix | prd-admin | Safari 兼容性批量修复：`backdrop-filter` 全量补齐 `-webkit-` 前缀（7 处 CSS + 24 处内联样式）、`@property` 动画降级（`@supports` 回退 `transform: rotate`）、`conic-gradient` 添加 `linear-gradient` 回退、内联 `inset: 0` 展开为 `top/right/bottom/left`、`aspect-ratio` 添加 `@supports` 降级 |
| fix | prd-admin | Safari Dialog 输入框 focus 发光被裁剪：`overflow-y-auto` 滚动容器添加 `-mx-1 px-1` 呼吸空间，防止 Safari 裁剪子元素 `box-shadow` 溢出 |
| fix | prd-admin | 文学创作配图卡片入场特效 Safari 降级修复：`transform:rotate` 回退改为静态渐变边框淡入淡出，消除矩形伪元素旋转溢出的对角线伪影 |
| feat | prd-api, prd-desktop, prd-admin | 桌面客户端更新加速：后台自动将 GitHub Release 缓存到 COS，客户端优先走加速端点（3s 超时回退 GitHub），管理后台新增"更新加速"设置页签，支持手动触发缓存和查看状态 |
| feat | prd-desktop | 更新提醒新增"极速下载"标签：加速源命中时通知弹窗和设置页更新面板均显示闪电图标+琥珀色主题，区分 GitHub 回退源 |
| feat | skills | 新增 skill-validation 需求验证技能（/validate）：8 种需求气味检测 + 功能雷同排查 + 七维度 RICE/WSJF/ISO 29148 混合打分 + 综合判定（通过/改进/驳回），融合 ARTA/Paska 学术模式，补全质量保障链条的需求阶段 |
| fix | prd-admin | 百宝箱卡片缩小至原来 1/3~1/4 大小，grid 改用 auto-fill + minmax(140px) 使列数随屏幕宽度自适应；修复 Spotlight 边框溢出；全站补全 agent 封面图映射（首页/百宝箱/Agent切换器 三处统一，新增 arena/shortcuts/workflow/report）；自定义工具卡片底栏显示作者头像+名字+使用次数 |
| feat | prd-desktop | 主题切换升级为 View Transition API 水波纹动效：从按钮位置圆形 clip-path 扩散，替代旧的 520ms 线性过渡，不支持的浏览器自动降级为瞬时切换 |

### 2026-03-18

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-api, prd-admin | 缺陷分享一键分享 + AI SSE 流式评分（实时推送打字效果和逐条评分结果） |
| feat | prd-api | 新增外部 AI Agent 标记缺陷修复状态端点（fix-status），自动通知缺陷提交者 |
| feat | prd-api | ViewShare 端点增强 LLM 友好响应（含 agentInstructions、操作流程、端点 schema） |
| feat | prd-admin | 分享复制剪贴板改为完整 AI 提示词（含 API 地址、认证说明、操作步骤） |
| feat | prd-admin | AI 评分实时面板：阶段提示、LLM 打字效果、评分表逐行动画 |
| rule | 全局 | CLAUDE.md 新增强制规则：LLM 交互过程可视化（禁止空白等待） |
| feat | prd-admin | 新增 SSE 基础组件库：useSseStream hook、SsePhaseBar、SseTypingBlock、SseStreamPanel |
| feat | 全局 | 新增 llm-visibility 技能：LLM 交互过程可视化审计 + 组件指南 |
| feat | cds | ClawHub 暖色调仅亮色模式：H27° 暖米背景、暖褐文字、朱红 accent、海沫绿 success、alpha 透明度边框/阴影、径向暖光晕；暗色模式保持原翡翠绿方案不变（tag: pre-clawhub-theme 可还原） |
| fix | cds | 白天模式颜色修复：背景纯白、饱和度提升、modal/日志面板适配、accent 颜色加深 |
| fix | cds | 重新部署时立即清除之前的拉取/部署错误信息（前后端同步清除） |
| feat | cds | 主题切换按钮移至顶部栏，View Transition API 水波纹动效（圆形clip-path扩散），暗色 #131314/#1E1F20、亮色 #FFFFFF/#F0F4F9 |
| feat | cds | 清理孤儿分支：新增"清理孤儿分支"入口（设置菜单），自动 fetch 远程后对比，删除远程已不存在的本地分支及其容器和 worktree |
| feat | cds | 启动成功标志：设置菜单新增配置入口（基础设施和路由规则之间），为每个服务指定日志中的启动成功字符串（如 "Now listening on"），CDS 监听容器日志检测到后才标记为运行中 |
| feat | cds | 停止状态视觉反馈：停止容器时卡片周围闪烁红光脉冲动画 + 端口徽章红色闪烁 + "正在停止"状态徽章 |
| fix | cds | 部署日志显示不全：内联日志从 8 行增至 20 行、默认高度从 120px 增至 280px、容器日志尾部从 100 行增至 500 行、操作日志持久化容器输出 |
| feat | cds | 中间态 UX 增强：构建中/启动中/停止中端口徽章独立样式、分支卡片状态徽章提示、构建中蓝色脉冲动效 |
| feat | cds | 容器容量检查重构：停止按钮增加下拉三角选择要停止的分支（最早启动排前），显示标签图标+标签名；全部服务运行中的分支无需额外提醒，仅部分运行时显示警告 |
| feat | cds | 无默认分支时自动选中 main/master 作为默认分支 |
| feat | prd-desktop | 缺陷管理列表行补充缺陷编号和截图缩略图显示 |
| feat | prd-desktop | 缺陷列表视图改为单行紧凑布局（对齐 web 端），新增图片预览缩略图及全屏预览 |
| feat | prd-admin | 缺陷列表视图新增图片预览缩略图（状态列左侧），支持 hover 高亮和点击全屏预览 |
| fix | prd-admin | 缺陷列表头部漏光修复：改用 surface-inset 统一样式 |
| fix | prd-admin, prd-desktop | 缺陷管理默认视图改为列表模式，视图切换按钮列表优先 |
| feat | prd-desktop | 缺陷详情面板合并优化：双栏布局、截图画廊+lightbox、[IMG]标签解析、验收/关闭/删除操作、内嵌弹窗替代prompt()、角色标识 |
| feat | prd-desktop | 新增 Tauri 命令：verify_pass_defect、verify_fail_defect、close_defect、delete_defect |
| feat | prd-api | 周报创建接口新增 creationMode（manual/ai-draft），支持创建后自动调用大模型生成草稿并保持 Draft 状态；新增“我的 AI 数据源”接口（默认日常记录+MAP平台工作记录），并将 MAP 开关接入 AI 草稿上下文；新增“我的 AI 生成周报 Prompt”接口（获取/更新/恢复默认），生成链路改为“数据源 + 生效 Prompt + 模板要求”组合提交大模型；AI 自动生成结果补充模型标识字段（autoGeneratedModelId/autoGeneratedPlatformId/autoGeneratedBy）；语雀扩展源支持 spaceId/命名空间/URL 多格式匹配知识库；新增“我的日常记录自定义标签”接口（用户级）用于新增/修改/删除标签持久化；日常记录保存接口增加标签多值归一化（去空白、去重、保序） |
| feat | prd-admin | 周报创建卡片新增“手动填写/AI生成周报草稿”双入口，AI 模式直接回填生成内容并保留失败降级提示，编辑页文案升级为“AI重新生成草稿”并替换原生 confirm 为系统确认弹窗，详情页/详情弹窗评论输入框改为当前板块内就地展开；“我的数据源”改为先展示默认两项并支持 MAP 开关，个人扩展源移除 GitLab，扩展源弹窗增强选中态可读性并补齐语雀 spaceId 配置链路；设置页移除“数据统计/团队数据源”模块并新增“AI生成周报Prompt”模块（系统默认可查看、自定义可保存与恢复默认）；周报 AI 生成提示补充具体生成模型信息（规则兜底时显示“规则兜底”）；周报来源标签映射为配置对应中文名称；“设置”移除自定义打点标签入口，日常记录页保留系统默认分类并新增轻量自定义标签管理（新增/修改/删除），并打磨管理区微交互（更弱 hover、更紧凑编辑态、更轻输入反馈）；标签区新增“管理标签”分割线与独立操作区，固定“其它”末位展示，系统标签与自定义标签统一支持多选、再次点击取消，并在提交前校验至少选择一个标签 |
| fix | prd-api | 修复“AI生成周报草稿”静默失败导致空草稿伪成功：LLM失败/空响应/解析失败/零条目时不再写空模板；新增规则兜底生成（基于日常记录/MAP统计自动产出草稿）保障可用性；创建接口返回 `aiGenerationError` 明确暴露失败原因；增强 LLM 内容解析兼容（OpenAI/Claude 外层包裹、think 标签与文本字段变体）并补充采集统计日志用于定位；新增启动自动同步 AppCallerRegistry 到 `llm_app_callers`，确保新 appCallerCode 无需手动初始化即可在管理台可见 |
| fix | prd-admin | 修复日常记录标签显示与编辑不一致：避免未显式选择时误显示“其它”，新增与编辑统一为同一套多选标签规则并保持顺序一致；修复时间戳缺失导致左侧圆点/文本列宽不一致引发的列表错位，对时间列采用固定宽度占位对齐；周报编辑页新增空结果防御，并消费创建接口 `aiGenerationError` 精准提示失败原因 |
| chore | scripts | 优化 Cloud Agent 启动环境：预热 prd-admin pnpm 缓存、统一 pnpm 安装策略，并在启动阶段直接验证 `dotnet build prd-api` 与 `pnpm -C prd-admin tsc --noEmit` |
| feat | prd-desktop, prd-api | 增强"保存为技能"：支持多轮对话选择器，从用户教导+AI回复中提炼技能草案（含标题/描述/分类/图标自动建议） |
| feat | prd-api | 新增 SkillMdFormat 序列化器：Skill 模型与 SKILL.md 跨平台标准格式双向转换，prd-agent: 命名空间扩展兼容 Claude Code/Cursor/Copilot 等 14+ 平台 |
| feat | prd-api | 新增技能导出/导入 API：GET /api/prd-agent/skills/{key}/export 导出 SKILL.md、POST /api/prd-agent/skills/import 从 SKILL.md 创建技能 |
| feat | prd-api | generate-from-conversation 端点同步返回 skillMd 字段，AI 提炼后直接生成标准 SKILL.md 内容 |
| feat | prd-desktop | SaveAsSkillModal 新增两步流程：对话选择 → SKILL.md 预览，支持"保存为文件"和"保存到账户"双路径 |
| feat | prd-desktop | SkillManagerModal 新增导入/导出功能：导入 SKILL.md 文本创建技能、导出个人技能为 SKILL.md 文件 |
| feat | prd-desktop | 新增 Tauri 命令：export_skill、import_skill、save_skill_to_file（系统保存对话框） |
| refactor | prd-api | 合并提示词系统到技能系统：promptstages 数据启动时自动迁移到 skills 集合，ChatService 改用 ISkillService 解析 promptKey，客户端 /api/v1/prompts 端点改读 skills |
| fix | prd-admin | 修复 favicon 和左上角 Logo 引用不存在的文件导致破图，统一使用 favicon.jpg |
| fix | prd-admin | 侧边栏导航项图标与文字拉近，圆角矩形统一包裹图标+文字 |
| fix | prd-admin | 海鲜市场路由移入 AppShell 内部，保留侧边导航栏 |
| fix | prd-admin | 通知弹窗按钮(去处理/标记已处理/一键处理)添加 hover 和 active 反馈效果 |

### 2026-03-17

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | 修复 SSE 流占位消息跳过发送者信息解析导致机器人头像显示为默认头像 |
| fix | prd-desktop | 修复群列表右键菜单非群主也显示"解散该群"的问题，改为仅群主可见 |

### 2026-03-16

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-desktop | 移植缺陷管理列表页面从管理后台到桌面客户端 |

### 2026-03-15

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-desktop | 群组管理功能：解散群、退出群、添加成员、系统消息展示 |

### 2026-03-14

| 类型 | 模块 | 描述 |
|------|------|------|
| fix | prd-api | CDS 重启时仅终止 node/tsx 进程，避免误杀其他端口占用者 |
| fix | prd-api | 解决 CDS 重启端口冲突（EADDRINUSE） |

### 2026-03-13

| 类型 | 模块 | 描述 |
|------|------|------|
| docs | doc | 新增周报功能完整操作指南 |
| refactor | doc | 重命名 research.ai-report-systems → design.ai-report-systems |

### 2026-03-12

| 类型 | 模块 | 描述 |
|------|------|------|
| feat | prd-admin | 团队周报 UX 改进：设置页使用 GlassCard、分支卡片三区布局重设计 |
| fix | prd-admin | CDS 分支卡片移除多余标签，修复布局问题 |
| feat | prd-admin | 新增XX功能 |
| fix | prd-api | 修复XX问题 |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 重构（不改变外部行为） |
| `docs` | 文档变更 |
| `perf` | 性能优化 |
| `chore` | 构建/工具/依赖变更 |

## [1.7.0] - 2026-03-20

> **用户更新项**
> - 新增群组管理功能（解散群、退出群、添加成员）
> - 修复机器人头像显示为默认头像的问题
> - 桌面端新增缺陷管理列表

### 2026-03-17
...（原有日条目保留）

---

## [未发布]
（新的未发布条目从这里开始）
```

版本标题下的 `用户更新项` 区块用于：
1. Tauri 自动更新弹窗的 `body` / `notes` 展示
2. GitHub Release Notes
3. 内部通知 / 群公告
