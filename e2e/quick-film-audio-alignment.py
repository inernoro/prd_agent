import json
import os
import re
from pathlib import Path

from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio


def normalize(text):
    simplified = text.translate(str.maketrans('構決錄織審舊組記紀', '构决录织审旧组记记'))
    return re.sub(r'[^\w\u3400-\u9fff]', '', simplified)


runner = Path(os.environ['RUNNER_TEMP'])
audio_file = runner / 'map-accepted-film.mp4'
model = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=4,
                     download_root=str(runner / 'map-audio-model'))
samples_per_second = 16000
track = decode_audio(str(audio_file), sampling_rate=samples_per_second)
cue_windows = (
    (9.6, 13.5, '架构决策记录'),
    (44.3, 48.8, '组织审查'),
    (63.0, 68.4, '取代旧记录'),
)
evidence = []
for cue_number, (start, end, anchor) in enumerate(cue_windows, start=1):
    excerpt_start = start - 0.8
    excerpt_end = end + 0.8
    excerpt = track[round(excerpt_start * samples_per_second):round(excerpt_end * samples_per_second)]
    segments, _ = model.transcribe(excerpt, language='zh', beam_size=5, word_timestamps=True,
                                   condition_on_previous_text=False)
    characters = []
    timestamps = []
    for segment in segments:
        for word in segment.words or []:
            word_characters = normalize(word.word)
            characters.extend(word_characters)
            timestamps.extend([(word.start + excerpt_start, word.end + excerpt_start)] * len(word_characters))
    match = ''.join(characters).find(anchor)
    found = match >= 0
    actual_start = round(timestamps[match][0], 2) if found else None
    actual_end = round(timestamps[match + len(anchor) - 1][1], 2) if found else None
    aligned = found and actual_start >= start - 0.35 and actual_end <= end + 0.35
    evidence.append({'cue': cue_number, 'captionSeconds': [start, end], 'anchorFound': found,
                     'speechSeconds': [actual_start, actual_end], 'aligned': aligned})

print(json.dumps(evidence))
if not all(item['aligned'] for item in evidence):
    raise SystemExit('At least one sampled speech cue could not be verified within the caption window.')
