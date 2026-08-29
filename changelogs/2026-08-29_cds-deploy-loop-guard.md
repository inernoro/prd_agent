| feat | cds | 部署端点新增空转熔断：同一分支在 30 分钟内反复部署**同一个 commit** 达 3 次告警、达 6 次拒绝（429），拒绝时活动流留一条可回读的记录，说清是哪个分支、哪个提交、已重复几次 |
| fix | cds | 补上一处真实盲区：CDS 此前对「串行空转部署」完全无感——branch-operation-coordinator 只防并发撞车，而这种环每轮都等上一轮结束才起，协调器从未触发；build-activity-tracker 记了次数却只喂资源面板展示，没有任何判定 |
| refactor | cds | build-activity-tracker 的事件补记 commitSha，并新增 assessDeployLoop 作为该判定的唯一来源；判据按「分支 + 提交」计数，推一个新提交即自动解除 |
| test | cds | 新增 16 条用例：复现事故节奏到 trip、正常连推十次（每次新 SHA）永不误伤、短 SHA 与全长 SHA 视为同一提交、大小写归一、跨分支不污染、窗口外不计数、无 SHA 一律放行；另有接线守卫扫 deploy 处理器，摘掉判定或改掉 429 当场变红（已做红绿闭环） |
| docs | doc | 判据选型的取舍写进 assessDeployLoop 注释：不按 trigger 过滤——triggerFromRequest 缺头时一律回落 manual，CDS 自己的面板与一个失控脚本在该字段上完全不可区分，事故里那个自触发脚本记录下来就是 manual |
| feat | cds | MySQL 基础设施补连接上限兜底：CDS 把 N 个分支复用到同一台库，扇出是 CDS 造的，默认值就该由 CDS 给。没显式声明时按 `--max-connections=1000` 注入（`CDS_MYSQL_MAX_CONNECTIONS` 可调、设 0 关闭），项目自己写了就一律尊重 |
| fix | cds | 事故起因：mdimp 两台 MySQL 都跑在 mysql:8.0 出厂默认 151 上，五个分支全起来实测峰值 294——连一半都不够，Flyway 撞 `Too many connections` 直接失败。难认之处在于抢输的服务死掉后连接就还回去了，事后再查又是空闲的 |
| feat | cds | 分支库新增 `mode=reset`（先 DROP 再重建）。此前唯一入口 `mode=empty` 是 `CREATE DATABASE IF NOT EXISTS`，对「库在、但留着一条 success=0 的 Flyway 记录」无能为力，CDS 没有任何途径修它——而仓库治理规则写的正是「迁移失败时，可丢弃分支库直接重建」 |
| security | cds | reset 硬拦项目共享基础库：`targetDatabase === baseDb` 直接 400，它只用于推倒重建可丢弃的分支独立库 |
| fix | cds | postgres / mongodb 收到 reset 显式报错，不静默退化成 empty——后者会让调用方以为库已重建、脏状态其实原封不动 |
| test | cds | 新增 25 条连接上限用例（三种等价写法识别、registry 端口冒号不误切仓库名、command 形态不安全时不改写别人的启动命令）+ 7 条 reset 契约守卫（含两条红用例）；两处都配接线守卫，摘掉即变红 |
