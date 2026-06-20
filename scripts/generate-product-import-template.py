#!/usr/bin/env python3
"""生成产品导入初始模板（去重后的应用列表）。"""
from pathlib import Path

try:
    from openpyxl import Workbook
except ImportError as exc:
    raise SystemExit("需要 openpyxl: pip install openpyxl") from exc

APPS = sorted({
    "互动营销", "智能营销", "微商控价", "万能零售助手", "会员小程序", "社交云店",
    "米多总后台", "品牌商后台基础", "新经销助手", "金牌导购员", "防窜物流", "DCRM",
    "微商城", "业务帮帮", "帮助中心", "外勤管理", "赋码采集关联系统", "掌柜云助手", "企微助手",
})

HEADERS = ["产品名称", "产品类型", "产品描述", "产品标识"]
DEFAULT_GRADE = "应用"

root = Path(__file__).resolve().parents[1]
out_dir = root / "prd-admin" / "public" / "templates"
out_dir.mkdir(parents=True, exist_ok=True)

csv_path = out_dir / "product-import-initial-apps.csv"
with csv_path.open("w", encoding="utf-8-sig", newline="") as f:
    f.write(",".join(HEADERS) + "\n")
    for name in APPS:
        f.write(f"{name},{DEFAULT_GRADE},,\n")

xlsx_path = out_dir / "product-import-initial-apps.xlsx"
wb = Workbook()
ws = wb.active
ws.title = "产品导入"
ws.append(HEADERS)
for name in APPS:
    ws.append([name, DEFAULT_GRADE, "", ""])
wb.save(xlsx_path)

print(f"Wrote {len(APPS)} apps to:")
print(f"  {csv_path}")
print(f"  {xlsx_path}")
