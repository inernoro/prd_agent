| polish | prd-admin | 视觉创作工具栏做减法：移除 Mark/上传视频/智能画板/形状文本 等未开发的禁用占位项，单项的「+新增」下拉收敛为直接「上传图片」按钮 |
| feat | prd-admin | 视觉创作桌面端「对话优先」：进入编辑器且画布无产物时自动聚焦右侧输入框，描述即生成无需先摆生成框 |
| fix | prd-admin | 视觉创作手机端补回 pc-only 门槛：该页是独立全屏路由绕过 AppShell 导致 MobileCompatGate 失效，手机用户直接走进桌面画布产生留白；现手机访问显示「建议用电脑」门槛，桌面端不受影响 |
| fix | prd-admin | 视觉创作「对话优先」聚焦改绑画布恢复完成点：原独立 1200ms 定时器在 workspace 切换后不再重跑、且会在画布异步水合前误判空画布抢焦点（有作品时也抢）；现并入 boot 恢复完成的 applyCanvasFocus，按 workspace 每次重判、确认无产物才聚焦 |
| feat | prd-admin | 视觉创作生图等待加「计时可见性」：画布 running 占位新增 已耗时(每秒+) + 平均预计时长(历史耗时指数滑动平均存 localStorage,首样本前 40s 兜底) + 进度条(按时间逼近封顶95%,超时转黄显示「即将完成」),消灭空等焦虑;running→done 自动采样刷新平均 |
| feat | prd-admin | 视觉创作生图加载动效换新（贴合靛蓝新主体风格）：running 占位由旧「金色 Nebula 花瓣」改为「流光进度条」GenSweepLoader——靛蓝斜向流光扫过 + 底部计时条(已耗时/预计~Ns/渐变进度条,超时转黄「即将完成」),倒计时融入动效;计时 helper 抽到 lib/genTiming.ts、loader 抽成 components/ui/GenSweepLoader.tsx 复用;error 态仍用花瓣灰显 |
