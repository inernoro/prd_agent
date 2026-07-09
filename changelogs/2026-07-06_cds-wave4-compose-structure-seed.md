| feat | cds | 波4 repo cds-compose.yml 降为纯结构种子:x-cds-env 剥离全部密钥/占位符键(密钥统一走 CDS env scope) |
| feat | cds | 波4 新增 classifyEnvSeed(seed 级 env 权威) + computeComposeDrift(repo->CDS 单向漂移巡检纯函数) |
| feat | cds | 波4 新增 POST /api/projects/:id/compose-drift-scan 端点,漂移可开 repo-sync PendingImport 走人审(去重,不回写 repo) |
| chore | cds | 偿还 debt D1 代码层:剥离 cds-compose.yml 的 TODO 密钥占位,消除全量 import 被拒根因(运行实例注入验证仍为唯一 blocker) |
