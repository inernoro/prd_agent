| fix | cds | 存量连接不再自动补 report:read：那等于在用户没重新看过授权页的情况下扩大一张已签发的长期令牌，改为管理员显式开 CDS_GRANT_REPORT_READ_TO_EXISTING 才补，逐条留痕（Codex P1） |
| fix | cds | memcached 认证判据区分大小写：小写 -s 是 unix socket、大写 -S 才是 SASL，此前一台走 socket、没配任何认证的实例会被判成已认证并通过门禁（Codex P2） |
| fix | cds | nacos 上下文路径去掉首尾斜杠再拼：运维按 servlet 习惯写成 /nacos 时会拼出双斜杠，探活、列命名空间、导出、导入全部打错路径（Codex P2） |
| fix | prd-api | 试跑转正的激活步骤加补偿：写库抛异常时回滚父记录认领与票据、删掉子记录并如实报错，否则那唯一一次转正机会永久作废而接口回的是成功（Codex P1 第二轮） |
| chore | cds | rabbitmq 与 nacos 的真容器用例改为 CDS_DOCKER_TESTS=1 才跑：两者在 GitHub runner 上都因镜像与环境不兼容起不来（erlang cookie 权限 / 老 JDK 读不了 cgroup v2），与备份脚本无关 |
| test | cds | 补 12 条判据：默认不补 scope、已有 scope 并不覆盖新权限、memcached 大小写、nacos 三种上下文路径写法 |
| docs | cds | debt.cds.md 新增 E53，记下两个真容器用例没跑起来的确切原因与重开方式 |
