# Project Brief: `tellme` — AI Terminal Assistant CLI

Build a complete, production-quality command-line tool called **tellme** that lets a user ask AI questions directly from their terminal and get streamed answers inline.

Example of the end result:

```bash
$ tellme how to create a nextjs repo in this directory
Run:

npx create-next-app@latest .

The dot creates the app in your current directory...
```

---

## 1. Tech Constraints

- **Runtime:** Node.js >= 18, ESM modules (`"type": "module"` in package.json)
- **Dependencies:** ZERO npm dependencies. Use native `fetch`, `node:fs`, `node:os`, `node:path`, `node:process`. Do not install axios, commander, chalk, dotenv, or anything else.
- **AI Provider:** Anthropic Messages API (`https://api.anthropic.com/v1/messages`)
- **Model:** `claude-sonnet-4-6`
- **Distribution:** Installable globally via `npm link` / `npm install -g .` using the `bin` field:
  ```json
  "bin": { "tellme": "./index.js" }
  ```
- `index.js` must start with the shebang `#!/usr/bin/env node` and be marked executable.

## 2. Project Structure

```
tellme/
├── index.js        # entire CLI — single file, well-commented, organized in sections
├── package.json
├── README.md       # user-facing docs: install, setup, usage, examples
└── .gitignore      # node_modules, .env
```

Keep it a single-file CLI. Organize `index.js` with clear section comments: config helpers → output helpers → commands → API call → entry point.

## 3. Commands & Behavior

### 3.1 `tellme <question...>`
- All args are joined with spaces into one question — no quotes required for normal questions.
- Sends the question to the Anthropic API with `stream: true` and prints text deltas to stdout **as they arrive** (live streaming, not wait-then-print).
- End with a single trailing newline.

### 3.2 `tellme config set-key <api-key>`
- Saves the key to `~/.tellme/config.json` (create the directory if missing).
- `chmod 600` the config file so only the user can read it.
- Confirm with the saved path.

### 3.3 `tellme config show`
- Prints whether a key is configured, **masked** (first 10 chars + last 4, e.g. `sk-ant-tes...6789`), its source (`env var` or `config file`), and the config file path.
- Never print the full key.

### 3.4 `tellme --help` / `-h` / no args
- Print a help screen: usage, all commands, 2–3 realistic examples, where to get an API key (https://console.anthropic.com/).

## 4. API Key Resolution

Priority order:
1. `ANTHROPIC_API_KEY` environment variable
2. `apiKey` field in `~/.tellme/config.json`

If neither exists when asking a question: print a clear error telling the user both ways to set a key, exit code 1. Never crash with a stack trace.

## 5. Anthropic API Call Details

Request:

```js
fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: question }],
    stream: true,
  }),
});
```

**System prompt** must instruct the model to:
- Act as a terminal assistant; be concise and practical
- Lead with the answer or exact command(s) to run
- Use plain text only — no markdown headers/bold (it renders raw in a terminal)
- And must inject live user context: `os.platform()`, `process.env.SHELL`, and `process.cwd()` — so "in this directory" style questions get tailored answers.

**SSE stream parsing** (no SDK — parse manually):
- Iterate `response.body` chunks with a `TextDecoder({ stream: true })`
- Buffer partial data; events are separated by `\n\n`, keep the incomplete tail in the buffer
- For each `data:` line, JSON.parse the payload (skip empty / `[DONE]` / unparseable)
- On `content_block_delta` with `delta.type === "text_delta"` → `process.stdout.write(delta.text)`
- On an `error` event → print the message to stderr and exit 1

## 6. Error Handling (all to stderr, exit code 1)

- **Network failure:** `Network error: <message>`
- **Non-2xx response:** parse the JSON body for `error.message`; print `API error (<status>): <detail>`. On **401**, additionally suggest `tellme config set-key <api-key>`.
- **Missing key:** actionable message (see §4)
- **Unknown config subcommand:** list valid ones (`set-key`, `show`)
- Wrap `main()` in a top-level catch — never show raw stack traces to the user.

## 7. Terminal Output Polish

- Use raw ANSI escape codes for bold/dim/red (no chalk). Example: `` (s) => `\x1b[1m${s}\x1b[0m` ``
- **Only apply colors when `process.stdout.isTTY` is true** — output must stay clean when piped (`tellme ... | grep npx`).

## 8. README.md Requirements

Include: one-line description, example terminal session, install steps (`npm link`), API key setup (both methods), usage examples, note about quoting shell-special characters (`?`, `!`, `*`), where the key is stored and its permissions, and a short "how it works" section (zero deps, native fetch, SSE streaming).

## 9. Acceptance Checklist (verify before finishing)

- [ ] `node index.js --help` prints help
- [ ] `node index.js config show` with no key says "No API key configured"
- [ ] `node index.js config set-key test123` saves and `config show` prints a masked key
- [ ] Config file has `600` permissions
- [ ] `node index.js some question` with an invalid key prints a clean 401 error with the fix suggestion, exit code 1
- [ ] No `node_modules` directory exists (zero dependencies)
- [ ] `npm link` makes the `tellme` command available globally

## 10. Nice-to-haves (only if everything above is done)

- Stdin pipe support: `cat error.log | tellme why is this failing` → prepend piped content to the question
- `--model <name>` flag to override the model per call
