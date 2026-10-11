// 単体テストの偽 InteractionResponder。応答を calls に順に記録する

import type { InteractionResponder, ModalDef, OutgoingMessage } from "../../src/discord/gateway.ts";

export type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "deferUpdate" }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

export class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];
  /** reply の直前に呼ばれる。投げればその応答は失敗する（記録しない） */
  beforeReply: (message: OutgoingMessage) => void = () => {};
  /** update の直前に呼ばれる。投げればその更新は失敗する（記録しない） */
  beforeUpdate: () => void = () => {};
  /** deferUpdate の直後に呼ばれる（保留の間に状態が変わったことにする） */
  afterDeferUpdate: () => void = () => {};

  /** reply で送った本文 */
  get replies(): OutgoingMessage[] {
    return this.calls.flatMap((call) => (call.method === "reply" ? [call.message] : []));
  }

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
  }
  async deferUpdate(): Promise<void> {
    this.calls.push({ method: "deferUpdate" });
    this.afterDeferUpdate();
  }
  async reply(message: OutgoingMessage): Promise<void> {
    this.beforeReply(message);
    this.calls.push({ method: "reply", message });
  }
  async update(message: OutgoingMessage): Promise<void> {
    this.beforeUpdate();
    this.calls.push({ method: "update", message });
  }
  async showModal(modal: ModalDef): Promise<void> {
    this.calls.push({ method: "showModal", modal });
  }
}
