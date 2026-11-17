#!/usr/bin/env python3
"""Recreate one explicitly named MAP container with the same runtime config and bounded logs.

Uses the local Docker socket. Private snapshots stay on the host for rollback;
never print Config.Env. Does not restart Docker or pull any images.
"""
import argparse
import copy
import fcntl
import http.client
import json
import os
from pathlib import Path
import socket
import time
from urllib.parse import quote

ALLOWED = ('prdagent-gateway', 'prdagent-api', 'prdagent-mongodb', 'prdagent-redis',
           'prdagent-llmgw', 'prdagent-llmgw-web', 'prdagent-llmgw-serve',
           'prdagent-llmgw-serve-b', 'prdagent-design-opendesign')
LOG_CONFIG = {'Type':'json-file','Config':{'max-size':'20m','max-file':'3'}}


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def request(method, path, body=None):
    connection = DockerConnection('localhost', timeout=150)
    payload = json.dumps(body).encode() if body is not None else None
    connection.request(method, '/v1.48'+path, payload, {'Content-Type':'application/json'})
    response = connection.getresponse()
    data = response.read()
    connection.close()
    if response.status >= 400:
        # Docker errors can contain original config; do not echo them.
        raise RuntimeError(f'Docker {method} {path.split("?")[0]} returned {response.status}')
    return json.loads(data) if data else None


def payload_for(snapshot):
    payload = copy.deepcopy(snapshot['Config'])
    payload['Image'] = snapshot['Image']  # Exact image ID; no tag resolution or pull.
    host = copy.deepcopy(snapshot['HostConfig'])
    host['LogConfig'] = copy.deepcopy(LOG_CONFIG)
    # Preserve anonymous volumes by their existing Docker volume names as well.
    binds = host.get('Binds') or []
    destinations = {bind.split(':')[1] for bind in binds}
    explicit = {mount['Target'] for mount in host.get('Mounts') or []}
    for mount in snapshot.get('Mounts', []):
        if mount['Type'] == 'volume' and mount['Destination'] not in destinations | explicit:
            binds.append(mount['Name']+':'+mount['Destination']+('' if mount['RW'] else ':ro'))
    host['Binds'] = binds
    payload['HostConfig'] = host
    endpoints = {}
    for name, net in snapshot['NetworkSettings']['Networks'].items():
        # Preserve service aliases and IPs so existing Nginx upstreams keep working.
        endpoint = {'Aliases': net.get('Aliases') or [], 'IPAMConfig': {}}
        if net.get('IPAddress'): endpoint['IPAMConfig']['IPv4Address'] = net['IPAddress']
        if net.get('GlobalIPv6Address'): endpoint['IPAMConfig']['IPv6Address'] = net['GlobalIPv6Address']
        endpoints[name] = endpoint
    payload['NetworkingConfig'] = {'EndpointsConfig': endpoints}
    return payload


def inspect(name):
    return request('GET', '/containers/'+quote(name, safe='')+'/json')


def wait_running(name, timeout=150):
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        state = inspect(name)['State']
        if not state.get('Running'): raise RuntimeError('Replacement container stopped')
        health = state.get('Health',{}).get('Status')
        if health is None:
            time.sleep(2)
            if inspect(name)['State'].get('Running'): return
        elif health == 'healthy': return
        elif health == 'unhealthy': raise RuntimeError('Replacement unhealthy')
        time.sleep(2)
    raise RuntimeError('Replacement readiness timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True, choices=ALLOWED)
    parser.add_argument('--snapshot-dir', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    lock = open('/run/lock/prd-agent-production.lock','a')
    fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    before = inspect(args.container)
    if before['HostConfig']['LogConfig'] == LOG_CONFIG:
        print(args.container+': already bounded'); return
    if not before['State'].get('Running'): raise RuntimeError('Expected running source container')
    payload = payload_for(before)
    print(args.container+': preserve image/env/volumes/ports/aliases/IP; log cap 20m x 3',flush=True)
    if not args.execute: return
    directory = Path(args.snapshot_dir)
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    os.chmod(directory,0o700)
    file = directory/(args.container+'-'+before['Id'][:12]+'.json')
    if file.exists(): raise RuntimeError('Refusing to overwrite prior snapshot')
    fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream: json.dump(before,stream)
    backup = args.container+'-log-backup-'+before['Id'][:12]
    stopped = renamed = created = False
    try:
        request('POST','/containers/'+before['Id']+'/stop?t=60'); stopped=True
        request('POST','/containers/'+before['Id']+'/rename?name='+backup); renamed=True
        for network in before['NetworkSettings']['Networks']:
            request('POST','/networks/'+quote(network,safe='')+'/disconnect',{'Container':before['Id'],'Force':True})
        result = request('POST','/containers/create?name='+args.container,payload);created=True
        request('POST','/containers/'+result['Id']+'/start')
        wait_running(args.container)
        after = inspect(args.container)
        if (after['Image'] != before['Image'] or after['Config']['Env'] != before['Config']['Env']
                or after['HostConfig']['LogConfig'] != LOG_CONFIG):
            raise RuntimeError('Runtime invariants differ')
        print(args.container+': ready; old container retained as '+backup,flush=True)
    except Exception:
        if created:
            request('DELETE','/containers/'+args.container+'?force=true')
        if renamed:
            request('POST','/containers/'+before['Id']+'/rename?name='+args.container)
            attached = inspect(before['Id'])['NetworkSettings']['Networks']
            for network,endpoint in payload['NetworkingConfig']['EndpointsConfig'].items():
                if network not in attached:
                    request('POST','/networks/'+quote(network,safe='')+'/connect',{'Container':before['Id'],'EndpointConfig':endpoint})
        if stopped:
            request('POST','/containers/'+before['Id']+'/start')
            wait_running(args.container)
        print(args.container+': restored original after rollout failure',flush=True)
        raise


if __name__=='__main__': main()
