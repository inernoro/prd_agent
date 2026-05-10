| fix | prd-api | AppCallerRegistrySyncService 增强：已存在 AppCaller 的 chat 模型组绑定为空时自动回填首个可用模型组（防御性，幂等），解决 CDS 新分支沿用旧空绑定导致毒舌秘书 LLM 调用失败 |
| fix | prd-api | PaAgentController 错误信息细化：把 ModelGroup/AppCaller/401/429 等关键词分别翻译为可操作的用户提示，前端不再只看到「AI 服务暂时不可用」 |
