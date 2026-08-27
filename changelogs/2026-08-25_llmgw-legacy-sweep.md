| feat | llmgw | 网关可清理 MAP 遗留配置：删除模型池/模型时落回 model_groups 与 llmmodels，补上「阻挡清单数得出来、却没有端点扫得掉」的缺口 |
| fix | llmgw | 平台托管默认池不再否决它自己派生出来的模型——删模型时同步摘掉托管池成员，解开「要删模型先摘成员、托管池又不许摘成员」的死锁 |
| feat | llmgw | 托管默认池对「指向已删上游的死成员」放开手工摘除，活成员仍受 append-only 保护 |
| test | prd-api | 新增 GatewayLegacySweepGuardTests：钉住 MAP 分支真的删到 MAP 集合、删除排在引用检查之后、死成员判定四条早退、摘成员只动托管池 |
