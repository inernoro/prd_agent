"""Regression coverage for official Speech streaming WAV responses."""
import importlib.util
import io
from pathlib import Path
import struct
import unittest
import wave


path = Path(__file__).resolve().parents[1] / 'testing-tutorial/batch_official_tts.py'
spec = importlib.util.spec_from_file_location('tutorial_tts', path)
tts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tts)


def fixture(streamed=False):
    output = io.BytesIO()
    with wave.open(output, 'wb') as writer:
        writer.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
        writer.writeframes(b'\x01\x00' * 240)
    body = bytearray(output.getvalue())
    if streamed:
        struct.pack_into('<I', body, 4, 0xffffffff)
        struct.pack_into('<I', body, 40, 0xffffffff)
    return bytes(body)


class SpeechWavTests(unittest.TestCase):
    def test_standard_and_streaming_have_identical_pcm_and_duration(self):
        standard = tts.wav_data(fixture())
        streamed = tts.wav_data(fixture(True))
        self.assertEqual(standard, streamed)
        self.assertEqual(streamed[:2], ((1, 2, 24000), 240))

    def test_declared_length_truncation_remains_rejected(self):
        with self.assertRaisesRegex(ValueError, 'truncated'):
            tts.wav_data(fixture()[:-2])

    def test_partial_streaming_pcm_frame_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'incomplete PCM'):
            tts.wav_data(fixture(True)[:-1])

    def test_empty_streaming_response_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'incomplete PCM'):
            tts.wav_data(fixture(True)[:44])

    def test_riff_marker_alone_does_not_allow_truncation(self):
        body = bytearray(fixture()[:-2])
        struct.pack_into('<I', body, 4, 0xffffffff)
        with self.assertRaisesRegex(ValueError, 'truncated'):
            tts.wav_data(bytes(body))


if __name__ == '__main__':
    unittest.main()
