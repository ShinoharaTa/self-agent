// 単体テストの偽 AgentRunner。渡した結果を呼ばれた順に返す

import type { AgentRunner, RunInput, RunResult } from "../../src/agent/runner.ts";

/** 1 回の run の結果。Error は投げ、関数は受け取った入力で結果を作る（session_report を呼んだことにするなど） */
export type FakeRunStep = RunResult | Error | ((input: RunInput) => RunResult);

export class FakeRunner implements AgentRunner {
  /** 受け取った入力のうち、中断（signal）と途中経過（onProgress）を除いたもの */
  inputs: Array<Omit<RunInput, "signal" | "onProgress">> = [];
  /** 受け取った入力そのもの（signal・onProgress を見る） */
  received: RunInput[] = [];
  /** gates[i] があれば、i 回目の呼び出しは結果を返す前にそれを待つ */
  gates: Array<Promise<void> | undefined> = [];
  /** 入力を記録した後、結果を返す前に待つ。input の onProgress を呼べ、signal で止まれる */
  beforeResult: ((input: RunInput) => Promise<void>) | undefined;
  private readonly steps: FakeRunStep[];

  constructor(steps: FakeRunStep[]) {
    this.steps = steps;
  }

  async run(input: RunInput): Promise<RunResult> {
    const { signal: _signal, onProgress: _onProgress, ...rest } = input;
    const index = this.received.length;
    this.inputs.push(rest);
    this.received.push(input);
    await this.gates[index];
    if (this.beforeResult !== undefined) await this.beforeResult(input);
    const next = this.steps.shift();
    if (next === undefined) throw new Error("想定外の呼び出し: run");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(input) : next;
  }
}
