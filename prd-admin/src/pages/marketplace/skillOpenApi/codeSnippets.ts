/**
 * AI 接入代码样本生成器。
 *
 * 返回的字符串直接喂给 <pre><code> 展示，外加"一键复制"按钮。
 * 使用占位符 `YOUR_API_KEY` —— 如果用户刚创建 Key，也可把真实明文传入，
 * 但这只在"刚生成"的瞬间做一次，列表里只展示 keyPrefix。
 */

export function resolveOpenApiBase(): string {
  if (typeof window === 'undefined') return 'https://your-platform.example.com';
  return window.location.origin;
}

export function buildCurlListSnippet(apiKey: string, baseUrl: string): string {
  return `curl -sS "${baseUrl}/api/open/marketplace/skills?keyword=&sort=hot&limit=20" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Accept: application/json"`;
}

export function buildCurlForkSnippet(apiKey: string, baseUrl: string): string {
  return `# 1) 查询技能
curl -sS "${baseUrl}/api/open/marketplace/skills?keyword=prd" \\
  -H "Authorization: Bearer ${apiKey}"

# 2) 取到返回 items[0].id 后触发 fork（计数 +1 并返回 zip 下载 URL）
curl -sS -X POST "${baseUrl}/api/open/marketplace/skills/SKILL_ID/fork" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" -d '{}'

# 3) 按返回的 data.downloadUrl 把 zip 存到本地
# curl -L -o skill.zip "<downloadUrl>"`;
}

export function buildCurlUploadSnippet(apiKey: string, baseUrl: string): string {
  return `# 注意：上传需 scope = marketplace.skills:write
curl -sS -X POST "${baseUrl}/api/open/marketplace/skills/upload" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -F "file=@./my-skill.zip" \\
  -F "title=我的新技能" \\
  -F "description=30 字以内概述这个技能做什么" \\
  -F "iconEmoji=🐟" \\
  -F 'tagsJson=["AI","效率"]'`;
}

export function buildTypeScriptSnippet(apiKey: string, baseUrl: string): string {
  return `// TypeScript / Node 18+（原生 fetch）
const BASE = ${JSON.stringify(baseUrl)};
const KEY = process.env.PRD_AGENT_API_KEY ?? ${JSON.stringify(apiKey)};

async function callOpenApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(\`\${BASE}\${path}\`, {
    ...init,
    headers: {
      Authorization: \`Bearer \${KEY}\`,
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  // 30 天内过期时，响应头会带 X-AgentApiKey-ExpiringSoon / X-AgentApiKey-DaysLeft
  const expiring = res.headers.get('X-AgentApiKey-ExpiringSoon') === 'true';
  if (expiring) {
    console.warn('[PrdAgent] API Key 即将过期，剩余', res.headers.get('X-AgentApiKey-DaysLeft'), '天');
  }
  if (!res.ok) throw new Error(\`HTTP \${res.status}: \${await res.text()}\`);
  const json = await res.json();
  if (!json.success) throw new Error(\`\${json.error?.code}: \${json.error?.message}\`);
  return json.data as T;
}

// 示例：列出前 20 条热门技能
const { items } = await callOpenApi<{ items: any[] }>(
  '/api/open/marketplace/skills?sort=hot&limit=20',
);
console.log(items.map((s) => s.title));

// 示例：fork 技能拿 zip 下载地址
const { downloadUrl, fileName } = await callOpenApi<{ downloadUrl: string; fileName: string }>(
  \`/api/open/marketplace/skills/\${items[0].id}/fork\`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
);
console.log('Download:', downloadUrl, fileName);`;
}

export function buildPythonSnippet(apiKey: string, baseUrl: string): string {
  return `# Python 3.9+（requests）
import os
import requests

BASE = ${JSON.stringify(baseUrl)}
KEY = os.environ.get("PRD_AGENT_API_KEY", ${JSON.stringify(apiKey)})

def call(path: str, *, method: str = "GET", **kwargs):
    r = requests.request(
        method,
        f"{BASE}{path}",
        headers={"Authorization": f"Bearer {KEY}", "Accept": "application/json"},
        timeout=30,
        **kwargs,
    )
    # 30 天内过期时，响应头会带 X-AgentApiKey-ExpiringSoon / X-AgentApiKey-DaysLeft
    if r.headers.get("X-AgentApiKey-ExpiringSoon") == "true":
        print(f"[PrdAgent] API Key 即将过期，剩余 {r.headers.get('X-AgentApiKey-DaysLeft')} 天")
    r.raise_for_status()
    payload = r.json()
    if not payload.get("success"):
        raise RuntimeError(payload.get("error"))
    return payload["data"]

# 示例：列出前 20 条热门技能
data = call("/api/open/marketplace/skills?sort=hot&limit=20")
for s in data["items"]:
    print(s["title"], s["downloadCount"])

# 示例：fork 一条技能拿 zip 下载地址
skill_id = data["items"][0]["id"]
fork = call(f"/api/open/marketplace/skills/{skill_id}/fork", method="POST", json={})
print("Download:", fork["downloadUrl"], fork["fileName"])`;
}
