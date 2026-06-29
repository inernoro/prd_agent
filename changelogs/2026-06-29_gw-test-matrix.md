| test | prd-api | 新增网关协议保真 MECE 自测 GatewayProtocolFidelityTests（think 三形态/tool_calls 归一/token+cache/finish_reason/跨chunk think 标签 + canary 探测元断言） |
| test | prd-api | 新增跨进程传输 D11/D12 自测 CrossProcessServingErrorLoadTests（上游失败→Fail/抛异常不崩/并发16不串扰/错key 401） |
| docs | prd-agent | 新增 spec.llm-gateway-test-matrix（14 维 MECE 矩阵 + 4 层分工 + 每层 canary），含 D 层真机冒烟脚本 scripts/gw-smoke.py |
