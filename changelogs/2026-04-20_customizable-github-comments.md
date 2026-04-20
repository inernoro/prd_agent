| feat | cds | 新增可自定义 GitHub PR 预览评论模板（/api/comment-template + Settings 面板「评论模板」Tab），支持 {{branch}}/{{previewUrl}}/{{prUrl}}/{{prReviewUrl}} 等 9 个动态变量；{{prReviewUrl}} 从当前分支预览地址自动拼接 /pr-review 路径，无需配置独立域名 |
| feat | prd-admin | PR 审查页支持深链自动发起审查（?prUrl=&autoStart=1），配合 CDS 默认模板的 {{prReviewUrl}} 实现从 GitHub 评论一键跳转 + 自动添加 PR |
