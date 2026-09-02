| security | cds | 撤除 CDS_PREVIEW_AI_ACCESS_KEY 通道：项目级 env 跨分支共享，而进程级静态钥匙不带项目作用域，等价于让任一分支预览以管理员身份访问兄弟分支 |
| fix | cds | 运行记录的全局上限改为按任务均分，不再按全局新旧一刀切吃掉低频任务的历史 |
| fix | cds | 任务调度时间轴在窄屏包一层横滚容器，固定 352px 列宽不再被 overflow-hidden 裁掉 |
| docs | cds | debt.cds.md 去掉逐文件改法与用例构造，改写为判据与取舍；补记「Agent 没有免登录自测子实例预览的通道」 |
