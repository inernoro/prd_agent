# CDS compose 模板 TODO secrets · 债务台账

> **版本**：v0.1 | **日期**：2026-05-18 | **状态**：open / 待规划

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 2 |
| in-progress | 0 |
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

### D1（open）cds-compose.yml 的 x-cds-env 携带 TODO secrets，全量 import 必被拒

- 现状：仓库 compose 模板与 CDS env scope 双写 secret，模板侧是 TODO 占位
- 影响：所有结构性 compose 变更（profile 命令 / readiness / 新增服务）无法经
  `cdscli import` 落地，必须 CDS 管理者手动 dashboard 操作
- 偿还方向：把 `x-cds-env` 中已由 CDS env scope 管理的 secret 键移除（compose
  只保留结构，不再声明 secret），使全量 import 不再覆盖线上密钥即可通过审核。
  需先验证 CDS「env scope 注入」与「compose x-cds-env」的优先级语义，确认移除
  后注入不丢，再改 + 重导入。属于共享基建改动，需 CDS 管理者确认。

### D2（open）admin static 模式每次部署全量 vite build，就绪窗口长期紧绷

- 现状：readiness-timeout 已（拟）提到 1200s 作为缓冲，但根因是每次部署冷构建
  重型前端（mermaid/katex/cytoscape）耗时数百秒
- 影响：每次部署到就绪要等十几分钟，UX 差；构建再变重会再次撞顶
- 偿还方向：评估 admin 改用 dev(Vite HMR) 预览模式（端口秒起，按需编译），或
  引入预构建产物 / 构建缓存层 / manualChunks 拆包降低冷构建时长

## 关联

- `cds-compose.yml`、`.claude/skills/cds/` cdscli、`.claude/rules/cds-auto-deploy.md`
- 触发本台账的会话：涌现 UI 重构分支 `claude/redesign-ui-layout-awNDL` 部署排查
