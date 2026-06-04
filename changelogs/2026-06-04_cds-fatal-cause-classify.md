| fix | cds | 容器编译/构建失败导致就绪探测超时时，从容器日志抽取真实根因（如 error CS0101）点名到 errorMessage，不再只显示笼统的"就绪探测超时" |
| fix | cds | 分支卡片错误归类把"就绪探测超时/编译失败"正确归为「应用代码错误」，不再误落到「未分类错误」让用户误以为是 CDS 自身问题 |
| fix | cds | failure-diagnosis 新增 build-failed 归类（C#/TS/MSBuild 编译失败 → 代码侧）+ 兜底识别中文「就绪探测超时」 |
| refactor | cds | 漂移徽标「收敛」措辞改为「重新部署」，去掉用户看不懂的「异常收敛」内部术语 |
| feat | cds | 部署失败时把自动诊断的根因（如 error CS0101）+ 容器日志尾部写进 GitHub PR Check 的 output，sandbox agent 无需 CDS 凭据/网络即可经 GitHub 读到失败原因 |
| feat | cds | 被动授权:新增「请求密钥(cdsr_)+ 授权密钥」两级凭据 — Agent 持永久低权限请求密钥发起授权申请,右下角一键批准即派发全权授权密钥,Agent 凭它直接读项目环境变量/参数,无需用户反复手动喂参数 |
| feat | cds | 项目设置新增「授权密钥」tab 签发/吊销请求密钥;AppShell 右下角新增「授权申请」审批盒(复用 pending-import 被动审批底座 + SSE 实时刷新) |
| refactor | cds | 被动授权改为最短路径:删除「请求密钥」概念与项目设置「授权密钥」tab,改为 Agent 免密直接发起授权申请(按项目限量防刷)+ 一次性 pollToken 取结果,用户只需右下角一键批准,前置步骤归零 |
