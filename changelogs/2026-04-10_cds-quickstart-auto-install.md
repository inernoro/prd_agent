| feat | cds | `./exec_cds.sh init` 现在自动检查并交互式安装依赖 (Node/pnpm/Docker/curl/openssl/python3)，缺失项给复制粘贴的安装命令 |
| feat | cds | 新增发行版检测 (Ubuntu/Debian/CentOS/Fedora/Arch/Alpine/macOS)，按发行版给对应的 apt/yum/dnf/pacman/apk/brew 安装命令 |
| feat | cds | Docker 检测区分"未安装"和"已安装但无权限"两种情况，后者给 `usermod -aG docker + newgrp docker` 修复步骤 |
| feat | cds | 依赖检查幂等：跑两次、跑到一半 Ctrl+C 再跑都能继续 |
| docs | project | 新增 `.claude/rules/quickstart-zero-friction.md` 原则：快启动必须大包大揽，假设使用者是小白，注册到 CLAUDE.md 规则索引 |
