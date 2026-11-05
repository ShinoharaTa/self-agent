// Claude Code の質問の Discord での途中の答え（docs/plan/claude-code-questions.md §3.2。Q2）。プロセスの中だけ。
// 行 id → 答えた問の答え（問の順）とセレクトで選んだもの（[決める] で確定する）。1 通を 1 問ずつ書き換えるので、答えられるのは
// 次の問（答えた数の番号）だけ。全部答えたら app/commands/cc-question.ts が permission-hold.ts の answerQuestion に渡して消す。
// 再起動で消えてよい（再起動は pending を expired にするので、古いボタンは押しても古い）。Web・端末で先に答えられた行は、次に押されたときに消す
// （それまで残っても上限 CC_QUESTION_FLOW_MAX 件で古いものから忘れる）
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

  /** セレクトで選んだ label（[決める] で確定する）を覚える。次の問でなければ何もしない */
  select(id: number, question: number, labels: readonly string[]): void {
    if (question !== this.step(id)) return;
    this.entry(id).selected.set(question, [...labels]);
  }

  /** セレクトで選んだ label（無ければ undefined） */
  selected(id: number, question: number): string[] | undefined {
    const labels = this.entries.get(id)?.selected.get(question);
    return labels === undefined ? undefined : [...labels];
  }

  /** 問の答えを記録して、答えた問の答え（問の順）を返す。次の問でなければ記録せずに undefined */
  answer(id: number, question: number, pick: CcQuestionPick): CcQuestionPick[] | undefined {
    if (question !== this.step(id)) return undefined;
    const entry = this.entry(id);
    entry.picks.push(pick);
    entry.selected.delete(question);
    return [...entry.picks];
  }

  /** 行を忘れる（全部答えた・やめた・古い） */
  drop(id: number): void {
    this.entries.delete(id);
  }

  private entry(id: number): Entry {
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = { picks: [], selected: new Map() };
      this.entries.set(id, entry);
      if (this.entries.size > CC_QUESTION_FLOW_MAX) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    return entry;
  }
}
