| fix | cds | self-update 改用 `git reset --hard origin/<branch>` 代替 `git pull`,避免本地分叉时生成 merge commit 静默丢失远端文件变更(实测 settings.js 436 行新增被 merge 策略吞掉导致 UI 不生效) |
