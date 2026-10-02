/** 同じ key のジョブは投入順に直列で実行し、全体の同時実行数を maxConcurrent までに抑える */
export class KeyedSerialQueue {
  private readonly maxConcurrent: number;
  private running = 0;
  /** 空きを待っているジョブ。空いた枠はそのまま先頭に引き渡す */
  private readonly waiters: Array<() => void> = [];
  /** key ごとの最後のジョブの完了（成否は問わない） */
  private readonly tails = new Map<string, Promise<void>>();

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError("maxConcurrent は正の整数で指定してください");
    }
    this.maxConcurrent = maxConcurrent;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => this.withSlot(fn));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running < this.maxConcurrent) {
      this.running++;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next === undefined) {
        this.running--;
      } else {
        next();
      }
    }
  }
}
