| fix | scripts | release-prepare CHANGELOG 重写：当 [未发布] 上一行非空时，分隔空行误用 append 加到了下方（应在上方）。改为 insert(0, '')。当前 CHANGELOG 格式不触发但写错了。修复 PR #528 Bugbot review |
