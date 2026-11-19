"""感知系统的直连事件接收。来源与渠道从独立进程的私有配置读取。"""

from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
from threading import Thread
import time


CATALOG = json.loads((Path(__file__).resolve().parents[1] / 'src/shared/notification-templates.json').read_text(encoding='utf-8'))
TEMPLATES = {
    'release-started': 'REL-04',
    'release-succeeded': 'REL-01',
    'release-failed': 'REL-02',
    'rollback-started': 'REL-05',
    'rollback-succeeded': 'REL-03',
    'rollback-failed': 'REL-06',
}
IDENTIFIER = re.compile(r'[A-Za-z0-9_.:-]{1,128}')
ROUTE = re.compile(r'/v1/sources/([A-Za-z0-9_.-]{1,64})/events(?:/([A-Za-z0-9_.:-]{1,128}))?')


def channel_revision(channel):
    return hashlib.sha256(json.dumps(channel['bark'], sort_keys=True).encode()).hexdigest()


class PerceptionInbox:
    def __init__(self, path, config):
        self.path = path
        self.sources = config['sources']
        self.channels = config['channels']
        for source, policy in self.sources.items():
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', source):
                raise ValueError('感知系统事件来源标识无效')
            if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', policy['token']):
                raise ValueError('感知系统事件来源令牌无效')
            if (policy['channel'] not in self.channels or not self.channels[policy['channel']]['bark']['key']
                    or policy['system'] not in CATALOG['systems'] or policy['system'] == 'unknown'
                    or not IDENTIFIER.fullmatch(policy['project']) or not IDENTIFIER.fullmatch(policy['target'])
                    or not policy['kinds'] or not set(policy['kinds']) <= TEMPLATES.keys()):
                raise ValueError('感知系统事件来源须绑定正式目标、事件类型和通道')
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            if os.fstat(fd).st_mode & 0o077:
                raise ValueError('感知系统事件库权限须为 0600')
        finally:
            os.close(fd)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute('''CREATE TABLE IF NOT EXISTS events (
                source TEXT, id TEXT, payload TEXT NOT NULL, received REAL NOT NULL, status TEXT NOT NULL,
                PRIMARY KEY (source, id))''')
            db.execute('CREATE INDEX IF NOT EXISTS events_pending ON events(status, received)')

    def authorize(self, source, header):
        policy = self.sources.get(source)
        return policy is not None and secrets.compare_digest(header.encode('utf-8'), ('Bearer ' + policy['token']).encode('utf-8'))

    def receive(self, source, event, now):
        policy = self.sources[source]
        if (not isinstance(event, dict) or set(event) != {'id', 'run', 'kind', 'version'}
                or any(not isinstance(value, str) for value in event.values())
                or event['kind'] not in policy['kinds'] or not IDENTIFIER.fullmatch(event['id'])
                or not IDENTIFIER.fullmatch(event['run']) or not re.fullmatch(r'[a-fA-F0-9]{7,64}', event['version'])):
            raise ValueError('事件不符合该来源的发布事实约定')
        event = {**event, 'version': event['version'].lower()}
        with closing(sqlite3.connect(self.path)) as db, db:
            # 先加写锁，保证两个同时到达的同编号请求只能接收一份事实。
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT payload, status FROM events WHERE source=? AND id=?', (source, event['id'])).fetchone()
            if row:
                if json.loads(row[0])['event'] != event:
                    raise FileExistsError('同一来源事件编号对应了不同事实')
                return row[1]
            payload = {'event': event, 'channel': policy['channel'], 'system': policy['system'],
                       'channelRevision': channel_revision(self.channels[policy['channel']]),
                       'project': policy['project'], 'target': policy['target']}
            db.execute('INSERT INTO events(source, id, payload, received, status) VALUES (?, ?, ?, ?, ?)',
                       (source, event['id'], json.dumps(payload), now, 'queued'))
            return 'queued'

    def receipt(self, source, event_id):
        with closing(sqlite3.connect(self.path)) as db:
            row = db.execute('SELECT status FROM events WHERE source=? AND id=?', (source, event_id)).fetchone()
            return row[0] if row else None

    def dispatch(self, dispatcher, now):
        with closing(sqlite3.connect(self.path)) as db:
            pending = db.execute("SELECT source, id, payload FROM events WHERE status='queued' ORDER BY received LIMIT 100").fetchall()
            for source, event_id, raw in pending:
                payload = json.loads(raw)
                channel = self.channels.get(payload['channel'])
                if channel is None or channel_revision(channel) != payload['channelRevision']:
                    with db:
                        db.execute('UPDATE events SET status=? WHERE source=? AND id=?', ('channel-changed', source, event_id))
                    continue
                event, system = payload['event'], payload['system']
                identifier = hashlib.sha256(json.dumps([source, event_id]).encode()).hexdigest()
                text = CATALOG['templates'][TEMPLATES[event['kind']]]['text'].replace('{version}', event['version'][:12])
                message = {'title': CATALOG['environments']['production'] + ' ' + CATALOG['systems'][system], 'body': text,
                           'level': 'active', 'routineChange': True, 'notificationOrigin': {'environment': 'production', 'system': system}}
                outcome = dispatcher.submit(channel, message, 'perception:' + identifier, now)
                if outcome is not None:
                    with db:
                        db.execute('UPDATE events SET status=? WHERE source=? AND id=?',
                                   ('provider-accepted' if outcome else 'unconfirmed', source, event_id))

    def listen(self, port):
        inbox = self

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                self.request.settimeout(5)
                super().setup()

            def log_message(self, *_args):
                pass  # 请求路径与鉴权信息不进入进程日志。

            def reply(self, status, payload):
                body = json.dumps(payload, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def handle_event(self):
                match = ROUTE.fullmatch(self.path)
                needs_event_id = self.command == 'GET'
                if not match or bool(match[2]) != needs_event_id:
                    self.reply(404, {'error': '未找到事件入口'})
                    return
                source, event_id = match.groups()
                if not inbox.authorize(source, self.headers.get('Authorization', '')):
                    self.reply(403, {'error': '来源未授权'})
                    return
                try:
                    if self.command == 'GET':
                        status = inbox.receipt(source, event_id)
                        if status:
                            self.reply(200, {'status': status})
                        else:
                            self.reply(404, {'error': '未登记该事件'})
                        return
                    size = int(self.headers.get('Content-Length', '0'))
                    if not 0 < size <= 4096:
                        self.reply(413, {'error': '事件载荷大小无效'})
                        return
                    if self.headers.get_content_type() != 'application/json':
                        self.reply(415, {'error': '事件格式须为 JSON'})
                        return
                    raw = self.rfile.read(size)
                    if len(raw) != size:
                        raise ValueError('事件载荷未完整到达')
                    status = inbox.receive(source, json.loads(raw), time.time())
                    self.reply(202, {'status': status})
                except ValueError:
                    self.reply(400, {'error': '事件格式不符合来源约定'})
                except FileExistsError:
                    self.reply(409, {'error': '事件编号已被其他事实使用'})
                except sqlite3.Error:
                    self.reply(503, {'error': '事件尚未持久保存，请重试'})

            do_GET = handle_event
            do_POST = handle_event

        server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        Thread(target=server.serve_forever, daemon=True).start()
        return server
