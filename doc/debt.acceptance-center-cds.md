# debt.acceptance-center-cds

> 工程债务台账：CDS 验收中心统一（WS1/WS2/WS3 + E1/E2/E4/E6，2026-06-25）的已知边界与后续可补项。
> 状态：active

## 背景

验收体系统一定调（用户 2026-06-25）：验收能力归 CDS（平台自带、按项目分类、证据链内置），
MAP 等系统通过知识库开放协议（MAP-KBTP v1 peer-sync）从 CDS 拉取展示。技能不再分流到 MAP 知识库。

## 已知边界（交付时主动声明）

### WS3 peer-sync —— item 枚举靠对端提供 itemId
- MAP-KBTP v1 的 6 个端点（handshake/ping/capabilities/signature/export/apply）**不含「列举 item」端点**
  （与 prd-api 的 PeerSyncController 一致）。CDS 把每个项目（及全局）的验收报告集合暴露为一个
  `document-store` item，**itemId = CDS 项目 id**（全局报告用 `__cds_global__`）。
- 因此 MAP 侧拉取时需由管理员**填入要拉的 itemId（项目 id）**。capabilities 只广告资源类型，不枚举 item。
- 后续可补：若需 MAP 自动发现 CDS 全部项目，需在协议外加一个「列举 items」端点（非标准，需 MAP 配合）。

### WS3 —— 端到端 MAP pull 未在 CDS 侧 E2E 验证
- 已验证：CDS 侧 **wire 契约**（`tests/routes/peer-sync.test.ts` 用真实 HMAC 走通
  handshake→ping→capabilities→signature→export 全链 + 负例）。
- 未验证：真实 MAP「同步中心」配对 CDS → pull → 报告落成 MAP 知识库。这需要 MAP 管理员操作 +
  MAP 实例，CDS 侧无法自测。交付后需在 MAP 侧做一次真人配对验证。

### WS3 —— 导出 bundle 大小无分页
- 协议 export 是**整 item 一次性返回**（与 MAP 的 document-store 导出同构）。一个项目若有很多
  大 HTML 报告（内联 base64 截图，单份可达 10MB），export 响应可能很大（数十 MB）。
- 当前不分页、不裁剪（保全证据）。后续可补：per-record content 上限 / 把大截图转附件 URL（需 CDS 出对象存储）。

### E4 验收回写 PR —— 依赖部署上下文齐全
- PR 评论需 `prNumber` + 项目已 link GitHub（githubRepoFullName + githubInstallationId）。
- check-run（PR Checks 面板「验收绿/红」）额外需 `commitSha`；缺则只发评论并在 warnings 里说明。
- 二者均 best-effort：失败项进 `warnings`，只要评论或 check-run 有一个成功即算回写成功。

### E6 匿名分享 —— 登录态门控的补充
- `/r/<token>` 用 128-bit 随机 token 自鉴权、可撤销、不经登录网关，沿用 `/raw` 的 sandbox CSP
  安全模型（唯一 origin、禁 same-origin）。撤销后立即 404，不区分「token 错」与「已撤销」防探测。

### WS2 —— doc-store 旧路径降级为非默认
- `archive_report.py` 默认 `mode=cds`；`local` 离线兜底；`doc-store`（旧 MAP 知识库）仅当 config
  显式保留 `mode=doc-store` + 补回 MAP 字段（apiBasePath/storeName/templateKey/auth.api）才走。
- `acceptance.config.json` 已移除 MAP 字段；新仓库不要用 doc-store 路径。

## 关键文件
- `cds/src/routes/peer-sync.ts`、`cds/src/routes/reports.ts`、`cds/src/services/state.ts`、`cds/src/server.ts`
- `cds/tests/routes/peer-sync.test.ts`、`cds/tests/services/acceptance-reports.test.ts`
- `.claude/skills/create-visual-test-to-kb/{scripts/archive_report.py,acceptance.config.json,SKILL.md}`
- `.claude/skills/cds/cli/cdscli.py`（report / peer 命令）
