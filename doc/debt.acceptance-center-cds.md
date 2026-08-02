# CDS 验收中心 · 债务台账

> **版本**：v1.0 | **日期**：2026-06-25 | **状态**：开发中

**一句话**：验收中心统一到平台自带之后，剩下的已知边界与后续可补项。
**谁该读**：接手验收中心的人；想知道某个能力为什么还没有的人。
**读完能做什么**：判断眼前的缺失是已知边界还是新问题。

---

> 工程债务台账：CDS 验收中心统一（WS1/WS2/WS3 + E1/E2/E4/E6，2026-06-25）的已知边界与后续可补项。

## 背景

验收体系统一定调（用户 2026-06-25）：验收能力归 CDS（平台自带、按项目分类、证据链内置），
MAP 等系统通过知识库开放协议（MAP-KBTP v1 peer-sync）从 CDS 拉取展示。技能不再分流到 MAP 知识库。

## 已知边界（交付时主动声明）

### 阻断缺陷播报与处理闭环 —— 状态机已落地，「按人指派」仍无根（2026-08-02）
- **已落地**：验收报告归档时若判定为阻断级（判定不通过 / 存在 P0 / 自称通过却带未决 P0-P1），
  CDS 发事件 → 记进站内信账本 → 按既有外发通道推给 MAP，并给出一步落到该报告的深链。
  归档脚本同时把 P0-P3 计数与逐行缺陷/根因证据随元数据上传（此前这些字段无人填写）。
  通知带**处理状态机**：待处理 / 处理中 / 已解决，状态持久化在服务端账本（换台机器仍在）。
- **仍然无根的那部分**：「按模块或项目自动路由到负责人」。CDS 的账号身份只在
  `CDS_AUTH_MODE=github` 与 ticket SSO 会话里成立，而标准部署是 basic 共享口令模式——
  请求上根本不挂用户，认领人恒为同一个值。项目也没有 owner 字段可供路由。
- **为什么状态机是主干、认领人只是可选快照**：若把「谁认领的」当主干，在开发机（有真名字）
  测起来一切正常，一上默认部署就变成「每条通知都被同一个身份认领」——界面看着有责任人，
  实际一个都没有，且不报错。那是把不成立的证据当成已做到的证明。故身份取不到时如实留空，
  前端明说「当前部署未启用账号身份，未记录责任人」，绝不回填一个桶名冒充。
- **关闭动作**：先补底座（项目 owner 字段或成员矩阵，且 basic 模式下也能识别人），
  再在状态机上叠加指派；在那之前不要在播报侧单独造一套只服务于验收的指派状态。

### 缺陷归因简报是确定性统计，不是 AI 归因（2026-08-02）
- **已落地**：报告中心「缺陷简报」按严重度分布 / 高频模块簇 / 根因结论分布聚合近期报告，
  每个数字都能点回具体报告。数据来自归档时上传的结构化缺陷行与根因行。
- **没做 AI 归因，因为 CDS 侧没有根**：CDS 进程内没有通用大模型通道——唯一出站路径是
  sidecar agent-session，硬门禁在「项目类型为共享服务 + 已部署 claude-sdk sidecar + 有效 key」，
  且形态是会话式 agent 而非批处理补全。在 CDS 里现造一个模型客户端会同时违反
  「所有 LLM 调用走 ILlmGateway」与无根之木禁令。
- **AI 归因应当落在 MAP 侧**：那边有 ILlmGateway、有库级 Run/Worker 先例，且已有
  报告镜像服务把 CDS 报告增量同步进知识库（早期记录的 peer-sync 内容拉取阻塞已被这条路绕过）。
  本轮补齐的结构化证据面正是 AI 版要消费的输入。
- **关闭动作**：在 MAP 侧按 Run/Worker 形态实现归因聚类，消费镜像过来的缺陷行；
  遵守 LLM 可视化要求（流式或进度反馈，不许空白等待）。

### P1-only 的验收结果刻意不告警（2026-08-02，取舍非缺陷）
- 判据刻意排除「有条件通过 + 若干 P1」：有条件通过本就意味着带着已知问题放行，结论与缺陷不矛盾，
  且这是每日验收的常态形状。把它算成阻断，铃会天天响到没人再看——与既有「网络抖动类失败不告警」同源取舍。
- 若日后发现 P1 长期积压无人处理，正确的补法是**周期性汇总**（例如按周统计未决 P1 趋势），
  而不是把单次归档改成阻断——后者只会把告警变成噪声。

### 冻结 commit 验收 —— 缺少不可变预览环境（2026-07-30）
- **目标要求**：每日验收需要按目标日结束时冻结的 commit 分别验证已合并、open PR 与未发布分支，测试对象不能被分支后续提交替换。
- **当前事实**：CDS 分支预览跟随分支当前 HEAD；当目标分支在目标日后继续推进时，现有预览不能证明历史冻结 SHA 的行为。
- **根因**：CDS 尚未提供“指定 project + commit SHA 创建不可变、隔离预览”的标准入口，也没有等价的历史快照复用接口。
- **证据影响**：当前 HEAD 冒烟通过只能证明当前版本健康，不能充当冻结 commit 的产品证据；对应范围必须标为 `unverifiable`，并列入未覆盖数量。
- **判定规则**：若没有观察到真实产品失败，单纯因冻结 SHA 无法复现只能给 `conditional`，不得把产品质量写成 FAIL；报告必须输出目标 SHA、实际测试 SHA、缺失能力与关闭动作的根因链条。
- **关闭动作**：CDS 增加 commit-pinned preview 或不可变快照复用能力，并让验收报告记录可核对的环境 ID、目标 SHA、部署 SHA。能力落地后补跑历史冻结范围，才可关闭该覆盖缺口。

### WS3 peer-sync —— 真实 MAP 配对已通；内容 pull 卡在 MAP 侧 item 映射（2026-06-25 实测）
- **真实配对成功**：用 MAP 管理员凭据登录真实 MAP（main-prd-agent.miduo.org）→ `POST /api/admin/peer-nodes`
  以 CDS 配对码 + `https://cds.miduo.org` 配对 → 返回 `status:connected`。证明 CDS 侧两处修复
  （空-body HMAC、handshake/confirm 返 404 走 MAP legacy 路径）在**真实 MAP 消费方**上端到端生效。
- **内容 pull 被 MAP 授权门挡住**：`POST /api/peer-sync/transfer`（PeerSyncController:515/530）要求每个 itemId
  必须出现在 actor 的**本地** `ListItemsAsync` 结果里。CDS 的 item key（`__cds_global__` / CDS 项目 id）
  在 MAP 没有对应的**本地知识库**，故 pull 返回「无权访问该条目（不在你的可访问范围内）」。
  即 MAP 的 document-store 传输是为 **MAPMAP 同 lineage** 设计的（两端共享 store id / lineage），
  CDS 用的是另一套 item 命名，首次「从 CDS 远端 item 新建本地库」不被现有 transfer 授权模型支持。
- **这是 MAP 侧的能力缺口，不是 CDS bug**。要让 CDS 报告真正落进 MAP 知识库，需 MAP 侧补一条
  「订阅/导入远端 item → 新建本地 store（itemId 对齐远端 key）」的路径，或放宽 pull 授权允许「目标库不存在时按远端 bundle 新建」。
- MAP-KBTP v1 的 6 端点仍**不含「列举 item」端点**：capabilities 只广告资源类型；itemId 需调用方填
  （CDS 项目 id，全局报告用 `__cds_global__`）。
- 现存状态：真实 MAP main 上留有一个指向 CDS 的 `connected` peer 节点（id `3baaaf67…`）+ CDS 侧的对端记录，
  待 MAP 侧补 item 映射后即可直接 pull；如不需要可在 MAP 同步中心或 CDS `cdscli peer revoke` 撤销。

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

### 报告内联 base64 截图 —— 已落地内容寻址对象存储（2026-06-26 修复）
- **更正前情**：报告正文历史上把截图以内联 `data:image;base64,...` 内嵌，既撑大正文，又会在被
  其它系统知识库拉取时把 base64 带进禁止 base64 的地方（用户原话：base64 只是当时没有对象存储的权宜）。
- **现状**：CDS 自带磁盘内容寻址对象存储（无外部 bucket/S3 SDK）。`POST /api/reports` 入库前归一化
  抽出 base64 → 存为 `report-assets/<sha256>.<ext>` → 正文改写为 `GET /api/reports/assets/:name`
  绝对 HTTPS 链接（公开只读、不可枚举、长缓存）。HTML/Markdown 通用。**CDS 报告正文不再携带 base64。**
- **MAP 侧叠加兜底**：`CdsReportImportService` 导入时再过 `DocumentStoreAssetNormalizer`，存量旧 base64
  报告在 MAP 端 Full 重导时一并清成 HTTPS 链接（用户保留自行触发）。
- 实现：`state.ts` writeReportAsset/readReportAsset、`routes/reports.ts` normalizeInlineImages + assets 路由、
  `server.ts` 登录网关放行 + API label。守卫测试 `acceptance-reports.test.ts` + `reports-access.test.ts`。

### WS3 —— 导出 bundle 大小无分页（CDS 侧已补分页，2026-07-09）
- 协议 export 是**整 item 一次性返回**（与 MAP 的 document-store 导出同构）。报告正文已不含 base64
  截图（改为外链资源，见上），单份显著变小；但一个项目报告很多时 export 响应仍可能偏大。
- **CDS 侧已落地**：export 接受可选 `limit`（1-500）/`cursor`（report id），按 `(createdAt, id)`
  稳定排序，响应带 `page:{nextCursor,hasMore,total}`；**不传参时响应逐字节兼容旧协议**；
  坏 cursor 返回 400。见 `cds/src/routes/peer-sync.ts`，单测 `peer-sync.test.ts`。
- **MAP 侧待接**：`CdsReportImportService` 目前仍整包拉取，需改为按 `nextCursor` 循环分页导入
  （不改协议，纯消费端升级）。per-record content 上限暂不做（保全证据）。

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
- `.claude/skills/create-visual-test-to-kb/{scripts/archive_report.py,acceptance.config.json,SKILL.md}`
- `.claude/skills/cds/cli/cdscli.py`（report / peer 命令）

---

## 实现来源

给要跳去看代码的人；只读这篇文档的人可以整块跳过。

| 位置 | 文件 |
|------|------|
| 关键文件 | `cds/src/routes/peer-sync.ts`、`cds/src/routes/reports.ts`、`cds/src/services/state.ts`、`cds/src/server.ts`、`cds/tests/routes/peer-sync.test.ts`、`cds/tests/services/acceptance-reports.test.ts` |
