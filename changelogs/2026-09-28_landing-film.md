| feat | prd-admin | 首页新增 52 秒片花：画面按时间轴逐帧由代码计算，配乐用 Web Audio 程序化合成（D 小调 120 BPM，切镜全部踩在鼓点上），支持拖动进度、静音、全屏、键盘操作，滚出视口自动暂停，中英文随页面语言切换 |
| feat | prd-admin | 新增 `scripts/render-landing-film.mjs`：用同一份组件与乐谱逐帧导出 1080p H.264 + AAC 的 MP4（含海报与 WAV 音轨），可直接外发 |
| polish | prd-admin | 片花画面按 Apple 发布片重做：纯黑底、每幕一句大字标题、产品界面从 3D 倾斜里抬起并持续推近、强拍硬切；修复快切换字后渐变大字变成实心方块 |
| feat | prd-admin | 片花按产品分幕：MAP / LLMGW / CDS 三张分幕卡（进度点 + 识别色产品名），各功能幕大字上方挂所属产品标签；知识星系改为平面六边形星图（实心发光节点、连线收在节点外、标签朝外）；中文版去掉 Canvas / Knowledge / primary 等英文残留 |
| fix | prd-admin | 片花导出脚本代取网络字体（此前导出的中文悄悄退回系统字体），逐帧等待字体分片到齐，并在日志里报告字体是否加载 |
| test | prd-admin | 新增片花契约守卫：幕与幕落在小节线上、每次切镜都有鼓点、画面落定时刻与乐谱同一张表、乐谱确定性、中英文案数量对齐 |
| feat | prd-admin | 片花配乐换成 Suno 成品《Big Final Chord》：按小节从原曲剪出 29 小节（引子 / 第一次爆发 / 蓄力与抽空 / 最后一次爆发 / 终和弦），每个剪接点都压在切镜上；时间轴拍速改读剪辑表 `scoreEdit.json`（121.5 BPM）；配乐取不回时退回合成版并在控制条写明，`data-film-audio` 可机读 |
| feat | prd-admin | 新增 `scripts/film/build-score.py`：按剪辑表从原曲剪出片花配乐（小节线上 40ms 等功率交叉淡化、收尾淡出、限幅），导出脚本默认改用这段成品配乐，`FILM_AUDIO=synth` 仍可导出合成版 |
