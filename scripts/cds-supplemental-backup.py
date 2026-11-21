#!/usr/bin/env python3
"""Back up small CDS object stores and empty Kafka topic definitions to the configured R2 repository."""

import argparse
import base64
import datetime as dt
import gzip
import hashlib
import hmac
import io
import ipaddress
from itertools import islice
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

MAX_BYTES = 64 * 1024 * 1024
MAX_OBJECTS = 1024
TIMEOUT = 30
OPTIONAL_BUCKET_SETTINGS = {
    "policy": "NoSuchBucketPolicy",
    "lifecycle": "NoSuchLifecycleConfiguration",
    "cors": "NoSuchCORSConfiguration",
    "encryption": "ServerSideEncryptionConfigurationNotFoundError",
    "tagging": "NoSuchTagSet",
    "object-lock": "ObjectLockConfigurationNotFoundError",
}


class BackupError(RuntimeError):
    def __init__(self, message, code="backup-failed"):
        super().__init__(message)
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


HTTP = urllib.request.build_opener(NoRedirect())


def utc():
    return dt.datetime.now(dt.timezone.utc)


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def run(*args, timeout=TIMEOUT):
    process = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if process.returncode:
        raise BackupError(f"{Path(args[0]).name} command failed ({process.returncode})")
    return process.stdout


class S3:
    def __init__(self, origin, access, secret, region, service, audit):
        self.origin = urllib.parse.urlsplit(origin)
        if (self.origin.scheme not in ("http", "https") or self.origin.path not in ("", "/")
                or not self.origin.hostname or self.origin.username or self.origin.password
                or self.origin.query or self.origin.fragment or not access or not secret):
            raise BackupError("Invalid configured object storage endpoint")
        self.access = access
        self.secret = secret
        self.region = region
        self.service = service
        self.audit = audit

    def request(self, method, path, operation, query=None, data=None, headers=None, limit=MAX_BYTES):
        query = urllib.parse.urlencode(sorted((query or {}).items()), quote_via=urllib.parse.quote, safe="-_.~")
        path = urllib.parse.quote(path, safe="/-_.~")
        now = utc()
        stamp = now.strftime("%Y%m%dT%H%M%SZ")
        day = stamp[:8]
        digest = sha(data or b"")
        signed_headers = {"host": self.origin.netloc, "x-amz-date": stamp,
                          "x-amz-content-sha256": digest, **(headers or {})}
        names = ";".join(sorted(signed_headers))
        canonical = "\n".join((method, path, query,
                               "".join(f"{key}:{signed_headers[key]}\n" for key in sorted(signed_headers)),
                               names, digest))
        scope = f"{day}/{self.region}/s3/aws4_request"
        signing = ("AWS4" + self.secret).encode()
        for term in (day, self.region, "s3", "aws4_request"):
            signing = hmac.digest(signing, term.encode(), "sha256")
        signature = hmac.new(signing, ("AWS4-HMAC-SHA256\n" + stamp + "\n" + scope + "\n"
                                      + sha(canonical.encode())).encode(), hashlib.sha256).hexdigest()
        authorization = (f"AWS4-HMAC-SHA256 Credential={self.access}/{scope}, "
                         f"SignedHeaders={names}, Signature={signature}")
        url = self.origin._replace(path=path, query=query).geturl()
        request = urllib.request.Request(url, method=method, data=data,
                                         headers={**signed_headers, "Authorization": authorization,
                                                  "Accept-Encoding": "identity"})
        result = {"service": self.service, "method": method, "operation": operation,
                  "requestTargetSha256": sha((path + "?" + query).encode()),
                  "startedAt": now.isoformat(), "timeoutSeconds": TIMEOUT}
        start = time.monotonic()
        try:
            try:
                response = HTTP.open(request, timeout=TIMEOUT)
            except urllib.error.HTTPError as failure:
                response = failure
            with response:
                output = response.read(limit + 1)
                output_headers = {key.lower(): value for key, value in response.headers.items()}
                status = response.code
                result.update(status=status, requestId=output_headers.get("x-amz-request-id"),
                              contentType=output_headers.get("content-type"), bytes=len(output),
                              bodySha256=sha(output), truncated=len(output) > limit)
                if status >= 400:
                    try:
                        code = ET.fromstring(output).findtext("{*}Code", "")
                        if re.fullmatch(r"[A-Za-z0-9._-]{1,80}", code):
                            result["upstreamCode"] = code
                    except ET.ParseError:
                        result["errorBodyParse"] = "invalid XML"
                if len(output) > limit:
                    raise BackupError("Object storage response exceeds the backup budget")
                return status, output_headers, output
        except OSError as failure:
            result["transportFailure"] = type(failure).__name__
            raise BackupError(f"{self.service} transport failure") from None
        finally:
            result["endedAt"] = utc().isoformat()
            result["durationMs"] = round(1000 * (time.monotonic() - start))
            self.audit.write(encode(result).decode() + "\n")
            self.audit.flush()


def inspect(target):
    container, = json.loads(run("docker", "inspect", target["container"]))
    config = container["Config"]
    labels = config["Labels"]
    if (not container["State"]["Running"] or labels.get("cds.project.id") != target["project"]
            or labels.get("cds.service.id") != target["service"]):
        raise BackupError("Container source identity changed")
    return container


def s3_source(target, audit):
    container = inspect(target)
    env = dict(line.split("=", 1) for line in container["Config"]["Env"] if "=" in line)
    ips = [value["IPAddress"] for value in container["NetworkSettings"]["Networks"].values()
           if value["IPAddress"]]
    if len(ips) != 1 or not ipaddress.ip_address(ips[0]).is_private:
        raise BackupError("Source container must have an unambiguous private address")
    if target["kind"] == "minio":
        port, names = 9000, ("MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD")
    else:
        port = int(env.get("RUSTFS_ADDRESS", ":9000").rsplit(":", 1)[-1])
        names = ("RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY")
    return container["Id"], S3(f"http://{ips[0]}:{port}", env[names[0]], env[names[1]],
                             "us-east-1", target["service"], audit)


def xml_request(source, path, operation, query=None):
    status, _, data = source.request("GET", path, operation, query=query)
    if status != 200:
        raise BackupError(f"{operation} returned HTTP {status}")
    return ET.fromstring(data)


def inventory(source):
    result = {}
    buckets = xml_request(source, "/", "list-buckets")
    for bucket in buckets.findall(".//{*}Bucket/{*}Name"):
        path = "/" + bucket.text
        version = xml_request(source, path, "get-bucket-versioning", {"versioning": ""})
        if version.findtext("{*}Status"):
            raise BackupError("Bucket has version history, requiring a version-aware backup")
        listing = xml_request(source, path, "list-objects", {"list-type": "2", "max-keys": "1000",
                                                           "encoding-type": "url"})
        if listing.findtext("{*}IsTruncated") != "false":
            raise BackupError("Bucket exceeds the current verified inventory bound")
        encoded = listing.findtext("{*}EncodingType") == "url"
        result[bucket.text] = [
            (urllib.parse.unquote(entry.findtext("{*}Key")) if encoded else entry.findtext("{*}Key"),
             int(entry.findtext("{*}Size")), entry.findtext("{*}ETag"))
            for entry in listing.findall("{*}Contents")
        ]
    count = sum(len(objects) for objects in result.values())
    size = sum(length for objects in result.values() for _, length, _ in objects)
    if len(result) > MAX_OBJECTS or count > MAX_OBJECTS or size > MAX_BYTES:
        raise BackupError("Object inventory exceeds the verified backup budget")
    return result


def bucket_settings(source, bucket):
    path = "/" + bucket
    settings = {}
    for operation, missing in OPTIONAL_BUCKET_SETTINGS.items():
        status, _, value = source.request("GET", path, "bucket-" + operation, query={operation: ""})
        if status == 200:
            if operation == "object-lock":
                raise BackupError("Object Lock requires a lock-aware recovery target")
            settings[operation] = base64.b64encode(value).decode("ascii")
        elif status not in (400, 404) or ET.fromstring(value).findtext("{*}Code") != missing:
            raise BackupError(f"Bucket {operation} configuration is unconfirmed")
    for operation in ("logging", "notification"):
        if len(xml_request(source, path, "bucket-" + operation, {operation: ""})):
            raise BackupError(f"Nonempty bucket {operation} requires destination validation")
    acl = xml_request(source, path, "bucket-acl", {"acl": ""})
    owner = acl.findtext(".//{*}Owner/{*}ID")
    actual = acl.findall(".//{*}Grant")
    if len(actual) != 1 or actual[0].findtext("{*}Permission") != "FULL_CONTROL":
        raise BackupError("Bucket has non-default grants requiring identity-aware recovery")
    grantee = actual[0].find("{*}Grantee")
    if (grantee is None or tuple(grantee.attrib.values()) != ("CanonicalUser",)
            or grantee.findtext("{*}ID") not in (None, "", owner)):
        raise BackupError("Bucket grant principal could not be identified as the owner")
    return settings


def object_backup(target, audit):
    identity, source = s3_source(target, audit)
    before = inventory(source)
    buckets = {}
    settings = {name: bucket_settings(source, name) for name in before}
    for bucket, objects in before.items():
        rows = []
        for key, size, etag in objects:
            status, headers, body = source.request("GET", f"/{bucket}/{key}", "get-object",
                                                   headers={"if-match": etag}, limit=size)
            if status != 200 or len(body) != size or headers.get("etag") != etag:
                raise BackupError("Source object changed during capture")
            meta = {key: value for key, value in headers.items() if key.startswith("x-amz-meta-")
                    or key in {"cache-control", "content-disposition", "content-encoding",
                               "content-language", "content-type", "expires"}}
            tag_status, _, tag_body = source.request("GET", f"/{bucket}/{key}", "get-object-tags",
                                                      query={"tagging": ""})
            if tag_status != 200:
                raise BackupError(f"Object tag capture returned HTTP {tag_status}")
            tag_rows = ET.fromstring(tag_body).findall(".//{*}Tag")
            rows.append({"key": key, "body": base64.b64encode(body).decode("ascii"), "sha256": sha(body),
                         "headers": meta,
                         "tags": [(tag.findtext("{*}Key"), tag.findtext("{*}Value", ""))
                                  for tag in tag_rows]})
        buckets[bucket] = {"settings": settings[bucket], "objects": rows}
    if (identity != inspect(target)["Id"] or before != inventory(source)
            or settings != {name: bucket_settings(source, name) for name in before}):
        raise BackupError("Source object inventory changed during capture")
    return {"kind": target["kind"], "buckets": buckets}


def kafka_cli(target, executable, *args):
    return run("docker", "exec", target["container"], "/opt/kafka/bin/" + executable,
               "--bootstrap-server", "127.0.0.1:9092", *args)


def kafka_offsets(target, when):
    values = {}
    for line in kafka_cli(target, "kafka-get-offsets.sh", "--time", when).splitlines():
        topic, partition, offset = line.rsplit(":", 2)
        # Only Kafka-owned internal topics are exempt, not all user topics beginning with '__'.
        if topic not in {"__consumer_offsets", "__transaction_state"}:
            values[topic, int(partition)] = int(offset)
    return values


def assert_kafka_empty(target, offsets):
    groups = kafka_cli(target, "kafka-consumer-groups.sh", "--list").strip()
    if groups or any(offsets.values()):
        raise BackupError("Kafka has messages or committed offsets, requiring full data replication",
                          "kafka-data-present")


def kafka_backup(target):
    identity = inspect(target)["Id"]

    def describe():
        actual = {line.strip() for line in kafka_cli(target, "kafka-topics.sh", "--list").splitlines()
                  if line.strip() and line.strip() not in {"__consumer_offsets", "__transaction_state"}}
        rows = []
        for line in kafka_cli(target, "kafka-topics.sh", "--describe").splitlines():
            match = re.fullmatch(r"Topic: (\S+)\s+TopicId: \S+\s+PartitionCount: (\d+)\s+"
                                 r"ReplicationFactor: (\d+)\s+Configs:\s*(.*)", line.strip())
            if match is None or match[1] not in actual:
                continue
            topic, parts, replicas, config = match.groups()
            if config or int(parts) < 1 or int(replicas) != 1:
                raise BackupError("Kafka has custom topic configuration requiring a wider recovery method")
            rows.append({"topic": topic, "partitions": int(parts), "replicationFactor": int(replicas)})
        if {row["topic"] for row in rows} != actual or len(rows) != len(actual):
            raise BackupError("Kafka topic inventory and descriptions disagree")
        return sorted(rows, key=lambda row: row["topic"])

    before = describe()
    if not before:
        raise BackupError("No Kafka business topic metadata was returned")
    expected = {(row["topic"], index) for row in before for index in range(row["partitions"])}
    earliest, latest = (kafka_offsets(target, when) for when in ("earliest", "latest"))
    assert_kafka_empty(target, latest)
    if earliest.keys() != expected or latest.keys() != expected or earliest != latest:
        raise BackupError("Kafka partition offset inventory is incomplete")
    if identity != inspect(target)["Id"] or before != describe():
        raise BackupError("Kafka topology changed during capture")
    return {"kind": "kafka-empty-topics", "topics": before}


def rabbit_cli(container, executable, *arguments, timeout=45):
    return run("docker", "exec", container, executable, "--quiet", *arguments, timeout=timeout)


def rabbit_queues(container):
    vhosts = json.loads(rabbit_cli(container, "rabbitmqctl", "list_vhosts", "name", "--formatter", "json"))
    fields = ("durable", "type", "messages_ready", "messages_unacknowledged", "messages_persistent")
    queues = {}
    for vhost in vhosts:
        rows = json.loads(rabbit_cli(container, "rabbitmqctl", "list_queues", "-p", vhost["name"],
                                      "name", *fields, "--formatter", "json"))
        for row in rows:
            queues[vhost["name"], row["name"]] = tuple(row[field] for field in fields)
    return queues


def stable_rabbit_tree(data_directory, metadata):
    archive = io.BytesIO()
    files = list(islice(data_directory.rglob("*"), MAX_OBJECTS))
    if len(files) >= MAX_OBJECTS:
        raise BackupError("RabbitMQ data directory exceeds the verified file count")
    size = 0
    with gzip.GzipFile(fileobj=archive, mode="wb", mtime=0) as output:
        with tarfile.open(fileobj=output, mode="w|") as tar:
            for source in [data_directory, *sorted(files)]:
                record = source.lstat()
                if source.is_symlink() or not (source.is_dir() or source.is_file()):
                    raise BackupError("Unexpected RabbitMQ data directory entry")
                size += record.st_size
                if size > MAX_BYTES:
                    raise BackupError("RabbitMQ data directory exceeds the verified byte budget")
                name = "mnesia" if source == data_directory else "mnesia/" + source.relative_to(data_directory).as_posix()
                member = tar.gettarinfo(str(source), name)
                member.mtime = 0
                if member.isdir():
                    tar.addfile(member)
                    continue
                content = source.read_bytes()
                if len(content) != record.st_size or source.lstat().st_mtime_ns != record.st_mtime_ns:
                    raise BackupError("RabbitMQ data changed while being read")
                tar.addfile(member, io.BytesIO(content))
            body = encode(metadata)
            record = tarfile.TarInfo("backup.json")
            record.mode = 0o600
            record.size = len(body)
            tar.addfile(record, io.BytesIO(body))
    return archive.getvalue()


def verify_rabbit_archive(archive, root_owner, cookie_owner, host, image, queues):
    with tempfile.TemporaryDirectory(prefix="cds-rabbitmq-backup-drill-") as workspace:
        target = Path(workspace)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            members = [member for member in tar.getmembers()
                       if member.name == "mnesia" or member.name.startswith("mnesia/")]
            tar.extractall(target, members=members, filter="data")
            for member in members:
                os.chown(target / member.name, member.uid, member.gid)
        os.chown(target, *root_owner)
        cookie = target / ".erlang.cookie"
        cookie.write_text(os.urandom(24).hex())
        os.chown(cookie, *cookie_owner)
        cookie.chmod(0o400)
        name = "cds-rabbitmq-backup-drill-" + os.urandom(6).hex()
        try:
            sandbox = run("docker", "run", "--detach", "--pull", "never", "--network", "none",
                          "--hostname", host, "--name", name, "--label", "cds.backup.drill=" + name,
                          "--memory", "768m", "--cpus", "1", "--pids-limit", "256",
                          "--env", "RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2 +A 4",
                          "--env", "RABBITMQ_CTL_ERL_ARGS=+S 1:1",
                          "--mount", f"type=bind,source={target},target=/var/lib/rabbitmq", image, timeout=65).strip()
            if (not re.fullmatch(r"[0-9a-f]{64}", sandbox)
                    or run("docker", "inspect", "--format", "{{.HostConfig.NetworkMode}}", sandbox).strip() != "none"):
                raise BackupError("Isolated RabbitMQ container identity was not returned")
            for _ in range(10):
                try:
                    rabbit_cli(sandbox, "rabbitmq-diagnostics", "check_running", timeout=22)
                    break
                except (BackupError, subprocess.TimeoutExpired):
                    if run("docker", "inspect", "--format", "{{.State.Running}}", sandbox).strip() != "true":
                        raise BackupError("Isolated RabbitMQ exited during recovery") from None
                    time.sleep(2)
            else:
                raise BackupError("Isolated RabbitMQ did not become ready")
            if rabbit_queues(sandbox) != queues:
                raise BackupError("Isolated RabbitMQ queue counts differ from the captured source")
        finally:
            lookup = subprocess.run(
                ("docker", "inspect", "--format", '{{.Id}} {{index .Config.Labels "cds.backup.drill"}}', name),
                capture_output=True, text=True, timeout=TIMEOUT,
            )
            match = re.fullmatch(r"([0-9a-f]{64}) " + re.escape(name), lookup.stdout.strip())
            if match:
                run("docker", "rm", "--force", "--volumes", match[1])


def rabbit_backup(target):
    container = inspect(target)
    hostname = container["Config"]["Hostname"]
    env = dict(line.split("=", 1) for line in container["Config"]["Env"] if "=" in line)
    if (not re.fullmatch(r"[a-zA-Z0-9.-]{1,70}", hostname)
            or env.get("RABBITMQ_NODENAME", "rabbit@" + hostname) != "rabbit@" + hostname):
        raise BackupError("RabbitMQ node name cannot be reproduced in the isolated restore")
    cluster = json.loads(rabbit_cli(target["container"], "rabbitmqctl", "cluster_status", "--formatter", "json"))
    if cluster.get("disk_nodes") != ["rabbit@" + hostname] or cluster.get("ram_nodes"):
        raise BackupError("RabbitMQ multi-node data needs a replica-aware recovery method")
    mounts = [Path(mount["Source"]) for mount in container["Mounts"]
              if mount["Type"] == "volume" and mount["Destination"] == "/var/lib/rabbitmq"]
    if len(mounts) != 1:
        raise BackupError("RabbitMQ data volume identity is unconfirmed")
    root = mounts[0]
    data_directory = root / "mnesia"
    if not data_directory.is_dir() or data_directory.is_symlink():
        raise BackupError("RabbitMQ data directory is missing")
    permissions = root.stat()
    cookie = root / ".erlang.cookie"
    if not cookie.is_file() or cookie.is_symlink():
        raise BackupError("RabbitMQ recovery file ownership is unconfirmed")
    cookie_permissions = cookie.stat()
    queues = rabbit_queues(target["container"])
    if not queues or any(not durable or kind != "classic" or unack or ready != persistent
                         for durable, kind, ready, unack, persistent in queues.values()):
        raise BackupError("RabbitMQ has active or unsupported queue state, so no new recovery point was accepted")
    metadata = {"formatVersion": 1, "kind": "rabbitmq-isolated-verified", "node": "rabbit@" + hostname,
                "imageId": container["Image"], "queueCount": len(queues),
                "persistentMessages": sum(queue[4] for queue in queues.values())}
    archive = stable_rabbit_tree(data_directory, metadata)
    if (queues != rabbit_queues(target["container"]) or archive != stable_rabbit_tree(data_directory, metadata)
            or container["Id"] != inspect(target)["Id"]):
        raise BackupError("RabbitMQ activity changed during the read-only capture")
    disk_budget()
    try:
        verify_rabbit_archive(archive, (permissions.st_uid, permissions.st_gid),
                              (cookie_permissions.st_uid, cookie_permissions.st_gid), hostname, container["Image"], queues)
    except (BackupError, OSError, subprocess.TimeoutExpired) as error:
        raise BackupError("Isolated RabbitMQ recovery verification failed", "rabbitmq-restore-failed") from error
    return archive, {"queues": metadata["queueCount"], "persistentMessages": metadata["persistentMessages"]}


def disk_budget():
    disk = os.statvfs("/")
    if (disk.f_bavail - disk.f_blocks * 0.15) * disk.f_frsize < 128 * 1024 * 1024:
        raise BackupError("Disk reserve before 85 percent is insufficient")


def observe_target(target):
    container = inspect(target)
    if target["kind"] == "kafka":
        offsets = kafka_offsets(target, "latest")
        assert_kafka_empty(target, offsets)
        if not offsets:
            raise BackupError("Kafka probe returned no business partition offsets", "probe-failed")
    elif target["kind"] == "stateless":
        cfg = container["Config"]
        command = [container["Image"], cfg["Entrypoint"], cfg["Cmd"]]
        if container["Mounts"] or sha(encode(command)) != target["commandSha256"]:
            raise BackupError("Audited proxy deployment changed", "stateless-changed")
    elif target["kind"] == "state-runtime":
        volumes = [Path(m["Source"]) for m in container["Mounts"]
                   if m["Type"] == "volume" and m["Destination"] == "/data"]
        if len(volumes) != 1 or len(container["Mounts"]) != 1 or not volumes[0].is_dir():
            raise BackupError("Could not confirm the runtime data volume", "runtime-data-unconfirmed")
        if any(p.is_symlink() or not p.is_dir() for p in volumes[0].rglob("*")):
            raise BackupError("Runtime data volume contains files", "runtime-data-present")
    if container["Id"] != inspect(target)["Id"]:
        raise BackupError("Source changed during the coverage probe", "probe-failed")


def read_previous(path):
    if not path.is_file():
        return {}
    try:
        receipt = json.loads(path.read_text())
        return {(row["projectId"], row["id"], row["kind"]): row["lastVerified"]
                for row in receipt["targets"] if row.get("lastVerified")}
    except (ValueError, KeyError, TypeError):
        return {}


def publish(base, name, rows):
    path = base / name
    temporary = path.with_name(f".{name}.{os.getpid()}.tmp")
    payload = {"version": 2, "completedAt": utc().isoformat(), "targets": rows}
    try:
        with temporary.open("xb") as handle:
            handle.write(encode(payload) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def scoped_target(target):
    project, service, kind = (target[k] for k in ("project", "service", "kind"))
    if kind not in {"minio", "rustfs", "kafka", "rabbitmq", "stateless", "state-runtime"} or not all(
            re.fullmatch(r"[a-z0-9_][a-z0-9_-]{0,100}", value) for value in (project, service)):
        raise BackupError("Invalid backup target configuration")
    return {"projectId": project, "id": service, "kind": kind}


def probe(base, config):
    rows = []
    for target in config["targets"]:
        if target["kind"] not in {"kafka", "stateless", "state-runtime"}:
            continue
        row = scoped_target(target)
        try:
            observe_target(target)
            row["ok"] = True
        except (BackupError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
            row.update(ok=False, code=error.code if isinstance(error, BackupError) and
                       error.code != "backup-failed" else "probe-failed")
        rows.append(row)
    publish(base, "probe.json", rows)
    print(json.dumps({"coverageProbe": {row["id"]: row.get("code", "ok") for row in rows}}))
    return 0 if all(row["ok"] for row in rows) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(args.config.read_text())
    base = Path(config["stateDirectory"])
    base.mkdir(parents=True, exist_ok=True)
    if args.probe:
        return probe(base, config)
    stamp = utc().strftime("%Y%m%dT%H%M%S.%fZ")
    previous = read_previous(base / "latest.json")
    master_pid = int(run("systemctl", "show", "cds-master", "-p", "MainPID", "--value"))
    if master_pid <= 1:
        raise BackupError("CDS backup configuration is unavailable")
    env = dict(line.split(b"=", 1) for line in Path(f"/proc/{master_pid}/environ").read_bytes().split(b"\0")
               if b"=" in line)
    prefix = env.get(b"R2_PREFIX", b"cds-infra-backups").decode().strip("/")
    if not prefix or not env[b"R2_ENDPOINT"].startswith(b"https://"):
        raise BackupError("The configured CDS private R2 prefix is required")
    outcomes = {}
    rows = []
    with (base / "requests.jsonl").open("a", encoding="utf-8") as audit:
        remote = S3(env[b"R2_ENDPOINT"].decode(), env[b"R2_ACCESS_KEY_ID"].decode(),
                    env[b"R2_SECRET_ACCESS_KEY"].decode(), "auto", "cds-backup-r2", audit)
        for target in config["targets"]:
            row = scoped_target(target)
            service, project, kind = row["id"], row["projectId"], row["kind"]
            if kind in {"stateless", "state-runtime"}:
                continue
            previous_point = previous.get((project, service, kind))
            try:
                disk_budget()
                if target["kind"] == "rabbitmq":
                    archive, verified = rabbit_backup(target)
                    extension = "tar.gz"
                else:
                    manifest = kafka_backup(target) if target["kind"] == "kafka" else object_backup(target, audit)
                    manifest["formatVersion"] = 1
                    archive = gzip.compress(encode(manifest), mtime=0)
                    verified = {}
                    extension = "json.gz"
                checksum = sha(archive)
                path = f"/{env[b'R2_BUCKET'].decode()}/{prefix}/coverage/{project}/{service}/{checksum}.{extension}"
                status, _, _ = remote.request("PUT", path, "store:" + service, data=archive,
                                              headers={"content-type": "application/gzip",
                                                       "x-amz-meta-sha256": checksum, "if-none-match": "*"})
                if not (200 <= status < 300 or status == 412):
                    raise BackupError(f"R2 archive upload returned HTTP {status}")
                status, _, readback = remote.request("GET", path, "verify:" + service, limit=len(archive))
                if status != 200 or len(readback) != len(archive) or sha(readback) != checksum:
                    raise BackupError("R2 archive readback did not match the captured data")
                outcomes[service] = {"ok": True, "object": path, "bytes": len(archive), "sha256": checksum,
                                     "verifiedRecovery": verified}
                row.update(ok=True, lastVerified={"at": utc().isoformat(), "bytes": len(archive),
                                                  "sha256": checksum, "recovery": verified})
            except (BackupError, ET.ParseError, ValueError, KeyError, OSError, subprocess.TimeoutExpired) as error:
                detail = str(error) if isinstance(error, BackupError) else type(error).__name__
                outcomes[service] = {"ok": False, "error": detail}
                row.update(ok=False, code=error.code if isinstance(error, BackupError) else "backup-failed")
                if previous_point:
                    row["lastVerified"] = previous_point
            rows.append(row)
    receipt = base / (stamp + ".json")
    receipt.write_bytes(encode({"completedAt": utc().isoformat(), "targets": outcomes}) + b"\n")
    publish(base, "latest.json", rows)
    print(json.dumps({"receipt": str(receipt), "targets": {key: value["ok"] for key, value in outcomes.items()}}))
    return 0 if outcomes and all(value["ok"] for value in outcomes.values()) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (BackupError, ValueError, KeyError, OSError) as error:
        detail = str(error) if isinstance(error, BackupError) else type(error).__name__
        print(detail, file=sys.stderr)
        sys.exit(1)
