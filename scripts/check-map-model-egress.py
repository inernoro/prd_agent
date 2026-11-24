#!/usr/bin/env python3
"""平台模型出口构建守卫：MAP 与 serving 的新底层运输必须先审计，不能默默绕过统一网关。

既有共享 serving 实现与非付费下载/存储留在有限台账；台账匹配调用指纹而非整目录豁免。
本守卫不替代网络命名空间隔离，也不把修改保护台账的恶意代码当成安全边界。
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "scripts/fixtures/map-model-egress-audit.json"
SOURCE_ROOTS = ("prd-api/src", "llmgw/serving")
NETWORK_TYPES = r"HttpClient|HttpClientHandler|SocketsHttpHandler|HttpMessageInvoker|WebClient|ClientWebSocket|Socket|TcpClient|UdpClient|Process|ProcessStartInfo|OpenAIClient|ClaudeClient|GatewayLLMClient|DoubaoStreamAsrService|IDoubaoStreamAsrExecutor|LiveAsrSessionOrchestrator|LiveAsrBatchFallbackService|HttpPoolDispatcher|LlmGateway"
VENDOR_NAMESPACE = re.compile(r"\b(?:using|global\s+using)\s+(?:\w+\s*=\s*)?(?:global::)?(?:OpenAI|Azure\.AI\.OpenAI|Anthropic|Google\.GenAI|Microsoft\.SemanticKernel|LangChain)(?:[.;\s])")
VENDOR_PACKAGE = re.compile(r'PackageReference\s+Include="(?:OpenAI|Azure\.AI\.OpenAI|Anthropic[^"\s]*|Google\.GenAI|Microsoft\.SemanticKernel[^"\s]*|LangChain[^"\s]*)"', re.I)
LEGACY_TRANSPORT = re.compile(r"\b(?:OpenAIClient|ClaudeClient|GatewayLLMClient|DoubaoStreamAsrService|IDoubaoStreamAsrExecutor|LiveAsrSessionOrchestrator|LiveAsrBatchFallbackService|HttpPoolDispatcher)\b")
SHARED_SERVING_TRANSPORT_FILES = {
    "prd-api/src/PrdAgent.Infrastructure/LLM/OpenAIClient.cs",
    "prd-api/src/PrdAgent.Infrastructure/LLM/ClaudeClient.cs",
    "prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayLLMClient.cs",
    "prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs",
    "prd-api/src/PrdAgent.Infrastructure/LlmGateway/Asr/DoubaoStreamAsrService.cs",
    "prd-api/src/PrdAgent.Infrastructure/LlmGateway/Asr/LiveAsrSessionOrchestrator.cs",
    "prd-api/src/PrdAgent.Infrastructure/LlmGateway/Asr/LiveAsrBatchFallbackService.cs",
    "prd-api/src/PrdAgent.Infrastructure/ModelPool/HttpPoolDispatcher.cs",
    # 现有宿主装配与已治理实时端点；其依赖解析/注册也按调用指纹锁定，不能借此新增旁路。
    "llmgw/serving/Program.cs",
    "llmgw/serving/LiveAsrGatewayEndpoint.cs",
    # 仅包装统一网关的任务金额闸；SDK客户端必须回到本包装器，不创建底层运输。
    "llmgw/serving/TaskBudgetGateway.cs",
}
CALL = re.compile(r"\.\s*(CreateClient|SendAsync|PostAsync|PostAsJsonAsync|PutAsync|PutAsJsonAsync|PatchAsync|DeleteAsync|GetAsync|GetStringAsync|GetByteArrayAsync|GetStreamAsync|ConnectAsync)\s*\(")
DEPENDENCY_CALL = re.compile(r"\.\s*(AddSingleton|AddScoped|AddTransient|GetRequiredService|GetService|GetServices)\s*<([^;\n()]*?)>\s*\(")
GATEWAY_RECEIVER = re.compile(r"(?:^|[^\w])(?:_?gateway|_?logicalGateway|_?modelGateway)\s*$", re.I)


def strip_non_code(source: str, *, strip_strings: bool = True) -> str:
    # 保留字符位置；字符串/注释里的示例不能触发守卫。支持 C# 普通、verbatim、raw strings。
    result = list(source)
    i = 0
    while i < len(source):
        end = None
        comment = False
        if source.startswith("//", i):
            comment = True
            end = source.find("\n", i)
            if end < 0: end = len(source)
        elif source.startswith("/*", i):
            comment = True
            close = source.find("*/", i + 2)
            end = len(source) if close < 0 else close + 2
        elif source[i] in '\"\'':
            quote = source[i]
            run = 1
            while i + run < len(source) and source[i + run] == quote: run += 1
            if quote == '"' and run >= 3:
                close = source.find('"' * run, i + run)
                end = len(source) if close < 0 else close + run
            else:
                verbatim = i > 0 and source[i - 1] == '@'
                j = i + 1
                while j < len(source):
                    if not verbatim and source[j] == "\\": j += 2; continue
                    if source[j] == quote:
                        if verbatim and j + 1 < len(source) and source[j + 1] == quote: j += 2; continue
                        j += 1; break
                    j += 1
                end = j
        if end is not None:
            if comment or strip_strings:
                for k in range(i, end):
                    if result[k] != "\n": result[k] = " "
            i = end
        else:
            i += 1
    return "".join(result)


def invocation_fingerprints(source: str) -> Counter[str]:
    code = strip_non_code(source)
    literal_code = strip_non_code(source, strip_strings=False)
    aliases = {}
    for match in re.finditer(r"\busing\s+(\w+)\s*=\s*(?:global::)?([\w.]+)\s*;", code):
        actual = match.group(2).split('.')[-1]
        if re.fullmatch(NETWORK_TYPES, actual): aliases[match.group(1)] = actual
    names = NETWORK_TYPES + ("|" + "|".join(map(re.escape, aliases)) if aliases else "")
    matches = []
    network_vars = set(re.findall(r"\b(?:HttpClient|HttpMessageInvoker|HttpMessageHandler|ClientWebSocket|WebSocket|WebClient|TcpClient|UdpClient)\s+(\w+)", code))
    network_vars.update(re.findall(r"\bvar\s+(\w+)\s*=\s*[^;\n]*\.CreateClient\s*\(", code))
    network_vars.update(re.findall(r"\bvar\s+(\w+)\s*=\s*new\s+(?:global::)?(?:[\w]+\.)*(?:HttpClient|ClientWebSocket|WebClient|TcpClient|UdpClient)\b", code))
    is_http_handler = bool(re.search(r":\s*(?:DelegatingHandler|HttpMessageHandler)\b", code))
    for match in re.finditer(r"\bnew\s+(?:global::)?(?:[\w]+\.)*(" + names + r")\b(?![\w.])", code):
        matches.append(("new:" + aliases.get(match.group(1), match.group(1)), match.start(), match.end()))
    for match in re.finditer(r"\b(" + names + r")\s+\w+\s*=\s*new\s*\(", code):
        matches.append(("target-new:" + aliases.get(match.group(1), match.group(1)), match.start(), match.end()))
    process_names = "Process" + "".join("|" + re.escape(alias) for alias, actual in aliases.items() if actual == "Process")
    # 标准静态启动入口无需 new Process；明确类型别名同样不能跳过子进程审计。
    process_start = r"(?<![\w.])(?:(?:global::)?System\.Diagnostics\.)?(?:" + process_names + r")\s*\.\s*Start\s*\("
    for match in re.finditer(process_start, code):
        matches.append(("static:Process.Start", match.start(), match.end()))
    for match in DEPENDENCY_CALL.finditer(code):
        generic = match.group(2).strip()
        if generic.startswith("ILogger<"): continue
        dependencies = re.findall(r"(?:\w+\.)*(\w+)", generic)
        if any(re.fullmatch(NETWORK_TYPES, aliases.get(dependency, dependency)) for dependency in dependencies):
            matches.append(("dependency:" + match.group(1), match.start(), match.end()))
    for match in CALL.finditer(code):
        preceding = code[max(0, match.start() - 80):match.start()]
        if GATEWAY_RECEIVER.search(preceding): continue
        receiver = re.search(r"(\w+)\s*$", preceding)
        if match.group(1) != "CreateClient":
            if not receiver or (receiver.group(1) not in network_vars and not (is_http_handler and receiver.group(1) == "base")):
                continue
        matches.append(("call:" + match.group(1), match.start(), match.end()))
    fingerprints = Counter()
    for kind, start, end in matches:
        # 绑定当前调用表达式与实参；即使在现有例外文件新增调用也必须重新审计。
        opening = code.find('(', start, end + 1)
        stop = end
        if opening >= 0:
            depth = 1
            stop = opening + 1
            while stop < len(code) and depth:
                if code[stop] == '(': depth += 1
                elif code[stop] == ')': depth -= 1
                stop += 1
        else:
            stop = min(len(code), end + 80)
        # 前置 receiver 也入指纹，禁止删除旧调用后以另一客户端补同个数量蒙混过关。
        receiver = re.search(r"[\w.?!]+\s*$", code[max(0, start-100):start])
        expression = (receiver.group(0) if receiver else "") + literal_code[start:stop]
        normalized = re.sub(r"\s+", "", expression)
        digest = hashlib.sha256(normalized.encode()).hexdigest()[:24]
        fingerprints[kind + ":" + digest] += 1
    return fingerprints


def source_paths(root: Path, pattern: str):
    for relative in SOURCE_ROOTS:
        for path in sorted((root / relative).rglob(pattern)):
            if not (set(path.parts) & {"obj", "bin"}): yield path


def source_inventory(root: Path) -> dict[str, dict]:
    inventory = {}
    for path in source_paths(root, "*.cs"):
        calls = invocation_fingerprints(path.read_text())
        if calls:
            inventory[path.relative_to(root).as_posix()] = {"calls": dict(sorted(calls.items()))}
    return inventory


def check(root: Path, ledger: dict) -> list[str]:
    failures = []
    allowed = ledger["files"]
    inventory = source_inventory(root)
    for relative, item in inventory.items():
        granted = allowed.get(relative, {})
        if not granted.get("purpose"):
            failures.append(f"{relative}: 新运输文件没有出口审计用途")
            continue
        extra = Counter(item["calls"]) - Counter(granted.get("calls", {}))
        if extra: failures.append(f"{relative}: 新增或变更底层出站调用 {dict(extra)}，须走统一网关或完成有限非付费用途审计")
    for relative, granted in allowed.items():
        stale = Counter(granted.get("calls", {})) - Counter(inventory.get(relative, {}).get("calls", {}))
        if stale:
            failures.append(f"{relative}: 已删除的运输审计许可必须一起移除，禁止留可复活的旁路 {dict(stale)}")
    for path in source_paths(root, "*.cs"):
        code = strip_non_code(path.read_text())
        # Logger 泛型只是日志分类，不会创建供应商客户端；除此以外 MAP 业务不能解析 legacy 发送器。
        without_loggers = re.sub(r"ILogger\s*<\s*[\w.]+\s*>", "ILogger", code)
        # 已有音频纯计算/结果解析工具没有发送能力，逐方法列明，不能放开整个 ASR 类型。
        without_loggers = re.sub(r"LiveAsrBatchFallbackService\s*\.\s*(?:WindowBytes|HasLikelySpeech|ExtractText|LooksLikeAssistantReply)\b", "AsrPureUtility", without_loggers)
        if path.relative_to(root).as_posix() not in SHARED_SERVING_TRANSPORT_FILES and LEGACY_TRANSPORT.search(without_loggers):
            failures.append(f"{path.relative_to(root)}: MAP 业务禁止直接引用底层供应商运输或 ASR executor，请调用 ILlmGateway")
        if VENDOR_NAMESPACE.search(code):
            failures.append(f"{path.relative_to(root)}: MAP 禁止新供应商 SDK，请调用 ILlmGateway")
    for path in source_paths(root, "*.csproj"):
        if VENDOR_PACKAGE.search(path.read_text()):
            failures.append(f"{path.relative_to(root)}: MAP 禁止供应商 SDK 包依赖")
        names = set(re.findall(r'PackageReference\s+Include="([^"\s]+)"', path.read_text()))
        approved = set(ledger.get("packages", {}).get(path.relative_to(root).as_posix(), []))
        if names - approved:
            failures.append(f"{path.relative_to(root)}: 新依赖未进入平台出口审计 {sorted(names - approved)}")
    program = (root / "prd-api/src/PrdAgent.Api/Program.cs").read_text()
    if not re.search(r"\bAddMapModelEgressGuard\s*\(\s*\)", strip_non_code(program)):
        failures.append("Program.cs: 缺少全 HttpClient 工厂出口守卫注册")
    if not re.search(r"GetRequiredService\s*<\s*(?:PrdAgent\.Core\.Interfaces\.)?ITaskExecutionAuthorizer\s*>\s*\(", strip_non_code(program)):
        failures.append("Program.cs: 网关运输必须通过 DI 必需解析任务 authorizer")
    ci_path = root / ".github/workflows/ci.yml"
    ci = ci_path.read_text() if ci_path.exists() else ""
    ci_code = "\n".join(line for line in ci.splitlines() if not line.lstrip().startswith("#"))
    if not re.search(r"\bpython3\s+scripts/check-map-model-egress\.py\b", ci_code):
        failures.append("ci.yml: 必须执行 MAP 模型出口源码守卫")
    explicit_tests = re.search(r"\bpython3\s+(?:-m\s+unittest\s+scripts\.tests\.test_map_model_egress|scripts/tests/test_map_model_egress\.py)\b", ci_code)
    script_suite = "scripts/tests/test_*.py" in ci_code and re.search(r"\bpython3\s+[\"']?\$t[\"']?", ci_code)
    if not (explicit_tests or script_suite):
        failures.append("ci.yml: 必须执行 MAP 模型出口守卫的回归测试")
    for relative in SOURCE_ROOTS:
        if f"{relative}/**" not in ci_code:
            failures.append(f"ci.yml: 模型出口守卫的源码触发范围缺少 {relative}/**")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    failures = check(args.root, json.loads(LEDGER.read_text()))
    if failures:
        for failure in failures: print(failure, file=sys.stderr)
        return 1
    print("平台模型出口守卫通过：MAP 与 serving 新运输无未审计调用，平台注册完整。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
