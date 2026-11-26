| feat | llmgw | 每日刷新官方模型候选目录，查询明确的淘汰公告和同类推荐 |
| feat | prd-api | TAPD 缺陷草稿支持固定型号或跟随默认，定向提醒近期淘汰并接入稳测 |
| fix | prd-admin | TAPD 草稿只展示本次成功整理所用的模型名 |
| test | prd-api | 将 TAPD 淘汰检查状态接入现有 48 小时稳测 |
| test | prd-api | 在 48 小时稳测中单独记录 TAPD 淘汰检查结果 |
| fix | prd-api | TAPD 草稿仅保留明确给出的预期结果并使用受控模型调用 |
| test | prd-api | TAPD 预览分支独立验证淘汰检查且不发送通知 |
| fix | prd-api | TAPD 模型淘汰检查遇到临时失败时一小时后重试 |
| fix | llmgw | 每日模型清单按视频用途展示匹配的上游建议 |
