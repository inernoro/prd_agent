# 稳定冒烟夹具

`stable-smoke-speech.m4a.b64` 来源于 whisper.cpp 仓库的 `samples/jfk.wav`，截取前 3.5 秒并转为单声道低码率 M4A，仅用于录音上传和转写链路测试。原始录音为美国政府公开演讲材料。

测试运行时只在内存中解码，不在仓库保存二进制副本。

`stable-smoke-clear-speech.wav.b64` 是独立准确性参考夹具：本机离线 macOS `say` 的 Samantha 语音合成完整源文“The white peach is on the table.”，不截句，转为16kHz单声道PCM16 WAV并补0.25秒尾静音。来源、期望转写、语言、有限归一化、字节哈希与时长见同名 `stable-smoke-clear-speech.reference.json`；真值是合成输入，不是ASR输出。信号/格式检测不等于人工真听核准，也不证明ASR已通过。

旧JFK材料只证明原链路，不具有独立准确性golden；保留全部旧失败，禁止根据旧CDS输出编写真值。新参考只允许空白、NFKC、ASCII大小写、句末句号/问号/感叹号的明确归一，完整词序与词形仍须相等。刷新比较页面原文与持久化原文时不使用语音归一化，正文逐行严格等值，时间戳单独验收。
