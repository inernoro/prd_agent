#!/usr/bin/env python3
"""Capture and restore a local Compose release without pulling images or replacing data volumes."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def run_command(executable, *args):
    result = subprocess.run([executable, *args], capture_output=True, text=True)
    if result.returncode:
        # Docker can put expanded Compose values in diagnostics.
        raise RuntimeError(f"Docker {args[0]} failed (exit {result.returncode})")
    return result.stdout


def docker(*args):
    return run_command("docker", *args)


def compose(executable, *args):
    if executable == "docker-compose":
        return run_command(executable, *args)
    return docker("compose", *args)


def inventory(project):
    ids = docker("ps", "-aq", "--filter", f"label=com.docker.compose.project={project}").split()
    containers = json.loads(docker("inspect", *ids)) if ids else []
    services = {}
    for row in containers:
        labels = row["Config"]["Labels"]
        if labels.get("com.docker.compose.oneoff", "").lower() == "true":
            continue
        name = labels["com.docker.compose.service"]
        previous = services.get(name)
        if previous and previous["State"]["Running"] and row["State"]["Running"]:
            raise RuntimeError(f"服务 {name} 有多个运行实例，无法确认回滚版本")
        # Docker lists the newest containers first. Keep the first stopped
        # instance as a fallback for inactive services, but prefer a live one.
        if not previous or row["State"]["Running"]:
            services[name] = row
    return services


def compose_source(row):
    labels = row["Config"]["Labels"]
    directory = labels.get("org.map.release.source-directory") or labels["com.docker.compose.project.working_dir"]
    files = (labels.get("org.map.release.source-files") or labels["com.docker.compose.project.config_files"]).split(",")
    return directory, tuple(files)


def escape_interpolation(value):
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, list):
        return [escape_interpolation(item) for item in value]
    if isinstance(value, dict):
        return {key: escape_interpolation(item) for key, item in value.items()}
    return value


def running_configuration(row):
    config, host = row["Config"], row.get("HostConfig") or {}
    mounts = []
    for mount in row.get("Mounts", []):
        kind = mount["Type"]
        if kind == "tmpfs":
            continue
        if kind not in ("bind", "volume"):
            raise RuntimeError(f"回滚点包含不支持的挂载类型 {kind}")
        spec = {"type": kind, "target": mount["Destination"], "read_only": not mount["RW"]}
        if kind == "bind":
            spec["source"] = mount["Source"]
            spec["bind"] = {"create_host_path": False}
            if mount.get("Propagation"):
                spec["bind"]["propagation"] = mount["Propagation"]
        else:
            spec["source"] = mount["Name"]
            spec["volume"] = {"nocopy": True}
        mounts.append(spec)

    ports = []
    for target, bindings in sorted((host.get("PortBindings") or {}).items()):
        number, protocol = target.split("/", 1)
        for binding in bindings or []:
            ip, published = binding.get("HostIp", ""), binding.get("HostPort", "")
            if not published or published == "0":
                effective = (row.get("NetworkSettings", {}).get("Ports") or {}).get(target) or []
                published = next((item["HostPort"] for item in effective if not ip or item["HostIp"] == ip), "")
            port = {"target": int(number), "protocol": protocol}
            if ip:
                port["host_ip"] = ip
            if published:
                port["published"] = published
            ports.append(port)

    restart = host.get("RestartPolicy") or {}
    restart_name = restart.get("Name") or "no"
    if restart_name == "on-failure" and restart.get("MaximumRetryCount"):
        restart_name += f":{restart['MaximumRetryCount']}"
    logging = host.get("LogConfig") or {}
    observed_health = config.get("Healthcheck") or {}
    health_test = observed_health.get("Test") or ["NONE"]
    health = {"disable": True} if health_test == ["NONE"] else {"test": health_test}
    if health_test != ["NONE"]:
        for docker_key, compose_key in (("Interval", "interval"), ("Timeout", "timeout"),
                                        ("StartPeriod", "start_period"), ("StartInterval", "start_interval")):
            if observed_health.get(docker_key):
                health[compose_key] = f"{observed_health[docker_key]}ns"
        if observed_health.get("Retries"):
            health["retries"] = observed_health["Retries"]
    return {
        "environment": dict(value.split("=", 1) for value in config.get("Env") or []),
        "command": config.get("Cmd") or [],
        "entrypoint": config.get("Entrypoint") or [],
        "user": config.get("User") or "",
        "working_dir": config.get("WorkingDir") or "",
        "read_only": bool(host.get("ReadonlyRootfs")),
        "volumes": sorted(mounts, key=lambda mount: mount["target"]),
        "ports": sorted(ports, key=lambda port: json.dumps(port, sort_keys=True)),
        "tmpfs": [f"{target}:{options}" if options else target
                  for target, options in sorted((host.get("Tmpfs") or {}).items())],
        "restart": restart_name,
        "logging": {"driver": logging["Type"], "options": logging.get("Config") or {}} if logging.get("Type") else {},
        "healthcheck": health,
    }


def configuration_proof(configuration):
    return {
        key: hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        for key, value in configuration.items()
    }


def retired_service(row, networks):
    service = {}
    if row.get("Name"):
        service["container_name"] = row["Name"].lstrip("/")
    interfaces = (row.get("NetworkSettings") or {}).get("Networks") or {}
    mode = (row.get("HostConfig") or {}).get("NetworkMode") or ""
    if mode in ("host", "none", "bridge") or mode.startswith("container:"):
        service["network_mode"] = mode
    elif interfaces:
        service["networks"] = {}
        for name, endpoint in sorted(interfaces.items()):
            alias = next((key for key, network in networks.items() if network.get("name") == name), None)
            if alias is None:
                alias = f"observed-{hashlib.sha256(name.encode()).hexdigest()[:12]}"
                networks[alias] = {"name": name, "external": True}
            attachment = {}
            if endpoint.get("Aliases"):
                attachment["aliases"] = endpoint["Aliases"]
            ipam = endpoint.get("IPAMConfig") or {}
            for docker_key, compose_key in (("IPv4Address", "ipv4_address"), ("IPv6Address", "ipv6_address")):
                if ipam.get(docker_key):
                    attachment[compose_key] = ipam[docker_key]
            service["networks"][alias] = attachment
    return service


def capture(project, gateway, directory, executable="docker compose", env_file=None):
    containers = inventory(project)
    groups = {}
    for name, row in containers.items():
        groups.setdefault(compose_source(row), []).append(name)
    snapshot = {}
    for index, ((working_dir, files), names) in enumerate(groups.items()):
        options = ["-p", project, "--project-directory", working_dir]
        if env_file and env_file.is_file():
            options.extend(["--env-file", str(env_file.resolve())])
        for file in files:
            options.extend(["-f", file])
        model = json.loads(compose(executable, *options, "config", "--format", "json"))
        declared_services = model.get("services", {})
        networks = model.setdefault("networks", {})
        model["services"] = {}
        model["volumes"] = {}
        filename = f"compose-{index}.json"
        for name in names:
            row = containers[name]
            if name in declared_services:
                service = declared_services[name]
            else:
                # A previous service can still run after its definition has been removed.
                service = retired_service(row, networks)
            model["services"][name] = service
            docker("image", "inspect", row["Image"], "--format", "{{.Id}}")
            service["image"] = row["Image"]
            service.pop("build", None)
            service.pop("depends_on", None)
            configuration = running_configuration(row)
            service.update(configuration)
            for mount in configuration["volumes"]:
                if mount["type"] == "volume":
                    model["volumes"][mount["source"]] = {"external": True, "name": mount["source"]}
            labels = service.setdefault("labels", {})
            labels["org.map.release.source-directory"] = working_dir
            labels["org.map.release.source-files"] = ",".join(files)
            snapshot[name] = {"image": row["Image"], "running": row["State"]["Running"],
                              "id": row["Id"], "compose": filename,
                              "configuration": configuration_proof(configuration)}
        (directory / filename).write_text(json.dumps(escape_interpolation(model)))
    (directory / "containers.json").write_text(json.dumps(snapshot))


def restore(project, gateway, directory, executable="docker compose"):
    snapshot = json.loads((directory / "containers.json").read_text())
    current = inventory(project)
    for name in sorted(current.keys() - snapshot.keys()):
        # Removing containers keeps named and anonymous data volumes.
        docker("rm", "-f", current[name]["Id"])
    changed = {}
    for name in sorted(snapshot, key=lambda item: item == gateway):
        expected = snapshot[name]
        row = current.get(name)
        if (not row or row["Id"] != expected["id"] or row["State"]["Running"] != expected["running"]
                or configuration_proof(running_configuration(row)) != expected["configuration"]):
            changed.setdefault((name == gateway, expected["compose"]), []).append(name)
    for (_, filename), names in changed.items():
        prefix = ["-p", project, "-f", str(directory / filename)]
        compose(executable, *prefix, "up", "-d", "--force-recreate", "--no-deps", "--pull", "never", *names)
        stopped = [name for name in names if not snapshot[name]["running"]]
        if stopped:
            compose(executable, *prefix, "stop", *stopped)
    actual = inventory(project)
    for name, expected in snapshot.items():
        row = actual.get(name)
        if not row or row["Image"] != expected["image"] or row["State"]["Running"] != expected["running"]:
            raise RuntimeError(f"回滚核对未通过，服务 {name} 的镜像或运行状态与发布前不符")
        proof = configuration_proof(running_configuration(row))
        drift = [key for key, value in expected["configuration"].items() if proof.get(key) != value]
        if drift:
            raise RuntimeError(f"回滚核对未通过，服务 {name} 的配置与发布前不符：{', '.join(drift)}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("capture", "restore"))
    parser.add_argument("project")
    parser.add_argument("gateway")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--compose", choices=("docker compose", "docker-compose"), default="docker compose")
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.action == "capture":
            capture(args.project, args.gateway, args.directory, args.compose, args.env_file)
        else:
            restore(args.project, args.gateway, args.directory, args.compose)
    except (KeyError, OSError, RuntimeError, ValueError) as error:
        # KeyError/ValueError can include raw Compose input. Report the type only.
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        parser.exit(1, f"ERROR: 生产运行版本{('备份' if args.action == 'capture' else '恢复')}失败：{detail}\n")


if __name__ == "__main__":
    main()
