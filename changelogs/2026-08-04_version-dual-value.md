| fix | prd-api | 版本端点改为双值对账：commit 烤进程序集作为实际值、环境变量降为期待值，不一致时直接在响应里告警，杜绝「镜像还是旧的却报新 commit」 |
| test | prd-api | 新增 BuildIdentity 守卫测试，锁死事故值判 mismatch、缺一边只能判 unknown |
| rule | 规则 | config-runtime-drift 新增「运行态自述必须双值对账」一节：能被运行时改写的值不能用来自证 |
