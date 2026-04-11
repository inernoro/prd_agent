| feat | cds | 新增 `./exec_cds.sh connect/disconnect/issue-token/cluster` 子命令，一条命令加入 CDS 集群 |
| feat | cds | 主节点 standalone → scheduler 自动热升级，首个 executor 注册时触发，无需重启 |
| feat | cds | 新增 `GET /api/executors/capacity` 端点，总容量（分支槽/内存/CPU）随执行器加入自动扩充 |
| feat | cds | 主节点作为 `role=embedded` 执行器自注册，容量汇总包含主机自身资源 |
| feat | cds | Bootstrap 两段式 token 机制：一次性 token（15 分钟过期）换永久 executor token |
| feat | cds | 新增 `cds/src/services/env-file.ts` 原子读写 `.cds.env` 工具模块 |
| docs | cds | 新增 `doc/guide.cds-cluster-setup.md` 集群扩容运维手册（含前置检查、5 种排错、安全建议） |
| docs | cds | `./exec_cds.sh help` 大改造：分区呈现、表情符号导航、新手 FAQ、命令解释假设零基础用户 |
| fix | cds | `./exec_cds.sh connect` 拒绝明文 HTTP URL（loopback 例外），防止 bootstrap token 被中间人截获 |
| fix | cds | `./exec_cds.sh connect` 网络探测按 curl exit code 分类（DNS/连接/超时/TLS/HTTP），给针对性修复建议 |
| fix | cds | `./exec_cds.sh connect` 注册超时从 20 秒延长到 60 秒，每 5 秒打印进度避免冷启动机器误报 |
| fix | cds | `./exec_cds.sh connect` 失败时区分 "Token 拼写/过期/已被消费" 三种场景，给具体修复步骤 |
| fix | cds | scheduler/routes 拒绝包含控制字符或长度 > 64 的 executor id，防止日志注入 |
| fix | cds | scheduler/routes 在 bootstrap token 已被消费时返回特定错误信息，引导用户重新 issue-token |
| fix | cds | scheduler/routes 把 "首个 executor" 判定从闭包标志改为基于 registry 状态，避免主进程重启后冗余触发 |
| fix | cds | executor-registry 拒绝把 embedded 节点降级为 remote（防恶意远程节点冒充主节点 id 静默禁用 embedded 部署路径）|
| fix | cds | executor-registry 自动回收离线超过 24 小时的远程节点（embedded 永远保留）|
| fix | cds | env-file 备份文件 `.cds.env.bak` 显式 chmod 0600，避免 copyFileSync 沿用 umask 默认权限暴露 token |
| fix | cds | env-file 持久化失败时打印 LOUD 警告框 + 广播到 dashboard activity stream |
| feat | cds | Dashboard 新增"集群设置"面板（设置菜单 → 集群），支持一键生成连接码、粘贴加入、热切换进入 hybrid 模式、UI 退出集群 |
| feat | cds | 新增 `/api/cluster/issue-token` + `/api/cluster/join` + `/api/cluster/leave` + `/api/cluster/status` 四个端点，作为 CLI 的补充 UI 入口 |
| feat | cds | 集群连接码格式：`base64(JSON{master,token,expiresAt})`，一个字符串自包含所有字段，便于复制粘贴 |
| feat | cds | 加入集群为进程内热切换（不重启），Dashboard 继续可用；UI 显式警告下次重启会进入纯 executor 模式 |
