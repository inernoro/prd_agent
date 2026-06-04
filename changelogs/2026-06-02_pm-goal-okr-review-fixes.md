| fix | prd-admin | OKR 仪表盘「按周期」聚合改为按结构化周期(cycleId→名称)分组，与顶部周期筛选口径一致(此前仍按旧 period 文本，结构化周期下会全落「未设周期」) |
| test | prd-api | 新增 PmGoalProgressTests：覆盖 PmKeyResult.ComputeProgress 的百分比/数值/递减型 KR/span=0/越界裁剪/binary 及叶子 KR 均值汇总 |
