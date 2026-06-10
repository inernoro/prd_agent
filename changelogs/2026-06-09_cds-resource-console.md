| feat | cds | 将分支服务标签升级为统一资源 chip，新增后端分支资源聚合 API，并在分支抽屉新增应用、数据库、缓存资源控制台 |
| feat | cds | 新增资源外部访问策略、资源审计查询和数据库克隆任务状态，MySQL 空库创建可生成分支级独立连接变量 |
| feat | cds | MySQL clone-main 任务接入 mysqldump 后台复制，执行过程中记录进度、失败原因，并在完成后注入分支级连接变量 |
| feat | cds | 分支资源控制台新增 MySQL 资源级备份列表、手动备份和恢复覆盖接口，恢复前自动生成安全备份并写入破坏性操作审计 |
| feat | cds | 资源连接页新增 MySQL 分支凭据重置、连接变量注入依赖应用和反向依赖展示，注入写入分支 profile override 并记录审计 |
| feat | cds | MySQL 资源数据页接入只读表列表、schema、数据预览和只读 SQL Console，查询按分支数据库执行并记录审计 |
| feat | cds | PostgreSQL 资源复用 SQL 数据面板，支持表列表、schema、只读预览和只读 SQL Console，并按 runtime 使用 PostgreSQL 引号规则 |
| feat | cds | Redis 资源数据页接入只读 key browser、TTL、value preview 和 memory usage，后端仅执行 SCAN/TYPE/TTL/MEMORY/GET 等只读命令 |
| feat | cds | MongoDB 资源数据页接入 database/collection/document browser 和 JSON 只读 query console，后端只接受 filter/projection/sort object 不执行任意 JS |
| feat | cds | 资源写操作新增 member/developer/admin 权限门控，生产资源公网访问、备份恢复、连接已有数据库等高风险操作要求 admin 权限 |
| feat | cds | 资源连接页新增外部访问 TTL 与 IP allowlist 表单，备份页新增从备份创建新库和连接已有数据库入口，后端写入分支级 env 并记录任务审计 |
| feat | cds | 资源级备份恢复扩展到 PostgreSQL、MongoDB、Redis，PostgreSQL/MongoDB 支持空库创建、clone-main 和从备份创建分支独立库 |
| feat | cds | 资源设置页新增清空数据、删除分支数据库、执行写 SQL 的危险操作入口，后端强制管理员权限、资源名确认、安全备份和审计日志 |
| fix | cds | MySQL clone-main 复制任务现在检查 mysqldump/mysql 导入退出码，失败时正确落到任务失败状态并记录失败原因 |
| feat | cds | 新增资源权限摘要 API，资源控制台按服务端判定的 member/developer/admin 权限禁用重启、外部访问、备份恢复、凭据、克隆和危险操作按钮 |
| feat | cds | 资源详情指标/日志 tab 接入资源级 metrics/logs API，数据库、缓存等 infra 容器不再显示占位指标和占位日志 |
| feat | cds | 资源公网 TCP 访问接入受管 Docker proxy 与 iptables allowlist，数据库外部连接串使用动态端口并在资源连接页显示网络层执行状态 |
| fix | cds | MongoDB 数据面板支持切换 database 后查询 collection/document，资源连接页新增按权限复制真实可用连接串，避免 Redis 只复制星号密码 |
