| fix | cds | 站内信陈旧通知清理:通知面板打开时对引用的项目探活,项目已删除(404)的通知自动移除,不再让用户点「查看推荐方式」落到已失效项目的 404 页;项目元信息降级(fallback)期间不再新发携带死链的通知 |
| fix | cds | 分支失败归因补全:detectContainerFatalCause 新增 Flyway 迁移失败/exit 137/139/signal 9(代码侧)与 OOM(配置侧)模式,就绪探测日志取样窗口 80 行扩到 400 行;Spring/Flyway 应用崩溃不再被误标成「就绪探测超时」甩锅 CDS |
| test | cds | 新增 Flyway/exit-137/OOM 归因回归测试 |
