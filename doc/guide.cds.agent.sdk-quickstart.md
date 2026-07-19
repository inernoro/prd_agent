# Claude Agent SDK Sidecar 接入 · 指南

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

本指南说明如何把外部 Claude Agent SDK sidecar 接入本地或 CDS/MAP 调度。密钥只通过环境变量或受控配置提供。

## 1. 前置条件

- Docker 与 Docker Compose 可用。
- 已获得合法的 Anthropic 或兼容上游凭据。
- 本地开发使用 `.env`，生产使用受控秘密配置。
- 需要远程调度时，CDS 与 MAP 已完成配对。

## 2. 本地启动

在本地环境文件中配置 `ANTHROPIC_API_KEY`，然后启动开发栈：

```bash
docker compose -f docker-compose.dev.yml up -d --build
docker exec prdagent-claude-sidecar curl -fsS http://localhost:7400/readyz
```

不要把真实密钥写入命令历史、文档或提交文件。

## 3. 工作流使用

在工作流编辑器中选择 `claude-sdk` 执行器，配置模型、提示词、允许的工具和最大轮次。执行器配置的字段和默认值以 sidecar schema 与现有节点实现为准，不在文档维护完整 JSON。

最小验收：

- Sidecar `readyz` 返回就绪。
- API 能发现至少一个可用实例。
- 工作流节点收到持续 SSE 事件并进入明确终态。
- 工具调用只使用节点允许的工具。

## 4. 兼容上游

需要兼容 Anthropic 协议的其他上游时，可通过 `ANTHROPIC_BASE_URL` 或受控 profile 配置。每个 profile 单独维护端点、密钥引用和允许模型。

```bash
cp claude-sdk-sidecar/profiles.example.yaml claude-sdk-sidecar/profiles.yaml
docker compose -f docker-compose.dev.yml up -d --force-recreate claude-sidecar
```

`profiles.yaml` 已被忽略，但仍应按秘密文件管理。不要在工作流正文中直接写密钥。

## 5. 远程 Sidecar

远程实例通过稳定 HTTPS 地址和强随机 token 接入。生产部署要求：

- Sidecar 的健康和就绪接口可从 API 网络访问。
- Token 与业务 API 密钥分离并可轮换。
- Callback 地址只暴露必要接口。
- 路由标签和权重由运行配置管理。
- 单个实例下线时调度能转向其他健康实例。

## 6. CDS/MAP 配对

推荐路径是由 CDS 管理 sidecar 实例，MAP 通过有效配对记录发现项目级实例并合并到路由池。验证时检查：

1. CDS remote host 和 shared-service project 有效。
2. executor 能调度承载 sidecar 的实例。
3. MAP 使用配对 long token 获取实例发现。
4. 路由池中实例来源标记为 CDS 配对。
5. 本地执行器关闭时，远程实例仍可被正确选择。

## 7. 故障定位

| 现象 | 检查 |
|---|---|
| Sidecar 未就绪 | 密钥、上游地址、容器日志 |
| API 找不到实例 | Sidecar 配置、网络、token 和健康检查 |
| MAP 无远程实例 | 配对状态、long token、项目实例发现 |
| 工具调用失败 | 工具白名单、回调地址和权限 |
| SSE 中断 | Forwarder、超时、心跳和服务端终态 |

具体配置结构以 `claude-sdk-sidecar/`、API 配置类和相关测试为事实源。
