| fix | prd-api | 更新中心关联缺陷反查兼容短 commit id |
| feat | prd-api | 新增缺陷自动化长期授权确保接口 |
| fix | prd-api | 缺陷自动化单次运行跳过已完成或失败的缺陷 |
| fix | prd-api | 缺陷自动化连接器授权复用检查补充过期与撤销判断 |
| security | prd-api | 缺陷自动化写入端点增加运行记录、目标缺陷和验收 trace 权限边界 |
| security | prd-api | 新增 defect-agent:share 窄 scope，仅允许访问缺陷分享端点 |
| fix | prd-admin | 缺陷分享临时密钥申请 scope 改为 defect-agent:share |
| feat | prd-api | 缺陷来源连接器返回单缺陷和轻量修复机读策略 |
| docs | prd-api | 更新 ai-defect-resolve 技能到 1.4.0 |
| fix | cds | API 预览服务补充就绪超时配置，避免冷启动被误判为 503 |
| fix | cds | Admin 静态预览改用锁定的 serve 依赖启动，避免 npx 动态安装后端口未监听 |
| feat | prd-api | 新增缺陷自动化控制台接口，返回长期授权、运行历史、统计和每日计划模板 |
| feat | prd-admin | 缺陷页面新增缺陷自动化控制台，支持一键生成并复制长期授权每日计划 |
| docs | skills | ai-defect-resolve 改为优先使用缺陷页面自动化入口生成永不过期授权 |
| ops | cds | Admin 预览容器改为从仓库根目录进入 prd-admin 启动，避免源码模式缺少 package.json |
| fix | prd-api | 缺陷自动化 commit 回写优先使用长期 K 标识，确保发布后验收和通知可继续查询 |
