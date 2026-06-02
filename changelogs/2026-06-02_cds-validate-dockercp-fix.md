| fix | cds | 试运行验证修复(dogfood 发现):容器化 CDS 下 bind-mount 主机路径不一致导致 /workspace 空、所有真实仓库报"找不到 package.json"——改用 docker cp 装载代码;sh -lc 改 sh -c 修复 golang 等镜像 "go: not found"(login shell 重置 PATH) |
| fix | cds | 试运行端口探活改用 /proc/net/tcp(不依赖镜像有 wget/curl)——python:slim 跑 Flask 起来了却被误判"端口未响应"的假告警修复 |
| feat | cds | 试运行失败时按日志智能提示根因(缺 package.json/requirements.txt/Go 主包→可能在子目录;NETSDK 版本不匹配;端口占用;缺命令)而非只报退出码 |
