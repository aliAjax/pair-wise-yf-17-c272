// 记录保存：音管实测与音程结论的存取、选择性失效和报告签发。
// 数据只存本机（localStorage），不上传任何服务器。

import {
  IntervalKind,
  IntervalPair,
  IntervalVerdict,
  PipeRef,
  absoluteNote,
  intervalPartners,
  judgeInterval,
  pairId,
  pipeKey,
} from "./intervalJudge";

export interface PipeMeasurement extends PipeRef {
  frequency: number;
  measuredAt: string;
}

export interface IntervalConclusion {
  id: string;
  kind: IntervalKind;
  venue: string;
  stop: string;
  lower: PipeRef;
  upper: PipeRef;
  verdict: IntervalVerdict;
  updatedAt: string;
}

export interface MaintenanceReport {
  id: string;
  venue: string;
  stop: string;
  issuedAt: string;
  pipeCount: number;
  passCount: number;
  failCount: number;
}

export interface ReviewState {
  measurements: Record<string, PipeMeasurement>;
  conclusions: Record<string, IntervalConclusion>;
  reports: MaintenanceReport[];
}

export const EMPTY_STATE: ReviewState = {
  measurements: {},
  conclusions: {},
  reports: [],
};

export interface SaveResult {
  state: ReviewState;
  /** 因重测被清掉的旧结论 id */
  cleared: string[];
  /** 依据新频率重算出的结论 id */
  recomputed: string[];
}

/**
 * 录入 / 重测一根音管。
 * 重测时只清掉涉及这根管的复核结论并按新频率重算，
 * 其余音程的结论保持原样、继续有效。
 */
export function saveMeasurement(
  state: ReviewState,
  input: PipeRef & { frequency: number },
  now: Date = new Date()
): SaveResult {
  const key = pipeKey(input);
  const measurement: PipeMeasurement = { ...input, measuredAt: now.toISOString() };
  const measurements = { ...state.measurements, [key]: measurement };
  const conclusions = { ...state.conclusions };

  const cleared: string[] = [];
  for (const [id, c] of Object.entries(conclusions)) {
    if (pipeKey(c.lower) === key || pipeKey(c.upper) === key) {
      delete conclusions[id];
      cleared.push(id);
    }
  }

  const recomputed: string[] = [];
  for (const pair of intervalPartners(input)) {
    const lower = measurements[pipeKey(pair.lower)];
    const upper = measurements[pipeKey(pair.upper)];
    if (!lower || !upper) continue; // 邻管未测，保持待补测
    const id = pairId(pair);
    conclusions[id] = {
      id,
      kind: pair.kind,
      venue: input.venue,
      stop: input.stop,
      lower: pair.lower,
      upper: pair.upper,
      verdict: judgeInterval(pair.kind, lower.frequency, upper.frequency),
      updatedAt: measurement.measuredAt,
    };
    recomputed.push(id);
  }

  return { state: { ...state, measurements, conclusions }, cleared, recomputed };
}

function sortConclusions(list: IntervalConclusion[]): IntervalConclusion[] {
  const score = (c: IntervalConclusion) =>
    absoluteNote(c.lower) + (c.kind === "octave" ? 0.5 : 0);
  return list.sort(
    (a, b) => Number(a.verdict.pass) - Number(b.verdict.pass) || score(a) - score(b)
  );
}

export function pipesFor(state: ReviewState, venue: string, stop: string): PipeMeasurement[] {
  return Object.values(state.measurements)
    .filter((m) => m.venue === venue && m.stop === stop)
    .sort((a, b) => absoluteNote(a) - absoluteNote(b));
}

export function conclusionsFor(
  state: ReviewState,
  venue: string,
  stop: string
): IntervalConclusion[] {
  return sortConclusions(
    Object.values(state.conclusions).filter((c) => c.venue === venue && c.stop === stop)
  );
}

/** 一根管的关联对象：它参与的全部音程结论 */
export function relatedConclusions(state: ReviewState, ref: PipeRef): IntervalConclusion[] {
  const key = pipeKey(ref);
  return sortConclusions(
    Object.values(state.conclusions).filter(
      (c) => pipeKey(c.lower) === key || pipeKey(c.upper) === key
    )
  );
}

/** 邻管尚未测量、暂时无法判定的音程 */
export function pendingPairs(state: ReviewState, venue: string, stop: string): IntervalPair[] {
  const seen = new Set<string>();
  const pending: IntervalPair[] = [];
  for (const pipe of pipesFor(state, venue, stop)) {
    for (const pair of intervalPartners(pipe)) {
      const id = pairId(pair);
      if (seen.has(id)) continue;
      seen.add(id);
      if (!state.conclusions[id]) pending.push(pair);
    }
  }
  return pending;
}

export interface ReportGate {
  pipeCount: number;
  passCount: number;
  fails: IntervalConclusion[];
  pending: IntervalPair[];
  canIssue: boolean;
}

/** 签发门禁：仍有未通过的音程时，单次维护报告不能签发 */
export function reportGate(state: ReviewState, venue: string, stop: string): ReportGate {
  const conclusions = conclusionsFor(state, venue, stop);
  const fails = conclusions.filter((c) => !c.verdict.pass);
  const pending = pendingPairs(state, venue, stop);
  const pipeCount = pipesFor(state, venue, stop).length;
  return {
    pipeCount,
    passCount: conclusions.length - fails.length,
    fails,
    pending,
    canIssue: pipeCount > 0 && fails.length === 0,
  };
}

export function issueReport(
  state: ReviewState,
  venue: string,
  stop: string,
  now: Date = new Date()
): { state: ReviewState; report: MaintenanceReport } | null {
  const gate = reportGate(state, venue, stop);
  if (!gate.canIssue) return null;
  const report: MaintenanceReport = {
    id: `R-${now.getTime()}`,
    venue,
    stop,
    issuedAt: now.toISOString(),
    pipeCount: gate.pipeCount,
    passCount: gate.passCount,
    failCount: gate.fails.length,
  };
  return { state: { ...state, reports: [report, ...state.reports] }, report };
}

const STORAGE_KEY = "organ-interval-review-v1";

export function loadState(): ReviewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw) as ReviewState;
    if (!parsed.measurements || !parsed.conclusions || !Array.isArray(parsed.reports)) {
      return seedState();
    }
    return parsed;
  } catch {
    return seedState();
  }
}

export function persistState(state: ReviewState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 本机存储不可用时静默失败，页面仍可使用当前会话数据
  }
}

export function resetState(): ReviewState {
  const seeded = seedState();
  persistState(seeded);
  return seeded;
}

/** 十二平均律频率（A4 = 440Hz）加音分偏移，用于示例数据 */
function etFrequency(midi: number, centsOffset: number): number {
  const hz = 440 * Math.pow(2, (midi - 69) / 12);
  return Math.round(hz * Math.pow(2, centsOffset / 1200) * 100) / 100;
}

/** [场馆, 音栓, MIDI 音高, 音分偏移]；St.Mary 的 G4 偏高 12¢，用于演示超限与重测 */
const SEED_ROWS: Array<[string, string, number, number]> = [
  ["St.Mary 教堂", "Principal 8'", 60, 2],
  ["St.Mary 教堂", "Principal 8'", 61, -1],
  ["St.Mary 教堂", "Principal 8'", 62, 1],
  ["St.Mary 教堂", "Principal 8'", 63, 0],
  ["St.Mary 教堂", "Principal 8'", 64, -2],
  ["St.Mary 教堂", "Principal 8'", 65, 1],
  ["St.Mary 教堂", "Principal 8'", 66, 0],
  ["St.Mary 教堂", "Principal 8'", 67, 12],
  ["St.Mary 教堂", "Principal 8'", 68, 1],
  ["St.Mary 教堂", "Principal 8'", 69, 0],
  ["St.Mary 教堂", "Principal 8'", 70, -1],
  ["St.Mary 教堂", "Principal 8'", 71, -1],
  ["St.Mary 教堂", "Principal 8'", 72, 2],
  ["St.Mary 教堂", "Principal 8'", 73, -1],
  ["St.Mary 教堂", "Principal 8'", 74, 1],
  ["St.Mary 教堂", "Principal 8'", 75, 0],
  ["St.Mary 教堂", "Principal 8'", 76, -1],
  ["St.Mary 教堂", "Principal 8'", 77, 1],
  ["St.Mary 教堂", "Principal 8'", 78, 0],
  ["St.Mary 教堂", "Principal 8'", 79, 1],
  ["ConcertHall A", "Principal 4'", 60, 0],
  ["ConcertHall A", "Principal 4'", 61, 1],
  ["ConcertHall A", "Principal 4'", 62, -1],
  ["ConcertHall A", "Principal 4'", 63, 0],
  ["ConcertHall A", "Principal 4'", 64, 1],
  ["ConcertHall A", "Principal 4'", 65, 0],
  ["ConcertHall A", "Principal 4'", 66, -1],
  ["ConcertHall A", "Principal 4'", 67, 1],
  ["ConcertHall A", "Principal 4'", 72, 0],
  ["ConcertHall A", "Principal 4'", 73, 1],
  ["ConcertHall A", "Principal 4'", 74, -1],
  ["ConcertHall A", "Principal 4'", 75, 0],
  ["ConcertHall A", "Principal 4'", 76, 1],
  ["Abbey Room", "Bourdon 16'", 36, 1],
  ["Abbey Room", "Bourdon 16'", 38, 0],
  ["Abbey Room", "Bourdon 16'", 40, -1],
  ["Abbey Room", "Bourdon 16'", 41, 2],
  ["Abbey Room", "Bourdon 16'", 43, 1],
  ["Abbey Room", "Bourdon 16'", 48, 1],
];

export function seedState(): ReviewState {
  let state: ReviewState = EMPTY_STATE;
  SEED_ROWS.forEach(([venue, stop, midi, cents], i) => {
    const at = new Date(Date.UTC(2026, 8, 24, 9, 0) + i * 60_000);
    state = saveMeasurement(
      state,
      {
        venue,
        stop,
        octave: Math.floor(midi / 12) - 1,
        note: midi % 12,
        frequency: etFrequency(midi, cents),
      },
      at
    ).state;
  });
  return state;
}
