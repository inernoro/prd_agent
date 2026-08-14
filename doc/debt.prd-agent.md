# prd-agent 平台杂项 · 债务台账

> **版本**：v1.4 | **日期**：2026-08-14 | **状态**：开发中

**一句话**：prd-agent 平台级、不属于某个具体 Agent 的债务合集，当前两条待办：头像上传对象键、AI 生成任务跨会话找不回。
**谁该读**：接手 prd-admin 头像编辑器或后台头像生成任务的工程师；做 entropy-cleanup D6 文档覆盖核对的人。
**读完能做什么**：知道「管理员改他人头像」的 CDN 缓存坑与「关浏览器后 AI 头像生成结果找不回」这两个已知边界，补的时候有现成核对结论可参考。

---

## 总览

当前 open: 2 / in-progress: 0 / paid: 1 / 总计: 3

## 债务列表

| ID | 严重度 | 创建日期 | 描述 | 触发条件 | 状态 | 备注 |
|----|--------|---------|------|---------|------|------|
| 2026-08-13-avatar-editor-no-design-doc | low | 2026-08-13 | `changelogs/2026-08-11_stable-smoke-runtime-equivalence.md`（406 行，跨 prd-api/prd-admin/llmgw/cds 多模块）里，除了已被 [design.platform.core-business-stability.md](./design.platform.core-business-stability.md) 覆盖的稳定冒烟框架部分，还包含一个完整的产品功能：点击本人头像打开沉浸式编辑器、AI 生成预览、后台任务化生成（浏览器断开不取消）、内容哈希版本化对象键防 CDN 缓存旧图、幂等重试与并发清理等。这部分目前在 `doc/` 下没有任何 design 文档覆盖 | entropy-cleanup PR #1367 review（Codex）指出：把一个跨多模块的巨型聚合一次性标记 D6 处理，会让后续扫描永久跳过它，从而永久隐藏这个真实存在的文档缺口 | paid | 2026-08-14 核对结论（逐模块，登记前置条件已满足）：① **头像编辑器**——新建 [doc/design.prd-agent.avatar-editor.md](./design.prd-agent.avatar-editor.md)，覆盖沉浸式编辑器、AI 预览确认后落地、后台任务化、内容哈希对象键四点决策，本条缺口已补齐；② **stable-smoke 框架**（合成 SSO 登录/双环境报告/执行覆盖账本/生产只读熔断等）——已被 [design.platform.core-business-stability.md](./design.platform.core-business-stability.md) 与 [plan.platform.core-business-stability.md](./plan.platform.core-business-stability.md) 的现状快照覆盖，不重复新增；③ **Offering 健康隔离**——已被 [design.platform.llm-gateway.md](./design.platform.llm-gateway.md) §五/§六（错误分层、故障隔离）覆盖；④ **视频/ASR 任务部署归属**——落在跨项目隔离规则已登记的部署作用域模式，不属于 design 文档范畴，故不新增；⑤ 用户可读错误分层——是工程规则而非产品设计，已存在于架构规则集，不属于 design 覆盖对象。五类均已核实，无遗留缺口，changelog 现已登记进 `changelogs/.entropy-manifest.yml` |
| 2026-08-14-admin-avatar-upload-fixed-filename-cdn-staleness | low | 2026-08-14 | 管理员为他人上传头像走的是固定对象键（用户名+扩展名）覆盖写，不带内容哈希；本人自服务的直传与 AI 生成两条路径已改用内容哈希对象键规避 CDN 边缘节点缓存旧图的问题，管理员路径未跟进，理论上仍会出现「后台换好了、别人看到的还是老头像」 | 撰写头像编辑器设计文档时核对两条路径代码发现的既有差异，非本次改动引入 | open | 补法：管理员路径改用与自服务路径相同的内容哈希对象键方案 + 旧对象回收逻辑；改动前确认是否有下游依赖「头像文件名固定为用户名」这个约定（如需要按用户名反查文件的场景），避免改坏兼容性 |
| 2026-08-14-avatar-ai-generation-no-cross-session-recovery | low | 2026-08-14 | AI 生成头像的任务号只存在浏览器 `sessionStorage`，服务端只有按任务号查询的端点、没有「查当前用户最新任务」的端点。用户提交生成后关闭浏览器，任务在服务端跑完了，但重新打开编辑器时无从得知这次生成的结果，只能再发起一次——已完成的这次生成实际上被浪费 | entropy-cleanup PR #1372 review（Codex）连续两轮指出：先是「不能宣称任何时候都能恢复进度」，随后进一步指出这与「不会浪费生成额度」的说法自相矛盾 | open | 补一个「查当前用户最近一次头像生成任务」的端点，前端在任务号丢失时用它兜底找回；或至少在关闭前提示用户「本次生成完成前请勿关闭页面，否则需要重新生成」 |
