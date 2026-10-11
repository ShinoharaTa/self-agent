// 単体テストの偽 Gateway。既定ではどのメソッドも「想定外の呼び出し: <method>」を投げる。
// 使うメソッドを allow で選ぶと、選んだメソッドだけが下の記録と Discord 上の状態で動く

import type { CommandDef, Gateway, OutgoingMessage, TextChannelOptions } from "../../src/discord/gateway.ts";

export type GatewayMethod = keyof Gateway;

/** calls に残す呼び出し（引数そのまま） */
export type GatewayCall =
  | { method: "send"; channelId: string; text: string }
  | { method: "sendMessage"; channelId: string; message: OutgoingMessage }
  | { method: "pinMessage"; channelId: string; messageId: string }
  | { method: "messageExists"; channelId: string; messageId: string }
  | { method: "createCategory"; guildId: string; name: string }
  | { method: "createTextChannel"; guildId: string; options: TextChannelOptions }
  | { method: "channelExists"; channelId: string }
  | { method: "countChannelsIn"; categoryId: string }
  | { method: "moveChannel"; channelId: string; parentId: string }
  | { method: "getParentId"; channelId: string };

export type FakeGatewayOptions = {
  /** 偽の動きをするメソッド。これ以外は投げる */
  allow?: readonly GatewayMethod[];
  /** calls に残すメソッド（allow にも入れる） */
  record?: readonly GatewayCall["method"][];
  /** 作ったカテゴリ・チャンネルの ID の頭。既定 ch-（1 から振る） */
  channelIdPrefix?: string;
  /** sendMessage で返す ID の頭。既定 message-（送れた順に 1 から振る） */
  messageIdPrefix?: string;
};

/** 失敗の注入。投げればその呼び出しは失敗する。Promise を返したときだけ待つ（同期の hook なら記録は呼び出しと同じ tick で済む） */
type Hook<A extends unknown[] = []> = (...args: A) => void | Promise<void>;

export class FakeGateway implements Gateway {
  // 記録
  /** record で選んだメソッドの呼び出し。send は送れたものだけ、それ以外は hook の前に残す */
  calls: GatewayCall[] = [];
  /** 送れた send */
  sent: Array<{ channelId: string; text: string; replyToId?: string }> = [];
  /** 送れた sendMessage */
  posts: Array<{ channelId: string; messageId: string; message: OutgoingMessage }> = [];
  /** 書き換えられた editMessage */
  edits: Array<{ channelId: string; messageId: string; message: OutgoingMessage }> = [];
  /** send・sendMessage・editMessage が成功した順 */
  order: string[] = [];
  typingStarted = 0;
  typingStopped = 0;
  registered: Array<{ guildId: string; defs: readonly CommandDef[] }> = [];
  /** listChannelParents で問い合わせたサーバー */
  listed: string[] = [];
  /** deleteChannel を呼ばれたチャンネル（hook の前に残す） */
  deleted: string[] = [];

  // Discord 上の状態
  /** Discord 上にあるチャンネル・カテゴリ（channelExists の答え）。作ったものは足し、消したものは除く */
  readonly alive = new Set<string>();
  /** チャンネル → 親カテゴリ（getParentId・countChannelsIn の答え）。作成・移動で更新する */
  parents = new Map<string, string | null>();
  /** カテゴリに手動で置かれたチャンネルの数（countChannelsIn に足す） */
  readonly manual = new Map<string, number>();
  /** Discord 上にあるメッセージ（channelId:messageId）。送れた sendMessage を足す */
  readonly messages = new Set<string>();
  /** Bot が参加しているサーバー。undefined なら全部に参加している扱い */
  joined: Set<string> | undefined;
  /** listChannelParents の答え（呼ばれた時点で写す）。既定は parents */
  listParents: () => Map<string, string | null> = () => this.parents;

  // 失敗の注入
  beforeSend: Hook<[channelId: string]> = () => {};
  beforeSendMessage: Hook<[channelId: string]> = () => {};
  beforeEdit: Hook<[channelId: string]> = () => {};
  beforePin: Hook = () => {};
  beforeMessageExists: Hook = () => {};
  /** createCategory・createTextChannel の直前（名前を渡す） */
  beforeCreate: Hook<[name: string]> = () => {};
  beforeExists: Hook<[channelId: string]> = () => {};
  beforeMove: Hook<[channelId: string]> = () => {};
  beforeDelete: Hook<[channelId: string]> = () => {};
  /** listChannelParents の中（答えを写した後、返す前） */
  beforeList: Hook<[guildId: string]> = () => {};
  beforeRegister: Hook<[guildId: string]> = () => {};
  beforeStop: Hook = () => {};

  private readonly allowed: ReadonlySet<GatewayMethod>;
  private readonly recorded: ReadonlySet<GatewayMethod>;
  private readonly channelIdPrefix: string;
  private readonly messageIdPrefix: string;
  private nextChannelId = 1;

  constructor(options: FakeGatewayOptions = {}) {
    this.recorded = new Set(options.record ?? []);
    this.allowed = new Set([...(options.allow ?? []), ...this.recorded]);
    this.channelIdPrefix = options.channelIdPrefix ?? "ch-";
    this.messageIdPrefix = options.messageIdPrefix ?? "message-";
  }

  /** calls を空にする（前の操作の呼び出しを見ないため） */
  reset(): void {
    this.calls = [];
  }

  /** moveChannel を呼ばれた [チャンネル, 移動先]（record に moveChannel が要る） */
  moves(): Array<[string, string]> {
    return this.calls.flatMap((call) => (call.method === "moveChannel" ? [[call.channelId, call.parentId]] : []));
  }

  /** calls のうち methods のもの */
  callsOf(...methods: GatewayCall["method"][]): GatewayCall[] {
    return this.calls.filter((call) => methods.includes(call.method));
  }

  async start(): Promise<void> {
    this.expect("start");
  }
  async send(channelId: string, text: string, replyToId?: string): Promise<void> {
    this.expect("send");
    const pending = this.beforeSend(channelId);
    if (pending instanceof Promise) await pending;
    this.order.push("send");
    this.sent.push({ channelId, text, replyToId });
    this.record({ method: "send", channelId, text });
  }
  async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
    this.expect("sendMessage");
    this.record({ method: "sendMessage", channelId, message });
    const pending = this.beforeSendMessage(channelId);
    if (pending instanceof Promise) await pending;
    const messageId = `${this.messageIdPrefix}${this.posts.length + 1}`;
    this.order.push("sendMessage");
    this.posts.push({ channelId, messageId, message });
    this.messages.add(`${channelId}:${messageId}`);
    return messageId;
  }
  async editMessage(channelId: string, messageId: string, message: OutgoingMessage): Promise<void> {
    this.expect("editMessage");
    const pending = this.beforeEdit(channelId);
    if (pending instanceof Promise) await pending;
    this.order.push("editMessage");
    this.edits.push({ channelId, messageId, message });
  }
  async pinMessage(channelId: string, messageId: string): Promise<void> {
    this.expect("pinMessage");
    this.record({ method: "pinMessage", channelId, messageId });
    const pending = this.beforePin();
    if (pending instanceof Promise) await pending;
  }
  async messageExists(channelId: string, messageId: string): Promise<boolean> {
    this.expect("messageExists");
    this.record({ method: "messageExists", channelId, messageId });
    const pending = this.beforeMessageExists();
    if (pending instanceof Promise) await pending;
    return this.messages.has(`${channelId}:${messageId}`);
  }
  startTyping(): () => void {
    this.expect("startTyping");
    this.typingStarted++;
    return () => {
      this.typingStopped++;
    };
  }
  isInGuild(guildId: string): boolean {
    this.expect("isInGuild");
    return this.joined === undefined || this.joined.has(guildId);
  }
  async registerGuildCommands(guildId: string, defs: readonly CommandDef[]): Promise<void> {
    this.expect("registerGuildCommands");
    const pending = this.beforeRegister(guildId);
    if (pending instanceof Promise) await pending;
    this.registered.push({ guildId, defs });
  }
  async createCategory(guildId: string, name: string): Promise<string> {
    this.expect("createCategory");
    this.record({ method: "createCategory", guildId, name });
    const pending = this.beforeCreate(name);
    if (pending instanceof Promise) await pending;
    return this.newChannelId();
  }
  async createTextChannel(guildId: string, options: TextChannelOptions): Promise<string> {
    this.expect("createTextChannel");
    this.record({ method: "createTextChannel", guildId, options });
    const pending = this.beforeCreate(options.name);
    if (pending instanceof Promise) await pending;
    const id = this.newChannelId();
    this.parents.set(id, options.parentId);
    return id;
  }
  async channelExists(channelId: string): Promise<boolean> {
    this.expect("channelExists");
    this.record({ method: "channelExists", channelId });
    const pending = this.beforeExists(channelId);
    if (pending instanceof Promise) await pending;
    return this.alive.has(channelId);
  }
  async countChannelsIn(categoryId: string): Promise<number> {
    this.expect("countChannelsIn");
    this.record({ method: "countChannelsIn", categoryId });
    let count = this.manual.get(categoryId) ?? 0;
    for (const parentId of this.parents.values()) if (parentId === categoryId) count++;
    return count;
  }
  async listChannelParents(guildId: string): Promise<Map<string, string | null>> {
    this.expect("listChannelParents");
    this.listed.push(guildId);
    const parents = new Map(this.listParents());
    const pending = this.beforeList(guildId);
    if (pending instanceof Promise) await pending;
    return parents;
  }
  async moveChannel(channelId: string, parentId: string): Promise<void> {
    this.expect("moveChannel");
    this.record({ method: "moveChannel", channelId, parentId });
    const pending = this.beforeMove(channelId);
    if (pending instanceof Promise) await pending;
    this.parents.set(channelId, parentId);
  }
  async getParentId(channelId: string): Promise<string | null> {
    this.expect("getParentId");
    this.record({ method: "getParentId", channelId });
    return this.parents.get(channelId) ?? null;
  }
  async deleteChannel(channelId: string): Promise<void> {
    this.expect("deleteChannel");
    this.deleted.push(channelId);
    const pending = this.beforeDelete(channelId);
    if (pending instanceof Promise) await pending;
    this.alive.delete(channelId);
  }
  async stop(): Promise<void> {
    this.expect("stop");
    const pending = this.beforeStop();
    if (pending instanceof Promise) await pending;
  }

  private expect(method: GatewayMethod): void {
    if (!this.allowed.has(method)) throw new Error(`想定外の呼び出し: ${method}`);
  }

  private record(call: GatewayCall): void {
    if (this.recorded.has(call.method)) this.calls.push(call);
  }

  private newChannelId(): string {
    const id = `${this.channelIdPrefix}${this.nextChannelId++}`;
    this.alive.add(id);
    return id;
  }
}

