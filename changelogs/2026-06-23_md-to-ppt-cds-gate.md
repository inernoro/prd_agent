| feat | prd-admin | PPT 创作工作台未连接 CDS Agent 时整页禁用，给「前往连接」引导卡 + 重新检测，不再放行到必然降级的生成 |
| feat | prd-api | 新增 GET /api/md-to-ppt/connection-status 返回 CDS 连接状态 |
| fix | prd-api | 并行逐页生成统计降级兜底页数，done 事件回报 degraded/total，杜绝把全页降级当成功 |
| fix | prd-admin | PPT 生成有页退化为「标题+要点」兜底时如实告知页数 + 警告 toast，不再一律报「PPT 已生成」 |
