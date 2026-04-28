| feat | prd-api | VideoGen 分镜级渲染模式覆盖：VideoGenScene 新增 RenderMode/DirectPrompt 等字段，Worker 按 effective mode 分发 Remotion 或单镜直出 |
| feat | prd-api | 新增 PUT /api/video-agent/runs/:id/render-mode 端点：任务级默认模式切换 + 可选同步覆盖全部分镜 |
| feat | prd-admin | UnifiedInputHero 把"生成方式"3 选 1 chip 从「高级设置」折叠区提到主区常驻，零摩擦可见 |
| feat | prd-admin | VideoAgentPage 分镜编辑页顶部新增"默认渲染模式"工具条 + 每张分镜卡片单独的模式 chip + 直出参数（Prompt/模型/时长/宽高/分辨率）面板，支持任意分镜单独切到 Remotion 或大模型直出，可混合渲染 |
