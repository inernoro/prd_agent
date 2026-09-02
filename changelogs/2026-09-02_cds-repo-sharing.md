| feat | cds | 一个仓库现在能绑第二个项目：link 与建项目各加一次显式确认（allowShared / allowSharedRepo），不带确认仍拦住 |
| fix | cds | 删分支 / 关 PR / 极速版镜像完成三条 webhook 事件改为分发到仓库下每个项目，此前只处理第一个且无任何报错 |
| feat | cds | 新增同仓关系判据（repo-sharing.ts）：算出兄弟项目、未声明范围的项目、真正撞在一起的数据库与缓存 |
| feat | cds | 项目接口透出 repoSharing（仅浏览器会话），列表一行小字、项目设置顶部一条、绑仓库时一次打断，三档强度分开 |
| feat | cds | 新增构建范围声明入口：此前 buildScope 只能走 API 改，界面上根本没有地方填 |
| fix | cds | CI 镜像结果缓存的键加上项目：镜像先于 push 到达时，此前第一个项目认领走之后第二个永远停在等待中 |
