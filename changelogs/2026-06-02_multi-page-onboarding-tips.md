| feat | prd-admin | 网页托管/视觉创作/知识库/文学创作四个页面新增右下角「小技巧」本页完整新手指引锚点（data-tour-id） |
| feat | prd-api | DailyTips 新增四条本页教程 seed（webpages/visual/document-store/literary-page-guide，8-14 步），替换三条精简旧 seed |
| feat | prd-admin | 「小技巧」入口移到右上角带文字标签的常驻 pill（不再是右下角匿名图标）；进入任一有本页教程的页面自动开讲一次，未走完（点完最后一步）跨 session 会再弹，强制人人过一遍 |
| feat | prd-admin | 新增海鲜市场/智识殿堂/作品广场三页本页教程锚点 + seed；教程入口与 Spotlight 引导上移到 App 根挂载（全局唯一、跨任意路由含全屏编辑器不卸载），删除 FullscreenTipsDock 与 AppShell 内重复挂载 |
| feat | prd-api | DailyTips 新增 marketplace/library-landing/showcase 三条 page-guide seed |
| feat | prd-admin | 视觉/文学编辑器补 data-tour-id 锚点（visual-editor-*/literary-editor-*）；TipsDrawer 自动开讲匹配器区分列表路由与编辑器深层路由，CTA 已在目标路由内不再跳走 |
| feat | prd-api | DailyTips 新增 visual-editor/literary-editor page-guide（进入项目/文章编辑器后自动开讲），列表教程「贯通」到编辑器 |
| fix | prd-admin | 修正三处反馈：①分享/落地/登录/开发页不再挂教程入口（之前 /s/* 分享页误显示）②每条教程第 1 步从整页 root 改指向具体元素（高亮框不再框整屏看不出）③入口 pill z-index 50→300，确保各页右上角都在常规内容之上可见 |
| feat | prd-admin | 缺陷管理/PR审查/涌现探索/工作流四页补 data-tour-id 锚点（缺陷贯通到提交面板全流程） |
| feat | prd-api | DailyTips 新增 defect/pr-review/emergence/workflow 四条 page-guide seed（4-8 步） |
| fix | prd-admin | 涌现探索教程改锚到真实落地页 EmergenceIntroPage（hero/三步玩法/种子按钮/三维度），原锚的树列表视图非默认落地态导致定位失败 |
| fix | prd-admin | 右上角教程入口降突兀：新人(本页教程没走完)才强调色+脉冲闪烁，老人(走完/本页无教程)变中性安静低存在感 chip(不闪、不发光、低透明度)，融入页面 chrome；老人态隐藏计数徽标 |
| fix | prd-admin | 教程入口从右上角悬浮浮层改为内嵌进各页头部(融入而非悬浮)：新增 TipsEntryButton 内嵌进 TabBar/PageHeader(覆盖多数页) + 6 个自定义头部页(网页托管经 PageHeader、视觉/海鲜市场/智识殿堂/作品广场/PR审查/涌现落地页手动内嵌)；TipsDrawer 去掉悬浮书,改为监听 open 事件展开抽屉气泡 |
| feat | prd-admin | 多步教程引导改成「任务清单」式:Spotlight 气泡新增进度条 + 全步骤清单(已完成✓/当前●/待办○,当前自动滚入可见),像做任务一样一个个打勾完成 |
| feat | prd-admin | 子智能体批量给 7 个自定义头部页内嵌本页教程入口(视频/产品评审/项目路由/转录/快捷指令/技能/项目管理);arena、automations 无干净页头暂跳过 |
| fix | prd-admin | PR #712 评审修复：①视觉创作页教程入口误放进复用的 ToolbarButton(每个工具按钮上都叠一个)→ 移到 HeroSection 页面级单实例 ②教程气泡宽度 340→360 后 bubbleLeft 夹取仍用旧值(右溢出/偏移)→ 同步改 360/180 ③多步引导「下一步」自动点击改为仅在「下一步元素当前不存在」时才点,避免点到「分享统计」等按钮弹出 z-10000 抽屉挡住引导 |
| fix | prd-admin | PR #712 Codex P2:视觉编辑器旧版全屏路由 /visual-agent-fullscreen/:id 既不自动开讲也无入口。matcher 增配 -fullscreen 兼容前缀;VisualAgentFullscreenPage 编辑器态右上角内嵌教程入口(覆盖正式 + 旧版两路由,列表态不重复) |
| fix | prd-admin | PR #712 评审三连修：①公开主页 /u/:username 加入教程浮层排除名单(登录用户访问公开页不再冒出内部引导，Codex P2) ②文学编辑器头部右侧补本页教程入口(自动开讲关掉后可手动重开，Codex P2) ③修复抽屉自动展开与 Spotlight 叠加:改用渲染级 pageGuideHere 单一真值抑制(不再依赖 effect 声明顺序，Bugbot Medium) |
| fix | prd-admin | PR #712 再修三处：①TipsEntryButton 未登录不渲染(公开页 /library 匿名访客点了没人接还打 401，Codex P2) ②handleOpenTip 导航守卫补 -fullscreen/ 前缀(在旧版全屏编辑器点 CTA 不再被弹回列表，Bugbot Medium) ③入口点击的 load 去重(只 TipsDrawer 监听里 load 一次，Bugbot Low) |
