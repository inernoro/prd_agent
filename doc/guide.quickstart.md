# PRD Agent 快速部署 · 指南

## 一键初始化 + 启动

```bash
cd cds
./exec_cds.sh init      # 交互式写入 .cds.env，并自动生成 nginx 配置
./exec_cds.sh start     # 默认后台启动 CDS + Nginx
./exec_cds.sh cert      # (可选) 为所有根域名签发 Let's Encrypt 证书
```

也可以从仓库根目录直接调用（本质上是转发到 `cds/exec_cds.sh`）：

```bash
./exec_cds.sh init
./exec_cds.sh start
```

## 常用命令

```bash
./exec_cds.sh init          # 交互式初始化 (写 .cds.env，渲染 nginx)
./exec_cds.sh start [--fg]  # 启动 CDS + Nginx (默认后台；--fg 前台)
./exec_cds.sh stop          # 停止 CDS + Nginx
./exec_cds.sh restart       # 重启
./exec_cds.sh status        # 查看运行状态
./exec_cds.sh logs          # 跟随 CDS 日志
./exec_cds.sh cert          # 签发/续签 Let's Encrypt 证书
```

## 多域名

`CDS_ROOT_DOMAINS` 支持逗号分隔多个根域名，每个根域名 `D` 自动生成三条路由：

```
D          → Dashboard
cds.D      → Dashboard (别名)
*.D        → Preview   (任意子域名 → 分支预览)
```

例：`CDS_ROOT_DOMAINS="miduo.org,mycds.net"` 同时支持：

- `miduo.org` / `cds.miduo.org` / `branch-x.miduo.org`
- `mycds.net` / `cds.mycds.net` / `branch-x.mycds.net`

切换根域名？编辑 `cds/.cds.env` → `./exec_cds.sh restart`。

## 默认值

| 项 | 值 |
|----|-----|
| 管理员 | 初始化时交互输入 |
| Dashboard 端口 | `:9900` |
| Gateway 端口 | `:5500` |
| Nginx 容器名 | `cds_nginx` |
| 环境变量文件 | `cds/.cds.env` |

## 部署后

1. 访问 `https://<你的根域名>` 或 `http://<IP>:9900` → 登录 Dashboard → 配置环境变量 → 激活分支
2. 访问 `https://<分支名>.<你的根域名>` → 分支预览
3. 管理后台 → 模型管理 → 初始化应用

## 详细文档

- 环境变量配置：[doc/guide.cds-env.md](guide.cds-env.md)
- CDS 架构设计：[doc/design.cds.md](design.cds.md)
