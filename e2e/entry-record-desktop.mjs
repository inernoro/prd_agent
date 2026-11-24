import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

/** Keep the actual cloud desktop frames and FFmpeg's epoch for comparison alignment. */
export async function recordEntryDesktop(output, name, action) {
  const file = new URL(`${name}.mp4`, output).pathname;
  const recorder = spawn('ffmpeg', ['-hide_banner', '-y', '-f', 'x11grab', '-video_size', '1920x1080',
    '-framerate', '60', '-i', process.env.DISPLAY, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
    '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'pipe'] });
  let log = '';
  recorder.stderr.on('data', data => { log += data; });
  const done = new Promise(resolve => recorder.once('close', resolve));
  try {
    const deadline = Date.now() + 15_000;
    while (!/frame=\s*[1-9]/.test(log)) {
      assert.ok(Date.now() < deadline && recorder.exitCode === null, 'Cloud screen recorder did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return await action();
  } finally {
    if (recorder.exitCode === null) recorder.stdin.end('q');
    const status = await done;
    await writeFile(new URL(`${name}-ffmpeg.log`, output), log);
    assert.equal(status, 0, 'Cloud screen recorder did not finish');
  }
}
