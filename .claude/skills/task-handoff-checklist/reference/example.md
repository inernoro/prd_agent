# 完整示例：新增缺陷管理 Agent 后的交接清单

```markdown
# 任务交接清单

> **任务描述**: 新增缺陷管理 Agent，支持缺陷模板管理和缺陷提交
> **变更范围**: 42 个文件 | +3,200 / -120 行
> **涉及端**: 后端 / 管理后台

---

## 一、导航与入口变更

| 维度 | 状态 | 详情 |
|------|------|------|
| 管理后台路由 | ✅ 新增 | `/defect-agent/templates`, `/defect-agent/reports` |
| 管理后台菜单 | ✅ 新增 | 侧边栏 → "缺陷管理" 下新增"模板管理"和"缺陷列表" |
| API 端点 | ✅ 新增 | `POST/GET/PUT/DELETE /api/defect-agent/templates`, `POST /api/defect-agent/reports` |
| 桌面端入口 | ➖ 无变化 | |

**操作路径**:
1. 登录管理后台 → 侧边栏点击"缺陷管理"
2. 点击"模板管理" → 创建/编辑缺陷模板
3. 点击"缺陷列表" → 查看已提交的缺陷报告

---

## 二、文档沉淀

| 检查项 | 状态 | 说明 |
|--------|------|------|
| SRS | ⚠️ 需更新 | 需新增缺陷管理 API 契约 |
| PRD | ⚠️ 需更新 | 需新增功能描述和用户场景 |
| 数据字典 | ⚠️ 需更新 | 新增 defect_templates, defect_reports, defect_messages |
| 设计文档 | ✅ 已创建 | doc/20.defect-agent.md |
| CLAUDE.md 快照 | ⚠️ 需更新 | 功能注册表+集合清单 |

**待补文档**:
- [ ] rule.data-dictionary.md: 3 个新集合字段定义
- [ ] CLAUDE.md: 功能注册表+集合清单

---

## 三、规则与约定

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 新增 appKey | ✅ | `defect-agent`，Controller 硬编码 |
| 新增 AppCallerCode | ✅ | `defect-agent.analyze::intent` |
| 新增架构模式 | ➖ | 复用 Run/Worker |
| 新增 MongoDB 集合 | ✅ | defect_templates, defect_reports, defect_messages |
| 新增权限点 | ✅ | DefectAgent.Templates.Manage, DefectAgent.Reports.View |

---

## 四、流程变更

| 检查项 | 状态 | 影响范围 |
|--------|------|----------|
| Breaking Change | ➖ | 全部新增，不影响现有 |
| 权限变更 | ✅ | 管理员默认拥有，其他角色需手动分配 |
| 其他 | ➖ | |

---

## 五、测试计划

| 类型 | 状态 | 说明 |
|------|------|------|
| 单元测试 | ✅ 完成 | DefectAgentTests (25 tests) |
| 冒烟测试 | ⚠️ 未完成 | 模板 CRUD + 缺陷提交 |
| 页面测试 | ⚠️ 需人工 | 模板管理页 + 缺陷列表页 |

**顺序**: 单元测试 → `/smoke defect-agent` → 页面手动验证 → 权限测试

**技能串联**:
- [ ] `/smoke defect-agent` → 冒烟测试
- [ ] `/verify` → 多角度验证

---

## 六、注意事项与风险

- **已知限制**: 缺陷消息暂不支持图片附件（v2 迭代）
- **依赖项**: LLM Gateway 可用（意图识别）

---

## 七、代码质量自检

| 检查项 | 状态 |
|--------|------|
| 编译通过 | ✅ |
| 前端构建 | ✅ |
| TypeScript | ✅ |
| 架构合规 | ✅ Controller 硬编码 appKey / ILlmGateway / 服务器权威性 |

---

## 八、后续事项

| 事项 | 优先级 | 说明 |
|------|--------|------|
| 更新数据字典 | P1 | 3 个新集合字段定义 |
| 缺陷消息支持图片 | P2 | v2 迭代 |

---

**交接时间**: 2026-02-27 14:30 | **交接人**: AI Assistant
```
