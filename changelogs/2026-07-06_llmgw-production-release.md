| ops | prd-agent | 生产发布脚本的不可变 commit 发布同步钉住 llmgw、llmgw-serve、llmgw-web 三个网关镜像，避免 API 已切 sha 但网关仍漂在 latest |
| ops | prd-agent | 发布 manifest 补充网关三镜像 ref，便于正式环境部署前后核对 |
| ci | prd-agent | branch-image 手动触发改为全组件构建，确保正式环境热修前能补齐同一 sha 的 API/Admin/GW 镜像组 |
