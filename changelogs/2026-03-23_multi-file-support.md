| feat | prd-api | 文件上传自动检测文本/二进制：已知格式用提取器，其他尝试 UTF-8 解码，通过 null 字节和控制字符比例判断 |
| feat | prd-desktop | 三阶段文件上传体验：已知格式直接放行、已知二进制立即拒绝、未知格式标记"探测中"后上传并反馈结果 |
| feat | prd-desktop | 逐文件上传进度面板，实时显示每个文件的状态（排队/检测/上传/成功/失败） |
| feat | prd-admin | 附件和追加文档支持三阶段检测：已知放行、已知拒绝、未知格式客户端快速探测 null 字节 |
| refactor | prd-desktop | 移除文件格式白名单和 read_text_file 命令，所有文件统一走 upload 接口 |
