# CDS compose 模板 TODO secrets · 债务台账

> **版本**：v0.1 | **日期**：2026-05-18 | **状态**：open / 待规划

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 1 |
| in-progress | 1 |
| paid | 0 |

模块范围：仓库根 `cds-compose.yml` 的 `x-cds-env` 段 + admin profile readiness 配置，以及任何走 `cdscli import` 的全量 compose 重导入路径。

## 背景

`cds-compose.yml` 头部注释写明"由 /cds-scan 自动生成、粘贴导入"，其 `x-cds-env` 段把
`JWT_SECRET` / `AI_ACCESS_KEY` / `TENCENT_COS_*` 等敏感键以 `TODO: 请填写实际值`
占位符形式保留在仓库里。但这些密钥的**真实值已存在于 CDS env scope `prd-agent`**
（`cdscli env get --scope prd-agent` 可见 23 个键，含全部真实 secret）。

后果：任何 `cdscli import --project prd-agent --compose cds-compose.yml` 全量重导入
都会被 CDS 审核**拒绝**，理由 "reject stale cdscli import with TODO secrets;
unblock deploy"——因为全量导入会用 TODO 占位覆盖线上真实密钥。这条路径对该项目
结构性失效。

2026-05-18 发现链路：admin profile 因 static 模式每次 `pnpm install + vite build`
（重型依赖冷构建实测 ~614s）撞 `cds.readiness-timeout: 600` 上限，必现"就绪探测
超时：容器已启动但端口未在超时时间内响应"。修复需把 readiness-timeout 提到 1200，
但该改动**无法经全量 import 落地**（被上述规则拒），最终由 CDS 管理者在 dashboard
直接改 profile 配置。

## 债务条目

### D1（in-progress，波4 代码层已偿还）cds-compose.yml 的 x-cds-env 携带 TODO secrets，全量 import 必被拒

- 现状（2026-07-06 波4 更新）：**repo `cds-compose.yml` 的 `x-cds-env` 已剥离全部
  TODO 密钥键**（`TENCENT_COS_*` / `JWT_SECRET` / `ApiKeyCrypto__Secret` /
  `AI_ACCESS_KEY`），只保留非密钥结构默认（`ASSETS_PROVIDER` / `TENCENT_COS_PREFIX`）。
  剥离后 `parseCdsCompose` 仍解析出全部 5 个 profile + 2 个 infra，`envVars` 里
  零密钥、零 `TODO:` 占位 → 全量 import 不再有可覆盖线上密钥的占位值，D1 的
  import-reject 根因（占位覆盖真实密钥）在代码层消除。
- 配套能力：`config-authority.classifyEnvSeed` 给每个 env 键判「repo 结构种子 /
  CDS env scope」；`compose-drift.computeComposeDrift` + `POST /projects/:id/
  compose-drift-scan` 做 repo→CDS 单向漂移巡检，密钥若再次混入 repo 会被
  `secretsInRepo` 标为「应剥离」违规。
- **仍 open 的最后一环（隔离穿透高风险，需 CDS 管理者确认）**：必须在**运行实例**上
  验证 CDS env scope `prd-agent` 确实把这 6 个密钥注入到容器（`cdscli env get
  --scope prd-agent` 应见真实值 + 部署后容器内变量非空），确认剥离后注入不丢，
  才能把 D1 判为 **paid**。此步依赖对生产实例的读权限，AI 无法自闭环，见
  `.claude/rules/cross-project-isolation.md` 通道 1/2（共享密钥通道）。在该验证
  通过前，D1 记为 in-progress，禁止声称「已彻底偿还」。

### D2（open）admin static 模式每次部署全量 vite build，就绪窗口长期紧绷

- 现状：readiness-timeout 已（拟）提到 1200s 作为缓冲，但根因是每次部署冷构建
  重型前端（mermaid/katex/cytoscape）耗时数百秒
- 影响：每次部署到就绪要等十几分钟，UX 差；构建再变重会再次撞顶
- 偿还方向：评估 admin 改用 dev(Vite HMR) 预览模式（端口秒起，按需编译），或
  引入预构建产物 / 构建缓存层 / manualChunks 拆包降低冷构建时长

## 关联

- `cds-compose.yml`、`.claude/skills/cds/` cdscli、`.claude/rules/cds-auto-deploy.md`
- 触发本台账的会话：涌现 UI 重构分支 `claude/redesign-ui-layout-awNDL` 部署排查
