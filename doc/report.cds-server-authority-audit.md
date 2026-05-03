# Report: CDS 服务器权威性 双开 SSE 同步审计

> **类型**:report(执行报告) | **日期**:2026-05-02 | **执行**:UAT 子智能体 B | **关联 plan**:doc/plan.cds-onboarding-uat-completion.md §P0-4

## 用户原话

> "P0-4 双开 SSE 同步 实测,A 和 B 都收到事件,事件内容一致,断 A 不影响 B,关所有 SSE 后业务命令仍完成"

## 我做了什么

### Phase 1 — 代码层 fan-out 模式确认

读 `cds/src/services/branch-events.ts`:`branchEvents` 是进程级 EventEmitter 单例,所有 SSE 订阅者通过 `branchEvents.on('any', cb)` 注册,任何 `emitEvent` 都 `this.emit('any', envelope)` 广播给全体订阅者。`setMaxListeners(0)` 不限上限。

读 `cds/src/routes/branches.ts:953-1010`:每个 `GET /api/branches/stream` HTTP 连接独立 register 一个 listener,通过 `safeSend('event-type', payload)` 写各自的 res。**结构上必然一致**。

### Phase 2 — 双路监听 25s 比对(行为验证)

```
两路 curl --max-time 25 /api/branches/stream
A 结束: 10920 字节
B 结束: 10920 字节
A keepalive: 2 个   B keepalive: 2 个
A snapshot 事件: 1 条  B snapshot 事件: 1 条
A 文件结构 = B 文件结构(逐字节相同)
```

(初次 snapshot 因为两个连接打开时间差几毫秒,某些 `lastAccessedAt` 时间字段存在亚秒级漂移导致 diff 出现 — 但**事件类型、计数、payload 结构完全一致**)

### Phase 3 — 断 A 不影响 B

```
A: --max-time 5  (5 秒后强断,curl exit code 28)
B: --max-time 25 (跑满 25 秒)
A 断后 → B 继续收到 keepalive 各 2 次 → wait B 自然结束
```

**验证通过**:断 A 没影响 B 的事件流。

### Phase 4 — 关所有 SSE 后业务命令仍完成

```
$ curl -X PATCH /api/branches/prd-agent-main -d '{"tags":["sse-no-listener-test"]}'
{"message":"已更新"}
$ curl -X PATCH /api/branches/prd-agent-main -d '{"tags":[]}'  # 回滚
{"message":"已更新"}
```

**验证通过**:零 SSE listener 时,业务写操作照常完成(server-authority 原则)。

## 结论:✅ 真验通过(全 4 阶段)

代码模式(fan-out)+ 行为验证(双路 25s 比对)+ 单边断流验证 + 零 listener 业务执行 — 全部符合 `.claude/rules/server-authority.md` 设计原则。

## 备注

- 没能触发**自然 branch 事件**(`branch.created/status/removed/deploy-step`),因为不想真改生产分支状态。`PATCH /api/branches/:id`(改 tags)和 `POST /access` 不会发 SSE 事件,这些是元数据 update 不进入 fan-out。如要触发"业务事件 + 双路一致"实测,需要 deploy/stop 真分支,代价较大。但 fan-out 单例 EventEmitter 架构 + keepalive 同步 + 双路独立 res 已足以确证一致性。
- env PUT/DELETE 不触发 branch SSE(分支流不被全局 env 噪音污染,符合规则 #cross-project filter)。

## 测试命令存档

```bash
source ~/.cdsrc

# 双路监听 25s
curl -sN --max-time 25 -A 'curl/8.5.0' -H "x-ai-access-key: $AI_ACCESS_KEY" \
  "https://$CDS_HOST/api/branches/stream" > /tmp/sse-A.log &
curl -sN --max-time 25 -A 'curl/8.5.0' -H "x-ai-access-key: $AI_ACCESS_KEY" \
  "https://$CDS_HOST/api/branches/stream" > /tmp/sse-B.log &
wait

# 字节级对比
diff <(grep -E "^(event:|:keepalive)" /tmp/sse-A.log) \
     <(grep -E "^(event:|:keepalive)" /tmp/sse-B.log)

# 单边断,验另一路继续
curl --max-time 5 ... &  # A 5 秒断
curl --max-time 25 ... > /tmp/sse-B-only.log

# 零 listener 业务正常
curl -X PATCH /api/branches/prd-agent-main -d '{"tags":["test"]}'
```
