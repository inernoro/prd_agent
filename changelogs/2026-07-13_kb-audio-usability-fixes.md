| fix | prd-admin | 知识库外层旧「新建」移动悬浮按钮下线：与统一「+」菜单撞位且内容不一致，内外「+」现点开显示一致 |
| fix | prd-admin | 上传白名单补齐音频/视频/图片/Office 扩展名，修复「上传录音文件上传不了」；超 20MB 前端预检即时报错 |
| feat | prd-admin | 上传改 XHR 带实时进度：页面浮动进度卡（文件名+百分比+第 n/共 m）、转录抽屉上传阶段进度条，大文件不再无反馈 |
| fix | prd-admin | 移动端 markdown 编辑改单栏（原双栏 live 被挤成两条窄柱无法编辑） |
| feat | prd-admin | 音频播放器声纹化：跨域拿不到真实波形时渲染语音条式声纹（确定性伪随机+进度着色+点按跳播），去掉顶部大图标与文件名块 |
| feat | prd-admin | 转录笔记/字幕/再加工产物顶部新增「来源文件」chip，一键跳回源音频/源文档 |
| fix | prd-api | restyle 权限改为按笔记可写判定（协作者可整理别人发起的转录）；latest-run 端点支持 status/requireOutput 过滤，修复一次整理失败后面板永远打不开 |
| fix | prd-admin | 双皮肤棘轮回绿：本轮新增的 10 处 rgba 白透明硬编码全部换 token（--bg-elevated/--bg-input/--bg-tertiary） |
| feat | prd-admin | 转录完成结果区双页签「整理结果 / 转录原文」（原文来自 run.transcriptText，老任务给指引）；restyle 失败提示可见（不再静默）；抽屉底部留白修复 |
| fix | prd-api | 修复 PrdAgent.Api.Tests 因处理器新构造参数导致的编译失败 |
