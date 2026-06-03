# 事件流 Demo - Kafka (KRaft 单节点)

一个最小的事件流演示：前端生产事件 → Kafka 主题 → 后端消费者读取 → 实时回显。
Kafka 跑在 **KRaft 模式（单节点，无 Zookeeper）**。全部通过官方镜像 + `command` + bind-mount
一键部署，无 Dockerfile、无 build 步骤。

## 演示了什么

- **静态前端**（`node:20-alpine` + `npx serve`）：一个「生产事件」表单 + 每 2 秒轮询的
  已消费事件流列表。
- **Node + Express 后端** 用 `kafkajs` 作生产者与消费者：`POST /api/produce` 写入主题
  `demo.events`，消费组 `demo-stream-consumer` 从头读取并存入内存列表。后端启动时自动建主题。
- **单节点 Kafka（KRaft）** 同一个容器兼任 broker + controller，容器网络内通过 `kafka:9092` 访问。

## 基础设施

| 服务 | 镜像 | 端口 | 说明 |
|------|------|------|------|
| kafka | `apache/kafka:3.7.0` | 9092 | KRaft 单节点，命名卷 `kafka-data`，`KAFKA_*` 为非密钥调优参数 |

broker 地址走 `x-cds-env` 的 `KAFKA_BROKERS`，后端用 `${KAFKA_BROKERS}` 引用。Kafka 的 `KAFKA_*`
环境变量是非敏感的副本/监听器调优，按约定可用字面量；连接地址仍走 `x-cds-env`。

## 应用与端点

| 服务 | 路由前缀 | 容器端口 | 端点 |
|------|----------|----------|------|
| frontend | `/` | 4173 | 生产事件页面 |
| backend | `/api/` | 3000 | `GET /api/health`、`POST /api/produce`、`GET /api/events` |

- `GET /api/health` — 返回 broker 连接状态、broker 列表、topic、已消费事件数
- `POST /api/produce` — 生产一条事件（body: `{ "text": "..." }`）
- `GET /api/events` — 返回消费者已读取的事件（newest first）

## 验证一键导入 / 评分

```bash
python3 ../../../.claude/skills/cds/cli/cdscli.py verify .
```

## 「跑通了」的信号

1. 打开前端（`/`），顶部状态标签显示「Kafka 已连接」（KRaft 单节点首次启动需要几十秒，期间显示「连接中」属正常）。
2. 在表单里输入文字点「生产事件」，1 秒内「已消费事件流」出现该条（说明它经过了 Kafka 主题又被消费）。
3. `GET /api/health` 返回 `{"ok": true, "broker": "connected", "topic": "demo.events"}`。
