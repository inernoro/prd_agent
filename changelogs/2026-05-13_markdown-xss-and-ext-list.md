| fix | prd-api | 安全：BuildMarkdownWrapper 启用 Markdig `.DisableHtml()`，阻止用户上传的 .md 文件透传原始 `<script>` 块执行 XSS（Cursor PR #598 review） |
| fix | prd-api | 网页托管不支持类型错误消息补全：增加 .markdown / .m4v / .ogg / .ogv，与后端 VideoExtensions + MarkdownExtensions 实际接受范围一致 |
