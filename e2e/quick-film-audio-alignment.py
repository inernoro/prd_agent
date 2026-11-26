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
model = WhisperModel(os.environ.get('MAP_QA_WHISPER_MODEL', 'small'), device='cpu', compute_type='int8', cpu_threads=4,
                     download_root=str(runner / 'map-audio-model'))
samples_per_second = 16000
track = decode_audio(str(audio_file), sampling_rate=samples_per_second)
cue_windows = (
    (9.6, 13.5, '架构决策记录', '决策记录'),
    (44.3, 48.8, '组织审查', '审查'),
    (63.0, 68.4, '取代旧记录', '审查通过'),
)
segments, _ = model.transcribe(track, language='zh', beam_size=5, word_timestamps=True,
                               condition_on_previous_text=False, vad_filter=True)
characters = []
timestamps = []
for segment in segments:
    for word in segment.words or []:
        word_characters = normalize(word.word)
        characters.extend(word_characters)
        timestamps.extend([(float(word.start), float(word.end))] * len(word_characters))


def nearest_phrase(phrase, start):
    found = [match.start() for match in re.finditer(re.escape(phrase), ''.join(characters))]
    if not found:
        return None
    match = min(found, key=lambda offset: abs(timestamps[offset][0] - start))
    return [round(timestamps[match][0], 2), round(timestamps[match + len(phrase) - 1][1], 2)]


evidence = []
for cue_number, (start, end, anchor, shorter_anchor) in enumerate(cue_windows, start=1):
    spoken = nearest_phrase(anchor, start)
    aligned = spoken is not None and spoken[0] >= start - 0.35 and spoken[1] <= end + 0.35
    speech_characters = sum(start <= (low + high) / 2.0 <= end for low, high in timestamps)
    evidence.append({'cue': cue_number, 'captionSeconds': [start, end], 'speechSeconds': spoken,
                     'shorterPhraseSeconds': nearest_phrase(shorter_anchor, start),
                     'speechCharactersInWindow': speech_characters, 'aligned': aligned})

print(json.dumps(evidence))
if not all(item['aligned'] for item in evidence):
    raise SystemExit('At least one sampled speech cue could not be verified within the caption window.')
