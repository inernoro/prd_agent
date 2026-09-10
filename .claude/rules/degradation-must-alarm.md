# 降级必须响铃（Degradation Must Alarm）

**一句话**：后端崩了而前端优雅降级，是这个系统最难被验收发现的一类错误——凡是有降级兜底的链路，必须有一条不靠人去点的常设探针，走了降级就响铃。
**什么时候撞上**：写任何 fallback / 兜底 / 重试降级；或者验收一个「页面看着正常」的功能。

> 判定口诀：**这条链路的降级路径被走过一次，有没有任何一条不靠人去点的闸会响？**
> 没有 → 这个降级就是一个消音器，它把故障从「用户报错」降级成「没人知道」。

---

## 一、为什么这类错误能穿过全部验收

降级本身是对的（`no-rootless-tree`：不许假装模型给过意见）。但它有一个必然的副作用：
**把一次后端崩溃，翻译成了一次表面成功。**

于是三道防线同时失效，而且是结构性的，不是谁不仔细：

| 防线 | 为什么没拦住 |
|---|---|
| 功能验收 / 视觉验收 | 判据问的是「产物出来了吗」。降级路径**确实**产出了产物，页面完整、能点下一步。红色错误条对人眼刺目，对脚本只是一段没人断言的文案 |
| CI / 单测 / 集成测试 | 这类 bug 常常依赖**脏数据时序**：干净库里一切正常，必须写方先跑一遍留下数据，读方下一次读才炸。测试矩阵里没有「先写后读」这个组合，永远绿 |
| 人工巡检 | 后台留痕在容器日志里，而没有任何一条验收会去读容器日志 |

结论：**验收在看前台，这类错误只在后台留痕。** 靠加严前台判据永远补不上，必须另开一条常设的、机器驱动的通道。

---

## 二、五层治理（缺一层就漏）

### 层 0：止血——读方对写方永远宽容

多进程共库时，任一进程先写了新字段，其余还没更新的进程必须仍能读。做不到，
「加一个字段」就是一次跨进程的破坏性变更。

- 强类型读 Mongo 的每个进程，启动时必须装 `IgnoreExtraElementsConvention(true)`
  全局约定（本仓库唯一入口：`BsonClassMapRegistration.RegisterConventionsOnly()`）。
- 约定必须装在**任何一次 Mongo 读写之前**：class map 是懒建的，类型一旦映射过，
  之后再注册约定不会追溯。
- 宽容不等于装懂：字段该补进 record 类还是要补，且**保持与写方相同的态数**
  （写方三态 true/false/缺失，读方就必须是 `bool?`，不许收敛成 `bool` 替它下结论）。

### 层 1：CDS 定时监控是触发器，不是看板

告警不能等人打开面板才发现。CDS `uptime-monitor` 的轮次是本系统唯一的常设触发器：
去抖后**状态翻转才外发**（真掉线 / 真恢复），不会每轮响一次。所有常设探针挂在它上面，
不另起定时器。

### 层 2：定量表格是唯一 SSOT（协议见第三节）

监控什么、判据是什么、多久一次、告警给谁——全部写在一张表里，由**被监控方自己声明**，
CDS 消费。禁止 CDS 侧硬编码某个项目的探测细节：CDS 不该知道 MAP 的业务。

### 层 3：验收表与监控表是同一张表，只是消费方式不同

这是防漂移的关键（`predicate-and-wiring-discipline` 形状 3：判据分裂成两份各自漂移）。

| 消费方 | 取哪些行 | 频率 |
|---|---|---|
| 48 小时稳定冒烟 / 每日验收 | 全量（含重流程、截图、写入用例） | 48h / 每日 |
| CDS 常设探针 | 仅 `probe: light` 的行（一次请求、只读、无副作用） | **6h** |

重验收不提频（148 张截图不可能 6 小时一轮），但它里面每一条「打一次真实请求」的轻探针，
**必须同时登记为 6 小时常设监控**。判据一模一样，只是跑的频率不同。

这条直接消灭「我一测试就出问题，系统却迟迟不反馈」——最坏情况下故障存活 6 小时，
而不是等到下一次人工验收。

### 层 4：告警走 MAP 站内通知，定向不全局

- 来源必须先在 `AdminNotificationSourceCatalog` 登记（新增来源不登记 = 通知没有归属分区）。
- `Section = admin`，`TargetUserId` **必须指定**：禁止发全局通知
  （`cross-project-isolation` 通道 4：全局单行状态被所有部署共享，旧构建会把误报复活）。
- 用 `Key` 做幂等去重，同一故障不重复轰炸。
- 通知正文写**症状 + 下一步**，不写堆栈；堆栈进技术附录。

---

## 三、监控声明协议（定量表格）

### 3.1 行业依据（不自创）

| 这一层 | 抄的行业标准 | 为什么是它 |
|---|---|---|
| 被监控方声明式地告诉监控系统「来抓我」 | Prometheus Operator 的 **ServiceMonitor** | CNCF 事实标准；本仓库 `cds-compose.yml` 已是同一姿势（项目声明、CDS 消费），不引入新心智 |
| 自检端点的响应体 | IETF **draft-inadarei-api-health-check**（`application/health+json`） | 它天生是定量的：`status: pass/warn/fail` + `checks[]` 每项带 `observedValue` / `observedUnit` / `time` / `output` |
| 连续失败几次才算真故障 | Alertmanager 的 `for:` 持续时长 | CDS `nextDebounceState` 已是这个语义 |
| 对症状告警，不对原因告警 | Google SRE Book, symptom-based alerting | 「推导退回了本地关键词」是症状；「Mongo 少个字段」是原因。对症状告警才不会漏掉下一个没预料到的原因 |

### 3.2 声明文件：`cds-monitors.yml`（与 `cds-compose.yml` 并列）

每行一个监控项，列固定：

| 列 | 含义 | 硬要求 |
|---|---|---|
| `id` | 稳定标识 | 告警去重与台账追溯的键，不随意改名 |
| `name` | 中文名 | 通知正文直接用，人读 |
| `kind` | `health-json` / `http` / `keyword` / `tcp` | 前三种判内容，`tcp` 只判端口通 |
| `url` | 打哪里 | 深链到自检端点，不是根路径 |
| `componentId` | 断言哪一条 check | health-json 专用；指向不存在的 check 判**失败**，那是接线断了 |
| `expect` | **结构化判据** | `field`(status/observedValue) + `op`(eq/ne/lt/lte/gt/gte) + `value`。刻意不做可解析表达式：自由文本判据一开口，下一轮就会被要求加同义词和嵌套语法（CLAUDE.md 5.5 熔断条件） |
| `probe` | `light` / `heavy` | `light` 才进 6 小时常设监控（一次请求、只读、无副作用） |
| `intervalSeconds` | 频率 | 常设轻探针默认 `21600`（6h） |
| `failuresToAlarm` | 连续失败几次才响 | 去抖，默认 2 |
| `notify.source` | MAP 通知来源 | 必须已在 `AdminNotificationSourceCatalog` 登记 |
| `notify.targetUserId` | 通知给谁 | 必填，禁止全局 |
| `severity` | P0 / P1 / P2 | 决定通知的 `Level` |

### 3.3 自检端点必须跑真链路，不是报「我还活着」

这是整个协议成立的前提。`kind: health-json` 打的端点，内部要**真的把关键链路走一遍**
（行业叫合成事务监控 / synthetic transaction），逐项返回定量结论。

对本次事故，`llmgw` 该暴露的两条 check 是：

| componentId | 断言 | 抓的是什么 |
|---|---|---|
| `intent-draft.roundtrip` | 真调一次用途码推导，`observedValue` 的来源必须 `== "model"` | **直接抓「走了降级」这个症状本身** |
| `serving.unhandled-exceptions` | 最近窗口未处理异常数 `== 0` | 抓「页面看着好、后台在炸」的**全部**同类错误，不止这一个 |

第二条是这套东西里最值钱的一条：它不需要为每个功能单独写判据。

### 3.4 Key：公钥配一次，签名每次现算

要求是永久、不重复配对。这里**不发明新机制**——本仓库的
`StableSmokeAuthenticationHandler` 已经跑通了这套：MAP 配置里只存公钥，调用方持私钥
每次现签，带 nonce 防重放，认证通过后自动开号。

关键性质：**配对关系永久，过期的只是单次签名**。签名短时效是为了防重放，不是让人隔三
差五重新配一次；私钥从不过网络，泄漏面比静态 token 小一个量级。行业同类：GitHub App
的 JWT 认证、AWS SigV4。

| 方向 | 机制 | 永久性 |
|---|---|---|
| 本仓库 → CDS（提交声明） | CDS 项目级 Agent Key `cdsp_<slug12>_<suffix>` | `AgentKey` 类型**没有 `expiresAt` 字段**，只有显式 DELETE 才写 `revokedAt`——天生永久 |
| CDS → 自检端点（探测） | RSA 签名请求，验证方只持公钥 | 换钥才失效 |
| CDS 告警 → MAP 站内通知 | 同上，走 `POST /api/dashboard/notifications/events`，`stable-smoke` 已在用 | 换钥才失效 |

声明**不直接写**监控：CDS 的 `/api/uptime/monitors` 写接口挂着 `denyProjectScopedWrite`，
项目级 key 一律 403（2026-09-08 安全加固，防止一个项目的 key 去改别人的监控、或让它打
任意外部地址）。那条边界是对的，不要为了自动化去破它——照 `cds-compose.yml` 的先例走
**pending-import → 管理员审批 → 生效**。「由被监控方发起声明」与「写权限仍归管理员」
在这个模式下不冲突，且心智与 `cdscli import` 完全一致，不引入第二套流程。

**为什么探测不用静态 token**：静态 token 一旦泄漏就是永久失守，而且它还得存在某个地方——
存进 CDS 项目级 env 就正好踩上 `cross-project-isolation` 通道 9（2026-09-01 事故：
项目级 env 同项目所有分支共用一份，一次轮换把兄弟分支打成 401）。公钥不是秘密，放哪都行。

判据：**一条预览的签名拿去打同项目另一条预览，必须被拒**（部署作用域要进签名载荷）。

---

## 四、自查清单

写降级 / 兜底代码时：

- [ ] 这条降级被走过一次，有没有一条不靠人去点的闸会响？
- [ ] 降级状态有**机读判据**吗（`data-*` 属性 / 响应字段 / 自检端点的 check），还是只有一段给人看的红字？
- [ ] 这条链路进 `cds-monitors.yml` 了吗？`probe: light` 的话，是不是 6 小时常设？

多进程共库改数据结构时：

- [ ] 写方加的字段，读方那个 record 类有吗？没有的话，那个进程装了 `IgnoreExtraElements` 吗？
- [ ] 读方保持了与写方相同的态数（三态别收敛成两态）？
- [ ] 约定装在第一次 Mongo 读写之前吗？

接监控 / 告警时：

- [ ] 判据是定量的（数字 / 枚举）还是一句不可判的话？
- [ ] 通知来源在 `AdminNotificationSourceCatalog` 登记了吗？`TargetUserId` 指定了吗（禁止全局）？
- [ ] key 是永久的吗？`probeToken` 是不是躲开了项目级 env？

---

## 五、与其他规则的关系

- `closed-loop-acceptance.md`：那条管「产物要真的出现」；本条管**产物是不是走正路出现的**——它正是那条规则漏掉的另一半。
- `predicate-and-wiring-discipline.md`：本次事故是形状 3（写读两侧判据分裂）+ 形状 2（`BsonClassMapRegistration` 建了但 serving 不调用，链路只建一半）的合体。
- `cross-project-isolation.md`：通道 4（共享 Mongo）是这次事故的土壤；通道 9（项目级 env 跨分支）是 `probeToken` 那条禁令的来源。
- `expectation-management.md`：降级而不告警，是「白等 / 白做一场」在**运维侧**的形态——用户以为好着，其实每次都在炸。
- `real-visual-acceptance.md` / `stable-smoke`：那两条是重验收；本条是它们的轻量高频补集，共用同一张定量表格。
- `living-status-board.md`：常设探针的当前状态挂看板「验收证据」列。

---

## 六、历史背景

2026-09-09，用户在 Quickstart 页面看到「网关服务内部错误（500）。已退回本地关键词判定。」，
问的是：「我的那么多条验收都解决不了这种低级错误？」

挖到的根因是一条完全静默的链路：`console-api` 用弱类型 `BsonDocument` 往
`llmgw_app_callers` 写了 `SystemManaged` 字段，`serving` 用强类型 `GatewayAppCallerRecord`
读同一个集合，而那个类没有这个属性、也没装忽略额外字段的约定——鉴权路径上直接
`FormatException` → 500。仓库里有一份逐个类调了 60 多次 `SetIgnoreExtraElements(true)`
的注册表，但它既没覆盖这个类，也**只在 `prd-api/Program.cs` 被调用，serving 根本不跑它**。

真正值得记住的不是这个 bug，而是它**穿过了全部验收**：前端降级把 500 翻译成了一次
表面成功，页面完整、码照样出、下一步照样能点。所有断言「产物出来了吗」的判据全部判绿，
而容器日志里那条 `fail:` 未处理异常，从落地那天起就没有任何闸门读过它。

本规则由此固化：**有降级的地方，必须有铃。**
