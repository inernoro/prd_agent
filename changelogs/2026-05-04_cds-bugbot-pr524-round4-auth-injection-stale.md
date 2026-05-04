| fix | cds | 修复 [项目环境变量] /api/branches/:id/effective-env/reveal 缺 assertProjectAccess 导致项目隔离绕过(Bugbot High security):项目 A 的 cdsp_xxx key 能 reveal 项目 B 的 secret 明文,redact 设计被绕开。补加 assertProjectAccess 与 list 端点同级 |
| fix | cds | 修复 docker stats 容器名拼接命令注入(Bugbot Medium):JSON.stringify 不是 shell-safe(双引号串里 $(...)/反引号仍展开),改 [a-zA-Z0-9][a-zA-Z0-9_.-]* 白名单 regex 拒绝任何不合法名字 |
| fix | cds | 修复切分支时 in-flight metrics 请求污染新分支 ring buffer(Bugbot Medium):loadMetrics 起点 capture branchId,resolve 时对 branchIdRef.current 校验,不一致直接丢弃 |
| refactor | cds | reveal 与 list 端点 env 合并逻辑共享 buildBranchEnvMap helper(Bugbot Medium):共用 builder 杜绝两端 source 判定漂移 |
