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
cd tlme
npm link          # or: npm install -g .
```

This exposes a global `tlme` command. To develop without linking, run
`node index.js <question...>` from the project directory.

## Quick start

The fastest way in is the interactive wizard:

```bash
tlme setup
```

Navigate it with the **arrow keys** (↑/↓) and press **Enter** to choose — no
typing numbers. On the model list you can just **start typing to filter** (handy
when a provider exposes hundreds of models); the list scrolls automatically.
Ctrl+C cancels. (On terminals that don't support raw input, it falls back to a
numbered prompt.)

It lists the providers, asks which one you want, takes your API key (hidden as
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
tlme config set-key claude sk-ant-...
tlme config set-key openai sk-...
tlme config set-provider claude      # choose the default provider
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

### Quoting

Most questions need no quotes, but your shell treats a few characters specially
— `?`, `!`, `*`, `&`, `|`, `<`, `>`. If a question contains them, quote it:

```bash
tlme "what does chmod +x do?"
tlme 'is this regex correct: ^\d{3}-\d{4}$'
```

## Listing models

`tlme models` asks the provider's API which models your key can use:

```bash
tlme models                 # models for your default provider
tlme models openai          # models for a specific provider
tlme models openrouter | grep gpt-5   # piped output is one model id per line
```

In an interactive terminal it also lets you set one as your default with the same
arrow-key + type-to-filter picker; piped, it just prints the list (one id per
line) so it's easy to `grep`.

## Config commands

```bash
tlme setup                                # interactive: provider + key + model
tlme models [provider]                    # list models your key can use
tlme config set-key <provider> <key>      # save a key
tlme config set-provider <provider>       # set the default provider
tlme config set-model <provider> <model>  # set the default model for a provider
tlme config show                          # list providers, masked keys, models
tlme --help                               # full help
```

`config show` prints only **masked** keys (e.g. `sk-ant-tes...6789`) and whether
each came from an env var or the config file. The full key is never printed.

### Default models

Each provider has a sensible default you can override with `--model` or
`config set-model`. Model availability changes over time — if a call fails with
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
- **TTY-aware output.** ANSI colors only when writing to a terminal, so piping
  (`tlme ... | grep npx`) stays clean.

## Where keys are stored

`~/.tlme/config.json`, permission `600` (owner read/write only) on Unix-like
systems. On Windows the file lives under your home directory and inherits your
user's default ACLs.

## License

MIT
