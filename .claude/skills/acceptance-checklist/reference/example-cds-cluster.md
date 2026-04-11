# CDS 集群引导功能验收清单（完整示例）

> 这是 `acceptance-checklist` skill 生成的一份**真实示例**，来自 `claude/cds-load-balancing-Vm85Y` 分支的 B→A 双机验收场景。
>
> **使用方式**：照这个结构填你自己的功能。包括顶部元信息、8 个 Phase、失败处置、整体汇总、诊断命令五大块。

---

# CDS 集群 B→A 验收清单

> **验收目标**：验证"一条命令让 B 加入 A"的集群引导功能端到端可用
> **分支**：`claude/cds-load-balancing-Vm85Y`
> **入口**：`./exec_cds.sh issue-token`（A 节点）+ `./exec_cds.sh connect <url> <token>`（B 节点）
> **场景类型**：CLI（纯命令行，无 Web UI）
> **估算总时长**：15-25 分钟（依赖 tsc 编译速度）
> **打勾方式**：每个 checkpoint 有 ☐，跑完一项写 ✅ / ❌ / ⏭ (跳过)
> **【位置】**：两台机器的 shell 终端
> **【路径】**：SSH 到 A 和 B → 分别 cd 到 cds/ → 按 Phase 顺序执行

---

## 🟢 Phase 0：前置检查（在 B 上，2 分钟）

| # | 操作 | 预期 | 状态 |
|---|---|---|---|
| 0.1 | `node -v` | `v20.x` 或更高 | ☐ |
| 0.2 | `docker ps` | 列出容器（至少能跑）| ☐ |
| 0.3 | `which pnpm` | 返回 pnpm 路径（版本 8+）| ☐ |
| 0.4 | `git log --oneline -1` | 是 `cf2f4a2` 或之后 | ☐ |
| 0.5 | `date -u` | 和 A 对比误差 < 60 秒 | ☐ |

**如果 0.X 失败**：
- 0.1 node 版本低 → `nvm install 20` 或升级系统 Node
- 0.4 不对 → `git pull origin claude/cds-load-balancing-Vm85Y`
- 0.5 时间漂移 → `sudo ntpdate pool.ntp.org` 或同步时钟

---

## 🟢 Phase 1：B 本机 standalone 自检（冷启动注入，3 分钟）

> 这一步就是 skill 里说的"冷启动自检"：确认 B 自己能正常跑，再去测集群。

| # | 操作 | 预期 | 状态 |
|---|---|---|---|
| 1.1 | `cd /path/to/cds && ./exec_cds.sh status` | running 或 stopped | ☐ |
| 1.2 | 若 stopped：`./exec_cds.sh start` | `[OK] CDS 启动完成` + Dashboard URL | ☐ |
| 1.3 | `curl -s http://127.0.0.1:9900/healthz \| python3 -m json.tool` | `"ok": true` | ☐ |
| 1.4 | `curl -s http://127.0.0.1:9900/api/executors/capacity \| python3 -m json.tool` | `online: 1`（embedded master 自注册）| ☐ |
| 1.5 | `./exec_cds.sh cluster` | 节点列表有 `[embedded] master-xxx` | ☐ |

**如果 1.X 失败**：
- 1.2 启动失败 → 贴 `./exec_cds.sh logs \| tail -30`
- 1.3 healthz 非 200 → 检查 docker socket 权限
- 1.4 online≠1 → 确认代码包含 `registerEmbeddedMaster` 调用

**验收点 1**：B 在 standalone 模式下就能看到 `role=embedded` 的自己——证明容量汇总从第一天生效。

---

## 🟢 Phase 2：A 上生成 token（2 分钟）

| # | 在 A 上操作 | 预期 | 状态 |
|---|---|---|---|
| 2.1 | `./exec_cds.sh status` | A 的 CDS running | ☐ |
| 2.2 | `./exec_cds.sh cluster` | online=1 | ☐ |
| 2.3 | `git log --oneline -1` | A 也是 `cf2f4a2` 或之后 | ☐ |
| 2.4 | 若 A 未更新：`git pull && ./exec_cds.sh restart` | 重启后 running | ☐ |
| 2.5 | `./exec_cds.sh issue-token` | `[OK] 已生成 bootstrap token (有效期 15 分钟)` | ☐ |
| 2.6 | 复制输出中的 `./exec_cds.sh connect https://... <token>` 那行 | 记到剪贴板 | ☐ |

**如果 2.X 失败**：
- 2.5 报"未安装 openssl" → `apt-get install openssl` 或改用 `/dev/urandom`
- 2.6 没看到提示行 → 检查 A 的代码是否包含新版 `issue_token_cmd`

**验收点 2**：issue-token 不仅生成，还自动给出扩容命令模板。注意 15 分钟有效期倒计时。

---

## 🟢 Phase 3：B 上 connect（3-5 分钟）

| # | 操作 | 预期 | 状态 |
|---|---|---|---|
| 3.1 | 粘贴并执行 Phase 2.6 的命令 | `[INFO] 验证主节点可达` | ☐ |
| 3.2 | 继续 | `[OK] 主节点可达` | ☐ |
| 3.3 | 继续 | `[OK] 已写入 executor 配置` | ☐ |
| 3.4 | 继续 | `[INFO] 启动 CDS (executor 模式)...` | ☐ |
| 3.5 | 继续 | `[INFO] 等待 executor 注册到主节点 (最多 60s)...` | ☐ |
| 3.6 | 等待期间每 5 秒一次进度 | `[INFO]   ...仍在等待 (5/60s)` 递增 | ☐ |
| 3.7 | 最终 | `[OK] 已加入集群: https://...` | ☐ |

**如果 3.X 失败**：
- "拒绝通过明文 HTTP 传输 bootstrap token!" → URL 改成 `https://`
- curl exit 60/51（TLS）→ 在 A 上 `./exec_cds.sh cert` 续签证书
- 超时失败 → `./exec_cds.sh logs | grep -i executor`，贴最后 30 行

**验收点 3**：进度提示（3.6）是本次 fix #4 的核心改进——老版本会沉默 20 秒，新版本每 5 秒反馈。

---

## 🟢 Phase 4：验证集群容量汇总（核心功能）

| # | 在 B 上操作 | 预期 | 状态 |
|---|---|---|---|
| 4.1 | `./exec_cds.sh cluster` | 2 个在线节点 | ☐ |
| 4.2 | 节点列表 | `[embedded] master-<A>` 和 `[remote] executor-<B>-9901` | ☐ |
| 4.3 | "总内存" | A 和 B 内存之和（对比 `free -m`）| ☐ |
| 4.4 | "总 CPU" | A 和 B 的 `nproc` 之和 | ☐ |
| 4.5 | "总分支槽" | `floor((A+B内存)/2048)` | ☐ |
| 4.6 | `curl -s http://A/api/executors/capacity \| python3 -m json.tool` | `online: 2`, `nodes[]` 长度为 2 | ☐ |

**如果 4.X 失败**：
- 只看到一个节点 → 心跳可能没发，等 20 秒再查
- 总内存不对 → 检查 `buildRegistration()` 的 `os.totalmem()` 计算

**验收点 4（核心）**：A 在不重启的情况下自动从 standalone 变成 scheduler，**容量从 1 台变成 2 台之和**。这就是一句 `connect` 命令的价值。

---

## 🟢 Phase 5：心跳健康（1 分钟）

| # | 操作 | 预期 | 状态 |
|---|---|---|---|
| 5.1 | `./exec_cds.sh cluster` 记录 B 的状态 | 当前 online | ☐ |
| 5.2 | 等待 20 秒 | — | ☐ |
| 5.3 | 再次 `cluster` | B 仍 online | ☐ |
| 5.4 | 在 A 上 `./exec_cds.sh logs \| grep -i heartbeat` | 若有输出说明心跳在发 | ☐ |
| 5.5 | 在 A 上 `./exec_cds.sh logs \| grep "Executor.*registered"` | 至少一条注册记录 | ☐ |

---

## 🟢 Phase 6：回归检查（确认 A 原有功能未受影响）

> skill 强制规则：新功能必须验证老路径。

| # | 在 A 上操作 | 预期 | 状态 |
|---|---|---|---|
| 6.1 | 浏览器打开 `https://<A Dashboard 域名>` | 正常登录页 | ☐ |
| 6.2 | 登录 Dashboard | 正常进入分支列表 | ☐ |
| 6.3 | 打开一个原有的分支预览 URL | 正常渲染 | ☐ |
| 6.4 | `cat cds/.cds.env \| grep CDS_MODE` | `CDS_MODE="scheduler"` | ☐ |
| 6.5 | `ls -la cds/.cds.env.bak` | 权限必须是 `-rw-------` (0600) | ☐ |

**验收点 5**：fix #6（`.cds.env.bak` 权限）单元测试测过了 Node 层，这里做**唯一的真机 OS 级校验**。

---

## 🟢 Phase 7：回滚演练（disconnect，2 分钟）

| # | 在 B 上操作 | 预期 | 状态 |
|---|---|---|---|
| 7.1 | `./exec_cds.sh disconnect` | `[OK] 已重置本地配置为 standalone` | ☐ |
| 7.2 | `./exec_cds.sh status` | 重启后 standalone | ☐ |
| 7.3 | `./exec_cds.sh cluster` | 只剩 B 自己的 embedded master | ☐ |
| 7.4 | 在 A 上 `./exec_cds.sh cluster` | B 节点已从列表移除 | ☐ |
| 7.5 | `cat cds/.cds.env \| grep CDS_MODE` | `CDS_MODE="standalone"` | ☐ |

---

## 🔴 Phase 8：负面测试（可选）

| # | 操作 | 预期 | 状态 |
|---|---|---|---|
| 8.1 | `./exec_cds.sh connect http://A fake-token` | 拒绝 + "拒绝通过明文 HTTP 传输" | ☐ |
| 8.2 | `./exec_cds.sh connect https://A wrong-token` | 失败 + 提示 token 错误 | ☐ |
| 8.3 | 等 16 分钟让 token 过期再 connect | 拒绝 + "Bootstrap token expired" | ☐ |

---

## 🧾 整体验收汇总

| 验收点 | Phase | 你的结论（✅/❌/⏭）|
|---|---|---|
| B 单机 standalone 正常 | 1 | |
| A 能生成 token 且提示清晰 | 2 | |
| B connect 成功且有进度反馈 | 3 | |
| **集群总容量 = A + B 之和**（核心）| 4 | |
| 心跳稳定，状态持续 online | 5 | |
| A 原有 Dashboard/预览页不受影响 | 6 | |
| `.cds.env.bak` 权限 = 0600 | 6.5 | |
| disconnect 后两边状态都干净 | 7 | |

**任一 ❌**：按对应 Phase 的"失败处置"排查。还不行就贴日志给开发者。
**全部 ✅**：功能正式验收通过 → 下一步跑 `/handoff` 生成交接文档。

---

## 🆘 万一有问题的快速诊断命令

```bash
# 最近 50 行日志
./exec_cds.sh logs 2>&1 | tail -50

# 进程和端口
ps aux | grep -E "node.*dist/index" | grep -v grep
ss -tlnp 2>/dev/null | grep -E ":(9900|9901|5500)"

# .cds.env 当前状态（脱敏）
cat cds/.cds.env | grep -v TOKEN | grep -v PASSWORD

# master 的 capacity 端点
curl -s http://127.0.0.1:9900/api/executors/capacity | python3 -m json.tool

# 强制清理僵尸进程
./exec_cds.sh stop
lsof -ti :9900 | xargs -r kill -9
```

---

## 💡 这个示例体现的 skill 核心特性

| 特性 | 本文档体现 |
|---|---|
| 顶部元信息（含位置+路径）| `> **【位置】**` + `> **【路径】**` |
| 冷启动注入 | Phase 1 是"B 本机 standalone 自检" |
| 双通道（CLI+Web）| Phase 6 有浏览器步骤，其他全是 CLI |
| 每步 3 要素 | 操作 / 预期 / 状态 三列表 |
| 失败处置 | 每个 Phase 下方的"如果 N.X 失败" |
| 验收点总结 | 每个 Phase 末尾的"验收点 N" |
| 整体汇总 | 末尾的表格打勾 |
| 回归检查 | Phase 6 |
| 回滚演练 | Phase 7 |
| 负面测试 | Phase 8（可选）|
| 诊断命令 | 文末独立小节 |

复用这个结构到你自己的功能，把场景替换掉就行。
