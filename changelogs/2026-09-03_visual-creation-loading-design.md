| fix | cds | 预览自动唤醒判据从只认 scheduler 放宽到「CDS 自己决定的停机」，容器还在的分支不再永久 503 |
| refactor | cds | 唤醒判据抽成唯一判定源 branch-wake-eligibility.ts，proxy 与 index 两份拷贝合一；删除意图标记同处收敛 |
| test | cds | 新增 28 项判据测试（十种停机来源逐档 + 删除意图 + 远端执行器 + 空 services + 分裂守卫） |
| feat | prd-admin | 视觉创作生图等待态改版：进度画在画框上，尺寸/阶段/剩余时间合并成底边一行 |
| refactor | prd-admin | GenSweepLoader 退场，换成 GenDevelopLoader；配色下沉到 tokens.css 的 --gen-wait-* 一族，组件内零硬编码颜色 |
| polish | prd-admin | 等待态材质回到轻透大斜扫（底纱 0.56→0.12、去潜像马赛克与暗角），画框加一颗跑光 |
| fix | prd-admin | 等待态占位卡不再由调用方画 border，消掉世界坐标边框与屏幕坐标描边错位 |
| fix | prd-admin | 修 tokens.css 多出一个注释闭合导致的整前端构建失败（CI 红 → 分支 idle → 预览 503） |
| test | prd-admin | 新增 GenDevelopLoader 单测（档位阶梯/阶段词/画框路径/动效声明纪律 32 项） |
| test | e2e | 生图等待态布局回归改盯新结构，并补「配色不跟主题翻面」与「fixture 必须注入 tokens.css」两条判据 |
| chore | prd-admin | 双皮肤棘轮台账移除 GenSweepLoader 条目（该文件已零硬编码，欠账减一） |
| rule | platform | AGENTS.md 前端校验表补 .css 走 pnpm build——tsc/lint/vitest 都不解析 CSS |
| polish | prd-admin | 生图等待卡补上织纹与呼吸辉光，不再是一块纯平深色方块 |
| fix | prd-admin | 等待卡被选中时进度画框整个藏在蓝色选择框下，内缩到选择框里侧 |
| polish | prd-admin | 生图等待卡去掉灰色底轨，画框只留 #D97757 一种颜色 |
| fix | prd-admin | 开始生成不再自动选中占位卡，等待卡外不再多套一圈蓝色选择框 |
| feat | prd-admin | 视觉创作首页换成暗房版式：小眉标 + 32px 实心标题 + 六格预设 |
| feat | prd-admin | 新增潜像场背景组件，替换与产品无关的星空插画和粒子漩涡 |
| refactor | prd-admin | 潜像场配色下沉为 --latent-* / --backdrop-scrim 双写 token |
| feat | prd-admin | 视觉创作首页顶栏：品牌块 + 创作/作品 + 右侧动作，与视频创作同结构 |
| feat | prd-admin | 输入区换成暗房控制台样式，反色主按钮，去掉与品牌无关的靛蓝 |
| feat | prd-admin | 首页背景每 10 天轮换一张，素材取自用户自己项目的封面 |
| feat | prd-admin | 顶栏新增背景设置：自动轮换 / 关闭 / 钉住一张，含下次更换倒计时 |
| fix | prd-admin | 视觉创作选中图时上传不再替换原图，改为在旁边新增 |
| feat | prd-admin | 上传的新图贴着选中图共边落位，多张排成等距一行 |
| polish | prd-admin | 生图等待画框只留一处光，钉在进度最前端，不再有两道光分不清 |
| feat | prd-admin | 背景素材新增设计批六张：星环 / 地平 / 光锥 / 星野 / 同心 / 棱镜，覆盖几何、光线、宇宙、星空 |
| polish | prd-admin | 背景清单改为新批在前，面板高度给到 400px（四行整 + 第五行露一截提示还有） |
| polish | prd-admin | 同心与棱镜按亮度单独压重暗罩，同心从 0.80 降到 0.78 以保住「随包严格轻于用户生成」的不变量 |
| fix | prd-admin | 背景压暗罩从全屏均匀改为按内容分布的三档，边缘由 38% 透出提到 86%，字区照旧压住 |
| feat | prd-admin | 背景素材新增 focus 焦点位置，主体不再被 cover+center 塞在标题底下 |
| feat | prd-admin | 新增第四批六张铺满画面的设计版面：等高 / 纸雕 / 构成 / 极光 / 色场 / 山脊 |
| chore | prd-admin | 删掉实测有效像素占比低于 5% 的六张素材（褶 / 弧光 / 星环 / 粼 / 余烬 / 薄雾） |
| test | prd-admin | dim 守卫改为双向（既要有调高也要有调低），新增每张素材必须声明 focus 的守卫 |
| fix | prd-admin | 输入框里的虚线参考图槽改为可点击，点击直接打开文件选择器 |
| feat | prd-admin | 背景素材从 4 张扩到 9 张，新增百叶/粼/析出/弧光/褶五张带「形」的素材 |
| feat | prd-admin | 背景素材支持逐条 dim，偏亮的三张单独压重，不再全批共用一个暗罩值 |
| polish | prd-admin | 背景面板回到三列并只显示名字，九张一屏全在，说明留在悬停 |
| test | prd-admin | 新增空槽可点守卫；暗罩用例改为按条目 dim 判定并要求偏亮项单独调过 |
| fix | prd-admin | 输入框恢复长框：宽度与项目栅格内容宽（1300px）对齐，不再自作主张收窄一档 |
| polish | prd-admin | 打字区高度上限跟着放到 360px，避免 1300 宽配 190 高又变回横条 |
| polish | prd-admin | 唤醒时长 1900ms 放慢到 2500ms，元素点亮延迟等比拉开到 160-1740ms |
| polish | prd-admin | 系统弹窗改控制台形态：容器 8px、控件 6px、正文 12-13px，替换掉 22px 圆角 + 液态玻璃 + 44px 药丸按钮那一套 |
| polish | prd-admin | 弹窗新增贴底动作条（上分隔线 + 淡底），主操作反色、危险操作填色、次操作只描边 |
| refactor | prd-admin | 弹窗面板改实底并全部走 --dialog-* 双写 token，删掉浅色 / 性能模式 / 素色材质三条 !important 补丁与遮罩模糊 |
| feat | prd-admin | Dialog 新增 actions 与 tone 两个入参，危险弹窗标题前加红竖条 |
| test | prd-admin | 新增弹窗形态守卫：尺寸档位、Button 尺寸钩子接线、遮罩不模糊、token 双写、调用方不叠内边距 |
| fix | prd-admin | 视觉创作预设行 MAP Pro 接上线，点击清空输入回到自由描述；选完预设把光标送进输入框 |
| polish | prd-admin | 顶栏「创作」从只有一项的分段控件降级为纯标签 |
| polish | prd-admin | 撤掉左侧浮动工具栏（新建项目的第三个入口），新建文件夹挪进最近项目标题行并带文字 |
| refactor | prd-admin | 删除 DarkroomPlate 与 LatentField 两层程序美术，背景只留真图 + 压暗罩 + 一层非重复渐晕 |
| polish | prd-admin | 输入框 820x180 放大到 880x约250，参考图从 30px chip 改为落在打字区内的 56px 缩略图，空态给虚线拖放槽 |
| polish | prd-admin | 背景面板缩略图改两列并显示名字与说明，不再只挂在原生 title 里 |
| fix | prd-admin | 没有封面的项目卡给项目名首字 + 「还没有图」，不再是与加载失败同形的纯色空框 |
| test | prd-admin | 新增死控件守卫（预设格全可点 / 不摆单项分段控件 / 入口不重复 / 空态可辨），背景守卫改为禁止重复图案 |
| fix | prd-admin | 守卫的剥注释正则钉住行首，修复 accept="image/*" 把通配符当注释开头吞掉五千余字符导致判据对空串断言 |
| feat | prd-admin | 视觉创作首页背景改用随包的四张暗调素材（显影/门缝/余烬/薄雾），每 10 天轮换一张 |
| feat | prd-admin | 背景设置面板支持自己生成一张背景：填一句氛围即可，走产品自身生图链路，生成期显示阶段与已等待秒数 |
| fix | prd-admin | 背景素材池不再取项目封面——真实封面多为白底产品图，压暗后整页变平灰且图本身也认不出来 |
| fix | prd-admin | 浅色主题下不再铺背景照片——近黑素材压在奶白底上会把整页糊成灰，眉标小字读不出来 |
| feat | prd-admin | 视觉创作首页背景换成「印相台」美术层：接触印样 + 错开套印的两块墨 + 半调网点 + 四角套准十字，替换原来的辉光与掠光 |
| feat | prd-admin | 首页前景改磨砂玻璃（0.618 + 顶边高光 + 投影），新增 .glass-pane / .glass-sub 与对应双写 token |
| fix | prd-admin | 视觉创作左上角的白色实心占位块换成线性套准十字，和背景印相台同一个符号，不再是整页最亮的东西 |
| feat | prd-admin | 视觉创作项目列表改骨架加载：按真实卡片几何摆位（160 封面 + 标题条 + 日期条），翻页也用同一种骨架 |
| fix | prd-admin | 视觉创作首页背景层移出滚动容器，向下滚动时不再跟着滚走 |
| polish | prd-admin | 印相台去掉胶片语言（齿孔、接触印样画格），换成灰阶梯尺与印刷色标条 |
| fix | prd-admin | 印相台网点改 16px 周期、半径 0.75 并只铺在四周，不再读作马赛克 |
| polish | prd-admin | 首页去掉标语与重复眉标，主标题改为「今天做什么图？」 |
| test | prd-admin | 新增三条守卫：不用胶片语言、网点几何、背景层在滚动容器之外 |
| fix | prd-admin | 唤醒从「一道窄光带扫过」改为「幕从左上退到右下」，整张壁纸被逐渐点亮而不是闪一下 |
| fix | prd-admin | 修复幕的几何：inset 与 translate 的百分比基准不同，原参数让幕滑出画面，t=0 就漏出大半张图 |
| fix | prd-admin | 输入框宽高改为跟随视口 clamp，此前写死 880px 在宽屏上只占 45%，比下面的项目栅格还窄 |
| test | prd-admin | 新增几何参数守卫与 scripts/wake-veil-probe.mjs 像素探针（t=0 全盖住 / t=末全露出 / 中途有前沿） |
| feat | prd-admin | 视觉创作首页新增整页刷新时的唤醒：一束斜光从左上扫下，页面元素沿光路依次点亮 |
| fix | prd-admin | 背景素材改按出图原生 1536 存储、质量 0.88，此前降到 1280 等于白扔 20% 像素，DPR2 下放大 2.375 倍 |
| test | prd-admin | 新增唤醒守卫：只消费一次、光带斜向且左上到右下、元素延迟单调递增且落在光带行程内、reduce-motion 下终态就位 |
| fix | prd-admin | 背景设置浮层改走 Portal 挂到 body，窄视口下不再被祖先 overflow 裁掉、控件点不到 |
| fix | prd-admin | storage 写不进时保住仅本次会话有效的背景列表，第二次生成不再挤掉第一张 |
| test | prd-admin | 补浮层 Portal 与会话列表保全的守卫 |
| fix | prd-admin | 自己生成的背景改为按账号分键存，共用电脑上换账号不再看到上一个人的产物 |
| fix | prd-admin | 背景生成改查 text2img 专用模型目录，避免选中 img2img/vision-only 池导致每次必败 |
| fix | cds | 项目暂停中的分支不再被「访问预览域名」唤醒，暂停契约不被绕过 |
| test | prd-admin | 补跨账号隔离与目录选择守卫 |
| test | cds | 补项目暂停压倒停机来源分档的守卫 |
| fix | prd-admin | 唤醒动画改为按「本文档最初加载的就是本页」判定，从别的路由跳进来或深链返回列表不再误播 |
| fix | prd-admin | 换模型时先丢掉上一个模型的尺寸清单，避免窗口期内交出新模型不支持的尺寸 |
| fix | cds | 自动唤醒的复检也带上项目暂停状态；唤醒跑到一半被暂停时停回容器，不再制造「跑着的暂停项目」 |
| test | prd-admin | 唤醒来源判定补行为用例；补换模型清空顺序守卫 |
| test | cds | 暂停守卫扩到两个调用点，并补「落 running 前再问一次」的守卫 |
| fix | prd-admin | 手机端把交接包里的选项 id 还原成池 id 再选模型，不再一次都比不中、退回第一个可用池 |
| fix | prd-admin | 首页模型浮层落点改为按视口翻面并夹紧，页面滚到工具行接近顶部时不再整个跑出屏幕 |
| refactor | prd-admin | 浮层落点算术收敛到 lib/anchoredPanel，模型选择器与背景面板共用一份 |
| feat | prd-api | 视觉创作本页教程补「挑一个绘图模型」一步（11 步 → 12 步），后续步号同步 |
| test | prd-admin | 新增落点纯函数用例与两处消费方守卫；新增首页锚点与教程步骤的双向对账守卫 |
| test | prd-admin | 池 id 与选项 id 的互转用真 builder 断言；修正一条「读了就算数」的旧守卫 |
| rule | 全局 | onboarding-tips 步数表同步为 12 步 |
| fix | cds | 暂停回滚停容器后先核实再落状态，容器没停下来时分支记 error 而不是谎称已停 |
| perf | prd-admin | 首页提交不再等偏好写回，跳转只等建工作区一个往返 |
| test | cds | 补「停完必须核实」的守卫，复用副本停止那份判定 |
| test | prd-admin | 三条钉着旧理由的守卫改钉新不变量：跳转前只等建工作区 |
| fix | prd-admin | 「暂不可用」的模型改为真的点不动，不再能选中一个没有健康成员的池去跑生成 |
| fix | prd-admin | 新建文件夹改为禁用并标「开发中」，不再走完整套取名流程却什么都不创建 |
| test | prd-admin | 补两条守卫；修正一条把「必须可点」一并钉死的旧守卫 |
| fix | cds | 暂停回滚的每个 await 前后与落盘前重新确认租约，被手动部署接管时不再停错容器、不覆盖对方状态 |
| fix | prd-admin | 模型锚点常驻：目录还没读到或读失败时给禁用占位，教程走到那一步不再卡在「正在定位」 |
| test | cds | 补回滚段租约复检的守卫 |
| test | prd-admin | 补「锚点不许被目录条件挡掉」的守卫 |
| test | prd-admin | 交接包消费方守卫改为真扫源码树，第三个消费方出现时才真的会红（旧写法永远绿） |
| merge | prd-admin | 合入 main：保留 GenDevelopLoader 的同时把 main 在旧 loader 上的「进度行夹在可见区域内」一并带过来 |
| fix | prd-admin | 手机端模型 id 归一到选项 id 口径——main 把比较对象换成选项 id 后，原先剥前缀的写法会让自动发送整个不触发 |
| test | prd-admin | 进度行夹紧守卫从旧 loader 搬到新 loader；模型 id 归一改为行为断言（源码守卫在口径反转时不会红） |
| fix | 全局 | 设计画布目录并入 .design/，修复根目录布局契约 CI 红灯 |
| fix | prd-admin | 背景生成落地读最新列表：等待期间删掉的那张不再被写回来复活 |
| test | prd-admin | 补复活场景的行为判据（用旧快照落地会复现缺陷，用最新列表不会） |
| fix | prd-admin | 守卫改用手写目录遍历替代 Node 22 才有的 fs.globSync，CI 的 Node 20 不再直接崩 |
| fix | 全局 | debt 文档的源码路径收进「实现来源」小节，文档可读性棘轮回到基线 |
| fix | prd-admin | 暗岛补齐 11 个经由 CSS 类被消费的主题 token，浅色档下首页不再近白字压浅色玻璃底 |
| test | prd-admin | 暗岛守卫从「只数直接 var()」扩到「类名 → token」的消费关系 |
| fix | prd-admin | 手机端参考图落盘失败时不再替用户跑一次纯文字付费生成，提示词放回输入框可重试 |
| fix | prd-admin | 首页提交先探站点存储再建工作区，存储不可用时重试不再堆出一串空项目 |
| test | prd-admin | 补两条守卫；放宽一条把 toast 文案逐字钉死的旧断言 |
| fix | prd-admin | 浅色主题下暗岛里的背景照片不再被整层藏掉（用户反馈：背景消失了） |
| fix | prd-admin | 背景改为解码完当帧点亮、过渡收到 260ms，不再等 onload 后再解一次码 |
| fix | prd-admin | 暗岛补上罩与渐晕的深色值，背景恢复可见后不再盖着为纸面调的浅罩 |
| test | prd-admin | 补背景可见性与点亮时机的守卫 |
| docs | cds | 记债：项目暂停恢复后，被保留的容器仍可能被一次预览访问拉起（判据分不出暂停来源） |
| fix | prd-admin | 首页选的模型随交接包直接交给编辑器，偏好接口写失败时不再退回上一次的模型跑生成 |
| test | prd-admin | 补交接包携带模型的守卫 |
| fix | prd-admin | AI 分层面板改为从画布右缘推出，让开右侧对话浮层，两者不再互相遮挡 |
| refactor | prd-admin | 右侧两个浮层的几何收敛为一组常量，面板位置与画布预留宽度都从它推导 |
| test | prd-admin | 补守卫：几何必须同源，且让位量真的接到面板与预留宽度上 |
| fix | prd-admin | 手机端编辑器也认首页交接包：参考图先落盘再生成、模型按用户所选，不再丢图或换模型 |
| test | prd-admin | 补「交接包只有两个消费方」的守卫，防止再改一个漏一个 |
| docs | prd-admin | 记债：背景生成中途离开页面，已付费的产物收不回来；挑池不看健康状态 |
| fix | prd-admin | 画布卡片上角不再叠字：属于 Frame 的卡让位给 Frame 标题与图层面板按钮，生成中让位给 loader 底行 |
| test | prd-admin | 补守卫：卡片上角的两个让位条件必须存在且真的接上标签 |
| fix | prd-admin | 修复视觉创作首页整页刷新时输入框塌成窄条：JSX spread 覆盖 className 导致包裹层丢掉 w-full |
| fix | prd-admin | 输入框宽高回到原来的 880 × 190：先前误把塌陷当成尺寸太小，越改越大 |
| test | prd-admin | 唤醒守卫补「rise() 的 className 不许被覆盖」，并修正延迟正则漏匹配带第二参数的调用 |
| test | prd-admin | 补守卫：输入台与预设行必须同宽且只有一个宽度值；输入台高度必须是定值不跟视口长 |
| fix | prd-admin | 首页带图进画板时第一次生成会丢掉参考图（setCanvas 未刷新，解析器在旧画布里找不到），改为把刚加的元素直接递给发送路径 |
| test | prd-admin | 新增 mergeSendCanvas 纯函数用例与接线守卫，复现「旧画布 → 零引用」的退化 |
| perf | prd-admin | 视觉创作首页点发送后立刻进画板，不再等参考图上传完；建工作区与写偏好并行发 |
| fix | prd-admin | 画布落位把尺寸未知的元素当成 1×1 的点，导致新生成的图压在参考图上 |
| fix | prd-admin | 生成的新图现在贴着参考图共边排列，与上传路径同一套对齐规则 |
| fix | prd-admin | 首页带入的参考图量出真实像素尺寸并显式落位，才能当对齐锚点 |
| refactor | prd-admin | 落位碰撞表收敛到 canvasPlacement 一处，生成/上传/拖入三处不再各写一遍 |
| test | prd-admin | 新增落位与首页交接守卫；修正两条钉死实现字面写法、以及跨函数误判顺序的旧守卫 |
| fix | prd-admin | 站点存储被禁用导致交接包一个字都没存进去时不再跳转，保住用户刚敲的提示词并说明原因 |
| test | prd-admin | 补守卫：没存进去必须先 return，不许走到跳转与清空输入 |
| feat | prd-admin | 视觉创作首页工具行补上模型选择器，默认按账号上次用过的模型选中 |
| feat | prd-admin | 首页尺寸清单跟着所选模型走：只列该模型真支持的档位与比例，换模型后按比例优先纠正当前尺寸 |
| fix | prd-admin | 首页尺寸 chip 从靛蓝药丸改回与同行控件同一档，不再是整行唯一带色块的旧样式 |
| feat | prd-admin | 首页提交时把所选模型写回账号偏好，编辑器挂载即读到同一个值 |
| test | prd-admin | 新增 visualModelSizes 纯函数用例与首页模型接线守卫，覆盖比例优先纠正、无数据不乱改、写偏好必须先于跳转 |
| docs | prd-admin | 记债：编辑器仍自带一份模型目录与尺寸联动，未切共享模块 |
| fix | prd-admin | 首页带图跳画板不再出现两张一样的参考图：内联图落地前先按 assetId 认领画布上已有的那张 |
| test | prd-admin | 补守卫：内联图先认领后新增；上传路径不许去重（用户传几次就几张） |
| fix | prd-admin | 分层副本落位撞到东西时跨过挡路者即可，不再整整跳一个原图宽度导致副本跑到视野外 |
| fix | prd-admin | 视觉编辑器教程 pill 移到左上角返回钮下方，不再压住 AI 分层面板的收起按钮 |
| test | prd-admin | 补落位与 pill 位置守卫；修正一条钉死实现字面写法的旧守卫 |
| rule | 全局 | onboarding-tips 补「右上角被浮层占住的全屏页把 pill 放左上角」的例外与理由 |
| fix | prd-admin | 视觉创作画布：选中图旁新增图片时在画布上给提示，不再只写进看不见的聊天面板 |
| test | prd-admin | 补守卫：贴着选中图落位时必须走画布 toast |
| fix | prd-admin | 视觉创作首页输入框工具行手机端改横滚，参考图/模型/尺寸/反馈四个控件不再被裁掉 |
| fix | prd-admin | 模型目录不再等偏好接口：偏好慢或不回时也能选模型，不再卡在「读取模型…」 |
| chore | 全局 | 本分支 31 份 changelog 碎片按规则 #4 合并成一份 |
| test | prd-admin | 新增 375px 工具行像素探针，量「能不能横滚 + 五个控件能否完整露出」，不只看类名 |
| fix | prd-admin | 首页选完模型后，晚到的账号偏好不再把用户的选择改回去 |
| fix | prd-admin | 浮层落点按视口夹紧：视口比 minHeight 还矮时也不再把面板撑出屏幕 |
| fix | prd-admin | 两个探针脚本改从自身位置解析路径，换个 clone / CI 也跑得起来 |
| fix | prd-admin | 视觉创作首页「模型设置」按钮在浅色档下白字压白底，暗岛补齐次要/危险/ghost 按钮 token |
| fix | prd-admin | 暗岛 token 判据补「算出来的类名」一层，Button 这类拼类名的组件不再漏判 |
| fix | prd-admin | 交接包存不下时把刚建的空工作区收掉，重试不再攒出一串空画板 |
| fix | prd-admin | 桌面端参考图没能带上来时停住，不再替用户跑一次纯文字的付费生成 |
| fix | prd-admin | 背景生成的查目录与建任务两次请求也归超时与取消管，不再永远卡在「生成中」 |
