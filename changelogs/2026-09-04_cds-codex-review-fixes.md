| fix | cds | 修复窄屏下切走上手助手 tab 时它藏不掉——高度链规则的 display:flex !important 打败了 hidden，两个 tab 会一起铺在屏幕上 |
| test | cds | 上手向导探针改为量每一步的真实出口（含开头两步的卡片），此前 action:null 让它跳过量测直接 DOM click，卡片被裁到屏幕外也全绿 |
| test | cds | 探针新增 tab 隔离判据：切走后上手助手必须真的从屏幕上消失 |
