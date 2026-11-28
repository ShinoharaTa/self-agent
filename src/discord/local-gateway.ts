// Gateway のローカルの実装。Web だけの人格の、Discord に何も作らない場所（place = 'local'。docs/plan/personas-web-antigravity.md §3.1）に使う。
// 引き受けるのは「場所に文を置く」事だけで、送信は捨てる（sendMessage は番号（LocalIdStore）を返し、send は戻り値が無いので番号を振らない）。
// 編集・ピン・リアクション・入力中は何もしない。
// Discord のサーバーの形（参加・コマンド・カテゴリ・チャンネル）に触る物は投げる。これはこの Gateway に届いた呼び出しへの最後の網で、
// 関所そのものは呼び手の側で place を見て作る（WP3）。今の呼び手は管理の操作と channelExists・messageExists を既定の Bot の Gateway に
// 直に呼び、gatewayFor を通らないので、この網には届かない。
// 「在るか」を訊かれたら在ると答える（無いと答えると、呼び手が消えたと見て片付けや作り直しに進むため。在るかは DB の行が決める）。
// ネットに出ず、log も出さない
import type { LocalIdStore } from "../store/local-places.ts";
import type { CommandDef, Gateway, GatewayHandlers, OutgoingMessage, TextChannelOptions } from "./gateway.ts";

/** 管理の操作がローカルの Gateway に来たときに投げる（ID・本文は入れない） */
function adminError(method: string): Error {
  return new Error(`ローカルの場所では Discord の管理の操作を呼べません: ${method}`);
}

export class LocalGateway implements Gateway {
  private readonly ids: Pick<LocalIdStore, "next">;

  constructor(ids: Pick<LocalIdStore, "next">) {
    this.ids = ids;
  }

  async start(_handlers: GatewayHandlers): Promise<void> {}

  /** 何もしない（戻り値が無いので番号を振らない） */
  async send(_channelId: string, _text: string, _replyToId?: string, _mentionUserId?: string): Promise<void> {}

  /** 送らずに番号を 1 つ返す */
  async sendMessage(_channelId: string, _message: OutgoingMessage): Promise<string> {
    return this.ids.next();
  }

  async editMessage(_channelId: string, _messageId: string, _message: OutgoingMessage): Promise<void> {}

  async pinMessage(_channelId: string, _messageId: string): Promise<void> {}

  async addReaction(_channelId: string, _messageId: string, _emoji: string): Promise<void> {}

  async removeOwnReaction(_channelId: string, _messageId: string, _emoji: string): Promise<void> {}

  async messageExists(_channelId: string, _messageId: string): Promise<boolean> {
    return true;
  }

  startTyping(_channelId: string): () => void {
    return () => {};
  }

  isInGuild(_guildId: string): boolean {
    throw adminError("isInGuild");
  }

  async registerGuildCommands(_guildId: string, _defs: readonly CommandDef[]): Promise<void> {
    throw adminError("registerGuildCommands");
  }

  async createCategory(_guildId: string, _name: string): Promise<string> {
    throw adminError("createCategory");
  }

  async createTextChannel(_guildId: string, _options: TextChannelOptions): Promise<string> {
    throw adminError("createTextChannel");
  }

  async setChannelTopic(_channelId: string, _topic: string): Promise<void> {
    throw adminError("setChannelTopic");
  }

  async channelExists(_channelId: string): Promise<boolean> {
    return true;
  }

  async countChannelsIn(_categoryId: string): Promise<number> {
    throw adminError("countChannelsIn");
  }

  async listChannelParents(_guildId: string): Promise<Map<string, string | null>> {
    throw adminError("listChannelParents");
  }

  async moveChannel(_channelId: string, _parentId: string): Promise<void> {
    throw adminError("moveChannel");
  }

  async getParentId(_channelId: string): Promise<string | null> {
    throw adminError("getParentId");
  }

  async deleteChannel(_channelId: string): Promise<void> {
    throw adminError("deleteChannel");
  }

  async stop(): Promise<void> {}
}
