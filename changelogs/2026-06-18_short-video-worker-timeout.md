| fix | prd-api | 视频下载器对显式非视频类型（text/html 分享/登录/防盗链页、image/*）直接拒绝而非改写成 mp4 存入非视频字节，避免 source 假成功 + 卡片/ASR 误导性失败；仅 缺失/application/octet-stream 归一成 video/mp4（Codex P2 二轮） |
