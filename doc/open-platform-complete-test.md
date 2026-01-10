# 开放平台完整测试指南

## 概述

本文档提供开放平台 API 的完整测试用例，包括：
1. PRD 问答模式（model=prdagent）
2. LLM 代理模式（model=其他）
3. 使用永久测试 Key 进行测试

## 前置条件

1. 后端服务运行在 `http://localhost:5000`
2. MongoDB 和 Redis 已启动
3. 已配置 LLM 服务（Claude/OpenAI）

## 测试 Key

### 永久测试 Key（免密测试）

```bash
export TEST_API_KEY="sk-test-permanent-key-for-testing-only"
```

此 Key 已在 `appsettings.json` 中配置，无需数据库验证，直接可用。

测试 Key 绑定信息：
- appId: `test-app-id`
- boundUserId: `test-user-id`
- boundGroupId: 无（需在请求中指定）

## 测试用例

### 1. LLM 代理模式测试（推荐先测试）

#### 1.1 基础对话测试

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {
        "role": "user",
        "content": "你好，请介绍一下你自己"
      }
    ],
    "stream": true
  }'
```

**预期结果：**
- 返回 SSE 流式响应
- 格式符合 OpenAI 规范
- 包含 `data: [DONE]` 结束标记
- 包含 Token 用量统计

#### 1.2 多轮对话测试

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {
        "role": "user",
        "content": "什么是 RESTful API？"
      },
      {
        "role": "assistant",
        "content": "RESTful API 是一种基于 HTTP 协议的 Web 服务架构风格..."
      },
      {
        "role": "user",
        "content": "它有哪些优点？"
      }
    ],
    "stream": true
  }'
```

**预期结果：**
- 正确处理上下文
- 回答与前文相关

#### 1.3 不同模型名称测试

```bash
# 测试 deepseek
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v3",
    "messages": [{"role": "user", "content": "1+1=?"}],
    "stream": true
  }'

# 测试任意模型名
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "my-custom-model",
    "messages": [{"role": "user", "content": "测试"}],
    "stream": true
  }'
```

**预期结果：**
- 所有非 `prdagent` 的模型名都会转发到主模型
- 返回的 `model` 字段与请求一致

### 2. PRD 问答模式测试

#### 2.1 前置准备：创建测试群组

首先需要通过管理后台或 API 创建一个群组并上传 PRD 文档。

```bash
# 假设已有群组 ID: test-group-123
# 假设该群组已上传 PRD 文档
# 假设 test-user-id 是该群组成员
```

#### 2.2 PRD 问答测试

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "prdagent",
    "groupId": "test-group-123",
    "messages": [
      {
        "role": "user",
        "content": "这个项目的核心功能是什么？"
      }
    ],
    "stream": true
  }'
```

**预期结果：**
- 基于 PRD 文档回答
- 返回结构化的功能说明
- 引用 PRD 中的具体内容

#### 2.3 缺少 groupId 测试

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "prdagent",
    "messages": [
      {
        "role": "user",
        "content": "测试问题"
      }
    ],
    "stream": true
  }'
```

**预期结果：**
- 返回 400 错误
- 错误信息：`groupId is required for prdagent model`

#### 2.4 无权限群组测试

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "prdagent",
    "groupId": "unauthorized-group-id",
    "messages": [
      {
        "role": "user",
        "content": "测试问题"
      }
    ],
    "stream": true
  }'
```

**预期结果：**
- 返回 403 错误
- 错误信息：`User is not a member of this group`

### 3. 认证测试

#### 3.1 无 API Key

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "测试"}],
    "stream": true
  }'
```

**预期结果：**
- 返回 401 错误

#### 3.2 无效 API Key

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-invalid-key-12345" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "测试"}],
    "stream": true
  }'
```

**预期结果：**
- 返回 401 错误
- 错误信息：`Invalid or inactive API Key`

#### 3.3 格式错误的 API Key

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer invalid-format" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "测试"}],
    "stream": true
  }'
```

**预期结果：**
- 返回 401 错误
- 错误信息：`Invalid API Key format`

### 4. OpenAI SDK 兼容性测试

#### 4.1 Python SDK 测试

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-test-permanent-key-for-testing-only",
    base_url="http://localhost:5000/api/v1/open-platform/v1"
)

# LLM 代理模式
response = client.chat.completions.create(
    model="gpt-4",
    messages=[
        {"role": "user", "content": "你好，请用一句话介绍 Python"}
    ],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
print()

# PRD 问答模式（需要先创建群组）
response = client.chat.completions.create(
    model="prdagent",
    messages=[
        {"role": "user", "content": "项目的技术栈是什么？"}
    ],
    extra_body={"groupId": "test-group-123"},
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
print()
```

#### 4.2 Node.js SDK 测试

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-test-permanent-key-for-testing-only',
  baseURL: 'http://localhost:5000/api/v1/open-platform/v1'
});

// LLM 代理模式
async function testLlmProxy() {
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
  console.log('\n');
}

// PRD 问答模式
async function testPrdAgent() {
  const stream = await client.chat.completions.create({
    model: 'prdagent',
    messages: [{ role: 'user', content: '项目的核心功能？' }],
    groupId: 'test-group-123', // 自定义字段
    stream: true
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      process.stdout.write(content);
    }
  }
  console.log('\n');
}

await testLlmProxy();
await testPrdAgent();
```

### 5. 性能测试

#### 5.1 并发测试

```bash
# 使用 Apache Bench 进行并发测试
ab -n 100 -c 10 -p request.json -T application/json \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  http://localhost:5000/api/v1/open-platform/v1/chat/completions
```

request.json:
```json
{
  "model": "gpt-4",
  "messages": [{"role": "user", "content": "测试"}],
  "stream": true
}
```

**预期结果：**
- 所有请求成功
- 平均响应时间 < 3s
- 无内存泄漏

#### 5.2 长时间运行测试

```bash
# 持续 10 分钟发送请求
for i in {1..100}; do
  curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
    -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
    -H "Content-Type: application/json" \
    -d '{"model":"gpt-4","messages":[{"role":"user","content":"测试'$i'"}],"stream":true}' \
    > /dev/null 2>&1
  sleep 6
done
```

**预期结果：**
- 所有请求成功
- 服务稳定运行
- 日志正常记录

### 6. 日志验证

#### 6.1 查看请求日志

通过管理后台 `/open-platform` 页面查看日志，或直接查询数据库：

```javascript
// MongoDB 查询
db.openplatformrequestlogs.find({
  AppId: "test-app-id"
}).sort({ StartedAt: -1 }).limit(10)
```

**验证项：**
- 所有请求都有日志记录
- Token 用量统计正确
- 错误码正确记录
- 耗时合理

#### 6.2 验证 API Key 脱敏

检查日志中 API Key 是否已脱敏（仅显示后 8 位）。

### 7. 错误处理测试

#### 7.1 空消息测试

```bash
curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [],
    "stream": true
  }'
```

**预期结果：**
- 返回 400 错误
- 错误信息：`Messages cannot be empty`

#### 7.2 LLM 服务异常测试

停止 LLM 服务或配置错误的 API Key，然后发送请求。

**预期结果：**
- 返回错误事件
- 错误码：`LLM_ERROR`
- 日志中记录错误

#### 7.3 客户端取消测试

```bash
# 发送请求后立即 Ctrl+C 取消
timeout 1s curl -X POST http://localhost:5000/api/v1/open-platform/v1/chat/completions \
  -H "Authorization: Bearer sk-test-permanent-key-for-testing-only" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "请写一篇长文章"}],
    "stream": true
  }'
```

**预期结果：**
- 服务端正常处理取消
- 日志中记录状态码 499（CLIENT_CANCELLED）

## 测试检查清单

### 功能测试
- [ ] LLM 代理模式正常工作
- [ ] PRD 问答模式正常工作
- [ ] model 名称正确区分两种模式
- [ ] 测试 Key 免密认证成功
- [ ] 群组权限验证正确
- [ ] 多轮对话上下文正确

### 兼容性测试
- [ ] OpenAI Python SDK 可用
- [ ] OpenAI Node.js SDK 可用
- [ ] SSE 格式符合 OpenAI 规范
- [ ] Token 用量统计正确

### 安全测试
- [ ] 无 API Key 被拒绝
- [ ] 无效 API Key 被拒绝
- [ ] 格式错误的 API Key 被拒绝
- [ ] 无权限群组被拒绝
- [ ] API Key 在日志中已脱敏

### 性能测试
- [ ] 并发请求稳定
- [ ] 长时间运行无内存泄漏
- [ ] 响应时间符合预期
- [ ] 日志记录不影响性能

### 错误处理
- [ ] 空消息返回 400
- [ ] LLM 错误正确处理
- [ ] 客户端取消正确处理
- [ ] 所有错误都有日志记录

## 故障排查

### 问题：测试 Key 无法认证

**检查：**
1. `appsettings.json` 中是否配置了 `OpenPlatform:TestApiKey`
2. API Key 格式是否正确（`sk-` 开头）
3. Authorization header 格式是否正确

### 问题：PRD 问答返回 404

**检查：**
1. 群组是否存在
2. 群组是否已上传 PRD 文档
3. test-user-id 是否为群组成员

### 问题：LLM 代理返回错误

**检查：**
1. LLM 服务是否配置正确
2. LLM API Key 是否有效
3. 网络连接是否正常

### 问题：日志未记录

**检查：**
1. MongoDB 连接是否正常
2. `openplatformrequestlogs` 集合是否存在
3. 后端日志中是否有错误

## 总结

完成以上所有测试后，开放平台功能应该：
1. 支持两种模式（PRD 问答 + LLM 代理）
2. 完全兼容 OpenAI SDK
3. 认证和权限控制正确
4. 性能和稳定性符合要求
5. 错误处理完善
6. 日志记录完整

## 下一步

1. 在生产环境部署前，使用真实 API Key 进行测试
2. 配置速率限制
3. 设置监控和告警
4. 编写自动化测试脚本
