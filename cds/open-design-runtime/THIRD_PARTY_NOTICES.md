# 第三方软件声明

本镜像只作为 CDS 隔离会话中的无头设计运行时，不构成 OpenDesign 官方发行版，也不使用其商标为 MAP 背书。

| 组件 | 固定版本 | 来源 | 许可证 | 本项目处理 |
|---|---|---|---|---|
| OpenDesign | 0.21.1 | https://github.com/nexu-io/open-design/tree/fbd4d48ebe21b20f4a2faaad0ad5e53aaeb1dc4b | Apache-2.0 | 固定 tag `open-design-v0.21.1`；作为上游基础镜像运行，保留其镜像内许可证与归属信息 |
| Codex CLI | 0.143.0 | https://github.com/openai/codex/tree/b213653e584580ccbb6dbd17ca1a6561e4bf065a | Apache-2.0 | 安装公开 npm 包 `@openai/codex@0.143.0`，对应 `rust-v0.143.0`；构建时核对 CLI 版本，保留包内许可证与归属信息 |

Codex npm 包来源为 https://registry.npmjs.org/@openai/codex/-/codex-0.143.0.tgz ，发布完整性标识为 `sha512-6h53sNtESIYncWVwU7zEjdVajwcad/0H94MOrgGqhwBMa9RRUDVG6DU9E9euC7yRdtrsKDAkJkz/m5moZ6MU3A==`。该版本与固定 OpenDesign 的原生 Codex adapter 配套；会话配置只指向 MAP 模型出口，关闭 WebSocket 状态续接，不使用个人登录凭据。

OpenDesign 捆绑的技能、设计模板和其他资产可能带有各自许可证。运行镜像沿用上游文件及其许可证，不把这些资产改称 MAP 自有内容。正式升级前由 CDS 运行时维护者核对上游 `LICENSE`、`NOTICE`、模板级许可证、镜像摘要和软件物料清单；发现许可证变化时停止晋级并更新本声明。

本文件只提供来源与责任说明。完整许可证文本随上游基础镜像和安装的软件包一同保留；对应权利、免责声明和责任限制以各组件随附许可证为准。
