# 消息队列 Demo - RabbitMQ (AMQP)

一个最小的消息队列演示：前端投递消息 → RabbitMQ 队列 → 后端消费者异步处理 → 实时回显。
全部通过官方镜像 + `command` + bind-mount 一键部署，无 Dockerfile、无 build 步骤。

## 演示了什么

- **静态前端**（`node:20-alpine` + `npx serve`）：一个「发送消息」表单 + 每 2 秒轮询的
  已处理消息列表。
- **Node + Express 后端** 用 `amqplib` 同时作生产者与消费者：`POST /api/publish` 把消息
  投递到持久化队列 `demo.messages`，一个常驻消费者把队列里的消息取出存入内存列表。
- **RabbitMQ** 带管理插件，演示真实的「投递 → 入队 → 消费」往返。

## 基础设施

| 服务 | 镜像 | 端口 | 说明 |
|------|------|------|------|
| rabbitmq | `rabbitmq:3-management-alpine` | 5672 (AMQP) / 15672 (管理台) | 命名卷 `rabbitmq-data` |

连接串走 `x-cds-env` 的 `RABBITMQ_URL`，service 用 `${VAR}` 引用，密码不写死在 service env。

## 应用与端点

| 服务 | 路由前缀 | 容器端口 | 端点 |
|------|----------|----------|------|
| frontend | `/` | 4173 | 发送消息页面 |
| backend | `/api/` | 3000 | `GET /api/health`、`POST /api/publish`、`GET /api/messages` |

- `GET /api/health` — 返回 broker 连接状态与已处理消息数
- `POST /api/publish` — 投递一条消息（body: `{ "text": "..." }`）
- `GET /api/messages` — 返回消费者已处理的消息（newest first）

## 验证一键导入 / 评分

```bash
python3 ../../../.claude/skills/cds/cli/cdscli.py verify .
```

## 「跑通了」的信号

1. 打开前端（`/`），顶部状态标签显示「RabbitMQ 已连接」。
2. 在表单里输入文字点「发送消息」，1 秒内「已处理消息」列表出现该条（说明它经过了队列又被消费）。
3. `GET /api/health` 返回 `{"ok": true, "broker": "connected"}`。
4. RabbitMQ 重启后队列持久化，已投递但未消费的消息不丢。
