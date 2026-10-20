# 第一、二章分段制作

此目录给制作Agent维护；学员使用交付包内的视频、教材与审阅页，不执行这些脚本。

本轮只制作第一章四段、第二章五段。`course.json`保留完整课程操作卡；`production.json`描述已确认的前两章画面与口播。教材从同一规格、操作卡和实际分镜时间生成，不再独立维护一份验收规则。其余章节等待用户审阅。

制作顺序：

1. `official_tts.py`调用官方Speech API准备短样试听，凭据只走安全环境配置或无回显输入。`batch_official_tts.py`在试听确认后并发合成，按实际采样数产生字幕边界。用户已拒绝旧本地中文配音，`synthesize_narration.py`只保留历史复现，禁止用于课程交付。官方API发送原中文与英文产品名，不使用旧本地谐音替换。
2. `build_segments.py`读取实际音频构建独立项目。输出根提供`audio`、初始化的`template`、原始`source-assets`；`--shared-assets`提供手绘运行时、字体与手臂原素材。旧绝对路径缺失时从输出根取得对应音频和截图。
3. `render_segments.py --root`只渲染已经构建的段。完整浏览器检查零错误、已判读的警告、成片音视频格式和完整解码通过后才记为成功。相同输入与文件哈希才复用缓存。
   已有静音画面时，可用`replace_official_voice.py --root <制作根> --official-manifest <官方音轨清单>`快速换声。它校验试听批准、音轨哈希和原文，保留旧分镜时序供重跑；以整帧排时、逐段一次编码声音，避免多次拼接AAC产生累积偏移。Pillow按现有字体生成字幕图层，不依赖FFmpeg的libass模块。
4. `finalize_segments.py --root`核对成片版本与哈希，生成JSON和离线JS清单，从实际MP4抽取教材同帧。全部九段未齐时默认拒绝完整交付；`--partial`用于制作过程中更新预览。
5. `build_review.py`和`build_textbook.py`均使用`--root`、`--repo`及实际`--link-record`，生成相同段号的审阅页和教材。最终截图齐全后打印PDF。
6. `serve_materials.py`由Agent在本机托管材料，支持视频Range读取；学员无需运行命令。也保留独立MP4、PDF与离线HTML。

只改某段内容时，只重做该段受影响音频、构建与渲染，刷新教材和交付清单。每段编号保持稳定，用户意见附段号、时间点、版本及文件校验值。公共画面样式变化时应重新检查所有受影响段。

快速换声另需Pillow；制作与教材脚本使用Python 3.11或更新版本。官方Speech的流式WAV长度标记按已接收PCM采样数读取，普通WAV仍严格检查声明长度。PDF按每幕一页打印，段标题、同帧与操作说明保持同页。

官方配音调用只需Python标准库与FFmpeg，不安装本地声音模型。`narration-requirements.txt`与`narration-models.json`仅留旧配音的历史复现记录。构建另需fontTools 4.61.1，渲染使用固定HyperFrames 0.8.171、Chromium与FFmpeg。媒体及其原素材放交付/制作归档，不提交到仓库。

公开地址、登录跳转、登录后的目标页面核验分开记录。现有平台实录缺口见`doc/debt.platform.md`，不得将路径示意、教学组件数据或技术检查称为真实平台验收通过。机器配音听感与真人独立跟做仍由审阅和试学判断。
