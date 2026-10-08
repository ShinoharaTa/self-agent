# self-agent

English | [日本語](README_ja.md)

A personal AI agent that lives on a private Discord server and helps one owner manage tasks and organize information.
It runs on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) (TypeScript) and uses the allowance of a Claude subscription.

> The bot speaks Japanese, and its channel names, buttons and messages are in Japanese. `CLAUDE.md` and `docs/` are also written in Japanese.

- Jot things down in `#inbox`. Adding, listing and completing tasks happen right there.
- Give bigger topics their own channel (a session). A session's state shows as its category: 進行中 (active) / 待ち (waiting) / 完了 (done).
- Web search, reading pages from URLs you paste, a knowledge base (full-text search), and memories (facts it should always keep in mind).
- Lightweight like [Pi](https://github.com/badlogic/pi-mono): one model, a small fixed set of tools, a short static system prompt, no subagents.

## What it does

| Where / how | What you get |
|---|---|
| Write in `#inbox` | Add tasks (e.g. 「明日 買い物」, "shopping tomorrow"), list them and complete them. Dates are read relative to when you posted. When a conversation looks like it will run long, the bot opens a session channel and points you there (limited per day). |
| A session channel | One channel = one conversation. It picks up where you left off, even after a restart. |
| Web | Ask it to look something up and it searches the web. To have it read a page, paste the URL in your message (it can read only URLs you pasted). |
| Knowledge base | Save with "add this URL to the knowledge base" or "summarize this and save it"; recall with "what was that thing I saved about …?". An entry is deleted only when you press the confirmation button. |
| Memories | "I live in …, remember that" saves a memory. Memories are given as background at the start of each new session. Every change comes with an [取り消す] (undo) button. |
| Housekeeping | Sessions with no messages for 12 hours move to 待ち. 30 days after a session is done, the bot asks in `#system` whether to delete its channel (it never deletes without asking). The `#inbox` conversation is summarized and restarted every morning at 4:00. Hours, days and the time are configurable through environment variables. |

### Slash commands

| Command | What it does |
|---|---|
| `/setup` | Creates the categories (`self-agent`, `進行中`, `待ち`, `完了`) and the `#inbox`, `#tasks` and `#system` channels. Running it again recreates only what is missing. |
| `/new <title>` | Creates a session channel. |
| `/close` | Closes the session: saves a summary, lets you confirm suggested to-dos with buttons and adds them, then moves the channel to 完了. |
| `/wait` | Moves the session to 待ち. Posting in that channel moves it back to 進行中. |
| `/sessions` | Lists sessions with links. |
| `/tasks` | Lists open tasks. Pick one to mark it done. |
| `/usage` | Turns, tokens, cache hits and tool calls for today and the last 7 days. |
| `/help` | How to use it. |

The home panel pinned in `#inbox` also has buttons to create a session, list tasks and open waiting sessions.

## How it works

```
Discord ──(discord.js)── Gateway ── access check (allowed servers, owner only)
                                       │
                         per-channel serial queue
                                       │
                         Claude Agent SDK query() (resumed per channel)
                           ├─ own tools (in-process MCP: tasks, sessions, knowledge base, memories)
                           └─ built-in tools (WebSearch / WebFetch only)
                                       │
                                 SQLite (node:sqlite)
```

- One channel = one SDK session. The SDK stores the conversation, and `resume` continues it.
- To keep the prompt cache effective, the system prompt and the tool set are the same for every session. The date and time go at the top of each message instead.
- A periodic job (every 5 minutes) fixes channels in the wrong category, moves idle sessions to 待ち, asks about deletions and rotates `#inbox`.
- See [`CLAUDE.md`](CLAUDE.md) for the code layout, [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) for requirements and decisions, and [`docs/plan/`](docs/plan/) for designs (all in Japanese).

## Safety rules

- It responds only to the owner's messages and actions, and only on servers allowed by an environment variable. It ignores DMs, other servers, other people, bots and webhooks.
- All Claude Code built-in tools except WebSearch and WebFetch are disabled (no shell, no file access).
- WebFetch can fetch only URLs the owner pasted in that turn's message (and where they redirect to); anything else is denied by a hook. This blocks a page's instructions from sending data to some other URL.
- Content from web pages, search results and the knowledge base is treated as reference material. Instructions inside it are not followed.
- Irreversible actions, such as deleting a channel or a knowledge base entry, happen only when you press a button.
- Bot messages never ping `@everyone` or roles.
- The Claude child process receives only allowlisted environment variables (it never sees the Discord token, for example).

## Running it

### Requirements

- Linux (headless is fine) and Node.js 24.20 or later
- A Claude subscription (it runs with a token issued by `claude setup-token`; the default model is Opus, and it is run on the Max plan)
- A Discord bot you create yourself

### 1. Create the Discord bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and a bot, and issue the bot token.
2. In the bot settings, turn **Public Bot off**, and under Privileged Gateway Intents turn **Message Content Intent on**.
3. Invite the bot to your server (scopes: `bot` and `applications.commands`). It needs these permissions:
   View Channels / Send Messages / Read Message History / Manage Channels / Pin Messages

### 2. Issue a Claude token

```bash
claude setup-token   # sign in at the URL it shows, then keep the token it prints (valid for 1 year)
```

### 3. Put the environment variables in place

`~/.config/self-agent/env` (mode 600; keep it out of the repository):

```
# token from claude setup-token
CLAUDE_CODE_OAUTH_TOKEN=...
# bot token
DISCORD_TOKEN=...
# IDs of the servers to run on (comma-separated)
SELF_AGENT_ALLOWED_GUILD_IDS=...
# your Discord user ID
SELF_AGENT_OWNER_ID=...
```

```bash
mkdir -p ~/.config/self-agent && chmod 700 ~/.config/self-agent
( umask 077; ${EDITOR:-vi} ~/.config/self-agent/env )
```

To copy server and user IDs, turn on Developer Mode in Discord, then right-click (long-press on mobile) the server or your name.
For optional settings (model, effort, intervals and limits), see the [environment variable table in `CLAUDE.md`](CLAUDE.md#環境変数) (in Japanese).

### 4. Start it

```bash
npm ci
npm start
```

To keep it running, make it a systemd user service (no sudo needed; if Node comes from nvm, run `source ~/.nvm/nvm.sh` first). For example:

```bash
systemd-run --user --unit=self-agent --working-directory="$PWD" \
  "$(command -v node)" --env-file="$HOME/.config/self-agent/env" src/main.ts
journalctl --user -u self-agent -f      # logs
systemctl --user stop self-agent        # stop (waits for in-flight replies first)
```

### 5. Set it up in Discord

Run `/setup` on an allowed server. Once the categories and channels exist, try writing 「明日 買い物」 ("shopping tomorrow") in `#inbox`.

## Development

```bash
npm run check             # type check (tsc --noEmit; the code runs without a build step via Node's type stripping)
npm test                  # unit tests (fake Gateway / Runner and a temporary SQLite; no tokens needed)
npm run test:integration  # integration tests (call the real SDK when a Claude token is present; uses your allowance)
npm run measure           # measure time, memory and tokens for one turn
```

- Only three runtime dependencies (`@anthropic-ai/claude-agent-sdk`, `discord.js`, `zod`), pinned to exact versions.
- Conventions, the directory layout and the prompt caching rules are in [`CLAUDE.md`](CLAUDE.md).
- System prompt changes do not reach existing sessions (they apply to new sessions and after the `#inbox` rotation). Adding tools or changing tool descriptions invalidates the cache once for every session, so batch such changes.
