import { describe, it, expect } from 'vitest';
import { ShellExecutor, MockShellExecutor } from '../../src/services/shell-executor.js';

describe('ShellExecutor', () => {
  it('should execute a simple command', async () => {
    const executor = new ShellExecutor();
    const result = await executor.exec('echo hello');
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('should capture stderr', async () => {
    const executor = new ShellExecutor();
    const result = await executor.exec('echo error >&2');
    expect(result.stderr.trim()).toBe('error');
    expect(result.exitCode).toBe(0);
  });

  it('should return non-zero exit code on failure', async () => {
    const executor = new ShellExecutor();
    const result = await executor.exec('exit 1');
    expect(result.exitCode).toBe(1);
  });

  it('should respect cwd option', async () => {
    const executor = new ShellExecutor();
    const result = await executor.exec('pwd', { cwd: '/tmp' });
    expect(result.stdout.trim()).toBe('/tmp');
  });

  it('should respect timeout option', async () => {
    const executor = new ShellExecutor();
    const result = await executor.exec('sleep 10', { timeout: 500 });
    expect(result.exitCode).not.toBe(0);
  });
});

describe('MockShellExecutor', () => {
  it('should return predefined responses', async () => {
    const mock = new MockShellExecutor();
    mock.addResponse('docker ps', { stdout: 'container1\n', stderr: '', exitCode: 0 });

    const result = await mock.exec('docker ps');
    expect(result.stdout).toBe('container1\n');
    expect(result.exitCode).toBe(0);
  });

  it('should record executed commands', async () => {
    const mock = new MockShellExecutor();
    mock.addResponse('git status', { stdout: '', stderr: '', exitCode: 0 });
    mock.addResponse('git branch', { stdout: '', stderr: '', exitCode: 0 });

    await mock.exec('git status');
    await mock.exec('git branch');

    expect(mock.commands).toEqual(['git status', 'git branch']);
  });

  it('should return default error for unregistered commands', async () => {
    const mock = new MockShellExecutor();
    const result = await mock.exec('unknown command');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not mocked');
  });

  it('should support regex-based matching', async () => {
    const mock = new MockShellExecutor();
    mock.addResponsePattern(/docker run.*--name (\S+)/, (match) => ({
      stdout: `Started ${match[1]}`,
      stderr: '',
      exitCode: 0,
    }));

    const result = await mock.exec('docker run -d --name my-container image:latest');
    expect(result.stdout).toBe('Started my-container');
  });
});
