// Discord との境界。discord.js を import しない（実装は discord-gateway.ts、テストでは偽物に差し替える）

export type IncomingMessage = {
  id: string;
  channelId: string;
  /** DM では null */
  guildId: string | null;
  authorId: string;
  authorIsBot: boolean;
  isWebhook: boolean;
  content: string;
  createdAt: Date;
};

type InteractionBase = {
  /** DM では null */
  guildId: string | null;
  channelId: string | null;
  userId: string;
  createdAt: Date;
};

/** スラッシュコマンド・ボタン・セレクト・モーダル送信。custom_id は `<ns>:<action>:<channelId>`（100 字以内） */
export type Interaction =
  | (InteractionBase & { kind: "command"; name: string; options: Record<string, string | number | boolean> })
  | (InteractionBase & { kind: "button"; customId: string })
  | (InteractionBase & { kind: "select"; customId: string; values: string[] })
  /** fields はテキスト入力の customId → 入力値 */
  | (InteractionBase & { kind: "modal"; customId: string; fields: Record<string, string> });

export type ButtonDef = {
  customId: string;
  label: string;
  /** 既定 secondary */
  style?: "primary" | "secondary" | "success" | "danger";
  disabled?: boolean;
};

export type SelectDef = {
  customId: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  /** 25 件まで */
  options: Array<{ label: string; value: string; description?: string }>;
};

/** メッセージの 1 行。ボタンは 1 行 5 個まで、セレクトは 1 行に 1 つ。1 メッセージ 5 行まで */
export type ComponentRow = { kind: "buttons"; buttons: ButtonDef[] } | { kind: "select"; select: SelectDef };

export type OutgoingMessage = {
  /** 2000 字以内（分割しない） */
  text: string;
  /** update で省略すると元のコンポーネントを残す。[] で取り除く */
  components?: ComponentRow[];
  /** reply でだけ効く。defer 後の reply は defer 時の指定に従う */
  ephemeral?: boolean;
};

export type ModalDef = {
  customId: string;
  title: string;
  /** テキスト入力。5 個まで */
  fields: Array<{
    customId: string;
    label: string;
    /** 既定 short（1 行） */
    style?: "short" | "paragraph";
    /** 既定 true */
    required?: boolean;
    maxLength?: number;
    placeholder?: string;
    value?: string;
  }>;
};

export type CommandDef = {
  name: string;
  description: string;
  options?: Array<{
    type: "string" | "integer" | "boolean";
    name: string;
    description: string;
    required?: boolean;
    /** string のときだけ効く。文字数の下限・上限（Discord 側で検証する） */
    minLength?: number;
    maxLength?: number;
  }>;
};

export type TextChannelOptions = {
  name: string;
  /** 置くカテゴリ */
  parentId: string;
  topic?: string;
};

/** 1 つの interaction への応答。最初の応答は 3 秒以内（時間のかかる処理は先に defer） */
export interface InteractionResponder {
  /** 応答を保留する（「考え中」表示）。後の reply がその本文になる */
  defer(ephemeral: boolean): Promise<void>;
  /**
   * ボタン・セレクト（とメッセージから開いたモーダル）の応答を、元メッセージを変えずに保留する（「考え中」も出さない）。
   * 後の update が元メッセージの書き換えになり、reply は追加のメッセージになる
   */
  deferUpdate(): Promise<void>;
  /** 新しいメッセージで応答する。defer 後なら保留中の応答の本文、応答済み・deferUpdate 後なら追加のメッセージになる */
  reply(message: OutgoingMessage): Promise<void>;
  /** ボタン・セレクト（とメッセージから開いたモーダル）の元メッセージを書き換えて応答する（deferUpdate 後でも使える） */
  update(message: OutgoingMessage): Promise<void>;
  /** モーダルを開いて応答する（モーダル送信への応答には使えない） */
  showModal(modal: ModalDef): Promise<void>;
}

export type GatewayHandlers = {
  onMessage: (message: IncomingMessage) => void;
  /** 許可外のサーバー・DM のものも含めて渡す（受付判定は app 側） */
  onInteraction: (interaction: Interaction, responder: InteractionResponder) => void;
};

export interface Gateway {
  start(handlers: GatewayHandlers): Promise<void>;
  /** 長い本文は分割して送る。replyToId があれば最初の塊だけその発言への返信にする */
  send(channelId: string, text: string, replyToId?: string): Promise<void>;
  /** ボタンなどの付いたメッセージを 1 通送る（分割しない。ephemeral は効かない） */
  sendMessage(channelId: string, message: OutgoingMessage): Promise<void>;
  /** 入力中表示を始め、止める関数を返す */
  startTyping(channelId: string): () => void;
  /** Bot がそのサーバーに参加しているか（start 後に使う） */
  isInGuild(guildId: string): boolean;
  /** そのサーバーのコマンドを defs で丸ごと置き換える（bulk overwrite） */
  registerGuildCommands(guildId: string, defs: readonly CommandDef[]): Promise<void>;
  /** カテゴリを作り、その ID を返す。permission overwrite は書かない */
  createCategory(guildId: string, name: string): Promise<string>;
  /** カテゴリの中にテキストチャンネルを作り、その ID を返す。name・topic は作成時にだけ設定し、以後変更しない */
  createTextChannel(guildId: string, options: TextChannelOptions): Promise<string>;
  /** チャンネル（カテゴリを含む）がまだ Discord 上にあるか。無い以外の失敗（権限・通信）は投げる */
  channelExists(channelId: string): Promise<boolean>;
  /** カテゴリの中にあるチャンネルの数（キャッシュではなく Discord 上の実数。手動で置かれた分も数える） */
  countChannelsIn(categoryId: string): Promise<number>;
  /** チャンネルを別のカテゴリへ移す。permission overwrite は移動先に合わせない（書き換えない） */
  moveChannel(channelId: string, parentId: string): Promise<void>;
  /** チャンネルの今の親カテゴリの ID（キャッシュではなく Discord 上の値）。カテゴリの外なら null */
  getParentId(channelId: string): Promise<string | null>;
  stop(): Promise<void>;
}
