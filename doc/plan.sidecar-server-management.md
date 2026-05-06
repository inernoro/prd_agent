# plan.sidecar-server-management

| 字段 | 内容 |
|---|---|
| 版本 | 0.1.0 |
| 状态 | frozen-as-reference（冻结为备查方案，等 CDS 扩展完成后再决定是否落地） |
| 责任人 | Claude Code |
| 关联 | `doc/design.claude-sdk-executor.md`、`doc/plan.cds-shared-service-extension.md` |

---

## 0. 一句话定位

把"如何把 claude-sdk sidecar 装到任意远程服务器并管理起来"作为一份**完整可执行方案**冻结。**不立即实施** —— 等 CDS 端把"shared-service"分类做出来后，本计划的部署/编排部分迁过去；prd-admin 端只保留消费侧。

---

## 1. 为什么冻结

最初设计是在 `prd-api` 自己写 SSH 部署引擎 + 服务器登记。但讨论后判断：

| 维度 | prd-api 自做 | 迁到 CDS |
|---|---|---|
| SSH 部署链路 | 重写一份（SSH.NET + docker compose） | CDS 已有"远程编排+健康监控+webhook" |
| 多服务复用 | 仅 sidecar 用 | 未来任何共享服务（Embedding/RAG/转录）都用 |
| 与现有 CI 能力 | 脱节 | CDS 已对接 GitHub App webhook |
| 主系统耦合度 | 高（部署逻辑混在业务系统） | 低（主系统只消费实例发现 API） |

结论：冻结此 plan 作为参考，**主战场迁到 CDS**（见 `plan.cds-shared-service-extension.md`）。

---

## 2. 完整方案归档（备查）

### 2.1 数据模型

```csharp
// 集合: sidecar_servers
public class RemoteServer {
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; }                    // "prod-sandbox-1"
    public string Host { get; set; }                    // 1.2.3.4 / domain
    public int SshPort { get; set; } = 22;
    public string SshUser { get; set; }
    public string SshPrivateKeyEncrypted { get; set; }  // IDataProtector
    public string SshPrivateKeyFingerprint { get; set; }
    public string? SshPassphraseEncrypted { get; set; }
    public List<string> Tags { get; set; } = new();     // ["prod","asia"]
    public int SidecarPort { get; set; } = 7400;
    public string SidecarTokenEncrypted { get; set; }
    public string? AnthropicBaseUrl { get; set; }
    public string? AnthropicApiKeyEncrypted { get; set; }
    public bool IsEnabled { get; set; } = true;
    public string CreatedByUserId { get; set; }
    public DateTime CreatedAt { get; set; }
}

// 集合: sidecar_deployments （每次部署一条，含日志流）
public class SidecarDeployment {
    public string Id { get; set; }
    public string ServerId { get; set; }
    public string Status { get; set; }   // pending|connecting|installing|verifying|running|failed
    public string? Phase { get; set; }
    public long Seq { get; set; }        // SSE 断线续传
    public string SidecarVersion { get; set; }
    public DateTime? LastHeartbeatAt { get; set; }
    public bool LastHealthOk { get; set; }
    public DateTime StartedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
    public List<DeploymentLogEntry> Logs { get; set; } = new();
}
```

### 2.2 部署 5 阶段

```
[1 connecting]   ssh test echo                            < 2s
[2 installing]   scp compose.yml + .env
                 docker compose pull
                 docker compose up -d                     5-15s
[3 verifying]    GET /healthz x5 retries (5s)             5-30s
[4 registering]  追加到 DynamicSidecarRegistry            立即
[5 running]      HealthMonitor 接管周期检查                持续
```

每阶段 SSE 实时推送，前端流式显示进度日志。

### 2.3 监听 3 层探针

| 层 | 频率 | 实现 |
|---|---|---|
| 存活 `/healthz` | 30s | HostedService |
| 就绪 `/readyz` | 60s | 同上扩展 |
| 业务 echo tool | 手动 | 真跑一次工具调用验证完整链路 |

### 2.4 安全考量

1. SSH 私钥用 `IDataProtector`，KeyRing 持久化
2. 私钥永不出库，UI 仅显示 fingerprint 后 8 字
3. 录入校验禁止 unroutable 地址
4. 新增权限 `AdminPermissionCatalog.SidecarServerManage`
5. 部署日志脱敏
6. 录入时当场测连接才允许保存
7. `CLAUDE_SIDECAR_TOKEN` 后端生成强随机，不让用户操心

### 2.5 实施分期

**P0（1.5 天）单服务器最小可用**
- Model + Service + Controller CRUD
- 同步 SSH 部署逻辑（无 SSE）
- DynamicSidecarRegistry 合并 DB 到 Sidecars[]
- admin UI 基础录入表单 + 列表

**P1（1 天）体验完整**
- 部署进度 SSE
- 详情抽屉 + docker logs tail
- HealthMonitor + 状态 chip 实时更新

**P2** 业务探针 / 通知告警 / 蓝绿部署 / SSH 证书

### 2.6 风险点

| 风险 | 缓解 |
|---|---|
| SSH 私钥泄露 | IDataProtector + 不返回前端 + 审计 |
| docker pull 私有 registry 失败 | 部署模板支持 registry login |
| 主-远程网络抖动 | 路由器熔断 + 多副本 + 降级 |
| 远程 daemon 宕机 | HealthMonitor 检测 + 自动重启 |
| SSH.NET 在 ARM/Mac 兼容 | 用 9.x，E2E 测试覆盖 |

---

## 3. 与 CDS 迁移路径

迁过去后，本 plan 的 P0 / P1 / P2 全部由 CDS 实现。prd-admin 只剩：

- 实例发现（调 CDS API 拿"哪些 sidecar 在跑"）
- 路由策略配置（tag-weighted / sticky / 加权）—— `ClaudeSidecarOptions` 仍在主系统
- 业务级监控（active runs / 平均延迟 / 错误率）

边界判断：**任何涉及"操作远程主机/容器"的代码都不在 prd-api**。

---

## 4. 何时解冻

满足以下任一即可解冻并启动 P0：

1. CDS 决定**不**做 shared-service 分类（被否或延期）
2. 紧急临时方案（一台远程 sandbox 必须立刻上线，等不了 CDS）
3. CDS 团队反馈本 plan 中某个能力他们覆盖不到（如 SSH 证书认证）
