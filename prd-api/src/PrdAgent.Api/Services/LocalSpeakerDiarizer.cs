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
    private const int LongTurnBoundaryMilliseconds = 800;
    private const double MinimumSpeakerDistance = 0.34;
    private const double MinimumLongTurnSpeakerDistance = 0.18;

    internal sealed record Result(
        IReadOnlyList<SubtitleSegment> Segments,
        int SpeakerCount,
        double Confidence,
        int VoiceTurnCount,
        bool HasDistinctLongTurnEvidence);

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
        var longTurns = CoalesceLongVoiceTurns(turns, audio);
        var longClustering = ClusterSpeakers(
            longTurns,
            audio.SampleRate,
            MinimumLongTurnSpeakerDistance);
        var hasDistinctLongTurnEvidence = longTurns.Count is >= 2 and <= 4
            && longClustering.SpeakerCount == longTurns.Count
            && longClustering.Confidence >= MinimumLongTurnSpeakerDistance;
        if (hasDistinctLongTurnEvidence)
        {
            turns = longTurns;
            clustering = longClustering;
        }
        if (clustering.SpeakerCount < 2)
            return new Result(
                [new SubtitleSegment(
                    turns[0].StartSample / (double)audio!.SampleRate,
                    turns[^1].EndSample / (double)audio.SampleRate,
                    transcript.Trim(),
                    "说话人1")],
                1,
                clustering.Confidence,
                turns.Count,
                hasDistinctLongTurnEvidence);

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

        return new Result(
            aligned,
            distinct,
            clustering.Confidence,
            turns.Count,
            hasDistinctLongTurnEvidence);
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

    private static List<VoiceTurn> CoalesceLongVoiceTurns(
        IReadOnlyList<VoiceTurn> turns,
        WavAudio audio)
    {
        if (turns.Count < 2)
            return turns.ToList();

        var maximumGapSamples = audio.SampleRate * LongTurnBoundaryMilliseconds / 1000;
        var result = new List<VoiceTurn>();
        var groupStart = turns[0].StartSample;
        var groupEnd = turns[0].EndSample;
        for (var index = 1; index < turns.Count; index++)
        {
            var turn = turns[index];
            if (turn.StartSample - groupEnd <= maximumGapSamples)
            {
                groupEnd = turn.EndSample;
                continue;
            }

            result.Add(new VoiceTurn(
                groupStart,
                groupEnd,
                ExtractFeatures(audio.Samples, groupStart, groupEnd, audio.SampleRate)));
            groupStart = turn.StartSample;
            groupEnd = turn.EndSample;
        }
        result.Add(new VoiceTurn(
            groupStart,
            groupEnd,
            ExtractFeatures(audio.Samples, groupStart, groupEnd, audio.SampleRate)));
        return result;
    }

    private static (int[] Labels, int SpeakerCount, double Confidence) ClusterSpeakers(
        IReadOnlyList<VoiceTurn> turns,
        int sampleRate,
        double minimumDistance = MinimumSpeakerDistance)
    {
        if (turns.Count < 2)
            return ([0], 1, 0);

        // 按原始声学距离做平均链接聚类。这里刻意不把音量作为说话人特征：
        // 同一个人在会议中离麦克风远近变化很常见，按每个维度标准化后再做
        // KMeans 会把音量差放大成新角色，并且三段发言时天然偏向 k=2。
        // 平均链接同时利用同一声线的多段证据，只有簇间音高、频谱和过零率
        // 的平均差异达到阈值时才保留为不同角色。
        var clusters = turns
            .Select((_, index) => new List<int> { index })
            .ToList();
        while (clusters.Count > 1)
        {
            var closest = FindClosestClusters(clusters, turns);
            if (closest.Distance >= minimumDistance && clusters.Count <= 4)
                break;

            clusters[closest.Left].AddRange(clusters[closest.Right]);
            clusters.RemoveAt(closest.Right);
        }

        // 极短噪声片段不能单独成为角色；并回最近的稳定声纹簇。
        while (clusters.Count > 1)
        {
            var shortCluster = clusters.FindIndex(cluster => cluster
                .Sum(index => turns[index].DurationSeconds(sampleRate)) < 0.35);
            if (shortCluster < 0)
                break;

            var nearest = Enumerable.Range(0, clusters.Count)
                .Where(index => index != shortCluster)
                .OrderBy(index => AverageClusterDistance(
                    clusters[shortCluster],
                    clusters[index],
                    turns))
                .First();
            var keep = Math.Min(shortCluster, nearest);
            var remove = Math.Max(shortCluster, nearest);
            clusters[keep].AddRange(clusters[remove]);
            clusters.RemoveAt(remove);
        }

        var labels = new int[turns.Count];
        for (var cluster = 0; cluster < clusters.Count; cluster++)
        foreach (var index in clusters[cluster])
            labels[index] = cluster;

        var confidence = clusters.Count == 1
            ? turns.SelectMany((turn, left) => turns
                    .Skip(left + 1)
                    .Select(right => AcousticDistance(turn.Features, right.Features)))
                .DefaultIfEmpty(0)
                .Max()
            : Enumerable.Range(0, clusters.Count)
                .SelectMany(left => Enumerable.Range(left + 1, clusters.Count - left - 1)
                    .Select(right => AverageClusterDistance(clusters[left], clusters[right], turns)))
                .Min();
        return (
            RenumberByFirstAppearance(labels),
            clusters.Count,
            Math.Min(0.95, Math.Max(0, confidence)));
    }

    private static (int Left, int Right, double Distance) FindClosestClusters(
        IReadOnlyList<List<int>> clusters,
        IReadOnlyList<VoiceTurn> turns)
    {
        var best = (Left: 0, Right: 1, Distance: double.MaxValue);
        for (var left = 0; left < clusters.Count - 1; left++)
        for (var right = left + 1; right < clusters.Count; right++)
        {
            var distance = AverageClusterDistance(clusters[left], clusters[right], turns);
            if (distance < best.Distance)
                best = (left, right, distance);
        }
        return best;
    }

    private static double AverageClusterDistance(
        IReadOnlyList<int> left,
        IReadOnlyList<int> right,
        IReadOnlyList<VoiceTurn> turns)
        => left.SelectMany(leftIndex => right.Select(rightIndex => AcousticDistance(
                turns[leftIndex].Features,
                turns[rightIndex].Features)))
            .Average();

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

    private static double AcousticDistance(double[] left, double[] right)
    {
        var pitch = Math.Min(1, Math.Abs(left[0] - right[0]) * 2.5);
        var spectral = Math.Sqrt(left.Skip(3).Zip(right.Skip(3), (a, b) => Math.Pow(a - b, 2)).Sum()) / 5;
        var zeroCrossing = Math.Min(1, Math.Abs(left[1] - right[1]) * 8);
        return pitch * 0.55 + spectral * 0.35 + zeroCrossing * 0.10;
    }

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
