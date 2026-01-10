# 开放平台集成测试指南

## 前置条件

1. 后端服务已启动（默认 http://localhost:5000）
2. 已有管理员账号登录管理后台
3. 已创建至少一个用户和群组，并上传了 PRD 文档

## 测试步骤

### 1. 创建开放平台应用

1. 登录管理后台（http://localhost:8000）
2. 进入"开放平台"页面
3. 点击"新建应用"
4. 填写信息：
   - 应用名称：测试应用
   - 描述：用于测试 Chat Completion 接口
   - 绑定用户：选择一个已有用户
   - 绑定群组：选择一个已上传 PRD 的群组
5. 创建成功后，复制显示的 API Key（格式：sk-xxxxx）

### 2. 使用 curl 测试 Chat Completion 接口

#### 测试流式响应

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "prd-agent",
    "messages": [
      {"role": "user", "content": "这个功能的核心流程是什么？"}
    ],
    "stream": true
  }'
```

**预期结果**：
- 返回 SSE 流式响应
- 首先收到 role chunk：`data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk",...,"choices":[{"index":0,"delta":{"role":"assistant"},...}]}`
- 然后收到多个 content chunk
- 最后收到 done chunk 和 `data: [DONE]`

#### 测试权限验证（访问未授权群组）

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "prd-agent",
    "messages": [
      {"role": "user", "content": "测试"}
    ],
    "stream": true,
    "groupId": "UNAUTHORIZED_GROUP_ID"
  }'
```

**预期结果**：
- 返回 403 错误
- 错误信息：`{"error":{"message":"Access to this group is denied","type":"permission_denied"}}`

#### 测试无效 API Key

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-invalid-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "prd-agent",
    "messages": [
      {"role": "user", "content": "测试"}
    ],
    "stream": true
  }'
```

**预期结果**：
- 返回 401 错误
- 错误信息：`{"error":{"message":"Invalid API Key","type":"invalid_request_error"}}`

### 3. 验证调用日志

1. 返回管理后台"开放平台"页面
2. 点击应用行的"查看日志"按钮
3. 验证日志记录：
   - 请求时间正确
   - 状态码正确（200 或 403）
   - 耗时已记录
   - Token 用量已记录（成功请求）

### 4. 测试应用管理功能

#### 禁用应用

1. 点击应用行的"禁用"按钮
2. 使用该应用的 API Key 再次调用接口
3. **预期结果**：返回 401 错误，提示 API Key 无效

#### 重新生成密钥

1. 点击应用行的"重新生成密钥"按钮
2. 确认操作
3. 复制新的 API Key
4. 使用旧 API Key 调用接口
5. **预期结果**：返回 401 错误
6. 使用新 API Key 调用接口
7. **预期结果**：成功返回响应

#### 删除应用

1. 点击应用行的"删除"按钮
2. 确认操作
3. 使用该应用的 API Key 调用接口
4. **预期结果**：返回 401 错误

## 使用 OpenAI SDK 测试

### Python 示例

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-YOUR_API_KEY_HERE",
    base_url="http://localhost:5000/api/v1/open-platform/v1"
)

response = client.chat.completions.create(
    model="prd-agent",
    messages=[
        {"role": "user", "content": "这个功能的核心流程是什么？"}
    ],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### Node.js 示例

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-YOUR_API_KEY_HERE',
  baseURL: 'http://localhost:5000/api/v1/open-platform/v1'
});

const stream = await client.chat.completions.create({
  model: 'prd-agent',
  messages: [
    { role: 'user', content: '这个功能的核心流程是什么？' }
  ],
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    process.stdout.write(content);
  }
}
```

## 性能测试

### 并发测试

使用 Apache Bench 测试并发性能：

```bash
# 准备请求体文件 request.json
echo '{
  "model": "prd-agent",
  "messages": [{"role": "user", "content": "测试"}],
  "stream": true
}' > request.json

# 发起 10 个并发请求，共 100 个请求
ab -n 100 -c 10 \
  -H "Authorization: Bearer sk-YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json" \
  -p request.json \
  http://localhost:5000/api/v1/open-platform/v1/chat/completions
```

## 故障排查

### 常见错误

1. **401 Unauthorized**
   - 检查 API Key 是否正确
   - 检查应用是否已启用
   - 检查 Authorization header 格式

2. **403 Permission Denied**
   - 检查 groupId 是否正确
   - 检查应用绑定的用户是否为该群组成员
   - 检查应用绑定的群组是否匹配

3. **404 Not Found**
   - 检查群组是否存在
   - 检查群组是否已上传 PRD 文档

4. **500 Internal Error**
   - 查看后端日志
   - 检查 LLM 配置是否正确
   - 检查数据库连接

### 日志查看

#### 后端日志

```bash
# 查看 API 日志
tail -f prd-api/logs/prdagent-*.log

# 查看特定请求
grep "OpenPlatform" prd-api/logs/prdagent-*.log
```

#### 数据库查询

```javascript
// MongoDB 查询开放平台日志
db.openplatformrequestlogs.find().sort({startedAt: -1}).limit(10)

// 查询特定应用的日志
db.openplatformrequestlogs.find({appId: "YOUR_APP_ID"}).sort({startedAt: -1})

// 查询错误请求
db.openplatformrequestlogs.find({statusCode: {$gte: 400}}).sort({startedAt: -1})
```

## 验收标准

- [x] 管理员可创建开放平台应用，获得 API Key
- [x] 第三方可通过 API Key 调用 `/v1/chat/completions`
- [x] 流式响应格式兼容 OpenAI SDK
- [x] 权限验证正确（用户/群组绑定）
- [x] 调用日志完整记录（时间、Token、错误）
- [x] 禁用应用后无法调用
- [x] 重新生成密钥后旧密钥失效
- [x] API Key 仅在创建时显示一次
