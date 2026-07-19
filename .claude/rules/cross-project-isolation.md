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
| 4 | 共享 Mongo/Redis 基础设施 | 同项目所有分支预览 + 可能的生产实例 | 同一连接串/同一 database（dbScope 默认 shared，`MongoDB__DatabaseName` 不做 per-branch 后缀，恒为 `prdagent`） | 分支间共享数据是有意设计，但意味着：**A 分支写坏的数据 B 分支立刻可见**；llmrequestlogs 里会混入其他部署的记录（排障时先按时间窗 + 行为特征区分来源，勿误判）。**全局单行状态（`admin_notifications` 里 `TargetUserId=null` + 固定 Key 的行）尤其危险**：任何容器都能开/关同一行，旧构建/异钥分支会把误报复活成看似全局的事故。写共享库全局状态前必须判「是否权威部署」（`DeploymentAuthority.IsAuthoritativeDeployment`：非 CDS 分支预览才写），分支预览只读自检 + 本地日志 |
| 5 | 生产 CDS 单实例多 Agent 共用 | 所有 Agent 的分支预览 + self-update | 任一 Agent self-update 即重启 CDS | 重启清空内存态（agent sessions）；self-update 切分支会替换 CDS 行为。self-update 前跑 dry-run，并意识到会影响所有人 |
| 6 | `cds-compose.yml` 的 `x-cds-env` 占位值 | CDS 项目 env 导入 | re-import/sync 可能用占位值（`TODO: 请填写实际值`）覆盖真实值 | 重新导入 compose 前 diff 现有项目 env，含 `TODO` 的 key 一律不覆盖 |
| 7 | CDS 平台注入的 `BULLMQ_PREFIX`（2026-07-09） | 同项目所有分支容器的 BullMQ 队列前缀 | 同项目多分支共用 Redis 时 BullMQ 默认前缀相同 → 兄弟分支互抢 job；平台按分支注入 `BULLMQ_PREFIX=<branch-db-slug>` 隔离 | **只兜底不覆盖**：customEnv/分支 env/profile.env 显式定义一律优先（`cds/src/services/env-provenance.ts` 步骤 4.5 在 profile 层之后判空注入，slug 与 per-branch DB 后缀同 SSOT）；系统级逃生阀 `CDS_BULLMQ_PREFIX_INJECTION=0`。项目若刻意要跨分支共享队列，显式钉住同一个 BULLMQ_PREFIX 即可 |
| 8 | 共享 Mongo 的 run 队列集合（`image_gen_runs` 等，2026-07-19） | 所有分支预览 + 生产的 `ImageGenRunWorker` | 认领过滤只看 `Status=Queued`，任何部署的 worker 都能抢走任意部署入队的 run——旧构建 worker 抢到新分支的 run 用旧代码执行 | **已隔离**：`ImageGenRun.DeploymentSlug`（入队盖 `DeploymentScope.Current`——`CDS_PROJECT_ID` 标记判分支预览 + 分支级 slug 取实际被注入的 `BULLMQ_PREFIX`/`VITE_GIT_BRANCH`；注意 `CDS_BRANCH_SLUG` 只做镜像模板替换、**不注入容器 env**，不能单独依赖），worker 认领只取同作用域（生产认 null，兼容存量无字段文档）；幂等键经 `DeploymentScope.ScopeIdempotencyKey` 加 `{scope}::` 前缀（生产原样），防前端确定性键跨分支撞唯一索引；WeeklyPoster 复用查询同作用域过滤。过渡期已知边界：仍在跑旧构建的存量部署（认领谓词无作用域）在其重建前仍可能抢走新 run。新增其他 Mongo run 队列（video_gen_runs / 对话 Run 等）必须照此加作用域，禁止裸 Status 认领 |

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
| 2026-07-19 | 共享 Mongo run 队列抢单 | 视觉创作 stub-vision 修复在分支预览「修了像没修」——`image_gen_runs` 认领无部署作用域，旧构建部署的 worker 抢走新分支入队的 run 用旧解析器/旧 stub 执行，同一错误反复复现且新旧两种错误文案混出（用户三次反馈同一画面）。修复：`ImageGenRun.DeploymentSlug` 盖戳 + worker 同作用域认领（通道 8） |
| 2026-07-14 | 共享库全局告警行 | 「平台 API key 解密失败」告警反复出现——`admin_notifications` 全局单行被所有分支预览容器共享，跑旧构建（缺 IsStub）或异钥的分支不断把 dev-stub 误报「复活」成看似全局的事故；且分支预览的密文自动重加密会用本分支密钥改写共享库存量密文。修复：`DeploymentAuthority` 判权威部署，只有生产（非分支预览）才写共享库全局告警行 + 自动重加密，分支预览改为只读自检 + 本地日志；告警文案带来源标签 |
| （此前 3 次） | 各异 | 用户口述「隔离问题爆发 4 次，总在不同层面」。历史事故发生时未记台账——此后每次隔离穿透事故必须在本表补一行，含层面 + 根因 + 修复 |

## 相关

- `cds/.claude/rules/scope-naming.md` —— 系统级 vs 项目级的命名与归属判定
- `cds/src/services/container.ts` —— 容器 env 注入的唯一入口
- `prd-api/src/PrdAgent.Api/Services/PlatformKeyIntegrityWorker.cs` —— 密钥完整性自检
- `cds/tests/services/container.test.ts` —— 项目值优先的回归测试
