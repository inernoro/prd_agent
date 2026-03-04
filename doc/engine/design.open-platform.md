# 开放平台功能概要

## 文档版本

- **版本**：v1.0
- **创建日期**：2025-01-10
- **最后更新**：2025-01-10
- **状态**：已实现并测试

## 功能简介

开放平台（Open Platform）允许第三方应用通过 API Key 认证，以兼容 OpenAI 的方式调用 PRD Agent 服务，支持两种工作模式：

1. **PRD 问答模式**（`model=prdagent`）：基于群组 PRD 文档的智能问答
2. **LLM 代理模式**（`model=其他`）：直接转发到主模型，作为通用 LLM 服务

## 核心价值

### 对外部开发者
- 使用熟悉的 OpenAI SDK 即可接入
- 无需关心底层 PRD 解析和会话管理
- 统一的 API 接口，降低集成成本

### 对系统管理员
- 灵活的用户和群组绑定
- 完整的调用日志和 Token 统计
- API Key 管理（生成、重新生成、禁用）
- 支持测试 Key 用于开发调试

### 对产品团队
- 将 PRD 问答能力开放给外部系统
- 支持集成到 CI/CD、文档平台、协作工具
- 提供通用 LLM 代理服务，统一管理 Token 用量

## 架构设计

### 请求流程

```
外部应用
    ↓ (HTTP POST + API Key)
API Key 认证中间件
    ↓ (验证 & 提取 Claims)
OpenPlatformChatController
    ↓ (根据 model 分流)
    ├─ model=prdagent → PRD 问答模式
    │   ├─ 验证群组权限
    │   ├─ 创建会话
    │   ├─ 调用 ChatService
    │   └─ 返回 SSE 流
    │
    └─ model=其他 → LLM 代理模式
        ├─ 转换消息格式
        ├─ 调用 ILLMClient
        └─ 返回 SSE 流
```

### 数据模型

#### OpenPlatformApp（应用）
```csharp
{
    Id: string,                    // 应用唯一标识
    AppName: string,               // 应用名称
    Description: string?,          // 应用描述
    BoundUserId: string,           // 绑定的用户 ID（必选）
    BoundGroupId: string?,         // 绑定的群组 ID（可选）
    ApiKeyHash: string,            // API Key 哈希值（SHA256）
    IsActive: bool,                // 是否启用
    CreatedAt: DateTime,           // 创建时间
    LastUsedAt: DateTime?,         // 最后使用时间
    TotalRequests: long            // 总请求数
}
```

#### OpenPlatformRequestLog（请求日志）
```csharp
{
    Id: string,                    // 日志唯一标识
    AppId: string,                 // 应用 ID
    RequestId: string,             // 请求 ID
    StartedAt: DateTime,           // 请求开始时间
    EndedAt: DateTime,             // 请求结束时间
    DurationMs: long,              // 耗时（毫秒）
    Method: string,                // HTTP 方法
    Path: string,                  // 请求路径
    StatusCode: int,               // HTTP 状态码
    ErrorCode: string?,            // 错误码
    UserId: string?,               // 用户 ID
    GroupId: string?,              // 群组 ID
    SessionId: string?,            // 会话 ID
    InputTokens: int?,             // 输入 Token 数
    OutputTokens: int?             // 输出 Token 数
}
```

### 认证机制

#### API Key 格式
- 格式：`sk-` + 32位随机字符（总长 35 字符）
- 示例：`sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`
- 存储：仅存储 SHA256 哈希值
- 传输：`Authorization: Bearer {apiKey}`

#### 测试 Key
- 配置文件：`appsettings.json` → `OpenPlatform:TestApiKey`
- 默认值：`sk-test-permanent-key-for-testing-only`
- 用途：开发调试，无需数据库验证
- 绑定：`test-app-id` / `test-user-id`

### 权限模型

```
应用 (OpenPlatformApp)
    ├─ 绑定用户（必选）
    │   └─ 所有请求以该用户身份执行
    │
    └─ 绑定群组（可选）
        ├─ 已绑定：仅可访问该群组
        └─ 未绑定：可访问用户所属的任何群组（需在请求中指定）
```

## API 接口

### Chat Completion 接口

**端点**：`POST /api/v1/open-platform/v1/chat/completions`

**认证**：`Authorization: Bearer {apiKey}`

**请求体**：
```json
{
  "model": "prdagent",           // 模型名称（prdagent=PRD问答，其他=LLM代理）
  "messages": [                  // 消息列表
    {
      "role": "user",            // 角色：user / assistant
      "content": "问题内容"       // 消息内容
    }
  ],
  "groupId": "group-123",        // 群组 ID（PRD 模式必填）
  "stream": true,                // 是否流式响应（默认 true）
  "temperature": 0.7             // 温度参数（可选）
}
```

**响应格式**（SSE 流）：
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"prdagent","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"prdagent","choices":[{"index":0,"delta":{"content":"回答内容"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1234567890,"model":"prdagent","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}

data: [DONE]
```

### 管理后台接口

**基础路径**：`/api/v1/admin/open-platform`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/apps` | 获取应用列表（分页） |
| POST | `/apps` | 创建应用 |
| PUT | `/apps/{id}` | 更新应用 |
| DELETE | `/apps/{id}` | 删除应用 |
| POST | `/apps/{id}/regenerate-key` | 重新生成 API Key |
| POST | `/apps/{id}/toggle` | 启用/禁用应用 |
| GET | `/logs` | 获取调用日志 |

## 使用场景

### 场景 1：PRD 问答集成

**需求**：将 PRD 问答能力集成到团队的文档平台

**实现**：
1. 管理员创建应用，绑定文档平台的服务账号
2. 绑定到特定群组（如"产品需求评审群"）
3. 文档平台使用 API Key 调用 `model=prdagent` 接口
4. 用户在文档平台直接提问，后台转发到 PRD Agent

**示例代码**：
```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-api-key",
    base_url="https://your-domain.com/api/v1/open-platform/v1"
)

response = client.chat.completions.create(
    model="prdagent",
    messages=[
        {"role": "user", "content": "这个功能的验收标准是什么？"}
    ],
    extra_body={"groupId": "group-123"},
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### 场景 2：LLM 代理服务

**需求**：统一管理团队的 LLM 调用，避免每个应用单独配置 API Key

**实现**：
1. 管理员创建应用，绑定到各个业务系统的服务账号
2. 不绑定群组（LLM 代理模式不需要）
3. 业务系统使用 API Key 调用 `model=gpt-4` 等接口
4. PRD Agent 后端统一转发到主模型

**示例代码**：
```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-your-api-key',
  baseURL: 'https://your-domain.com/api/v1/open-platform/v1'
});

const stream = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [{ role: 'user', content: '你好' }],
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    process.stdout.write(content);
  }
}
```

### 场景 3：CI/CD 集成

**需求**：在 CI/CD 流程中自动检查 PRD 完整性

**实现**：
1. 管理员创建 CI 专用应用，绑定到 CI 服务账号
2. 绑定到"主干需求群"
3. CI 脚本在每次 PRD 更新后自动提问
4. 根据回答判断 PRD 是否完整

**示例脚本**：
```bash
#!/bin/bash

API_KEY="sk-ci-api-key"
API_BASE="https://your-domain.com/api/v1/open-platform/v1"
GROUP_ID="main-requirements-group"

# 检查 PRD 完整性
response=$(curl -s -X POST "$API_BASE/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"prdagent\",
    \"groupId\": \"$GROUP_ID\",
    \"messages\": [{
      \"role\": \"user\",
      \"content\": \"请列出 PRD 中缺失的关键信息\"
    }],
    \"stream\": false
  }")

# 解析响应并判断
if echo "$response" | grep -q "缺失"; then
  echo "PRD 不完整，请补充"
  exit 1
else
  echo "PRD 检查通过"
  exit 0
fi
```

## 安全考虑

### API Key 管理
- **生成**：使用加密安全的随机数生成器
- **存储**：仅存储 SHA256 哈希值，永不存储明文
- **传输**：仅通过 HTTPS 传输
- **展示**：仅在创建/重新生成时显示一次
- **日志**：脱敏显示（`sk-***{后8位}`）

### 权限控制
- **用户绑定**：所有请求以绑定用户身份执行
- **群组隔离**：绑定群组后仅可访问该群组
- **成员验证**：未绑定群组时，验证用户是否为群组成员
- **禁用机制**：可随时禁用应用，立即生效

### 速率限制
- **建议配置**：
  - 每个应用：100 请求/分钟
  - 每个用户：1000 请求/小时
  - 全局：10000 请求/小时
- **实现方式**：Redis + 滑动窗口

### 日志审计
- **记录内容**：
  - 请求时间、耗时、状态码
  - 应用 ID、用户 ID、群组 ID
  - Token 用量、错误码
  - 请求体（脱敏）
- **保留期限**：30 天（TTL 索引自动清理）
- **访问控制**：仅管理员可查看

## 监控指标

### 关键指标
- **调用量**：总请求数、成功率、失败率
- **性能**：平均响应时间、P95/P99 延迟
- **Token 用量**：输入 Token、输出 Token、总用量
- **错误分布**：按错误码统计
- **应用排行**：按调用量排序

### 告警规则
- 错误率 > 5%
- P99 延迟 > 10s
- 单应用调用量异常（> 1000/分钟）
- API Key 认证失败率 > 10%

## 测试指南

详细测试用例请参考：
- [完整测试指南](./open-platform-complete-test.md)
- [测试脚本](../test-open-platform.sh)（Bash）
- [测试脚本](../test-open-platform.ps1)（PowerShell）

### 快速测试

```bash
# 使用测试 Key 进行快速验证
export TEST_KEY="sk-test-permanent-key-for-testing-only"

# LLM 代理模式
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'

# PRD 问答模式（需要先创建群组）
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer $TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "prdagent",
    "groupId": "your-group-id",
    "messages": [{"role": "user", "content": "项目的核心功能是什么？"}],
    "stream": true
  }'
```

## 未来规划

### 短期（v1.1）
- [ ] 速率限制实现
- [ ] API Key 过期时间配置
- [ ] Webhook 通知（调用成功/失败）
- [ ] 更详细的 Token 用量统计图表

### 中期（v1.2）
- [ ] 支持更多 OpenAI 接口（embeddings、images）
- [ ] 批量请求接口
- [ ] 自定义系统提示词
- [ ] API Key 权限范围配置

### 长期（v2.0）
- [ ] 多租户支持
- [ ] 计费系统集成
- [ ] API 版本管理
- [ ] GraphQL 接口

## 相关文档

- [开放平台实施总结](./open-platform-implementation-summary.md)
- [开放平台完整测试指南](./open-platform-complete-test.md)
- [SRS - 软件需求规格说明书](./2.srs.md)
- [PRD - 产品需求文档](./3.prd.md)
- [开发指南](./4.dev.md)

## 变更历史

| 版本 | 日期 | 变更内容 | 作者 |
|------|------|----------|------|
| v1.0 | 2025-01-10 | 初始版本，包含 PRD 问答和 LLM 代理两种模式 | - |
