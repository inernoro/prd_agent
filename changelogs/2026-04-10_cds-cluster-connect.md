| feat | cds | 新增 `./exec_cds.sh connect/disconnect/issue-token/cluster` 子命令，一条命令加入 CDS 集群 |
| feat | cds | 主节点 standalone → scheduler 自动热升级，首个 executor 注册时触发，无需重启 |
| feat | cds | 新增 `GET /api/executors/capacity` 端点，总容量（分支槽/内存/CPU）随执行器加入自动扩充 |
| feat | cds | 主节点作为 `role=embedded` 执行器自注册，容量汇总包含主机自身资源 |
| feat | cds | Bootstrap 两段式 token 机制：一次性 token（15 分钟过期）换永久 executor token |
| feat | cds | 新增 `cds/src/services/env-file.ts` 原子读写 `.cds.env` 工具模块 |
