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
