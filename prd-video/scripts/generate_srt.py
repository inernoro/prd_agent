#!/usr/bin/env python3
"""
SRT 字幕生成脚本
从 video_data.json 中读取场景数据，生成精确对齐的 SRT 字幕文件。

用法:
    python3 generate_srt.py --data ./data/xxx.json --output ./out/xxx.srt
"""

import argparse
import json
import re
import sys
from pathlib import Path


def format_srt_time(seconds: float) -> str:
    """将秒数格式化为 SRT 时间戳 (HH:MM:SS,mmm)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def split_narration(text: str, max_len: int = 20) -> list[str]:
    """按标点将旁白拆分为 <= max_len 字的片段"""
    delimiters = set("。，；！？、.,;!?")
    segments = []
    current = []
    current_len = 0

    for ch in text:
        current.append(ch)
        current_len += 1

        if ch in delimiters and current_len >= 5:
            seg = "".join(current).strip()
            if seg:
                segments.append(seg)
            current = []
            current_len = 0
        elif current_len >= max_len:
            seg = "".join(current).strip()
            if seg:
                segments.append(seg)
            current = []
            current_len = 0

    # 处理剩余文本
    if current:
        remaining = "".join(current).strip()
        if remaining:
            if segments and len(remaining) < 5:
                segments[-1] += remaining
            else:
                segments.append(remaining)

    return [s for s in segments if s.strip()]


def generate_srt(data: dict) -> str:
    """从 video data 生成 SRT 字幕内容"""
    scenes = data.get("scenes", [])
    lines = []
    subtitle_index = 1
    cum_time = 0.0

    for scene in scenes:
        narration = scene.get("narration", "")
        duration = scene.get("durationSeconds", 5.0)

        if not narration.strip():
            cum_time += duration
            continue

        segments = split_narration(narration, 20)
        total_chars = sum(len(s) for s in segments)

        for seg in segments:
            ratio = len(seg) / max(total_chars, 1)
            seg_duration = duration * ratio

            start_ts = format_srt_time(cum_time)
            end_ts = format_srt_time(cum_time + seg_duration)

            lines.append(str(subtitle_index))
            lines.append(f"{start_ts} --> {end_ts}")
            lines.append(seg)
            lines.append("")

            cum_time += seg_duration
            subtitle_index += 1

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Generate SRT subtitles from video data JSON")
    parser.add_argument("--data", required=True, help="Path to video_data.json")
    parser.add_argument("--output", required=True, help="Output SRT file path")
    args = parser.parse_args()

    data_path = Path(args.data)
    if not data_path.exists():
        print(f"Error: Data file not found: {data_path}", file=sys.stderr)
        sys.exit(1)

    with open(data_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    srt_content = generate_srt(data)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(srt_content)

    print(f"SRT generated: {output_path} ({srt_content.count(chr(10)) // 4} subtitles)")


if __name__ == "__main__":
    main()
