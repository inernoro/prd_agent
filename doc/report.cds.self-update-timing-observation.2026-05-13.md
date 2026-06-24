# CDS Self-Update 耗时观察记录（2026-05-13）

> 类型：report / 运维观察  
> 日期：2026-05-13  
> 对象：`https://cds.miduo.org` 远程 CDS  
> 关联：`report.cds.self-update-timing-audit`、`f7ae3da9 feat: persist self update timing details`

## 背景

用户反馈 CDS 更新页经常停在 `validate`，接口已经返回但页面还显示“更新进行中”，并要求不要直接猜修复，而是持续观察、测算和沉淀。

本次记录用于以后复查“到底慢在哪里”，避免只靠截图或体感判断。

## 观察方法

使用远程 CDS API 读取真实运行数据：

- `GET /api/self-status?probe=remote`
- `GET /api/self-update-history?limit=20`
- `POST /api/self-update-dry-run`
- `GET /api/host-stats`

鉴权使用 `X-AI-Access-Key`，报告不记录密钥。

## 关键结论

1. `pnpm install` 不是主要慢点。历史里多数为 `0-15ms(skip)`。
2. 主要慢点集中在 `validate` 内的 `tsc --noEmit`，以及需要前端更新时的 `web build`。
3. 同一 HEAD 第二次 dry-run 能从 `33.4s` 降到 `0.5s`，说明 tsc stamp/cache 是有效的。
4. 历史中曾出现多条更新时间重叠、心跳时间非单调的记录，说明旧链路允许并发 self-update，导致日志串台。
5. 结构化 `timings` 上线后，可以直接从 history 复盘每段耗时，不再解析日志文本。

## 采样结果

### 上线前历史统计

最近 20 条历史中：

| 指标 | 最小 | 中位 | P90 | 最大 |
|---|---:|---:|---:|---:|
| `durationMs` | 0.7s | 103.9s | 207.6s | 300.0s |
| `validate_total_ms` | 42.5s | 79.7s | 149.3s | 182.1s |
| `tsc_cds_ms` | 37.6s | 63.0s | 120.0s | 120.2s |
| `tsc_web_ms` | 41.1s | 79.2s | 149.2s | 182.0s |
| `web_build_ms` | 29.0s | 49.0s | 105.0s | 206.0s |
| `backend_ms` | 2.5s | 4.0s | 9.0s | 30.3s |

典型慢记录：

| 时间 | 状态 | 总耗时 | validate | web build | 备注 |
|---|---|---:|---:|---:|---|
| 2026-05-13T02:25:31Z | success | 300.0s | - | 206.0s | 旧日志缺 validate timing |
| 2026-05-13T05:37:45Z | success | 207.6s | 79.7s | 105.0s | validate + web build 都慢 |
| 2026-05-13T07:23:00Z | success | 186.2s | 100.7s | 74.0s | validate 为主 |
| 2026-05-13T07:02:22Z | aborted | 183.8s | 182.1s | - | tsc 失败 |
| 2026-05-13T08:16:07Z | aborted | 150.4s | 149.3s | - | tsc 失败 |

### dry-run 验证

同一远程 HEAD 连续运行两次 dry-run：

| 次数 | 接口总耗时 | 响应 `durationMs` | 结论 |
|---|---:|---:|---|
| 第一次 | 34.5s | 33.4s | 真实跑 tsc |
| 第二次 | 1.67s | 0.5s | 同 HEAD 命中 tsc stamp/cache |

这证明缓存路径可用，慢主要来自每次 HEAD 变化后的重新 typecheck/build。

### 结构化 timings 上线后

远程 CDS 已更新到：

- `currentBranch=main`
- `headSha=2a781484`
- `remoteAheadCount=0`
- `activeSelfUpdate=null`
- `bundleStale=false`

最近几条带 `timings` 的记录：

| toSha | duration | validate | validateTsc | backend | webBuild | webBuildReason |
|---|---:|---:|---:|---:|---:|---|
| `2a781484` | 45.29s | 40.22s | 39.75s | 1.60s | 0.031s | `web-input-match` |
| `98499fb3` | 35.61s | 29.39s | 29.27s | 4.92s | 0.047s | `web-input-match` |
| `5222fa6f` | 133.84s | 63.60s | 63.27s | 4.82s | 63.13s | `rebuilt` |
| `63f130db` | 230.48s | 148.03s | 147.94s | 6.88s | 72.72s | `rebuilt` |

结论：

- 纯后端路径：现在 web build 可以正确跳过，主要看 `validateTscMs`。
- 前端改动路径：`validateTscMs + webBuildMs` 共同决定总耗时。
- 以后复查应优先看 `timings.validateTscMs`、`timings.webBuildMs`、`timings.webBuildReason`。

## 已落地改动

提交 `f7ae3da9 feat: persist self update timing details`：

- `SelfUpdateRecord.timings` 持久化结构化耗时。
- `/api/self-update-dry-run` 返回 validate 原始 timings。
- `/api/self-update` 和 `/api/self-force-sync` 增加更新互斥，避免并发构建导致日志串台。
- `runInProcessWebBuild` 返回 `webBuildMs / webBuildSkipped / webBuildReason`。

## 后续复查口径

用户跑几轮后，再读取：

```text
GET /api/self-update-history?limit=20
```

复查顺序：

1. 是否有 `activeSelfUpdate` 残留。
2. 是否存在多条时间重叠的 update。
3. 对每条成功/失败记录拆：
   - `timings.validateTscMs`
   - `timings.webBuildMs`
   - `timings.buildBackendMs`
   - `timings.webBuildReason`
   - `timings.totalMs`
4. 如果 `validateTscMs` 持续超过 60s，再单独审视 TypeScript 增量缓存、前端/后端 tsc 触发条件。
5. 如果 `webBuildMs` 持续超过 60s，再审视 Vite build、chunk 体积、依赖和机器瞬时负载。

## 注意

`totalElapsedMs` 当前更接近“流程记录完成到 daemon ready 的尾段耗时”，不是完整用户体感总耗时。复查总耗时时应优先看 `durationMs` / `timings.totalMs`，并把重启尾段单独看。
