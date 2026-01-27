# 应用子功能与 appCallerCode 定义规则

## 1. 目标
- 定义“应用子功能”的结构与范围
- 统一 appCallerCode 的命名与使用
- 让调度与日志具备可追踪的业务身份

---

## 2. 应用子功能（Feature）定义

**定义**：应用内部可独立描述、独立配置模型的业务功能点。  

**判定标准**：
- 隶属于某个 appKey
- 有明确输入输出
- 需要调用 LLM
- 需要独立的模型需求配置

**层级关系**：
```
App (appKey)
  └─ Feature
      └─ Model Requirement
          └─ Model Group
              └─ Model
```

---

## 3. appCallerCode 定义（应用子功能调用大模型 key）

### 3.1 格式
```
{app}.{feature}[.{subfeature}...]::modelType
```

**说明**：
- `::` 前为功能路径，`::` 后为模型类型  
- 功能路径使用 `.` 分层  
- `app` 使用 `kebab-case`

### 3.2 模型类型（modelType）
常用类型：
- `chat`
- `intent`
- `vision`
- `generation`
- `code`
- `embedding`
- `rerank`

### 3.3 示例
```
desktop.chat.sendmessage::chat
desktop.chat.sendmessage::intent
visual-agent.image::generation
literary-agent.content::chat
open-platform.proxy::chat
admin.prompts.optimize::chat
```

---

## 4. 业务调用规则

### 4.1 强制入口
业务层必须通过 `ISmartModelScheduler` 获取客户端：
```csharp
var scheduled = await _modelScheduler.GetClientWithGroupInfoAsync(appCallerCode, modelType, ct);
```

### 4.2 日志要求
必须在调用前写入 `LlmRequestContext`：
- `RequestType`
- `RequestPurpose`（即 appCallerCode）
- `ModelResolutionType`
- `ModelGroupId`
- `ModelGroupName`

---

## 5. 生成与注册

### 5.1 自动注册
首次调用 `appCallerCode` 时，若未注册：
- 自动创建 `LLMAppCaller`
- 自动补默认 `ModelRequirement`

### 5.2 幂等初始化（摘要）
初始化机制只更新元信息，不覆盖用户已配置的模型需求。

---

## 6. 因果关系（顺序）
1) appKey / appname  
2) Feature 定义  
3) appCallerCode 生成与调用  
