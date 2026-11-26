#!/usr/bin/env python3
"""Read-only MAP/CDS capacity inventory. Never removes cache, images or data.

Run hourly on each host with explicit, non-overlapping source roots. stdout is
JSON; exit 0=healthy, 1=warning, 2=critical, 3=unknown. A scheduler must alert on
nonzero exits AND missing runs. This command does not install a scheduler.
"""
import argparse
import contextlib
from concurrent.futures import ThreadPoolExecutor
import fcntl
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import time

MAX_SAMPLES = 192  # eight days of hourly observations, bounded on every write
MAX_STATE_BYTES = 4 * 1024 * 1024
DAY = 86400
# The managed parent kills the whole collector at 55s. Leave time to analyze
# and atomically publish even when one or more native scans time out.
COLLECTION_SECONDS = 45
SOURCE_WORKERS = 4


def run(argv, env=None, timeout=COLLECTION_SECONDS):
    if timeout <= 0:
        raise subprocess.TimeoutExpired(argv, timeout)
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=True, env=env)
    if len(result.stdout) > 1024 * 1024:
        raise ValueError("collector output exceeds budget")
    return result.stdout


def roots(values):
    selected = {}
    for value in values:
        name, sep, raw = value.partition("=")
        if not sep or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", name) or name in selected:
            raise ValueError("source must be a unique NAME=PATH")
        p = str(Path(raw).resolve(strict=True))
        if not Path(p).is_dir():
            raise ValueError("source must be a directory")
        for previous in selected.values():
            if os.path.commonpath([p, previous]) in (p, previous):
                raise ValueError("source roots overlap; use disjoint roots to avoid double counting")
        selected[name] = p
    if not 1 <= len(selected) <= 32:
        raise ValueError("select between one and 32 sources")
    return selected


def collect(selected, docker=False, now=None):
    deadline = time.monotonic() + COLLECTION_SECONDS
    sample = {"at": time.time() if now is None else now, "host": socket.gethostname(),
              "sources": {}, "filesystems": {}, "errors": []}

    def source_reading(item):
        name, directory = item
        source = {"path": directory, "bytes": None, "device": None}
        filesystem, error = None, None
        try:
            device = str(os.stat(directory).st_dev)
            source["device"] = device
            v = os.statvfs(directory)
            if v.f_blocks <= 0 or v.f_frsize <= 0:
                raise ValueError("invalid filesystem reading")
            filesystem = {
                "totalBytes": v.f_blocks * v.f_frsize,
                "usedBytes": (v.f_blocks - v.f_bfree) * v.f_frsize,
                "availableBytes": v.f_bavail * v.f_frsize,
                "totalInodes": v.f_files, "availableInodes": v.f_favail,
            }
            # GNU du counts allocated bytes, skips nested filesystems, never
            # dereferences interior symlinks. No shell and no recursive Python walk.
            output = run(["du", "-sx", "--block-size=1", "--", directory],
                         timeout=deadline - time.monotonic())
            source["bytes"] = int(output.split()[0])
            if source["bytes"] < 0:
                raise ValueError("invalid du reading")
        except (OSError, ValueError, IndexError, subprocess.SubprocessError):
            source["bytes"] = None
            error = f"source:{name}:collection-failed"
        return name, source, filesystem, error

    # Four managed sources can make progress independently. Queued CLI roots
    # share the same deadline, rather than receiving a new budget per root.
    # Only this thread merges results; no shared sample mutation by workers.
    with ThreadPoolExecutor(max_workers=SOURCE_WORKERS) as pool:
        for name, source, filesystem, error in pool.map(source_reading, selected.items()):
            sample["sources"][name] = source
            if filesystem is not None:
                sample["filesystems"][source["device"]] = filesystem
            if error:
                sample["errors"].append(error)
    if docker:
        try:
            # Filesystem readings are local. A saved remote Docker context must
            # never silently mix another host's images with this host's disk.
            docker_env = os.environ.copy()
            for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
                docker_env.pop(key, None)
            rows = [json.loads(line) for line in run(
                ["docker", "--host=unix:///var/run/docker.sock", "system", "df", "--format", "{{json .}}"],
                env=docker_env,
                timeout=deadline - time.monotonic(),
            ).splitlines() if line.strip()]
            if not rows or any(not all(k in row for k in ("Type", "Size", "Reclaimable")) for row in rows):
                raise ValueError("incomplete docker inventory")
            sample["docker"] = rows
        except (OSError, ValueError, subprocess.SubprocessError):
            sample["errors"].append("docker:collection-failed")
    return sample


def growth(current, history, read):
    """Max positive net rate over the retained window and latest hour.

    Missing data, changed device/size/root and clock reversal never become zero
    growth. A shrink is visible as a negative delta; no exhaustion is predicted.
    """
    value = read(current)
    valid = [(s, read(s)) for s in history if 900 <= current["at"] - s["at"] <= 8 * DAY]
    valid = [(s, v) for s, v in valid if v is not None]
    if value is None or not valid:
        return {"deltaBytes": None, "bytesPerDay": None, "windowSeconds": None}
    first, old = valid[0]
    latest, recent = valid[-1]
    rates = [(value - old) * DAY / (current["at"] - first["at"]),
             (value - recent) * DAY / (current["at"] - latest["at"])]
    return {"deltaBytes": value - old, "bytesPerDay": max(rates),
            "windowSeconds": current["at"] - first["at"]}


def analyze(sample, history, warning=75, critical=90, reserve_bytes=6 * 1024**3, horizon_days=7):
    alerts = [{"code": error, "severity": "unknown"} for error in sample["errors"]]
    if history and sample["at"] <= history[-1]["at"]:
        alerts.append({"code": "clock-not-increasing", "severity": "unknown"})
    if history and sample["at"] - history[-1]["at"] > 7200:
        alerts.append({"code": "sampling-gap", "severity": "unknown"})
    sources = {}
    for name, source in sample["sources"].items():
        def read(s):
            entry = s["sources"].get(name)
            return entry["bytes"] if entry and entry["path"] == source["path"] and entry["device"] == source["device"] else None
        sources[name] = {**source, **growth(sample, history, read)}
    filesystems = {}
    for device, fs in sample["filesystems"].items():
        def read(s):
            old = s["filesystems"].get(device)
            return old["usedBytes"] if old and old["totalBytes"] == fs["totalBytes"] else None
        trend = growth(sample, history, read)
        # Available includes the filesystem's reserved-block policy; used is
        # physical consumption. Their difference is intentionally not "free".
        percent = 100 * (fs["totalBytes"] - fs["availableBytes"]) / fs["totalBytes"]
        inode_percent = 100 * (fs["totalInodes"] - fs["availableInodes"]) / fs["totalInodes"] if fs["totalInodes"] else None
        rate = trend["bytesPerDay"]
        days = fs["availableBytes"] / rate if rate is not None and rate > 0 else None
        reserve_days = max(0, fs["availableBytes"] - reserve_bytes) / rate if rate is not None and rate > 0 else None
        # The deployment guard rounds to the nearest whole percent before
        # freezing. Forecast that cutoff independently of the OS reserve.
        freeze_headroom = max(0, fs["availableBytes"] - fs["totalBytes"] * (1 - (critical - .5) / 100))
        freeze_days = freeze_headroom / rate if rate is not None and rate > 0 else None
        for code, severity, condition in (
            ("bytes-critical", "critical", percent >= critical),
            ("bytes-warning", "warning", warning <= percent < critical),
            ("reserve-low", "critical", fs["availableBytes"] <= reserve_bytes),
            ("inodes-critical", "critical", inode_percent is not None and inode_percent >= critical),
            ("inodes-warning", "warning", inode_percent is not None and warning <= inode_percent < critical),
            ("reserve-exhaustion-forecast", "warning", reserve_days is not None and reserve_days <= horizon_days),
            ("deployment-freeze-forecast", "warning", freeze_days is not None and freeze_days <= horizon_days),
        ):
            if condition:
                alerts.append({"code": code, "severity": severity, "device": device})
        if trend["windowSeconds"] is None:
            alerts.append({"code": "growth-baseline-missing", "severity": "unknown", "device": device})
        filesystems[device] = {**fs, **trend, "usedPercent": percent,
                               "inodeUsedPercent": inode_percent, "daysToFull": days,
                               "daysToReserve": reserve_days, "daysToDeploymentFreeze": freeze_days}
        for name, source in sources.items():
            source_rate = source["bytesPerDay"]
            monitored = name == "containerd-image-content" or name.startswith("cds-backups-")
            if (monitored and source["device"] == device and source_rate is not None
                    and source_rate > 0 and freeze_headroom / source_rate <= horizon_days):
                alerts.append({"code": f"source-growth:{name}", "severity": "warning", "device": device})
    # Do not sum Docker's shared image layers, volumes, and du roots. Sources
    # explain where bytes live; filesystem available space governs risk.
    severity = "critical" if any(a["severity"] == "critical" for a in alerts) else (
        "unknown" if any(a["severity"] == "unknown" for a in alerts) else (
            "warning" if alerts else "ok"))
    return {"version": 1, "at": sample["at"], "host": sample["host"], "status": severity,
            "sources": sources, "filesystems": filesystems, "docker": sample.get("docker"),
            "alerts": alerts, "accounting": "allocated source bytes; cross-root hardlinks and Docker rows are non-additive; no deletion authority",
            "policy": {"warningPercent": warning, "criticalPercent": critical,
                       "reserveBytes": reserve_bytes, "horizonDays": horizon_days, "maxSamples": MAX_SAMPLES}}


def load_history(file, selected, new_source_baseline=False, new_host_baseline=False):
    if not file.exists():
        return []
    if file.is_symlink() or file.stat().st_size > MAX_STATE_BYTES:
        raise ValueError("unsafe or oversized state")
    data = json.loads(file.read_text())
    changed = data["roots"] != selected
    old_host = data["host"]
    if not isinstance(old_host, str) or not old_host or len(old_host) > 255 or any(ord(c) < 32 for c in old_host):
        raise ValueError("invalid host history")
    host_changed = old_host != socket.gethostname()
    if data["version"] != 1 or (host_changed and not new_host_baseline) or (changed and not new_source_baseline):
        raise ValueError("state host or source roots changed; use a separate state directory")
    if changed:
        previous_roots = data["roots"]
        if not isinstance(previous_roots, dict) or not 1 <= len(previous_roots) <= 32 or any(
                not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", name)
                or not isinstance(root, str) or not os.path.isabs(root) or "\x00" in root
                for name, root in previous_roots.items()):
            raise ValueError("invalid source history")
    samples = data["samples"]
    if not isinstance(samples, list) or len(samples) > MAX_SAMPLES:
        raise ValueError("invalid sample history")
    last = -1
    for sample in samples:
        stamp = sample["at"]
        if not isinstance(stamp, (int, float)) or not math.isfinite(stamp) or stamp <= last:
            raise ValueError("invalid sample ordering")
        last = stamp
        for entry in sample["sources"].values():
            if entry["bytes"] is not None and (not isinstance(entry["bytes"], int) or entry["bytes"] < 0):
                raise ValueError("invalid source measurement")
        for entry in sample["filesystems"].values():
            if not all(isinstance(entry[key], int) and entry[key] >= 0 for key in (
                "totalBytes", "usedBytes", "availableBytes", "totalInodes", "availableInodes")) or entry["totalBytes"] <= 0:
                raise ValueError("invalid filesystem measurement")
    # The managed producer has a finite known root set. A lazily-created cache
    # starts a new baseline in the same bounded slot, never a mixed history.
    return [] if changed or host_changed else samples


def save_history(file, selected, history, sample):
    # One point per hour, not one file/run. Frequent checks cannot evict the
    # eight-day baseline. Never overwrite a baseline after clock reversal.
    points = history[:]
    if not points or sample["at"] - points[-1]["at"] >= 3600:
        points.append(sample)
    data = {"version": 1, "host": socket.gethostname(), "roots": selected, "samples": points[-MAX_SAMPLES:]}
    save_json(file, data)


def save_json(file, data):
    encoded = json.dumps(data, allow_nan=False)
    if len(encoded.encode()) > MAX_STATE_BYTES:
        raise ValueError("state exceeds budget")
    # A fixed slot under the caller's lock bounds SIGKILL leftovers too. Unique
    # mkstemp names would leak one file on every interrupted collection.
    temp = file.parent / "history.pending"
    fd = os.open(temp, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    pending_owned = False
    try:
        with os.fdopen(fd, "w") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError("unsafe pending state")
            pending_owned = True
            os.ftruncate(stream.fileno(), 0)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, file)
        dirfd = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    finally:
        if pending_owned:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temp)


def publish_failed_report(state, requested_roots, report):
    """Best effort only in an existing private state, never touch its history.

    Input/root validation can fail before normal collection acquires the lock.
    Publish unknown there too, instead of leaving a fresh-looking old report.
    Unsafe state, overlap or another collector's lock must remain untouched.
    """
    state = state.resolve()
    for selected in requested_roots:
        _, sep, raw = selected.partition("=")
        if sep:
            root = str(Path(raw).resolve())
            if os.path.commonpath([str(state), root]) in (str(state), root):
                return
    info = state.stat()
    if info.st_mode & 0o077 or info.st_uid != os.getuid():
        return
    lockfd = os.open(state / "lock", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(lockfd, "w") as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
            return
        fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        save_json(state / "latest.json", report)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", action="append", required=True, help="NAME=PATH; repeat for disjoint roots, max 32")
    p.add_argument("--state-dir", required=True, type=Path, help="private writable directory outside measured roots")
    p.add_argument("--docker", action="store_true", help="query local Unix-socket Docker only; ignore remote contexts; never prune")
    p.add_argument("--warning", type=float, default=75)
    p.add_argument("--critical", type=float, default=90)
    p.add_argument("--reserve-gib", type=float, default=6)
    p.add_argument("--horizon-days", type=float, default=7)
    p.add_argument("--new-source-baseline", action="store_true", help="start a cold baseline on a known source-set change; host identity must still match")
    p.add_argument("--new-host-baseline", action="store_true", help="start a cold managed baseline on hostname change; validate history and never mix host trends")
    args = p.parse_args()
    try:
        if not (0 < args.warning < args.critical <= 100 and math.isfinite(args.reserve_gib)
                and args.reserve_gib >= 0 and math.isfinite(args.horizon_days) and args.horizon_days > 0):
            raise ValueError("invalid capacity thresholds")
        selected = roots(args.source)
        state = args.state_dir.resolve()
        if any(os.path.commonpath([str(state), root]) in (str(state), root) for root in selected.values()):
            raise ValueError("state and source directories must not overlap")
        state.mkdir(mode=0o700, parents=True, exist_ok=True)
        if state.stat().st_mode & 0o077 or state.stat().st_uid != os.getuid():
            raise ValueError("state directory must be owned by current user and mode 0700")
        lockfd = os.open(state / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(lockfd, "w"):
            fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                history = load_history(state / "history.json", selected, args.new_source_baseline, args.new_host_baseline)
                sample = collect(selected, args.docker)
                report = analyze(sample, history, args.warning, args.critical,
                                 int(args.reserve_gib * 1024**3), args.horizon_days)
                save_history(state / "history.json", selected, history, sample)
            except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError, subprocess.SubprocessError):
                report = {"version": 1, "at": time.time(), "host": socket.gethostname(), "status": "unknown", "alerts": [
                    {"code": "collector-or-state-failed", "severity": "unknown"}]}
            save_json(state / "latest.json", report)
        print(json.dumps(report, ensure_ascii=False, allow_nan=False))
        return {"ok": 0, "warning": 1, "critical": 2, "unknown": 3}[report["status"]]
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError, subprocess.SubprocessError):
        report = {"version": 1, "at": time.time(), "host": socket.gethostname(), "status": "unknown", "alerts": [
            {"code": "collector-or-state-failed", "severity": "unknown"}]}
        with contextlib.suppress(OSError, ValueError):
            publish_failed_report(args.state_dir, args.source, report)
        print(json.dumps(report))
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
