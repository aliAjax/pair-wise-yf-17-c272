// 音程判定：根据两根音管的实测频率，判定纯五度 / 八度是否合格。
// 判定依据两条：相对纯律频率比的音分偏差，以及共有泛音产生的拍频。

export type IntervalKind = "fifth" | "octave";

export const INTERVAL_KINDS: IntervalKind[] = ["fifth", "octave"];

export const INTERVAL_LABEL: Record<IntervalKind, string> = {
  fifth: "纯五度",
  octave: "八度",
};

/** 纯律频率比：纯五度 3:2，八度 2:1 */
export const INTERVAL_RATIO: Record<IntervalKind, number> = {
  fifth: 3 / 2,
  octave: 2,
};

export interface IntervalThreshold {
  /** 允许的最大音分偏差（绝对值，单位 ¢） */
  maxCents: number;
  /** 拍频的绝对下限容忍（Hz），低于该值一律可接受 */
  maxBeatHz: number;
  /** 拍频相对共有泛音频率的容忍比例；实际限值取 max(maxBeatHz, 泛音频率 × beatRatio)，
   *  因为同样的音分偏差在高音区产生的拍频天然更快 */
  beatRatio: number;
}

/** 默认判定阈值，可按场馆习惯调整 */
export const INTERVAL_THRESHOLDS: Record<IntervalKind, IntervalThreshold> = {
  fifth: { maxCents: 6, maxBeatHz: 1.0, beatRatio: 0.003 },
  octave: { maxCents: 4, maxBeatHz: 0.8, beatRatio: 0.0025 },
};

export interface PipeRef {
  venue: string;
  stop: string;
  octave: number;
  /** 八度内半音序号 0-11，0 = C */
  note: number;
}

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function pipeKey(ref: PipeRef): string {
  return [ref.venue, ref.stop, ref.octave, ref.note].join("|");
}

export function pipeLabel(ref: PipeRef): string {
  return `${NOTE_NAMES[ref.note] ?? "?"}${ref.octave}`;
}

/** 绝对半音数，用于比较两根管谁低谁高 */
export function absoluteNote(ref: PipeRef): number {
  return ref.octave * 12 + ref.note;
}

export interface IntervalPair {
  kind: IntervalKind;
  lower: PipeRef;
  upper: PipeRef;
}

function shiftNote(ref: PipeRef, semitones: number): PipeRef {
  const abs = absoluteNote(ref) + semitones;
  return {
    venue: ref.venue,
    stop: ref.stop,
    octave: Math.floor(abs / 12),
    note: ((abs % 12) + 12) % 12,
  };
}

/** 列出一根管参与的全部音程配对（作为低音与作为高音各两条） */
export function intervalPartners(ref: PipeRef): IntervalPair[] {
  return [
    { kind: "fifth", lower: ref, upper: shiftNote(ref, 7) },
    { kind: "octave", lower: ref, upper: shiftNote(ref, 12) },
    { kind: "fifth", lower: shiftNote(ref, -7), upper: ref },
    { kind: "octave", lower: shiftNote(ref, -12), upper: ref },
  ];
}

export function pairId(pair: IntervalPair): string {
  return `${pair.kind}:${pipeKey(pair.lower)}->${pipeKey(pair.upper)}`;
}

/** 实际频率比相对期望频率比的音分偏差（带符号） */
export function deviationCents(actualRatio: number, expectedRatio: number): number {
  return 1200 * Math.log2(actualRatio / expectedRatio);
}

/**
 * 拍频取自两音共有泛音的频率差：
 * 纯五度 3:2 → 低音第 3 泛音 vs 高音第 2 泛音
 * 八度   2:1 → 低音第 2 泛音 vs 高音基频
 */
export function beatFrequency(kind: IntervalKind, lowerHz: number, upperHz: number): number {
  return kind === "fifth"
    ? Math.abs(3 * lowerHz - 2 * upperHz)
    : Math.abs(2 * lowerHz - upperHz);
}

/** 共有泛音频率：纯五度为低音第 3 泛音，八度为低音第 2 泛音 */
export function coincidentPartial(kind: IntervalKind, lowerHz: number): number {
  return kind === "fifth" ? 3 * lowerHz : 2 * lowerHz;
}

/** 实际拍频限值：绝对下限与泛音比例限值取大者 */
export function beatLimit(
  kind: IntervalKind,
  lowerHz: number,
  threshold: IntervalThreshold = INTERVAL_THRESHOLDS[kind]
): number {
  return Math.max(threshold.maxBeatHz, coincidentPartial(kind, lowerHz) * threshold.beatRatio);
}

export interface IntervalVerdict {
  kind: IntervalKind;
  expectedRatio: number;
  actualRatio: number;
  deviationCents: number;
  beatHz: number;
  pass: boolean;
  reasons: string[];
}

export function judgeInterval(
  kind: IntervalKind,
  lowerHz: number,
  upperHz: number,
  threshold: IntervalThreshold = INTERVAL_THRESHOLDS[kind]
): IntervalVerdict {
  const expectedRatio = INTERVAL_RATIO[kind];
  const actualRatio = upperHz / lowerHz;
  const cents = deviationCents(actualRatio, expectedRatio);
  const beat = beatFrequency(kind, lowerHz, upperHz);
  const beatMax = beatLimit(kind, lowerHz, threshold);
  const reasons: string[] = [];
  if (Math.abs(cents) > threshold.maxCents) {
    reasons.push(`音分偏差 ${cents.toFixed(1)}¢ 超出 ±${threshold.maxCents}¢`);
  }
  if (beat > beatMax) {
    reasons.push(`拍频 ${beat.toFixed(2)}Hz 超出限值 ${beatMax.toFixed(2)}Hz`);
  }
  return {
    kind,
    expectedRatio,
    actualRatio,
    deviationCents: cents,
    beatHz: beat,
    pass: reasons.length === 0,
    reasons,
  };
}
