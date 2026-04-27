| refactor | prd-api | 视频生成 Agent 彻底砍掉 Remotion 拆分镜路径，只保留 OpenRouter 视频大模型直出。VideoGenRunWorker 从 2473 行简化到 ~250 行；VideoGenModels/IVideoGenService/VideoGenService 同步精简；VideoAgentController 删除分镜/渲染相关端点 |
| refactor | prd-admin | 视频 Agent 前端去掉分镜编辑 UI，VideoAgentPage 改为 VideoGenDirectPanel + HistoryDrawer 薄壳；删除 UnifiedInputHero、videoModeDetect.ts 和 contracts 中所有 scene/RenderMode 类型 |
| chore | repo | 删除整个 prd-video/（Remotion 项目）和 prd-video-renderer/（短暂存在的过渡微服务）目录 |
| chore | infra | cds-compose.yaml + docker-compose.yml + docker-compose.dev.yml 撤掉 video-renderer service + VideoRenderer__Url 注入；prd-api/Dockerfile 已无 prd-video 嵌入 |
