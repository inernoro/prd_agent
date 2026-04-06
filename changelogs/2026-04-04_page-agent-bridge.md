| feat | cds | Page Agent Bridge：编码 Agent 通过 CDS Widget 读取页面 DOM 和执行操作 |
| feat | cds | Bridge HTTP 轮询服务 + REST API（/api/bridge/*）|
| feat | cds | Widget DOM 提取器（简化文本格式供 LLM 消费）|
| feat | cds | Widget 操作执行器（click/type/scroll/navigate/spa-navigate/evaluate）|
| feat | cds | 导航请求 UI（Agent 申请 → 用户点击打开 → 自动建立连接）|
| feat | cds | Console 错误和网络异常拦截上报 |
| feat | cds | 鼠标轨迹动画（渐变蓝光标 + 旋转光环 + 目标高亮 3s 淡出）|
| feat | cds | 操作面板（Badge 上方展开，步骤列表实时状态）|
| feat | cds | 按需激活（start-session/end-session 生命周期管理）|
| feat | cds | spa-navigate 四级策略（React Link → 注入 <a> → 文字匹配 → pushState）|
| fix | cds | 命令队列从单槽改为 FIFO 数组，防止连发丢命令 |
| fix | cds | URL 变化检测去除 WebSocket 残留引用 |
| fix | cds | end-session 改为 Widget 响应后清理（非固定延迟）|
