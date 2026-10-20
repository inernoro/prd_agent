#!/usr/bin/env python3
"""
按剪辑表把原曲剪成片花配乐。

用法（在 prd-admin 目录下）：
    python3 scripts/film/build-score.py <原曲.mp3>
输出：public/film/landing-score.mp3（MP3 192k，与片长逐样本对齐）
为什么是 MP3 而不是 AAC：开源版 Chromium（及以它为内核的一部分浏览器）不带 AAC 解码器，
decodeAudioData 直接报 EncodingError；MP3 在所有主流浏览器都解得开，且 Chromium 实测会按
LAME 头裁掉编码延迟，解出来的起点与原始波形偏差 0 毫秒。

剪辑表是 src/pages/home/film/scoreEdit.json——片子的时间轴也从那里读拍速，
所以这里剪出来的每一个剪接点，都正好落在画面的一次切镜上（守卫测试盯着这件事）。

剪法：每一段按「第几小节开始、剪几小节」从原曲截取，两段之间做 40ms 等功率交叉淡化，
淡化中心正好压在小节线上，拼好后总长 = 小节数 × 小节长；最后 1.6 秒淡出。
依赖：numpy；ffmpeg 优先用 PATH 上的，退到 python 包 imageio-ffmpeg 自带的静态版。
"""
import json
import os
import shutil
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
EDIT = os.path.join(ROOT, 'src', 'pages', 'home', 'film', 'scoreEdit.json')
OUT = os.path.join(ROOT, 'public', 'film', 'landing-score.mp3')
SR = 48000
XFADE = 0.04
FADE_OUT = 1.6


def ffmpeg_bin() -> str:
    found = shutil.which('ffmpeg')
    if found:
        return found
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit('找不到 ffmpeg：装一个，或 `pip install imageio-ffmpeg`')


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    edit = json.load(open(EDIT, encoding='utf-8'))
    bpm = edit['source']['bpm']
    first = edit['source']['firstDownbeat']
    bar = 240.0 / bpm
    ff = ffmpeg_bin()

    raw = subprocess.run(
        [ff, '-hide_banner', '-loglevel', 'error', '-i', src, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
        check=True,
        capture_output=True,
    ).stdout
    song = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)

    total_bars = sum(s['bars'] for s in edit['segments'])
    total = int(round(total_bars * bar * SR))
    out = np.zeros((total, 2), dtype=np.float32)
    half = int(XFADE * SR / 2)
    film_bar = 0
    for i, seg in enumerate(edit['segments']):
        # 在原曲里多截出半个淡化长度，两头与相邻段重叠
        a = int(round((first + seg['songBar'] * bar) * SR))
        n = int(round(seg['bars'] * bar * SR))
        pre = half if i > 0 else 0
        post = half if i < len(edit['segments']) - 1 else 0
        piece = song[max(0, a - pre): a + n + post].copy()
        if len(piece) < n + pre + post:
            piece = np.pad(piece, ((0, n + pre + post - len(piece)), (0, 0)))
        # 等功率淡入淡出，只作用在重叠的那一小段
        if pre:
            ramp = np.sin(np.linspace(0, np.pi / 2, 2 * pre))[:, None]
            piece[: 2 * pre] *= ramp
        if post:
            ramp = np.cos(np.linspace(0, np.pi / 2, 2 * post))[:, None]
            piece[-2 * post:] *= ramp
        at = int(round(film_bar * bar * SR)) - pre
        lo = max(0, at)
        hi = min(total, at + len(piece))
        out[lo:hi] += piece[lo - at: hi - at]
        print(f'  段 {i + 1}: 原曲第 {seg["songBar"]:>2} 小节起 {seg["bars"]:>2} 小节 -> 片子第 {film_bar:>2} 小节  {seg["role"]}')
        film_bar += seg['bars']

    fade = int(FADE_OUT * SR)
    out[-fade:] *= np.linspace(1, 0, fade)[:, None]
    peak = float(np.abs(out).max())
    if peak > 0.98:
        out *= 0.98 / peak

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    subprocess.run(
        [ff, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-i', '-',
         '-c:a', 'libmp3lame', '-b:a', '192k', OUT],
        input=out.tobytes(),
        check=True,
    )
    print(f'完成：{OUT}（{total_bars} 小节，{total / SR:.3f} 秒，峰值 {peak:.3f}）')


if __name__ == '__main__':
    main()
