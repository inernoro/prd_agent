# prd-agent 平台杂项 · 债务台账

> **版本**：v1.3 | **日期**：2026-08-14 | **状态**：开发中

**一句话**：prd-agent 平台级、不属于某个具体 Agent 的债务合集，当前一条待办：管理员为他人上传头像未做内容哈希对象键，仍有 CDN 缓存陈旧风险。
**谁该读**：接手 prd-admin 头像编辑器或后台头像生成任务的工程师；做 entropy-cleanup D6 文档覆盖核对的人。
**读完能做什么**：知道「管理员改他人头像」这条路径的 CDN 缓存坑还没修，补的时候直接照抄自服务路径的对象键方案。

---

## 总览

当前 open: 1 / in-progress: 0 / paid: 1 / 总计: 2

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-08-13-avatar-editor-no-design-doc | low | 2026-08-13 | `changelogs/2026-08-11_stable-smoke-runtime-equivalence.md`（406 行，跨 prd-api/prd-admin/llmgw/cds 多模块）里，除了已被 [design.platform.core-business-stability.md](./design.platform.core-business-stability.md) 覆盖的稳定冒烟框架部分，还包含一个完整的产品功能：点击本人头像打开沉浸式编辑器、AI 生成预览、后台任务化生成（浏览器断开不取消）、内容哈希版本化对象键防 CDN 缓存旧图、幂等重试与并发清理等。这部分目前在 `doc/` 下没有任何 design 文档覆盖 | entropy-cleanup PR #1367 review（Codex）指出：把一个跨多模块的巨型聚合一次性标记 D6 处理，会让后续扫描永久跳过它，从而永久隐藏这个真实存在的文档缺口 | paid | 2026-08-14 核对结论（逐模块，登记前置条件已满足）：① **头像编辑器**——新建 [doc/design.prd-agent.avatar-editor.md](./design.prd-agent.avatar-editor.md)，覆盖沉浸式编辑器、AI 预览确认后落地、后台任务化、内容哈希对象键四点决策，本条缺口已补齐；② **stable-smoke 框架**（合成 SSO 登录/双环境报告/执行覆盖账本/生产只读熔断等）——已被 [design.platform.core-business-stability.md](./design.platform.core-business-stability.md) 与 [plan.platform.core-business-stability.md](./plan.platform.core-business-stability.md) 的现状快照覆盖，不重复新增；③ **Offering 健康隔离**——已被 [design.platform.llm-gateway.md](./design.platform.llm-gateway.md) §五/§六（错误分层、故障隔离）覆盖；④ **视频/ASR 任务部署归属**——落在跨项目隔离规则已登记的部署作用域模式，不属于 design 文档范畴，故不新增；⑤ 用户可读错误分层——是工程规则而非产品设计，已存在于架构规则集，不属于 design 覆盖对象。五类均已核实，无遗留缺口，changelog 现已登记进 `changelogs/.entropy-manifest.yml` |
| 2026-08-14-admin-avatar-upload-fixed-filename-cdn-staleness | low | 2026-08-14 | 管理员为他人上传头像（`UsersController` 的 `/api/users/{userId}/avatar/upload`）用固定对象键 `{用户名}.{扩展名}` 覆盖写，不带内容哈希；本人自服务的直传与 AI 生成两条路径（`ProfileController`）已改用内容哈希对象键规避 CDN 边缘节点缓存旧图的问题，管理员路径未跟进 | 撰写 [design.prd-agent.avatar-editor.md](./design.prd-agent.avatar-editor.md) 时核对两条路径代码发现的既有差异，非本次改动引入 | open | 补法：管理员路径复用自服务路径同一套内容哈希对象键 + 旧对象回收逻辑；改动前确认是否有下游依赖「头像文件名固定为 `{用户名}.{扩展名}`」这个约定（如需要按用户名反查文件的场景），避免改坏兼容性 |
