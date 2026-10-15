"""独立通知收件箱。私钥、通道配置和投递台账只留在服务账号的私有目录。"""
import base64
import json
import os
from pathlib import Path
import time
import urllib.request


def save(path, state):
    tmp = str(path) + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(state, stream, ensure_ascii=False)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(tmp, path)


def decrypt(envelope, private_key):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = serialization.load_pem_private_key(private_key.encode(), password=None)
    aes = key.decrypt(base64.b64decode(envelope['key']), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    return json.loads(AESGCM(aes).decrypt(base64.b64decode(envelope['iv']), base64.b64decode(envelope['ciphertext']) + base64.b64decode(envelope['tag']), None))


def poll(config, state, now):
    body = {'proof': state.get('proof'), 'acks': state.get('acks', [])[:100]}
    request = urllib.request.Request(config['cdsBase'] + '/api/cds-system/alarm-relay/poll',
        data=json.dumps(body).encode(), headers={**config['headers'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        packet = decrypt(json.loads(response.read(4_000_000)), config['relayPrivateKey'])
    state['acks'] = state.get('acks', [])[len(body['acks']):]
    state.update(proof=packet['challenge'], enabled=packet['enabled'], channels=packet['channels'], syncedAt=now)
    for item in packet['items']:
        if item['id'] in state.setdefault('receipts', {}):
            state.setdefault('acks', []).append(state['receipts'][item['id']])
        else:
            state.setdefault('inbox', {}).setdefault(item['id'], {**item, 'receivedAt': now})


def send(channel, message):
    bark = channel['bark']
    payload = {'device_key': bark['key'], 'title': message['title'], 'body': message['body'],
        'url': message.get('url', ''), 'group': message.get('group') or bark.get('group') or '业务监控',
        'level': bark.get('level') or message.get('level', 'active')}
    if message.get('icon'): payload['icon'] = message['icon']
    for key in ('sound', 'call'):
        if bark.get(key): payload[key] = bark[key]
    request = urllib.request.Request(bark.get('serverUrl', 'https://api.day.app').rstrip('/') + '/push',
        data=json.dumps(payload, ensure_ascii=False).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status == 200 and json.loads(response.read(4096)).get('code') == 200
    except Exception:
        # Bark 没有幂等回执。超时不能证明没送达，记录待核实而不盲目重复推送。
        return False


def process(state, now, persist, sender=send, platform_incident=None):
    channels = {c['id']: c for c in state.get('channels', []) if c.get('enabled')}
    for item in list(state.get('inbox', {}).values()):
        if now - item['receivedAt'] < 30 and not item['event'].get('drill'): continue
        event = item['event']; channel = channels.get(item['channelId'])
        if not channel: continue
        key = item['channelId'] + '/' + (event.get('correlationKey') or event.get('targetId') or item['id'])
        if event.get('drill'): key = item['id']
        inherited = event.get('recoveryConfirmed', False) and event['kind'].endswith('-recovered')
        incident = state.setdefault('incidents', {}).setdefault(key, {'targets': [], 'notified': inherited, 'accepted': inherited, 'deliveries': []})
        target = event.get('targetId') or item['id']
        recovered = event['kind'].endswith('-recovered')
        targets = incident['targets']
        if recovered:
            if target in targets: targets.remove(target)
        elif target not in targets: targets.append(target)
        merged_parent = bool(platform_incident and event.get('projectId') == 'cds-self-monitor' and event.get('assessment') == 'observation-unavailable')
        should_send = (not recovered and not incident['notified'] and not merged_parent) or (recovered and not targets and incident.get('accepted'))
        prior = next((d for d in incident['deliveries'] if d['itemId'] == item['id']), None)
        if prior:
            # 在发送后、回执前重启，也不能再发同一条。结果未知会留在台账。
            ok = prior.get('accepted', False)
            incident['notified'] = not recovered
            incident['accepted'] = ok and not recovered
        elif should_send:
            delivery = {'itemId': item['id'], 'at': now, 'state': 'sending', 'accepted': False}
            incident['deliveries'].append(delivery)
            persist()
            ok = sender(channel, item['message'])
            delivery.update(accepted=ok, state='accepted' if ok else 'unconfirmed')
            incident['notified'] = not recovered
            incident['accepted'] = ok and not recovered
        else:
            ok = incident.get('accepted', False) or merged_parent
            incident['deliveries'].append({'itemId': item['id'], 'at': now, 'state': 'merged', 'accepted': ok})
        if recovered and not targets:
            incident['notified'] = False
            incident['accepted'] = False
        receipt = {'id': item['id'], 'ok': ok, 'merged': (prior or {}).get('state') == 'merged' if prior else not should_send}
        state.setdefault('receipts', {})[item['id']] = receipt
        state.setdefault('acks', []).append(receipt)
        del state['inbox'][item['id']]
        persist()
