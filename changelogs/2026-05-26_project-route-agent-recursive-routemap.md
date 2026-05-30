| fix | prd-api | GitRepoCacheService.ReadRoutemap 增加子目录递归搜索（BFS 深度 6，跳过 .git/node_modules/bin/obj/dist 等噪声目录），monorepo 中藏在 apps/x/routemap、services/y/routemap 的 routemap 现在也能被发现 |
| feat | prd-api | RoutemapSnapshot 新增 FoundLocations 字段：找到的所有 routemap 目录列表（相对仓库根）；文件 Path 也改为相对仓库根的完整路径，跨多个 routemap 时能区分来源 |
| feat | prd-api | SSE repo 事件 + Resolve LLM Prompt 都带上 FoundRoutemapDirs，让 AI / 用户能看到 routemap 实际所在子路径 |
| feat | prd-admin | 仓库栏新增「找到的 routemap 子目录」绿色 pill 列表展示 |
