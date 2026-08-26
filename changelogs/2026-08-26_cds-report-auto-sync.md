| feat | prd-api | CDS 验收报告镜像库每小时自动同步，照着各库首次导入的范围重放（单份报告 / 单项目 / 全量都能保持新鲜） |
| docs | prd-api | debt.knowledge-base 补「CDS 验收报告自动同步」已知边界 |
| fix | prd-api | 换 CDS 源时把旧源的增量水位一起清掉：来源字段无条件改成新源、水位却留着旧源的游标，自动同步会拿 A 的游标去列 B 的报告，B 上更新时间更早的报告被永久跳过且无任何报错 |
| test | prd-api | 「同一个源吗」收敛成唯一判据 + 6 条等价写法用例，另加两条源码守卫（真的清了水位、判断没被抄成第二份），两处均做过红绿闭环 |
| fix | prd-api | 每小时同步的闸改用 `CanRunSharedScheduledWork`：原来走的 `IsAuthoritativeDeployment` 按契约只管通知，分支预览打开「接管全局告警」的逃生阀就会顺带获得对共享库和 CDS 跑周期拉取的权限 |
| test | prd-api | 新增 `CanRunSharedScheduledWork`（软开关只能收紧不能放宽）三条行为用例 + 一条接线守卫，做过红绿闭环 |
