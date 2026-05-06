# report.cds-shared-service-mvp-runthrough

| 字段 | 内容 |
|---|---|
| 版本 | 0.1.0 |
| 状态 | done（demo 成功跑通） |
| 责任人 | Claude Code |
| 时间 | 2026-05-06 |
| 关联 | `doc/plan.cds-shared-service-extension.md`、`cds/scripts/mvp-demo.ts`、`changelogs/2026-05-06_cds-shared-service-mvp.md` |

---

## 0. 一句话结论

shared-service 协议链路在沙箱本机端到端跑通：临时 CDS state -> 注入 host + 部署 -> 协议契约返回 instance.host:port -> 直连 sidecar -> DeepSeek 上游真流式响应 9 个 token 写春天诗句，**零污染**（临时目录 + 临时端口，跑完即清）。

## 1. 跑这次演示的目的

验证四件事，**不需要远程服务器**：

1. CDS 数据模型 + 加密入库正确
2. `/api/cds-system/remote-hosts/:id/instance` 协议契约符合主系统消费格式
3. 主系统拿到 `{host, port}` 后能直连 sidecar
4. sidecar 上游切换（DeepSeek）真实工作，token 用量正常

不验证：

- 真实 SSH `docker pull + run`（沙箱无 SSH 服务器）
- prd-api `ClaudeSidecarRouter` 集成（沙箱无 dotnet SDK）

## 2. 隔离设计

| 隔离面 | 实现 |
|---|---|
| state 数据 | `mkdtempSync(/tmp/cds-mvp-demo-*)` 临时目录 + 自有 `state.json`，跑完 `rmSync` |
| HTTP 端口 | mini cds 监听 `127.0.0.1:9991`（避开正式 9900）；sidecar 监听 `127.0.0.1:7401`（避开默认 7400） |
| 进程生命周期 | 脚本同步执行，结束自动 `server.close()`；sidecar 用户控制，跑完手动 `pkill` |
| 产品代码 | 零修改。脚本只 `import` 现有 service / route 工厂，不注册到 server.ts，不进 npm scripts |
| 凭据 | sidecar token、Anthropic key 经环境变量注入，不写盘 |

## 3. 实际跑出来的 5 步输出

```
[demo] tmp state dir: /tmp/cds-mvp-demo-6AR3oG

=== Step 1: Register RemoteHost (RemoteHostService.create) ===
  host id: 99f23d8d5ff63b1a
  host fingerprint: 33cf6c971a20ac51
  redacted view contains plaintext PEM?: false

=== Step 2: Inject a running ServiceDeployment (bypass real SSH) ===
  deployment id: demo-dep-1
  deployment status: running

=== Step 3: Mini express + createRemoteHostsRouter, contract probes ===
[demo] mini cds listening on http://127.0.0.1:9991
  list count: 1
  list[0].name: demo-localhost
  list[0].sshPrivateKeyEncrypted: undefined
  instance.host: 127.0.0.1
  instance.port: 7401
  instance.healthy: true
  instance.version: demo-v0
  instance.tags: ["demo","localhost"]
  deployments count: 1
  deployments[0].status: running

=== Step 4: Directly call sidecar at instance.host:port ===
  sidecar /healthz status: 200
  sidecar /healthz body: {"status":"ok","version":"0.1.0"}

=== Step 5: Sidecar /v1/agent/run streaming via DeepSeek upstream ===
  sidecar /v1/agent/run status: 200
  text_delta event count: 9
  final_text: 柳絮轻飘，花开满径。
  usage: {"input_tokens":24,"output_tokens":9}

=== Demo OK ===
[demo] cleaned tmp dir + closed mini cds (port 9991)
```

## 4. 这次跑通了什么协议层面的事实

| 事实 | 证据 |
|---|---|
| `RemoteHostPublicView` 不暴露 sshPrivateKeyEncrypted | Step 3 `list[0].sshPrivateKeyEncrypted: undefined` |
| fingerprint 不可逆且稳定 | Step 1 `33cf6c971a20ac51`（明文哈希前 16 hex） |
| `/instance` 返回主系统消费的最小契约 | Step 3 `{host, port, healthy, version, tags}` 5 字段齐全 |
| `instance.healthy` 来源于 `containerHealthOk !== false` | inject 的 deployment `containerHealthOk:true` -> 路由器把它当 healthy |
| sidecar 协议层（HTTP + SSE）跨上游工作 | Step 5 `text_delta count=9` + `final_text` 中文诗 |
| `usage` 字段从 Anthropic Done 事件映射 | Step 5 `{input_tokens:24, output_tokens:9}` |
| 上游切换（base_url 透传到 anthropic SDK） | sidecar 进程 env `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`，请求真到 DeepSeek |

## 5. 怎么自己重跑

复用 `cds/scripts/mvp-demo.ts`，三步：

```bash
# 1. 起本机 sidecar
cd claude-sdk-sidecar
SIDECAR_TOKEN=demo \
ANTHROPIC_API_KEY=sk-xxxxx \
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
uvicorn app.main:app --host 127.0.0.1 --port 7401

# 2. 跑 demo 脚本
cd /path/to/repo
SIDECAR_HOST=127.0.0.1 SIDECAR_PORT=7401 SIDECAR_TOKEN=demo \
MINI_CDS_PORT=9991 \
npx tsx cds/scripts/mvp-demo.ts

# 3. 跑完手动停 sidecar
pkill -f 'uvicorn.*7401'
```

DeepSeek 不可用时换 Anthropic 官方：`ANTHROPIC_API_KEY=sk-ant-xxx` + 不设 `ANTHROPIC_BASE_URL`，模型名改 `claude-haiku-4-5-20251001`。

## 6. 真上线时还要补的（仍待 plan 推动）

| 项 | 说明 | 触发条件 |
|---|---|---|
| 真实 SSH 部署 | 给一台 SSH 主机 + 私钥，可在 sandbox 跑 SidecarDeployer 5 阶段全程 | 用户给一台真实主机即可 |
| prd-api ClaudeSidecarRouter 联动 | 沙箱无 dotnet SDK，得跑 CDS 远端编译 | push 到 main 后自动部署 |
| shared-service Project 抽象 | 多主机部署同一服务 | doc/plan.cds-shared-service-extension.md Phase A.5 |
| 蓝绿 / 滚动升级 / 回滚 | 业务量上来后再做 | Phase C |
| prd-admin /infra-services 接 CDS API | 等本分支合 main | 后续 session |

## 7. 历史背景

- 2026-05-06 用户要求"先在本机部署，记得要隔离"
- 沙箱无 docker socket、无 SSH 服务器、无 dotnet SDK，能跑的最大组件：Python sidecar + Node ts 脚本 + 临时 state
- 本 demo 用"注入一条 ServiceDeployment status=running"绕过真实 SSH 部署阶段，专门验证**协议层 + sidecar 上游切换**
- 完整的"SSH 部署 → 健康探针通过 → 路由器路由"链路需要真实远程主机，待用户提供主机后即可补 sandbox 演示
