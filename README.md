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
| `/new <title>` | Creates a session channel. With `project`, the session works in a project under `~/workspace` with the same setup as Claude Code (see step 10). |
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
  "$(command -v node)" --env-file="$HOME/.config/self-agent/env" src/cli.ts start
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

When the Claude Code integration of section 9 (`SELF_AGENT_CC=1`) is also on and `git` is available, notifications for your own repositories (`SELF_AGENT_GITHUB_OWNERS`) and for repositories cloned directly under `SELF_AGENT_WORKSPACE_DIR` (or one level below) get a [対応] button (also in the GitHub tab of the Web UI). It queues a one-line request (repository, number, kind and URL only; no title or body) for the Claude Code session running in that repository's directory, delivered once the session waits for input. If several sessions match and they cannot be narrowed down to one waiting for input, nothing is sent and the candidates are listed. If no session is running, [起動して送る] starts a new session in that directory (same conditions as in section 9) and delivers the same request. Pressing again while the request waits, or within 30 minutes after it was delivered, does not queue another one.

### 8. (Optional) Web UI

A small web app on your tailnet for checking the bot's status and usage from a browser (work in progress: for now it serves `/api/status`, `/api/usage` and a placeholder page). It listens only on `127.0.0.1`; you expose it with `tailscale serve` on its own port.

1. Add to `~/.config/self-agent/env` and restart (the UI is on only when both the port and the login are set):

```
# port for the Web UI (listens on 127.0.0.1 only)
SELF_AGENT_WEB_PORT=8791
# your Tailscale login; only requests whose Tailscale-User-Login matches it exactly get in
SELF_AGENT_WEB_ALLOWED_LOGIN=<you>@<domain>
# optional: a token (32+ characters, no spaces) to sign in at /login when the login header is missing
SELF_AGENT_WEB_TOKEN=...
```

2. Expose it on the tailnet (once; it persists):

```bash
tailscale serve --bg --https=9444 http://127.0.0.1:8791
```

3. Open `https://<host>.<tailnet>.ts.net:9444/`. Without the login header (and with a token set), you are sent to `/login`; paste the token there to get a 30-day cookie. Replacing the token signs everyone out. Requests straight to `127.0.0.1` without the header get 401.

4. (Optional) On an iPhone, open the https URL of step 3 in Safari and use Share → "Add to Home Screen" to open it like an app without the browser bars (with its own icon and the name self-agent; on Android or desktop Chrome, use "Install app" in the menu). This needs the https `tailscale serve` from step 2; over plain http you cannot sign in (the cookie is `Secure`). It does not work offline.

### 9. (Optional) Watch, send to and start the Claude Code sessions on this machine

Work in progress (`docs/plan/claude-code-sessions.md`, stages CC5c, CC7 and CC8): the bot reads `claude agents --json` periodically and receives Claude Code's hooks on a local port, so it knows which sessions are waiting for you, running or idle. The Web UI (when enabled) lists the sessions in a "Claude Code" group of the conversation sidebar, right after the entrances (waiting for you, then running, then by the latest instruction; the count on the conversation activity is unread plus waiting for you). Clicking a row opens the tab of that session, with a copy of its screen when it is inside tmux (every 3 seconds). From the tab of a session inside tmux you can send an instruction (multiple lines, up to 2,000 characters). It is pasted and Enter is pressed only while the session is waiting for input; while it is working, the instruction waits until it is (and is dropped after `SELF_AGENT_CC_SEND_WAIT_MIN` minutes, 120 by default; [やめる] withdraws it while it waits). If the paste cannot be confirmed, Enter is not pressed, so check the screen. If multi-line pastes keep looking as if only the first line was submitted, later sends replace line breaks with spaces and #system says so. After checking in the terminal, `npm run cc-dry-run -- --reset-multiline` turns multi-line sends back on (it changes only that value in the DB). [Claude Code を起動] below that group (also in the command palette) starts a new session in a directory directly under `SELF_AGENT_WORKSPACE_DIR` (`~/workspace` by default): it creates a new session on the default tmux server and runs `claude -n <title>` there. You can pick the permission mode (default of your settings, default, acceptEdits, plan or auto) and write a first instruction, which is sent once the session waits for input. It refuses when the tmux server is not running (the bot does not start one), when `SELF_AGENT_CC_MAX_SESSIONS` (30 by default) or more `claude` processes are alive, when less than 1 GB of memory is available, or within 1 minute of the previous start. The tmux session name is only for display; the bot follows the pane even if a tmux hook renames the session. In a new directory Claude Code asks whether you trust the folder; its default choice is "No, exit", so the bot never presses a key. When the list shows "trust の確認待ち", answer it in the terminal or in RC. When a session asks for permission, the bot holds Claude Code's `PermissionRequest` hook for up to `SELF_AGENT_CC_PERMISSION_HOLD_SEC` seconds (300 by default) and the tab of that session shows a card with [許可] (allow) and [拒否] (deny). A question from Claude Code (AskUserQuestion, a choice dialog) arrives through the same hook and is held for up to `SELF_AGENT_CC_QUESTION_HOLD_SEC` seconds (900 by default); In Discord (the session's Claude Code channel, created for it when there is none) the question is one message with a button per choice ([1. <label>] up to 4 choices, plus [その他] (other), which opens a box for a free answer of up to 1,000 characters); with 5 or more choices or multiple selection it is a select menu plus [決める] (decide). With several questions the message moves on to the next question after each answer and sends all answers to Claude Code after the last one, then shows the answers. [やめる] (stop) declines the question (Claude goes on without an answer). Answers in progress live only in the bot's memory, so after a restart the old buttons are stale. Until the Web card for questions arrives, the Web tab still shows the permission card, where [拒否] declines the question and [許可] does not answer it (answer in Discord, the terminal or RC). Run `npm run cc-setup -- --print` again after changing either value: the hook's timeout is the longer of the two plus 5 seconds. When Claude Code suggests a rule for the request (for example `Bash(npm test *)`), the card also has [このセッションでは常に許可（<rule>）] (always allow for this session): the rule is added to that session only (never to a settings file) and goes away when the `claude` process ends. Broad or risky rules are not offered: no command words, risky commands (`rm`, `sudo`, `curl` …), wrappers (`env`, `bash`, `xargs` …), quoted or path-like first words (`"rm"`, `./x.sh`), commands that run arbitrary code (`node`, `npx`, `python`, `make` …; for npm only `npm test` and `npm run <name>`), destructive git subcommands (`push`, `reset`, `checkout` …), `find -exec` / `-delete`, and pipes, redirects and the like. File rules must stay inside the project of the session's directory. Many requests come with no rule at all, so the button often does not appear. The usual dialog stays in the terminal (and RC) the whole time, and whichever answers first wins; when you answer there, the card closes within about 10 seconds. If nobody presses a button in time, the bot answers nothing and the dialog stays. Requests from a session the bot has not listed yet (for example, right after the bot starts, or while `claude agents --json` cannot be read) are not held; answer those in the terminal or RC. A permission request is also posted once on Discord (mentioning the owner) with buttons ([許可], [このセッションでは常に許可], [拒否], and [RC で開く] when the RC link is known), so you can answer from your phone. It goes to the session's Claude Code channel; when the session has none, the bot creates it first (`cc-<name>` in the "Claude Code" category, also for a session outside tmux, where writing in the channel answers that it cannot send from there). Nothing goes to #system: when the channel cannot be created (before /setup, the category is full, or Discord fails), the bot only logs it and you answer on the Web, in the terminal or RC. When the answer is settled (a button on the Web or Discord, an answer in the terminal, or time running out), the post is rewritten and its buttons are removed; pressing a button after that says "この操作は古くなっています" (stale). Other waits for your decision (a question dialog, a sandbox network permission, the dialog left after the hold expired, and so on) are posted the same way once after 60 seconds (up to 10 an hour; past that, a channel that already exists gets one short line, and no channel is created). The end of a session is posted only in its channel, when it has one. `SELF_AGENT_CC_NOTIFY=0` stops creating channels for these notices (requests of a session without a channel are then answered on the Web, in the terminal or RC; the hold time does not change). Posts to a channel that already exists (permission requests, questions, waiting notices, the end, mirrors) keep going with `0`, and their buttons still work. You can also check it with `npm run cc-dry-run`. It needs `claude` and `tmux` in `~/.local/bin`, `/usr/local/bin` or `/usr/bin` (anywhere else, on the bot's `PATH`). Whether `claude agents --json` works with only `HOME`, `PATH` and `LANG` in its environment (which is all the bot passes to it) is not confirmed yet.

You can also ask from Discord (CC7). Write something like "tell the <name> session '…'" or "start a new Claude Code session in alpha" in #inbox or another channel, and the bot posts a confirmation in that channel with the full text to send (up to 4,000 characters, split into up to three messages of 1,800 characters each) and [送る][やめる] or [起動する][やめる] on the last one. Text that cannot be shown in full is never sent. Nothing is sent or started until you press the button, and the confirmation is cancelled after 10 minutes (when a start fails for a passing reason, such as the session limit, memory or the one-minute interval, the buttons stay so you can press again a little later; if the bot is talked into it by a web page or similar, read the text and press [やめる]). Ask how the sessions are doing and it answers from the list (waiting for you / running / idle). It does not work in scheduled requests or /close turns. The first restart with these tools and the extra line in the system prompt misses the prompt cache once on the next turn of every session (even when `SELF_AGENT_CC` is off; you can see it with `npm run usage`).

Replies of a session you asked from Discord come back to the channel you asked in (CC8). Once a [送る] (or a [起動する] with a first instruction) is delivered, the bot follows that session: every time it finishes answering (Claude Code's `Stop` hook, including turns typed in RC, the terminal or the Web UI), it posts "Claude Code（<name>）の返事（hook）:" and the reply in that channel. The first reply is a reply to the confirmation. Each message holds 1,800 characters, up to three messages; anything longer becomes "ほか n 字。RC で読む". Replies are data from Claude Code, so they never ping anyone, link previews are off, and they are not fed into the bot's own conversation. To stop, press [追いかけをやめる] on a reply or in the session tab of the Web UI (after the replies moved to another channel, the buttons in the old channel still stop it). It also stops when the session ends (one line saying so) and after 3 days without a reply. There is a limit of 50 messages per session per day; past it the bot posts one "今日はここまで" line and resumes the next day. Asking from another channel moves the replies there. Turns stopped with Esc send no `Stop`, so their replies do not come back.

Each session can have its own Discord channel (stages CC9 to CC14 of `docs/plan/claude-code-channels.md`). With `SELF_AGENT_CC=1`, `/setup` creates a "Claude Code" category (and re-creates it if it was deleted). A `cc-<session name>` channel is created there automatically the first time you get involved with the session (sending from the Web UI, starting it from the Web UI, answering a permission request, [送る] on `cc_send`, [起動する] on `cc_start`, or [対応] in #github); just looking at the list does not create one (one per session, only for sessions inside tmux). A permission request, a question or a 60-second wait of a session without a channel also creates one (even outside tmux; see above). [Discord のチャンネルを作る] in the session tab of the Web UI, or `/cc open` in Discord (pick a session), also creates it. If it cannot be created (no category, category full at 50, ...), the send or start still goes ahead and the bot only logs it (the same reason at most once an hour; nothing goes to #system). **What you write in the channel is delivered to the session as is, without a confirmation** (pasted and submitted when the session waits for input; while it works, up to 5 messages per session are queued; images and files cannot be sent). Reactions show the state: ⏳ waiting, ✅ delivered, ⚠️ could not confirm, ❌ not sent; `/cc cancel` drops the queued ones. Text sent from the Web UI, `cc_send` or [対応] is mirrored into the channel ("（Web から）" and so on). The session's replies (`Stop`) always go to the channel when there is one (the first reply answers your message or the mirror, up to 200 a day, no [追いかけをやめる]). When the session ends (drops out of the list), the bot posts "セッションが終わりました。ここに書くと、同じディレクトリで起動して続けられます" and moves the channel to the "完了" category; when the same session comes back (for example with `claude -r`), it moves the channel back to "Claude Code". **You can continue in an ended channel**: if the session is still running (you only closed the channel with `/cc close`), what you write reopens the channel ("開き直しました") and is delivered as usual. Otherwise what you write there is not sent; the bot replies "このセッションは終わっています" with [起動して続ける] and [やめる]. [起動して続ける] starts a new `claude` in a new tmux session in the same directory (only a directory directly under `SELF_AGENT_WORKSPACE_DIR`, with the same limits as starting from the Web UI, including once a minute) with your message as the first instruction; once it shows up in the list, the channel is switched over to the new session and moved back to "Claude Code" (no new channel). Writing in the channel while it starts is refused ("起動中です"); if it cannot start, the channel stays ended and you can press the button again later. Only the button starts anything; writing alone never does. `/cc close` in the channel closes it (moves it to "完了"; it opens again the next time you get involved with that session, including writing in it while the session is running).
`/cc close` also drops that session's queued messages (⏳ is removed and the reply says how many were dropped). **Deleting**: `SELF_AGENT_DELETE_AFTER_DAYS` days after a channel ended, #system asks [削除する] / [残す], as for topic sessions ([残す] asks again after the same number of days). **Permission requests, questions and waiting notices go to the channel** (never to #system; a permission request is one post mentioning the owner, with [許可], [このセッションでは常に許可], [拒否] and [RC で開く]. A session without a channel gets one created for the notice, unless `SELF_AGENT_CC_NOTIFY=0`). **Instructions typed in the terminal or in RC are mirrored to the channel too** ("（端末か RC から）" and the first 1,000 characters; the rest is shown as "（ほか n 字）"; what the bot itself delivered from the channel or the Web is not mirrored). **You can follow the same flow in the Web UI conversation**: in the "Claude Code" group of the conversation list, a session with a channel (marked #) opens a conversation tab that shows your messages, mirrors, replies, permission requests and their results, waiting notices, and ended / back lines in the same order as Discord (a reply marks it unread). Sending from its input box delivers to the session the same way as the session tab, and the text is mirrored into the channel as "（Web から）" (if you only closed the channel with `/cc close` and the session is still running, it reopens and delivers, as when writing in Discord; an ended session cannot be sent to, so use [起動して続ける] in Discord). [画面] in the header opens the copy of the screen (every 3 seconds while open), [閉じる] is the same as `/cc close`, and a pending permission card can be answered there. There are no turns, so there is no [中断], [続ける] or [会話を新しくする]. Sessions without a channel still open the session tab.

1. Run `npm run cc-dry-run` to see the sessions in three groups (waiting for you / running / idle). It posts nothing and changes nothing.
2. Add to `~/.config/self-agent/env` (the token is shared with Claude Code's hooks; 32+ characters, no spaces):

```
SELF_AGENT_CC=1
# port for the hook endpoint (listens on 127.0.0.1 only; do not expose it with tailscale serve)
SELF_AGENT_CC_HOOK_PORT=8792
SELF_AGENT_CC_HOOK_TOKEN=...
```

3. Print the hooks settings and add them to `~/.claude/settings.json` yourself (the bot never writes to `~/.claude`):

```bash
npm run cc-setup -- --print
```

It prints an `env` entry and `hooks` for five events (`UserPromptSubmit`, `Stop`, `SessionEnd`, `Notification`, `PermissionRequest`; `SessionStart` is left out because it does not support http hooks), all `type: "http"` to `http://127.0.0.1:<port>/hook` with the header `X-Self-Agent-Hook: $SELF_AGENT_CC_HOOK_TOKEN`. Replace the placeholder in `env` with the same token as in `~/.config/self-agent/env`, and keep `~/.claude/settings.json` at mode 600. If the token is not picked up from `settings.json`'s `env`, export `SELF_AGENT_CC_HOOK_TOKEN` in the shell that starts your tmux server instead.

4. Restart the bot. While the bot is stopped, prompts are not delayed, but the terminal (and probably RC) shows a hook error line (`hook error … ECONNREFUSED`) on every turn.

### 10. (Optional) Project sessions (the same agent as Claude Code)

Work in progress (`docs/plan/unify.md`, stage U1). A project session is a session channel whose conversation runs in a project directly under `SELF_AGENT_WORKSPACE_DIR` (default `~/workspace`), with the same setup as Claude Code in the terminal: Claude Code's system prompt, your `~/.claude/CLAUDE.md` and the project's `CLAUDE.md`, your skills and subagents, and Bash without the sandbox. `#inbox`, `#tasks` and ordinary sessions stay as they are.

It needs step 9 (`SELF_AGENT_CC=1`), because permission requests use the same cards.

1. Print the links the bot needs and run them yourself (the bot never writes to `~/.claude` or its own `CLAUDE_CONFIG_DIR`). They make the bot's `skills` and `agents` symlinks to `~/.claude/skills` and `~/.claude/agents`; links that are already in place show as `済`, and anything that is not a symlink is reported instead of replaced. If `~/.claude/skills` or `~/.claude/agents` does not exist yet, a `mkdir -p` line for it comes first:

```bash
npm run unify-setup -- --print
```

2. Restart the bot. At startup it checks the two links; if they are missing it logs one line and refuses to create project sessions (existing project sessions keep working).
3. Create a session with `/new title:<title> project:<name>` (the choices list the directories under `~/workspace`; with more than 25 you type the name), or pick a project in the Web UI's "新しいセッション" dialog. Project sessions run with the default persona only.
4. When Claude wants to run a command or edit a file, the bot posts a permission card in that channel ([許可] / [このセッションでは常に許可] / [拒否]); you can also answer it on the session's tab in the Web UI. If nobody answers within `SELF_AGENT_CC_PERMISSION_HOLD_SEC` seconds it is denied. While a card is waiting, the turn's time limit does not run, and the progress message shows "許可を待っています: <tool>". [中断] denies the waiting request and stops the turn.

## Development

```bash
npm run check             # type check (tsc --noEmit; the code runs without a build step via Node's type stripping)
npm test                  # unit tests (fake Gateway / Runner and a temporary SQLite; no tokens needed)
npm run test:integration  # integration tests (call the real SDK when a Claude token is present; uses your allowance)
npm run measure           # measure time, memory and tokens for one turn
npm run github-dry-run    # fetch GitHub notifications once and print only the counts per class (posts nothing)
npm run cc-dry-run        # read the Claude Code sessions on this machine once and print them in three groups (posts nothing)
```

- Only three runtime dependencies (`@anthropic-ai/claude-agent-sdk`, `discord.js`, `zod`), pinned to exact versions.
- Conventions, the directory layout and the prompt caching rules are in [`CLAUDE.md`](CLAUDE.md).
- The system prompt is sent fresh on every request (`snapshot: false`), so changes reach existing sessions from their next turn. Changing the system prompt, adding tools or changing tool descriptions invalidates the cache once for every session, so batch such changes.
