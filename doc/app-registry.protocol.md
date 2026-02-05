# 应用注册中心协议规范

> **版本**: 1.0.0
> **最后更新**: 2026-02-04

## 概述

应用注册中心（App Registry）是一个**统一的应用调度网关**，允许第三方应用注册到系统中，通过标准协议接收和处理来自多种通道（邮件、SMS、Siri、Webhook 等）的请求。

### 核心概念

```
┌─────────────────────────────────────────────────────────────┐
│                    通道网关 (Channel Gateway)                │
│   📧 Email    📱 SMS    🎙️ Siri    🔗 Webhook              │
│                          ↓                                  │
│              ┌───────────────────────┐                      │
│              │   统一协议层           │                      │
│              │   序列化 → 标准格式    │                      │
│              └───────────────────────┘                      │
│                          ↓                                  │
│              ┌───────────────────────┐                      │
│              │      路由层            │                      │
│              │  关键词 / 用户 / 规则  │                      │
│              └───────────────────────┘                      │
└──────────────────────────┬──────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────┐
│               应用注册中心 (Application Registry)             │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  📋 PRD问答    🐛 缺陷管理    ✅ 待办    🧪 桩应用     │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 1. 创建桩应用（测试）

```bash
# 创建一个简单的桩应用
curl -X POST http://localhost:5000/api/app-registry/stubs \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "my-test-app",
    "appName": "测试应用",
    "description": "用于测试的桩应用",
    "icon": "🧪",
    "stubConfig": {
      "fixedResponse": "收到您的消息，这是固定回复！",
      "delayMs": 500
    }
  }'
```

### 2. 创建路由规则

```bash
# 将包含 "测试" 关键词的请求路由到桩应用
curl -X POST http://localhost:5000/api/app-registry/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "测试规则",
    "priority": 10,
    "condition": {
      "type": "Keyword",
      "keywords": ["测试", "test"]
    },
    "targetAppId": "my-test-app"
  }'
```

### 3. 测试调用

```bash
# 模拟一个请求
curl -X POST http://localhost:5000/api/app-registry/invoke/my-test-app \
  -H "Content-Type: application/json" \
  -d '{
    "source": {
      "channel": "email",
      "senderIdentifier": "user@example.com",
      "senderName": "测试用户"
    },
    "content": {
      "subject": "测试邮件",
      "body": "这是一封测试邮件"
    }
  }'
```

---

## 协议规范

### 统一请求格式 (UnifiedAppRequest)

```json
{
  "requestId": "req_abc123",
  "timestamp": "2026-02-04T10:30:00Z",

  "source": {
    "channel": "email",
    "senderIdentifier": "user@example.com",
    "senderName": "张三",
    "originalMessageId": "msg_xxx",
    "channelMetadata": {}
  },

  "content": {
    "subject": "关于登录功能的问题",
    "body": "用户登录失败时应该显示什么提示？",
    "contentType": "text",
    "attachments": [],
    "parameters": {}
  },

  "context": {
    "userId": "user_123",
    "userName": "张三",
    "sessionId": "sess_456",
    "groupId": "group_789",
    "customPrompt": "请用简洁的语言回答",
    "metadata": {}
  },

  "routing": {
    "ruleId": "rule_001",
    "matchType": "Keyword",
    "matchedKeyword": "登录"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | string | 是 | 请求唯一标识，用于追踪 |
| `timestamp` | datetime | 是 | 请求时间戳 |
| `source.channel` | string | 是 | 通道类型：email, sms, siri, webhook, api |
| `source.senderIdentifier` | string | 是 | 发送者标识（邮箱/手机号等） |
| `source.senderName` | string | 否 | 发送者名称 |
| `content.subject` | string | 否 | 主题/标题 |
| `content.body` | string | 是 | 正文内容 |
| `content.contentType` | string | 否 | 内容类型：text, html, markdown |
| `content.attachments` | array | 否 | 附件列表 |
| `context.userId` | string | 否 | 映射的系统用户 ID |
| `context.customPrompt` | string | 否 | 自定义提示词 |

### 统一响应格式 (UnifiedAppResponse)

```json
{
  "requestId": "req_abc123",
  "status": "Success",
  "message": "处理成功",

  "result": {
    "content": "根据 PRD 文档，登录失败时应显示「用户名或密码错误」",
    "entityId": "doc_123",
    "entityType": "prd_section",
    "data": {}
  },

  "reply": {
    "shouldReply": true,
    "content": "已为您查询，登录失败时应显示「用户名或密码错误」",
    "contentType": "text",
    "attachments": []
  },

  "error": null,
  "durationMs": 1234,
  "data": {}
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `requestId` | string | 是 | 对应请求的 ID |
| `status` | enum | 是 | Success, Failed, Pending, Processing, Timeout, Rejected |
| `message` | string | 否 | 状态描述 |
| `result.content` | string | 否 | 处理结果内容 |
| `result.entityId` | string | 否 | 创建的实体 ID（如待办事项 ID） |
| `reply.shouldReply` | bool | 是 | 是否需要回复发送者 |
| `reply.content` | string | 否 | 回复内容 |
| `error.code` | string | 否 | 错误代码 |
| `error.message` | string | 否 | 错误消息 |
| `error.retryable` | bool | 否 | 是否可重试 |

---

## 应用注册

### 注册外部应用

```bash
curl -X POST http://localhost:5000/api/app-registry/apps \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "prd-qa-agent",
    "appName": "PRD 问答助手",
    "description": "基于 PRD 文档回答问题",
    "icon": "📋",
    "version": "1.0.0",
    "capabilities": {
      "inputTypes": ["text"],
      "outputTypes": ["text"],
      "supportsAttachments": false,
      "triggerKeywords": ["PRD", "需求", "文档", "功能"],
      "useCaseDescription": "回答与 PRD 文档相关的问题"
    },
    "endpoint": "https://your-app.com/api/handle",
    "authType": "ApiKey",
    "apiKey": "your-secret-key"
  }'
```

### 应用清单 (Application Manifest)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `appId` | string | 是 | 应用唯一标识（自定义） |
| `appName` | string | 是 | 应用显示名称 |
| `description` | string | 否 | 应用描述 |
| `icon` | string | 否 | 图标（emoji 或 URL） |
| `version` | string | 否 | 版本号 |
| `capabilities.inputTypes` | array | 否 | 支持的输入类型 |
| `capabilities.outputTypes` | array | 否 | 支持的输出类型 |
| `capabilities.triggerKeywords` | array | 否 | 触发关键词（用于智能路由） |
| `endpoint` | string | 是 | 调用端点 URL |
| `authType` | enum | 否 | 认证方式：None, ApiKey, Bearer, Basic |
| `apiKey` | string | 否 | API 密钥 |

---

## 路由规则

### 规则类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `Keyword` | 关键词匹配 | 内容包含 "待办" 时触发 |
| `Regex` | 正则表达式 | 匹配 `\[待办\].*` 模式 |
| `User` | 指定用户 | 用户 user_123 的请求 |
| `Sender` | 指定发送者 | 来自 `*@company.com` 的请求 |
| `All` | 全部匹配 | 默认路由 |

### 创建规则示例

```json
// 关键词匹配
{
  "name": "待办事项",
  "priority": 10,
  "condition": {
    "type": "Keyword",
    "keywords": ["待办", "todo", "任务"]
  },
  "targetAppId": "todo-agent"
}

// 用户专属
{
  "name": "张三专属",
  "priority": 5,
  "condition": {
    "type": "User",
    "userId": "user_123"
  },
  "targetAppId": "prd-qa-agent"
}

// 发送者匹配
{
  "name": "公司内部",
  "priority": 20,
  "condition": {
    "type": "Sender",
    "senderPattern": "*@company.com"
  },
  "targetAppId": "internal-agent"
}

// 默认路由
{
  "name": "默认",
  "priority": 999,
  "condition": {
    "type": "All"
  },
  "targetAppId": "general-agent"
}
```

---

## 桩应用（测试用）

桩应用是系统内置的模拟应用，用于**测试和调试**，无需部署外部服务。

### 桩应用配置

| 字段 | 类型 | 说明 |
|------|------|------|
| `fixedResponse` | string | 固定回复内容 |
| `delayMs` | int | 模拟延迟（毫秒） |
| `randomFailure` | bool | 是否随机失败 |
| `failureProbability` | int | 失败概率（0-100） |
| `failureMessage` | string | 失败时的错误消息 |
| `echoInput` | bool | 是否回显输入内容 |
| `responseTemplate` | string | 响应模板（支持变量） |

### 响应模板变量

| 变量 | 说明 |
|------|------|
| `{subject}` | 请求主题 |
| `{body}` | 请求正文 |
| `{sender}` | 发送者名称 |
| `{timestamp}` | 当前时间 |

### 示例

```json
// 回显模式
{
  "appId": "echo-app",
  "appName": "回显应用",
  "stubConfig": {
    "echoInput": true,
    "delayMs": 100
  }
}

// 模板模式
{
  "appId": "template-app",
  "appName": "模板应用",
  "stubConfig": {
    "responseTemplate": "你好 {sender}！\n你的问题「{subject}」已收到。\n处理时间：{timestamp}"
  }
}

// 故障模拟
{
  "appId": "unstable-app",
  "appName": "不稳定应用",
  "stubConfig": {
    "fixedResponse": "处理成功",
    "randomFailure": true,
    "failureProbability": 30,
    "failureMessage": "模拟随机故障"
  }
}
```

---

## API 端点

### 应用管理

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/app-registry/apps` | 获取所有应用 |
| GET | `/api/app-registry/apps/{appId}` | 获取应用详情 |
| POST | `/api/app-registry/apps` | 注册应用 |
| PUT | `/api/app-registry/apps/{appId}` | 更新应用 |
| DELETE | `/api/app-registry/apps/{appId}` | 注销应用 |
| POST | `/api/app-registry/apps/{appId}/toggle` | 切换应用状态 |
| POST | `/api/app-registry/apps/{appId}/heartbeat` | 应用心跳 |

### 桩应用

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/app-registry/stubs` | 创建桩应用 |
| PUT | `/api/app-registry/stubs/{appId}/config` | 更新桩配置 |

### 路由规则

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/app-registry/rules` | 获取所有规则 |
| GET | `/api/app-registry/rules/{id}` | 获取规则详情 |
| POST | `/api/app-registry/rules` | 创建规则 |
| PUT | `/api/app-registry/rules/{id}` | 更新规则 |
| DELETE | `/api/app-registry/rules/{id}` | 删除规则 |
| POST | `/api/app-registry/rules/{id}/toggle` | 切换规则状态 |

### 测试

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/app-registry/invoke/{appId}` | 测试调用应用 |
| POST | `/api/app-registry/resolve` | 测试路由解析 |
| GET | `/api/app-registry/protocol` | 获取协议规范 |

---

## 开发指南

### 实现一个外部应用

1. **创建 HTTP 端点**：接收 POST 请求
2. **解析请求**：按照 `UnifiedAppRequest` 格式解析
3. **处理业务**：执行你的业务逻辑
4. **返回响应**：按照 `UnifiedAppResponse` 格式返回

```python
# Python 示例 (Flask)
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route('/api/handle', methods=['POST'])
def handle():
    req = request.json

    # 解析请求
    request_id = req.get('requestId')
    subject = req.get('content', {}).get('subject', '')
    body = req.get('content', {}).get('body', '')

    # 处理业务
    result = process_message(subject, body)

    # 返回响应
    return jsonify({
        'requestId': request_id,
        'status': 'Success',
        'message': '处理成功',
        'result': {
            'content': result
        },
        'reply': {
            'shouldReply': True,
            'content': f'已处理您的请求：{result}'
        }
    })

def process_message(subject, body):
    # 你的业务逻辑
    return f'收到：{subject}'

if __name__ == '__main__':
    app.run(port=8080)
```

### 注册应用

```bash
curl -X POST http://localhost:5000/api/app-registry/apps \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "my-python-app",
    "appName": "我的 Python 应用",
    "endpoint": "http://localhost:8080/api/handle"
  }'
```

### 创建路由

```bash
curl -X POST http://localhost:5000/api/app-registry/rules \
  -H "Content-Type: application/json" \
  -d '{
    "name": "路由到我的应用",
    "condition": { "type": "Keyword", "keywords": ["我的应用"] },
    "targetAppId": "my-python-app"
  }'
```

---

## 调试技巧

1. **使用桩应用测试路由**：先创建桩应用验证路由逻辑
2. **使用 `/resolve` 端点**：只测试路由匹配，不实际调用
3. **查看 `/protocol` 端点**：获取完整的协议示例
4. **开启回显模式**：桩应用设置 `echoInput: true` 查看接收到的请求

---

## 错误处理

### 常见错误码

| 错误码 | 说明 | 处理建议 |
|--------|------|----------|
| `APP_NOT_FOUND` | 应用不存在 | 检查 appId 是否正确 |
| `APP_DISABLED` | 应用已禁用 | 启用应用或检查配置 |
| `INVOKE_ERROR` | 调用失败 | 检查应用端点是否可达 |
| `STUB_FAILURE` | 桩应用模拟失败 | 正常，用于测试故障场景 |
| `NOT_IMPLEMENTED` | 功能未实现 | 内部应用预留接口 |

### 重试策略

当 `error.retryable = true` 时，建议：
- 等待 1-5 秒后重试
- 最多重试 3 次
- 指数退避策略

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-02-04 | 初始版本 |
