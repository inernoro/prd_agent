| feat | prd-admin | PPT 创作工作台未连接 CDS Agent 时整页禁用，给「前往连接」引导卡 + 重新检测，不再放行到必然降级的生成 |
| feat | prd-api | 新增 GET /api/md-to-ppt/connection-status 返回 CDS 连接状态 |
| fix | prd-api | 并行逐页生成统计降级兜底页数，done 事件回报 degraded/total，杜绝把全页降级当成功 |
| fix | prd-admin | PPT 生成有页退化为「标题+要点」兜底时如实告知页数 + 警告 toast，不再一律报「PPT 已生成」 |
| fix | prd-api | 降级页数改用 per-page 标记统计，修复 retry 兜底后 EmitAsync 抛异常被外层 catch 重复计数 |
| fix | prd-api | MdToPptRun 持久化 degraded/total 并由 GetRun 返回，刷新/断线恢复仍如实告警降级 |
| fix | prd-admin | 三处 run 恢复路径读取 degraded，降级时同样弹告警 + 改写完成文案，不再报普通成功 |
