| fix | cds | 将 .cds/state.json 从 Git 跟踪中移除并加入 .gitignore，防止敏感环境变量（JWT Secret、云存储密钥等）泄露到仓库 |
| fix | cds | API 端点 GET /build-profiles 和 GET /env 返回值中对敏感字段进行脱敏处理 |
