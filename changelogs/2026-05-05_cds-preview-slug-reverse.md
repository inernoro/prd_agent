| fix | cds | auto-build 路径补 v3 / v2 预览 slug 反向解析，子域名首次访问也能从 host 还原带 / 的真实分支名（如 `audio-upload-asr-tgr1f-claude-prd-agent` → `claude/audio-upload-asr-TGR1f`），不再误报"远程仓库中未找到分支" |
| test | cds | WorktreeService.findBranchByPreviewSlug 单测覆盖 v1/v2/v3 三档 + 多项目候选 + git 失败兜底，共 7 条用例 |
