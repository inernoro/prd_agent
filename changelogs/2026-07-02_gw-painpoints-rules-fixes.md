| rule | doc | 新增 5 条规则治网关剥离痛点：living-status-board（活状态看板 SSOT）/ real-visual-acceptance（真视觉验收）/ parallel-workstreams（默认并线 Workflow fan-out）/ extraction-readiness-gate（剥离干净度记分卡 + 可发布 gate）/ cds-dual-exit-topology（双出口须 2 HTTPS + 容器职责透明） |
| docs | llm-gateway | 新增活状态看板 plan.llm-gateway.status-dashboard.md（记分卡 + 容器拓扑澄清 2前端+3后端+2共享infra + 可发布 gate），以后看这一页不用反复问 |
| fix | cds | 双出口 HTTPS：branches.ts 命名子域/网关/别名出口 5 处硬编码 http:// 改 https://（nginx *.<root> 已在 443 用同一通配证书服务命名子域，此前误印成 http 才致「1 HTTPS + 3 HTTP」）；激活需合 main/CDS 自更新 |
| feat | prd-llmgw-serve | serving 引擎补 ServingKeyIntegrityCheck（只读、仅告警、不重加密）：把「serving 到底能不能解密真实平台密文」从盲区变成容器日志里可见的 [ServingKeyIntegrity] 行，对齐 design §3.4「网关侧也跑密钥自检」 |
