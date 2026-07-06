# CDS 配置树 · 技术设计

> **类型**:design(怎么做) · **更新**:2026-07-06 · **状态**:波1-3 已实现,波4-5 方向已定
>
> 对应工程看板:`doc/plan.cds.status.md` §〇「配置体系三波演进」。

---

## 一、管理摘要

CDS 的配置此前是「项目为中心的两层继承」:项目底座 + 分支覆盖,能力存在但**不可见、不可达、不可派生**——分支临时容器只有裸 HTTP API、没人能回答「容器里这个变量是哪一层给的」、新分支永远从项目模板起步而无法继承来源分支的配置。

本设计把配置体系定型为**四层配置树**:

```
CDS 全局默认(_global 变量层)
  → 项目配置(customEnv / BuildProfile 底座 / 虚拟 compose)
    → 分支配置(profileOverrides 覆盖 + extraProfiles 临时追加)
      → 派生分支(从来源分支快照拷贝,之后各自独立)
```

三个已拍板的关键决策:

1. **派生 = 快照拷贝**,不是活继承。建分支时把来源分支的分支级配置深拷贝一份,之后两边独立;保留 `derivedFrom*` 指针仅做溯源展示与「一键重新拉取」入口。理由:活继承的远程副作用(父分支改动静默影响子分支)与排障复杂度远超收益。
2. **仓库 `cds-compose.yml` = 纯结构种子**(波4 方向):只声明服务/依赖/路由结构,零密钥零环境值;CDS 配置树是运行时 SSOT;repo 变更走漂移巡检出「同步建议」,人审落地。
3. **配置必须可观测**:任何分支能一屏回答「生效配置是什么、每项从哪继承、被谁覆盖、CDS 接下来会做什么」(生效配置检查器)。

---

## 二、背景与定位

用户诉求(2026-07-06):CDS 能力上限在涨,使用下限没降。核心痛点:

- `cds-compose.yml` 是静态文件,难一次生成准确,且与项目真实状态渐行渐远 → 不信任;
- 分支临时接一个 Nacos 不应影响其他分支,且要能快速撤销;
- 配置的继承/覆盖/新增全程黑盒,用户和 Agent 都看不见;
- 产品经理等非后端角色无法低成本获得「分支级独立可测环境」。

调研结论:一半能力已存在但停在 API 层(`extraProfiles`、`resolveEffectiveProfile` 合并链、虚拟 compose 版本化、快照回滚)。本工程的主体是**把存量能力产品化 + 补齐树的缺口(派生/溯源/分支层快照)**,不是重写。

---

## 三、四层配置树模型

| 层 | 载体 | 作用域 | 改动方式 |
|---|---|---|---|
| 全局默认 | `customEnv._global`(CDS 全局变量) | 所有项目 | CDS 系统设置 |
| 项目 | `Project.customEnv / defaultEnv / defaultDeployModes` + `BuildProfile`(项目底座) + 虚拟 compose(`composeYaml` 带版本/来源) | 单项目全分支 | 项目设置 / pending-import 审批 |
| 分支 | `BranchEntry.profileOverrides`(逐字段覆盖底座) + `BranchEntry.extraProfiles`(临时追加服务) + 分支级 env scope | 单分支 | 分支抽屉「设置」tab / cdscli / API |
| 派生分支 | 建分支时从来源分支深拷贝分支层配置 + `derivedFrom*` 指针 | 单分支 | `POST /branches` 带 `sourceBranchId` / cdscli `branch create --from` |

合并中枢不变:`resolveEffectiveProfile`(baseline → 分支覆盖 → 部署模式)与 `mergeBranchProfiles`(项目底座 + 分支追加,撞 id 底座赢)。字段权威边界由 `config-authority.ts` 三级(repo/platform/user)把守。

### 派生的三层判定策略(W3a)

| 场景 | 行为 | 理由 |
|---|---|---|
| 手动创建(`sourceBranchId`) | **真拷贝** + 写指针 | 用户显式选择,预期明确 |
| webhook push 自动建分支 | 保持项目模板,不拷贝不回填 | push payload 无可靠派生信号,不猜 |
| PR opened/reopened | **仅回填指针**(base 分支),不拷贝 | 分支往往已按模板部署,静默改写违反最小惊讶;要拷贝走显式端点 |

补偿路径:`POST /branches/:id/copy-config-from/:sourceId` —— 显式一键拉取,**拷贝前自动拍含分支层的 ConfigSnapshot**,误拷可回滚;`?redeploy=1` 让配置立即生效。

### 已知边界

- 派生拷贝会把来源分支覆盖里**硬编码的连接串原样带过来**(per-branch DB 名会自动按新分支后缀化,但硬编码串穿透)。检查器把这类 key 的来源显示为「分支覆盖」,用户可辨;后续可对 `PER_BRANCH_DB_ENV_KEYS` 命中的覆盖 key 加警示徽标。
- 跨项目派生被显式拒绝(profileId 引用与隔离语义均为项目内)。

---

## 四、配置可观测性(生效配置检查器,波2)

**逐 key 溯源**是本工程的可信基座。容器 env 是两段式合并:

- 段A 分支 customEnv:`cds-builtin → mirror → global → project → branch → cds-derived(保留 key)`
- 段B 单容器运行时:`customEnv → JWT 兜底 → node PATH → profile 层(底座/分支覆盖/部署模式) → 版本元数据 → per-branch DB 改写 → ${VAR} 模板展开`

实现原则:**单一代码路径**。段B抽为纯函数 `resolveProfileRuntimeEnvWithProvenance`(`cds/src/services/env-provenance.ts`),输入「带来源标注的层数组」,输出 `{env, provenance}`;部署路径退化为单层包装只取 `.env`,行为与旧实现逐字节一致(container.test.ts 43 例护栏)。检查器端点把两段按真实来源拆层传入,免费获得溯源——不存在第二份合并逻辑,永不漂移。

`EnvSource` 12 值枚举 + `EnvKeyProvenance`(value/source/detail/shadowed/templated)是公开契约,定义在 `cds/src/types.ts`。

消费面:

- `GET /api/branches/:id/effective-config`:envLayers 分层摘要 + 每 profile 的 envProvenance(maskSecrets 脱敏,缺模板值不 fail 而是 `envError` 显性化)+ `plan`(将起的容器/网络/需拉起的共享 infra,记录态不打 docker)+ `derivedFrom` 溯源。
- 前端 `EffectiveConfigPanel`:分支抽屉「配置」tab + 分支详情页「生效配置」区。继承链树、来源徽标、shadowed 覆盖链、部署计划、派生行(含「重新拉取来源配置」按钮)。

---

## 五、快照与回滚(W3d)

`ConfigSnapshot.payload` 新增可选 `branchConfigs`(分支层:profileOverrides / extraProfiles / derivedFrom*),只收有配置的分支控体积。回滚语义:

- 仅恢复**仍存在**的分支;快照后新建的不动、已删的不复活;
- 新快照总是带 `branchConfigs`(空对象也带)——区分「拍照时确无分支配置(回滚要清掉事后新增)」与「旧快照没拍过分支层(回滚 no-op,零迁移)」;
- 快照 scope 为项目时只拍/只回滚该项目的分支。

---

## 六、接口与入口一览

| 能力 | API | CLI | UI |
|---|---|---|---|
| 分支临时服务 | GET/PUT `/branches/:id/extra-services[?redeploy=1]` | `cdscli branch extra-services list/set/remove` | 分支抽屉「设置」tab + 详情页面板(预设:Nacos/Kafka/RabbitMQ/Redis/MinIO) |
| per-branch DB 开关 | PUT `/branches/:id/profile-overrides/:pid`(dbScope) | — | 分支抽屉运行模式区选择器 |
| 生效配置检查器 | GET `/branches/:id/effective-config` | — | 抽屉「配置」tab / 详情页「生效配置」 |
| 派生建分支 | POST `/branches`(sourceBranchId) | `branch create --from <id>` | 分支列表页搜索下拉「配置来源」选择器(默认项目模板,不派生) |
| 显式拉取配置 | POST `/branches/:id/copy-config-from/:sourceId[?redeploy=1]` | — | 检查器派生行按钮 |
| 快照/回滚 | `/api/config-snapshots*`(含分支层) | — | 项目设置快照 tab |

---

## 七、波4 / 波5 方向(未实施,只定方向)

**波4 双 SSOT 收敛(repo compose = 纯结构种子)—— 代码层已实现(2026-07-06)**

- **已落地**:仓库 `cds-compose.yml` 的 `x-cds-env` 已剥离全部密钥/占位符键(仅留
  `ASSETS_PROVIDER` / `TENCENT_COS_PREFIX` 结构默认),密钥统一走 CDS env scope →
  消除 `debt.cds.compose-secrets.md` D1 的 import-reject 根因(占位覆盖真实密钥);
- **已落地**:`config-authority.classifyEnvSeed(key,value)` = seed 级判定(`repo-structural`
  vs `cds-env-scope`);`compose-drift.computeComposeDrift(repo, live)` 纯函数按权威分级
  产出漂移报告(密钥应剥离 / 结构漂移同步建议 / CDS 运行时独占不回写);
- **已落地**:`POST /api/projects/:id/compose-drift-scan` 读 repo 结构种子 diff 配置树,
  `createImport=true` 时用 `composeSource='repo-sync'` 语义开一条 `repo-sync` PendingImport
  走既有人审流(去重,单向:CDS 运行时改动不回写 repo);
- **仍 open**:运行实例上验证 env scope 注入不丢(D1 判 paid 的最后一环,见 debt 台账);
  可选增强:drift-scan 由 webhook push 自动触发 + 面板漂移入口 UI + 「CDS 级默认 profile
  片段」结构默认源统一。

**波5 无 Agent 接入 —— 后端 race-free 检测已实现(2026-07-06)**

- **关键发现**:建项目对话框(`ProjectListPage`)**已**提供 URL 式 3 步接入 —— 粘贴 Git URL →
  「检测」调 `POST /api/detect-runtime`(浅克隆 + `detectModules` 填 runtime/命令/端口)→
  确认应用服务 → 建项目时 `onboardingServices` + `autoDetectOnClone` 走 `applyRuntimeHintProfiles`
  (用户确认 = race-free,不产 ghost profile)。所以「PM 无法在 UI 接入」的旧前提大体已过时。
- **本波补齐的真实断头路** = 「已 clone 的空项目」事后检测(webhook 自动 clone / 建时没勾服务 /
  检测为空的项目,clone 后停在「保留为手动配置」):
  - `GET /api/projects/:id/detect-preview`:只读扫描项目**已 clone** 的 worktree(不再重复克隆、
    不写状态),复用抽出的 `buildDetectedServicesFromDir`;
  - `POST /api/projects/:id/detect-apply`:用户显式确认后按检测结果建 profile,**空项目守门**
    (已有 profile 则 409),用户发起 = 无 ghost race;
  - ghost race 的根因是「clone 时自动提交」,本波不重开该自动提交,而是走「用户确认再提交」绕开。
- **UI 已落地**:`BranchListPage` 空项目态(`buildProfiles.length===0`)引导「检测技术栈」→
  `DetectStackDialog`(shadcn Dialog,主题 token 双色,列表勾选)调 detect-preview → detect-apply →
  刷新,PM 无需 Claude/cdscli 即可 UI 完成接入。
- **仍 open**:灰度真视觉验收(双主题截图,`real-visual-acceptance`),故本波记 80%。

---

## 八、关联文档

- `doc/plan.cds.status.md` §〇 —— 工程看板(进度/blocker/证据)
- `doc/design.cds.branch-local-extra-services.md` —— 分支临时服务的底层设计
- `doc/design.cds.branch-network-isolation.md` —— 分支专属网(cds-br-*)
- `doc/spec.cds.compose-contract.md` —— compose 契约(波4 的改造对象)
- `doc/debt.cds.compose-secrets.md` —— D1 债务(波4 偿还)
- `doc/guide.cds.multi-branch-db.md` —— per-branch DB 用法
- `.claude/rules/cross-project-isolation.md` —— 隔离穿透审计(派生拷贝的风险对照)

## 九、风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 段B重构触部署热路径 | 高 | 纯函数单一代码路径 + 行为等价断言 + container.test.ts 护栏;灰度真机验证是合并前置门槛 |
| 溯源端点泄密 | 高 | maskSecrets SSOT + 不提供 reveal + vitest 脱敏断言 |
| 派生拷贝隔离穿透(硬编码连接串) | 中 | 检查器来源可辨 + 后续警示徽标;跨项目派生直接拒绝 |
| 快照回滚不重建容器 | 中 | 响应 hint 明示「重新部署后生效」 |
