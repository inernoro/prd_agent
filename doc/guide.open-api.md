# guide.open-api

> 类型：guide（操作指南） | 模块：开放接口（OpenAI 兼容对外网关） | 状态：active
> 最后更新：2026-06-04

开放接口让外部调用方用**标准 OpenAI 兼容**方式（借鉴 OpenRouter 风格）调用本平台模型。
对方只需把 SDK 的 `base_url` 指到本服务，填入签发的 `sk-ak-*` 密钥即可。

## 一、快速开始（3 步）

### 1. 签发密钥
在管理后台「接入 AI」弹窗创建 `sk-ak-*` Key，**勾选 `open-api:call` scope**。明文只显示一次，妥善保存。

### 2. 配置 base_url
- Base URL：`https://<你的域名>/api/v1`
- Auth：`Authorization: Bearer sk-ak-xxxx`

OpenAI Python SDK 示例：
```python
from openai import OpenAI
client = OpenAI(base_url="https://<域名>/api/v1", api_key="sk-ak-xxxx")
resp = client.chat.completions.create(model="deepseek/deepseek-v3.2",
    messages=[{"role":"user","content":"你好"}])
print(resp.choices[0].message.content)
```

### 3. 三条 curl 自检
```bash
# 查这把 Key 能用什么 + 余量（不打模型，最快鉴定）
curl -H "Authorization: Bearer sk-ak-xxx" https://<域名>/api/v1/key
# 列可用模型
curl -H "Authorization: Bearer sk-ak-xxx" https://<域名>/api/v1/models
# 发一条对话
curl -X POST https://<域名>/api/v1/chat/completions \
  -H "Authorization: Bearer sk-ak-xxx" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

## 二、端点契约

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/chat/completions` | 对话补全，OpenAI 兼容，支持 `stream:true` SSE |
| POST | `/api/v1/images/generations` | 生图，OpenAI 兼容 |
| GET | `/api/v1/models` | 该 Key 可用模型清单（OpenAI `{object:list,data:[]}`） |
| GET | `/api/v1/key` | **密钥自省**：白名单/配额/今日用量/有效期，不消耗额度 |

`/api/v1/key` 返回示例：
```json
{
  "name": "客户A", "is_active": true, "scopes": ["open-api:call"],
  "chat_models": ["deepseek/deepseek-v3.2"], "image_models": [],
  "default_chat_model": "deepseek/deepseek-v3.2", "default_image_model": null,
  "limits": {"rate_per_min": 60, "daily_requests": null, "daily_tokens": 1000000},
  "usage_today": {"requests": 12, "tokens": 3456},
  "expires_at": "2026-09-01T00:00:00Z"
}
```

## 三、模型选择规则（重点，与 OpenRouter 的差异）

每个 Key 配一个**模型白名单**（管理后台「开放接口」tab 配置）：

| 情况 | 行为 |
|---|---|
| Key 配了白名单，client `model` 命中 | 用该模型 |
| Key 配了白名单，client 不填 `model` | 用白名单**第一个**（默认） |
| Key 配了白名单，client 填了**白名单外**的 model | **400 `model_not_allowed`**（返回允许清单） |
| Key 未配白名单 | 回落默认池（`default:chat` / `default:image`），`model` 字段被忽略 |

> 与 OpenRouter 区别：OpenRouter 路由到任意 model；本平台把可选模型**限定在 Key 的白名单内**，便于按客户固定/隔离模型。

## 四、限流与配额

- 每分钟速率：响应头 `X-RateLimit-Limit/Remaining/Reset`；超限 **429** + `Retry-After`。
- 每日请求 / 每日 token 配额：超限 **429**（按 UTC 日切）。
- 输入大小上限：单请求约 20 万字符，超限 **400 `input_too_large`**。
- 错误体统一 OpenAI 式：`{"error":{"message","type","code"}}`。
- 错误码：`model_not_allowed` / `input_too_large` / `rate_limit_exceeded` / `daily_request_quota_exceeded` / `daily_token_quota_exceeded`。

## 五、可观测性

- 响应 `id` 形如 `chatcmpl-<requestId>`，**与服务端日志同源可回溯**。
- 响应 `usage`（prompt/completion/total tokens）随补全返回（流式在最后一个 chunk）。
- 管理后台「开放接口」tab 看每 Key 今日请求数 / token；专属模型降级会发站内管理预警。

## 六、暂未支持（见 doc/debt.open-api.md）

`/v1/embeddings`、成本/额度账本、单次生成回查 `/v1/generation`、并发上限。需要再排期。
</content>
