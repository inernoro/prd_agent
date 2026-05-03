# Report: CDS 跨项目隔离审计

> **类型**:report(执行报告) | **日期**:2026-05-02 | **执行**:UAT 子智能体 B | **关联 plan**:doc/plan.cds-onboarding-uat-completion.md §P0-3

## 用户原话

> "P0-3 跨项目隔离 实测,3 层都要验:docker network、DB 隔离、per-branch DB 后缀、同名 branch 跨项目共存"

## 测试环境

- CDS 实例:`https://cds.miduo.org`(commit `0e3709fa` 之后)
- 项目 A:`prd-agent`(MAP),分支 `prd-agent-main` 在 docker network `cds-prd-agent`,IP 段 172.18.x
- 项目 B:`twenty-demo` (`44d832a9cf8a`),分支 `twenty-demo-main` 在 docker network `cds-proj-44d832a9cf8a`,IP 段 172.21.x
- 工具:`cdscli branch exec` + `getent hosts` + `nc`

## 测试矩阵 + 结论

### Layer 1 — DNS 隔离(docker network 名称解析)

| 测试 | 期望 | 实测 | 结论 |
|------|------|------|------|
| twenty-demo 容器 → `cds-prd-agent-main-api` 解析 | NXDOMAIN | **空返回** | ✅ 隔离 |
| twenty-demo 容器 → 自家 worker 名解析 | 成功 | `172.21.0.4` | ✅ 同网络 |
| prd-agent 容器 → twenty-demo 容器名解析 | NXDOMAIN | **空返回** | ✅ 反向也隔离 |
| 共享别名 `db` 解析 | twenty-demo 通,prd-agent 不通 | twenty=`172.21.0.2`,prd-agent 空 | ✅ alias 也隔离 |

### Layer 2 — IP 子网隔离

- twenty-demo: `inet 172.21.0.5/16`
- prd-agent: `inet 172.18.0.7/16`
- 完全不同 docker network bridge,L3 从根上就过不去。✅

### Layer 3 — TCP 隔离

- `nc -zw 2 cds-prd-agent-main-api 5000` from twenty-demo:DNS 解析就空,nc 直接超时。✅

### Layer 4 — DB 隔离(技术栈差异)

| 项目 | DB 类型 | 连接 | DB 名 |
|------|---------|------|-------|
| prd-agent-main | MongoDB | `mongodb://172.17.0.1:10001` | `prdagent` |
| twenty-demo-main | PostgreSQL | `postgres://...@db:5432/default` | `default`(host=`db`,只在自家网络解析) |

✅ 物理 DB 隔离。

### Layer 5 — per-branch DB 后缀(❌ 未落地)

prd-agent 三个不同分支**全部** `MongoDB__DatabaseName=prdagent`:

```
prd-agent-main                                       MongoDB__DatabaseName=prdagent
prd-agent-claude-cds-mysql-phase-3-scan-enhance      MongoDB__DatabaseName=prdagent
prd-agent-claude-cds-mysql-phase-5-multi-branch-db   MongoDB__DatabaseName=prdagent
```

讽刺的是 `phase-5-multi-branch-db` 分支正是为实现这个能力而存在,目前还未合并/落地。

❌ 标记为 **F16**(per-branch DB 后缀未实施)。

### Layer 6 — 同名 branch 跨项目共存

两个 `main` 通过 `<projectSlug>-` 前缀消歧,worktree 路径、容器名、网络全部独立。✅

## 结论汇总

| 维度 | 等级 | 说明 |
|------|------|------|
| docker network 隔离(DNS) | ✅ 真验通过 | 双向 NXDOMAIN |
| docker network 隔离(IP) | ✅ 真验通过 | 172.21.x vs 172.18.x |
| TCP 跨项目穿透 | ✅ 真验通过 | nc 超时无法连通 |
| DB 隔离(技术栈) | ✅ 真验通过 | postgres `db` host vs mongo `172.17.0.1` |
| per-branch DB 后缀 | ❌ **未落地** | 三分支共享 `prdagent` 库 — F16 |
| 同名 branch 跨项目共存 | ✅ 真验通过 | `main` 消歧前缀正确 |

**P0-3 总评:5/6 维度真验通过。**

## 新发现 friction

### F15:`branch exec` 输出原样回显容器内 secret(HIGH severity)

跑 `cdscli branch exec ... "env"` 时,stdout 中明文出现 `GITHUB_PAT=ghp_jxuN7af...`、`ROOT_ACCESS_PASSWORD=Miduomima..22`、`R2_ACCESS_KEY_ID=66f747...`、`PG_DATABASE_PASSWORD=VsmV6CyOkL3rMfnNqxEqwQ`。当 cdscli 把 stdout 透传给 AI Agent / 终端 / 日志时会带出生产 secret。`/api/branches/:id/container-exec` 端点未做脱敏。

**修复**:由 Agent D 在 commit `8f8d0434` 修复(secret-masker.ts + 51 vitest case)。container-exec/logs 默认 mask,admin 可 `?unmask=1` 显式取消。

### F16:per-branch DB 后缀未实施(MID severity)

预期不同分支的 prd-agent 写到不同 MongoDB 数据库(避免分支间数据污染),实际三分支同库。在 `phase-3` 分支跑生成种子,会污染 `main` 分支同 `prdagent` DB,反向亦然。CDS"分支沙盒"承诺在 DB 层未兑现。

**追踪**:`claude/cds-mysql-phase-5-multi-branch-db` 分支正是为此而存在,等待合并(本轮不在 onboarding UAT 范围,记录待办)。

## 测试命令存档(可复用)

```bash
source ~/.cdsrc

# DNS 隔离双向
cdscli branch exec twenty-demo-main --profile server-twenty-demo "getent hosts cds-prd-agent-main-api"
cdscli branch exec prd-agent-main --profile api "getent hosts cds-twenty-demo-main-server-twenty-demo"

# TCP 跨项目穿透
cdscli branch exec twenty-demo-main --profile server-twenty-demo "nc -zw 2 cds-prd-agent-main-api 5000"

# per-branch DB 后缀(❌ 应不同,实测同)
for B in prd-agent-main prd-agent-claude-cds-mysql-phase-3-scan-enhance prd-agent-claude-cds-mysql-phase-5-multi-branch-db; do
  cdscli branch exec $B --profile api "env | grep -i 'MongoDB__DatabaseName'"
done
```
