<!--
PR 标准格式（本系统所有 PR 的 SSOT）。任何人 / 任何 Agent 新建 PR 都按本模板填写。
GitHub 网页或 `gh pr create` 新建 PR 时会自动用本文件预填描述框。
规则见 CLAUDE.md §5.4。约束：禁止 emoji（CLAUDE.md §0）；禁止只留标题不填正文；改动 diff 禁止只写一行。
提交前删除本段注释与用不到的占位行。
-->

## 摘要
<!-- 1-3 句：本 PR 解决什么问题、用什么方案。 -->


## 改动 diff
<!-- 按 后端(prd-api) / 前端(prd-admin) / 桌面(prd-desktop) / 视频(prd-video) / CDS / 文档 分组；
     每条「文件或模块：一句话变更说明」。禁止只写一行。 -->
- `路径或模块`：变更说明


## 测试
<!-- 勾选实际跑过的；无关项删除。需人工验收时贴预览地址（走 `python3 .claude/skills/cds/cli/cdscli.py --human preview-url`，禁手拼）。 -->
- [ ] 后端 `dotnet build` / CDS 远端编译通过（零 `error CS`）—— 有 `.cs` 改动时
- [ ] 前端 `pnpm tsc --noEmit` + `pnpm lint`（本次改动文件零新增告警）—— 有 `.ts/.tsx` 改动时
- [ ] 单元 / 集成测试通过（`dotnet test` / `pnpm test`）—— 有相应套件时
- [ ] 真人通过预览域名验收：<预览地址>


## 风险与已知边界
<!-- 数据破坏性 / Breaking Change / 迁移注意 / 已知限制 / 回滚方案。无则写「无」。 -->
- 无


## 后续事项
<!-- 本 PR 未做、留待后续的项（带优先级）。无则删除本段。 -->
