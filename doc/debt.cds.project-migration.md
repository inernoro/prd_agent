# 项目迁移（CDS 项目移植）· 债务台账

> 状态：active | 模块：cds | 最后更新：2026-06-23
>
> CDS「项目设置 → 迁移」Tab：把一个 CDS 项目打包复刻到另一个 CDS 节点（配置 + 数据）。
> 本台账记录本次交付的已知边界与后续可补项，避免下一个 session 重复踩坑。

## 背景

用户反馈"以前 CDS 的一键导出可被其他平台复刻部署的配置功能不见了"。排查确认：
`CdsPeer` / `DataMigration` 类型、`state.ts` 的 CRUD、`server.ts` 的 `/data-migrations/*`
API label 都还在，但**路由处理器文件与前端 UI 早已丢失**——这就是"消失的功能"。本次
在既有底座上补回，并明确做成**项目级移植**：`cds/src/routes/project-migration.ts` +
`ProjectSettingsPage` 的「迁移」Tab。

## 已落地（2026-06-23）

- 迁移目标（远端 CDS 节点 = `CdsPeer`）增/删/列 + 连接测试（真实打远端 `/api/me`）。
  远端鉴权用目标自带 accessKey，留空回退本机 `AI_ACCESS_KEY`（同密钥跨节点场景，用户确认）。
- 配置复刻：导出本项目 `cds-compose`（复用 `toCdsCompose`，与 `/api/export-config?project=`
  同口径）→ 推送到目标 `/api/import-config`，支持 `dryRun` 预演 / `merge` / `replace-all`。
- 数据迁移：**只读扫描**（源库 MongoDB infra + 目标可达性）+ 手动桥接清单。
- 安全：accessKey 明文不出库到前端（只回 `hasKey` + 掩码）；`replace-all` 二次确认。
- 验证：unit test（脱敏/归一化/对外视图不泄密）+ Playwright 真机截图 + 对 `noroenrn.com`
  的真实 dry-run（远端 HTTP 200，`infraServices 新增1`）。

## 已知边界 / 后续可补

| # | 边界 | 说明 | 后续 |
|---|------|------|------|
| 1 | 数据全量落库未做成一键 | 全量库迁移走既有、已测的 `/api/infra/:id/backup`(mongodump) → 远端 `/api/infra/:id/restore`(mongorestore) 手动桥接；本路由只做只读扫描，不在本端点直接执行破坏性写入 | 后续可加"一键全量迁移"端点（流式 dump → 远端 restore + SSE 进度 + 强确认 + 目标快照回滚） |
| 2 | 远端无 dry-run 回滚预览 | `replicate-config` 的 dryRun 仅返回远端 import 预览，未做"复刻后一键回滚到迁移前快照"的反向链路 | 复用远端 ConfigSnapshot（import 前自动拍快照）暴露回滚入口 |
| 3 | accessKey 明文落 state | `CdsPeer.accessKey` 当前明文存 state（与既有设计一致）；留空走本机 key 时不落 | 评估是否走 `sealToken` 加密（参考 remote-hosts 的密文存储） |
| 4 | 仅 MongoDB 数据扫描 | data-plan 只识别 mongo infra；redis/postgres 未纳入迁移扫描 | 扩展到其它 infra 类型（infra-backup 已支持 redis/generic tar） |
| 5 | CDS 面板不可分支预览 | 该功能在 CDS 控制台（cds.miduo.org），非分支预览域名；视觉验收靠 headless 截图 + self-update 灰度 | 无（CDS 控制台架构使然） |
| 6 | 迁移仅限人类管理员（cookie/GitHub 会话） | PR #909 review（Codex P1 / Bugbot High）指出：迁移会跨节点并可能回退本机 bootstrap `AI_ACCESS_KEY` 鉴权远端，任何非人类调用方（项目级 Agent Key、AI 配对会话 `x-cds-ai-token`/`_aiSession`、全局 key、静态 AI_ACCESS_KEY）都能加攻击者控制 baseUrl 的 peer 诱导服务端外泄 bootstrap key。`guard()` 已改为 `isHumanAdmin = _cdsCookieAuth || (cdsUser && cdsSession)`，与 operator-console / remote-hosts 等系统级管理端一致（secret-revealing 须 cookie 鉴权）；AI / 各类 key 一律 403 | 若将来要支持 AI/项目级自助迁移，需把 CdsPeer 下沉为项目级资源 + 禁用 bootstrap-key 回退（强制每 peer 显式 key，杜绝外泄路径） |
| 7 | 远端 import 落到目标 legacy 项目 | 远端 `/api/import-config` 不带 projectId，导入的 infra/profile 落到目标的 legacy/default 项目，不会在目标建同名项目；故多项目目标上「复刻」语义不精确。已**移除 replace-all**（其为全局破坏，会清掉目标其它项目配置），强制 merge（纯新增/更新，不删存量） | 在远端加项目级 import 路径（`POST /api/projects/:id/import-config`），迁移时带目标 projectId 精确落库 |
| 8 | env 元数据（required/auto）不随迁移过去 | PR #909 Codex P2：迁移走 `toCdsCompose`，只序列化 env 的**值**（`x-cds-env`），不带 `envMeta`（哪些是 required/auto/infra-derived）。目标 import 后 `getMissingRequiredEnvKeys` 为空 → 不再弹「必填 env」提示，含空/TODO 必填值的项目在目标可能直接放行部署。**非本 PR 引入**：`/api/export-config`→`/api/import-config` 手动 round-trip 一直如此 | `toCdsCompose` 增 envMeta 参数并 emit `x-cds-env-meta`（parser 已支持解析）+ 远端 import-config 落 `setEnvMeta`。属共享序列化 + 远端契约改动，需跨同版本双端验证后单独做 |
| 9 | 无 command 的 build profile 迁移会被远端 400 | PR #909 Codex P2：`toCdsCompose` 只在 `p.command` truthy 时 emit command；而 `/build-profiles` 允许缺 command（归一为空串，依赖镜像 CMD/ENTRYPOINT）。这类项目导出的 YAML 没 command，远端 import-config 校验 `if (!p.command)` 直接 400，dry-run/apply 失败。**非本 PR 引入**：是 toCdsCompose↔import-config 共享 round-trip 的既有不一致 | 让 import-config 校验接受空 command（与 build-profiles 一致，归一空串=用镜像 CMD），或 toCdsCompose 显式 emit 空 command 标记。同属共享契约改动，需双端同版本验证 |

## 相关

- `cds/src/routes/project-migration.ts` —— 路由处理器
- `cds/web/src/pages/ProjectSettingsPage.tsx` —— `ProjectMigrationTab`
- `cds/src/routes/branches.ts` —— `/api/export-config` `/api/import-config`（复刻底座）
- `cds/src/routes/infra-backup.ts` —— mongodump/mongorestore（数据迁移底座）
- `doc/design.cds-data-migration.md` —— 原始数据迁移设计（本次校正"已落地"口径）
