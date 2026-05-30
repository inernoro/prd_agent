#!/usr/bin/env python3
"""
跨环境知识库同步（design.acceptance-kb.md §5.C）。

把一个知识库从源环境导出、导入到目标环境，按 metadata.reportId 幂等去重。
本期只同步文本类正文（验收报告天然是 markdown），二进制附件源端标 skipped、不搬。

鉴权：与 archive_report.py 一致——AI 超级密钥 + 模拟登录头。
  - 默认两端共用 env：AI_ACCESS_KEY（密钥）+ MAP_AI_USER（模拟用户）
  - 目标端如需不同密钥，用 --to-key-env / --to-user-env 指向另一组 env 变量名

用法：
  export AI_ACCESS_KEY=...  MAP_AI_USER=...
  python3 kb_sync.py \
    --from https://<src-branch>.miduo.org \
    --to   https://<dst-branch>.miduo.org \
    --store 验收报告
"""
import argparse
import json
import os
import subprocess
import sys

API_BASE = "/api/document-store"


def curl(args, retries=3):
    last = ""
    for i in range(retries):
        try:
            out = subprocess.run(["curl", "-sS", "--max-time", "120", *args],
                                 capture_output=True, text=True, timeout=130)
            txt = out.stdout.strip()
            if not txt:
                last = out.stderr.strip() or "空响应"
                continue
            return json.loads(txt)
        except Exception as e:  # noqa: BLE001
            last = str(e)[:160]
    raise RuntimeError(f"curl 失败（{retries} 次）：{last}")


def headers(key, user, with_json=False):
    h = ["-H", f"X-AI-Access-Key: {key}", "-H", f"X-AI-Impersonate: {user}"]
    if with_json:
        h += ["-H", "Content-Type: application/json"]
    return h


def find_store(base, H, name):
    stores = curl(H + [f"{base}{API_BASE}/stores?pageSize=100"])["data"]["items"]
    match = [s for s in stores if s["name"] == name]
    return match[0]["id"] if match else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True, help="源环境 base URL，如 https://a.miduo.org")
    ap.add_argument("--to", dest="dst", required=True, help="目标环境 base URL")
    ap.add_argument("--store", required=True, help="知识库名称（两端按名匹配/创建）")
    ap.add_argument("--key-env", default="AI_ACCESS_KEY", help="源端密钥 env 变量名")
    ap.add_argument("--user-env", default="MAP_AI_USER", help="源端模拟用户 env 变量名")
    ap.add_argument("--to-key-env", default=None, help="目标端密钥 env（缺省同源端）")
    ap.add_argument("--to-user-env", default=None, help="目标端模拟用户 env（缺省同源端）")
    ap.add_argument("--dry-run", action="store_true", help="只导出并打印统计，不写目标端")
    a = ap.parse_args()

    src = a.src.rstrip("/")
    dst = a.dst.rstrip("/")
    src_key = os.environ[a.key_env]
    src_user = os.environ[a.user_env]
    dst_key = os.environ[a.to_key_env] if a.to_key_env else src_key
    dst_user = os.environ[a.to_user_env] if a.to_user_env else src_user

    Hs = headers(src_key, src_user)
    Hd = headers(dst_key, dst_user)
    HdJ = headers(dst_key, dst_user, with_json=True)

    # 1. 源端定位库 → 导出 bundle
    sid = find_store(src, Hs, a.store)
    if not sid:
        print(f"[错误] 源环境找不到库「{a.store}」")
        sys.exit(2)
    print(f"源库 id={sid}，导出中…")
    bundle = curl(Hs + [f"{src}{API_BASE}/stores/{sid}/export"])["data"]
    stats = bundle.get("stats", {})
    print(f"导出完成：共 {stats.get('total', '?')} 条，二进制跳过 {stats.get('binarySkipped', 0)} 条")

    if a.dry_run:
        print("[dry-run] 不写目标端。")
        return

    # 2. 目标端导入（find-or-create + reportId 幂等去重）
    print(f"导入到 {dst} …")
    res = curl(HdJ + ["-X", "POST", "-d", json.dumps(bundle, ensure_ascii=False),
                      f"{dst}{API_BASE}/stores/import"])
    if not res.get("success"):
        print(f"[错误] 导入失败：{json.dumps(res.get('error'), ensure_ascii=False)}")
        sys.exit(3)
    d = res["data"]
    print(f"导入完成：storeId={d['storeId']} 新增={d['created']} 跳过(已存在)={d['skipped']} 失败={d['failed']}")


if __name__ == "__main__":
    main()
