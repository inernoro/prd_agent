| fix | cds | 容器编译/构建失败导致就绪探测超时时，从容器日志抽取真实根因（如 error CS0101）点名到 errorMessage，不再只显示笼统的"就绪探测超时" |
| fix | cds | 分支卡片错误归类把"就绪探测超时/编译失败"正确归为「应用代码错误」，不再误落到「未分类错误」让用户误以为是 CDS 自身问题 |
| fix | cds | failure-diagnosis 新增 build-failed 归类（C#/TS/MSBuild 编译失败 → 代码侧）+ 兜底识别中文「就绪探测超时」 |
| refactor | cds | 漂移徽标「收敛」措辞改为「重新部署」，去掉用户看不懂的「异常收敛」内部术语 |
