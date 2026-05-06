| fix | scripts | release-prepare 检测到工作区有非 changelog 改动时直接 abort（之前是警告但继续，导致后续 ./quick.sh release 因 dirty tree 拒绝执行，把用户卡在中间）。修复 PR #528 Codex review |
| fix | prd-admin | stopStreaming 补上 flushPendingChunks 调用，避免用户点停止按钮时把 RAF 缓冲里那一帧（~16ms）已 stream 但未刷屏的 token 静默丢弃。修复 PR #528 Bugbot review |
