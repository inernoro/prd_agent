# CDS Agent 当前进度面板

> **状态**：已合并到权威入口
> **最后校准**：2026-05-19 Asia/Shanghai
> **权威文档**：`doc/design.cds.agent.commercial-architecture-and-roadmap.md`

当前不再维护独立进度页，避免架构、阶段、进度、视觉测试和冒烟测试分散在多个地方。

当前校准结论：`prd-agent` 主系统已经不再被 `claude-agent-sdk-runtime-v2` 侵入；远端 provider-backed 只读巡检已进入 `provider_smokes_passed`，Phase 4 P4-1/P4-2/P4-3/P4-4/P4-5 已在权威文档中收口。Claude SDK Agent 是 CDS-managed runtime/container/sandbox；SSH、remote host env、sidecar image 只能作为 CDS operator/debug fallback，不能作为普通用户主路径。

请只看：

```text
doc/design.cds.agent.commercial-architecture-and-roadmap.md
```

其中：

- 阶段完成对勾：看 `14.1 阶段总览`
- 视觉测试/冒烟测试对勾：看 `14.2 Phase 0 测试对勾`
- 当前小节点进度：看 `14.3 Phase 1 当前进度`
- 当前对话完成项：看 `14.5 当前对话完成项`
- 下一次开发入口：看 `14.6 下一次开发入口`
- Phase 4 远端收口：看 `14.8 Phase 4 当前进度`
