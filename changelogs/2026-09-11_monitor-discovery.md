| feat | cds | 监控自发现：服务在自检响应里申报「该怎么监控我」，CDS 插上一个地址即建监控项，端点改了自动跟上、没了自动下线 |
| feat | llmgw | serving 深度自检的两条 check 补 cds:monitor 自描述段 |
| refactor | cds | 删掉 cds-monitors.yml 与它的导入契约守卫——声明改由端点自报，两处声明只会各自漂移 |
| docs | platform | 新增 spec.platform.monitor-discovery.md（协议字段表 + 三条命门 + 谁能插） |
