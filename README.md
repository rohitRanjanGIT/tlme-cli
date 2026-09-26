# tlme

Ask AI questions straight from your terminal and get **streamed** answers inline.
Multi-provider — **Claude, OpenAI, Grok, Google AI Studio, OpenRouter** — with
**zero npm dependencies** (native `fetch` + `node:*` only).

```bash
$ tlme how to create a nextjs app in this directory
Run:

npx create-next-app@latest .

The dot creates the app in your current directory instead of a new subfolder.
```

## Install

Requires **Node.js >= 18**.

```bash
npm install -g tlme-cli
```

This exposes a global `tlme` command. To hack on it locally instead, clone the
repo and run `npm link` (or just `node index.js <question...>`) from the project
directory.

## Quick start

The fastest way in is the interactive wizard:

```bash
tlme --setup
```

It opens a clean, full-screen picker (think "connect a provider"): navigate with
the **arrow keys** (↑/↓), **type to filter**, and press **Enter** to choose —
no typing numbers. **Esc** goes back / cancels; **Ctrl+C** quits. On the model
list the type-to-filter is handy when a provider exposes hundreds of models; the
list scrolls automatically. (On terminals that don't support raw input, it falls
back to a numbered prompt.)

It lists the providers, asks which one you want, takes your API key (masked as
you type), makes it your default, and then — using that key — fetches the live
list of models you can actually use so you can pick a default. Then just ask:

```bash
tlme how do I undo the last git commit but keep changes
```

Prefer to do it by hand? See the manual setup below.

## Setup an API key

`tlme` supports five providers. Pick one (or several) and add a key. Keys resolve
in this order: **environment variable first, then the config file.**

| Provider   | `--provider`  | Env var(s)                              | Get a key |
|------------|---------------|-----------------------------------------|-----------|
| Claude     | `claude`      | `ANTHROPIC_API_KEY`                     | https://console.anthropic.com/settings/keys |
| OpenAI     | `openai`      | `OPENAI_API_KEY`                        | https://platform.openai.com/api-keys |
| Grok (xAI) | `grok`        | `XAI_API_KEY` / `GROK_API_KEY`          | https://console.x.ai/ |
| Google     | `google`      | `GEMINI_API_KEY` / `GOOGLE_API_KEY`     | https://aistudio.google.com/app/apikey |
| OpenRouter | `openrouter`  | `OPENROUTER_API_KEY`                    | https://openrouter.ai/keys |

Aliases work too: `anthropic`, `gpt`, `xai`, `gemini`, `googleaistudio`, `router`.

### Method 1 — config file (persisted, chmod 600)

```bash
tlme --config set-key claude sk-ant-...
tlme --config set-key openai sk-...
tlme --config set-provider claude      # choose the default provider
```

The first key you save automatically becomes the default provider. Keys are
stored in `~/.tlme/config.json`, locked to your user (`chmod 600` where the OS
supports it).

### Method 2 — environment variable (takes priority)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
```

## Usage

```bash
# Ask with the default provider — no quotes needed for normal questions
tlme how do I undo the last git commit but keep changes

# Pick a provider just for this call
tlme -p openai explain this stack trace in two sentences
tlme --provider grok what changed in HTTP/3

# Override the model per call
tlme --model claude-opus-4-8 give me refactor ideas for a big react file
tlme -p openrouter -m anthropic/claude-3.5-sonnet summarize REST vs gRPC

# Pipe input as context
cat error.log | tlme why is this failing
git diff | tlme write a commit message for this
```

### Piped input

`tlme` reads stdin when it isn't a terminal, so `cat error.log | tlme why is
this failing` works. It waits up to **2 seconds** for the first byte and then
reads to the end with no further limit, so large or slow producers are fine once
they start.

If a command is slow to emit its *first* output, raise the window:

```bash
TLME_STDIN_WAIT=15000 slow-build | tlme why did this fail
```

The wait exists because a terminal isn't the only thing that makes stdin
non-piped — a script or CI runner can hand over a stdin that is neither a
terminal nor ever closed, and waiting for its end would hang forever.

### Quoting

Most questions need no quotes, but your shell treats a few characters specially
— `?`, `!`, `*`, `&`, `|`, `<`, `>`. If a question contains them, quote it:

```bash
tlme "what does chmod +x do?"
tlme 'is this regex correct: ^\d{3}-\d{4}$'
```

## Listing models

`tlme --models` asks the provider's API which models your key can use:

```bash
tlme --models                 # models for your default provider
tlme --models openai          # models for a specific provider
tlme --models openrouter | grep gpt-5   # piped output is one model id per line
```

In an interactive terminal it also lets you set one as your default with the same
arrow-key + type-to-filter picker; piped, it just prints the list (one id per
line) so it's easy to `grep`.

## Conversation context

`tlme` remembers recent turns, so follow-ups just work:

```bash
$ tlme how do I undo the last git commit but keep changes
git reset --soft HEAD~1

$ tlme and if I want to discard them too
git reset --hard HEAD~1
```

A thread holds **10 exchanges** by default. The last few tick down a countdown,
and past the budget the oldest exchange rolls off — you never get blocked:

```
$ tlme ...
3 exchanges left in this context.  tlme --extend for 10 more
```

Widen it with `tlme --extend`, or just say so in plain words:

```bash
tlme --extend              # +10 exchanges
tlme --extend 25           # +25
tlme extend the context    # same thing, typed as a sentence
```

Only whole phrases like that are treated as the command. A real question that
happens to contain the words still reaches the model, so
`tlme how do I extend the context menu in vscode` gets answered normally.

```bash
tlme --history             # show the current thread and how full it is
tlme --history clear       # start over
tlme --no-history <q>      # one-off: don't read or record context
```

The countdown is written to **stderr and only on a terminal**, so piping is
unaffected — `tlme ... | grep npx` still sees only the answer.

### Scope — what "the conversation" means

| Scope | Behaviour |
|-------|-----------|
| `global` (default) | One thread shared by every terminal. Works everywhere. |
| `terminal` | One thread per terminal tab; closing it and opening a new tab starts fresh. |
| `directory` | One thread per working directory. |

```bash
tlme --config set-scope terminal
tlme --session              # which thread you're on, and why
```

`terminal` scope works by reading the session id your terminal exports —
`WT_SESSION` on Windows Terminal, `TERM_SESSION_ID` on macOS Terminal,
`ITERM_SESSION_ID`, `TMUX_PANE`, `KONSOLE_DBUS_SESSION`, `WINDOWID`. Terminals
that export none of those (**VS Code**, plain `conhost`, SSH, CI) fall back to
per-directory threads, and `tlme --session` says so when it happens. To pin a
session explicitly, export your own in your shell profile:

```bash
export TLME_SESSION=$$    # one thread per shell
```

Threads live in `~/.tlme/history/`, one JSON file each, `chmod 600` like the
config. They quote whatever you piped in, so each stored message is capped at
4 KB — a big `git diff` won't be replayed with every later question.

## Config commands

```bash
tlme --setup                                # interactive: provider + key + model
tlme --models [provider]                    # list models your key can use
tlme --config set-key <provider> <key>      # save a key
tlme --config set-provider <provider>       # set the default provider
tlme --config set-model <provider> <model>  # set the default model for a provider
tlme --config set-scope <scope>             # global | terminal | directory
tlme --config set-history <n|on|off>        # exchanges per block, or turn it off
tlme --config show                          # providers, masked keys, models, context
tlme --history [clear]                      # show or reset the current thread
tlme --extend [n]                           # widen the current context
tlme --session                              # which thread this terminal maps to
tlme --help                                 # full help
```

`--config show` prints only **masked** keys (e.g. `sk-ant-tes...6789`) and
whether each came from an env var or the config file. The full key is never
printed.

### Default models

Each provider has a sensible default you can override with `--model` or
`--config set-model`. Model availability changes over time — if a call fails with
an "unknown model" error, set a current one:

| Provider   | Default model        |
|------------|----------------------|
| Claude     | `claude-sonnet-4-6`  |
| OpenAI     | `gpt-4o`             |
| Grok       | `grok-2-latest`      |
| Google     | `gemini-2.0-flash`   |
| OpenRouter | `openai/gpt-4o`      |

## How it works

- **Zero dependencies.** Native `fetch`, `node:fs`, `node:os`, `node:path`,
  `node:process`. No axios, commander, chalk, or dotenv.
- **Live streaming.** Requests use `stream: true` and the tool parses the
  Server-Sent Events stream by hand, writing text deltas to stdout as they
  arrive — you read the answer while it's being generated.
- **One dialect, many providers.** OpenAI, Grok, and OpenRouter share the
  OpenAI chat-completions format; Claude and Gemini each get their own request
  builder and delta extractor.
- **Context-aware.** The system prompt injects your OS, shell, and current
  directory so "in this directory" questions get tailored commands.
- **Stateful across invocations.** Each run is a separate process, so the
  conversation is persisted to `~/.tlme/history/` and replayed on the next
  call. Only complete exchanges are written, and only after a successful
  answer — a failed call can't leave a half-turn that would break the
  user/assistant alternation Claude and Gemini require.
- **TTY-aware output.** ANSI colors only when writing to a terminal, so piping
  (`tlme ... | grep npx`) stays clean.

## Where keys and history are stored

`~/.tlme/config.json`, permission `600` (owner read/write only) on Unix-like
systems. On Windows the file lives under your home directory and inherits your
user's default ACLs.

Conversation threads sit alongside it in `~/.tlme/history/`, same permissions.
Nothing is ever written into the directory you run `tlme` from.

## License

MIT
