// Claude Code の質問の Discord での途中の答え（docs/plan/claude-code-questions.md §3.2。Q2）。プロセスの中だけ。
// 行 id → 答えた問の答え（問の順）とセレクトで選んだもの（[決める] で確定する）。1 通を 1 問ずつ書き換えるので、答えられるのは
// 次の問（答えた数の番号）だけ。全部答えたら app/commands/cc-question.ts が permission-hold.ts の answerQuestion に渡して消す。
// 再起動で消えてよい（再起動は pending を expired にするので、古いボタンは押しても古い）。Web・端末で先に答えられた行は、次に押されたときに消す
// （上限は CC_QUESTION_FLOW_MAX 件。超えるときは何も答えていない・選んでいない行を古いものから忘れ、それが無ければ新しい行を受けない。
// 進行中の行は消さない）
import type { CcQuestionPick } from "./questions.ts";

/** 覚えておく行の数（超えたら古いものから忘れる） */
export const CC_QUESTION_FLOW_MAX = 100;

type Entry = { picks: CcQuestionPick[]; selected: Map<number, string[]> };

export class CcQuestionFlow {
  private readonly entries = new Map<number, Entry>();

  /** 次に答える問の番号（答えた数） */
  step(id: number): number {
    return this.entries.get(id)?.picks.length ?? 0;
  }

  /** 答えた問の答え（問の順） */
  picks(id: number): CcQuestionPick[] {
    return [...(this.entries.get(id)?.picks ?? [])];
  }

  /** セレクトで選んだ label（[決める] で確定する）を覚える。次の問でない・上限で新しい行を受けられなければ何もしない（false） */
  select(id: number, question: number, labels: readonly string[]): boolean {
    if (question !== this.step(id)) return false;
    const entry = this.entry(id);
    if (entry === undefined) return false;
    entry.selected.set(question, [...labels]);
    return true;
  }

  /** セレクトで選んだ label（無ければ undefined） */
  selected(id: number, question: number): string[] | undefined {
    const labels = this.entries.get(id)?.selected.get(question);
    return labels === undefined ? undefined : [...labels];
  }

  /** 問の答えを記録して、答えた問の答え（問の順）を返す。次の問でない・上限で新しい行を受けられなければ記録せずに undefined */
  answer(id: number, question: number, pick: CcQuestionPick): CcQuestionPick[] | undefined {
    if (question !== this.step(id)) return undefined;
    const entry = this.entry(id);
    if (entry === undefined) return undefined;
    entry.picks.push(pick);
    entry.selected.delete(question);
    return [...entry.picks];
  }

  /** 行を忘れる（全部答えた・やめた・古い） */
  drop(id: number): void {
    this.entries.delete(id);
  }

  /** 行（無ければ作る）。上限に達していれば空の行（答えも選んだものも無い）を古いものから 1 つ忘れ、それも無ければ undefined */
  private entry(id: number): Entry | undefined {
    const existing = this.entries.get(id);
    if (existing !== undefined) return existing;
    if (this.entries.size >= CC_QUESTION_FLOW_MAX) {
      const idle = [...this.entries].find(([, entry]) => entry.picks.length === 0 && entry.selected.size === 0);
      if (idle === undefined) return undefined;
      this.entries.delete(idle[0]);
    }
    const entry: Entry = { picks: [], selected: new Map() };
    this.entries.set(id, entry);
    return entry;
  }
}
