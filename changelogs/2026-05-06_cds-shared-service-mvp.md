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
