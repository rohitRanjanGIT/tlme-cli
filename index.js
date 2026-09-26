#!/usr/bin/env node
// tlme — ask AI questions straight from your terminal.
// Multi-provider (Claude, OpenAI, Grok, Google AI Studio, OpenRouter).
// Zero npm dependencies: native fetch + node:* only. ESM.
//
// Sections:
//   1. Provider registry
//   2. Config helpers      (~/.tlme/config.json)
//   2b. Conversation history (~/.tlme/history/<thread>.json)
//   3. Key resolution
//   4. Output helpers       (ANSI, TTY-aware)
//   5. System prompt
//   6. API call + SSE streaming
//   7. Commands             (config, help)
//   8. Arg parsing + entry point

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 1. Provider registry
// ---------------------------------------------------------------------------
// Each provider knows how to build a streaming request and how to pull text
// deltas / errors out of the parsed SSE JSON. OpenAI, Grok and OpenRouter all
// speak the same OpenAI "chat/completions" dialect, so they share a builder.

const MAX_TOKENS = 1024;

function openAICompatible({ url, defaultModel, keyHint, extraHeaders = {} }) {
  return {
    defaultModel,
    keyHint,
    build(apiKey, model, system, messages) {
      return {
        url,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          ...extraHeaders,
        },
        body: {
          model,
          max_tokens: MAX_TOKENS,
          // Prior turns sit between the system prompt and the new question.
          messages: [{ role: "system", content: system }, ...messages],
          stream: true,
        },
      };
    },
    // returns text delta ("" if none) for a parsed SSE JSON object
    extractDelta: (o) => o?.choices?.[0]?.delta?.content || "",
    // returns an error message string if the event is an error, else null
    extractError: (o) => o?.error?.message || null,
    // returns a finish reason string when the turn ends, else null
    extractFinish: (o) => o?.choices?.[0]?.finish_reason || null,
    // GET request for listing the models available to this key
    modelsRequest: (apiKey) => ({
      url: url.replace(/\/chat\/completions$/, "/models"),
      headers: { authorization: `Bearer ${apiKey}`, ...extraHeaders },
    }),
    parseModels: (j) => (j?.data || []).map((m) => m.id).filter(Boolean),
  };
}

const PROVIDERS = {
  claude: {
    label: "Claude (Anthropic)",
    envVars: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-sonnet-4-6",
    keyHint: "https://console.anthropic.com/settings/keys",
    build(apiKey, model, system, messages) {
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model,
          max_tokens: MAX_TOKENS,
          system,
          // Must alternate user/assistant and open on a user turn — guaranteed
          // by only ever appending complete exchanges (see appendExchange).
          messages,
          stream: true,
        },
      };
    },
    extractDelta: (o) =>
      o?.type === "content_block_delta" && o?.delta?.type === "text_delta"
        ? o.delta.text
        : "",
    extractError: (o) => (o?.type === "error" ? o?.error?.message || "unknown error" : null),
    extractFinish: (o) => (o?.type === "message_delta" ? o?.delta?.stop_reason || null : null),
    modelsRequest: (apiKey) => ({
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    }),
    parseModels: (j) => (j?.data || []).map((m) => m.id).filter(Boolean),
  },

  openai: {
    label: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    keyHint: "https://platform.openai.com/api-keys",
    ...openAICompatible({
      url: "https://api.openai.com/v1/chat/completions",
      defaultModel: "gpt-4o",
      keyHint: "https://platform.openai.com/api-keys",
    }),
  },

  grok: {
    label: "Grok (xAI)",
    envVars: ["XAI_API_KEY", "GROK_API_KEY"],
    keyHint: "https://console.x.ai/",
    ...openAICompatible({
      url: "https://api.x.ai/v1/chat/completions",
      defaultModel: "grok-2-latest",
      keyHint: "https://console.x.ai/",
    }),
  },

  openrouter: {
    label: "OpenRouter",
    envVars: ["OPENROUTER_API_KEY"],
    keyHint: "https://openrouter.ai/keys",
    ...openAICompatible({
      url: "https://openrouter.ai/api/v1/chat/completions",
      defaultModel: "openai/gpt-4o",
      keyHint: "https://openrouter.ai/keys",
      extraHeaders: {
        "HTTP-Referer": "https://github.com/tlme-cli",
        "X-Title": "tlme",
      },
    }),
  },

  google: {
    label: "Google AI Studio (Gemini)",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_AI_STUDIO_API_KEY"],
    defaultModel: "gemini-2.0-flash",
    keyHint: "https://aistudio.google.com/app/apikey",
    build(apiKey, model, system, messages) {
      // Gemini streams SSE when ?alt=sse is set; key travels as a query param.
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
        `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      return {
        url,
        headers: { "content-type": "application/json" },
        body: {
          system_instruction: { parts: [{ text: system }] },
          // Gemini names the assistant role "model" rather than "assistant".
          contents: messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
        },
      };
    },
    // Skip "thought" parts — thinking models (e.g. Gemma) stream their raw
    // reasoning tagged thought:true; only the plain parts are the answer.
    extractDelta: (o) =>
      (o?.candidates?.[0]?.content?.parts || [])
        .filter((p) => !p.thought)
        .map((p) => p?.text || "")
        .join(""),
    extractError: (o) => o?.error?.message || null,
    extractFinish: (o) => o?.candidates?.[0]?.finishReason || null,
    modelsRequest: (apiKey) => ({
      url:
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=" +
        encodeURIComponent(apiKey),
      headers: {},
    }),
    // Only keep models that can actually answer a prompt, strip the "models/" prefix.
    parseModels: (j) =>
      (j?.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => (m.name || "").replace(/^models\//, ""))
        .filter(Boolean),
  },
};

// Friendly aliases → canonical provider id.
const ALIASES = {
  anthropic: "claude",
  claude: "claude",
  openai: "openai",
  gpt: "openai",
  chatgpt: "openai",
  grok: "grok",
  xai: "grok",
  google: "google",
  gemini: "google",
  googleaistudio: "google",
  googleaistudios: "google",
  aistudio: "google",
  openrouter: "openrouter",
  router: "openrouter",
};

function resolveProviderId(name) {
  if (!name) return null;
  return ALIASES[String(name).toLowerCase()] || null;
}

// ---------------------------------------------------------------------------
// 2. Config helpers
// ---------------------------------------------------------------------------
const CONFIG_DIR = path.join(os.homedir(), ".tlme");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// Shape: { provider, keys: {...}, models: {...}, history: {enabled, scope, block} }
const HISTORY_DEFAULTS = { enabled: true, scope: "global", block: 10 };
const SCOPES = ["global", "terminal", "directory"];

// Accept only a well-formed history block; anything odd falls back to defaults
// so a hand-edited config can't produce a nonsense scope or a zero budget.
function normalizeHistory(h) {
  if (!h || typeof h !== "object") return { ...HISTORY_DEFAULTS };
  const scope = SCOPES.includes(h.scope) ? h.scope : HISTORY_DEFAULTS.scope;
  const block =
    Number.isInteger(h.block) && h.block > 0 && h.block <= 200
      ? h.block
      : HISTORY_DEFAULTS.block;
  return { enabled: h.enabled !== false, scope, block };
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    return {
      provider: cfg.provider || null,
      keys: cfg.keys && typeof cfg.keys === "object" ? cfg.keys : {},
      models: cfg.models && typeof cfg.models === "object" ? cfg.models : {},
      history: normalizeHistory(cfg.history),
    };
  } catch {
    return { provider: null, keys: {}, models: {}, history: { ...HISTORY_DEFAULTS } };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  // Lock down to owner-only. No-op on filesystems that don't support it.
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* ignore (e.g. Windows) */
  }
}

// ---------------------------------------------------------------------------
// 2b. Conversation history
// ---------------------------------------------------------------------------
// Each invocation is its own process, so "remembering" means persisting the
// thread to disk and replaying it on the next call.
//
// A thread is keyed by scope:
//   global    — one conversation everywhere. Needs no session detection at all,
//               so it behaves identically in every terminal, IDE and over SSH.
//   terminal  — one per terminal tab, keyed off the session id the emulator
//               exports (WT_SESSION etc). Falls back to directory where there
//               isn't one, e.g. VS Code, plain conhost, SSH, CI.
//   directory — one per working directory.
//
// Budget: a thread holds `block` exchanges (default 10). The last few tick down
// a countdown; past the budget the oldest exchange rolls off. --extend grants
// another block.

const HISTORY_DIR = path.join(CONFIG_DIR, "history");
const WARN_WITHIN = 3; // start the countdown when this many exchanges remain
const MAX_STORED_CHARS = 4000; // per message — see clip()

// Session ids exported once per tab/pane and inherited by every child process.
// First hit wins; TLME_SESSION is the manual override for terminals that export
// nothing usable (`export TLME_SESSION=$$` in a shell profile).
const SESSION_VARS = [
  "TLME_SESSION",
  "WT_SESSION", // Windows Terminal
  "TERM_SESSION_ID", // macOS Terminal.app
  "ITERM_SESSION_ID", // iTerm2
  "TMUX_PANE", // tmux
  "KONSOLE_DBUS_SESSION", // Konsole
  "WINDOWID", // X11
];

function sessionSource() {
  for (const v of SESSION_VARS) {
    if (process.env[v]) return { via: v, value: process.env[v] };
  }
  return null;
}

// Resolve which thread this invocation belongs to.
function threadScope(cfg) {
  const scope = cfg.history.scope;
  if (scope === "directory") {
    return { key: `dir:${process.cwd()}`, label: `directory — ${process.cwd()}` };
  }
  if (scope === "terminal") {
    const s = sessionSource();
    if (s) return { key: `tty:${s.value}`, label: `terminal — via ${s.via}` };
    // Degrade instead of collapsing every terminal into one shared thread.
    return {
      key: `dir:${process.cwd()}`,
      label: `directory — ${process.cwd()}`,
      note: "no terminal session id here, so this is per-directory instead",
    };
  }
  return { key: "global", label: "global — shared by every terminal" };
}

function threadPath(key) {
  const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
  return path.join(HISTORY_DIR, `${hash}.json`);
}

// Piped context (a long diff, a stack trace) would otherwise be replayed with
// every later question in the thread. Store a bounded prefix instead.
function clip(text) {
  const s = String(text);
  if (s.length <= MAX_STORED_CHARS) return s;
  return s.slice(0, MAX_STORED_CHARS) + "\n…[truncated]";
}

// Keep only well-formed turns: a hand-edited or partially-written file must not
// produce a request body the API will reject.
function sanitize(messages) {
  if (!Array.isArray(messages)) return [];
  const out = messages.filter(
    (m) =>
      m &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.length > 0
  );
  // Claude and Gemini both require the thread to open on a user turn.
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function loadThread(cfg) {
  const scope = threadScope(cfg);
  const file = threadPath(scope.key);
  let messages = [];
  let budget = cfg.history.block;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    messages = sanitize(raw.messages);
    if (Number.isInteger(raw.budget) && raw.budget > 0 && raw.budget <= 500) {
      budget = raw.budget;
    }
  } catch {
    /* missing or unreadable → start a clean thread */
  }
  return { ...scope, file, budget, messages };
}

function saveThread(thread) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const body = {
    scope: thread.label,
    budget: thread.budget,
    updated: new Date().toISOString(),
    messages: thread.messages,
  };
  fs.writeFileSync(thread.file, JSON.stringify(body, null, 2) + "\n", "utf8");
  // Threads quote whatever you piped in, so lock them down like the key file.
  try {
    fs.chmodSync(thread.file, 0o600);
  } catch {
    /* ignore (e.g. Windows) */
  }
}

// Append one completed exchange and roll the oldest off when over budget.
//
// Two deliberate choices here:
//  * Only complete pairs are ever written, and only after a successful answer.
//    A half-written turn would break the user/assistant alternation that Claude
//    and Gemini require, poisoning every later call in the thread.
//  * The thread is re-read first rather than reusing the copy loaded before the
//    API call. That call takes seconds, during which another terminal may have
//    written; re-reading shrinks the clobber window to milliseconds.
function appendExchange(cfg, question, answer) {
  const thread = loadThread(cfg);
  thread.messages.push(
    { role: "user", content: clip(question) },
    { role: "assistant", content: clip(answer) }
  );
  const max = thread.budget * 2;
  let rolled = 0;
  if (thread.messages.length > max) {
    rolled = (thread.messages.length - max) / 2;
    thread.messages = thread.messages.slice(-max);
  }
  saveThread(thread);
  return { thread, rolled };
}

function clearThread(cfg) {
  const thread = loadThread(cfg);
  try {
    fs.unlinkSync(thread.file);
  } catch {
    /* already gone */
  }
  return thread;
}

// Grant another block of exchanges to the current thread.
function extendThread(cfg, by) {
  const thread = loadThread(cfg);
  thread.budget += by;
  saveThread(thread);
  return thread;
}

// Countdown as the thread fills. stderr + TTY-only: stdout stays clean so
// `tlme ... | grep npx` is unaffected.
function budgetNotice(thread, rolled, block) {
  if (!process.stderr.isTTY) return;
  const used = thread.messages.length / 2;
  const left = thread.budget - used;
  let msg;
  if (rolled > 0 || left <= 0) {
    msg =
      `context full at ${thread.budget} exchanges — oldest now rolling off.  ` +
      `tlme --extend for ${block} more, tlme --history clear to start over`;
  } else if (left <= WARN_WITHIN) {
    msg =
      `${left} exchange${left === 1 ? "" : "s"} left in this context.  ` +
      `tlme --extend for ${block} more`;
  } else {
    return;
  }
  process.stderr.write(dim(msg) + "\n");
}

// A bare "extend the context" is treated as a command rather than a question.
// Matched against the WHOLE input only: a real question that merely contains
// these words ("how do I extend the context menu in vscode") must still reach
// the model, so we never pattern-match inside longer input.
const EXTEND_PATTERNS = [
  /^(?:please[ ]+)?(?:extend|increase|widen|expand|grow)(?:[ ]+(?:the|my|this))?[ ]+context(?:[ ]+(?:window|size|limit))?(?:[ ]+by[ ]+([0-9]+))?[ ]*[.!]?$/i,
  /^(?:give[ ]+me[ ]+)?(?:some[ ]+)?more[ ]+context(?:[ ]+please)?[ ]*[.!]?$/i,
];

// Returns the number of exchanges to add, or null if this isn't such a request.
function extendRequest(question, block) {
  const q = question.trim();
  for (const re of EXTEND_PATTERNS) {
    const m = re.exec(q);
    if (!m) continue;
    const by = m[1] ? Number(m[1]) : block;
    return by > 0 && by <= 200 ? by : block;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Key resolution — env var wins over config file
// ---------------------------------------------------------------------------
function resolveKey(providerId, cfg) {
  const provider = PROVIDERS[providerId];
  for (const envVar of provider.envVars) {
    if (process.env[envVar]) {
      return { key: process.env[envVar], source: `env var (${envVar})` };
    }
  }
  if (cfg.keys[providerId]) {
    return { key: cfg.keys[providerId], source: "config file" };
  }
  return { key: null, source: null };
}

function resolveModel(providerId, cfg, override) {
  if (override) return override;
  return cfg.models[providerId] || PROVIDERS[providerId].defaultModel;
}

// ---------------------------------------------------------------------------
// 4. Output helpers (TTY-aware ANSI)
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = wrap("1");
const dim = wrap("2");
const red = wrap("31");
const cyan = wrap("36");

// Sentinel used to unwind out of any depth after we've already reported an
// error. We deliberately avoid process.exit(): on Windows, calling it while a
// fetch/undici socket handle is still closing trips a libuv assertion
// (UV_HANDLE_CLOSING). Setting exitCode and letting the loop drain is clean.
class ExitSignal extends Error {}

function fail(msg) {
  process.stderr.write(red("Error: ") + msg + "\n");
  process.exitCode = 1;
  throw new ExitSignal(msg);
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 14) return key.slice(0, 4) + "…";
  return `${key.slice(0, 10)}...${key.slice(-4)}`;
}

// --- Rich TUI palette (256-color) for the setup panels ---------------------
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visLen = (s) => stripAnsi(s).length;
const REV = (s) => (useColor ? `\x1b[7m${s}\x1b[0m` : s); // cursor block
const fg256 = (n) => (s) => (useColor ? `\x1b[38;5;${n}m${s}\x1b[0m` : s);
const section = (s) => (useColor ? `\x1b[1;38;5;140m${s}\x1b[0m` : s); // purple header
const desc = fg256(244); // dim gray descriptions
const hintc = fg256(244); // footer hints
const check = fg256(114); // green ✓
// Selected row: peach background, near-black text; plain ">" prefix without color.
const selBar = (s) => (useColor ? `\x1b[48;5;216m\x1b[38;5;16m${s}\x1b[0m` : `>${s}`);

// Alternate-screen control so the panels render like a modal and leave the
// scrollback clean on exit.
const ALT = { enter: "\x1b[?1049h", exit: "\x1b[?1049l", hide: "\x1b[?25l", show: "\x1b[?25h" };
let _altActive = false;
function enterAlt() {
  process.stdout.write(ALT.enter + ALT.hide);
  _altActive = true;
}
function exitAlt() {
  if (_altActive) {
    process.stdout.write(ALT.show + ALT.exit);
    _altActive = false;
  }
}
function panelWidth() {
  return Math.min(process.stdout.columns || 80, 88);
}
function panelRows() {
  return Math.max(6, (process.stdout.rows || 24) - 8);
}

// ---------------------------------------------------------------------------
// 4b. Interactive prompts (native readline — no dependencies)
// ---------------------------------------------------------------------------
function requireTTY(what) {
  if (!process.stdin.isTTY) {
    fail(`${what} is interactive — run it in a terminal (not piped).`);
  }
}

// One shared readline interface per interactive command, with a line queue so
// no input is dropped between prompts (rl.question only catches the *next* line;
// bulk/pasted input would otherwise be lost). A mute flag hides the API key by
// suppressing echo while it's typed.
let _rl = null;
let _lineQueue = [];
let _lineWaiter = null;
let _mute = false;
let _closed = false;

function getRL() {
  if (!_rl) {
    _closed = false;
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const write = _rl._writeToOutput.bind(_rl);
    _rl._writeToOutput = (s) => {
      if (!_mute) write(s);
    };
    _rl.on("line", (line) => {
      if (_lineWaiter) {
        const w = _lineWaiter;
        _lineWaiter = null;
        w(line);
      } else {
        _lineQueue.push(line);
      }
    });
    // stdin EOF (e.g. piped input runs out): unblock any waiter with "".
    _rl.on("close", () => {
      _closed = true;
      if (_lineWaiter) {
        const w = _lineWaiter;
        _lineWaiter = null;
        w("");
      }
    });
  }
  return _rl;
}

function closePrompts() {
  if (_rl) {
    _rl.close();
    _rl = null;
    _lineQueue = [];
    _lineWaiter = null;
    _mute = false;
    _closed = false;
  }
}

function nextLine() {
  return new Promise((resolve) => {
    if (_lineQueue.length) resolve(_lineQueue.shift());
    else if (_closed) resolve("");
    else _lineWaiter = resolve;
  });
}

// Print a prompt. Uses readline's redraw on a live terminal; falls back to a
// plain write once stdin has closed (bulk-piped input) so we don't touch a
// closed interface.
function showPrompt(query) {
  const rl = getRL();
  if (_closed) {
    process.stdout.write(query);
  } else {
    rl.setPrompt(query);
    rl.prompt();
  }
}

// Ask a visible question and return the trimmed answer.
async function ask(query) {
  showPrompt(query);
  return (await nextLine()).trim();
}

// Ask for a secret (API key) without echoing it to the screen.
async function askHidden(query) {
  showPrompt(query); // prints before muting
  _mute = true;
  const line = await nextLine();
  _mute = false;
  process.stdout.write("\n");
  return line.trim();
}

// ---------------------------------------------------------------------------
// 4c. Raw-mode UI (arrow-key menu + masked input) — used on real terminals.
//     Falls back to the line-based prompts above where raw mode isn't possible.
// ---------------------------------------------------------------------------
function canRaw() {
  return Boolean(process.stdin.isTTY) && typeof process.stdin.setRawMode === "function";
}

// Extract the printable characters from a keypress string (handles paste).
function printableOf(str) {
  if (!str) return "";
  return [...str].filter((c) => c >= " " && c !== "\x7f").join("");
}

// Render one panel frame: home the cursor, write each line clearing to EOL,
// then clear anything below. Called on every keypress.
function paintPanel(lines) {
  let out = "\x1b[H";
  for (const ln of lines) out += ln + "\x1b[K\n";
  out += "\x1b[0J";
  process.stdout.write(out);
}

// The title bar: bold title on the left, "esc" affordance on the right.
function panelTitleLine(title, cols) {
  const pad = Math.max(1, cols - 4 - title.length - 3 - 3);
  return "    " + bold(title) + " ".repeat(pad) + dim("esc");
}

// The search input line: placeholder (dim, with a cursor block on the first
// char) when empty, otherwise the typed query followed by a cursor block.
function panelSearchLine(query, placeholder) {
  if (!query) return "    " + REV(placeholder[0]) + desc(placeholder.slice(1));
  return "    " + query + REV(" ");
}

// OpenCode-style modal picker. `groups` is [{ name, items: [{label, desc,
// value, current}] }]. Renders section headers, a search/filter box and a
// full-width highlight on the selected row. Resolves the chosen item's `value`,
// or null on Escape. Ctrl-C hard-cancels (exit 130).
function panelSelect({ title, placeholder = "Search", groups, current = 0, footer }) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;

    // Flatten items (keeping group tags) for navigation + filtering.
    const flat = [];
    for (const g of groups) for (const it of g.items) flat.push({ ...it, _group: g.name });
    let query = "";
    let items = flat;
    let index = Math.max(0, Math.min(current, items.length - 1));

    const refilter = () => {
      const q = query.toLowerCase();
      items = flat.filter((it) => `${it.label} ${it.desc || ""}`.toLowerCase().includes(q));
      if (index >= items.length) index = items.length - 1;
      if (index < 0) index = 0;
    };

    const draw = () => {
      // Read size on every draw so the panel reflows when the window resizes.
      const cols = panelWidth();
      const barW = cols - 2;
      const rows = panelRows();

      // Build the display list (section headers interleaved with items).
      const disp = [];
      let g = null;
      items.forEach((it, i) => {
        if (it._group !== g) {
          disp.push({ kind: "section", label: it._group });
          g = it._group;
        }
        disp.push({ kind: "item", it, i });
      });

      // Viewport: window `disp` around the selected item when it overflows.
      let selDisp = disp.findIndex((d) => d.kind === "item" && d.i === index);
      if (selDisp < 0) selDisp = 0;
      let start = 0;
      if (disp.length > rows) {
        start = Math.max(0, Math.min(selDisp - Math.floor(rows / 2), disp.length - rows));
      }
      const end = Math.min(disp.length, start + rows);

      const lines = [panelTitleLine(title, cols), "", panelSearchLine(query, placeholder), ""];
      if (items.length === 0) {
        lines.push("    " + desc("No matches"));
      } else {
        if (start > 0) lines.push("    " + desc(`↑ ${start} more`));
        for (let r = start; r < end; r++) {
          const d = disp[r];
          if (d.kind === "section") {
            lines.push("    " + section(d.label));
            continue;
          }
          const it = d.it;
          const mark = it.current ? "✓" : " ";
          if (d.i === index) {
            let bar = ` ${mark} ${it.label}${it.desc ? "  " + it.desc : ""}`;
            bar = bar.slice(0, barW).padEnd(barW);
            lines.push(" " + selBar(bar));
          } else {
            const m = it.current ? check("✓") : " ";
            lines.push(`  ${m} ${it.label}${it.desc ? "  " + desc(it.desc) : ""}`);
          }
        }
        if (end < disp.length) lines.push("    " + desc(`↓ ${disp.length - end} more`));
      }
      lines.push("");
      lines.push("    " + hintc(footer || "↑/↓ navigate   enter select   esc cancel   type to filter"));
      paintPanel(lines);
    };

    const onResize = () => draw();
    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      process.stdout.removeListener("resize", onResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      exitAlt();
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exitCode = 130;
        reject(new ExitSignal("cancelled"));
        return;
      }
      if (key.name === "escape") {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (!items.length) return;
        cleanup();
        resolve(items[index].value);
        return;
      }
      if (!items.length && key.name !== "backspace" && !printableOf(str)) return;
      const step = panelRows();
      if (key.name === "up") index = index > 0 ? index - 1 : items.length - 1;
      else if (key.name === "down") index = index < items.length - 1 ? index + 1 : 0;
      else if (key.name === "pageup") index = Math.max(0, index - step);
      else if (key.name === "pagedown") index = Math.min(items.length - 1, index + step);
      else if (key.name === "home") index = 0;
      else if (key.name === "end") index = items.length - 1;
      else if (key.name === "backspace") {
        if (!query) return;
        query = query.slice(0, -1);
        refilter();
      } else {
        const add = printableOf(str);
        if (!add) return;
        query += add;
        index = 0;
        refilter();
      }
      draw();
    };

    enterAlt();
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    process.stdout.on("resize", onResize);
    draw();
  });
}

// OpenCode-style single-field input panel (used for the API key). Masks input
// with • by default. Resolves the trimmed value, or null on Escape.
function panelInput({ title, placeholder = "Value", mask = true, footer = "enter submit   esc cancel" }) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";

    const draw = () => {
      const cols = panelWidth(); // re-read so the title bar reflows on resize
      let inputLine;
      if (!value) inputLine = "    " + REV(placeholder[0]) + desc(placeholder.slice(1));
      else inputLine = "    " + (mask ? "•".repeat(value.length) : value) + REV(" ");
      paintPanel([panelTitleLine(title, cols), "", inputLine, "", "", "    " + hintc(footer)]);
    };

    const onResize = () => draw();
    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      process.stdout.removeListener("resize", onResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      exitAlt();
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exitCode = 130;
        reject(new ExitSignal("cancelled"));
        return;
      }
      if (key.name === "escape") {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(value.trim());
        return;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        draw();
        return;
      }
      const add = printableOf(str);
      if (add) {
        value += add;
        draw();
      }
    };

    enterAlt();
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    process.stdout.on("resize", onResize);
    draw();
  });
}

// GET the list of model ids available to a key. Same fail() semantics as chat.
async function fetchModels(providerId, key) {
  const provider = PROVIDERS[providerId];
  const { url, headers } = provider.modelsRequest(key);

  let res;
  try {
    res = await fetch(url, { method: "GET", headers });
  } catch (e) {
    fail(`Network error: ${e.message}`);
  }

  if (!res.ok) {
    let detail = res.statusText || "request failed";
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || detail;
    } catch {
      /* not JSON */
    }
    let msg = `API error (${res.status}) from ${provider.label}: ${detail}`;
    if (res.status === 401 || res.status === 403) {
      msg += `\n\nCheck your key:  ${bold(`tlme --config set-key ${providerId} <your-key>`)}`;
    }
    fail(msg);
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    fail(`Could not parse model list from ${provider.label}: ${e.message}`);
  }
  return provider.parseModels(json).sort();
}

// ---------------------------------------------------------------------------
// 5. System prompt (injects live user context)
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
  const platform = os.platform();
  const shell = process.env.SHELL || process.env.ComSpec || "unknown";
  const cwd = process.cwd();
  return [
    "You are tlme, a terminal assistant. Be concise and practical.",
    "Lead with the direct answer or the exact command(s) to run, then a short explanation only if needed.",
    "Output plain text only — no markdown headers, bold, or backtick fences; it renders raw in a terminal.",
    "Assume the user is on the command line and wants to act immediately.",
    "",
    "User environment (use it to tailor commands, e.g. \"in this directory\"):",
    `- OS platform: ${platform}`,
    `- Shell: ${shell}`,
    `- Current directory: ${cwd}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 6. API call + manual SSE streaming
// ---------------------------------------------------------------------------
async function askQuestion(question, { providerId, cfg, modelOverride, useHistory = true }) {
  const provider = PROVIDERS[providerId];
  const { key } = resolveKey(providerId, cfg);

  if (!key) {
    const envList = provider.envVars.map((v) => `  export ${v}=<your-key>`).join("\n");
    fail(
      `No API key configured for ${provider.label}.\n\n` +
        `Set one either way:\n` +
        `  1. Environment variable:\n${envList}\n` +
        `  2. Config:  ${bold(`tlme --config set-key ${providerId} <your-key>`)}\n\n` +
        `Get a key: ${provider.keyHint}`
    );
  }

  const model = resolveModel(providerId, cfg, modelOverride);
  const system = buildSystemPrompt();

  // Replay the thread, then this question. A disabled or suppressed history
  // just means an empty prior-turn list — the request shape is the same.
  const remember = useHistory && cfg.history.enabled;
  const thread = remember ? loadThread(cfg) : null;
  const messages = [
    ...(thread ? thread.messages : []),
    { role: "user", content: question },
  ];
  const { url, headers, body } = provider.build(key, model, system, messages);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(`Network error: ${e.message}`);
  }

  if (!res.ok) {
    let detail = res.statusText || "request failed";
    try {
      const errBody = await res.json();
      detail = errBody?.error?.message || errBody?.message || detail;
    } catch {
      /* body wasn't JSON */
    }
    let msg = `API error (${res.status}) from ${provider.label}: ${detail}`;
    if (res.status === 401 || res.status === 403) {
      msg += `\n\nCheck your key:  ${bold(`tlme --config set-key ${providerId} <your-key>`)}`;
    }
    fail(msg);
  }

  const answer = await streamSSE(res, provider, providerId, model);

  // Record only after a successful answer, so a failed call never leaves a
  // dangling user turn that would break user/assistant alternation.
  if (remember && answer.trim()) {
    const { thread: updated, rolled } = appendExchange(cfg, question, answer);
    budgetNotice(updated, rolled, cfg.history.block);
  }
}

// Find the next SSE event boundary (a blank line) regardless of line-ending
// style: real servers use CRLF (\r\n\r\n), our mocks/others use \n\n or \r\r.
function nextEventBoundary(buf) {
  let at = -1;
  let len = 0;
  for (const sep of ["\r\n\r\n", "\n\n", "\r\r"]) {
    const i = buf.indexOf(sep);
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
      len = sep.length;
    }
  }
  return { at, len };
}

// Iterate the response body, frame SSE events on blank lines, and print deltas.
async function streamSSE(res, provider, providerId, model) {
  const decoder = new TextDecoder();
  let buffer = "";
  let wroteAnything = false;
  let lastFinish = null;
  let answer = ""; // accumulated so the turn can be saved to history

  // Parse one framed SSE event: pull data: lines, surface errors, print deltas.
  const handleEvent = (rawEvent) => {
    for (const line of rawEvent.split(/\r\n|\r|\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let obj;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue; // partial or non-JSON keep-alive; skip
      }

      const errMsg = provider.extractError(obj);
      if (errMsg) {
        if (wroteAnything) process.stdout.write("\n");
        fail(`Stream error: ${errMsg}`);
      }

      if (provider.extractFinish) {
        const f = provider.extractFinish(obj);
        if (f) lastFinish = f;
      }

      const text = provider.extractDelta(obj);
      if (text) {
        process.stdout.write(text);
        answer += text;
        wroteAnything = true;
      }
    }
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });

    // Events are separated by a blank line; keep the incomplete tail buffered.
    let b;
    while ((b = nextEventBoundary(buffer)).at !== -1) {
      handleEvent(buffer.slice(0, b.at));
      buffer = buffer.slice(b.at + b.len);
    }
  }

  // A final event may arrive without a trailing blank line — flush it.
  if (buffer.trim()) handleEvent(buffer);

  if (!wroteAnything) {
    // A 200 that streamed no answer text: a safety/length stop, a
    // thinking-only model that never emitted a plain answer, etc. Don't exit 0
    // silently — say what happened and how to fix it.
    const normal = new Set(["stop", "STOP", "end_turn", "length", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"]);
    let msg = `${PROVIDERS[providerId].label} returned no answer text for model "${model}".`;
    if (lastFinish && !normal.has(lastFinish)) msg += ` (finish reason: ${lastFinish})`;
    msg += `\nTry another model:  ${bold(`tlme --models ${providerId}`)}`;
    fail(msg);
  }

  // Trailing newline so the shell prompt lands on its own line.
  process.stdout.write("\n");
  return answer;
}

// ---------------------------------------------------------------------------
// 7. Commands
// ---------------------------------------------------------------------------

// `tlme setup` — interactive: pick a provider, paste a key, optionally choose a
// default model (validated against the provider's live model list).
async function cmdSetup() {
  requireTTY("tlme --setup");
  try {
    await runSetup();
  } finally {
    closePrompts(); // release stdin so the process can exit
  }
}

// Short tagline shown next to each provider on the connect screen, and which
// section it sits under. Order here is the on-screen order.
const PROVIDER_SETUP = {
  claude: { group: "Popular", desc: "(Recommended)" },
  openai: { group: "Popular", desc: "(ChatGPT Plus/Pro or API key)" },
  google: { group: "Popular", desc: "AI Studio (Gemini)" },
  grok: { group: "More", desc: "(xAI API key)" },
  openrouter: { group: "More", desc: "(one key, many models)" },
};

async function runSetup() {
  const ids = Object.keys(PROVIDER_SETUP);
  const cfg = loadConfig();

  // Provider choice — OpenCode-style panel on a real terminal, numbered prompt
  // otherwise.
  let providerId;
  if (canRaw()) {
    const groups = [];
    for (const id of ids) {
      const meta = PROVIDER_SETUP[id];
      let g = groups.find((x) => x.name === meta.group);
      if (!g) {
        g = { name: meta.group, items: [] };
        groups.push(g);
      }
      g.items.push({
        label: PROVIDERS[id].label,
        desc: meta.desc,
        value: id,
        current: cfg.provider === id,
      });
    }
    providerId = await panelSelect({
      title: "Connect a provider",
      groups,
      current: Math.max(0, ids.indexOf(cfg.provider)),
      footer: "↑/↓ navigate   enter select   esc cancel",
    });
    if (!providerId) {
      process.stdout.write("Cancelled.\n");
      return;
    }
  } else {
    process.stdout.write(bold("tlme --setup\n\n"));
    process.stdout.write("Which provider do you want to set up?\n");
    ids.forEach((id, i) => {
      process.stdout.write(`  ${cyan(String(i + 1))}. ${PROVIDERS[id].label}  ${dim(`(${id})`)}\n`);
    });
    const pick = await ask(`\nSelect a provider [1-${ids.length}]: `);
    providerId = resolveProviderId(pick) || ids[Number(pick) - 1];
    if (!providerId || !PROVIDERS[providerId]) fail(`Invalid selection: ${pick || "(none)"}`);
  }
  const provider = PROVIDERS[providerId];

  // API key entry.
  let key;
  if (canRaw()) {
    key = await panelInput({
      title: "API key",
      placeholder: `${provider.label} API key`,
      mask: true,
      footer: `${dim("get one at")} ${provider.keyHint}    ${hintc("enter submit   esc cancel")}`,
    });
    if (key === null) {
      process.stdout.write("Cancelled.\n");
      return;
    }
  } else {
    process.stdout.write(`\nGet a key here if you need one: ${provider.keyHint}\n`);
    key = await askHidden(`Paste your ${provider.label} API key: `);
  }
  if (!key) fail("No API key entered.");

  cfg.keys[providerId] = key;
  cfg.provider = providerId; // the provider you just set up becomes the default
  saveConfig(cfg);
  process.stdout.write(`Saved. ${cyan(providerId)} is now your default provider.\n`);

  // Validate the key immediately by listing models, then pick a default.
  process.stdout.write(dim("Fetching models…\n"));
  const models = await fetchModels(providerId, key);
  if (models.length === 0) {
    process.stdout.write("No models returned. Using the built-in default.\n");
  } else {
    await pickDefaultModel(providerId, cfg, models);
  }
  process.stdout.write(`\nDone. Try:  ${bold("tlme hello there")}\n`);
}

// Let the user set a default model. OpenCode-style panel (scroll + filter) on a
// terminal, numbered prompt otherwise. Escape/blank keeps the current default.
async function pickDefaultModel(providerId, cfg, models) {
  const current = resolveModel(providerId, cfg, null);
  let model;

  if (canRaw()) {
    model = await panelSelect({
      title: PROVIDERS[providerId].label,
      groups: [
        {
          name: "Models",
          items: models.map((m) => ({ label: m, value: m, current: m === current })),
        },
      ],
      current: Math.max(0, models.indexOf(current)),
      footer: "↑/↓ navigate   enter select   esc keep default   type to filter",
    });
    if (!model) return; // Escape → keep current default
  } else {
    process.stdout.write(`\nModels available to your ${PROVIDERS[providerId].label} key:\n`);
    models.forEach((m, i) => {
      const marker = m === current ? cyan(" (current default)") : "";
      process.stdout.write(`  ${cyan(String(i + 1))}. ${m}${marker}\n`);
    });
    const choice = await ask(`\nSet default model — enter a number, or press Enter to keep "${current}": `);
    if (!choice) return;
    model = models[Number(choice) - 1];
    if (!model) {
      process.stdout.write(dim(`"${choice}" is not in the list — keeping "${current}".\n`));
      return;
    }
  }

  if (!model || model === current) return;
  cfg.models[providerId] = model;
  saveConfig(cfg);
  process.stdout.write(`Default model for ${PROVIDERS[providerId].label} set to ${cyan(model)}\n`);
}

// `tlme models [provider]` — list models the current key can use. Interactive
// terminals also get to set a default; piped output just prints the list.
async function cmdModels(args) {
  const cfg = loadConfig();
  let providerId = cfg.provider || "claude";
  if (args[0]) {
    const resolved = resolveProviderId(args[0]);
    if (!resolved) {
      fail(`Unknown provider: ${args[0]}\nValid: ${Object.keys(PROVIDERS).join(", ")}`);
    }
    providerId = resolved;
  }

  const { key } = resolveKey(providerId, cfg);
  if (!key) {
    fail(
      `No API key configured for ${PROVIDERS[providerId].label}.\n` +
        `Run:  ${bold("tlme --setup")}   or   ${bold(`tlme --config set-key ${providerId} <your-key>`)}`
    );
  }

  const models = await fetchModels(providerId, key);
  if (models.length === 0) {
    process.stdout.write(`No models returned for ${PROVIDERS[providerId].label}.\n`);
    return;
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      await pickDefaultModel(providerId, cfg, models);
    } finally {
      closePrompts();
    }
  } else {
    // Clean, greppable one-per-line output when piped.
    for (const m of models) process.stdout.write(m + "\n");
  }
}

// `tlme --history [show|clear]` — inspect or reset the current thread.
function cmdHistory(args) {
  const cfg = loadConfig();
  const sub = args[0];

  if (sub === "clear" || sub === "reset") {
    const thread = clearThread(cfg);
    process.stdout.write(`Cleared the thread for ${cyan(thread.label)}.\n`);
    return;
  }
  if (sub && sub !== "show") {
    fail(`Unknown history command: ${sub}\nValid: show, clear`);
  }

  const thread = loadThread(cfg);
  const used = thread.messages.length / 2;
  process.stdout.write(bold("tlme history\n"));
  process.stdout.write(`Scope:  ${cyan(cfg.history.scope)}  ${dim(thread.label)}\n`);
  if (thread.note) process.stdout.write(`        ${dim(thread.note)}\n`);
  process.stdout.write(`Thread: ${thread.file}\n`);
  process.stdout.write(`Used:   ${used} / ${thread.budget} exchanges\n`);
  if (!cfg.history.enabled) {
    process.stdout.write(dim(`History is off — ${bold("tlme --config set-history on")}\n`));
  }
  if (!thread.messages.length) {
    process.stdout.write(dim("\nNothing recorded yet.\n"));
    return;
  }
  process.stdout.write("\n");
  for (const m of thread.messages) {
    const who = m.role === "user" ? cyan("you") : dim("ai ");
    const flat = m.content.replace(/\s+/g, " ").trim();
    process.stdout.write(`  ${who}  ${flat.length > 96 ? flat.slice(0, 96) + "…" : flat}\n`);
  }
}

// `tlme --extend [n]` — grant the current thread another block of exchanges.
function cmdExtend(args) {
  const cfg = loadConfig();
  if (!cfg.history.enabled) {
    fail(`History is off, so there's no context to extend.\nTurn it on:  ${bold("tlme --config set-history on")}`);
  }
  let by = cfg.history.block;
  if (args[0] !== undefined) {
    const n = Number(args[0]);
    if (!Number.isInteger(n) || n <= 0 || n > 200) {
      fail(`Extend by how many exchanges? Give a whole number from 1 to 200.`);
    }
    by = n;
  }
  const thread = extendThread(cfg, by);
  const used = thread.messages.length / 2;
  const left = Math.max(0, thread.budget - used);
  process.stdout.write(
    `Context extended by ${by} — now ${cyan(String(thread.budget))} exchanges ` +
      `(${used} used, ${left} left).\n`
  );
  process.stdout.write(dim(`Thread: ${thread.label}\n`));
}

// `tlme --session` — show which thread this terminal resolves to and why.
// Mainly a way to check whether a new terminal or IDE exports a usable id.
function cmdSession() {
  const cfg = loadConfig();
  const thread = loadThread(cfg);
  process.stdout.write(bold("tlme session\n"));
  process.stdout.write(`Scope setting: ${cyan(cfg.history.scope)}\n`);
  process.stdout.write(`This thread:   ${thread.label}\n`);
  if (thread.note) process.stdout.write(`               ${dim(thread.note)}\n`);
  process.stdout.write(`File:          ${thread.file}\n\n`);
  process.stdout.write("Terminal session ids visible from here:\n");
  let any = false;
  for (const v of SESSION_VARS) {
    if (process.env[v]) {
      process.stdout.write(`  ${check("✓")} ${v} = ${process.env[v]}\n`);
      any = true;
    } else {
      process.stdout.write(`    ${dim(v.padEnd(22))}${dim("not set")}\n`);
    }
  }
  if (!any) {
    process.stdout.write(
      dim("\nNone available, so scope=terminal falls back to per-directory here.\n") +
        dim("Pin one yourself with:  export TLME_SESSION=$$\n")
    );
  }
}

function cmdConfig(args) {
  const sub = args[0];

  if (sub === "show") {
    const cfg = loadConfig();
    const activeProvider = cfg.provider || "claude";
    process.stdout.write(bold("tlme configuration\n"));
    process.stdout.write(`Config file: ${CONFIG_PATH}\n`);
    process.stdout.write(`Default provider: ${cyan(activeProvider)}\n\n`);

    for (const id of Object.keys(PROVIDERS)) {
      const provider = PROVIDERS[id];
      const { key, source } = resolveKey(id, cfg);
      const model = resolveModel(id, cfg, null);
      const marker = id === activeProvider ? bold("* ") : "  ";
      if (key) {
        process.stdout.write(
          `${marker}${provider.label}\n` +
            `    key:    ${maskKey(key)}  ${dim(`(${source})`)}\n` +
            `    model:  ${model}\n`
        );
      } else {
        process.stdout.write(
          `${marker}${provider.label}\n` + `    key:    ${dim("not configured")}\n`
        );
      }
    }

    const thread = loadThread(cfg);
    process.stdout.write(bold("\nHistory\n"));
    process.stdout.write(`    state:  ${cfg.history.enabled ? "on" : dim("off")}\n`);
    process.stdout.write(`    scope:  ${cyan(cfg.history.scope)}  ${dim(thread.label)}\n`);
    process.stdout.write(`    budget: ${cfg.history.block} exchanges per block\n`);
    process.stdout.write(`    used:   ${thread.messages.length / 2} / ${thread.budget}\n`);
    return;
  }

  if (sub === "set-key") {
    const providerId = resolveProviderId(args[1]);
    const key = args[2];
    if (!providerId) {
      fail(
        `Usage: tlme --config set-key <provider> <api-key>\n` +
          `Providers: ${Object.keys(PROVIDERS).join(", ")}`
      );
    }
    if (!key) fail(`Missing API key.\nUsage: tlme --config set-key ${providerId} <api-key>`);
    const cfg = loadConfig();
    cfg.keys[providerId] = key;
    if (!cfg.provider) cfg.provider = providerId; // first key becomes default
    saveConfig(cfg);
    process.stdout.write(
      `Saved ${PROVIDERS[providerId].label} key to ${CONFIG_PATH}\n` +
        `Default provider: ${cyan(cfg.provider)}\n`
    );
    return;
  }

  if (sub === "set-provider") {
    const providerId = resolveProviderId(args[1]);
    if (!providerId) {
      fail(
        `Usage: tlme --config set-provider <provider>\n` +
          `Providers: ${Object.keys(PROVIDERS).join(", ")}`
      );
    }
    const cfg = loadConfig();
    cfg.provider = providerId;
    saveConfig(cfg);
    process.stdout.write(`Default provider set to ${cyan(providerId)}\n`);
    return;
  }

  if (sub === "set-model") {
    const providerId = resolveProviderId(args[1]);
    const model = args[2];
    if (!providerId || !model) {
      fail(`Usage: tlme --config set-model <provider> <model>`);
    }
    const cfg = loadConfig();
    cfg.models[providerId] = model;
    saveConfig(cfg);
    process.stdout.write(`Model for ${PROVIDERS[providerId].label} set to ${model}\n`);
    return;
  }

  if (sub === "set-scope") {
    const scope = String(args[1] || "").toLowerCase();
    if (!SCOPES.includes(scope)) {
      fail(
        `Usage: tlme --config set-scope <${SCOPES.join("|")}>\n\n` +
          `  global     one conversation everywhere (works in every terminal)\n` +
          `  terminal   one per terminal tab, per-directory where the terminal\n` +
          `             exports no session id (VS Code, plain conhost, SSH, CI)\n` +
          `  directory  one per working directory`
      );
    }
    const cfg = loadConfig();
    cfg.history.scope = scope;
    saveConfig(cfg);
    const thread = loadThread(cfg);
    process.stdout.write(`History scope set to ${cyan(scope)}\n`);
    process.stdout.write(dim(`This thread: ${thread.label}\n`));
    if (thread.note) process.stdout.write(dim(`${thread.note}\n`));
    return;
  }

  if (sub === "set-history") {
    const raw = String(args[1] || "").toLowerCase();
    const cfg = loadConfig();
    if (raw === "off" || raw === "false" || raw === "0") {
      cfg.history.enabled = false;
      saveConfig(cfg);
      process.stdout.write(`History ${dim("off")} — every question starts fresh.\n`);
      return;
    }
    if (raw === "on" || raw === "true") {
      cfg.history.enabled = true;
      saveConfig(cfg);
      process.stdout.write(`History ${cyan("on")} — ${cfg.history.block} exchanges per block.\n`);
      return;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > 200) {
      fail(`Usage: tlme --config set-history <exchanges|on|off>   (1-200)`);
    }
    cfg.history.enabled = true;
    cfg.history.block = n;
    saveConfig(cfg);
    process.stdout.write(`History budget set to ${cyan(String(n))} exchanges per block.\n`);
    return;
  }

  fail(
    `Unknown config command: ${sub || "(none)"}\n` +
      `Valid: set-key, set-provider, set-model, set-scope, set-history, show`
  );
}

function printHelp() {
  const providers = Object.keys(PROVIDERS).join(", ");
  const out = `${bold("tlme")} — ask AI from your terminal (streamed answers, zero deps)

${bold("Usage")}
  tlme <question...>                 Ask a question (no quotes needed)
  tlme [options] <question...>

${bold("Commands")}
  --setup                                 Interactive: pick a provider & paste a key
  --models [provider]                     List models your key can use (and set a default)
  --history [clear]                       Show the current conversation, or reset it
  --extend [n]                            Add another ${HISTORY_DEFAULTS.block} exchanges of context
  --session                               Which thread this terminal maps to, and why
  --config <sub> ...                      Manage saved config (see below)
  --help, -h                              Show this help

${bold("Options")}
  -p, --provider <name>   Provider for this call: ${providers}
  -m, --model <name>      Override the model for this call
  --no-history            Ask as a one-off: ignore and don't record context

${bold("Config")}
  tlme --config set-key <provider> <key>    Save an API key (chmod 600)
  tlme --config set-provider <provider>     Set the default provider
  tlme --config set-model <provider> <name> Set the default model for a provider
  tlme --config set-scope <scope>           global | terminal | directory
  tlme --config set-history <n|on|off>      Exchanges per block, or turn it off
  tlme --config show                        Show providers, masked keys, models

${bold("Context")}
  tlme remembers the last ${HISTORY_DEFAULTS.block} exchanges so follow-ups just work. It counts
  down when ${WARN_WITHIN} are left; past the budget the oldest exchange rolls off.
  Widen it with ${bold("tlme --extend")} (or just ask: ${bold("tlme extend the context")}).

  Scope decides what "the conversation" means — global (default) is one thread
  shared by every terminal; terminal gives each tab its own; directory keys it
  to the project. Check yours with ${bold("tlme --session")}.

${bold("Examples")}
  tlme how do I create a nextjs app in this directory
  tlme -p openai explain this error briefly
  cat error.log | tlme why is this failing
  tlme --model claude-opus-4-8 refactor tips for a large react file
  tlme --setup

${dim("(The bare words setup / models / config still work as aliases.)")}

${bold("Providers & keys")}
  claude       ANTHROPIC_API_KEY          ${PROVIDERS.claude.keyHint}
  openai       OPENAI_API_KEY             ${PROVIDERS.openai.keyHint}
  grok         XAI_API_KEY                ${PROVIDERS.grok.keyHint}
  google       GEMINI_API_KEY             ${PROVIDERS.google.keyHint}
  openrouter   OPENROUTER_API_KEY         ${PROVIDERS.openrouter.keyHint}

Keys resolve as: environment variable first, then ${CONFIG_PATH}.
`;
  process.stdout.write(out);
}

// ---------------------------------------------------------------------------
// 8. Arg parsing + entry point
// ---------------------------------------------------------------------------
// Read piped stdin (nice-to-have): `cat file | tlme why is this broken`.
//
// isTTY alone can't tell us whether anything is actually coming. A script or CI
// runner can hand us a stdin that is neither a terminal nor ever closed, and
// `for await` would then wait for an EOF that never arrives — a hang with no
// output at all. Type-sniffing doesn't help: on Windows a real pipe and that
// inherited handle are indistinguishable (fstat reports neither as a FIFO), so
// the only portable signal is whether data shows up.
//
// So wait for the first byte, then read to EOF with no further limit — a slow or
// large producer is fine once it has started. If nothing arrives at all within
// the grace window, assume there's no piped input and carry on. A producer that
// is slow to emit its *first* byte needs a longer window: TLME_STDIN_WAIT=<ms>.
const STDIN_GRACE_MS = 2000;

async function readStdin() {
  if (process.stdin.isTTY) return "";

  const stdin = process.stdin;
  const grace = Number(process.env.TLME_STDIN_WAIT) || STDIN_GRACE_MS;
  const chunks = [];

  const outcome = await new Promise((resolve) => {
    const finish = (how) => {
      clearTimeout(timer);
      stdin.off("readable", onReadable);
      stdin.off("end", onDone);
      stdin.off("error", onDone);
      resolve(how);
    };
    const onReadable = () => {
      const c = stdin.read();
      if (c === null) return; // woke up with nothing buffered yet
      chunks.push(c);
      finish("data");
    };
    const onDone = () => finish("end");
    const timer = setTimeout(() => finish("timeout"), grace);
    stdin.on("readable", onReadable);
    stdin.once("end", onDone);
    stdin.once("error", onDone);
  });

  // Nothing ever showed up: treat it as "no piped input" rather than hanging.
  // The handle is still open and would keep the event loop alive long after the
  // answer has printed, so let go of it explicitly — otherwise the hang just
  // moves from before the output to after it.
  if (outcome === "timeout") {
    stdin.pause();
    try {
      stdin.unref();
    } catch {
      /* not all stdin stream types expose unref */
    }
    return "";
  }
  // Something did: drain the rest without a deadline.
  if (outcome === "data") {
    for await (const chunk of stdin) chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function parseArgs(argv) {
  const opts = { provider: null, model: null, help: false, noHistory: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--no-history" || a === "--fresh") opts.noHistory = true;
    else if (a === "-p" || a === "--provider") opts.provider = argv[++i];
    else if (a === "-m" || a === "--model") opts.model = argv[++i];
    else if (a.startsWith("--provider=")) opts.provider = a.slice("--provider=".length);
    else if (a.startsWith("--model=")) opts.model = a.slice("--model=".length);
    else rest.push(a);
  }
  return { opts, rest };
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    printHelp();
    return;
  }

  // Commands, handled before flag parsing. Each is spelled as a --flag (the
  // documented form) and also accepts the bare word as an alias.
  // A bare word only counts as a command when everything after it looks like
  // that command's own arguments. Otherwise "tlme setup nginx on ubuntu" and
  // "tlme extend the context" get swallowed as commands carrying junk arguments
  // instead of reaching the model. The --flag spelling is always unambiguous.
  const cmd = argv[0];
  const tail = argv.slice(1);
  const bare = (word, allowed) =>
    cmd === word && tail.every((a) => allowed.includes(a.toLowerCase()) || /^[0-9]+$/.test(a));

  const CONFIG_SUBS = ["set-key", "set-provider", "set-model", "set-scope", "set-history", "show"];

  if (cmd === "--config" || (cmd === "config" && CONFIG_SUBS.includes(String(tail[0] || "").toLowerCase()))) {
    cmdConfig(tail);
    return;
  }
  if (cmd === "--setup" || bare("setup", [])) {
    await cmdSetup();
    return;
  }
  // `tlme models` / `tlme models openai`; "tlme models of gpt" is a question.
  if (cmd === "--models" || (cmd === "models" && tail.every((a) => resolveProviderId(a)))) {
    await cmdModels(tail);
    return;
  }
  if (cmd === "--history" || bare("history", ["show", "clear", "reset"])) {
    cmdHistory(tail);
    return;
  }
  if (cmd === "--extend" || bare("extend", [])) {
    cmdExtend(tail);
    return;
  }
  if (cmd === "--session" || bare("session", [])) {
    cmdSession();
    return;
  }
  if (cmd === "--help" || cmd === "-h" || bare("help", [])) {
    printHelp();
    return;
  }

  const { opts, rest } = parseArgs(argv);

  // Explicit --help, or nothing left to ask after flags → show help.
  if (opts.help || rest.length === 0) {
    printHelp();
    return;
  }

  // Resolve provider: --provider flag > config default > claude.
  const cfg = loadConfig();
  let providerId = cfg.provider || "claude";
  if (opts.provider) {
    const resolved = resolveProviderId(opts.provider);
    if (!resolved) {
      fail(
        `Unknown provider: ${opts.provider}\n` +
          `Valid: ${Object.keys(PROVIDERS).join(", ")}`
      );
    }
    providerId = resolved;
  }

  // Assemble the question; prepend any piped stdin as context.
  let question = rest.join(" ");

  // A bare "extend the context" is the command, not something to ask the model.
  // Checked before stdin so it stays a cheap local action with no API call.
  if (cfg.history.enabled && !opts.noHistory) {
    const by = extendRequest(question, cfg.history.block);
    if (by) {
      cmdExtend([String(by)]);
      return;
    }
  }

  const piped = await readStdin();
  if (piped) {
    question = `${question}\n\n--- piped input ---\n${piped}`;
  }

  await askQuestion(question, {
    providerId,
    cfg,
    modelOverride: opts.model,
    useHistory: !opts.noHistory,
  });
}

// Run as a CLI only when invoked directly (not when imported by a test).
const _invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (_invokedDirectly) {
  main().catch((e) => {
    exitAlt(); // safety net: never leave the terminal on the alternate screen
    if (e instanceof ExitSignal) return; // already reported by fail()
    // Never surface a raw stack trace.
    process.stderr.write(red("Error: ") + (e && e.message ? e.message : String(e)) + "\n");
    process.exitCode = 1;
  });
}
