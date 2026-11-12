"""隔离测试：sidecar 只传业务关联，不复用物理请求编号。"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.agent_loop import run_agent
from app.schemas import SidecarRunRequest


class Response:
    status_code = 200

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def aiter_lines(self):
        yield 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}'
        yield 'data: [DONE]'


class Client:
    calls = []

    def __init__(self, **_):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    def stream(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return Response()


class GatewayTraceHeadersTests(unittest.IsolatedAsyncioTestCase):
    async def test_business_identity_reaches_gateway_without_reusing_request_id(self):
        Client.calls = []
        with patch('app.agent_loop.httpx.AsyncClient', Client):
            for run in ['operation-a', 'operation-b']:
                request = SidecarRunRequest(runId=run, model='fixture-model', protocol='openai-compatible',
                    baseUrl='https://gateway.example', apiKey='fixture-key', appCallerCode='page-agent.generate::chat',
                    maxTurns=1, messages=[{'role': 'user', 'content': 'fixture'}])
                events = [event async for event in run_agent(request)]
                self.assertEqual(events[-1].type, 'done')
        self.assertEqual(len(Client.calls), 2)
        self.assertEqual(Client.calls[0][2]['headers']['X-Gateway-Run-Id'], 'operation-a')
        self.assertEqual(Client.calls[1][2]['headers']['X-Gateway-Run-Id'], 'operation-b')
        for _, _, call in Client.calls:
            self.assertEqual(call['headers']['X-Gateway-App-Caller'], 'page-agent.generate::chat')
            self.assertNotIn('X-Request-Id', call['headers'])
