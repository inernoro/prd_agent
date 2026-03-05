# exec_bt.sh 部署架构与冲突分析

> **版本**：v1.2 | **日期**：2026-02-26 | **关联**：design.branch-tester.md, quickstart.md, test.sh

## 1. 系统全景

```
                         ┌──────────────── 公网 ────────────────┐
                         │                                      │
                    :80 (APP)                          :9900 (Dashboard)
                         │                                      │
  ┌──────────────────────┼──────────────────────────────────────┼───────────┐
  │ Host Machine         │                                      │           │
  │                      ▼                                      │           │
  │  ┌──────────────────────────┐                               │           │
  │  │ Host Nginx               │                               │           │
  │  │ prdagent-app.conf        │                               │           │
  │  │ listen :80 → :5500       │                               │           │
  │  └───────────┬──────────────┘                               │           │
  │              │                                              │           │
  │  ┌───────── Docker (prdagent-network) ──────────────────┐   │           │
  │  │           │                                          │   │           │
  │  │           ▼                                          │   │           │
  │  │  ┌────────────────────┐                              │   │           │
  │  │  │ prdagent-gateway   │ ← symlink 切换               │   │           │
  │  │  │ nginx:1.27-alpine  │   default.conf →             │   │           │
  │  │  │ :5500 → :80        │   branches/{id}.conf         │   │           │
  │  │  └────────┬───────────┘                              │   │           │
  │  │           │                                          │   │           │
  │  │     ┌─────┴─────────────────────────────┐            │   │           │
  │  │     │ (根据激活分支路由)                  │            │   │           │
  │  │     ▼                                   ▼            │   │           │
  │  │  ┌─────────────┐  ┌─────────────┐  ┌──────────┐     │   │           │
  │  │  │ run-main    │  │ run-feat-x  │  │ (更多..) │     │   │           │
  │  │  │ API :8080   │  │ API :8080   │  │          │     │   │           │
  │  │  │ host:9001   │  │ host:9002   │  │          │     │   │           │
  │  │  └──────┬──────┘  └──────┬──────┘  └──────────┘     │   │           │
  │  │         │                │                           │   │           │
  │  │  ┌─────────────┐  ┌─────────────┐                   │   │           │
  │  │  │ run-main    │  │ run-feat-x  │                   │   │           │
  │  │  │ -web        │  │ -web        │                   │   │           │
  │  │  │ Vite :8000  │  │ Vite :8000  │                   │   │           │
  │  │  └─────────────┘  └─────────────┘                   │   │           │
  │  │                                                      │   │           │
  │  │  ┌──────────────┐  ┌──────────────┐                 │   │           │
  │  │  │ prdagent-    │  │ prdagent-    │                 │   │           │
  │  │  │ mongodb      │  │ redis        │                 │   │           │
  │  │  │ :27017       │  │ :6379        │                 │   │           │
  │  │  └──────────────┘  └──────────────┘                 │   │           │
  │  └─────────────────────────────────────────────────────┘   │           │
  │                                                             │           │
  │  ┌──────────────────────────────────────────────────────────┤           │
  │  │ Branch-Tester (Node.js 进程, 非 Docker)                  │           │
  │  │ :9900 dashboard (直接监听 0.0.0.0)  ◄────────────────────┘           │
  │  │                                                          │           │
  │  │ 职责:                                                    │           │
  │  │   - 管理 git worktree                                    │           │
  │  │   - docker build / docker run 分支容器                    │           │
  │  │   - 切换 gateway 的 nginx conf (symlink + reload)         │           │
  │  │   - 管理 MongoDB 数据库隔离                               │           │
  │  └──────────────────────────────────────────────────────────┘           │
  └────────────────────────────────────────────────────────────────────────┘
```

## 2. 组件清单

| 组件 | 类型 | 端口 | 谁管理 | 生命周期 |
|------|------|------|--------|----------|
| **Host Nginx** | 宿主机进程 | :80 | exec_bt.sh 安装+配置 | systemd |
| **prdagent-gateway** | Docker 容器 | :5500→:80 | docker-compose.yml | `docker compose up` |
| **prdagent-mongodb** | Docker 容器 | 27017(内部) | docker-compose.yml | `docker compose up` |
| **prdagent-redis** | Docker 容器 | 6379(内部) | docker-compose.yml | `docker compose up` |
| **prdagent-api** | Docker 容器 | (无映射) | docker-compose.yml | **独立部署专用，BT 会停掉** |
| **Branch-Tester** | 宿主机 Node.js | :9900 | exec_bt.sh | PID file |
| **prdagent-run-{id}** | Docker 容器 | :9001+ | Branch-Tester | per-branch |
| **prdagent-run-{id}-web** | Docker 容器 | (内部) | Branch-Tester | per-branch |

## 3. exec_bt.sh 执行流程

```
exec_bt.sh
  │
  ├─ [PRE] Pre-flight 检查（在任何变更之前）
  │   ├─ 1. 检查工具: docker, docker compose, git, node 20+, pnpm
  │   ├─ 2. 检查端口冲突:
  │   │   ├─ :5500 → 被非 prdagent-gateway 占用? FAIL
  │   │   ├─ :9900 → 被非 branch-tester 占用? FAIL
  │   │   └─ :80   → 被非自己的 nginx conf 占用? WARN
  │   └─ 3. 检查 Docker network
  │
  ├─ [1/4] 基础设施
  │   ├─ docker network create (如不存在)
  │   ├─ docker compose up -d mongodb redis gateway
  │   │   └─ ⚠ gateway depends_on api → compose 会尝试拉 api 镜像
  │   │     如果拉取失败, gateway 仍然启动 (soft dependency)
  │   ├─ 等待 2s, 验证三个容器 running
  │   ├─ docker stop prdagent-api (如果在跑 → 独立部署残留)
  │   └─ **NEW** 检查 gateway default.conf 类型
  │       ├─ 如果是普通文件 (独立部署残留) → 备份 → symlink 到 _disconnected.conf
  │       └─ docker exec gateway nginx -s reload
  │
  ├─ [2/4] Branch-Tester 依赖
  │   └─ pnpm install (如 node_modules 不存在或过期)
  │
  ├─ [3/4] Host Nginx (可 SKIP_NGINX=1 跳过)
  │   ├─ 安装 nginx (如未安装)
  │   ├─ 扫描已有配置, 检测 :80 端口冲突
  │   ├─ 写入 prdagent-app.conf (仅此一个文件)
  │   ├─ 如 default 站点冲突 :80 → 备份到 .bak 再禁用
  │   ├─ nginx -t → **失败则自动回滚** (删除 prdagent-app.conf)
  │   └─ **NEW** nginx 未运行 → `start`; 已运行 → `reload`
  │
  ├─ [4/4] 启动 Branch-Tester
  │   ├─ **NEW** is_bt_pid() 验证 PID 归属 (防 PID reuse 误杀)
  │   ├─ kill 旧实例 → wait_port_free(9900, 5s) → 超时 kill -9
  │   ├─ **NEW** 验证 state.json 合法性 → 损坏则备份+重置
  │   └─ pnpm dev (前台) 或 nohup (后台)
  │       └─ Branch-Tester 内部 InfraService 会再次检查基础设施
  │          (幂等, 已经 running 的不会重启)
  │
  └─ [POST] 输出摘要
      ├─ 公网 IP + 端口
      ├─ 登录凭据
      └─ 管理命令
```

## 4. MECE 冲突矩阵

### 4.1 初始状态 × 行为

| # | 初始状态 | exec_bt.sh 行为 | 最终状态 | 风险 |
|---|----------|-----------------|----------|------|
| **独立部署相关** | | | | |
| S1 | `prdagent-api` 正在运行（用户之前跑过 `exec_dep.sh`） | Step 1 停掉 api 容器 | api 停止, gateway 接管由 BT | **用户独立部署丢失**。需明确提示 |
| S2 | gateway 的 `default.conf` 指向 prdagent-api | BT 激活分支时会覆盖 symlink | gateway 改为指向分支容器 | 无冲突，正常流程 |
| S3 | gateway 的 `deploy/web/dist/` 有独立部署的前端文件 | BT 的 run mode 不走 dist，deploy mode 会覆盖 | dist 被替换 | 无冲突，预期行为 |
| S4 | MongoDB 有独立部署的数据 (db: prdagent) | BT main 分支使用同一个 prdagent 库 | 数据共享 | **数据共享**，可能有 schema 差异 |
| **BT 重复启动相关** | | | | |
| S5 | branch-tester 已在运行 (PID file 有效) | Step 4 kill 旧进程再启动 | 新实例替代旧实例 | 旧实例管理的分支容器仍在跑，新实例从 state.json 恢复 |
| S6 | PID file 存在但进程已死 (zombie PID) | Step 4 检测到进程不存在, 跳过 kill | 正常启动 | 无冲突 |
| S7 | state.json 有分支数据, 但容器已被手动删除 | BT 启动后 state 显示分支, 但容器不在 | 状态不一致, dashboard 显示 error | 用户需在 dashboard 重新 run |
| **端口冲突相关** | | | | |
| P1 | :5500 被非 prdagent-gateway 进程占用 | docker compose up gateway 失败 | 基础设施不完整 | **Pre-flight 应检测并 FAIL** |
| P2 | :9900 被其他进程占用 | branch-tester listen 失败 | BT 无法启动 | **Pre-flight 应检测并 FAIL** |
| P3 | :80 被其他 nginx server block 占用 | prdagent-app.conf 与之冲突 | nginx -t 失败或两个 block 都响应 | **Pre-flight 应检测并 WARN** |
| P4 | :80 被非 nginx 进程占用 (如 apache, caddy) | nginx listen :80 失败 | nginx 启动/reload 失败 | **Pre-flight 应检测并 WARN** |
| P5 | :9001 被之前的分支容器占用 | 新 run 分配同端口, docker run 失败 | 分支启动失败 | BT 内部处理, 非 exec_bt.sh 责任 |
| **Host Nginx 相关** | | | | |
| N1 | nginx 未安装 | Step 3 安装 | 全新 nginx | 需要 root 权限, apt 可能失败 |
| N2 | nginx 已安装, 无自定义配置 | 写入 prdagent-app.conf | 干净安装 | 无冲突 |
| N3 | nginx 已安装, default 站点监听 :80 | 备份 default → .bak, 禁用, 写入 prdagent-app.conf | default 被替换 | **如果 default 服务其他站点, 那些站点断了** |
| N4 | nginx 已安装, 有其他站点在 :80 (非 default) | 检测到冲突, 跳过配置, 给出提示 | 用户手动处理 | 无破坏, 但 :80 没配上 |
| N5 | nginx 已安装, 已有 prdagent-app.conf (上次 exec_bt.sh 留的) | 覆盖写入新内容 | 配置更新 | 无冲突, 幂等 |
| N6 | nginx 正在运行, reload 失败 | 回滚 — nginx -t 先检查 | 保持原有配置 | 无破坏 |
| **Docker Network 相关** | | | | |
| D1 | prdagent-network 不存在 | docker network create | 网络创建 | 无冲突 |
| D2 | prdagent-network 存在但为 bridge 类型 (非 external) | compose 期望 external: true, 可能冲突 | compose 可能报错 | 删除重建或修改 compose |
| D3 | 容器在不同网络上 | gateway 无法 proxy_pass 到分支容器 | 502 错误 | BT 内部 ContainerService 统一使用同网络 |
| **Docker Compose 相关** | | | | |
| C1 | `docker compose up -d gateway` 触发 api depends_on | compose 尝试拉 api 镜像 | api 镜像拉取可能失败 | **gateway 仍会启动** (soft dep), 但有 warning |
| C2 | api 镜像已存在 (之前拉过) | compose 启动 api 容器 | api 容器启动后被 InfraService 停掉 | 浪费几秒, 功能正确 |
| C3 | docker-compose.yml 被修改 (用户自定义端口) | compose 使用修改后的配置 | 端口可能变化 | 脚本应从 compose 配置读端口, 或用常量 |
| **PID/进程安全相关** | | | | |
| R1 | PID file 中的 PID 被 OS 复用给其他进程 | `is_bt_pid()` 检测 cmdline 不匹配 → 跳过 kill | 不误杀, 新实例正常启动 | ~~CRITICAL~~ **已修复** |
| R2 | kill 旧 BT 后端口 9900 仍被占用 (TIME_WAIT) | `wait_port_free(9900, 5s)` 等待 → 超时 kill -9 | 端口释放, 新实例绑定成功 | ~~HIGH~~ **已修复** |
| R3 | state.json 被截断或损坏 | 启动前 `JSON.parse` 校验 → 失败则备份+重置 | BT 正常启动 (空状态) | ~~HIGH~~ **已修复** |
| **Gateway 残留相关** | | | | |
| G1 | gateway default.conf 是静态文件 (独立部署残留) + api 被停 | 检测非 symlink → 备份 → 替换为 _disconnected symlink + reload | gateway 返回友好 502 而非挂死 | ~~HIGH~~ **已修复** |
| G2 | gateway 的 default.conf symlink 指向不存在的文件 | BT SwitcherService 内部处理 (写新 conf 再 link) | gateway reload 前验证 target | BT 内部责任 |
| **Host Nginx 启动相关** | | | | |
| N7 | nginx 已安装但未运行, reload 无效 | 检测 `systemctl is-active` → 不活跃则 `start` | nginx 正确启动 | ~~HIGH~~ **已修复** |
| N8 | nginx -t 失败 | 自动回滚: 删除 prdagent-app.conf | 恢复原有配置 | **已修复** (之前只 warn 不回滚) |

### 4.2 组合场景（最常见路径）

| 场景 | 描述 | 结果 |
|------|------|------|
| **全新机器** | 啥都没有 | 安装 node+pnpm+nginx → 创建网络 → 启动基础设施 → 配置 nginx → 启动 BT |
| **已有独立部署** | 之前跑过 `exec_dep.sh` | 基础设施已在 → 停掉 prdagent-api → 配 nginx → 启动 BT → 用户在 dashboard 激活分支 |
| **BT 已在运行** | 再次执行 exec_bt.sh | 基础设施跳过 → nginx 幂等覆盖 → kill 旧 BT → 启动新 BT → state.json 恢复 |
| **BT 异常退出后** | 进程死了但容器还在 | PID file 清理 → 基础设施检查正常 → 启动新 BT → 恢复管理 |
| **端口 80 被占** | 其他服务在 :80 | 检测冲突 → 跳过 nginx → 用户手动 or `NGINX_APP_PORT=8080` |

## 5. 安全设计

### 5.1 写操作清单

exec_bt.sh 对宿主机的**全部写操作**：

| 写操作 | 文件/目标 | 可回滚? | 保护措施 |
|--------|-----------|---------|----------|
| 写 nginx conf | `/etc/nginx/{sites-available,conf.d}/prdagent-app.conf` | 是(删除即可) | 只写这一个文件; nginx -t 失败自动删除 |
| 禁用 default | `/etc/nginx/sites-enabled/default` | 是(有 .bak) | 先备份, 只在端口冲突时才禁用 |
| symlink | `/etc/nginx/sites-enabled/prdagent-app.conf` | 是(删除即可) | — |
| 写 PID file | `branch-tester/.bt/bt.pid` | 自动(进程退出后) | is_bt_pid() 验证所有权 |
| pnpm install | `branch-tester/node_modules/` | 是(删除即可) | — |
| gateway default.conf → symlink | `deploy/nginx/conf.d/default.conf` | 是(有 .standalone-bak) | 仅在 api 停止且 default.conf 为静态文件时 |
| 备份 state.json | `.bt/state.json.bak.{ts}` | — | 仅在 JSON 损坏时自动备份 |

### 5.2 PID 安全

**问题**：Linux 会复用 PID。如果 BT 进程退出，OS 可能将相同 PID 分配给无关进程。盲目 `kill` 会误杀。

**解决**：`is_bt_pid()` 函数双重验证：
1. `/proc/{pid}/cmdline` 包含 `branch-tester` / `pnpm` 关键词
2. 回退到 `ps -p {pid} -o args=` 检查

```
kill 前:
  PID 存在?  ── No  → 跳过 (stale)
      │
     Yes
      │
  is_bt_pid?  ── No  → WARN "PID reuse, skip kill"
      │
     Yes
      │
  kill + wait_port_free(9900, 5s) → 超时则 kill -9
```

### 5.3 端口释放等待

**问题**：kill 旧进程后，端口不会立刻释放（TCP TIME_WAIT）。新 BT 立即启动会 EADDRINUSE。

**解决**：`wait_port_free()` 最多等待 5 秒确认端口空闲，超时则 `kill -9` 强杀后再等。

### 5.4 Gateway default.conf 保护

**问题**：独立部署模式下 `default.conf` 是普通文件（指向 prdagent-api:8080）。
停掉 prdagent-api 后，gateway 会 502（upstream 不存在）。

**解决**：exec_bt.sh 检测到 `default.conf` 是普通文件时：
1. 备份为 `.standalone-bak.{timestamp}`
2. 替换为 symlink → `_disconnected.conf`（返回友好 502 JSON）
3. `nginx -s reload` 让 gateway 立即生效

### 5.5 state.json 容错

**问题**：如果 BT 在写 state.json 时崩溃，文件可能被截断（空文件或不完整 JSON）。
Node.js `JSON.parse` 会抛异常导致启动失败。

**解决**：启动前验证 JSON 合法性，损坏时备份并重置。

### 5.6 不触碰原则

- **永远不删除** 非 `prdagent-*` 命名的 nginx 配置
- **永远不修改** docker-compose.yml
- **永远不操作** 非 prdagent-network 的 Docker 网络
- **永远不 drop** MongoDB 数据库 (BT 内部有安全检查, exec_bt.sh 不碰 DB)
- **永远不盲杀** PID — 必须通过 `is_bt_pid()` 验证所有权

## 6. 测试体系

### 6.0 全量验收测试: `test.sh`

> **一个脚本, 一条命令, 覆盖全部意外场景。**

```bash
./test.sh                  # 运行全部 (≈70 项)
./test.sh --phase 4        # 只跑分支生命周期
./test.sh --from 7         # 从混沌测试开始
./test.sh --list           # 列出所有测试项 (不执行)
./test.sh --dry            # 干跑 (打印不执行)
```

| Phase | 名称 | 测试数 | 覆盖意外场景 |
|-------|------|--------|-------------|
| 0 | 环境前置检查 | 13 | docker/node/pnpm 缺失, 仓库结构不完整 |
| 1 | exec_bt.sh 首次启动 | 7 | 首次部署失败, BT 无法绑定端口 |
| 2 | 基础设施验证 | 12 | 容器未启动, 网络不通, MongoDB/Redis 连不上 |
| 3 | Dashboard & API | 10 | API 不可达, 返回格式错误, 404 处理 |
| 4 | 分支生命周期 | 18 | 添加/部署/激活/断开/拉取/停止/删除 全链路 |
| 5 | Nginx 网关 | 10 | symlink 断裂, _disconnected 缺失, Host nginx 配置 |
| 6 | 幂等性 | 7 | 重复启动覆盖旧实例, 基础设施不被重建 |
| 7 | 混沌测试 | 16 | **PID reuse, state.json 损坏, 端口抢占, 静态 default.conf** |
| 8 | 端到端 | 4 | 公网不可达, 本地端口链路断裂 |
| 9 | 清理 | 2 | 测试后系统仍正常 |

### 6.0.1 混沌测试覆盖矩阵 (Phase 7 × MECE 场景)

| test.sh 测试 | MECE 场景 | 注入方式 | 验证点 |
|-------------|-----------|---------|--------|
| C01-C03 | S5, S6 | `kill -9` BT 进程 | 重启恢复, API 可用 |
| C04-C05 | R3 | 写入截断 JSON 到 state.json | 自动备份+重置, BT 启动 |
| C06-C08 | R1 | PID file 写入 PID 1 | is_bt_pid() 跳过 kill, PID 1 存活 |
| C09-C11 | G1 | 替换 symlink 为静态 nginx conf | 检测→备份→symlink→reload |
| C12-C13 | P2 | python 占用 :9900 | 冲突警告, 释放后恢复 |
| C14 | — | `--test` 自检 | 全部 PASS |
| C15-C16 | — | `--status` 状态 | 显示 running + ports |

### 6.1 `exec_bt.sh --test` 自检项 (轻量级)

```bash
# Pre-flight
TEST-01  docker daemon 可达                    docker info
TEST-02  docker compose 可用                   docker compose version
TEST-03  node >= 20                            node -v
TEST-04  pnpm 可用                             pnpm -v
TEST-05  git 可用                              git --version

# Infrastructure
TEST-10  prdagent-network 存在                 docker network inspect
TEST-11  prdagent-mongodb running              docker inspect
TEST-12  prdagent-redis running                docker inspect
TEST-13  prdagent-gateway running              docker inspect
TEST-14  gateway :5500 响应                    curl -sf http://localhost:5500
TEST-15  prdagent-api 未运行                   docker inspect (should not be running)

# Branch-Tester
TEST-20  BT 进程存活 + PID 归属验证             is_bt_pid($(cat .bt/bt.pid))
TEST-21  BT dashboard :9900 响应               curl -sf http://localhost:9900
TEST-22  BT state.json 可读                    cat .bt/state.json

# Host Nginx
TEST-30  nginx 进程运行                        systemctl is-active nginx
TEST-31  prdagent-app.conf 存在                ls /etc/nginx/*/prdagent-app.conf
TEST-32  nginx -t 通过                         nginx -t
TEST-33  :80 响应且转发到 :5500                curl -sf http://localhost:80

# End-to-End
TEST-40  公网 IP :80 可达                      curl -sf http://{PUBLIC_IP}
TEST-41  公网 IP :9900 可达                    curl -sf http://{PUBLIC_IP}:9900
```

### 6.2 手动验收场景

| # | 场景 | 步骤 | 预期结果 |
|---|------|------|----------|
| M1 | 全新机器首次部署 | `./exec_bt.sh --background` | 全部安装+启动, :80 和 :9900 可访问 |
| M2 | 从独立部署迁移 | 之前跑过 `exec_dep.sh`, 然后 `./exec_bt.sh -d` | prdagent-api 被停, BT 接管, 数据保留 |
| M3 | 重复执行 | 连续跑两次 `./exec_bt.sh -d` | 第二次幂等, 无报错, 旧 BT 被替换 |
| M4 | 端口 80 冲突 | 其他进程占 80, `./exec_bt.sh -d` | 跳过 nginx 配置, 提示用户, BT 仍启动 |
| M5 | 停止+重启 | `./exec_bt.sh --stop` 然后 `./exec_bt.sh -d` | 干净停止, 干净重启, 状态恢复 |
| M6 | 进程异常退出 | kill -9 BT 进程, 然后 `./exec_bt.sh -d` | 清理 PID, 正常重启 |
| M7 | 跳过 nginx | `SKIP_NGINX=1 ./exec_bt.sh -d` | BT 启动, 无 nginx 变更, :5500 和 :9900 直连 |
| M8 | 自定义端口 | `NGINX_APP_PORT=8080 ./exec_bt.sh -d` | nginx listen :8080 → :5500 |
| M9 | --test 验证 | `./exec_bt.sh --test` | 逐项检查, 输出 PASS/FAIL 表格 |

## 7. 入口简化

```bash
# === 最简用法 ===

./exec_bt.sh                  # 前台 (开发调试)
./exec_bt.sh -d               # 后台 (部署上线)
./exec_bt.sh --test           # 自检
./exec_bt.sh --status         # 状态
./exec_bt.sh --stop           # 停止

# === 自定义 ===

ROOT_ACCESS_PASSWORD="xxx" ./exec_bt.sh -d     # 改密码
NGINX_APP_PORT=8080 ./exec_bt.sh -d            # 改端口
SKIP_NGINX=1 ./exec_bt.sh -d                   # 不碰 nginx
```

不需要记任何子命令、配置文件、目录路径。一个脚本，一个入口。
