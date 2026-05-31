#!/usr/bin/env python3
"""把 4 个 CDS 教程场景各发布进一个独立隔离的知识库(DocumentStore)。

每个场景 = 一个独立 store(appKey=cds-tutorial),互不污染;删其一不影响其余
(DocumentStoreController.DeleteStore 级联清理)。脚本幂等:按 name+appKey 查重,
存在则更新内容,不重复建库。

依赖:仅标准库(urllib)。不新增后端代码,只调既有 REST 端点。

环境变量:
  PRD_API_BASE             prd-api 根地址,默认 http://localhost:5000
  AI_ACCESS_KEY            X-AI-Access-Key(后端 AI 直连密钥)
  CDS_TUTORIAL_IMPERSONATE 以哪个真实用户名义建库(X-AI-Impersonate),必填

用法:
  python3 scripts/publish-cds-tutorial-kb.py            # 发布/更新全部 4 个场景
  python3 scripts/publish-cds-tutorial-kb.py --dry-run  # 只打印将要做什么
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

APP_KEY = "cds-tutorial"
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
EX = os.path.join(REPO, "cds", "examples")

# 场景定义:store 名 + 描述 + 内容来源(示例 README)。
SCENARIOS = [
    {
        "name": "CDS 教程 01 - 静态网页托管",
        "description": "横向场景①:把纯前端目录托管成可访问站点,无后端无数据库。",
        "tags": ["cds", "tutorial", "static"],
        "readme": os.path.join(EX, "tutorial-01-static-web", "README.md"),
    },
    {
        "name": "CDS 教程 02 - 网页 + 后台",
        "description": "横向场景②:前端静态站 + Express 后端,path 前缀路由 / 与 /api/。",
        "tags": ["cds", "tutorial", "backend"],
        "readme": os.path.join(EX, "tutorial-02-web-and-backend", "README.md"),
    },
    {
        "name": "CDS 教程 03 - 网页 + 后台 + MongoDB",
        "description": "横向场景③:在场景②基础上加 MongoDB,后端真实读写一条记录。",
        "tags": ["cds", "tutorial", "mongodb"],
        "readme": os.path.join(EX, "tutorial-03-web-backend-mongo", "README.md"),
    },
    {
        "name": "CDS 教程 04 - 多体前后端分离 + Redis + MySQL + RabbitMQ",
        "description": "横向场景④:前后端分离 + 三种基础设施(redis/mysql/rabbitmq)。",
        "tags": ["cds", "tutorial", "fullstack", "infra"],
        "readme": os.path.join(EX, "tutorial-04-fullstack-infra", "README.md"),
    },
]


def _cfg():
    base = os.environ.get("PRD_API_BASE", "http://localhost:5000").rstrip("/")
    key = os.environ.get("AI_ACCESS_KEY", "")
    user = os.environ.get("CDS_TUTORIAL_IMPERSONATE", "")
    if not key:
        sys.exit("缺 AI_ACCESS_KEY 环境变量(后端 AI 直连密钥)")
    if not user:
        sys.exit("缺 CDS_TUTORIAL_IMPERSONATE 环境变量(以哪个真实用户名义建库)")
    return base, key, user


def _req(method, path, base, key, user, body=None):
    url = base + path
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-AI-Access-Key", key)
    req.add_header("X-AI-Impersonate", user)
    req.add_header("Content-Type", "application/json")
    # 预览域名走 Cloudflare,默认 urllib UA 会被 1010 拦,带个常规 UA。
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
    # ApiResponse<T> = {success, data, error}
    if isinstance(parsed, dict) and parsed.get("success") is False:
        err = parsed.get("error") or {}
        msg = err.get("message") if isinstance(err, dict) else err
        sys.exit(f"{method} {path} 业务失败: {msg}")
    if isinstance(parsed, dict) and "data" in parsed:
        return parsed["data"]
    return parsed


def _find_store(base, key, user, name):
    """在我的 store 列表里按 name 查重(同 appKey),逐页翻直到找到或遍历完。"""
    page = 1
    page_size = 100  # 服务端最大值
    while True:
        data = _req("GET", f"/api/document-store/stores?page={page}&pageSize={page_size}",
                    base, key, user)
        items = data.get("items") if isinstance(data, dict) else data
        items = items or []
        for s in items:
            if s.get("name") == name and s.get("appKey") == APP_KEY:
                return s
        if len(items) < page_size:
            break
        page += 1
    return None


def _find_entry(base, key, user, store_id, title):
    data = _req("GET", f"/api/document-store/stores/{store_id}/entries?page=1&pageSize=200",
                base, key, user)
    items = data.get("items") if isinstance(data, dict) else data
    for e in items or []:
        if e.get("title") == title:
            return e
    return None


def publish(scenario, base, key, user, dry_run):
    name = scenario["name"]
    content = ""
    if os.path.exists(scenario["readme"]):
        with open(scenario["readme"], "r", encoding="utf-8") as f:
            content = f.read()
    title = name  # entry 标题与 store 同名,作为主文档

    if dry_run:
        print(f"[dry-run] 将确保 store '{name}'(appKey={APP_KEY}) + 主文档 {len(content)} 字")
        return

    store = _find_store(base, key, user, name)
    if store:
        store_id = store["id"]
        print(f"[skip-create] store 已存在: {store_id} '{name}'")
    else:
        store = _req("POST", "/api/document-store/stores", base, key, user, {
            "name": name,
            "description": scenario["description"],
            "appKey": APP_KEY,
            "tags": scenario["tags"],
            "isPublic": True,
        })
        store_id = store["id"]
        print(f"[created] store {store_id} '{name}'")

    entry = _find_entry(base, key, user, store_id, title)
    if not entry:
        entry = _req("POST", f"/api/document-store/stores/{store_id}/entries",
                     base, key, user, {
                         "title": title,
                         "summary": scenario["description"],
                         "sourceType": "upload",
                         "contentType": "text/markdown",
                         "tags": scenario["tags"],
                     })
        print(f"  [entry-created] {entry['id']}")
    else:
        print(f"  [entry-exists] {entry['id']}")
    _req("PUT", f"/api/document-store/entries/{entry['id']}/content",
         base, key, user, {"content": content})
    # 设为主文档(README 风格)
    _req("PUT", f"/api/document-store/stores/{store_id}/primary-entry",
         base, key, user, {"entryId": entry["id"]})
    print(f"  [content-synced] {len(content)} 字, 已设为主文档")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只打印将要做什么,不调 API")
    args = ap.parse_args()
    base, key, user = _cfg() if not args.dry_run else ("(dry)", "(dry)", "(dry)")
    print(f"目标 API: {base}  appKey={APP_KEY}  共 {len(SCENARIOS)} 个隔离知识库")
    for sc in SCENARIOS:
        publish(sc, base, key, user, args.dry_run)
    print("完成。每个场景独立 store,删其一不影响其余。")


if __name__ == "__main__":
    main()
