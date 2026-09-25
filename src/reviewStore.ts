// 记录保存：复核数据只存本机 localStorage，负责重测失效、结论写入与报告签发
import { findIntervalPairs, judgeInterval, midiOctave, midiToNoteName } from "./intervalJudge";
import type { IntervalType, Judgement } from "./intervalJudge";

export interface PipeRecord {
  id: string;
  venue: string;
  stop: string;
  midi: number;
  note: string;
  octave: number;
  measuredFreq: number | null;
  measuredAt: string | null;
}

export interface Conclusion {
  status: "pass" | "fail";
  deviationCents: number;
  beatHz: number;
  reviewedAt: string;
}

export interface IntervalRecord {
  id: string;
  venue: string;
  stop: string;
  type: IntervalType;
  lowerPipeId: string;
  upperPipeId: string;
  /** 当前复核结论 */
  conclusion: Conclusion | null;
  /** 上次结论（重测失效或重新复核后仍保留） */
  lastConclusion: Conclusion | null;
}

export interface ReportRecord {
  id: string;
  venue: string;
  issuedAt: string;
  intervalCount: number;
}

export interface ReviewState {
  pipes: PipeRecord[];
  intervals: IntervalRecord[];
  reports: ReportRecord[];
}

export type IntervalStatus = "pass" | "fail" | "pending" | "unmeasured";

const STORAGE_KEY = "organ-interval-review-v1";

/* ---------- 本机持久化 ---------- */

export function loadState(): ReviewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ReviewState;
      if (Array.isArray(parsed.pipes) && Array.isArray(parsed.intervals)) {
        return {
          pipes: parsed.pipes,
          reports: parsed.reports ?? [],
          // 以当前音管清单重建音程对，保留已有结论
          intervals: reconcileIntervals(parsed.pipes, parsed.intervals),
        };
      }
    }
  } catch {
    // 数据损坏时重新播种
  }
  return seedState();
}

export function saveState(state: ReviewState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 本机存储不可用时静默失败，页面内状态仍有效
  }
}

/* ---------- 状态查询 ---------- */

function pipeOf(state: ReviewState, id: string): PipeRecord | undefined {
  return state.pipes.find((p) => p.id === id);
}

export function intervalStatus(state: ReviewState, iv: IntervalRecord): IntervalStatus {
  const lower = pipeOf(state, iv.lowerPipeId);
  const upper = pipeOf(state, iv.upperPipeId);
  if (!lower?.measuredFreq || !upper?.measuredFreq) return "unmeasured";
  if (!iv.conclusion) return "pending";
  return iv.conclusion.status;
}

/** 用当前实测频率实时计算偏差与拍频（不写入结论） */
export function liveJudgement(state: ReviewState, iv: IntervalRecord): Judgement | null {
  const lower = pipeOf(state, iv.lowerPipeId);
  const upper = pipeOf(state, iv.upperPipeId);
  if (!lower?.measuredFreq || !upper?.measuredFreq) return null;
  return judgeInterval(iv.type, lower.measuredFreq, upper.measuredFreq);
}

/* ---------- 业务动作 ---------- */

/** 重测某根音管：只清掉涉及它的复核结论（转入上次结论），其他音程继续有效 */
export function remeasurePipe(state: ReviewState, pipeId: string, freq: number, when: string): ReviewState {
  const pipes = state.pipes.map((p) =>
    p.id === pipeId ? { ...p, measuredFreq: freq, measuredAt: when } : p
  );
  const intervals = state.intervals.map((iv) => {
    if (iv.lowerPipeId !== pipeId && iv.upperPipeId !== pipeId) return iv;
    return { ...iv, lastConclusion: iv.conclusion ?? iv.lastConclusion, conclusion: null };
  });
  return { ...state, pipes, intervals };
}

/** 复核单个音程：用当前实测频率判定并写入结论 */
export function reviewInterval(state: ReviewState, intervalId: string, when: string): ReviewState {
  const intervals = state.intervals.map((iv) => {
    if (iv.id !== intervalId) return iv;
    const j = liveJudgement(state, iv);
    if (!j) return iv;
    const conclusion: Conclusion = {
      status: j.status,
      deviationCents: j.deviationCents,
      beatHz: j.beatHz,
      reviewedAt: when,
    };
    return { ...iv, lastConclusion: iv.conclusion ?? iv.lastConclusion, conclusion };
  });
  return { ...state, intervals };
}

/** 复核全部已具备实测频率的音程 */
export function reviewAllIntervals(state: ReviewState, when: string): ReviewState {
  const intervals = state.intervals.map((iv) => {
    const j = liveJudgement(state, iv);
    if (!j) return iv;
    const conclusion: Conclusion = {
      status: j.status,
      deviationCents: j.deviationCents,
      beatHz: j.beatHz,
      reviewedAt: when,
    };
    return { ...iv, lastConclusion: iv.conclusion ?? iv.lastConclusion, conclusion };
  });
  return { ...state, intervals };
}

/** 仍有未通过（超限 / 待复核 / 待测）的音程时，单次维护报告不能签发 */
export function issueBlockers(state: ReviewState, venue: string): string[] {
  const scoped = state.intervals.filter((iv) => iv.venue === venue);
  if (scoped.length === 0) return ["该场馆没有可签发的音程记录"];
  let fail = 0;
  let pending = 0;
  let unmeasured = 0;
  for (const iv of scoped) {
    const status = intervalStatus(state, iv);
    if (status === "fail") fail += 1;
    else if (status === "pending") pending += 1;
    else if (status === "unmeasured") unmeasured += 1;
  }
  const blockers: string[] = [];
  if (fail > 0) blockers.push(`${fail} 个音程超限未通过`);
  if (pending > 0) blockers.push(`${pending} 个音程尚未复核`);
  if (unmeasured > 0) blockers.push(`${unmeasured} 个音程缺少实测频率`);
  return blockers;
}

export type IssueResult = { ok: true; state: ReviewState } | { ok: false; blockers: string[] };

export function issueReport(state: ReviewState, venue: string, when: string): IssueResult {
  const blockers = issueBlockers(state, venue);
  if (blockers.length > 0) return { ok: false, blockers };
  const report: ReportRecord = {
    id: `RPT-${venue}-${when}`,
    venue,
    issuedAt: when,
    intervalCount: state.intervals.filter((iv) => iv.venue === venue).length,
  };
  return { ok: true, state: { ...state, reports: [report, ...state.reports] } };
}

/* ---------- 初始数据 ---------- */

function reconcileIntervals(pipes: PipeRecord[], existing: IntervalRecord[]): IntervalRecord[] {
  const byId = new Map(existing.map((iv) => [iv.id, iv]));
  return findIntervalPairs(pipes).map((pair) => {
    const prev = byId.get(pair.id);
    return prev
      ? { ...pair, conclusion: prev.conclusion ?? null, lastConclusion: prev.lastConclusion ?? null }
      : { ...pair, conclusion: null, lastConclusion: null };
  });
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const etFreq = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const round3 = (v: number) => Math.round(v * 1000) / 1000;

interface SeedGroup {
  venue: string;
  stop: string;
  midis: number[];
  offsets?: Record<number, number>;
  unmeasured?: number[];
}

function seedState(): ReviewState {
  const now = new Date().toISOString();
  const groups: SeedGroup[] = [
    { venue: "St.Mary", stop: "Trumpet 8'", midis: range(60, 72), offsets: { 64: 4, 67: 9, 69: -6 } },
    { venue: "St.Mary", stop: "Principal 8'", midis: range(60, 72) },
    { venue: "ConcertHall A", stop: "Principal 4'", midis: [48, 50, 52, 53, 55, 57, 59, 60], offsets: { 52: -8 } },
    { venue: "Abbey Room", stop: "Bourdon 16'", midis: [36, 38, 40, 41, 43, 45, 47, 48], offsets: { 41: -12 }, unmeasured: [47] },
  ];
  const pipes: PipeRecord[] = groups.flatMap((g) =>
    g.midis.map((midi) => {
      const offset = g.offsets?.[midi] ?? 0;
      const skip = g.unmeasured?.includes(midi) ?? false;
      return {
        id: `${g.venue}::${g.stop}::${midi}`,
        venue: g.venue,
        stop: g.stop,
        midi,
        note: midiToNoteName(midi),
        octave: midiOctave(midi),
        measuredFreq: skip ? null : round3(etFreq(midi) * Math.pow(2, offset / 1200)),
        measuredAt: skip ? null : now,
      };
    })
  );
  const intervals: IntervalRecord[] = findIntervalPairs(pipes).map((pair) => {
    const lower = pipes.find((p) => p.id === pair.lowerPipeId);
    const upper = pipes.find((p) => p.id === pair.upperPipeId);
    let conclusion: Conclusion | null = null;
    if (lower?.measuredFreq && upper?.measuredFreq) {
      const j = judgeInterval(pair.type, lower.measuredFreq, upper.measuredFreq);
      conclusion = {
        status: j.status,
        deviationCents: j.deviationCents,
        beatHz: j.beatHz,
        reviewedAt: now,
      };
    }
    return { ...pair, conclusion, lastConclusion: null };
  });
  return { pipes, intervals, reports: [] };
}
