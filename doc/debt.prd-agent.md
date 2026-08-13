# prd-agent 平台杂项 · 债务台账

> **版本**：v1.0 | **日期**：2026-08-13 | **状态**：规划中

**一句话**：prd-agent 平台级、不属于某个具体 Agent 的债务合集，目前只有一条：头像编辑器缺 design 文档。
**谁该读**：接手 prd-admin 头像编辑器或后台头像生成任务的工程师；做 entropy-cleanup D6 文档覆盖核对的人。
**读完能做什么**：知道头像编辑器功能缺设计文档，不会误以为已有覆盖；补文档时知道要看哪份 changelog 取史料。

---

## 头像编辑器缺 design 文档

### 缺口是什么

`changelogs/2026-08-11_stable-smoke-runtime-equivalence.md`（406 行，跨 prd-api/prd-admin/llmgw/cds 多模块）里，除了已被 [design.platform.core-business-stability.md](./design.platform.core-business-stability.md) 覆盖的稳定冒烟框架部分，还包含一个完整的产品功能：点击本人头像打开沉浸式编辑器、AI 生成预览、后台任务化生成（浏览器断开不取消）、内容哈希版本化对象键防 CDN 缓存旧图、幂等重试与并发清理等。这部分目前在 `doc/` 下没有任何 design 文档覆盖。

2026-08-13 entropy-cleanup 自动化 PR #1367 曾打算把该 changelog 整体标记为 D6「已处理」，被 Codex 审查指出：把一个跨多模块的巨型聚合一次性标记处理，会让后续 D6 扫描永久跳过它，从而永久隐藏这个真实存在的文档缺口。因此该 changelog **未被**登记进 `changelogs/.entropy-manifest.yml`，会在后续 D6 扫描中继续出现，直到本条描述的缺口被补上或该 changelog 被拆分处理。

### 已知边界

| # | 事项 | 说明 |
|---|---|---|
| 1 | 头像编辑器无 design 文档 | 沉浸式编辑器交互、AI 生成预览确认流程、后台任务状态机、内容哈希对象键版本化策略均无文档记录，只能从 changelog 逐条还原 |
| 2 | 该 changelog 的其余模块也未逐一核对 | 406 行里除头像编辑器外，还有转写/ASR、视频任务归属、生图 Offering 路由、stable-smoke 报告结构等大量条目；本次只核实了头像编辑器这一处明显缺口，未逐条核对其余条目是否都已有覆盖 |
| 3 | D6 manifest 里该文件保持未处理 | 每次 entropy-cleanup 扫描都会重新报出这个 changelog，直到显式处理（拆分成多个 design 章节 + 登记，或确认覆盖已补齐） |

### 建议

- 新建 `doc/design.prd-agent.avatar-editor.md`（或并入某个既有的账户/个人设置 design 文档），覆盖：为什么需要沉浸式编辑器（同步生成体验差）、AI 生成预览确认前不落地的产品决策、后台任务化的原因（避免同步请求超时）、内容哈希对象键的取舍（防 CDN 脏缓存）。
- **补齐头像编辑器的 design 文档不等于可以登记整条 changelog**：只有在上表「事项 2」描述的其余模块（ASR/视频归属/生图 Offering 路由/stable-smoke 报告结构等）也逐一核对过覆盖情况后，才能把 `2026-08-11_stable-smoke-runtime-equivalence.md` 登记进 `changelogs/.entropy-manifest.yml`；核对结论（哪些已覆盖、哪些确认是无需 design 文档的纯 fix/test）要写进登记说明，不要静默勾掉。
- 若只想先解决头像编辑器这一处，也可以把该 changelog 拆分成多条更小的 changelog（每条对应一个模块）分别登记，而不是继续把整份 406 行当一个单元处理。
