# 网络诊断功能

## 概述

参考 Cursor 的网络诊断实现，为 PRD Agent Desktop 添加了更精确的网络连接测试功能。

## 功能特性

### 诊断项目

1. **DNS 解析测试**
   - 测试域名是否能正确解析为 IP 地址
   - 显示解析出的 IP 地址列表

2. **SSL/TLS 连接测试**（仅 HTTPS）
   - 验证 SSL 证书是否有效
   - 显示证书有效期

3. **API 端点测试**
   - 测试 `/health` 端点是否可达
   - 验证服务器响应状态

4. **Ping 测试**
   - 测试 TCP 连接延迟
   - 显示连接耗时（毫秒）

5. **聊天功能测试**
   - 测试聊天 API 端点是否可达
   - 验证 `/api/v1/sessions` 端点

6. **Agent 功能测试**
   - 标记需要登录后测试的功能

### 测试时间优化

- 所有测试项目并发执行，总耗时通常在 2-5 秒内
- 单项测试超时时间：5 秒（DNS/SSL/API/Ping）
- 整体诊断超时：30 秒

## 技术实现

### 后端 API

**端点**: `POST /api/v1/diagnostics/network`

**请求体**:
```json
{
  "clientUrl": "https://pa.759800.com"
}
```

**响应体**:
```json
{
  "success": true,
  "data": {
    "timestamp": "2026-01-10T14:30:00Z",
    "tests": [
      {
        "name": "DNS",
        "status": "success",
        "message": "解析成功: 192.168.1.1",
        "duration": 45
      },
      {
        "name": "SSL",
        "status": "success",
        "message": "SSL/TLS 连接成功, 证书有效期至 2027-01-10",
        "duration": 120
      }
      // ... 其他测试项
    ]
  },
  "error": null
}
```

### Rust 命令

**命令**: `run_network_diagnostics`

**参数**:
- `api_url`: String - 要测试的 API 地址

**返回**:
- `NetworkDiagnosticsResult` - 包含所有测试项的结果

### 前端组件

**组件**: `NetworkDiagnosticsModal`

**Props**:
- `isOpen`: boolean - 是否打开模态框
- `onClose`: () => void - 关闭回调
- `apiUrl`: string - 要测试的 API 地址

## 使用方法

### 在设置页面使用

1. 打开 PRD Agent Desktop
2. 点击设置按钮（右上角齿轮图标）
3. 在 "API 服务地址" 部分，点击 "网络诊断" 按钮
4. 在弹出的模态框中，点击 "开始诊断"
5. 查看各项测试结果

### 测试结果说明

- **绿色勾号**: 测试通过
- **红色叉号**: 测试失败
- **黄色警告**: 测试有警告
- **蓝色加载**: 测试进行中

每个测试项都会显示：
- 测试名称（DNS/SSL/API/Ping/Chat/Agent）
- 测试状态（成功/失败/警告）
- 详细信息
- 耗时（毫秒）

## 对比原有功能

### 原有 "快速测试"

- 仅测试 `/health` 端点
- 只返回成功/失败和延迟
- 测试项目单一

### 新增 "网络诊断"

- 多项测试（DNS/SSL/API/Ping/Chat/Agent）
- 详细的测试结果和错误信息
- 更精确的问题定位
- 参考 Cursor 的用户体验

## 注意事项

1. **测试时间**: 完整诊断通常需要 2-5 秒，请耐心等待
2. **网络环境**: 某些网络环境可能会阻止某些测试（如企业防火墙）
3. **SSL 测试**: 仅对 HTTPS 地址执行 SSL 测试
4. **Agent 测试**: 需要登录后才能完整测试 Agent 功能

## 故障排查

### DNS 解析失败

- 检查网络连接
- 检查 DNS 服务器设置
- 尝试使用其他 DNS（如 8.8.8.8）

### SSL 连接失败

- 检查证书是否过期
- 检查系统时间是否正确
- 检查是否有中间人代理（如企业代理）

### API 端点不可达

- 检查服务器是否运行
- 检查防火墙设置
- 检查 API 地址是否正确

### Ping 测试失败

- 检查网络连接
- 检查服务器端口是否开放
- 检查是否有网络代理

## 开发说明

### 添加新的测试项

1. 在后端 `DiagnosticsController.cs` 中添加新的测试方法
2. 在 `NetworkDiagnostics` 方法中调用新测试
3. 前端会自动显示新的测试结果

### 修改测试超时

- 后端：修改 `DiagnosticsController.cs` 中的 `HttpClient` 超时设置
- Rust：修改 `config.rs` 中的 `Client::builder().timeout()` 设置

### 自定义测试项显示

修改 `NetworkDiagnosticsModal.tsx` 中的：
- `getStatusIcon()` - 自定义图标
- `getStatusColor()` - 自定义颜色
- 测试项渲染逻辑

## 相关文件

### 后端
- `prd-api/src/PrdAgent.Api/Controllers/DiagnosticsController.cs`

### Rust
- `prd-desktop/src-tauri/src/commands/config.rs`
- `prd-desktop/src-tauri/src/lib.rs`

### 前端
- `prd-desktop/src/components/NetworkDiagnosticsModal.tsx`
- `prd-desktop/src/components/Settings/SettingsModal.tsx`
