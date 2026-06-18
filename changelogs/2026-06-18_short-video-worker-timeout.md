| fix | prd-api | 短视频 worker 单任务硬超时 16 分钟：即便某步意外挂死也强制失败该 run 并释放 worker，杜绝单任务饿死单线程 worker；视频下载器对显式非视频类型（text/html 分享/登录/防盗链页、image/*）直接拒绝而非改写成 mp4 存入非视频字节（Codex P2 二轮） |
