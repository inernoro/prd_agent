using System.Buffers.Binary;
using System.Text;

namespace PrdAgent.Api.Services;

/// <summary>
/// 当上游 ASR 没有返回 speaker 字段时，用规范化 WAV 的声学特征做保守兜底。
/// 只在检测到明显不同的声纹簇时输出多个说话人；不确定时保持单一说话人，
/// 避免用交替编号伪造角色。
/// </summary>
internal static class LocalSpeakerDiarizer
{
    private const int FrameMilliseconds = 20;
    private const int MinimumSpeechMilliseconds = 260;
    private const int SplitSilenceMilliseconds = 220;
    private const double MinimumSpeakerDistance = 0.34;
    private const double MinimumClusterSilhouette = 0.18;

    internal sealed record Result(
        IReadOnlyList<SubtitleSegment> Segments,
        int SpeakerCount,
        double Confidence,
        int VoiceTurnCount);

    private sealed record WavAudio(short[] Samples, int SampleRate);
    private sealed record VoiceTurn(int StartSample, int EndSample, double[] Features)
    {
        public double DurationSeconds(int sampleRate) => (EndSample - StartSample) / (double)sampleRate;
    }

    public static Result? TryDiarize(byte[] wavBytes, string transcript)
    {
        if (string.IsNullOrWhiteSpace(transcript) || !TryReadPcm16Mono(wavBytes, out var audio))
            return null;

        var turns = DetectVoiceTurns(audio!);
        if (turns.Count == 0)
            return null;

        var clustering = ClusterSpeakers(turns, audio!.SampleRate);
        if (clustering.SpeakerCount < 2)
            return new Result(
                [new SubtitleSegment(
                    turns[0].StartSample / (double)audio!.SampleRate,
                    turns[^1].EndSample / (double)audio.SampleRate,
                    transcript.Trim(),
                    "说话人1")],
                1,
                clustering.Confidence,
                turns.Count);

        var clauses = SplitClauses(transcript);
        if (clauses.Count == 0)
            return null;

        var aligned = RenumberSegmentsByFirstAppearance(
            AlignClausesToTurns(clauses, turns, clustering.Labels, audio!.SampleRate));
        var distinct = aligned
            .Select(segment => segment.SpeakerId)
            .Where(speaker => !string.IsNullOrWhiteSpace(speaker))
            .Distinct(StringComparer.Ordinal)
            .Count();
        if (distinct < 2)
            return null;

        return new Result(aligned, distinct, clustering.Confidence, turns.Count);
    }

    private static bool TryReadPcm16Mono(byte[] bytes, out WavAudio? audio)
    {
        audio = null;
        if (bytes.Length < 44
            || Encoding.ASCII.GetString(bytes, 0, 4) != "RIFF"
            || Encoding.ASCII.GetString(bytes, 8, 4) != "WAVE")
            return false;

        var offset = 12;
        ushort format = 0;
        ushort channels = 0;
        ushort bitsPerSample = 0;
        var sampleRate = 0;
        ReadOnlySpan<byte> pcm = default;
        while (offset + 8 <= bytes.Length)
        {
            var chunkId = Encoding.ASCII.GetString(bytes, offset, 4);
            var size = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset + 4, 4));
            if (size < 0 || offset + 8L + size > bytes.Length)
                return false;
            var content = bytes.AsSpan(offset + 8, size);
            if (chunkId == "fmt " && size >= 16)
            {
                format = BinaryPrimitives.ReadUInt16LittleEndian(content[..2]);
                channels = BinaryPrimitives.ReadUInt16LittleEndian(content.Slice(2, 2));
                sampleRate = BinaryPrimitives.ReadInt32LittleEndian(content.Slice(4, 4));
                bitsPerSample = BinaryPrimitives.ReadUInt16LittleEndian(content.Slice(14, 2));
            }
            else if (chunkId == "data")
            {
                pcm = content;
            }
            offset += 8 + size + (size & 1);
        }

        if (format != 1 || channels is < 1 or > 8 || bitsPerSample != 16 || sampleRate is < 8000 or > 96000 || pcm.IsEmpty)
            return false;

        var frameCount = pcm.Length / (2 * channels);
        if (frameCount < sampleRate / 2)
            return false;
        var samples = new short[frameCount];
        for (var frame = 0; frame < frameCount; frame++)
        {
            var sum = 0;
            for (var channel = 0; channel < channels; channel++)
            {
                var index = (frame * channels + channel) * 2;
                sum += BinaryPrimitives.ReadInt16LittleEndian(pcm.Slice(index, 2));
            }
            samples[frame] = (short)(sum / channels);
        }
        audio = new WavAudio(samples, sampleRate);
        return true;
    }

    private static List<VoiceTurn> DetectVoiceTurns(WavAudio audio)
    {
        var frameSize = Math.Max(1, audio.SampleRate * FrameMilliseconds / 1000);
        var rms = new List<double>();
        for (var start = 0; start < audio.Samples.Length; start += frameSize)
        {
            var end = Math.Min(audio.Samples.Length, start + frameSize);
            double energy = 0;
            for (var i = start; i < end; i++)
                energy += (double)audio.Samples[i] * audio.Samples[i];
            rms.Add(Math.Sqrt(energy / Math.Max(1, end - start)));
        }
        if (rms.Count == 0)
            return [];

        var ordered = rms.OrderBy(value => value).ToArray();
        var noise = Percentile(ordered, 0.20);
        var strong = Percentile(ordered, 0.90);
        var threshold = Math.Max(180, noise + Math.Max(120, (strong - noise) * 0.16));
        if (strong < threshold)
            return [];

        var speech = rms.Select(value => value >= threshold).ToArray();
        var bridgeFrames = Math.Max(1, SplitSilenceMilliseconds / FrameMilliseconds);
        for (var i = 0; i < speech.Length;)
        {
            if (speech[i])
            {
                i++;
                continue;
            }
            var start = i;
            while (i < speech.Length && !speech[i]) i++;
            if (start > 0 && i < speech.Length && i - start < bridgeFrames)
                Array.Fill(speech, true, start, i - start);
        }

        var minimumFrames = Math.Max(1, MinimumSpeechMilliseconds / FrameMilliseconds);
        var turns = new List<VoiceTurn>();
        for (var i = 0; i < speech.Length;)
        {
            if (!speech[i])
            {
                i++;
                continue;
            }
            var startFrame = i;
            while (i < speech.Length && speech[i]) i++;
            if (i - startFrame < minimumFrames)
                continue;
            var startSample = startFrame * frameSize;
            var endSample = Math.Min(audio.Samples.Length, i * frameSize);
            turns.Add(new VoiceTurn(
                startSample,
                endSample,
                ExtractFeatures(audio.Samples, startSample, endSample, audio.SampleRate)));
        }
        return turns;
    }

    private static (int[] Labels, int SpeakerCount, double Confidence) ClusterSpeakers(
        IReadOnlyList<VoiceTurn> turns,
        int sampleRate)
    {
        if (turns.Count < 2)
            return ([0], 1, 0);

        if (turns.Count == 2)
        {
            var rawDistance = AcousticDistance(turns[0].Features, turns[1].Features);
            return rawDistance >= MinimumSpeakerDistance
                ? ([0, 1], 2, Math.Min(0.9, rawDistance))
                : ([0, 0], 1, Math.Max(0, rawDistance));
        }

        var normalized = Normalize(turns.Select(turn => turn.Features).ToArray());
        var maxK = Math.Min(4, turns.Count);
        (int[] Labels, int K, double Score)? best = null;
        for (var k = 2; k <= maxK; k++)
        {
            var labels = KMeans(normalized, k);
            if (labels.Distinct().Count() != k)
                continue;
            var score = Silhouette(normalized, labels, k);
            var minimumDuration = Enumerable.Range(0, k)
                .Min(cluster => turns.Where((_, index) => labels[index] == cluster)
                    .Sum(turn => turn.DurationSeconds(sampleRate)));
            if (minimumDuration < 0.35)
                continue;
            if (best is null || score > best.Value.Score + 0.08)
                best = (labels, k, score);
        }

        if (best is null)
        {
            var rawDistance = AcousticDistance(turns[0].Features, turns[1].Features);
            return (new int[turns.Count], 1, Math.Max(0, rawDistance));
        }

        if (best.Value.Score < MinimumClusterSilhouette)
            return (new int[turns.Count], 1, Math.Max(0, best.Value.Score));

        return (RenumberByFirstAppearance(best.Value.Labels), best.Value.K, Math.Min(0.95, best.Value.Score));
    }

    private static double[] ExtractFeatures(short[] samples, int start, int end, int sampleRate)
    {
        var length = Math.Max(1, end - start);
        double energy = 0;
        var crossings = 0;
        for (var i = start; i < end; i++)
        {
            var sample = samples[i] / 32768d;
            energy += sample * sample;
            if (i > start && (samples[i - 1] < 0) != (samples[i] < 0)) crossings++;
        }
        var pitch = EstimatePitch(samples, start, end, sampleRate);
        var bandFrequencies = new[] { 150d, 300d, 600d, 1200d, 2400d, 3600d };
        var bands = bandFrequencies.Select(frequency => GoertzelEnergy(samples, start, end, sampleRate, frequency)).ToArray();
        var bandTotal = bands.Sum() + 1e-12;
        return
        [
            pitch / 300d,
            crossings / (double)length,
            Math.Sqrt(energy / length),
            .. bands.Select(value => Math.Log10(1e-9 + value / bandTotal)),
        ];
    }

    private static double EstimatePitch(short[] samples, int start, int end, int sampleRate)
    {
        var frameSize = Math.Max(160, sampleRate * 40 / 1000);
        var hop = Math.Max(80, sampleRate * 20 / 1000);
        if (end - start < frameSize)
            return 0;
        const int maximumPitchFrames = 24;
        var availableFrames = Math.Max(1, (end - start - frameSize) / hop + 1);
        var frameStride = hop * Math.Max(1, (int)Math.Ceiling(availableFrames / (double)maximumPitchFrames));
        var minLag = Math.Max(1, sampleRate / 420);
        var maxLag = Math.Min(frameSize / 2, sampleRate / 70);
        var pitches = new List<double>();
        for (var offset = start; offset + frameSize <= end; offset += frameStride)
        {
            double frameEnergy = 0;
            for (var i = 0; i < frameSize; i++)
                frameEnergy += samples[offset + i] * (double)samples[offset + i];
            if (Math.Sqrt(frameEnergy / frameSize) < 240)
                continue;

            var bestLag = 0;
            var best = 0d;
            for (var lag = minLag; lag <= maxLag; lag++)
            {
                double correlation = 0;
                double leftEnergy = 0;
                double rightEnergy = 0;
                for (var i = 0; i < frameSize - lag; i++)
                {
                    var left = samples[offset + i];
                    var right = samples[offset + i + lag];
                    correlation += left * (double)right;
                    leftEnergy += left * (double)left;
                    rightEnergy += right * (double)right;
                }
                var normalized = correlation / Math.Sqrt(Math.Max(1, leftEnergy * rightEnergy));
                if (normalized > best)
                {
                    best = normalized;
                    bestLag = lag;
                }
            }
            if (best >= 0.32 && bestLag > 0)
                pitches.Add(sampleRate / (double)bestLag);
        }
        if (pitches.Count == 0)
            return 0;
        pitches.Sort();
        return pitches[pitches.Count / 2];
    }

    private static double GoertzelEnergy(short[] samples, int start, int end, int sampleRate, double frequency)
    {
        var step = Math.Max(1, (end - start) / 12000);
        var omega = 2 * Math.PI * frequency / sampleRate * step;
        var coefficient = 2 * Math.Cos(omega);
        var previous = 0d;
        var previous2 = 0d;
        for (var i = start; i < end; i += step)
        {
            var current = samples[i] / 32768d + coefficient * previous - previous2;
            previous2 = previous;
            previous = current;
        }
        return Math.Max(0, previous2 * previous2 + previous * previous - coefficient * previous * previous2);
    }

    private static double[][] Normalize(double[][] values)
    {
        var dimensions = values[0].Length;
        var means = new double[dimensions];
        var scales = new double[dimensions];
        for (var d = 0; d < dimensions; d++)
        {
            means[d] = values.Average(value => value[d]);
            scales[d] = Math.Sqrt(values.Average(value => Math.Pow(value[d] - means[d], 2)));
            if (scales[d] < 1e-6) scales[d] = 1;
        }
        return values.Select(value => value.Select((item, d) => (item - means[d]) / scales[d]).ToArray()).ToArray();
    }

    private static int[] KMeans(double[][] values, int k)
    {
        var centroids = new List<double[]> { values[0].ToArray() };
        while (centroids.Count < k)
        {
            var next = values
                .Select((value, index) => new { index, distance = centroids.Min(center => Distance(value, center)) })
                .OrderByDescending(item => item.distance)
                .ThenBy(item => item.index)
                .First();
            centroids.Add(values[next.index].ToArray());
        }

        var labels = new int[values.Length];
        for (var iteration = 0; iteration < 30; iteration++)
        {
            var changed = false;
            for (var i = 0; i < values.Length; i++)
            {
                var label = Enumerable.Range(0, k)
                    .OrderBy(cluster => Distance(values[i], centroids[cluster]))
                    .First();
                if (label != labels[i])
                {
                    labels[i] = label;
                    changed = true;
                }
            }
            for (var cluster = 0; cluster < k; cluster++)
            {
                var members = values.Where((_, index) => labels[index] == cluster).ToArray();
                if (members.Length == 0) continue;
                centroids[cluster] = Enumerable.Range(0, values[0].Length)
                    .Select(d => members.Average(member => member[d]))
                    .ToArray();
            }
            if (!changed) break;
        }
        return labels;
    }

    private static double Silhouette(double[][] values, int[] labels, int k)
    {
        if (values.Length <= k)
            return 0;
        var scores = new List<double>();
        for (var i = 0; i < values.Length; i++)
        {
            var own = values.Where((_, index) => index != i && labels[index] == labels[i]).ToArray();
            if (own.Length == 0)
                continue;
            var a = own.Average(value => Distance(values[i], value));
            var b = Enumerable.Range(0, k)
                .Where(cluster => cluster != labels[i] && labels.Contains(cluster))
                .Min(cluster => values.Where((_, index) => labels[index] == cluster)
                    .Average(value => Distance(values[i], value)));
            scores.Add((b - a) / Math.Max(a, b));
        }
        return scores.Count == 0 ? 0 : scores.Average();
    }

    private static double AcousticDistance(double[] left, double[] right)
    {
        var pitch = Math.Min(1, Math.Abs(left[0] - right[0]) * 2.5);
        var spectral = Math.Sqrt(left.Skip(3).Zip(right.Skip(3), (a, b) => Math.Pow(a - b, 2)).Sum()) / 5;
        var zeroCrossing = Math.Min(1, Math.Abs(left[1] - right[1]) * 8);
        return pitch * 0.55 + spectral * 0.35 + zeroCrossing * 0.10;
    }

    private static double Distance(double[] left, double[] right)
        => Math.Sqrt(left.Zip(right, (a, b) => Math.Pow(a - b, 2)).Sum());

    private static int[] RenumberByFirstAppearance(int[] labels)
    {
        var map = new Dictionary<int, int>();
        var next = 0;
        return labels.Select(label =>
        {
            if (!map.TryGetValue(label, out var normalized))
            {
                normalized = next++;
                map[label] = normalized;
            }
            return normalized;
        }).ToArray();
    }

    private static List<SubtitleSegment> RenumberSegmentsByFirstAppearance(
        IReadOnlyList<SubtitleSegment> segments)
    {
        var speakerMap = new Dictionary<string, string>(StringComparer.Ordinal);
        var next = 1;
        return segments.Select(segment =>
        {
            var source = string.IsNullOrWhiteSpace(segment.SpeakerId)
                ? "说话人1"
                : segment.SpeakerId;
            if (!speakerMap.TryGetValue(source, out var normalized))
            {
                normalized = $"说话人{next++}";
                speakerMap[source] = normalized;
            }
            return segment with { SpeakerId = normalized };
        }).ToList();
    }

    private static List<string> SplitClauses(string transcript)
    {
        var clauses = new List<string>();
        var current = new StringBuilder();
        foreach (var character in transcript.Trim())
        {
            current.Append(character);
            if (character is '。' or '！' or '？' or '；' or '!' or '?' or ';' or '\n')
            {
                var clause = current.ToString().Trim();
                if (clause.Length > 0) clauses.Add(clause);
                current.Clear();
            }
        }
        if (current.Length > 0)
            clauses.Add(current.ToString().Trim());
        return clauses;
    }

    private static List<SubtitleSegment> AlignClausesToTurns(
        IReadOnlyList<string> clauses,
        IReadOnlyList<VoiceTurn> turns,
        IReadOnlyList<int> labels,
        int sampleRate)
    {
        var totalCharacters = Math.Max(1, clauses.Sum(clause => clause.Length));
        var durations = turns.Select(turn => turn.DurationSeconds(sampleRate)).ToArray();
        var totalDuration = durations.Sum();
        var raw = new List<SubtitleSegment>();
        var consumedCharacters = 0;
        foreach (var clause in clauses)
        {
            var midpoint = (consumedCharacters + clause.Length / 2d) / totalCharacters;
            consumedCharacters += clause.Length;
            var target = midpoint * totalDuration;
            var cumulative = 0d;
            var turnIndex = turns.Count - 1;
            for (var i = 0; i < turns.Count; i++)
            {
                cumulative += durations[i];
                if (target <= cumulative)
                {
                    turnIndex = i;
                    break;
                }
            }
            var turn = turns[turnIndex];
            raw.Add(new SubtitleSegment(
                turn.StartSample / (double)sampleRate,
                turn.EndSample / (double)sampleRate,
                clause,
                $"说话人{labels[turnIndex] + 1}"));
        }

        var merged = new List<SubtitleSegment>();
        foreach (var segment in raw)
        {
            if (merged.Count > 0 && string.Equals(merged[^1].SpeakerId, segment.SpeakerId, StringComparison.Ordinal))
            {
                var previous = merged[^1];
                merged[^1] = previous with
                {
                    EndSec = Math.Max(previous.EndSec, segment.EndSec),
                    Text = previous.Text + segment.Text,
                };
            }
            else
            {
                merged.Add(segment);
            }
        }
        return merged;
    }

    private static double Percentile(double[] sorted, double percentile)
    {
        if (sorted.Length == 0) return 0;
        var index = Math.Clamp((int)Math.Round((sorted.Length - 1) * percentile), 0, sorted.Length - 1);
        return sorted[index];
    }
}
