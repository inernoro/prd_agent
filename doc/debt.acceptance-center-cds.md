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

### 验收报告重复归档 —— 去重键含分钟级时间戳，重跑必然撞不上（2026-08-02 定位）
- **现象**：同一件事在验收中心留下多条报告。W30 周报点名一次（07-19、07-23 各两份内容相同），
  W31 复发且更密：07-27 缺陷复测 2 份内容相同、07-31 Commit 验收 2 份内容相同、
  07-29 每日巡检 3 份（原版 fail + 「结论修订版」+ 「规则合并后结论重算」）。
- **业务影响**：**通过率这个数字本身失真**。W31 共 16 份验收里 11 份 conditional，其中 6 份属于
  3 组重复/重验簇；分母被重复条目撑大，读者无法判断「有条件通过变多」是质量真的变差还是
  同一件事被记了三遍。质量闸是老板判断「该不该介入」的唯一依据，分母不可信＝整张表不可信。
- **根因**：报告的去重键（归档脚本生成的 report id，也就是元数据里那个声明为「跨环境同步幂等」的字段）
  由「项目 + **归档时刻的分钟级时间戳** + 目标名」拼成。时间戳每次归档都不同，两次归档只要相隔
  1 分钟，键必不相同 → **这条去重从落地那天起就对「重跑同一目标」不设防**：它能防的只有
  同一分钟内的重复写入，而真实的重复归档全都发生在几分钟到几小时之后。
  属「判据与接线纪律」形状 1（判据太窄：身份键里混进了每次都变的成分）叠形状 6
  （判据读的不是真正决定身份的那个值）。
- **为什么不在本次直接改**：正确的身份键不是显然的，改错会造成更坏的后果。至少三种语义要先定：
  1. **纯重复**（内容相同、结论相同，如 07-27 / 07-31 那两组）—— 应当原地更新，不该新增；
  2. **重验且结论变了**（07-29 的 fail → 修订版 → 重算）—— 新结论应当**取代**旧结论进入统计，
     但旧报告作为审计痕迹可能需要保留，那就要引入「supersededBy / 只有最新版计入 tally」的概念；
  3. **修完缺陷后的合法复测** —— 必须是一条**新**报告，绝不能被去重吃掉。
  这三种今天在数据里长得一模一样（同 target、同日、同 project），单靠 id 方案分不开；
  且 reportId 同时是 CDS 报告深链的一部分，改 id 形态会动既有链接与跨环境同步幂等。
  这是设计决策，不是小修，故本次只定位不动刀。
- **关闭动作**：给验收报告定义显式身份与版本语义（建议：`身份键 = project + target + 冻结 SHA`，
  同身份重跑走 `version+1` 原地更新或标 `supersededBy`，**tally 只计每个身份的最新版**），
  并补一条守卫测试：同一目标连跑两次归档，验收中心里必须只增加一条（或只有最新版计入通过率）。
  没有这条守卫，去重逻辑「删掉也不会红」，会再次静默漂移。
- **在此之前的止血**：归档前先在验收中心搜同 target + 同日报告；发现重复立即合并或删除，
  并在周报质量闸里显式标注「本周 N 份为重复归档，已从通过率分母剔除」，不要让失真的数字裸奔。

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
| 重复归档去重键 | `.claude/skills/create-visual-test-to-kb/scripts/archive_report.py`（report id 拼装在 `main` 末尾；`entry_meta.reportId` 的幂等声明在 `run_doc_store`） |
