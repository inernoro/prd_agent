| fix | deploy | exec_dep.sh 优先探测宿主机已有 ffmpeg (/usr/local/bin/ffmpeg 等)，仅在不存在时下载静态版 |
| feat | prd-api | VideoAgent 新增 "videogen" 直出模式：通过 OpenRouter 视频 API 调用 Seedance / Wan / Veo / Sora，保留 Remotion 路径不变 |
| feat | prd-api | 新增 IOpenRouterVideoClient + OpenRouterVideoClient（异步 submit + 轮询，按秒计费） |
| feat | prd-api | VideoGenRun 模型新增 RenderMode / DirectPrompt / DirectVideoModel / DirectAspectRatio / DirectResolution / DirectDuration / DirectVideoJobId / DirectVideoCost 字段 |
| feat | prd-api | VideoGenRunWorker 新增 ProcessDirectVideoGenAsync 分支，不影响原 Scripting/Rendering 流程 |
| feat | deploy | docker-compose.yml + dev.yml 注入 OpenRouter__ApiKey 与 OpenRouter__BaseUrl 环境变量 |
| feat | prd-admin | VideoAgentPage 顶部新增模式切换条（分镜模式 / 直出模式），Remotion 原流程保留不变 |
| feat | prd-admin | 新增 VideoGenDirectPanel 沉浸式直出面板：prompt 输入 + 模型/时长/比例/分辨率选择 + 实时进度 + MP4 内嵌播放 |
