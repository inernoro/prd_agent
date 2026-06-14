# 跨项目隔离原则（Cross-Project Isolation）

> 一份全局状态被多个项目/分支共享时，为 A 项目改它就可能静默打坏 B 项目。
> 这类「隔离穿透」事故在本系统已爆发多次（见底部事故台账），且每次出现在
> 不同层面。本规则把所有已知共享通道列成清单，规定改动前的强制审计动作。

---

## 核心判定

改任何「全局值」之前先问：**这个值有几个消费方？改完之后每个消费方还成立吗？**

- 只有一个消费方 → 放心改
- 多个消费方（跨项目/跨分支/跨服务） → 必须先解耦（把值下沉到项目级），
  或逐一确认每个消费方兼容后再改，**并在改动说明里列出消费方清单**

## 已知共享通道清单（改动前逐条对照）

| # | 共享通道 | 消费方 | 穿透方式 | 现状 |
|---|---------|--------|---------|------|
| 1 | CDS master 的 `CDS_JWT_SECRET`（`cds/.cds.env`） | CDS 自身鉴权 + **所有项目**容器的 `Jwt__Secret` | `container.ts` 注入 | **已解耦**（2026-06-12）：项目 customEnv 显式定义 `Jwt__Secret` 时优先，全局值仅兜底。受影响项目应在「项目设置 → 项目环境变量」钉住自己的值 |
| 2 | `Jwt__Secret` 在 prd-agent 内部的双重身份 | JWT 签名 + 平台 API key 的 AES 静态加密（`ApiKeyCrypto`） | 同一个配置值两用 | 轮换密钥 = 存量密文全哑。**轮换前必须先解密重加密所有 `ApiKeyEncrypted` 字段**（llmplatforms / llmmodels）。`PlatformKeyIntegrityWorker` 启动自检 + 站内告警兜底 |
| 3 | CDS 全局变量 `_global` customEnv | 所有项目容器 | `getCustomEnv` 合并 | 合并顺序正确（项目值覆盖全局值）。新增全局变量前先确认没有项目把同名 key 用作不同语义 |
| 4 | 共享 Mongo/Redis 基础设施 | 同项目所有分支预览 + 可能的生产实例 | 同一连接串/同一 database | 分支间共享数据是有意设计，但意味着：**A 分支写坏的数据 B 分支立刻可见**；llmrequestlogs 里会混入其他部署的记录（排障时先按时间窗 + 行为特征区分来源，勿误判） |
| 5 | 生产 CDS 单实例多 Agent 共用 | 所有 Agent 的分支预览 + self-update | 任一 Agent self-update 即重启 CDS | 重启清空内存态（agent sessions）；self-update 切分支会替换 CDS 行为。self-update 前跑 dry-run，并意识到会影响所有人 |
| 6 | `cds-compose.yml` 的 `x-cds-env` 占位值 | CDS 项目 env 导入 | re-import/sync 可能用占位值（`TODO: 请填写实际值`）覆盖真实值 | 重新导入 compose 前 diff 现有项目 env，含 `TODO` 的 key 一律不覆盖 |

## 强制动作

1. **改全局密钥/全局 env**（CDS_JWT_SECRET、`_global` 变量、`.cds.env` 任何值）：
   - 列出上表对应行的全部消费方，逐个确认兼容
   - 涉及加密密钥轮换 → 先迁移存量密文（解密-重加密），后切换
   - 改完后验证**每个**消费方（不只是触发你改它的那一个）
2. **新增全局注入**（往 `container.ts` mergedEnv、`_global` scope 等加 key）：
   - 默认项目值优先（`if (!mergedEnv[k])` guard），禁止无条件覆盖
   - 在本规则的清单表加一行
3. **新增「一值两用」**（同一配置同时当签名密钥/加密密钥/鉴权凭据）：
   - 禁止。新用途必须用独立的配置项，即使初始值相同

## 事故台账

| 日期 | 层面 | 事故 |
|------|------|------|
| 2026-06-12 | CDS env 注入 | 为 miduo-backend HS512 弱钥换 `CDS_JWT_SECRET`，穿透打哑 prd-agent 全部 6 平台 key 密文，模型池静默 401 约 2 小时（无告警）。修复：通道 1 解耦 + 通道 2 自检 Worker |
| （此前 3 次） | 各异 | 用户口述「隔离问题爆发 4 次，总在不同层面」。历史事故发生时未记台账——此后每次隔离穿透事故必须在本表补一行，含层面 + 根因 + 修复 |

## 相关

- `cds/.claude/rules/scope-naming.md` —— 系统级 vs 项目级的命名与归属判定
- `cds/src/services/container.ts` —— 容器 env 注入的唯一入口
- `prd-api/src/PrdAgent.Api/Services/PlatformKeyIntegrityWorker.cs` —— 密钥完整性自检
- `cds/tests/services/container.test.ts` —— 项目值优先的回归测试
