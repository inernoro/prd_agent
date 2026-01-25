---
name: auto-test-debug
description: Automated testing and debugging skill for PrdAgent backend. Use when user mentions "automated testing", "end-to-end test", "E2E test", "integration test", "debug with real requests", "verify fix with browser", "test model pool", "test image generation", "verify LLM logs", or any scenario requiring real UI-driven testing combined with API verification.
---

# Automated Testing & Debugging

This skill provides a systematic approach to debugging backend issues using browser automation and API verification.

## Core Workflow

### 1. Problem Identification

Query relevant API endpoints to understand current state:

```bash
# Query LLM request logs
curl -s "http://localhost:5000/api/logs/llm?pageSize=5" \
  -H "X-AI-Access-Key: 123" -H "X-AI-Impersonate: admin" | jq '.data.items[] | {requestId, modelGroupId, modelGroupName, status}'

# Query AppCaller configuration
curl -s "http://localhost:5000/api/open-platform/app-callers?pageSize=100" \
  -H "X-AI-Access-Key: 123" -H "X-AI-Impersonate: admin" | jq '.data.items[] | select(.appCode | contains("visual-agent"))'

# Query Model Groups
curl -s "http://localhost:5000/api/mds/model-groups" \
  -H "X-AI-Access-Key: 123" -H "X-AI-Impersonate: admin" | jq
```

Note: On Windows PowerShell, use `Invoke-RestMethod` with `-Headers @{...}` syntax instead.

### 2. Add Strategic Debug Logging

Add `_logger.LogInformation` at critical points in the code path:
- Before and after key method calls
- When retrieving or setting important values
- At decision branch points

Example pattern:
```csharp
_logger.LogInformation("[ComponentName] MethodName: param1={P1}, param2={P2}, result={Result}",
    param1, param2 ?? "(null)", result);
```

### 3. Build and Start Server

```bash
# Stop existing server (cross-platform)
# Windows: Get-Process dotnet -ErrorAction SilentlyContinue | Stop-Process -Force
# Mac/Linux: pkill -f dotnet || true

# Build (working_directory: prd-api)
dotnet build --no-restore

# Start server in background (working_directory: prd-api/src/PrdAgent.Api)
dotnet run --no-build
```

### 4. Browser Automation Testing

Use MCP browser tools for real UI testing:

```
1. browser_navigate -> target page URL
2. browser_lock -> lock browser for automation
3. browser_snapshot -> get current page state
4. browser_click -> click interactive elements
5. browser_fill -> fill form inputs
6. browser_press_key -> trigger actions (Enter, etc.)
7. sleep N -> wait for async operations
8. browser_unlock -> release browser
```

Key patterns:
- Always lock browser before interaction sequence
- Use Shell tool with `sleep N` (or `Start-Sleep -Seconds N` on Windows) between actions
- Unlock browser when done

### 5. Verify Results

After triggering action, verify via API:

```bash
curl -s "http://localhost:5000/api/logs/llm?pageSize=1" \
  -H "X-AI-Access-Key: 123" -H "X-AI-Impersonate: admin" | jq '.data.items[0]'
```

Check terminal logs for debug output:
```bash
# Terminal logs are stored in the Cursor terminals folder
# Use LS tool to list: ~/.cursor/projects/{project-slug}/terminals/
# Use Read tool to read the terminal output file
```

### 6. Cleanup Debug Logs

After fix is verified, remove temporary debug logs to keep code clean.

## Common Issues & Solutions

### Issue: Field appears null in logs despite being set in context

**Root Cause Pattern**: The context object (`LlmRequestContext`) correctly contains the value, but the log writer (`LlmLogStart`) doesn't receive it.

**Diagnosis Steps**:
1. Add debug log before context creation to verify value
2. Trace the data flow: Context -> LogWriter -> Database
3. Check if `LlmLogStart` constructor includes all required fields

**Fix Pattern**: Ensure all context fields are passed to log writer:
```csharp
// In the client (e.g., OpenAIImageClient.cs)
new LlmLogStart(
    // ... existing fields ...
    ModelGroupId: ctx?.ModelGroupId,      // <-- Often missing
    ModelGroupName: ctx?.ModelGroupName,  // <-- Often missing  
    IsDefaultModelGroup: ctx?.IsDefaultModelGroup)
```

### Issue: Model pool scheduling not working

**Check Points**:
1. AppCaller exists: `/api/open-platform/app-callers`
2. ModelRequirements contains correct ModelGroupIds
3. ModelGroups exist: `/api/mds/model-groups`
4. Worker calls `ResolveModelGroupAsync` before creating `LlmRequestContext`

### Issue: Legacy model pool fallback

When `group.Id.StartsWith("legacy-")`, scheduler returns null for `ModelGroupId/Name`. This is intentional for direct single-model calls but may mask issues.

## Test Scenarios Checklist

1. **With Model Pool**: Configure AppCaller with dedicated model pool, verify `modelGroupId` in logs
2. **Without Model Pool**: Remove model pool binding, verify fallback behavior
3. **Multiple Pools**: Configure multiple pools, verify random selection works
4. **Error Cases**: Test with invalid configurations, verify error handling

## Key Files Reference

| Component | File Path |
|-----------|-----------|
| Image Gen Worker | `prd-api/src/PrdAgent.Api/Services/ImageGenRunWorker.cs` |
| Image Client | `prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIImageClient.cs` |
| Model Scheduler | `prd-api/src/PrdAgent.Infrastructure/LLM/SmartModelScheduler.cs` |
| Log Writer | `prd-api/src/PrdAgent.Infrastructure/LLM/LlmRequestLogWriter.cs` |
| Log Start Record | `prd-api/src/PrdAgent.Core/Interfaces/ILlmRequestLogWriter.cs` |
| Request Context | `prd-api/src/PrdAgent.Core/Models/LlmRequestContext.cs` |
