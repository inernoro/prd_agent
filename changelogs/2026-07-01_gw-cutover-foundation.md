| feat | cds | 分支详情面板多出口：GET /branches/:id/subdomain-aliases 新增 gatewayUrls（读 cds.subdomain 标签、复用 forwarder 同源判定 + 63 octet 守卫 + 去重），BranchDetailPage 显示「主应用入口」+「网关入口」两组 + 有网关时预览按钮带下拉「打开网关」（point 0） |
| refactor | prd-api | 六处直连收口 A 类：Program.cs ILLMClient 工厂 + ModelDomainService.GetClientAsync 改走 gateway.CreateClient（A 类本是运行时死路，近零风险清理）；AppCallerRegistry 新增 3 个通用 caller（main-client/intent-client/vision-client）；保留主→config→env 兜底 |
| feat | prd-api | LLM 请求 transport 观测标记：LlmRequestLog/LlmLogStart/LlmRequestContext 加 nullable GatewayTransport（inproc/http/shadow/direct SSOT），网关/HttpClient/直连各标来源，日志页可辨请求走哪条路径（L1，翻 http 前置） |
| refactor | prd-api | 六处直连 B 类（ModelLab/Arena）保留直连锁定语义（测 admin 选中 platform+model、故意绕池，走池会破坏「选 A 测 A」），仅补 direct 观测标记 + 注释；全网关路由留待网关支持 pinned 入口 |
| test | prd-api | MECE 网关测试：直连守卫棘轮（baseline 外新直连即 fail）+ 网关 no-key 401 契约常开 [Fact] + 网关端点解析/防串号集成骨架 |
