# CDS 集群扩容 · 指南

> **类型**：操作指南 (How-to) | **日期**：2026-04-10 | **版本**：v1.0
>
> 本文档教你**怎么用**两条命令把第二台服务器加入 CDS 集群。
> 想了解**为什么这么设计**，请看 `doc/design.cds-cluster-bootstrap.md`。

---

## 0. 你需要先理解三个名词

| 名词 | 大白话解释 |
|---|---|
| **standalone（单机模式）** | 一台机器自己跑 CDS，没和别人组队。这是默认状态 |
| **scheduler（主节点）** | 集群的"老大"，负责分发任务、汇总容量、对外暴露 Dashboard |
| **executor（从节点）** | 集群的"小弟"，听老大派活，跑容器，每 15 秒汇报一次自己的状态 |

**关键事实**：standalone 模式的机器**自动可以变成主节点**——你不用手动选择。当第一台从节点连接过来时，被连接的那台会自动从 standalone 升级成 scheduler，整个过程秒级完成、不重启进程、不影响正在跑的容器。

---

## 1. 适用场景

| 我要做什么 | 用哪个命令 |
|---|---|
| 我有一台 CDS 跑得好好的，但容量不够，想加一台机器 | 在老机器跑 `issue-token`，在新机器跑 `connect` |
| 我想看现在集群里有几台机器、每台多少负载 | 在任意机器跑 `cluster` |
| 某台从节点要做硬件维护、要下线 | 在那台从节点上跑 `disconnect` |
| 我想知道集群总共有多少 CPU 和内存 | 在任意机器跑 `cluster`，或 `curl http://主节点/api/executors/capacity` |

---

## 2. 前置条件检查清单

在开始之前，**逐项确认**：

- [ ] **两台机器都已经装好 CDS**：能跑 `./exec_cds.sh status` 看到 CDS running
- [ ] **两台机器之间网络互通**：在新机器上跑 `curl https://老机器域名/healthz`，期望返回 `{"ok":true,...}`。返回不通就先解决防火墙/DNS，**不要继续往下走**
- [ ] **两台机器的 Docker 都能用**：跑 `docker ps`，没报错
- [ ] **两台机器时间大致同步**：时间差 1 分钟以内（bootstrap token 校验有 60 秒容忍，超过会失败）
- [ ] **你能 SSH 到两台机器**：操作过程需要在两台机器上分别敲命令
- [ ] **老机器上 CDS 已经能正常工作**：能登录 Dashboard、能创建分支预览

> ⚠️ **如果新机器还没装 CDS**：先按 `doc/guide.quickstart.md` 装好，跑通 `./exec_cds.sh init` + `./exec_cds.sh start`，确认本机 standalone 模式工作正常，**再回来做扩容**。

---

## 3. 标准扩容流程（5 分钟搞定）

### 第 1 步：在老机器（要变成主节点的那台）上生成 token

```bash
# 假设你的老机器是 cds.miduo.org
ssh ubuntu@cds.miduo.org
cd /path/to/cds
./exec_cds.sh issue-token
```

**期望看到**：

```
[OK]   已生成 bootstrap token (有效期 15 分钟)

  下一步 — 在要加入集群的新机器上执行:

    ./exec_cds.sh connect https://cds.miduo.org abcdef0123456789...

  Token 过期时间: 2026-04-10T14:25:00Z
  Token 消费后会自动清理并换成永久 token
```

**怎么办**：把上面那条 `./exec_cds.sh connect ...` 完整复制下来，准备粘到新机器上。

> ⚠️ **token 是密码级别的敏感信息**。15 分钟内有效，过期会被服务端拒绝。不要发到公开聊天群、不要写在 wiki 里。复制完一次就用完。

### 第 2 步：在新机器上跑 connect

```bash
ssh ubuntu@new-server.example.com
cd /path/to/cds
# 粘贴第 1 步复制的命令
./exec_cds.sh connect https://cds.miduo.org abcdef0123456789...
```

**期望看到**：

```
[INFO] 验证主节点可达: https://cds.miduo.org/healthz
[OK]   主节点可达
[OK]   已写入 executor 配置 -> /path/to/cds/.cds.env
[INFO] 启动 CDS (executor 模式)...
[OK]   已加入集群: https://cds.miduo.org

  本机已作为 executor 运行，心跳周期 15s
  总容量会自动汇总到主节点的 /api/executors/capacity
  查看集群状态: ./exec_cds.sh cluster
  断开集群:    ./exec_cds.sh disconnect
```

**完事了。** 新机器已经加入集群，老机器的容量自动扩充。

### 第 3 步：验证（推荐但非必须）

在**任意一台**机器上跑：

```bash
./exec_cds.sh cluster
```

**期望看到**：

```
  CDS 集群状态
  ──────────────────
  在线节点:  2
  离线节点:  0
  总分支槽:  14 (已用 3)
  总内存:    16384 MB (已用 4200 MB)
  总 CPU:    8 cores (负载 45%)
  空闲比例:  74%

  节点列表:
    - [embedded] master-cds-a            127.0.0.1        online   branches=2
    - [remote  ] executor-newserver-9901 192.168.1.42     online   branches=1
```

**关键验证点**：
1. `在线节点` 应该是 **2**（一个 embedded master + 一个 remote executor）
2. `总内存` 应该是两台机器内存之和
3. `总 CPU` 应该是两台机器 CPU 核数之和
4. 节点列表里两台都应该 `online`

---

## 4. 撤回操作（disconnect）

某台从节点要下线时：

```bash
ssh ubuntu@new-server.example.com
cd /path/to/cds
./exec_cds.sh disconnect
```

会发生以下事情：

1. 调用主节点 `DELETE /api/executors/{id}` 把自己从注册表移除
2. 把本机 `.cds.env` 改回 `CDS_MODE=standalone`
3. 清掉 `CDS_MASTER_URL` 等集群字段
4. 重启 CDS 进入 standalone 模式

**注意**：本机已经在跑的容器**不会**被自动停掉。如果你想清理它们，单独用 `docker stop` 或 CDS Dashboard 操作。

---

## 5. 排错手册

### 错误 1：`无法连接主节点 https://xxx`

**症状**：connect 第一步就失败。

**原因**：新机器到老机器的网络不通。

**排查步骤**：

```bash
# 1. DNS 是否解析正确
nslookup cds.miduo.org
# 期望看到老机器的 IP

# 2. 能不能 ping 通
ping -c 3 cds.miduo.org

# 3. HTTPS 端口能不能连
curl -v https://cds.miduo.org/healthz
# 期望看到 200 + JSON

# 4. 看老机器的 Nginx 日志
ssh ubuntu@cds.miduo.org "docker logs cds_nginx --tail 50"
```

**常见原因**：
- 防火墙没开 443 端口
- Cloudflare 代理开关导致证书问题
- 域名 DNS 还没生效

### 错误 2：`Bootstrap token expired`

**症状**：connect 时主节点返回 401，日志写"token expired"。

**原因**：从 issue-token 生成到 connect 成功超过了 15 分钟。

**怎么办**：在老机器上**重新生成一个 token**：

```bash
# 老机器
./exec_cds.sh issue-token
# 复制新的 token，到新机器再跑一次 connect
```

### 错误 3：`Invalid bootstrap token`

**症状**：connect 时主节点返回 401，日志写"invalid bootstrap token"。

**原因**：你跑 `issue-token` 之后，又跑了一次 `issue-token`，**第二次生成的 token 覆盖了第一次的**。你手里复制的是第一次的，已经失效。

**怎么办**：在老机器上跑 `issue-token` 拿**最新的** token，再到新机器跑 connect。

### 错误 3.5：`Bootstrap token already consumed or never issued`

**症状**：connect 时主节点返回 401，错误信息明确说"already consumed"。

**原因**：上一次 connect 在主节点端**已经成功消费了 token**，但 HTTP 响应回程时网络断了，从节点没收到永久 token。从节点重试时，主节点的 bootstrap token 已经清掉，就拒绝了。

**怎么办**：

```bash
# 在主节点上重新生成
./exec_cds.sh issue-token

# 拿新 token 到从节点重试
./exec_cds.sh connect https://master <new-token>
```

> 这是已知边界场景，无法在客户端单边重试解决。从节点的 `connect` 错误信息已经会主动提示这种情况，按提示操作即可。

### 错误 4：`./exec_cds.sh cluster` 显示节点 offline

**症状**：从节点已经成功 connect，但几分钟后 `cluster` 命令显示该节点 `offline`。

**原因**：心跳超时（45 秒未上报，3 次心跳）。可能是从节点崩了，或者从节点到主节点的网络断了。

**排查步骤**：

```bash
# 1. 在从节点上看 CDS 是否在跑
ssh ubuntu@new-server
./exec_cds.sh status

# 2. 看从节点日志
./exec_cds.sh logs
# 找 "executor" 关键词，看心跳是不是在发

# 3. 在从节点上手动 ping 主节点
curl -v https://cds.miduo.org/api/executors/capacity
```

**常见原因**：
- 从节点 CDS 进程崩了 → `./exec_cds.sh restart`
- 从节点公网出口断了 → 检查云厂商安全组
- 主节点重启过 → 从节点会自动重连，等 30 秒看看

### 错误 5：connect 成功但 `cluster` 看不到新节点

**症状**：connect 输出 "已加入集群"，但在主节点上跑 `cluster` 只看到 master，没有新节点。

**排查步骤**：

```bash
# 1. 直接 curl 主节点的 capacity 端点
curl http://主节点:9900/api/executors/capacity | python3 -m json.tool

# 2. 在新节点上看日志，确认注册成功
./exec_cds.sh logs | grep "Registered as"
# 期望看到: [executor] Registered as executor-newserver-9901

# 3. 在新节点上看心跳是不是被接受
./exec_cds.sh logs | grep heartbeat
```

**常见原因**：
- 主节点的 `executorToken` 配过但客户端用的是旧 token，401 后被静默丢弃
- 新节点的 `CDS_EXECUTOR_HOST` 环境变量是 127.0.0.1 之类（被探测错了），主节点收到的 host 字段不可用

---

## 6. 高级配置

### 自定义心跳周期

默认 15 秒一次。要调整，编辑 `cds/src/executor/agent.ts:60` 的 `setInterval` 时长，重新编译 + 重启。**不建议小于 5 秒**（容易把网络打满）也不建议大于 60 秒（容量统计延迟过大）。

### 多个从节点同时加入

支持。在主节点上跑一次 `issue-token` 拿到 token 后，**15 分钟内**可以让多台从节点用**同一个** token 加入吗？

**答案：不能。** Bootstrap token 只能消费一次（`alreadyBootstrapped` 标志），第一台 connect 成功后会被服务端清掉。需要每台从节点单独跑一次 `issue-token`。

> 这是有意为之的安全设计。如果你需要批量扩容，写一个脚本循环 issue-token 即可。

### 让主节点也能被派发分支

主节点会以 `role=embedded` 自注册到集群，**容量被计入总和**，但目前 `BranchDispatcher` 不会通过 HTTP 派发任务给主节点（避免循环调用自己）。主节点本机的分支部署仍然走 standalone 路径，由现有代码处理。

### 强制把所有 token 重置

```bash
# 在主节点上
./exec_cds.sh stop
sed -i '/CDS_BOOTSTRAP_TOKEN/d' cds/.cds.env
sed -i '/CDS_EXECUTOR_TOKEN/d' cds/.cds.env
./exec_cds.sh start
# 然后所有 executor 必须重新 connect
```

---

## 7. 安全建议

| 问题 | 建议 |
|---|---|
| 我担心 bootstrap token 在传输过程中被截获 | 走 HTTPS（已强制，明文 `http://` 会被 connect 拒绝）+ 用 SSH 复制 token，不要走 IM/邮件 |
| **bootstrap token 出现在 `ps aux` 里** | 这是已知限制：shell 命令行参数对同机器其他用户可见。如果服务器是多用户共享的，做完 connect 后**立刻**在主节点重新跑 `issue-token`，老 token 会被覆盖失效 |
| 我担心从节点被偷走 | 永久 token 存在 `cds/.cds.env`，权限 600（备份文件 `.cds.env.bak` 也是 600）。定期轮换：在主节点 `issue-token` 后让从节点 `disconnect && connect` |
| 我担心有人扫到 `/api/executors/register` 端点恶意注册 | 默认不暴露这个端点（只有跑 `issue-token` 后 15 分钟内才会接受请求）。可以在 Cloudflare 上加 IP 白名单，只允许你的从节点 IP 访问 `/api/executors/*` |
| 我担心 executor 自报的 id 被恶意构造 | 服务端 regex 校验 `^[a-zA-Z0-9._-]{1,64}$`，控制字符和换行符会被 400 拒绝，避免日志注入 |
| 我担心主节点挂了从节点跑飞 | 从节点心跳失败时**不会**自动停止本机容器，会保留状态等主节点恢复。主节点回来后会从存量心跳中识别这些 executor |
| 我担心 disconnect 失败导致主节点累积僵尸节点 | 主节点会自动回收离线超过 24 小时的远程节点（embedded master 不会被回收）|

---

## 8. 与 Cloudflare DNS 的关系

**好消息**：你不需要改任何 Cloudflare 配置。

| 你的现状 | 加入集群后 |
|---|---|
| `*.miduo.org` 解析到老机器 IP | 不变。所有用户流量仍然先到老机器 |
| 老机器 nginx 反代到 `cds_master:9900` | 不变。新流量从 nginx → CDS scheduler → 智能路由到对应 executor |
| 老机器是 HTTPS 证书的唯一持有者 | 不变。从节点不需要自己的证书，因为不直接对外服务 |

**如果你以后想让从节点直接对外（控制面 + 数据面分离）**，那需要改 Cloudflare：

1. 给每个从节点分配一个独立子域名（如 `exec-a.miduo.org`）
2. 在 Cloudflare 配置 A 记录指向从节点公网 IP
3. 修改 CDS Nginx 模板生成跨节点反代规则

**这超出本文档范围**，是未来工作。当前推荐先跑主代理方案。

---

## 9. 完整示例：从零搭建 2 节点集群

```bash
# ─── 在老机器 cds.miduo.org 上 ───
ssh ubuntu@cds.miduo.org
cd /opt/prd_agent/cds

# 确认现状
./exec_cds.sh status
# 应该看到 CDS running, Nginx running

# 生成 token
./exec_cds.sh issue-token
# 复制输出的 connect 命令

# ─── 切到新机器 new-server.example.com ───
ssh ubuntu@new-server.example.com
cd /opt/prd_agent/cds

# 确保已经 init 过
./exec_cds.sh status
# 如果显示 stopped，先 init:
./exec_cds.sh init

# 粘贴老机器输出的命令
./exec_cds.sh connect https://cds.miduo.org abcdef...

# 等待 "已加入集群" 输出

# ─── 验证 ───
./exec_cds.sh cluster
# 应该看到 2 个在线节点

# ─── 在老机器上也验证一次 ───
ssh ubuntu@cds.miduo.org
cd /opt/prd_agent/cds
./exec_cds.sh cluster
# 也应该看到 2 个在线节点

# 完事
```

---

## 10. 相关文档

- **设计原理**：`doc/design.cds-cluster-bootstrap.md`
- **CDS 整体架构**：`doc/design.cds.md`
- **资源容量与故障隔离**：`doc/design.cds-resilience.md`
- **环境变量配置**：`doc/guide.cds-env.md`
- **从零开始装 CDS**：`doc/guide.quickstart.md`
