# CDS Forwarder 部署与迁移 · 指南

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

Forwarder 是 CDS 业务预览流量的数据面。它读取 master 发布的路由文件，使 master 更新期间的业务转发保持稳定。管理界面仍由 master 提供。

## 1. 前置条件

- Master 已通过 systemd 安装并正常运行。
- Nginx 容器和 CDS 路由文件目录可用。
- 操作者有宿主机 sudo 权限。
- 已安排代理切换与回滚窗口。

## 2. 安装

```bash
cd /path/to/prd_agent/cds
sudo ./exec_cds.sh install-forwarder
sudo systemctl start cds-forwarder
sudo systemctl restart cds-master
sudo CDS_USE_FORWARDER=1 ./exec_cds.sh nginx-render
```

使用当前部署方式把渲染后的 Nginx 配置加载到代理，并先执行 `nginx -t`。具体容器名和路径以该环境的脚本输出为准。

## 3. 验证

```bash
curl -fsS http://127.0.0.1:9090/__forwarder/healthz
systemctl status cds-forwarder cds-master
```

通过标准：

- Forwarder 健康响应中的路由数量大于零。
- Nginx upstream 指向 Forwarder。
- 至少一个真实预览深链返回业务页面。
- 重启 master 时已就绪的预览流量仍可访问。
- Master 恢复后路由文件继续更新。

## 4. 迁移

迁移到新服务器时按顺序执行：

1. 记录旧机配置、路由和健康状态。
2. 在新机安装并验证 master。
3. 安装 Forwarder，让 master 发布路由。
4. 在新机本地验证健康和真实预览。
5. 切换 Nginx 或入口流量。
6. 观察错误率后再卸载旧机 Forwarder。

不要先卸载旧机再验证新机。

## 5. 卸载与回滚

```bash
cd /path/to/prd_agent/cds
sudo ./exec_cds.sh uninstall-forwarder
```

卸载脚本应恢复 master 直连配置。完成后重新渲染 Nginx、校验配置并验证业务域名。残留路由文件只在确认 publisher 已停止后清理。

## 6. 故障定位

| 现象 | 检查 |
|---|---|
| 路由数为零 | master publisher、路由文件路径和权限 |
| 健康但预览失败 | Nginx upstream、Host、目标服务健康 |
| master 重启仍中断 | 流量是否实际经过 Forwarder |
| 路由不更新 | 文件原子发布、mtime、Forwarder reload |
| systemd 启动失败 | 环境文件、用户权限、端口占用 |

实现和服务单元以 `cds/` 脚本及源码为事实源。
