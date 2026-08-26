| feat | llmgw | 网关可清理 MAP 遗留配置：删除模型池/模型时落回 model_groups 与 llmmodels，补上「阻挡清单数得出来、却没有端点扫得掉」的缺口 |
| feat | llmgw | 平台托管默认池对「指向已删上游的死成员」放开摘除，活成员仍受 append-only 保护 |
| test | prd-api | 新增 GatewayLegacySweepGuardTests：钉住 MAP 分支存在、先算引用再删、死成员判定必须两侧都查不到 |
