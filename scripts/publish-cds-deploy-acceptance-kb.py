#!/usr/bin/env python3
"""把「CDS 可视化部署与验收」步骤发布进一个新的隔离知识库(DocumentStore)。

一个 store「CDS 部署验收知识库」(appKey=cds-deploy-acceptance):
  - 主文档 = doc/guide.cds.deploy-acceptance.md(部署 + 验收步骤)
  - 4 个示例文档 = cds/examples/demo-* 的 README

幂等:按 name+appKey 查重,存在则更新内容,不重复建库。只调既有 REST 端点,不新增后端代码。

环境变量:
  PRD_API_BASE              prd-api 根地址,默认 https://main-prd-agent.miduo.org
  AI_ACCESS_KEY             X-AI-Access-Key(后端 AI 直连密钥),必填
  CDS_TUTORIAL_IMPERSONATE  以哪个真实用户名义建库(X-AI-Impersonate);未设则回退 MAP_AI_USER

用法:
  python3 scripts/publish-cds-deploy-acceptance-kb.py
  python3 scripts/publish-cds-deploy-acceptance-kb.py --dry-run
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

APP_KEY = "cds-deploy-acceptance"
STORE_NAME = "CDS 部署验收知识库"
STORE_DESC = "CDS 可视化一键部署任意前后端 + 数据库 + 消息队列的部署与验收步骤、示例工程、验收清单。"
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
EX = os.path.join(REPO, "cds", "examples")

PRIMARY = {
    "title": "CDS 可视化部署与验收指南",
    "summary": "纯前端一键部署前后端 + 基础设施(含消息队列)的步骤、基础设施目录、验收清单。",
    "tags": ["cds", "deploy", "acceptance", "guide"],
    "path": os.path.join(REPO, "doc", "guide.cds.deploy-acceptance.md"),
}

EXAMPLES = [
    {"title": "示例 · 管理台 + PostgreSQL + Redis", "tags": ["cds", "example", "postgres", "redis"],
     "path": os.path.join(EX, "demo-admin-pg-redis", "README.md")},
    {"title": "示例 · 消息队列 RabbitMQ", "tags": ["cds", "example", "rabbitmq", "queue"],
     "path": os.path.join(EX, "demo-queue-rabbitmq", "README.md")},
    {"title": "示例 · 流处理 Kafka(KRaft)", "tags": ["cds", "example", "kafka", "queue"],
     "path": os.path.join(EX, "demo-stream-kafka", "README.md")},
    {"title": "示例 · 事件 NATS", "tags": ["cds", "example", "nats", "queue"],
     "path": os.path.join(EX, "demo-events-nats", "README.md")},
]


def _cfg():
    base = os.environ.get("PRD_API_BASE", "https://main-prd-agent.miduo.org").rstrip("/")
    key = os.environ.get("AI_ACCESS_KEY", "")
    user = os.environ.get("CDS_TUTORIAL_IMPERSONATE", "") or os.environ.get("MAP_AI_USER", "")
    if not key:
        sys.exit("缺 AI_ACCESS_KEY 环境变量(后端 AI 直连密钥)")
    if not user:
        sys.exit("缺 CDS_TUTORIAL_IMPERSONATE 或 MAP_AI_USER 环境变量(以哪个真实用户名义建库)")
    return base, key, user


def _req(method, path, base, key, user, body=None):
    url = base + path
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-AI-Access-Key", key)
    req.add_header("X-AI-Impersonate", user)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent",
                   "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        sys.exit(f"{method} {path} -> HTTP {e.code}: {raw[:500]}")
    except urllib.error.URLError as e:
        sys.exit(f"{method} {path} 连接失败: {e}")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw}
    if isinstance(parsed, dict) and parsed.get("success") is False:
        err = parsed.get("error") or {}
        msg = err.get("message") if isinstance(err, dict) else err
        sys.exit(f"{method} {path} 业务失败: {msg}")
    if isinstance(parsed, dict) and "data" in parsed:
        return parsed["data"]
    return parsed


def _find_store(base, key, user, name):
    page = 1
    while True:
        data = _req("GET", f"/api/document-store/stores?page={page}&pageSize=100", base, key, user)
        items = (data.get("items") if isinstance(data, dict) else data) or []
        for s in items:
            if s.get("name") == name and s.get("appKey") == APP_KEY:
                return s
        if len(items) < 100:
            return None
        page += 1


def _find_entry(base, key, user, store_id, title):
    data = _req("GET", f"/api/document-store/stores/{store_id}/entries?page=1&pageSize=200", base, key, user)
    items = (data.get("items") if isinstance(data, dict) else data) or []
    for e in items:
        if e.get("title") == title:
            return e
    return None


def _read(path):
    if not os.path.exists(path):
        sys.exit(f"内容文件不存在: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _upsert_entry(base, key, user, store_id, spec, set_primary=False):
    content = _read(spec["path"])
    entry = _find_entry(base, key, user, store_id, spec["title"])
    if not entry:
        entry = _req("POST", f"/api/document-store/stores/{store_id}/entries", base, key, user, {
            "title": spec["title"],
            "summary": spec.get("summary", spec["title"]),
            "sourceType": "upload",
            "contentType": "text/markdown",
            "tags": spec["tags"],
        })
        print(f"  [entry-created] {entry['id']} {spec['title']}")
    else:
        print(f"  [entry-exists]  {entry['id']} {spec['title']}")
    _req("PUT", f"/api/document-store/entries/{entry['id']}/content", base, key, user, {"content": content})
    if set_primary:
        _req("PUT", f"/api/document-store/stores/{store_id}/primary-entry", base, key, user, {"entryId": entry["id"]})
    print(f"    [content-synced] {len(content)} 字{' (主文档)' if set_primary else ''}")
    return entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if args.dry_run:
        print(f"[dry-run] 将确保 store '{STORE_NAME}' (appKey={APP_KEY}) + 主文档 + {len(EXAMPLES)} 个示例文档")
        return
    base, key, user = _cfg()
    print(f"目标 API: {base}  store='{STORE_NAME}'  appKey={APP_KEY}  impersonate={user}")

    store = _find_store(base, key, user, STORE_NAME)
    if store:
        store_id = store["id"]
        print(f"[skip-create] store 已存在: {store_id}")
    else:
        store = _req("POST", "/api/document-store/stores", base, key, user, {
            "name": STORE_NAME,
            "description": STORE_DESC,
            "appKey": APP_KEY,
            "tags": ["cds", "deploy", "acceptance"],
            "isPublic": True,
        })
        store_id = store["id"]
        print(f"[created] store {store_id}")

    _upsert_entry(base, key, user, store_id, PRIMARY, set_primary=True)
    for ex in EXAMPLES:
        _upsert_entry(base, key, user, store_id, ex)

    print(f"\n完成。store_id={store_id}")
    print(f"访问(登录后):知识库 → 「{STORE_NAME}」")
    print(f"store 元信息:GET {base}/api/document-store/stores/{store_id}")


if __name__ == "__main__":
    main()
