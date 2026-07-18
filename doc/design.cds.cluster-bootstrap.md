# CDS 集群引导协议设计 · 设计

> **版本**：v1.0 | **日期**：2026-07-17 | **状态**：已落地

> 范围：CDS standalone、scheduler 与 executor 的受控组网

## 1. 结论

CDS 集群引导把一台已运行的 standalone 节点和一个或多个 executor 组成调度集群。协议只负责身份交换、节点注册、心跳、容量汇总和角色持久化，不承诺自动完成跨机数据迁移、DNS、存储复制或业务容器搬迁。

Dashboard 和 `exec_cds.sh` 是同一协议的两个入口。连接码是短期敏感凭据，不是长期 executor token。

## 2. 角色

| 角色 | 职责 | 对外能力 |
| --- | --- | --- |
| standalone | 单机运行，也可签发首次连接码 | Dashboard、Worker、Bridge、内置 executor |
| scheduler | 维护 executor registry、选择节点并派发分支 | standalone 能力加集群调度 |
| executor | 注册、心跳、接收部署与回收任务 | 执行面，不提供主 Dashboard |
| hybrid | join 后到重启前的临时状态 | 当前进程保留 Dashboard，同时向主节点心跳 |

主节点自身以 embedded executor 进入 registry，使单机和集群使用同一套容量视图。

## 3. 设计原则

- 引导凭据短期有效，注册成功后换取长期 executor token。
- 非回环地址拒绝明文 HTTP，防止连接码在传输中泄露。
- join 先完成远端注册，再持久化本地 executor 模式，避免失败后把节点锁进不可用状态。
- 注册、心跳和容量是事实；“机器已加入”不等于数据和工作负载已经迁移。
- 热切换必须显式暴露 hybrid 与重启提示，不能伪装成已经完成纯角色切换。

## 4. 引导协议

### 4.1 Dashboard 与 CLI 并行入口

主节点通过 Dashboard 的 `POST /api/cluster/issue-token` 或 CLI 的 `issue-token` 生成连接信息。从节点通过 `POST /api/cluster/join` 或 CLI 的 `connect` 消费同一组 `master URL + token + expiresAt` 事实。

Dashboard 使用 base64 编码 JSON 作为便于复制的 connection code。base64 不是加密，连接码应按密码处理，不得写入文档、日志或工单。

### 4.2 主节点签发连接码

签发流程：

1. 仅 standalone 或 scheduler 可签发，executor 请求返回冲突。
2. 生成随机 bootstrap token，默认有效期 15 分钟。
3. 从显式 master URL、根域名或当前请求地址确定主节点 URL。
4. 将 token 和过期时间写入 `.cds.env`，并同步内存配置。
5. 返回连接码、主节点 URL 和过期时间。

连接码过期后必须重新签发。主节点不应长期保留已消费的 bootstrap token。

### 4.3 从节点加入与注册

join 流程：

1. 解码并校验 `master`、`token` 和 `expiresAt`。
2. 拒绝过期连接码、非回环明文 HTTP 和重复加入。
3. 暂时更新内存中的 master 与 bootstrap 配置，不立即改写 `.cds.env`。
4. 创建 `ExecutorAgent`，向主节点注册并报告节点 ID、地址、容量和能力。
5. 主节点验证 bootstrap token，把节点写入 registry，并签发长期 executor token。
6. 注册成功后，从节点才持久化 `CDS_MODE=executor` 等配置并开始心跳。

`GET /api/executors/capacity` 返回 embedded 与 remote 节点的聚合容量。它是调度输入和运维观测，不是资源可用性的绝对承诺；部署仍需经过实际构建和运行检查。

### 4.4 运行中角色切换

主节点始终挂载 scheduler 路由。首个 remote executor 注册后，回调把 standalone 提升为 scheduler，并持久化相应配置；路由无需重启才可接受后续心跳和调度。

从节点的 Dashboard join 不会在当前 HTTP 请求中杀掉进程。当前进程进入 hybrid：Dashboard 继续可用，ExecutorAgent 已注册并心跳；下一次重启读取 `CDS_MODE=executor` 后才进入纯 executor。API 必须返回 `restartWarning`，UI 必须展示这一边界。

热切换中的持久化或附属刷新失败应记录为显式运维错误，不能撤销一个已经在主 registry 中生效的远端注册。

## 5. 调度与健康

### 5.1 调度策略

当前支持：

| 策略 | 选择依据 |
| --- | --- |
| `least-load` | 内存与 CPU 加权负载 |
| `least-branches` | 当前分支数量 |
| `round-robin` | 节点轮转 |

draining 或离线节点不得接收新部署。节点选择只决定执行位置，不替代构建闸、快照同步和部署验收。

### 5.2 心跳与容量

executor 使用长期 token 定期上报 load 与 branches。主节点更新 `lastHeartbeat`、节点状态和聚合容量。超时节点应从可调度集合中剔除，但保留足够诊断信息供运维确认。

embedded 主节点的负载由 registry 在读取容量和列表时刷新，以避免静态占位数据误导调度。

## 6. 运维边界

### 6.1 离开集群

`POST /api/cluster/leave` 先尽力向主节点 unregister，再停止心跳，清除本地 master、token 和 executor 配置，并把持久化模式恢复为 standalone。接口返回后建议重启，以退出 hybrid 进程状态。

### 6.2 安全

- bootstrap token 只用于首次注册且受过期时间约束；
- executor token 用于心跳、移除和 drain 等长期操作；
- 令牌不得出现在 URL query、普通日志或文档示例中；
- 生产 master 必须使用 HTTPS 或可信内网；
- 节点 ID、地址和能力必须经过服务端校验，不直接信任请求体。

### 6.3 脚本与事实源

CLI 入口以 `cds/exec_cds.sh` 为准，Dashboard API 以 `cds/src/routes/cluster.ts` 和 `cds/src/scheduler/routes.ts` 为准，环境文件更新以 `cds/src/services/env-file.ts` 为准。

本文不复制可执行命令和配置模板，避免与脚本漂移。操作步骤见 `doc/guide.cds.cluster-setup.md`。

## 7. 不在本协议内

- MongoDB、对象存储和本地目录的数据迁移；
- DNS、证书和公网防火墙配置；
- 跨节点共享缓存与会话一致性；
- 自动容量承诺和故障后的业务无损迁移；
- 把一个仍在运行的 standalone 进程瞬间变成纯 executor。

这些能力分别由数据迁移、部署、韧性和运维文档负责。

## 8. 关联文档

- `doc/guide.cds.cluster-setup.md`
- `doc/design.cds.resilience.md`
- `doc/design.cds.data-migration.md`
- `doc/guide.cds.mongo-migration.md`
- `doc/design.cds.md`
