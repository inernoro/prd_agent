# 发布订阅 Demo - NATS

一个最小的发布/订阅演示：前端发布消息 → NATS 主题 → 后端订阅者实时接收 → 回显。
全部通过官方镜像 + `command` + bind-mount 一键部署，无 Dockerfile、无 build 步骤。

## 演示了什么

- **静态前端**（`node:20-alpine` + `npx serve`）：一个「发布消息」表单 + 每 2 秒轮询的
  已接收消息列表。
- **Node + Express 后端** 用 `nats` 包作发布者与订阅者：`POST /api/pub` 在主题
  `demo.events` 上发布，一个常驻订阅者实时接收并存入内存列表。
- **NATS** 单节点、无鉴权，演示最轻量的实时 pub/sub。

## 基础设施

| 服务 | 镜像 | 端口 | 说明 |
|------|------|------|------|
| nats | `nats:2-alpine` | 4222 | 无密码，容器网络内通过服务名 `nats` 访问 |

连接地址走 `x-cds-env` 的 `NATS_URL`，后端用 `${NATS_URL}` 引用。

## 应用与端点

| 服务 | 路由前缀 | 容器端口 | 端点 |
|------|----------|----------|------|
| frontend | `/` | 4173 | 发布消息页面 |
| backend | `/api/` | 3000 | `GET /api/health`、`POST /api/pub`、`GET /api/sub` |

- `GET /api/health` — 返回 broker 连接状态、subject、已接收消息数
- `POST /api/pub` — 发布一条消息（body: `{ "text": "..." }`）
- `GET /api/sub` — 返回订阅者已接收的消息（newest first）

## 验证一键导入 / 评分

```bash
python3 ../../../.claude/skills/cds/cli/cdscli.py verify .
```

## 「跑通了」的信号

1. 打开前端（`/`），顶部状态标签显示「NATS 已连接」。
2. 在表单里输入文字点「发布消息」，几乎即时「已接收消息」列表出现该条（说明它经过了 NATS 主题又被订阅者收到）。
3. `GET /api/health` 返回 `{"ok": true, "broker": "connected", "subject": "demo.events"}`。

> 说明：NATS（非 JetStream）是「发后即忘」的实时投递——若发布时还没有订阅者，那条消息不会被补发。
> 本 demo 后端启动即订阅，正常使用顺序下消息都会被接收到。
