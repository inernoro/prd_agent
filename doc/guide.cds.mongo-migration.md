# CDS 状态存储迁移到 MongoDB · 指南

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

本指南用于把 CDS 状态从 `state.json` 切换到 MongoDB。新安装优先在初始化向导中选择 MongoDB；存量环境迁移前必须备份并验证回滚。

## 1. 场景

| 场景 | 路径 |
|---|---|
| 新安装 | 运行 `init` 并选择 MongoDB |
| 存量 JSON | 备份后通过存储模式 API seed 并切换 |
| 已切换但重启回退 | 检查环境文件加载和持久化状态 |

## 2. 新安装

```bash
cd cds
./exec_cds.sh init
./exec_cds.sh start
```

在向导中选择持久化 MongoDB。脚本负责容器、连接信息和环境文件；完成后健康信息应显示 Mongo backend。

## 3. 存量迁移

迁移顺序：

1. 停止高风险管理操作并备份 `state.json`。
2. 准备独立 MongoDB 和持久化卷。
3. 使用存储模式测试接口验证连接。
4. 调用 switch-to-mongo，并要求从 JSON seed。
5. 确认响应表明环境配置已持久化。
6. 重启 CDS 后再次核对 backend 和核心对象数量。

API 路径、请求字段和鉴权方式以当前 CDS 路由及 cdscli 为准，文档不保存带密钥的 curl 脚本。

## 4. 验证

```bash
./exec_cds.sh status
curl -fsS https://cds.example.com/healthz
```

至少核对：

- 存储模式为 Mongo，健康检查成功。
- 项目、分支、服务、凭据引用和运行记录数量合理。
- 创建一条可回收测试记录后，重启仍可读取。
- 原 JSON 备份未被覆盖。
- 生产流量和 Worker 没有出现持续错误。

## 5. 回滚

MongoDB 不健康或数据核对失败时，使用受控的 switch-to-json 操作恢复 JSON backend，并恢复迁移前备份。回滚后保留失败数据库用于调查，不立即删除。

回滚完成标准：

- 健康信息显示 JSON backend。
- 核心对象和分支状态可读取。
- Master 与 Forwarder 正常。
- 失败原因已记录到对应债务。

## 6. 备份

- JSON 迁移前创建带时间的只读备份。
- MongoDB 使用 `mongodump` 或平台备份能力。
- 备份保存位置与运行数据分离。
- 恢复流程应在非生产环境验证。
- 连接串和凭据不得写入文档或提交。

## 7. 常见问题

| 现象 | 检查 |
|---|---|
| 重启后回到 JSON | `.cds.env` 是否被进程加载 |
| 测试连接成功但切换失败 | 数据库权限、seed 过程和持久化写入 |
| 数量不一致 | seed 日志、旧备份和集合写入错误 |
| Mongo 容器未启动 | 容器配置、卷和启动脚本 |

存储实现和兼容读取以 CDS state store 源码及测试为事实源。
