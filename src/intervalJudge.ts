// 音程判定：纯五度与八度的偏差、拍频计算与合格判定（纯函数，不碰存储与界面）

export type IntervalType = "fifth" | "octave";

export const INTERVAL_DEFS: Record<IntervalType, { ratio: number; label: string; semitones: number }> = {
  fifth: { ratio: 3 / 2, label: "纯五度", semitones: 7 },
  octave: { ratio: 2, label: "八度", semitones: 12 },
};

/** 偏差容忍（音分） */
export const CENT_TOLERANCE = 5;
/** 拍频容忍（Hz），超过即认为拍音可察觉 */
export const BEAT_TOLERANCE_HZ = 1.5;

export interface Judgement {
  deviationCents: number;
  beatHz: number;
  status: "pass" | "fail";
}

/** 实际频率相对期望频率的偏差（音分） */
export function centsDeviation(expected: number, actual: number): number {
  return 1200 * Math.log2(actual / expected);
}

/** 拍频 = 实际频率与期望频率之差的绝对值（Hz） */
export function beatFrequency(expected: number, actual: number): number {
  return Math.abs(actual - expected);
}

/** 以下方管实测频率为基准，判定上方管构成的纯五度 / 八度是否合格 */
export function judgeInterval(type: IntervalType, lowerFreq: number, upperFreq: number): Judgement {
  const expected = lowerFreq * INTERVAL_DEFS[type].ratio;
  const deviationCents = centsDeviation(expected, upperFreq);
  const beatHz = beatFrequency(expected, upperFreq);
  const status =
    Math.abs(deviationCents) <= CENT_TOLERANCE && beatHz <= BEAT_TOLERANCE_HZ ? "pass" : "fail";
  return { deviationCents, beatHz, status };
}

export interface PipeTone {
  id: string;
  venue: string;
  stop: string;
  midi: number;
}

export interface IntervalPair {
  id: string;
  venue: string;
  stop: string;
  type: IntervalType;
  lowerPipeId: string;
  upperPipeId: string;
}

/** 同场馆同音栓内，半音差为 7（纯五度）或 12（八度）的音管两两成对，可跨八度组 */
export function findIntervalPairs(pipes: PipeTone[]): IntervalPair[] {
  const sorted = [...pipes].sort((a, b) => a.midi - b.midi);
  const pairs: IntervalPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const lower = sorted[i];
      const upper = sorted[j];
      if (lower.venue !== upper.venue || lower.stop !== upper.stop) continue;
      const diff = upper.midi - lower.midi;
      const type: IntervalType | null =
        diff === INTERVAL_DEFS.fifth.semitones
          ? "fifth"
          : diff === INTERVAL_DEFS.octave.semitones
            ? "octave"
            : null;
      if (!type) continue;
      pairs.push({
        id: `${lower.id}::${upper.id}`,
        venue: lower.venue,
        stop: lower.stop,
        type,
        lowerPipeId: lower.id,
        upperPipeId: upper.id,
      });
    }
  }
  return pairs;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiToNoteName(midi: number): string {
  return `${NOTE_NAMES[midi % 12]}${midiOctave(midi)}`;
}

export function midiOctave(midi: number): number {
  return Math.floor(midi / 12) - 1;
}
