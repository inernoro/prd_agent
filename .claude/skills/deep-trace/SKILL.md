---
name: deep-trace
description: Performs end-to-end cross-layer data flow tracing for untrusted code changes. Traces data from entry to exit across backend C#, Rust Tauri, and frontend React layers, verifying field names, types, serialization rules, and error handling at every seam. Trigger words: "/deep-trace", "深度追踪", "deep trace".
---

# Deep Trace - 跨层数据流深度追踪

对不信任的代码变更进行端到端穿透式验证，像探针一样追踪数据从入口到出口的完整链路，确保每一层的字段名、类型、序列化规则、异常处理都严丝合缝。

## 核心理念

不信任任何一层的"看起来对"。跨层系统（后端 C# -> Rust Tauri -> 前端 React）中，一个字段名拼写差异、一个 serde 规则遗漏、一个 null 处理缺失，都可能在运行时静默失败。Deep Trace 逐层穿透，不放过任何接缝。

## 触发条件

- 用户说 "/deep-trace"、"深度追踪"、"deep trace"
- 涉及跨层数据流（API -> 中间层 -> 前端）
- 涉及新增或修改 API 端点
- 涉及序列化/反序列化边界
- 对代码变更的正确性不信任时

## 追踪维度

### 1. 接缝扫描（Seam Scanning）

**目标**: 找出所有层间接缝，逐一验证数据能否正确穿越。

**接缝清单**:
| 接缝位置 | 验证点 |
|----------|--------|
| C# DTO -> JSON 序列化 | 属性名 camelCase？`[JsonPropertyName]`？匿名对象？ |
| JSON -> Rust struct 反序列化 | `serde(rename_all = "camelCase")` 是否一致？ |
| Rust -> Tauri command 返回 | 返回类型与前端 `invoke<T>` 泛型是否匹配？ |
| 前端 invoke -> 组件 state | 字段名是否拼写一致？可选字段是否处理 undefined？ |
| 组件 event -> 另一组件 | CustomEvent detail 结构是否与监听方解构匹配？ |
| 前端 -> 后端请求体 | 参数名与后端 DTO 属性是否一一对应？ |

**执行方式**:
```markdown
## 接缝扫描: [功能名称]

### 接缝 1: C# -> JSON
- DTO 类: `XxxResponse`
- 序列化方式: [匿名对象 / 显式 DTO]
- 字段映射:
  | C# 属性 | JSON 键 | 匹配? |
  |---------|---------|-------|
  | PromptTemplate | promptTemplate | ? |

### 接缝 2: JSON -> Rust
- Rust struct: `XxxResponse`
- serde 配置: `rename_all = "camelCase"`
- 字段映射:
  | JSON 键 | Rust 字段 | 匹配? |
  |---------|----------|-------|
  | promptTemplate | prompt_template | ? |

### 接缝 3: Rust -> 前端
...
```

### 2. 链路穿透（Chain Penetration）

**目标**: 选取一个关键数据字段，从源头到终点逐行追踪。

**步骤**:
1. 选择追踪目标字段
2. 找到字段的**诞生点**（第一次赋值的地方）
3. 逐层追踪：每经过一个函数/模块，记录字段名、类型、是否可能为 null
4. 到达**消费点**（最终使用的地方），确认值与预期一致

**输出格式**:
```
追踪字段: promptTemplate

[诞生] Controller:353 → var promptTemplate = resultBuilder.ToString().Trim()
  类型: string, 可能为空: 已检查 (line 355)
  ↓
[序列化] Controller:361 → new { promptTemplate }
  JSON: { "promptTemplate": "..." }
  ↓
[反序列化] skill.rs:200 → ExtractPromptTemplateResponse { prompt_template }
  serde camelCase: promptTemplate → prompt_template ✓
  ↓
[Tauri 返回] skill.rs:209 → Result<ApiResponse<ExtractPromptTemplateResponse>>
  ↓
[前端接收] MessageList.tsx:1391 → resp.data.promptTemplate
  类型: string ✓
  ↓
[事件传递] MessageList.tsx:1399 → detail.formData.promptTemplate
  ↓
[消费] SkillManagerModal.tsx:69 → { ...EMPTY_FORM, ...initialFormData }
  promptTemplate 覆盖默认空字符串 ✓

结论: 全链路字段名匹配，类型一致，null 已处理
```

### 3. 契约校验（Contract Verification）

**目标**: 验证每层的输入输出契约是否被遵守。

**检查矩阵**:

| 层 | 契约项 | 验证方式 |
|----|--------|---------|
| 后端 Controller | 认证检查 | 查找 GetUserId / Unauthorized |
| 后端 Controller | 必填验证 | 查找 IsNullOrWhiteSpace / [Required] |
| 后端 Controller | 错误响应格式 | 确认 ApiResponse.Fail 包含 code + message |
| Rust command | 参数类型 | 对比前端 invoke 传参与 Rust 函数签名 |
| Rust command | 错误处理 | Result<T, String> 是否有 map_err |
| 前端 | 成功判断 | resp?.success && resp.data?.xxx |
| 前端 | 错误处理 | throw / catch / 用户提示 |

### 4. 边界穿透测试（Boundary Penetration）

**目标**: 构造极端输入，验证每层的防御是否到位。

**测试向量**:
| 输入 | 预期行为 | 哪层拦截？ |
|------|---------|-----------|
| 必填字段为空 | 400 BadRequest | 后端 Controller |
| 必填字段为 null | 400 BadRequest | 后端 Controller |
| 未认证请求 | 401 Unauthorized | 后端 Controller |
| LLM 返回空 | 500 + 错误码 | 后端业务逻辑 |
| 网络超时 | 前端错误提示 | 前端 catch |
| 响应字段缺失 | 不崩溃，优雅降级 | 前端可选链 |
| 超长输入 (100K 字符) | 正常处理或拒绝 | 需确认 |

**执行方式**: 不需要真的发请求，通过阅读代码判断每个向量在哪层被拦截。

### 5. 注册完整性（Registration Completeness）

**目标**: 确认新增的端点/命令已在所有必要位置注册。

**检查清单**:
- [ ] 后端 Controller 路由存在且正确
- [ ] Tauri command 已在 `lib.rs` 的 `invoke_handler` 中注册
- [ ] 前端 `invoke` 的 command name 与 Rust `#[command]` 函数名一致
- [ ] 如有新的 MongoDB 集合，已在 `MongoDbContext` 注册
- [ ] 如有新的权限，已在 `AdminPermissionCatalog` 注册
- [ ] CLAUDE.md Codebase Skill 段落是否需要更新

## 执行流程

### Step 1: 确定追踪范围

```bash
# 查看变更文件
git diff --name-only [base]..HEAD

# 按层分类
# 后端: *.cs
# Rust: *.rs
# 前端: *.tsx, *.ts
```

### Step 2: 绘制数据流图

用文本画出数据从入口到出口的流向，标记每个接缝位置。

### Step 3: 逐接缝验证

对每个接缝执行接缝扫描 + 链路穿透。

### Step 4: 契约 + 边界验证

对整体流程执行契约校验和边界穿透测试。

### Step 5: 输出追踪报告

```markdown
# Deep Trace 报告

## 追踪对象
- 功能: [功能名称]
- 涉及层: [后端 / Rust / 前端]
- 文件: [文件列表]

## 数据流图
[文本流向图]

## 接缝扫描结果
| 接缝 | 状态 | 备注 |
|------|------|------|
| C# -> JSON | ✅/❌ | ... |
| JSON -> Rust | ✅/❌ | ... |
| Rust -> 前端 | ✅/❌ | ... |

## 链路穿透
[关键字段的逐层追踪结果]

## 契约校验
| 层 | 项目 | 状态 |
|----|------|------|
| ... | ... | ✅/❌ |

## 边界穿透
| 向量 | 拦截层 | 状态 |
|------|--------|------|
| ... | ... | ✅/❌ |

## 注册完整性
- [ ] 各项检查

## 发现的问题
1. [严重程度] [描述]

## 结论
- ✅ 全链路验证通过
- ⚠️ 通过但有建议
- ❌ 发现断裂点，需修复
```

## 与 human-verify 的区别

| 维度 | human-verify | deep-trace |
|------|-------------|------------|
| 聚焦 | 通用验证，多角度 | 跨层数据流，接缝穿透 |
| 适用 | 任何代码变更 | 涉及多层交互的变更 |
| 深度 | 广度优先 | 深度优先 |
| 核心问题 | "这个功能正确吗？" | "数据能完整穿越每一层吗？" |

## 注意事项

1. **只追踪变更涉及的链路**，不要扩散到无关代码
2. **优先追踪新增接缝**，已有接缝只做抽检
3. **关注序列化规则差异**：C# PascalCase vs JSON camelCase vs Rust snake_case
4. **Tauri command 注册是高频遗漏点**，务必检查 lib.rs
5. **匿名对象比显式 DTO 更容易出错**，重点关注
