#!/usr/bin/env python3
"""Check tutorial steps and evidence before rendering; never infer learner success."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COURSE = Path(__file__).with_name("course.json")
STATES = {"content", "pending", "local", "live"}


def audit(course, ledger, evidence_dir):
    errors, pending, checks = [], [], []
    ids = set()
    if sum(c["duration"] for c in course["chapters"]) != course["duration"]:
        errors.append("章节预算之和与完整课时长不符")
    inputs = {v["name"] for v in course["inputs"]}
    for chapter in course["chapters"]:
        for step in chapter["steps"]:
            sid = step.get("id", "")
            if not sid or sid in ids:
                errors.append(f"步骤标识缺失或重复：{sid}")
            ids.add(sid)
            for key in ("title", "where", "action", "expected", "recovery", "sources"):
                if not step.get(key):
                    errors.append(f"{sid} 缺少 {key}")
            if course.get("execution_model"):
                if step.get("command_kind") in {"shell", "comment"}:
                    errors.append(f"{sid} 把技术命令或PR操作交给学员；应改成给Agent的自然语言任务")
                if step.get("operator") not in {"agent", "human_browser"}:
                    errors.append(f"{sid} 没有说明由Agent执行还是由人确认页面")
            for name in step.get("needs", []):
                if name not in inputs:
                    errors.append(f"{sid} 输入没有取得方式：{name}")
            if step.get("hold", 0) < 8:
                errors.append(f"{sid} 暂停卡阅读不足8秒")
            for source in step.get("sources", []):
                if not source.startswith("https://") and not (ROOT / source).is_file():
                    errors.append(f"{sid} 来源不存在：{source}")
            state = step.get("proof")
            required = step.get("required_proof", "live")
            if required not in {"content", "local", "live"}:
                errors.append(f"{sid} 未定义合适的证据范围")
            if state not in STATES:
                errors.append(f"{sid} 未知证据状态：{state}")
            record = ledger.get("steps", {}).get(sid, {})
            if record:
                state = record.get("state", "pending")
                if state not in STATES:
                    errors.append(f"{sid} 执行记录状态不合法")
                if state in {"local", "live"}:
                    files = record.get("files", [])
                    if not files:
                        errors.append(f"{sid} 声称执行但没有证据文件")
                    for item in files:
                        path = (evidence_dir / item.get("path", "")).resolve()
                        if not path.is_relative_to(evidence_dir.resolve()) or not path.is_file():
                            errors.append(f"{sid} 证据路径无效")
                        elif hashlib.sha256(path.read_bytes()).hexdigest() != item.get("sha256"):
                            errors.append(f"{sid} 证据哈希与记录不符")
                    if not record.get("observed") or not record.get("scope"):
                        errors.append(f"{sid} 缺少实际观察或适用范围")
                    if state == "live" and not record.get("environment"):
                        errors.append(f"{sid} 线上证据缺少环境")
            sufficient = (required == "content" or state == "live"
                          or (required == "local" and state == "local"))
            if not sufficient:
                pending.append({"id": sid, "title": step["title"], "state": state,
                                "reason": record.get("scope", "尚未取得真实环境操作证据")})
            checks.append({"id": sid, "title": step["title"], "state": state, "required": required})
    unknown = set(ledger.get("steps", {})) - ids
    if unknown:
        errors.append("执行记录含未知步骤：" + ", ".join(sorted(unknown)))
    trial = ledger.get("learner_trial", {})
    trial_ok = trial.get("state") == "observed" and bool(trial.get("record"))
    if trial_ok:
        record = trial["record"]
        path = (evidence_dir / record.get("path", "")).resolve()
        if (not path.is_relative_to(evidence_dir.resolve()) or not path.is_file()
                or hashlib.sha256(path.read_bytes()).hexdigest() != record.get("sha256")):
            errors.append("真人试学记录无效")
            trial_ok = False
    return {"structural_errors": errors, "pending_steps": pending, "steps": checks,
            "learner_trial": "observed" if trial_ok else "pending",
            "draft_ready": not errors,
            "release_ready": not errors and not pending and trial_ok,
            "note": "本检查证明材料与证据记录完整性，不证明学员理解，也不将本机演示算作线上验收。"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--course", type=Path, default=COURSE)
    parser.add_argument("--ledger", type=Path)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--mode", choices=["draft", "release"], default="draft")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    course = json.loads(args.course.read_text())
    ledger = json.loads(args.ledger.read_text()) if args.ledger else {}
    result = audit(course, ledger, args.evidence_dir)
    result["course_sha256"] = hashlib.sha256(args.course.read_bytes()).hexdigest()
    result["mode"] = args.mode
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    ready = result[args.mode + "_ready"]
    print(f"{args.mode}：{'可进入粗样制作' if ready and args.mode == 'draft' else '通过' if ready else '未通过'}")
    print(f"结构错误 {len(result['structural_errors'])}；待补操作证据 {len(result['pending_steps'])}；真人试学 {result['learner_trial']}")
    for error in result["structural_errors"]:
        print("- " + error)
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
