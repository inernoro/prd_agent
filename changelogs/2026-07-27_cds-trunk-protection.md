| fix | cds | 修复 janitor 把主干分支（main/master）当过期分支整条删除的 P0 事故：分支保护判定收敛为唯一 SSOT（branch-protection.ts），janitor 与 scheduler 共用同一份，不再漂移 |
| fix | cds | janitor 保护判定改为 per-project：按 branch.projectId 查项目默认分支与 gitDefaultBranch，A 项目主干不再因 B 项目配置而失去保护 |
| fix | cds | GitHub delete webhook 增加主干兜底：主干分支拒绝自动停容器与删除分支条目，只记录拒绝原因 |
| feat | cds | janitor sweep 报表与快照新增 skippedProtected（受保护而免删的过期分支 + 原因）与 protectedTrunkBranches，主干保护是否生效可见不再静默 |
| test | cds | 新增分支保护回归测试：defaultBranch 未配置时 main/master 受保护、多项目隔离、普通分支仍正常回收、webhook 主干拒删 |
| fix | cds | 补齐用户一键触发的删分支路径的主干保护：POST /cleanup、POST /cleanup-orphans、POST /branches/cleanup-stopped 一律先过 branch-protection SSOT，不再只比对全局 state.defaultBranch，多项目下点一次清理不会再删掉项目主干 |
| fix | cds | cleanup-orphans 增加 fetch 异常守卫：远端分支集合为空时判定为 fetch 异常并中止该项目清理，杜绝「远端一个分支都没有」被解释成「本地全都是孤儿」而整批删除 |
| fix | cds | 恢复出厂设置默认保留各项目主干分支，需显式 confirmTrunk=1 才连主干一并清除；两种情况都在 SSE 与响应里逐条列明保留/删除的主干 |
| feat | cds | 清理类接口回传 skippedProtected（保住了谁、凭什么保住），与 janitor 报表同口径，保护可见 |
| perf | cds | janitor 保护跳过日志改为仅状态变化时输出，主干等永久受保护分支不再每轮 sweep 复读同一行淹没有效信号 |
| test | cds | 新增一键清理路径主干保护回归（cds/tests/routes/trunk-protection-cleanup.test.ts，10 例事故值用例）与 janitor 日志去噪回归 |
