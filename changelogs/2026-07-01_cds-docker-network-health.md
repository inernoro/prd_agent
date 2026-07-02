| feat | cds | 新增 Docker 分支网络容量健康检查与维护页风险提示 |
| ops | cds | 安装脚本新增 Docker 地址池预检，提前提示 default-address-pools 扩容方案 |
| polish | cds | 将未知预览域名错误页改为“预览未部署”，避免误导为 CDS 删除 GitHub 分支 |
| fix | cds | 分支创建和部署完成前等待状态持久化，避免 CDS 自更新后预览分支丢失 |
| fix | cds | 为 mongo-split 全局状态增加总量裁剪，避免诊断日志撑爆 Mongo 单文档上限 |
| fix | cds | 热重启等待页不再套用发布版构建耗时，避免进度长期显示 1% |
