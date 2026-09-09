#!/usr/bin/env python3
"""校验 cds-monitors.yml 的监控声明契约。

SSOT：.claude/rules/degradation-must-alarm.md

守四件事，每一件都是「写错了不会有任何地方报错，只会让铃不响」的那种：

1. 结构与枚举合法——kind / expect.field / expect.op 必须是 CDS 真正认识的值，
   写了 CDS 读不懂的判据，监控建不起来，而声明文件看着好好的；
2. `probe: light` 的必须是 6 小时常设——这是规则层 3 的核心约定，
   「我一测试就出问题、系统迟迟不反馈」正是靠它把故障存活期压到 6 小时以内；
3. health-json 必须给全 componentId 与 expect 三件套，否则探针无从判定；
4. notify.source 必须已在 MAP 的 AdminNotificationSourceCatalog 里登记——
   跨文件接线守卫：声明一个 MAP 不认识的 source，通知会落进没有归属分区的黑洞。
"""

from __future__ import annotations

import pathlib
import re
import sys

import yaml

REPO = pathlib.Path(__file__).resolve().parents[2]
MONITORS = REPO / "cds-monitors.yml"
CATALOG = REPO / "prd-api/src/PrdAgent.Core/Models/AdminNotificationSourceCatalog.cs"
MONITOR_SERVICE = REPO / "cds/src/services/uptime-custom-monitor.ts"

# 6 小时。规则层 3：轻探针的常设频率。
LIGHT_INTERVAL_SECONDS = 21600
REQUIRED_KEYS = {"id", "name", "kind", "probe", "severity", "notify"}
VALID_PROBES = {"light", "heavy"}
VALID_SEVERITIES = {"P0", "P1", "P2"}


def read_enum_from_ts(pattern: str) -> set[str]:
    """从 CDS 源码里取枚举，而不是在这里抄一份。

    抄一份就是第二个判定源（predicate-and-wiring-discipline 形状 3）：
    CDS 加了一种 kind 而这里没跟上，守卫会把合法声明判成非法。
    """
    source = MONITOR_SERVICE.read_text(encoding="utf-8")
    m = re.search(pattern, source)
    if not m:
        raise SystemExit(f"cds monitors contract failed:\n- 在 {MONITOR_SERVICE.name} 里找不到枚举定义（{pattern}）")
    return set(re.findall(r"'([^']+)'", m.group(1)))


def registered_sources() -> set[str]:
    """MAP 通知来源目录里已登记的 source。"""
    source = CATALOG.read_text(encoding="utf-8")
    return set(re.findall(r'new\("([^"]+)"', source))


def main() -> int:
    doc = yaml.safe_load(MONITORS.read_text(encoding="utf-8"))
    monitors = doc.get("monitors") or []
    errors: list[str] = []

    if not monitors:
        errors.append("monitors 为空——声明文件存在不等于有监控")

    valid_kinds = read_enum_from_ts(r"MONITOR_KINDS:\s*ReadonlyArray<UptimeCustomMonitorKind>\s*=\s*\[([^\]]+)\]")
    valid_fields = read_enum_from_ts(r"HEALTH_FIELDS\s*=\s*\[([^\]]+)\]")
    valid_ops = read_enum_from_ts(r"HEALTH_OPS\s*=\s*\[([^\]]+)\]")
    sources = registered_sources()

    seen_ids: set[str] = set()
    for entry in monitors:
        mid = entry.get("id", "<无 id>")
        missing = REQUIRED_KEYS - set(entry)
        if missing:
            errors.append(f"{mid}: 缺少必填字段 {sorted(missing)}")
            continue
        if mid in seen_ids:
            errors.append(f"{mid}: id 重复——告警去重与台账追溯都以它为键")
        seen_ids.add(mid)

        if entry["kind"] not in valid_kinds:
            errors.append(f"{mid}: kind={entry['kind']} 不是 CDS 认识的探测方式 {sorted(valid_kinds)}")
        if entry["probe"] not in VALID_PROBES:
            errors.append(f"{mid}: probe={entry['probe']} 必须是 light 或 heavy")
        if entry["severity"] not in VALID_SEVERITIES:
            errors.append(f"{mid}: severity={entry['severity']} 必须是 P0/P1/P2")

        # 规则层 3 的核心约定
        if entry["probe"] == "light":
            interval = entry.get("intervalSeconds")
            if interval != LIGHT_INTERVAL_SECONDS:
                errors.append(
                    f"{mid}: probe=light 必须是 {LIGHT_INTERVAL_SECONDS} 秒（6 小时）常设监控，"
                    f"当前 {interval}。轻探针提频正是「一测试才发现问题」的解药"
                )

        if entry["kind"] == "health-json":
            if not entry.get("componentId"):
                errors.append(f"{mid}: health-json 必须指定 componentId")
            expect = entry.get("expect")
            if not isinstance(expect, dict):
                errors.append(f"{mid}: health-json 必须给结构化 expect（field/op/value）")
            else:
                if expect.get("field") not in valid_fields:
                    errors.append(f"{mid}: expect.field={expect.get('field')} 不在 {sorted(valid_fields)}")
                if expect.get("op") not in valid_ops:
                    errors.append(f"{mid}: expect.op={expect.get('op')} 不在 {sorted(valid_ops)}")
                if expect.get("value") is None or str(expect.get("value")).strip() == "":
                    errors.append(f"{mid}: expect.value 不能为空（注意 0 是合法值，不是空）")
            # 自由文本判据在这条链路上被明确禁掉，见规则 3.2
            if "assert" in entry:
                errors.append(f"{mid}: 不许用自由文本 assert，判据只能是结构化 expect")

        notify = entry.get("notify") or {}
        src = notify.get("source")
        if not src:
            errors.append(f"{mid}: notify.source 必填")
        elif src not in sources:
            errors.append(
                f"{mid}: notify.source={src} 没有在 MAP 的 AdminNotificationSourceCatalog 登记，"
                f"通知会落进没有归属分区的黑洞"
            )

    if errors:
        print("cds monitors contract failed:")
        for e in errors:
            print(f"- {e}")
        return 1

    light = sum(1 for m in monitors if m["probe"] == "light")
    print(
        f"cds monitors contract passed: {len(monitors)} 条声明，"
        f"{light} 条 6 小时常设轻探针，枚举与通知来源均已对齐"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
