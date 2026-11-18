"""Actual independent Sidecar processes; fake control-plane/provider only.
Mongo persistence and terminal CAS are separately exercised by the C# integration tests.
"""
import asyncio
import multiprocessing as mp
import time
import unittest
from unittest.mock import patch
from fastapi import HTTPException
from app import main
from app.authorization import RunAuthorization
from app.schemas import SidecarRunRequest, SidecarEvent


def worker(shared, lock, output, mode):
    async def authority(token, run_id, operation):
        if token != "Bearer map-task-v2.alice" or run_id != "run-a":
            raise HTTPException(403)
        with lock:
            if shared.get("fault"):
                raise HTTPException(503)
            state = shared["state"]
            if operation == "cancel" and state == "running":
                state = "cancel_requested"
            if operation in {"complete", "fail"} and state in {"running", "cancel_requested"}:
                state = "cancelled" if state == "cancel_requested" else ("completed" if operation == "complete" else "failed")
            shared["state"] = state
        return RunAuthorization("alice", run_id, int(time.time())+60, "hash"), {"state": state}
    async def provider(req, cancel_event):
        yield SidecarEvent(type="text_delta", text="started")
        await asyncio.sleep(30)
        yield SidecarEvent(type="done", final_text="must not complete")
    class Request:
        async def is_disconnected(self): return False
    async def execute():
        with patch.object(main, "authorize", authority), patch.object(main, "run_official_agent", provider):
            if mode == "cancel":
                # This replica has no local run and cannot rely on _active_runs.
                assert not main._active_runs
                try:
                    await main.cancel("run-a", "Bearer map-task-v2.bob")
                    raise AssertionError("other subject accepted")
                except HTTPException as error:
                    assert error.status_code == 403
                response = await main.cancel("run-a", "Bearer map-task-v2.alice")
                output.put(("cancel", response.status_code, response.body))
                return
            req = SidecarRunRequest(runId="run-a", agentApiKey="map-task-v2.alice", timeoutSeconds=60)
            req._authorization = RunAuthorization("alice", "run-a", int(time.time())+60, "hash")
            req._cancel_event = asyncio.Event()
            async for chunk in main._run_stream(req, Request()):
                output.put(("stream", chunk))
    try:
        asyncio.run(execute())
    except BaseException as error:
        output.put(("failure", repr(error)))
        raise


class CrossProcessCancellationTests(unittest.TestCase):
    def test_remote_cancel_and_control_plane_failure_stop_worker(self):
        ctx = mp.get_context("spawn")
        for fault in (False, True):
            with self.subTest(fault=fault), ctx.Manager() as manager:
                shared = manager.dict(state="running", fault=False)
                lock = manager.Lock()
                output = ctx.Queue()
                owner = ctx.Process(target=worker, args=(shared, lock, output, "run"))
                owner.start()
                try:
                    first = output.get(timeout=10)
                    self.assertEqual(first[0], "stream")
                    self.assertIn(b"started", first[1])
                    if fault:
                        shared["fault"] = True
                    else:
                        other = ctx.Process(target=worker, args=(shared, lock, output, "cancel"))
                        other.start(); other.join(10)
                        self.assertEqual(other.exitcode, 0)
                    owner.join(10)
                    self.assertEqual(owner.exitcode, 0)
                    events = []
                    while not output.empty(): events.append(output.get(timeout=2))
                    text = b"".join(e[1] for e in events if e[0] == "stream")
                    self.assertNotIn(b"event: done", text)
                    self.assertIn(b"run_state_unconfirmed" if fault else b"cancelled", text)
                    self.assertEqual(shared["state"], "running" if fault else "cancelled")
                    self.assertFalse(any(e[0] == "failure" for e in events))
                finally:
                    if owner.is_alive(): owner.terminate(); owner.join()
