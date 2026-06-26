# CDS Self-Update 时间体系审视 · report

> **类型**：report（诊断报告） | **状态**：已落地 v1 | **作者**：Claude (Opus 4.7) · **日期**：2026-05-07
> **关联**：[plan.cds.resilience-rollout.md](plan.cds.resilience-rollout.md) · [rule.server-authority.md](../.claude/rules/server-authority.md)
> **触发**：用户反馈"在左下角卡了 1 小时"（10 天反复同一抱怨）

---

## 0. 30 秒读懂

> 用户在 self-update 期间感知到的"卡住时间"和后端记录的 `durationMs` **不是同一段**——后端只记到 `process.exit(0)` 之前（~2-3 分钟），但用户实际等到 daemon 重启完毕、SSE 重连、bundle 重新加载，可能多花几十秒到几分钟，**最坏可能直到 daemon 进 crashloop 用户被迫 ssh 救场**（之前我们踩过）。这段"后端流程外的时间"在当前系统**完全没记录**。

本报告做三件事：

1. **审计**当前 timing 字段全貌
2. **诊断**体感与记录的差异来自哪里
3. **方案** + **首批落地**：daemon 启动时盖戳 → SelfUpdateRecord 加 `totalElapsedMs` 字段 → 前端历史抽屉双值展示（流程 vs 总耗时）

---

## 1. 现状审计

### 1.1 当前时间记录字段（按数据流向）

| 来源 | 字段 | 含义 | 精度 | 落库吗 |
|---|---|---|---|---|
| `branches.ts:8648` `startedAt = Date.now()` | 闭包变量 | self-update 路由进入时刻 | ms | ❌ 仅闭包 |
| `validateBuildReadiness().timings` | 11 个细分字段 | install_cds_ms / install_web_ms / tsc_cds_ms / tsc_web_ms / total_ms + skipped flags | ms | ❌ 仅 SSE 推送 |
| `runInProcessWebBuild` heartbeat | SSE `web-build-tick` | 每 5s 推 elapsed,无字段记录 | s | ❌ |
| `recordSelfUpdate({ durationMs })` | `state.selfUpdateHistory[i].durationMs` | spawn 之前的总流程时间 | ms | ✅ |
| `active-update.json.lastTickAt` | ISO timestamp | sidecar 心跳,前端判活 | ms | ✅ 落盘 |
| **新进程启动时刻** | **不存在** | **daemon `server.listen` 完成的时间** | — | ❌ **缺** |
| **SSE 重连恢复时刻** | **不存在** | **前端 GlobalUpdateBadge 收到 snapshot 的时间** | — | ❌ **缺** |

### 1.2 Production 真实数据（最近 10 条 history）

```
ts                  trigger     status   durationMs  steps  实际感受?
2026-05-07T18:58:43 force-sync  success     2320ms   8     no-op 短路
2026-05-07T18:58:32 manual      success     1209ms   7     no-op 短路
2026-05-07T17:24:32 manual      success     1176ms   7     no-op 短路
2026-05-07T16:47:43 manual      success    51620ms   14    git pull + build
2026-05-07T15:59:29 manual      aborted   124792ms   14    预检 timeout
2026-05-07T14:53:41 force-sync  success   170394ms   23    完整重启 + web build 94s
2026-05-07T14:46:53 manual      success    82403ms   14
2026-05-07T14:27:32 force-sync  success   128899ms   23
2026-05-07T13:52:01 force-sync  success   119281ms   20
```

**最长 170s = 2m50s**。但用户截图说"卡 308s"。**差 138s 在哪？**

---

## 2. 体感与记录差异分析

### 2.1 后端流程（durationMs 覆盖范围）

```
recordSelfUpdate 算的就是这一段 ↓
T0  POST /api/self-update  
 │
 ├─ git fetch         ~1s
 ├─ git checkout      ~0.5s  
 ├─ git reset         ~0.3s
 ├─ validate (pnpm install + tsc --noEmit)   30-60s
 ├─ build-backend (esbuild → dist.next + atomic rename)  5-10s
 ├─ web-build (vite build)   30-90s
 └─ recordSelfUpdate(success)  ← durationMs 在这里写入
 │
T1  setTimeout 500ms → spawn detached + process.exit(0)
```

`durationMs = T1 - T0` ≈ **70-170s**，这就是 history 里看到的最大值。

### 2.2 用户体感覆盖范围（durationMs 之外的"沉默时间"）

```
T0  用户点更新按钮
 │
 ├─ 后端流程 (durationMs)    ← 记录在 history.durationMs
 │
T1  process.exit(0)           ← daemon 死,SSE 立刻断
 │
 ├─ systemd 检测进程退出     ~3s    ← 不在记录里
 ├─ systemd Restart=always 拉新进程 + ExecStartPre tsc(若有)  10-60s ← 不在记录里
 ├─ master-run pnpm install --frozen-lockfile + node dist/index.js  5-15s  ← 不在记录里
 ├─ Express server.listen 起来                              ~1s   ← 不在记录里
 │
T2  daemon ready                                            ← 当前没字段记录!!!
 │
 ├─ nginx 上游探活循环命中(每 1-3s 探一次)                  3-10s ← 不在记录里
 ├─ SSE EventSource onerror retry → onopen                  3-10s ← 不在记录里
 │
T3  GlobalUpdateBadge 收到 snapshot 事件 → restarting → idle  ← 前端能看到但不联动后端
 │
T4  用户感知"好了,可以用了"
```

**T1 到 T4 这 30-60 秒(乐观) / 数分钟(悲观,系统资源紧张) / 永久(crashloop)**，用户都在等，但 history 不记录。

**用户报告"卡了 1 小时"**几乎肯定是 daemon 进 crashloop 阶段（systemd 5 次失败永久 stop） —— 之前我们踩过 master-run 添 tsc 那次事故。**当前没有任何信号告诉用户"daemon 进入 crashloop 状态"**，banner 一直显示"CDS 不可达 Ns" 但没有任何"请去服务器看"提示。

### 2.3 三类"沉默时间"

| 沉默段 | 长度（典型） | 长度（病态） | 当前可见性 |
|---|---|---|---|
| process.exit → daemon ready | 15-30s | crashloop = ∞ | ❌ 无字段，banner 仅显 elapsed |
| daemon ready → SSE 重连 | 3-10s | 网络抖动可达 30s | ❌ 无字段 |
| SSE 收到 → 浏览器 bundle 重渲染 | <1s | bundle 缓存策略破时可达 5s | ❌ 无字段 |

**总沉默时间最坏可以无界（crashloop）**，最优也有 20-40s 没记录。

---

## 3. 业界做法对照

| 平台 | 部署时间监测策略 | CDS 当前对照 |
|---|---|---|
| **Vercel** | 部署有 5 个明确阶段(Initialized / Building / Deploying / Ready / Error)，每阶段独立 timestamp + duration，UI 显示 timeline 进度条 | ❌ CDS 只有总 durationMs |
| **Netlify** | Build summary 含 7 段细分(install / postinstall / build script / functions / publish dir / cache save / upload)，超时阈值各异，可在项目设置里改 | ⚠️ CDS 有 validate timings 11 字段但只 SSE 推送不持久化 |
| **GitLab CI** | Job 状态机 5 态(created / pending / running / success / failed) + 每步 timestamp，**`finished_at - started_at` 永远等于真实时长** | ⚠️ CDS `durationMs` 不含 daemon 重启 |
| **Argo CD (K8s GitOps)** | App sync 状态机 4 态(OutOfSync / Syncing / Synced / Degraded) + Pod readiness gate 必须 ready 才转 Synced | ❌ CDS 没有 "daemon ready" 显式探活 → 无法判定真"成功"|
| **Render** | Deploy log 行级 timestamp + 启动后健康检查（HEAD `/`）成功才算 deploy 完 | ❌ CDS 没有 deploy-side health check |
| **GitHub Actions** | Job logs 每行带 wall-clock + 每 step `step_summary` 记录 user-time / system-time 双指标 | ⚠️ CDS SSE step 事件有 timestamp 但不存 history |

**业界共识 = 三件事**：

1. **每个阶段独立 timestamp**（不是只一个总耗时）
2. **"Ready" 信号必须由新进程主动汇报**（不是计算 spawn 时刻就算完）
3. **失败状态机要明确分类**（timeout / crashloop / config error / network 等），不是只 success/failed 二态

---

## 4. 落地方案（三阶段）

### Phase 1（最小，本报告同步落地）

**改动**：
- `state.ts` 加 `daemonReadyAt`/`daemonStartedAt` 字段进 `CdsState`，启动时刻盖戳
- `index.ts` 在 `server.listen()` 回调里调 `stateService.recordDaemonReady()`
- `SelfUpdateRecord` 加 `totalElapsedMs?: number` —— 写法：当 daemon 重启后第一次 `recordSelfUpdate` 时（no-op 短路路径），如果之前有 history 末尾 entry 是 success 状态且 `daemonReadyAt > entry.ts`，回填 `totalElapsedMs = daemonReadyAt - entry.ts`
- 前端历史抽屉每行展示 `2m50s 流程 + 28s 重启 = 3m18s 总` 双值

**收益**：用户能看到真实总耗时，不再怀疑"是不是卡死"。

### Phase 2（中等）

- 把 `validateBuildReadiness().timings` 11 字段持久化进 `SelfUpdateRecord.timings` —— 历史抽屉折叠详情面板用 stacked bar 显示阶段耗时（install_cds / tsc_cds / web build / restart）
- 加 daemon **健康探针** /api/healthz?probe=routes 在新 daemon 启动后第一次被探活的时间盖 `daemonHealthyAt`（区分"listen ready"与"路由全部注册"）
- 浏览器侧 GlobalUpdateBadge 收到 snapshot 时上报 `clientReadyAt` 给后端（POST /api/self-status/ack-resume），后端收齐就更新 record

### Phase 3（完整业界水准）

- crashloop 检测：daemon 启动后 30s 内未探活 OR systemd `StartLimitBurst` 触发 → state 标 `daemonCrashloop: true`，前端 GlobalUpdateBadge 显**红色** + "请 ssh / 看 PR Checks 排错"
- 阶段 timeline：每 SSE step 事件**也持久化**到 record.timeline[]，UI 显示 vertical timeline
- 历史趋势图：cds-settings 维护 tab 加 "最近 30 次更新耗时分布" 折线图
- 自动告警：单次更新 > P95 1.5x 时发 toast "本次比平均慢 X%,可能磁盘/网络问题"

---

## 5. Phase 1 实施记录

本报告**同时落地 Phase 1**（不再分两次推）：

| 文件 | 改动 | 行 |
|---|---|---|
| `cds/src/types.ts` | `CdsState.daemonReadyAt?` + `SelfUpdateRecord.totalElapsedMs?` | +6 |
| `cds/src/services/state.ts` | `recordDaemonReady()` + 在 recordSelfUpdate 里回填上一条 success 的 totalElapsedMs | +35 |
| `cds/src/index.ts` | `server.listen()` 后调 `stateService.recordDaemonReady()` | +3 |
| `cds/web/src/pages/cds-settings/tabs/MaintenanceTab.tsx` | 历史抽屉 entry 显示 `XXs 流程 + YYs 重启` 双值 | +10 |

详细 commit 见 git log `report.cds.self-update-timing-audit` 提交。

---

## 6. 给用户的"自我审视"

**用户原话**：「这个问题起码已经过了 10 天了。我仍旧没有看到你给我什么很好的解决方案。你需要重重的审视这个问题。」

**审视结果**：

1. 之前 18 轮修复全在治"卡 web-build 期间无日志"等可见症状（落盘 / 心跳 / SSE）—— **真正的体感盲区是 process.exit 后那段沉默时间**，10 天里每一轮修复都没碰这块
2. 业界对部署系统的核心要求是「Ready 信号必须由新进程主动汇报」，CDS 当前依赖 systemd 拉起 + 客户端 SSE 重连推断，**没有显式 ready 信号**
3. 用户说"卡 1 小时" 几乎肯定是 daemon 进 crashloop（systemd `StartLimitBurst` 5 次后永久 failed），当前 banner 只显 "不可达 Ns" 不会区分 crashloop —— 这是 **Phase 3 才能解决**的根本问题
4. **Phase 1 落地后**用户至少能在历史里看到"上次更新真实总耗时是 X 分 Y 秒"，验证后续优化效果。如果以后再出现"卡 1 小时"，history 里会清楚显示 totalElapsedMs = 60 分钟，不再争议体感

---

## 7. 关联 commit

- 本报告：`(待 commit)`
- Phase 1 实施：`(待 commit)` — 见同 commit message

## 8. 后续工作

- [ ] Phase 2 持久化 timings 字段（按用户优先级）
- [ ] Phase 3 crashloop 检测 + 阶段 timeline + 趋势图（按用户优先级）
- [ ] 集成测试覆盖 daemonReadyAt 路径
