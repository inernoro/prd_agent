---
name: api-debug
description: Query the PrdAgent API to fetch real data for debugging. Use when you need to investigate issues, verify data states, or understand system behavior by querying actual API endpoints.
---

# API Debug

Query the PrdAgent API using AI Access Key authentication to fetch real data for debugging and investigation.

## When to Use

This skill should be used when:
- Debugging issues that require checking actual data states
- Investigating user-reported problems
- Verifying API behavior or data consistency
- Understanding system state without guessing

## Configuration

The API uses AI Access Key authentication:
- **Environment Variable**: `AI_ACCESS_KEY` (configured on the server)
- **Request Headers**:
  - `X-AI-Access-Key: {key}` - The configured access key
  - `X-AI-Impersonate: {username}` - A valid username to impersonate (must exist in database)

## Base URL

```
http://localhost:8000
```

> 注意：用户可能配置了不同端口，以实际运行的 API 服务端口为准。

## Common API Endpoints

### User Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List all users |
| GET | `/api/users/{userId}` | Get user details |

### Authentication & Authorization
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/authz/users` | List users with permissions |
| GET | `/api/authz/roles` | List system roles |

### Projects & PRD
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/prd/projects` | List projects |
| GET | `/api/prd/projects/{id}` | Get project details |

### Model Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/mds/model-groups` | List all model groups |
| PUT | `/api/mds/model-groups/{id}` | Update model group (e.g., set isDefaultForType) |
| GET | `/api/mds/platforms` | List LLM platforms |
| GET | `/api/mds/models` | List configured models |

### LLM Logs (Critical for debugging)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/logs/llm?limit=10` | Get recent LLM request logs |

### Visual Agent
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/visual-agent/image-master/workspaces` | List workspaces |
| POST | `/api/visual-agent/image-gen/generate` | Generate image |
| POST | `/api/visual-agent/image-gen/compose` | Multi-image compose |

### System
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/init/status` | Get system initialization status |

## Execution Steps

1. **Identify the data needed**: Determine which API endpoint to query based on the debugging context.

2. **Execute the query**: Use curl with the AI Access Key headers:
   ```bash
   curl -s "http://[::1]:5000/api/{endpoint}" \
     -H "X-AI-Access-Key: 123" \
     -H "X-AI-Impersonate: admin"
   ```

3. **Parse the response**: The API returns JSON in this format:
   ```json
   {
     "success": true,
     "data": { ... },
     "error": null
   }
   ```

4. **Analyze the data**: Use the returned data to understand the system state and diagnose issues.

## LLM Log Analysis (Important)

When debugging LLM-related features, always check the LLM logs:

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/api/logs/llm?limit=10" -Headers @{"X-AI-Access-Key"="123"; "X-AI-Impersonate"="admin"} | ForEach-Object { $_.data.items } | ForEach-Object {
    Write-Host "---"
    Write-Host "Model: $($_.model)"
    Write-Host "Purpose: $($_.requestPurpose)"
    Write-Host "Status: $($_.status)"
    Write-Host "Duration: $($_.durationMs)ms"
    if ($_.error) { Write-Host "Error: $($_.error)" }
}
```

Key fields to check:
- `requestPurpose`: Identifies which feature made the call (e.g., `visual-agent.compose::vision`)
- `status`: `succeeded` or `failed`
- `error`: Error message if failed
- `requestBody`: The actual request sent to LLM (check if data is missing)
- `answerPreview`: Preview of LLM response

## Example Queries

### Get all users
```bash
curl -s "http://[::1]:5000/api/users" \
  -H "X-AI-Access-Key: 123" \
  -H "X-AI-Impersonate: admin" | jq
```

### Get specific user
```bash
curl -s "http://[::1]:5000/api/users/user1" \
  -H "X-AI-Access-Key: 123" \
  -H "X-AI-Impersonate: admin" | jq
```

### List projects with pagination
```bash
curl -s "http://[::1]:5000/api/prd/projects?page=1&pageSize=10" \
  -H "X-AI-Access-Key: 123" \
  -H "X-AI-Impersonate: admin" | jq
```

## Error Handling

- **401 Unauthorized**: Check that `AI_ACCESS_KEY` environment variable is set on the server
- **401 User not found**: The username in `X-AI-Impersonate` must exist in the database
- **403 Forbidden**: Should not happen with AI Access Key (has super permissions)
- **404 Not Found**: Check the endpoint path

## Security Notes

- This skill has super permissions and can access all data
- Use responsibly for debugging purposes only
- The access key should be kept secure and not logged
- All requests are logged on the server for audit purposes

## Related Skills

- **auto-test-debug**：涉及 LLM 调用链路的自动化测试与调试，包含完整的验证流程和问题定位方法
