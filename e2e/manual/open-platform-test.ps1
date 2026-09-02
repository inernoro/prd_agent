# 开放平台集成测试脚本 (PowerShell)

$ErrorActionPreference = "Stop"

$API_BASE = "http://localhost:5000/api/v1/open-platform/v1"
$TEST_KEY = "sk-test-permanent-key-for-testing-only"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "开放平台 API 集成测试" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

$test_passed = 0
$test_failed = 0

function Run-Test {
    param(
        [string]$TestName,
        [int]$ExpectedStatus,
        [hashtable]$Headers,
        [string]$Body
    )
    
    Write-Host -NoNewline "测试: $TestName ... "
    
    try {
        $response = Invoke-WebRequest -Uri "$API_BASE/chat/completions" `
            -Method POST `
            -Headers $Headers `
            -Body $Body `
            -ContentType "application/json" `
            -TimeoutSec 30 `
            -UseBasicParsing `
            -ErrorAction SilentlyContinue
        
        $statusCode = $response.StatusCode
    }
    catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
    }
    
    if ($statusCode -eq $ExpectedStatus) {
        Write-Host "通过" -ForegroundColor Green -NoNewline
        Write-Host " (HTTP $statusCode)"
        $script:test_passed++
        return $true
    }
    else {
        Write-Host "失败" -ForegroundColor Red -NoNewline
        Write-Host " (期望 HTTP $ExpectedStatus, 实际 HTTP $statusCode)"
        $script:test_failed++
        return $false
    }
}

Write-Host "1. 认证测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

# 测试 1.1: 无 API Key
Run-Test -TestName "无 API Key" -ExpectedStatus 401 `
    -Headers @{} `
    -Body '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'

# 测试 1.2: 无效 API Key
Run-Test -TestName "无效 API Key" -ExpectedStatus 401 `
    -Headers @{"Authorization" = "Bearer sk-invalid-key"} `
    -Body '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'

# 测试 1.3: 格式错误的 API Key
Run-Test -TestName "格式错误的 API Key" -ExpectedStatus 401 `
    -Headers @{"Authorization" = "Bearer invalid-format"} `
    -Body '{"model":"gpt-4","messages":[{"role":"user","content":"test"}]}'

# 测试 1.4: 测试 Key 认证
Run-Test -TestName "测试 Key 认证" -ExpectedStatus 200 `
    -Headers @{"Authorization" = "Bearer $TEST_KEY"} `
    -Body '{"model":"gpt-4","messages":[{"role":"user","content":"你好"}]}'

Write-Host ""
Write-Host "2. LLM 代理模式测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

Write-Host -NoNewline "测试: LLM 代理模式 - 基础对话 ... "
try {
    $response = Invoke-WebRequest -Uri "$API_BASE/chat/completions" `
        -Method POST `
        -Headers @{"Authorization" = "Bearer $TEST_KEY"} `
        -Body '{"model":"gpt-4","messages":[{"role":"user","content":"1+1=?"}],"stream":true}' `
        -ContentType "application/json" `
        -TimeoutSec 30 `
        -UseBasicParsing
    
    $content = $response.Content
    if ($content -match "data: \[DONE\]") {
        Write-Host "通过" -ForegroundColor Green -NoNewline
        Write-Host " (收到完整 SSE 流)"
        $test_passed++
    }
    else {
        Write-Host "失败" -ForegroundColor Red -NoNewline
        Write-Host " (未收到完整响应)"
        $test_failed++
    }
}
catch {
    Write-Host "失败" -ForegroundColor Red -NoNewline
    Write-Host " (请求异常: $($_.Exception.Message))"
    $test_failed++
}

Write-Host ""
Write-Host "3. PRD 问答模式测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

# 测试 3.1: 缺少 groupId
Run-Test -TestName "PRD 模式 - 缺少 groupId" -ExpectedStatus 400 `
    -Headers @{"Authorization" = "Bearer $TEST_KEY"} `
    -Body '{"model":"prdagent","messages":[{"role":"user","content":"test"}]}'

Write-Host ""
Write-Host "4. 错误处理测试" -ForegroundColor Yellow
Write-Host "----------------------------------------"

# 测试 4.1: 空消息
Run-Test -TestName "空消息" -ExpectedStatus 400 `
    -Headers @{"Authorization" = "Bearer $TEST_KEY"} `
    -Body '{"model":"gpt-4","messages":[]}'

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "测试结果汇总" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "通过: " -NoNewline
Write-Host $test_passed -ForegroundColor Green
Write-Host "失败: " -NoNewline
Write-Host $test_failed -ForegroundColor Red
Write-Host "总计: $($test_passed + $test_failed)"
Write-Host ""

if ($test_failed -eq 0) {
    Write-Host "所有测试通过！" -ForegroundColor Green
    exit 0
}
else {
    Write-Host "部分测试失败" -ForegroundColor Red
    exit 1
}
