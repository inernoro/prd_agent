| fix | prd-api | 修好主干红灯：ServingFaultTrackerTests 两条接线守卫仍在读已被删除的 cds-monitors.yml（监控自发现落地时的涟漪漏一处），判据搬到端点源码上——componentId、sampleComponentId 与 `cds:monitor` 自描述段缺任一条照样红，不是放宽 |
| fix | prd-api | 上一条的判据再收紧（Codex review 两条 P2）：改为**逐条 check** 取声明块后再断言，堵住两个静默通过——只从未处理异常那条删掉 `cds:monitor`（另一条的还在，整份源码找子串照样绿）、以及整条 `serving:requests` 删掉但 `sampleComponentId` 还引着它（`"serving.requests"` 是后者的子串）。三种变异各自变红已实测 |
| docs | llmgw | serving 启动处那句「与 cds-monitors.yml 对齐」改为「与端点自描述对齐」，措辞跟上声明搬家 |
| docs | doc | W37 周报纠正一处过头的说法（Codex review P2）：两个深度自检端点不是「各自真跑一次数据库往返」——只有主系统那条 ping Mongo，模型网关那条只端进程内计数、不碰数据库，网关侧数据库故障不会让它变红，该缺口已写进正文与术语表 |
