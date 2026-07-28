| feat | prd-admin | 周报评论支持粘贴图片与图文结合：评论输入器升级为多行 composer（粘贴截图/选图上传/待发缩略图可删），评论区图片缩略图展示并可点击大图预览 |
| feat | prd-api | 周报评论新增图片附件：新增评论图片上传端点（有权查看即可上传），评论创建支持 attachmentIds（最多 9 张、归属校验、纯图无文字），列表批量解析附件详情返回 |
| refactor | prd-admin | 周报三处图片表单上传（富文本图/日报图/评论图）收敛为共用 uploadReportImageForm 实现 |
