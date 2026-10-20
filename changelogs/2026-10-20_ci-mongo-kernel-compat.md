| ci | platform | 临时固定服务端 CI 的兼容 runner，保留 Mongo 8.0 与原测试范围，并接入防漂移检查和版本回执 |
| test | platform | 强化 CI 编译与测试步骤守卫，拒绝完整注释管线及命令注释冒充实际执行 |
| fix | platform | 将本次 Mongo CI 守卫接入既有阻断链，补最终汇总 shell 与旧 runner 进程正反控制，保留整批发布脚本检查的原边界 |
| fix | platform | 将同一 Mongo 守卫同时接入实际必需的服务端检查和精确触发路径，保留根检查诊断，纠正仅凭 CI 汇总推断保护的边界 |
