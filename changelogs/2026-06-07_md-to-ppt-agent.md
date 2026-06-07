| feat | prd-api | 新增 MdToPptController（/api/md-to-ppt/convert SSE 流式生成 + /render + /publish 三端点），注册 AppCallerRegistry.MdToPptAgent.Generation.Convert |
| feat | prd-admin | 新增 Markdown 转网页 PPT 智能体页面（/md-to-ppt-agent），含三通道输入（手输/上传/知识库）、SSE 流式大纲生成、reveal.js 主题预览、逐页编辑、一键发布到网页托管 |
| fix | prd-admin | MD转PPT 预览改客户端渲染 reveal.js(免 /render 后端往返,即时预览不受代理层影响);发布契约对齐后端(发 htmlContent 而非 slides);新增团队多选(listMyTeams) |
| fix | prd-api | MD转PPT 修编译错误 PlatformId→ActualPlatformId(GatewayModelResolution 无 PlatformId) |
