# CDS 集群引导协议（Connect / Disconnect / Capacity Auto-Expand） · 设计

> **版本**：v1.0 | **日期**：2026-04-10 | **状态**：设计已确认，代码已落地
>
> 本文档回答一个问题：**怎样让用户在第二台机器上执行一条命令，就能把这台机器加入现有 CDS 集群，同时让总容量（分支数 / 内存 / CPU）自动扩充？**
>
> 关联文档：`doc/design.cds-resilience.md`（Phase 3 分布式集群设计的基础）、`doc/design.cds.md`（CDS 整体架构）

---

## 一、管理摘要

- **解决什么问题**：CDS Phase 3 的 `scheduler` / `executor` 架构已经落地，但缺一条"最后一公里"——用户必须手动改两台机器的 `.cds.env`、重启服务、生成 nginx 配置，才能把第二台机器加入集群。这个门槛把"多机集群"挡在了实验室之外
- **方案概述**：一条 `./exec_cds.sh connect <master-url> <token>` 命令完成所有握手动作。被连接方自动从 standalone 升级为 scheduler，连接方自动从 standalone 降级为 executor，中间的 token 交换、`.cds.env` 改写、进程重启、容量汇总全部自动完成
- **业务价值**：从"需要专门运维人员部署集群"降到"任意两台能互通的 Linux 机器，5 秒内组成集群"
- **影响范围**：`cds/exec_cds.sh`（新增 4 个子命令）、`cds/src/scheduler/routes.ts`（增强注册接口）、`cds/src/executor/agent.ts`（处理 bootstrap 响应）、`cds/src/index.ts`（总是挂载 scheduler 路由 + mode 热切换）、`cds/src/services/env-file.ts`（新建，用于原子改写 `.cds.env`）
- **预计风险**：中 — 涉及进程重启和 mode 切换，需保证幂等性与回滚路径。通过 bootstrap token 15 分钟过期、状态机显式化、热切换失败时保留旧 `.cds.env` 备份来降低

---

## 二、产品定位

### 一句话定义

> **"一条命令加入集群"。用户执行 `./exec_cds.sh connect <master> <token>` 就完成了两台机器之间的主从握手、身份切换、容量汇总、nginx 重载，无需手动编辑任何配置文件。**

### 设计取舍

| 维度 | 取舍 |
|---|---|
| **网络假设** | 假设主从之间能直接 HTTP 互通（公网 / VPN / 内网都行），不强制要求特定拓扑 |
| **数据路径** | 数据面 + 控制面都走主节点代理，Cloudflare DNS 配置零改动 |
| **安全模型** | 两段式 token：一次性 bootstrap token（15 分钟过期）换永久 executor token |
| **幂等性** | connect 可重复执行，disconnect 可以安全中断后重试 |
| **降级路径** | 断网时 executor 保留本地状态继续服务；主返回在线后自动重连 |

---

## 三、用户场景

### 场景 A：首次扩容

```
A机器（已跑 CDS standalone，域名 cds.miduo.org）
B机器（刚装完 CDS，还没启动）
```

操作序列：

1. A 机器执行：`./exec_cds.sh issue-token` → 输出 `TOKEN=abc123...`（15 分钟后自动过期）
2. B 机器执行：`./exec_cds.sh connect https://cds.miduo.org abc123`
3. B 机器内部发生：
   - 自动安装依赖 + 编译 TS
   - 写入 `.cds.env`：`CDS_MODE=executor` / `CDS_MASTER_URL=https://cds.miduo.org` / `CDS_EXECUTOR_TOKEN=<永久 token>`
   - 启动 CDS，以 executor 模式运行
   - 注册到 A，返回 `executorId=executor-B-9901`
4. A 机器内部发生：
   - 检测到首个 executor 注册，**热升级**：`CDS_MODE: standalone → scheduler`
   - 重写自己的 `.cds.env`
   - 调用 `nginx-template.ts` 重新生成 nginx 配置
   - `nginx -s reload`
   - 自己也作为一个 `role=embedded` 的 executor 自注册到 registry
5. 最终状态：`/api/executors/capacity` 返回 A+B 的容量之和

用户总共只执行了两条命令。

### 场景 B：日常监控

任意时刻在任意机器上：`./exec_cds.sh cluster` → 显示集群拓扑、每台执行器的负载、总容量。

### 场景 C：优雅下线

B 机器要做硬件维护：`./exec_cds.sh disconnect` → 主动 drain + 解注册 + 回退到 standalone。

---

## 四、核心能力

### 4.1 `exec_cds.sh` 新子命令

| 子命令 | 适用角色 | 作用 |
|---|---|---|
| `issue-token` | 主（或将成为主的机器） | 生成 15 分钟过期的 bootstrap token，写入 `.cds.env` |
| `connect <master-url> <token>` | 将成为从的机器 | 完整握手流程：写 env → 启动 → 注册 → 心跳 |
| `disconnect` | 当前是 executor 的机器 | 从主解注册，回退到 standalone |
| `cluster` | 任意 | 显示集群拓扑和总容量 |

### 4.2 Bootstrap 两段式 Token

**为什么不直接用永久 token？** 首次 connect 时从节点还不知道任何东西，必须有一个短命的"凭证"能让它把自己的机器信息告诉主。这个凭证暴露风险要小——15 分钟后自动失效。

| Token 类型 | 生命周期 | 作用 | 存储位置 |
|---|---|---|---|
| `CDS_BOOTSTRAP_TOKEN` | 15 分钟 | 允许调用一次 `/api/executors/register` | 主：`.cds.env`（过期后清除） |
| `CDS_EXECUTOR_TOKEN` | 永久（可手动轮换） | 所有后续 heartbeat / control-plane 调用 | 主和从：`.cds.env` |

注册流程：
```
从 → POST /api/executors/register { bootstrapToken: "abc123", hostInfo: {...} }
主 验证 bootstrapToken 有效且未过期
主 生成永久 token，写入自己的 state 和 .cds.env
主 → 响应 { executorId, permanentToken, masterInfo }
从 接收 permanentToken，写入自己的 .cds.env
从 启动 15 秒心跳循环
```

### 4.3 容量自动扩充

**核心 API**：`GET /api/executors/capacity` 返回：

```json
{
  "online": 2,
  "offline": 0,
  "total": {
    "maxBranches": 20,
    "memoryMB": 16384,
    "cpuCores": 8
  },
  "used": {
    "branches": 3,
    "memoryMB": 4200,
    "cpuPercent": 45
  },
  "freePercent": 74,
  "nodes": [
    { "id": "master-embedded", "role": "embedded", "host": "127.0.0.1", ... },
    { "id": "executor-B-9901", "role": "remote", "host": "192.168.1.42", ... }
  ]
}
```

**关键设计**：主节点自身也作为一个 `role=embedded` 的 ExecutorNode 注册到 registry，这样容量汇总天然包含主自己的机器资源。Dispatcher 在派发时检查 `role` 字段——embedded 的执行器走本地 standalone 路径（不经 HTTP），remote 的走 `/exec/deploy`。

### 4.4 Mode 热切换

standalone → scheduler 的升级**不需要重启进程**：

1. 内存中 `config.mode = 'scheduler'`
2. 原子重写 `.cds.env` 中 `CDS_MODE=scheduler`（先写临时文件再 `rename`，保证原子性）
3. 创建 `BranchDispatcher` 实例并挂载（已经总是挂载了 `/api/executors`，所以路由不用变）
4. 创建 master 自己的 embedded executor 条目
5. 调用 `nginx-template.ts` 重新生成并 `docker exec nginx -s reload`
6. 广播 state 变更到 Dashboard SSE

**关键守护措施**：升级失败（如 nginx 配置无效）时必须能回滚。实现方式：
- `.cds.env` 写入前先备份到 `.cds.env.bak`
- nginx reload 失败时保留旧配置文件
- 失败后 `config.mode` 回退到 standalone，记录错误到 activity stream

---

## 五、架构

### 5.1 状态机

```
             ┌──────────────┐
             │  standalone  │  ← 默认状态，单机可用
             └──┬────────┬──┘
      connect   │        │  首个 executor 注册
      (作为从)   │        │  (作为主)
                ▼        ▼
         ┌──────────┐  ┌──────────┐
         │ executor │  │scheduler │
         └──────────┘  └──────────┘
              │              │
         disconnect      (无执行器时降级，可选)
              │              │
              ▼              ▼
         ┌──────────────┐
         │  standalone  │
         └──────────────┘
```

### 5.2 握手时序图

```
                  从(B)                       主(A)
                   │                           │
  1. connect <A> <token>                       │
                   │                           │
  2. 写 .cds.env                               │
     CDS_MODE=executor                         │
     CDS_MASTER_URL=<A>                        │
                   │                           │
  3. 启动 CDS                                  │
                   │                           │
  4. POST /api/executors/register ────────────▶│
     Header: X-Bootstrap-Token: <token>        │
     Body:   { id, host, port, capacity }      │
                   │                           │
                   │       5. 验证 token
                   │       6. 热升级到 scheduler
                   │          - 写 .cds.env
                   │          - mount dispatcher
                   │          - self-register master
                   │          - regenerate nginx
                   │          - reload nginx
                   │       7. 签发永久 token
                   │                           │
                   │◀──── { executorId, permanentToken, masterInfo }
                   │                           │
  8. 写入 .cds.env                             │
     CDS_EXECUTOR_TOKEN=<permanentToken>       │
                   │                           │
  9. 启动心跳 (每 15s)                         │
                   │                           │
 10. POST /api/executors/:id/heartbeat ───────▶│
     Header: X-Executor-Token: <permanent>     │
                   │                           │
                   │       11. 更新 lastHeartbeat
                   │           更新总容量
                   │           广播到 Dashboard
                   │                           │
```

### 5.3 文件改动清单

| 文件 | 类型 | 改动内容 |
|---|---|---|
| `cds/src/types.ts` | 修改 | 新增 `bootstrapToken`、`masterUrl`、`ExecutorNode.role` 字段 |
| `cds/src/config.ts` | 修改 | 读取 `CDS_MASTER_URL` / `CDS_BOOTSTRAP_TOKEN*` / `CDS_EXECUTOR_TOKEN` |
| `cds/src/services/env-file.ts` | **新建** | 原子读写 `.cds.env` 的工具模块 |
| `cds/src/scheduler/routes.ts` | 修改 | bootstrap token 验证 + auto-upgrade 回调 + `/capacity` 端点 |
| `cds/src/scheduler/executor-registry.ts` | 修改 | 新增 `getTotalCapacity()` + self-register master helper |
| `cds/src/executor/agent.ts` | 修改 | 处理 bootstrap 响应，持久化永久 token |
| `cds/src/index.ts` | 修改 | 总是挂载 scheduler 路由 + 实现 mode 热切换 |
| `cds/exec_cds.sh` | 修改 | 新增 `connect` / `disconnect` / `issue-token` / `cluster` 子命令 |
| `cds/tests/scheduler/bootstrap.test.ts` | **新建** | bootstrap token 验证 + 注册流程的单元测试 |
| `cds/tests/services/env-file.test.ts` | **新建** | `.cds.env` 原子读写的单元测试 |

---

## 六、关联决策

### 6.1 为什么不用全局 etcd / Consul

单机内 `.cds.env` + JSON state 已经够用，引入外部 KV 会违背"CDS 是轻量单机工具"的定位。代价：集群规模上限 ~10 台机器，超出后需要迁移到 K8s。

### 6.2 为什么不直接让从暴露公网 IP（方案 B）

详见顶层探索结论：主代理方案 Cloudflare 零改动、证书集中管理、与现有 `nginx-template.ts` 100% 兼容。从直连方案作为未来优化（控制面走主、数据面直连从），**本期不做**。

### 6.3 为什么是 15 分钟 token 过期

- 太长：泄露风险
- 太短：跨时区、跨同事协作时来不及
- 15 分钟是"一次正常的扩容操作"的时间预算上限

### 6.4 主的 embedded executor 条目怎么处理 deploy？

新增字段 `ExecutorNode.role: 'embedded' | 'remote'`。Dispatcher 选择执行器后：

- `role === 'embedded'`：走现有 standalone deploy 路径（`containerService.runService()`），不发 HTTP
- `role === 'remote'`：POST `/exec/deploy` 到 `host:port`

本次代码实现 role 字段和 capacity 汇总；dispatcher 的分发逻辑保持现状（未来工作）。

---

## 七、风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 热切换时 nginx reload 失败 | 低 | 主访问中断 | 保留旧配置备份，失败时回滚 mode |
| bootstrap token 泄露 | 低 | 恶意注册 | 15 分钟过期 + 只允许注册一次 + 源 IP 记录 |
| 从节点时钟漂移导致 token 过期判断错误 | 低 | 握手失败 | token 存绝对时间戳 ISO 字符串，比较时容忍 ±60 秒 |
| 进程重启时并发 `.cds.env` 写入冲突 | 低 | 配置损坏 | 原子写：tempfile + rename |
| executor 心跳超时被误判离线 | 中 | 容量统计错误 | 复用已有 `HEARTBEAT_TIMEOUT_MS=45s` 阈值，减震 |
| mode 切换时已有 in-flight 请求 | 中 | 请求失败 | nginx reload 是原子操作，对 in-flight 透明 |
| disconnect 时本机仍有运行中的容器 | 高 | 容器成为孤儿 | disconnect 前强制 drain，drain 超时则警告用户 |

---

## 八、未来工作

- **数据面直连优化**：当带宽成瓶颈时，数据流量直连 executor，控制面仍走主（对应顶层探索的方案 C）
- **自动故障转移**：executor 挂掉时自动在其他 executor 上重建该分支
- **跨机房调度**：带 `labels: ['region:us-west']` 的标签调度
- **Web Dashboard 集群视图**：Dashboard 新增"集群"面板，显示拓扑图和总容量
- **Cloudflare Tunnel 集成**：可选的无公网 IP 部署方式
