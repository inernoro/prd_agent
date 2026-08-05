| feat | prd-api | 团队洞察端点支持 from/to 精确区间，12 处查询补上界；窗口解析抽成纯函数 InsightWindowResolver |
| fix | prd-api | 团队洞察时间窗此前只有下界没有上界，meta.to 仅是响应时刻不参与过滤，按周取数会把窗口外数据卷进来 |
| fix | prd-api | seriesAvailable 与实际是否返回序列不一致（无界窗口返回 30 天序列却声明没有），改为报实际结果 |
| feat | prd-api | 新增采用度端点 /api/executive/adoption：以显式 token 列表为骨架 left-join，把「本窗 0 次 / 无信号 / 未采集 / 标签写错」四种零区分开 |
| feat | skill | 周报技能从四源扩到六源，新增团队与用量、上线→采用两段；能力条目增加机器可读的「用量口径」标签 |
| feat | prd-api | 新增用量口径 token 守卫，校验源取注册表实际前缀而非更窄的 app-identity 清单 |
| feat | prd-admin | 周报 route token 守卫并入 navCoverage，复用同一份路由提取，避免判据分裂 |
| polish | prd-admin | 窗口标签在查历史区间时报真实区间，不再一律写「近 N 天」 |
| ci | ci | doc/report.*.md 登记进 server 与 admin 的 path filter，只改周报的 PR 不再跳过用量口径守卫 |
