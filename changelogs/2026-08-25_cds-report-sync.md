| fix | cds | 系统互联长效 token 补上 report:read：MAP 的验收报告导入器一直在用它调 /api/reports，而 CDS 只在 /api/bridge/* 上认这个 token，一半接好一半没接，同步从来没成功过 |
| security | cds | 长效 token 的放行判据从「路径前缀」收成一张 (scope, 方法, 路径) 表：report:read 只放行两个 GET，同路径上的 POST 新建与 DELETE 删除一律拒绝 |
| refactor | cds | 默认 scope 列表收敛成一份导出常量，授权页、authorize 端点与回包不再各写一遍 |
| fix | cds | 启动时给存量系统互联连接幂等补上 report:read，否则判据加了、线上那条已配好的连接照样 401 |
| feat | prd-api | 新增每 60 分钟运行的 CDS 验收报告同步任务：只在权威部署上跑，只刷新已存在的镜像库不替人建库，单个用户失败不影响其他人 |
| refactor | prd-api | 镜像库 AppKey 收敛成常量，后台任务与导入服务不再各写一遍字面量 |
| test | cds | 补 18 条权限边界判据（每条放行都配一条拒绝 + 无 scope 的反面对照），并做红绿闭环验证判据放宽会变红 |
