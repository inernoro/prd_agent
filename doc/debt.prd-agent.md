# prd-agent 平台杂项 · 债务台账

> **版本**：v1.1 | **日期**：2026-08-13 | **状态**：开发中

**一句话**：prd-agent 平台级、不属于某个具体 Agent 的债务合集，目前只有一条：头像编辑器缺 design 文档。
**谁该读**：接手 prd-admin 头像编辑器或后台头像生成任务的工程师；做 entropy-cleanup D6 文档覆盖核对的人。
**读完能做什么**：知道头像编辑器功能缺设计文档，不会误以为已有覆盖；补文档时知道要看哪份 changelog 取史料。

---

## 总览

当前 open: 1 / in-progress: 0 / paid: 0 / 总计: 1

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-08-13-avatar-editor-no-design-doc | low | 2026-08-13 | `changelogs/2026-08-11_stable-smoke-runtime-equivalence.md`（406 行，跨 prd-api/prd-admin/llmgw/cds 多模块）里，除了已被 [design.platform.core-business-stability.md](./design.platform.core-business-stability.md) 覆盖的稳定冒烟框架部分，还包含一个完整的产品功能：点击本人头像打开沉浸式编辑器、AI 生成预览、后台任务化生成（浏览器断开不取消）、内容哈希版本化对象键防 CDN 缓存旧图、幂等重试与并发清理等。这部分目前在 `doc/` 下没有任何 design 文档覆盖 | entropy-cleanup PR #1367 review（Codex）指出：把一个跨多模块的巨型聚合一次性标记 D6 处理，会让后续扫描永久跳过它，从而永久隐藏这个真实存在的文档缺口 | open | 该 changelog **未被**登记进 `changelogs/.entropy-manifest.yml`，会在后续 D6 扫描中继续出现。同时该 changelog 的其余模块（ASR/视频任务归属/生图 Offering 路由/stable-smoke 报告结构等）也未逐一核对过覆盖情况，本次只核实了头像编辑器这一处明显缺口。补法：① 新建 `doc/design.prd-agent.avatar-editor.md`（或并入既有账户/个人设置 design 文档），覆盖为什么需要沉浸式编辑器、AI 生成预览确认前不落地的产品决策、后台任务化原因、内容哈希对象键取舍；② 补齐头像编辑器的 design 文档不等于可以登记整条 changelog——须先核对其余模块覆盖情况（或把该 changelog 拆分成多条分别登记），核对结论要写进登记说明，不要静默勾掉 |
