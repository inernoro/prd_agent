#!/usr/bin/env python3
"""监控自发现的跨语言契约自检。

声明不再放在仓库里（原来那份 cds-monitors.yml 已删）——实现了协议的自检端点
自己说「该怎么监控我」，CDS 插上一个地址就读得到。好处是声明与被监控的东西
同生共死；代价是**声明的一方与解析的一方在两种语言里**，键名或枚举值对不上时
两边都「看着对」，而那条监控会静默地不存在（predicate-and-wiring-discipline 形状 3）。

所以这里逐项比对：
  1. 自描述段的键名（`cds:monitor`）两边一致；
  2. C# 端点里用到的每个字段名，TS 解析器都认；
  3. C# 端点里写的枚举值（op / severity / field / observeMode），TS 解析器都接受；
  4. 被动观测那条一定带了 sampleComponentId——否则零流量会被读成一切正常。

SSOT：.claude/rules/degradation-must-alarm.md、doc/spec.platform.monitor-discovery.md
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
ENDPOINT = REPO / "llmgw/serving/GatewayHttpEndpoints.cs"
PARSER = REPO / "cds/src/services/monitor-discovery.ts"
# 运算枚举的 SSOT 在 monitor-assertions（解析器是 import 过去的），
# 只扫解析器文件会把 eq / gt 判成「不认」——判据太窄（形状 1）。
ASSERTIONS = REPO / "cds/src/services/monitor-assertions.ts"
SPEC = REPO / "doc/spec.platform.monitor-discovery.md"

DISCOVERY_KEY = "cds:monitor"
# 解析器认得的字段。改解析器时这里要同步——它就是「协议有哪些字段」的清单。
KNOWN_FIELDS = {
    "name", "field", "op", "value", "intervalSeconds", "failuresToAlarm",
    "severity", "observeMode", "sampleComponentId", "publicVisible", "publicName",
}


def fail(errors: list[str]) -> int:
    print("monitor discovery contract failed:")
    for e in errors:
        print(f"- {e}")
    return 1


def main() -> int:
    errors: list[str] = []
    for path in (ENDPOINT, PARSER, ASSERTIONS, SPEC):
        if not path.exists():
            errors.append(f"缺文件：{path.relative_to(REPO)}")
    if errors:
        return fail(errors)

    endpoint = ENDPOINT.read_text(encoding="utf-8")
    # 解析器认什么，看它自己加上它 import 的枚举 SSOT。
    parser = PARSER.read_text(encoding="utf-8") + ASSERTIONS.read_text(encoding="utf-8")

    # 1. 键名两边一致
    if f"'{DISCOVERY_KEY}'" not in parser:
        errors.append(f"解析器里找不到自描述键 {DISCOVERY_KEY}")
    if f'"{DISCOVERY_KEY}"' not in endpoint:
        errors.append(f"自检端点里找不到自描述键 {DISCOVERY_KEY}，它一条监控都不会自报")

    # 2/3. 端点里每个自描述段的字段名与枚举值，解析器都要认
    blocks = re.findall(
        r'\["cds:monitor"\]\s*=\s*new\s*\{(.*?)\n\s*\},',
        endpoint,
        flags=re.S,
    )
    if not blocks:
        errors.append("自检端点里没有任何 cds:monitor 段——没有声明就没有监控")

    declared_ops: set[str] = set()
    for i, block in enumerate(blocks):
        used = set(re.findall(r"^\s*(\w+)\s*=", block, flags=re.M))
        unknown = used - KNOWN_FIELDS
        if unknown:
            errors.append(
                f"第 {i + 1} 段自描述用了解析器不认的字段 {sorted(unknown)}"
                f"——写了也不生效，而且两边都不会报错"
            )
        for key in ("op", "severity", "field", "observeMode"):
            for value in re.findall(rf'{key}\s*=\s*"([^"]+)"', block):
                if f'"{value}"' not in parser and f"'{value}'" not in parser:
                    errors.append(f"第 {i + 1} 段声明的 {key}=\"{value}\" 解析器不认")
                if key == "op":
                    declared_ops.add(value)
        if 'observeMode = "passive"' in block and "sampleComponentId" not in block:
            errors.append(
                f"第 {i + 1} 段是被动观测却没给 sampleComponentId："
                f"读不到样本量时零流量与全部成功长得一模一样，那条监控会永远绿着"
            )

    # 4. 端点自身必须仍在免鉴权名单里，否则探针连自描述都读不到
    if '!path.Equals("/gw/v1/healthz/deep"' not in endpoint:
        errors.append("深度自检端点不在免鉴权名单里，CDS 插上也读不到它的自描述")

    if errors:
        return fail(errors)
    print(
        "monitor discovery contract passed: "
        f"{len(blocks)} 段自描述，字段与枚举（op ∈ {sorted(declared_ops)}）两边一致"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
