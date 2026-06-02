| fix | cds | 试运行验证修复(dogfood 发现):容器化 CDS 下 bind-mount 主机路径不一致导致 /workspace 空、所有真实仓库报"找不到 package.json"——改用 docker cp 装载代码;sh -lc 改 sh -c 修复 golang 等镜像 "go: not found"(login shell 重置 PATH) |
