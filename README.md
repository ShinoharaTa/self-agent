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
| `/setup` | Creates the categories (`self-agent`, `進行中`, `待ち`, `完了`) and the `#inbox`, `#tasks` and `#system` channels (plus `#github` when GitHub notifications are enabled). Running it again recreates only what is missing. |
| `/new <title>` | Creates a session channel. |
| `/close` | Closes the session: saves a summary, lets you confirm suggested to-dos with buttons and adds them, then moves the channel to 完了. |
| `/renew` | Summarizes the conversation and starts a fresh one (to reset a long conversation). Works in sessions, `#inbox` and `#tasks`. |
| `/wait` | Moves the session to 待ち. Posting in that channel moves it back to 進行中. |
| `/sessions` | Lists sessions with links. |
| `/tasks` | Lists open tasks. Pick one to mark it done. |
| `/reminders` | Lists reminders and scheduled requests. Pick one to skip its next time or stop it. |
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
                           ├─ own tools (in-process MCP: tasks, sessions, knowledge base, memories, projects)
                           └─ built-in tools (web: WebSearch / WebFetch;
                                              files: Read / Write / Edit / Glob, inside projects only)
                                       │
                                 SQLite (node:sqlite)
```

- One channel = one SDK session. The SDK stores the conversation, and `resume` continues it.
- To keep the prompt cache effective, the system prompt and the tool set are the same for every session. The date and time go at the top of each message instead.
- A periodic job (every 5 minutes) fixes channels in the wrong category, moves idle sessions to 待ち, asks about deletions and rotates `#inbox`.
- See [`CLAUDE.md`](CLAUDE.md) for the code layout, [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) for requirements and decisions, and [`docs/plan/`](docs/plan/) for designs (all in Japanese).

## Safety rules

- It responds only to the owner's messages and actions, and only on servers allowed by an environment variable. It ignores DMs, other servers, other people, bots and webhooks.
- In session channels that have a project, the bot can run shell commands (Bash) — for example `git clone` and `npm install` — without asking each time. Every command runs inside an OS sandbox (bubblewrap): it can write only inside the working directory's `projects`, `.cache` and `.tmp` directories, cannot read the home directory (tokens, SSH keys, gh credentials, the bot's database and conversation logs, other projects), `/tmp`, `/run` or `/var/log`, and can reach only GitHub and the npm registry. The Claude token is removed from its environment. Commands time out after 5 minutes and cannot leave processes running.
- If the sandbox cannot start, the shell is turned off (commands are refused) and the bot says so in `#system`. The shell is off unless `SELF_AGENT_SHELL=1` is set.
- The working directory is a separate 8 GB filesystem image, so a runaway download cannot fill the host's disk.
- Besides WebSearch and WebFetch (and Bash when the shell is on), the built-in tools are the file tools (Read / Write / Edit / Glob). A hook lets them read only inside the projects directory and write only inside the current channel's own project. Files the bot deletes are moved to the project's `.trash` (so they can be restored) and removed for good after 30 days.
- WebFetch can fetch only URLs the owner pasted in that turn's message (and where they redirect to); anything else is denied by a hook. This blocks a page's instructions from sending data to some other URL.
- Content from web pages, search results and the knowledge base is treated as reference material. Instructions inside it are not followed.
- Images the owner attaches (JPEG / PNG / WebP / GIF, up to 4 per message) are sent to Anthropic's API as part of the conversation, so they also stay in the SDK's conversation record (under `CLAUDE_CONFIG_DIR`); the originals are kept in `<SELF_AGENT_DATA_DIR>/attachments/` (deleted after 30 days unless linked to a record).
- Irreversible actions, such as deleting a channel or a knowledge base entry, happen only when you press a button.
- Bot messages never ping `@everyone` or roles.
- Reminders and GitHub notifications addressed to you (red) mention only the owner.
- GitHub notifications are fetched by the app itself with GET requests through your current `gh` login (the LLM is not involved). It never marks anything as read on GitHub, and local logs never contain repository names, titles or URLs.
- The Claude child process receives only allowlisted environment variables (it never sees the Discord token, for example).

## Running it

### Requirements

- Linux (headless is fine) and Node.js 24.20 or later
- A Claude subscription (it runs with a token issued by `claude setup-token`; the default model is Opus, and it is run on the Max plan)
- A Discord bot you create yourself
- (for the shell) bubblewrap and socat, and an AppArmor profile for bwrap on Ubuntu 24.04+ (see [`docs/plan/shell.md`](docs/plan/shell.md) §6, in Japanese)

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
  -p MemoryMax=4G -p MemoryHigh=3G -p CPUQuota=300% -p TasksMax=1024 \
  "$(command -v node)" --env-file="$HOME/.config/self-agent/env" src/main.ts
journalctl --user -u self-agent -f      # logs
systemctl --user stop self-agent        # stop (waits for in-flight replies first)
```

### 5. Set it up in Discord

Run `/setup` on an allowed server. Once the categories and channels exist, try writing 「明日 買い物」 ("shopping tomorrow") in `#inbox`.

### 6. (Optional) Add a second bot (persona)

You can run a second bot with a different personality and role in the same process and server. Tasks, memories and the knowledge base are shared.

1. In the Developer Portal, create another application and bot, issue its token, turn **Public Bot off** and **Message Content Intent on**.
2. Invite it to the same server (scopes: `bot` and `applications.commands`) with only these permissions:
   View Channels / Send Messages / Read Message History (no Manage Channels; the first bot creates and moves channels)
3. Add to `~/.config/self-agent/env` (`<ID>` is the persona id in upper case):

```
# persona ids (lower-case letters and digits, 1–12 chars, comma-separated, up to 10)
SELF_AGENT_PERSONAS=mika
SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN=...
# display name (up to 20 chars; also the channel name #<NAME>, so it cannot be inbox / tasks / system / github; default: the id)
SELF_AGENT_PERSONA_MIKA_NAME=Mika
# optional: personality / tone / role (default ~/.config/self-agent/personas/<id>.md; keep it out of the repository)
SELF_AGENT_PERSONA_MIKA_PROMPT_FILE=...
# optional: claude (default) / codex (codex runs on Claude until the codex engine lands), and its model and effort
SELF_AGENT_PERSONA_MIKA_ENGINE=claude
SELF_AGENT_PERSONA_MIKA_MODEL=...
SELF_AGENT_PERSONA_MIKA_EFFORT=...
# recommended when you add a persona
SELF_AGENT_MAX_CONCURRENT=3
```

4. Restart, then run `/setup` again. It creates `#<NAME>` (for example `#mika`) in the self-agent category; write there to talk to the second bot.
   To start a session with it, use `/new` with the `persona` option (the channel is named `<NAME>-<title>`), or ask it in `#<NAME>`.

### 7. (Optional) Post GitHub notifications to `#github`

Comments and reviews on your PRs, mentions and review requests (red; pings only you) and other people's new issues / PRs in your own repositories (yellow; no ping) go to `#github`. Your own actions and bots' are left out.

1. Check `gh auth status`. The token must be stored in `~/.config/gh/hosts.yml` (a login stored in the keyring is not readable by the bot).
2. Run `npm run github-dry-run` to see only the counts (red / yellow / dropped) of one fetch. It posts nothing and does not mark anything as read.
3. Add these to `~/.config/self-agent/env`, restart, and run `/setup` again (it creates `#github` in the self-agent category):

```
SELF_AGENT_GITHUB=1
# optional: owners whose repositories count as yours (default: your gh login). Add your orgs
SELF_AGENT_GITHUB_OWNERS=<login>,<org>
# optional: polling interval in seconds (60 or more; default 300)
SELF_AGENT_GITHUB_POLL_SEC=300
```

The first fetch skips the unread notifications you already have and posts one start notice in `#github`. After that, only new ones are posted every 5 minutes (up to 10 at a time; the rest are folded into one "ほか n 件" message). Problems such as a broken `gh` login are reported in `#system`.

## Development

```bash
npm run check             # type check (tsc --noEmit; the code runs without a build step via Node's type stripping)
npm test                  # unit tests (fake Gateway / Runner and a temporary SQLite; no tokens needed)
npm run test:integration  # integration tests (call the real SDK when a Claude token is present; uses your allowance)
npm run measure           # measure time, memory and tokens for one turn
npm run github-dry-run    # fetch GitHub notifications once and print only the counts per class (posts nothing)
```

- Only three runtime dependencies (`@anthropic-ai/claude-agent-sdk`, `discord.js`, `zod`), pinned to exact versions.
- Conventions, the directory layout and the prompt caching rules are in [`CLAUDE.md`](CLAUDE.md).
- The system prompt is sent fresh on every request (`snapshot: false`), so changes reach existing sessions from their next turn. Changing the system prompt, adding tools or changing tool descriptions invalidates the cache once for every session, so batch such changes.
