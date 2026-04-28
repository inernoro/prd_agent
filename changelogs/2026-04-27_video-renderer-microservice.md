| feat | prd-video-renderer | 新建 Remotion 单镜渲染微服务（独立 prd-video-renderer/ 项目）：Express :5001 + 系统 Chromium，POST /render/scene 和 /render/full 端点；用 npx remotion render 内部 fork，5 分钟超时兜底，stderr 摘要返回 |
| refactor | prd-api | VideoGenRunWorker 不再 fork npx remotion 子进程；改为 HttpClient POST 到 video-renderer 容器，分镜预览（/render/scene）和最终导出（/render/full）走同一个微服务 |
| refactor | prd-api | Dockerfile 撤掉 Node.js + Chromium + prd-video 嵌入（之前为了 Remotion 加的），api 镜像恢复纯 dotnet/aspnet:8.0 干净基座，体积减重 ~250MB |
| feat | cds | cds-compose.yaml 撤掉之前给 api 容器灌 nodejs 的临时 hack，新增 video-renderer 服务（node:20-bullseye-slim + 挂载 prd-video + chromium 安装），独立运行 |
| feat | infra | docker-compose.yml + docker-compose.dev.yml 新增 video-renderer service，api 注入 VideoRenderer__Url 指向内网 :5001 |
