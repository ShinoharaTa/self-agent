/** run の指定。session はセッションのチャンネルのジョブ（同時に動けるのは maxConcurrent - 1 まで。最低 1） */
export type QueueRunOptions = { session?: boolean };

/**
 * 同じ key のジョブは投入順に直列で実行し、全体の同時実行数を maxConcurrent までに抑える。
 * セッションのジョブは max(1, maxConcurrent - 1) までにし、残りの枠を #inbox などのジョブ用に空けておく
 */
export class KeyedSerialQueue {
  private readonly maxConcurrent: number;
  /** セッションのジョブが同時に動ける数 */
  private readonly maxSessions: number;
  private running = 0;
  /** 実行中のセッションのジョブの数（running に含まれる） */
  private runningSessions = 0;
  /** 枠を待っているジョブ（来た順）。枠が空いたら、先頭から枠の条件を満たすものに渡す */
  private readonly waiters: Array<{ session: boolean; resolve: () => void }> = [];
  /** key ごとの最後のジョブの完了（成否は問わない） */
  private readonly tails = new Map<string, Promise<void>>();
  /** 受け付けてまだ終わっていないジョブの数（実行中・枠待ち・同じ key の前のジョブ待ち） */
  private pending = 0;
  /** idle() の待ち手。pending が 0 になったら全員を起こす */
  private readonly idleWaiters: Array<() => void> = [];

  constructor(maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError("maxConcurrent は正の整数で指定してください");
    }
    this.maxConcurrent = maxConcurrent;
    this.maxSessions = Math.max(1, maxConcurrent - 1);
  }

  run<T>(key: string, fn: () => Promise<T>, options: QueueRunOptions = {}): Promise<T> {
    this.pending++;
    const session = options.session === true;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => this.withSlot(fn, session));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
      this.pending--;
      if (this.pending === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    });
    return result;
  }

  /** 実行中・待機中のジョブが無くなったら resolve する（停止時に使う。待つ上限は呼び出し側で決める） */
  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** 今その種類のジョブに枠を渡せるか */
  private canStart(session: boolean): boolean {
    return this.running < this.maxConcurrent && (!session || this.runningSessions < this.maxSessions);
  }

  private take(session: boolean): void {
    this.running++;
    if (session) this.runningSessions++;
  }

  private async withSlot<T>(fn: () => Promise<T>, session: boolean): Promise<T> {
    // 待っているジョブは、枠が空いた時点で渡せるものが渡し済みなので、ここで条件を満たせば先に動いてよい
    if (this.canStart(session)) {
      this.take(session);
    } else {
      await new Promise<void>((resolve) => this.waiters.push({ session, resolve }));
    }
    try {
      return await fn();
    } finally {
      this.running--;
      if (session) this.runningSessions--;
      this.dispatch();
    }
  }

  /** 待っているジョブを来た順に見て、枠の条件を満たすものに枠を渡す（満たさないものは順番を保ったまま待たせる） */
  private dispatch(): void {
    for (let index = 0; index < this.waiters.length && this.running < this.maxConcurrent; ) {
      const waiter = this.waiters[index]!;
      if (!this.canStart(waiter.session)) {
        index++;
        continue;
      }
      this.waiters.splice(index, 1);
      this.take(waiter.session);
      waiter.resolve();
    }
  }
}
