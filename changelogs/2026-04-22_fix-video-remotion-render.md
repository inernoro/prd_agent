| fix | prd-api | Dockerfile 安装 Node.js 20 + pnpm，嵌入 prd-video 源码及依赖，修复 Remotion 渲染 npx 找不到问题 |
| fix | docker-compose | 构建上下文改为仓库根，新增 VideoAgent__RemotionProjectPath=/prd-video 环境变量 |
| fix | ci | server-deploy.yml 构建上下文改为仓库根，触发路径加入 prd-video/** |
