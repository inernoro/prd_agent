# 海鲜市场开放接口产品化 · 计划

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：规划中

## 目标

完成 `AgentOpenEndpoint` 已有后端能力的管理端、市场展示、自助权限和真实 Agent 复测，使开放接口不再只能通过数据库或 API 手工维护。

## 已有事实

- Agent key、scope 校验、限流和审计已经落地。
- `AgentOpenEndpoint` CRUD、MCP 动态工具暴露和反向 scope 白名单已经落地。
- Endpoint 保存时会桥接 `referenceType=open-api-reference` 的 MarketplaceSkill；旧计划中的“自动桥接”不再是待办。
- 当前前端没有完整的 AgentOpenEndpoint 管理页，也未证明 MarketplaceCard 能正确展示开放接口引用。

## P1：管理员管理页

- 在现有开放平台或管理员设置中提供 Endpoint 列表、新建、编辑、停用和删除。
- 表单覆盖 agentKey、名称、说明、HTTP 方法、路径、requiredScopes、输入 schema、版本和启用状态。
- scope 必须从服务端允许列表选择，并显示调用身份与风险；前端校验不能替代后端授权。
- 保存后展示 MCP tool 名、市场引用状态和最后更新时间。

## P2：海鲜市场引用卡片

- `open-api-reference` 使用明确的“开放接口”类型，不冒充可下载 skill 包。
- 卡片展示来源 Agent、方法、路径、scope、版本和使用说明；主操作是查看接入方式或生成受限 key。
- Endpoint 停用或删除后，市场引用同步隐藏或失效，不保留可点击空壳。
- Fork、下载、评分等不适用动作必须禁用并解释原因。

## P3：Agent 自助权限

- 先定义哪些 Agent owner 可以登记或维护自己的 Endpoint，默认仍由管理员管理。
- owner 只能操作自身 agentKey 下的 Endpoint，不能扩大 requiredScopes 或修改其他 Agent 引用。
- 权限变更、启停和删除必须写审计日志；高风险 scope 需要额外审批。
- API key 创建只允许选择已登记 scope，删除 Endpoint 后不能继续签发新的同名权限。

## P4：真实复测

1. 管理员创建 Endpoint，市场出现对应引用卡片。
2. 创建只含该 scope 的 Agent key，通过 MCP tools/list 看到工具并成功调用。
3. 去掉 scope 后工具不可见；停用 Endpoint 后调用被拒绝。
4. 普通用户与非 owner 无法创建、编辑或删除 Endpoint。
5. 重复保存不会生成重复 MarketplaceSkill，删除和恢复行为一致。

## 完成标准

- 管理端、市场卡片、key scope 和 MCP 工具由同一 Endpoint 事实源驱动。
- 用户无需手工写数据库即可完成登记、授权、调用和停用。
- 所有越权、停用、删除和重复写入分支有自动化测试。
- 真人路径从市场入口开始，不以直接访问 API 或路由代替验收。

## 关联文档

- `doc/design.skill.marketplace-open-api.md`
- `doc/rule.platform.data-dictionary.md`
- `doc/rule.platform.app-caller-registry.md`
