| feat | cds | 周期备份补上 postgres：新增 pg_dump 导出、psql 恢复与数表取证，手工下载不再掉进只有空壳的 tar 兜底 |
| refactor | cds | 收敛「这是什么库」的三份判据（backupKindOf / 下载端点 detectKind / 暴露面 detectInfraKind）到一份，并支持用服务 id、容器名兜底识别 |
| fix | cds | 备份执行层改成穷尽分支：新增备份类型忘了接线时由编译器报错，不再静默掉进 redis 的 BGSAVE 分支 |
| feat | cds | 备份结论新增范围提示：postgres 只导出目标库时，同实例其它未纳入的库当场报进一轮结论 |
| security | cds | memcached / kafka / nats 三个预设补认证（-Y 认证文件 / SASL_PLAIN / --user --pass），并给 catalog 加 entrypoint 字段让口令只在容器内展开 |
| security | cds | 认证门禁不再对 memcached / kafka / nats 静默放行，判据与暴露面自检收敛成同一份 |
| fix | cds | 暴露面自检对这三类不再硬编码「无认证」，改为读真实配置，避免配好认证的库长期误报 critical |
| chore | cds | cdscli 的 nats 模板与 demo-events-nats / demo-stream-kafka 两个示例工程同步改成带认证 |
| docs | cds | debt.cds.md 新增 E48（postgres 备份缺口）、E49（三个预设无认证 + 门禁缺口）、E50（docker run 的 env 值不转义双引号），E16 结项 |
| test | cds | 补 postgres 备份的真容器用例：起库塞数据 → 导出 → gzip -t → 清库 → 灌回 → 比对行数，外加守 ON_ERROR_STOP 的「坏 dump 必须失败」一条 |
| fix | cds | nats 口令不再进容器 argv：改为容器内写 chmod 600 的 authorization 配置再 -c 加载（真容器实测抓到，sh -c 只挡住宿主那一侧） |
| fix | cds | kafka 监听器改名 CLIENT：名字带下划线时镜像的 env→属性转换表达不出 JAAS 属性名，容器 `!1: unbound variable` 起不来 |
| fix | cds | kafka 认证判据改为顺着 security.protocol.map 解析生效协议，不再看广播地址的字面前缀（改个名就能骗过） |
| fix | cds | 真容器测试补上镜像拉不到时的跳过原因，不再静默 skip |
