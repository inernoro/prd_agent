import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStat, processTree } from './resources.mjs';

test('进程名含空格和括号时仍读取正确的CPU、RSS及父进程', () => {
  const fields = Array(25).fill('0');
  fields[0] = 'S'; fields[1] = '10'; fields[11] = '13'; fields[12] = '7'; fields[21] = '80';
  assert.deepEqual(parseStat(`20 (worker (one)) ${fields.join(' ')}`), { pid: 20, parent: 10, ticks: 20, rssPages: 80 });
});
test('各容器只累计自己进程树，不能重复归属宿主的共享cgroup', () => {
  const rows = [{ pid: 1, parent: 0, ticks: 9999, rssPages: 9000 },
    { pid: 10, parent: 1, ticks: 2, rssPages: 4 }, { pid: 20, parent: 10, ticks: 3, rssPages: 5 },
    { pid: 30, parent: 1, ticks: 7, rssPages: 9 }];
  assert.deepEqual(processTree(rows, 10), { ticks: 5, rssPages: 9, pids: [10, 20] });
  assert.equal(processTree(rows, 30).ticks, 7);
});
