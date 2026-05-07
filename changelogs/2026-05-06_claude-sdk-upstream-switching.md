| feat | claude-sdk-sidecar | 支持上游切换：env 全局 / per-request baseUrl+apiKey / 命名 profile yaml 三档配置，覆盖 cc-switch / DeepSeek / Kimi / GLM / 自建网关
| feat | claude-sdk-sidecar | 新增 profiles.example.yaml + profiles.py 加载器（PyYAML，${VAR} env 占位符替换），文件不存在静默跳过
| feat | prd-api | SidecarRunRequest + ExecuteCliAgent_ClaudeSdkAsync 增加 profile / baseUrl / apiKey 字段，节点 JSON 透传到 sidecar
| feat | docker | docker-compose.dev.yml 暴露 ANTHROPIC_BASE_URL + DEEPSEEK_API_KEY 等供应商 env，加 host.docker.internal 别名让容器能回宿主访问 cc-switch
| docs | doc | guide.claude-sdk-quickstart.md 增"切换其他模型 / 上游"章节（4 表格 + 3 档配置 + 实测证明）
