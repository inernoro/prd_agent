| feat | cds | 热更新新增 dotnet-restart 模式：kill+clean+no-incremental+重跑，对付 MSBuild 增量误判 |
| fix | cds | .NET profile 启用热更新默认用 dotnet-restart（watch 改为「不推荐」可选项） |
| feat | cds | 新增「💥 强制干净重建」：停容器 + rm -rf bin/obj，破除文件系统缓存 |
| feat | cds | 新增「🔍 运行时字节码核验」：比对源码/DLL/进程启动时间，诊断是否在跑老字节码 |
