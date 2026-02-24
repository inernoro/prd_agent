# PRD Agent 快速部署指南

## 一条命令

```bash
./exec_bt.sh -d
```

完成后访问 Dashboard 激活一个分支，然后通过公网 IP 访问应用。

## 所有命令

```bash
./exec_bt.sh                # 前台（调试）
./exec_bt.sh -d             # 后台（部署）
./exec_bt.sh --test         # 自检（T01-T41 全部 PASS 才正常）
./exec_bt.sh --status       # 看状态
./exec_bt.sh --stop         # 停止
```

## 自定义

```bash
ROOT_ACCESS_PASSWORD="xxx" ./exec_bt.sh -d       # 改密码
NGINX_APP_PORT=8080 ./exec_bt.sh -d              # 改端口（80 被占时）
SKIP_NGINX=1 ./exec_bt.sh -d                     # 不碰 nginx
BT_USERNAME=admin BT_PASSWORD=secret ./exec_bt.sh -d  # Dashboard 加认证
```

## 默认值

| 项 | 值 |
|----|-----|
| 管理员 | `admin` / `PrdAgent123!` |
| 应用端口 | `:80` (nginx) → `:5500` (gateway) |
| Dashboard | `:9900` (直连，无 nginx) |
| 资产存储 | `local` |

## 部署后

1. 访问 `http://IP:9900` → 激活一个分支
2. 访问 `http://IP` → 登录应用
3. 管理后台 → 模型管理 → 初始化应用

## 详细架构

见 [doc/arch.exec-bt.md](arch.exec-bt.md) — 含冲突矩阵、测试用例、字符架构图。
