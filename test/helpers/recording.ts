// 単体テストの記録用の部品。チャンネルの移動の列とキューの代わり

import type { MoveTarget } from "../../src/app/channel-ops.ts";
import { KeyedSerialQueue, type QueueRunOptions } from "../../src/app/queue.ts";

/** ChannelOpsQueue の代わりに、入れた移動と取り消しを記録する */
export class RecordingChannelOps {
  moves: Array<{ channelId: string; target: MoveTarget }> = [];
  cancelled: string[] = [];

  enqueueMove(channelId: string, target: MoveTarget): void {
    this.moves.push({ channelId, target });
  }
  cancel(channelId: string): void {
    this.cancelled.push(channelId);
  }
}

/** 受け取った key と指定（セッションのジョブか）を記録して、そのまま実行する */
export class RecordingQueue extends KeyedSerialQueue {
  keys: string[] = [];
  options: Array<QueueRunOptions | undefined> = [];

  run<T>(key: string, fn: () => Promise<T>, options?: QueueRunOptions): Promise<T> {
    this.keys.push(key);
    this.options.push(options);
    return super.run(key, fn, options);
  }
}
