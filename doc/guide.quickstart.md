# PRD Agent 快速部署指南

## 一键配置（推荐）

```bash
cd cds
./exec_setup.sh          # 交互式引导配置（账号、域名、Nginx）
source ~/.bashrc
./exec_cds.sh --background
```

完成后访问 Dashboard 激活一个分支，然后通过公网域名访问应用。

## CDS 命令

```bash
cd cds
./exec_cds.sh                # 前台运行
./exec_cds.sh --background   # 后台运行
```

或使用根目录入口脚本：

```bash
./exec_cds.sh                # 前台（调试）
./exec_cds.sh dev            # 开发（热重载）
./exec_cds.sh -d             # 后台（部署）
./exec_cds.sh --status       # 看状态
./exec_cds.sh --stop         # 停止
```

## 自定义

```bash
CDS_USERNAME=admin CDS_PASSWORD=secret ./exec_cds.sh -d   # Dashboard 加认证
SKIP_NGINX=1 ./exec_cds.sh -d                             # 不碰 nginx
```

## 默认值

| 项 | 值 |
|----|-----|
| 管理员 | `admin` / `PrdAgent123!` |
| 应用端口 | `:80` (nginx) → `:5500` (gateway) |
| Dashboard | `:9900` (直连，或 `cds.domain.com`) |
| 资产存储 | `local` |

## 部署后

1. 访问 `https://cds.domain.com` (或 `http://IP:9900`) → 配置环境变量 → 激活分支
2. 访问 `https://domain.com` (或 `http://IP:5500`) → 登录应用
3. 管理后台 → 模型管理 → 初始化应用

## 详细文档

- 环境变量配置：[doc/guide.cds-env.md](guide.cds-env.md)
- CDS 架构设计：[doc/design.cds.md](design.cds.md)
- 部署冲突分析：[doc/design.exec-bt-deployment.md](design.exec-bt-deployment.md)
