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

### WS3 —— 已对齐 MAP 真实 wire 约定（2026-06-25 复核后修正）
- **更正前情**：初版 WS3 只做了「CDS 对自己」的 HMAC 自测（vitest + live 都用 CDS 自家约定，
  自洽通过），并不证明能跟 MAP 通。逐字节比对 MAP 侧（`prd-api PeerNodeService` /
  `AdminPeerNodesController`）后发现两个真实不兼容点，已修复：
  1. **空-body HMAC 约定**：CDS 原对空 body 用空串，MAP 用 `sha256("")=e3b0c4…`。GET ping/
     capabilities 因此签名不一致，MAP 配对后探活 ping 被判 401 → 回滚。已改 CDS 为无条件
     `sha256(rawBody)`（commit d73c64c1）。
  2. **handshake/confirm 应 404 而非 401**：MAP 发起方对单阶段 peer 依赖「confirm 返回 404」
     判定为 legacy peer 继续；CDS 原未放行该子路径被登录网关拦成 401 → MAP 取消配对。已放行
     整个 `/api/peer-sync/` 前缀（admin 除外）+ 显式 confirm/finalize 返 404、cancel 清半连接节点
     （commit 995d1b3b）。
- **已验证（CDS 侧，对 cds.miduo.org 实景）**：用**模拟 MAP 客户端约定**的脚本（4 阶段 + 404
  legacy fallback + `sha256("")` 空 body + MAP 握手字段）跑通 handshake→confirm(404)→ping(200)→
  capabilities(200)→export(200, 合法 bundle)，旧空串约定 ping=401、bad-sig=401。等价「MAP 客户端」级
  互通证明。vitest 锁定 confirm/finalize=404、cancel=200、空-body 用 MAP 约定。
- **仍未验证（需 MAP 实例）**：真实 MAP「同步中心」点击配对 CDS → pull → 报告落成 MAP 知识库。
  需 MAP 管理员操作 + 可达 MAP 后端；wire 已证通，剩下是 MAP 侧一次真人配对（走 legacy 单阶段路径）。

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
