| feat | cds | 新增 POST /api/self-force-sync 自愈端点: git fetch + reset --hard origin/<branch> + 清 dist/.build-sha + 重启,彻底解决本地 git 分叉导致 self-update pull merge 丢远端改动的问题 |
| feat | cds | 项目 Settings → 危险区新增「强制同步 CDS 源码到 origin」卡片: 输入分支名 + 确认 + SSE 实时进度,再也不用 SSH 到服务器敲 git reset |
