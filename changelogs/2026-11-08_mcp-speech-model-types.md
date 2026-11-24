| fix | llmgw | 逻辑模型创建读取服务端完整用途目录，开放TTS与ASR等合法用途，切换时清理默认生图能力并保留自定义能力 |
| test | llmgw | 网关镜像构建纳入表单回归，验证TTS创建、既有Exchange映射绑定和编辑读回，以及用途目录失败时阻止新建 |
| test | llmgw | 显式提供并恢复浏览器navigator，使网关表单回归兼容镜像Node20与本地Node24 |
