# PRD Agent 快速部署 · 指南

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

本指南提供仓库自托管的最短启动路径。依赖检测、环境文件和 Nginx 配置由 `exec_cds.sh` 统一处理。

## 1. 前置条件

- Linux 或支持 Docker 的本地环境。
- Docker 与 Docker Compose 可用。
- 仓库目录可写。
- 公网部署时已准备域名和 DNS。

## 2. 初始化与启动

在仓库根目录执行：

```bash
./exec_cds.sh init
./exec_cds.sh start
```

`init` 会交互式生成环境配置并渲染代理配置；`start` 启动 CDS 与所需基础设施。不要手工复制其他环境的秘密文件。

如在 `cds/` 目录操作，使用同名脚本即可。

## 3. 验证

```bash
./exec_cds.sh status
curl -fsS http://127.0.0.1:9900/healthz
```

通过标准：

- CDS 状态为运行中。
- 健康接口返回成功。
- Dashboard 可以打开。
- 已部署分支的预览域名能到达对应服务或明确的加载页。

## 4. 常用维护

| 动作 | 命令 |
|---|---|
| 查看状态 | `./exec_cds.sh status` |
| 跟随日志 | `./exec_cds.sh logs` |
| 重启 | `./exec_cds.sh restart` |
| 停止 | `./exec_cds.sh stop` |
| 签发或续签证书 | `./exec_cds.sh cert` |

命令选项以 `./exec_cds.sh --help` 为准，文档不复制完整脚本帮助。

## 5. 失败处理

- Docker 不可用：先修复 Docker，再重新执行 `init`。
- 配置缺失：查看脚本输出指向的环境文件，不在聊天或日志中暴露秘密。
- 端口占用：确认 9900、代理端口和基础设施端口的占用者。
- 域名不可达：依次核对 DNS、证书、Nginx 和服务健康。
- 初始化中断：修复明确错误后重复执行，脚本应保持幂等。

集群扩容、Forwarder 和存储迁移分别见对应专项指南。
