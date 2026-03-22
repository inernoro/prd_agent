---
globs: ["prd-api/src/**/Enums/**/*.cs", "prd-api/src/**/Models/**/*.cs", "prd-admin/src/types/**/*.ts", "prd-desktop/src/types/**/*.ts"]
---

# 枚举/常量扩展涟漪审计

当枚举（enum）、联合类型（union type）、常量注册表（registry/map）的成员数量发生变化时，必须全栈审计所有消费点，防止遗漏。

> **根因案例**：`UserRole` 从 4 值扩展到 12 值，后端 enum 已更新，但前端 3 处类型定义、2 处后端硬编码标签映射、1 处仪表盘统计、1 处图标引用均未同步，共 12 处遗漏。

## 触发条件

以下任一变更发生时，**必须**执行涟漪审计：

| 变更类型 | 示例 |
|----------|------|
| 后端 enum 新增/删除成员 | `UserRole` 新增 `HR`, `FINANCE` |
| 前端 union type 新增/删除成员 | `type Role = 'PM' \| 'DEV' \| ...` |
| 常量注册表新增/删除 key | `ROLE_META`, `CONFIG_TYPE_REGISTRY` |
| switch/match 分支扩展 | 新增 case 分支 |

## 审计清单（6 层涟漪）

### 第 1 层：类型定义同步

- [ ] Grep 枚举名（如 `UserRole`）在**全部子项目**中的类型定义
- [ ] 确认后端 enum、前端 union type、桌面端类型、API 契约类型**成员数一致**
- [ ] 检查 `contracts/`、`types/`、`stores/` 中的内联类型字面量

### 第 2 层：映射表/注册表完整性

- [ ] Grep 枚举成员的**中文标签映射**（如 `switch(role)` → 中文名）
- [ ] Grep **图标/颜色/样式映射**（如 `ROLE_META`、`ROLE_COLORS`）
- [ ] 确认每个新成员都有对应的映射条目
- [ ] 验证图标/组件引用**实际存在**于依赖包中（如 lucide-react 图标名）

### 第 3 层：硬编码过滤/统计

- [ ] Grep 旧成员的**硬编码列表**（如 `new[] { "PM", "DEV", "QA", "ADMIN" }`）
- [ ] 检查仪表盘/统计/报表中按枚举值分组的查询
- [ ] 检查错误提示中列举的合法值列表

### 第 4 层：序列化/反序列化

- [ ] 确认 JSON 序列化器能处理新成员（`JsonStringEnumConverter` 等）
- [ ] 检查 MongoDB 文档中已有数据是否与新 enum 兼容
- [ ] 确认前端 fallback 逻辑能优雅处理未知值

### 第 5 层：Mock/测试数据

- [ ] 更新 mock 数据文件中的示例值
- [ ] 更新单元测试中的枚举遍历断言
- [ ] 更新 Seed 数据或初始化脚本

### 第 6 层：文档/提示

- [ ] 更新 API 文档中的枚举值列表
- [ ] 更新用户提示文案中引用的合法值
- [ ] 更新 `codebase-snapshot.md` 中的相关描述

## 快速审计命令

```bash
# 以 UserRole 为例，替换为实际枚举名
ENUM_NAME="UserRole"

# 第 1 层：找所有类型定义
grep -rn "$ENUM_NAME" --include="*.cs" --include="*.ts" --include="*.tsx" | grep -iE "enum|type|interface"

# 第 2 层：找映射表
grep -rn "role" --include="*.ts" --include="*.tsx" --include="*.cs" | grep -iE "label|icon|color|display|中文|tag"

# 第 3 层：找硬编码列表（旧成员名）
grep -rn "'PM'\|'DEV'\|'QA'\|'ADMIN'" --include="*.ts" --include="*.tsx" --include="*.cs"
```

## 设计原则

- **全栈一致**：enum 定义在后端是权威源，前端/桌面端类型必须同步
- **映射完备**：每个枚举成员必须在所有映射表中有对应条目
- **fallback 安全**：消费端必须有兜底逻辑，不能因未知值崩溃
- **禁止部分更新**：不允许"先改后端，前端下次再说"——必须一次性完成全栈同步
