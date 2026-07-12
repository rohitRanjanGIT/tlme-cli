#!/usr/bin/env node
// tlme — ask AI questions straight from your terminal.
// Multi-provider (Claude, OpenAI, Grok, Google AI Studio, OpenRouter).
// Zero npm dependencies: native fetch + node:* only. ESM.
//
// Sections:
//   1. Provider registry
//   2. Config helpers      (~/.tlme/config.json)
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
import readline from "node:readline";

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
    build(apiKey, model, system, question) {
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
          messages: [
            { role: "system", content: system },
            { role: "user", content: question },
          ],
          stream: true,
        },
      };
    },
    // returns text delta ("" if none) for a parsed SSE JSON object
    extractDelta: (o) => o?.choices?.[0]?.delta?.content || "",
    // returns an error message string if the event is an error, else null
    extractError: (o) => o?.error?.message || null,
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
    build(apiKey, model, system, question) {
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
          messages: [{ role: "user", content: question }],
          stream: true,
        },
      };
    },
    extractDelta: (o) =>
      o?.type === "content_block_delta" && o?.delta?.type === "text_delta"
        ? o.delta.text
        : "",
    extractError: (o) => (o?.type === "error" ? o?.error?.message || "unknown error" : null),
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
    build(apiKey, model, system, question) {
      // Gemini streams SSE when ?alt=sse is set; key travels as a query param.
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
        `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
      return {
        url,
        headers: { "content-type": "application/json" },
        body: {
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: question }] }],
        },
      };
    },
    extractDelta: (o) =>
      (o?.candidates?.[0]?.content?.parts || [])
        .map((p) => p?.text || "")
        .join(""),
    extractError: (o) => o?.error?.message || null,
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

// Shape: { provider: "claude", keys: {claude, openai, ...}, models: {claude, ...} }
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    return {
      provider: cfg.provider || null,
      keys: cfg.keys && typeof cfg.keys === "object" ? cfg.keys : {},
      models: cfg.models && typeof cfg.models === "object" ? cfg.models : {},
    };
  } catch {
    return { provider: null, keys: {}, models: {} };
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

// Arrow-key list picker with a scrollable viewport and type-to-filter.
// Resolves to the index (into `items`) that was chosen. Ctrl-C cancels.
function selectList({ title, items, current = 0, pageSize = 10, filter = false }) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let query = "";
    let index = Math.max(0, Math.min(current, items.length - 1));
    let view = items.map((label, i) => ({ label, i })); // filtered view
    let rendered = 0;

    const applyFilter = () => {
      const q = query.toLowerCase();
      view = items
        .map((label, i) => ({ label, i }))
        .filter((o) => o.label.toLowerCase().includes(q));
      index = Math.max(0, Math.min(index, view.length - 1));
    };

    const draw = () => {
      if (rendered > 0) process.stdout.write(`\x1b[${rendered}A`); // up to top
      process.stdout.write("\x1b[0J"); // clear from cursor down

      const lines = [];
      if (filter) lines.push(`${dim("filter:")} ${query}${useColor ? "\x1b[7m \x1b[0m" : "_"}`);

      const total = view.length;
      if (total === 0) {
        lines.push(dim("  (no matches)"));
      } else {
        let start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), total - pageSize));
        const end = Math.min(total, start + pageSize);
        if (start > 0) lines.push(dim(`  ↑ ${start} more`));
        for (let r = start; r < end; r++) {
          const sel = r === index;
          lines.push(sel ? cyan(`❯ ${view[r].label}`) : `  ${view[r].label}`);
        }
        if (end < total) lines.push(dim(`  ↓ ${total - end} more`));
      }
      const hint = filter
        ? "↑/↓ move · type to filter · Enter select · Ctrl+C cancel"
        : "↑/↓ move · Enter select · Ctrl+C cancel";
      lines.push(dim(hint));

      process.stdout.write(lines.join("\n") + "\n");
      rendered = lines.length;
    };

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exitCode = 130;
        reject(new ExitSignal("cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (view.length === 0) return;
        cleanup();
        resolve(view[index].i);
        return;
      }
      if (key.name === "up") index = Math.max(0, index - 1);
      else if (key.name === "down") index = Math.min(view.length - 1, index + 1);
      else if (key.name === "pageup") index = Math.max(0, index - pageSize);
      else if (key.name === "pagedown") index = Math.min(view.length - 1, index + pageSize);
      else if (key.name === "home") index = 0;
      else if (key.name === "end") index = view.length - 1;
      else if (filter && key.name === "backspace") {
        query = query.slice(0, -1);
        applyFilter();
      } else if (filter && key.name === "escape") {
        query = "";
        applyFilter();
      } else if (filter) {
        const add = printableOf(str);
        if (!add) return;
        query += add;
        index = 0;
        applyFilter();
      } else {
        return; // no filter: ignore other keys, don't redraw
      }
      draw();
    };

    if (title) process.stdout.write(title + "\n");
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    draw();
  });
}

// Masked secret entry in raw mode (shows * per character). Ctrl-C cancels.
function askHiddenRaw(query) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    process.stdout.write(query);

    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        process.exitCode = 130;
        reject(new ExitSignal("cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        process.stdout.write("\n");
        resolve(value.trim());
        return;
      }
      if (key.name === "backspace") {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      const add = printableOf(str);
      if (add) {
        value += add;
        process.stdout.write("*".repeat(add.length));
      }
    };

    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
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
      msg += `\n\nCheck your key:  ${bold(`tlme config set-key ${providerId} <your-key>`)}`;
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
async function askQuestion(question, { providerId, cfg, modelOverride }) {
  const provider = PROVIDERS[providerId];
  const { key, source } = resolveKey(providerId, cfg);

  if (!key) {
    const envList = provider.envVars.map((v) => `  export ${v}=<your-key>`).join("\n");
    fail(
      `No API key configured for ${provider.label}.\n\n` +
        `Set one either way:\n` +
        `  1. Environment variable:\n${envList}\n` +
        `  2. Config:  ${bold(`tlme config set-key ${providerId} <your-key>`)}\n\n` +
        `Get a key: ${provider.keyHint}`
    );
  }

  const model = resolveModel(providerId, cfg, modelOverride);
  const system = buildSystemPrompt();
  const { url, headers, body } = provider.build(key, model, system, question);

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
      msg += `\n\nCheck your key:  ${bold(`tlme config set-key ${providerId} <your-key>`)}`;
    }
    fail(msg);
  }

  await streamSSE(res, provider, source);
}

// Iterate the response body, frame SSE events on blank lines, and print deltas.
async function streamSSE(res, provider, _source) {
  const decoder = new TextDecoder();
  let buffer = "";
  let wroteAnything = false;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });

    // Events are separated by a blank line; keep the incomplete tail buffered.
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      for (const line of rawEvent.split("\n")) {
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

        const text = provider.extractDelta(obj);
        if (text) {
          process.stdout.write(text);
          wroteAnything = true;
        }
      }
    }
  }

  // Trailing newline so the shell prompt lands on its own line.
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// 7. Commands
// ---------------------------------------------------------------------------

// `tlme setup` — interactive: pick a provider, paste a key, optionally choose a
// default model (validated against the provider's live model list).
async function cmdSetup() {
  requireTTY("tlme setup");
  try {
    await runSetup();
  } finally {
    closePrompts(); // release stdin so the process can exit
  }
}

async function runSetup() {
  const ids = Object.keys(PROVIDERS);
  process.stdout.write(bold("tlme setup\n\n"));

  // Provider choice — arrow menu on a real terminal, numbered prompt otherwise.
  let providerId;
  if (canRaw()) {
    const idx = await selectList({
      title: "Which provider do you want to set up?",
      items: ids.map((id) => `${PROVIDERS[id].label}  ${dim(`(${id})`)}`),
      current: 0,
    });
    providerId = ids[idx];
  } else {
    process.stdout.write("Which provider do you want to set up?\n");
    ids.forEach((id, i) => {
      process.stdout.write(`  ${cyan(String(i + 1))}. ${PROVIDERS[id].label}  ${dim(`(${id})`)}\n`);
    });
    const pick = await ask(`\nSelect a provider [1-${ids.length}]: `);
    providerId = resolveProviderId(pick) || ids[Number(pick) - 1];
    if (!providerId || !PROVIDERS[providerId]) fail(`Invalid selection: ${pick || "(none)"}`);
  }
  const provider = PROVIDERS[providerId];

  process.stdout.write(`\nGet a key here if you need one: ${provider.keyHint}\n`);
  const key = canRaw()
    ? await askHiddenRaw(`Paste your ${provider.label} API key: `)
    : await askHidden(`Paste your ${provider.label} API key: `);
  if (!key) fail("No API key entered.");

  const cfg = loadConfig();
  cfg.keys[providerId] = key;
  cfg.provider = providerId; // the provider you just set up becomes the default
  saveConfig(cfg);
  process.stdout.write(`\nSaved. ${cyan(providerId)} is now your default provider.\n`);

  // Validate the key immediately by listing models, and offer to pick a default.
  const wantModels = await confirm("Fetch available models now to pick a default?", true);
  if (!wantModels) {
    process.stdout.write(`\nDone. Try:  ${bold("tlme hello there")}\n`);
    return;
  }

  process.stdout.write(dim("\nFetching models…\n"));
  const models = await fetchModels(providerId, key);
  if (models.length === 0) {
    process.stdout.write("No models returned. Using the built-in default.\n");
    process.stdout.write(`\nDone. Try:  ${bold("tlme hello there")}\n`);
    return;
  }

  await pickDefaultModel(providerId, cfg, models);
  process.stdout.write(`\nDone. Try:  ${bold("tlme hello there")}\n`);
}

// Yes/no confirm. Arrow menu on a terminal; [Y/n] line prompt otherwise.
async function confirm(question, defaultYes = true) {
  if (canRaw()) {
    const idx = await selectList({
      title: question,
      items: ["Yes", "No"],
      current: defaultYes ? 0 : 1,
    });
    return idx === 0;
  }
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${question} ${suffix} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

// Let the user set a default model. Arrow menu (scroll + filter) on a terminal,
// numbered prompt otherwise.
async function pickDefaultModel(providerId, cfg, models) {
  const current = resolveModel(providerId, cfg, null);
  let model;

  if (canRaw()) {
    const curIdx = Math.max(0, models.indexOf(current));
    const idx = await selectList({
      title: `Select the default model for ${PROVIDERS[providerId].label} (current: ${current}):`,
      items: models,
      current: curIdx,
      pageSize: 12,
      filter: true,
    });
    model = models[idx];
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
        `Run:  ${bold("tlme setup")}   or   ${bold(`tlme config set-key ${providerId} <your-key>`)}`
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
    return;
  }

  if (sub === "set-key") {
    const providerId = resolveProviderId(args[1]);
    const key = args[2];
    if (!providerId) {
      fail(
        `Usage: tlme config set-key <provider> <api-key>\n` +
          `Providers: ${Object.keys(PROVIDERS).join(", ")}`
      );
    }
    if (!key) fail(`Missing API key.\nUsage: tlme config set-key ${providerId} <api-key>`);
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
        `Usage: tlme config set-provider <provider>\n` +
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
      fail(`Usage: tlme config set-model <provider> <model>`);
    }
    const cfg = loadConfig();
    cfg.models[providerId] = model;
    saveConfig(cfg);
    process.stdout.write(`Model for ${PROVIDERS[providerId].label} set to ${model}\n`);
    return;
  }

  fail(
    `Unknown config command: ${sub || "(none)"}\n` +
      `Valid: set-key, set-provider, set-model, show`
  );
}

function printHelp() {
  const providers = Object.keys(PROVIDERS).join(", ");
  const out = `${bold("tlme")} — ask AI from your terminal (streamed answers, zero deps)

${bold("Usage")}
  tlme <question...>                 Ask a question (no quotes needed)
  tlme [options] <question...>

${bold("Getting started")}
  tlme setup                              Interactive: pick a provider & paste a key
  tlme models [provider]                  List models your key can use (and set a default)

${bold("Options")}
  -p, --provider <name>   Provider for this call: ${providers}
  -m, --model <name>      Override the model for this call
  -h, --help              Show this help

${bold("Config")}
  tlme config set-key <provider> <key>    Save an API key (chmod 600)
  tlme config set-provider <provider>     Set the default provider
  tlme config set-model <provider> <name> Set the default model for a provider
  tlme config show                        Show providers, masked keys, models

${bold("Examples")}
  tlme how do I create a nextjs app in this directory
  tlme -p openai explain this error briefly
  cat error.log | tlme why is this failing
  tlme --model claude-opus-4-8 refactor tips for a large react file

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
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function parseArgs(argv) {
  const opts = { provider: null, model: null, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
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

  // Subcommands handled before flag parsing.
  if (argv[0] === "config") {
    cmdConfig(argv.slice(1));
    return;
  }
  if (argv[0] === "setup") {
    await cmdSetup();
    return;
  }
  if (argv[0] === "models") {
    await cmdModels(argv.slice(1));
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
  const piped = await readStdin();
  if (piped) {
    question = `${question}\n\n--- piped input ---\n${piped}`;
  }

  await askQuestion(question, { providerId, cfg, modelOverride: opts.model });
}

main().catch((e) => {
  if (e instanceof ExitSignal) return; // already reported by fail()
  // Never surface a raw stack trace.
  process.stderr.write(red("Error: ") + (e && e.message ? e.message : String(e)) + "\n");
  process.exitCode = 1;
});
