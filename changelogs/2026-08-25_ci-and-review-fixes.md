| fix | cds | 真容器测试排队起：四个重型容器被 vitest 并行同时冷启动，CI 上全部没起来；改成跨进程互斥，一次只起一个 |
| fix | cds | 真容器探活失败时 dump 容器状态与日志，容器已退出立刻抛出不再空等到超时——原来只留一句「expected false to be true」，等于要再花一轮 CI 才能开始诊断 |
| fix | cds | postgres 探活从 pg_isready 改成拿目标库真跑一次查询：initdb 的临时服务器会让 pg_isready 提前返回成功，于是第一条 SQL 打在还没建出来的库上 |
| fix | cds | nacos 命名空间接口失败不再被 sed 的退出码吞掉：拿不到清单就整轮作废，不再只导 public 冒充全量（Codex P1） |
| fix | cds | 每日体检的豁免台账 key 补上项目：多个项目同名服务会互相捡走对方的豁免，导致配好认证的库被报成靠豁免在跑（Codex P2） |
| fix | cds | 用 json 状态后端的部署不再为一个不存在的 CDS Mongo 天天报警（Codex P2） |
| fix | prd-api | 试跑转正的写库改为不可取消：浏览器一关就可能停在「父记录已认领、子记录还是 pending」，那唯一一次转正机会永久作废，接口却回 running（Codex P1，同时是 server-authority 规则要求） |
| fix | prd-admin | 数据同步页主按钮改用 button-primary token：原来 accent 底配写死的 #fff，对比度 3.12:1，浅色主题下字会消失（双皮肤棘轮拦下） |
| test | cds | 补 9 条判据覆盖上述修复，命名空间失败、豁免 key、json 后端三处各做红绿闭环 |
