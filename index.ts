/**
 * Emote Audio Pi
 *
 * Plays a short sound when the reasoning stream shows an emotional expression, so
 * you can tell what the model is doing from across the room without reading the
 * trace. Tool results get a musical cue: rising notes when a call worked, falling
 * notes when it failed. A two-note chime marks the point where the run settles
 * and the keyboard is the user's again.
 *
 * config.json chooses a soundpack, and every soundpack is a directory with its
 * own config.json and its own audio files: one entry per category, naming the
 * folder that holds its takes and the words that fire it. The extension only
 * ever plays files - it never synthesizes anything.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "emote-audio-pi";
const AUDIO_EXT = [".wav", ".mp3", ".ogg", ".opus", ".flac", ".m4a"];
const LOG_MAX = 40;
const SET_KEYS = ["cooldown", "gap", "queue", "text", "nested"];
const DEFAULT_PACK = "default";
const PACKS_DIR = "packs";
const SUBCOMMANDS = ["on", "off", "mute", "dry", "stats", "legend", "log", "test", "set", "rescan", "packs", "use"];
const PLAYERS = [
  { bin: "paplay", args: (file: string) => [file] },
  { bin: "pw-play", args: (file: string) => [file] },
  { bin: "aplay", args: (file: string) => ["-q", file] },
  { bin: "ffplay", args: (file: string) => ["-nodisp", "-autoexit", "-loglevel", "quiet", file] },
  { bin: "mpv", args: (file: string) => ["--no-video", "--really-quiet", file] },
];

function extDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

const CONFIG_FILE = join(extDir(), "config.json");

interface Settings {
  enabled: boolean;
  muted: boolean;
  dryRun: boolean;
  matchText: boolean;
  skipNestedTools: boolean;
  cooldownMs: number;
  minGapMs: number;
  maxQueue: number;
}

const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  muted: false,
  dryRun: false,
  matchText: false,
  skipNestedTools: true,
  cooldownMs: 2500,
  minGapMs: 500,
  maxQueue: 2,
};

interface Category {
  name: string; // folder inside the pack, one per category
  words: string[];
  match: string; // "word" (whole word) or "substring" (anywhere in the stream)
  trigger: string; // "word", or an event cue: tool_success, tool_failure, handback
  priority: boolean;
  files: string[];
  bag: string[];
  pos: number;
}

interface Player {
  bin: string;
  args: (file: string) => string[];
}

interface LogEntry {
  at: string;
  category: string;
  word: string;
  outcome: string;
}

interface QueueItem {
  entry: LogEntry;
  file: string;
  priority: boolean;
}

const WORD_CHAR = /[\p{L}']/u;

export default function (pi: ExtensionAPI) {
  const cfg: Settings = { ...DEFAULT_SETTINGS };

  let packsDir = join(extDir(), PACKS_DIR);
  let packName = DEFAULT_PACK;
  let soundsDir = join(packsDir, DEFAULT_PACK); // audio root of the active pack
  let rootSettings: Record<string, unknown> = {};
  const categories = new Map<string, Category>();
  const wordMap = new Map<string, string>(); // word -> category name
  const subMap = new Map<string, string>(); // substring -> category name
  let longestSub = 0; // longest pattern, which keeps the tail small
  let tail = ""; // the last few characters of the stream

  const lastHeard = new Map<string, number>();
  const stats = {
    matched: 0,
    played: 0,
    suppressed: 0,
    throttled: 0,
    dropped: 0,
    missing: 0,
    muted: 0,
    failed: 0,
    byCategory: new Map<string, number>(),
  };

  const log: LogEntry[] = [];
  const queue: QueueItem[] = [];

  let player: Player | null = null;
  let active: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastStartAt = 0;
  let partialWord = "";
  let configError = "";
  let lastFailure = "";
  let lastStatus = "";

  const clock = () => new Date().toISOString().slice(11, 19);
  const sorted = () => [...categories.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totalTakes = () => [...categories.values()].reduce((n, c) => n + c.files.length, 0);
  const plural = (n: number, word: string) => `${n} ${n === 1 ? word : word.replace(/y$/, "ies")}`;

  // ---------- config ----------

  function readJsonFile(file: string): any {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (typeof data !== "object" || data === null) throw new Error("not an object");
    return data;
  }

  // Pack settings win over the shared defaults in the top-level config.json.
  function applySettings(overrides: any): void {
    Object.assign(cfg, DEFAULT_SETTINGS, rootSettings, overrides || {});
  }

  // A pack is one directory under packsDir: its own config.json and its own
  // folders of takes. Nothing changes until the pack is read cleanly, so a bad
  // pack leaves the working one in place. Returns "" on success.
  function loadPack(name: string): string {
    const dir = join(packsDir, name);
    if (!existsSync(dir)) return `pack ${name}: no directory under ${packsDir}`;

    const file = join(dir, "config.json");
    if (!existsSync(file)) return `pack ${name}: no config.json`;

    let data: any;
    try {
      data = readJsonFile(file);
    } catch (error) {
      return `pack ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }

    const parsed = new Map<string, Category>();
    for (const [folder, raw] of Object.entries<any>(data.categories || {})) {
      const words = (raw.words || []).map((w: string) => String(w).toLowerCase());
      parsed.set(folder, {
        name: folder,
        words,
        match: raw.match === "substring" ? "substring" : "word",
        trigger: raw.trigger || "word",
        priority: raw.priority === true,
        files: [],
        bag: [],
        pos: 0,
      });
    }

    packName = name;
    soundsDir = join(dir, data.soundsDir || "");
    categories.clear();
    wordMap.clear();
    subMap.clear();
    for (const [folder, category] of parsed) {
      categories.set(folder, category);
      for (const word of category.words) {
        if (!word) continue;
        if (category.match === "substring") subMap.set(word, folder);
        else wordMap.set(word, folder);
      }
    }
    longestSub = [...subMap.keys()].reduce((n, p) => Math.max(n, p.length), 0);
    partialWord = "";
    tail = "";
    applySettings(data.settings);
    rescan();
    return "";
  }

  function loadConfig(): void {
    let rootError = "";
    let packDefault = DEFAULT_PACK;
    try {
      const data = readJsonFile(CONFIG_FILE);
      rootSettings = data.settings || {};
      packsDir = join(extDir(), data.packsDir || PACKS_DIR);
      packDefault = data.pack || DEFAULT_PACK;
    } catch (error) {
      rootSettings = {};
      rootError = `config: ${error instanceof Error ? error.message : String(error)}`;
    }
    configError = rootError || loadPack(process.env.EMOTE_PACK || packDefault);
  }

  // What a pack holds, read without touching the active one.
  function describePack(name: string): { description: string; categories: number; takes: number; note: string } {
    const dir = join(packsDir, name);
    if (!existsSync(join(dir, "config.json"))) return { description: "", categories: 0, takes: 0, note: "no config.json" };
    try {
      const data = readJsonFile(join(dir, "config.json"));
      const folders = Object.keys(data.categories || {});
      const root = join(dir, data.soundsDir || "");
      const takes = folders.reduce((n, folder) => n + countAudio(join(root, folder)), 0);
      return { description: String(data.description || ""), categories: folders.length, takes, note: "" };
    } catch (error) {
      return { description: "", categories: 0, takes: 0, note: error instanceof Error ? error.message : String(error) };
    }
  }

  function countAudio(dir: string): number {
    try {
      return readdirSync(dir).filter((f) => AUDIO_EXT.includes(extname(f).toLowerCase())).length;
    } catch {
      return 0;
    }
  }

  function packNames(): string[] {
    try {
      return readdirSync(packsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  function rescan(): void {
    for (const category of categories.values()) {
      const dir = join(soundsDir, category.name);
      category.files = existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => AUDIO_EXT.includes(extname(f).toLowerCase()))
            .sort()
            .map((f) => join(dir, f))
        : [];
      category.bag = [];
      category.pos = 0;
    }
  }

  function findPlayer(): Player | null {
    for (const candidate of PLAYERS) {
      for (const dir of (process.env.PATH || "").split(delimiter)) {
        if (!dir) continue;
        try {
          accessSync(join(dir, candidate.bin), constants.X_OK);
          return candidate;
        } catch {
          /* not on this path */
        }
      }
    }
    return null;
  }

  // ---------- round-robin takes ----------

  // The bag holds whatever takes the folder has, in shuffled order, and is
  // reshuffled when it runs dry, so a folder with two takes simply cycles two.
  function nextTake(category: Category): string {
    if (category.bag.length === 0) {
      category.bag = [...category.files];
      for (let i = category.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [category.bag[i], category.bag[j]] = [category.bag[j], category.bag[i]];
      }
      category.pos = 0;
    }
    const file = category.bag[category.pos++];
    if (category.pos >= category.bag.length) category.bag = []; // next pick starts a fresh bag
    return file;
  }

  // ---------- playback ----------

  function pump(): void {
    if (queue.length === 0) return;

    if (cfg.dryRun) {
      const item = queue.shift()!;
      item.entry.outcome = `dry run ${basename(item.file)}`;
      stats.played++;
      return;
    }

    if (active || !player) return;

    const wait = lastStartAt + cfg.minGapMs - Date.now();
    if (wait > 0) {
      if (!timer) timer = setTimeout(() => { timer = null; pump(); }, wait);
      return;
    }

    const item = queue.shift()!;
    const child = spawn(player.bin, player.args(item.file), { stdio: ["ignore", "ignore", "pipe"] });
    let noise = "";
    let counted = false;
    const markFail = (message: string) => {
      if (counted) return;
      counted = true;
      stats.failed++;
      item.entry.outcome = "failed";
      lastFailure = noise.trim() ? `${message}: ${noise.trim()}` : message;
    };

    active = child;
    lastStartAt = Date.now();
    stats.played++;
    item.entry.outcome = "played";

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { noise += chunk; });
    child.on("error", (error) => {
      markFail(error.message);
      active = null;
      pump();
    });
    child.on("close", (code) => {
      if (code !== 0) markFail(`${player?.bin} exited with ${code}`);
      active = null;
      pump();
    });
  }

  function trigger(category: Category, label: string, force = false): void {
    stats.matched++;
    stats.byCategory.set(category.name, (stats.byCategory.get(category.name) ?? 0) + 1);

    const entry: LogEntry = { at: clock(), category: category.name, word: label, outcome: "" };
    log.unshift(entry);
    if (log.length > LOG_MAX) log.pop();

    if (!cfg.enabled) {
      entry.outcome = "off";
      return;
    }
    if (cfg.muted) {
      stats.muted++;
      entry.outcome = "muted";
      return;
    }
    if (category.files.length === 0) {
      stats.missing++;
      entry.outcome = "no takes";
      return;
    }
    if (!cfg.dryRun && !player) {
      stats.missing++;
      entry.outcome = "no player";
      return;
    }

    const now = Date.now();
    if (!force && now - (lastHeard.get(category.name) ?? 0) < cfg.cooldownMs) {
      stats.suppressed++;
      entry.outcome = "suppressed";
      return;
    }

    if (queue.length >= cfg.maxQueue) {
      // Priority entries (the tool cues) keep their slot by evicting an older,
      // non-priority item instead of being dropped themselves.
      const index = category.priority ? queue.findIndex((item) => !item.priority) : -1;
      if (index === -1) {
        stats.dropped++;
        entry.outcome = "dropped";
        return;
      }
      queue.splice(index, 1)[0].entry.outcome = "dropped";
      stats.dropped++;
    }

    if (!force && queue.length === 0 && !active && now - lastStartAt < cfg.minGapMs) {
      stats.throttled++;
      entry.outcome = "throttled";
      return;
    }

    lastHeard.set(category.name, now);
    queue.push({ entry, file: nextTake(category), priority: category.priority });
    pump();
  }

  // ---------- matching ----------

  function scan(delta: string): void {
    for (const char of delta) {
      const lower = char.toLowerCase();
      if (longestSub > 0) {
        tail += lower;
        if (tail.length > longestSub) tail = tail.slice(-longestSub);
        for (const [pattern, folder] of subMap) {
          if (tail.endsWith(pattern)) {
            trigger(categories.get(folder)!, pattern);
            tail = ""; // start the tail again, so one run of text cannot match twice
            break;
          }
        }
      }
      if (WORD_CHAR.test(lower)) {
        partialWord += lower;
        continue;
      }
      if (!partialWord) continue;
      const name = wordMap.get(partialWord);
      if (name) trigger(categories.get(name)!, partialWord);
      partialWord = "";
    }
  }

  function triggerCategory(name: string): Category | null {
    for (const category of categories.values()) if (category.trigger === name) return category;
    return null;
  }

  // ---------- ui ----------

  function showStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!cfg.enabled) {
      lastStatus = "";
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const mode = cfg.muted ? "muted" : cfg.dryRun ? "dry" : "on";
    const last = log[0];
    const text = `🎧 emote ${mode} · ${packName}${last ? ` · ${last.word} → ${last.category}` : ""}`;
    if (text === lastStatus) return;
    lastStatus = text;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  pi.registerCommand("emote", {
    description: "Emote audio: on | off | mute | dry | stats | legend | log | test <word or folder> | set <key> <value> | packs | use <pack> | rescan",
    getArgumentCompletions: (prefix: string) => {
      const [head, ...rest] = prefix.trim().split(/\s+/);
      const needle = rest[0] || "";
      if (head === "test") {
        const hits = [...sorted().map((c) => c.name), ...subMap.keys()].filter((n) => n.startsWith(needle));
        return hits.length ? hits.map((n) => ({ value: `test ${n}`, label: n })) : null;
      }
      if (head === "set") {
        const hits = SET_KEYS.filter((k) => k.startsWith(needle));
        return hits.length ? hits.map((k) => ({ value: `set ${k}`, label: k })) : null;
      }
      if (head === "use") {
        const hits = packNames().filter((n) => n.startsWith(needle));
        return hits.length ? hits.map((n) => ({ value: `use ${n}`, label: n })) : null;
      }
      const hits = SUBCOMMANDS.filter((s) => s.startsWith(head));
      return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/);
      const arg = rest.join(" ");

      switch (sub) {
        case "on":
        case "off": {
          cfg.enabled = sub === "on";
          showStatus(ctx);
          ctx.ui.notify(`Emote audio ${cfg.enabled ? "on" : "off"}.`, "info");
          return;
        }
        case "mute": {
          cfg.muted = arg === "on" ? true : arg === "off" ? false : !cfg.muted;
          showStatus(ctx);
          ctx.ui.notify(`Emote audio ${cfg.muted ? "muted (still counting)" : "audible"}.`, "info");
          return;
        }
        case "dry": {
          cfg.dryRun = arg === "on" ? true : arg === "off" ? false : !cfg.dryRun;
          showStatus(ctx);
          ctx.ui.notify(`Emote audio ${cfg.dryRun ? "dry run (no sound, log only)" : "playing"}.`, "info");
          return;
        }
        case "stats": {
          const rows = [...stats.byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => `  ${name.padEnd(18)} ${n}`);
          ctx.ui.notify(
            [
              `Emote audio ${cfg.enabled ? (cfg.muted ? "muted" : cfg.dryRun ? "dry" : "on") : "off"} · player ${player?.bin ?? "none"}`,
              `pack ${packName} · ${plural(totalTakes(), "take")} in ${plural(categories.size, "category")} (${soundsDir})`,
              `cooldown ${cfg.cooldownMs}ms · min gap ${cfg.minGapMs}ms · queue ${cfg.maxQueue} · text ${cfg.matchText ? "on" : "off"} · nested ${cfg.skipNestedTools ? "skipped" : "counted"}`,
              `matched ${stats.matched} · played ${stats.played} · suppressed ${stats.suppressed} · throttled ${stats.throttled} · dropped ${stats.dropped} · missing ${stats.missing} · failed ${stats.failed}`,
              rows.length ? `\nBy category:\n${rows.join("\n")}` : "",
              configError ? `\n${configError}` : "",
              lastFailure ? `\nlast failure: ${lastFailure}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            "info",
          );
          return;
        }
        case "legend": {
          const lines = sorted().map((category) => {
            const takes = String(category.files.length).padStart(2);
            const fires = category.words.length
              ? `${category.match === "substring" ? "sub " : ""}${category.words.join(" ")}`
              : `on ${category.trigger}`;
            return `  ${category.name.padEnd(18)} ${takes}  ${fires}${category.priority ? " *" : ""}`;
          });
          ctx.ui.notify(`pack ${packName}\n${lines.join("\n")}\n(sub fires on substrings, * keeps its slot)`, "info");
          return;
        }
        case "log": {
          if (log.length === 0) return ctx.ui.notify("Nothing heard yet.", "info");
          const lines = log.slice(0, 20).map((e) => `  ${e.at}  ${e.word.padEnd(8)} ${e.category.padEnd(18)} ${e.outcome}`);
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        case "test": {
          if (!arg) return ctx.ui.notify(`Usage: /emote test <folder or word>  (${sorted().map((c) => c.name).join(", ")})`, "info");
          const key = arg.toLowerCase();
          const folder = wordMap.get(key) || subMap.get(key);
          const category = categories.get(key) || (folder ? categories.get(folder) : null);
          if (!category) return ctx.ui.notify(`No category '${key}' in pack ${packName}.`, "warning");
          trigger(category, `test:${key}`, true);
          showStatus(ctx);
          ctx.ui.notify(`${key} → ${log[0].outcome}`, "info");
          return;
        }
        case "set": {
          const [key, value] = arg.split(/\s+/);
          if (!SET_KEYS.includes(key) || !value) return ctx.ui.notify(`Usage: /emote set ${SET_KEYS.join("|")} <value>`, "info");
          const bool = (v: string) => v === "on" ? true : v === "off" ? false : Boolean(v);
          if (key === "text") cfg.matchText = bool(value);
          else if (key === "nested") cfg.skipNestedTools = bool(value);
          else {
            const n = parseInt(value, 10);
            if (Number.isNaN(n) || n < 0 || n > 60000) return ctx.ui.notify(`Invalid ${key}: must be 0-60000`, "warning");
            if (key === "cooldown") cfg.cooldownMs = n;
            else if (key === "gap") cfg.minGapMs = n;
            else cfg.maxQueue = n;
          }
          const shown = key === "text"
            ? cfg.matchText
            : key === "nested"
              ? cfg.skipNestedTools
              : key === "cooldown"
                ? cfg.cooldownMs
                : key === "gap"
                  ? cfg.minGapMs
                  : cfg.maxQueue;
          ctx.ui.notify(`emote ${key} = ${shown}`, "info");
          return;
        }
        case "packs": {
          const packs = packNames();
          if (packs.length === 0) {
            return ctx.ui.notify(`No soundpacks under ${packsDir}. Each one is a directory with its own config.json and one folder per category.`, "info");
          }
          const rows = packs.map((name) => {
            const info = describePack(name);
            const note = info.note ? ` (${info.note})` : info.description ? ` - ${info.description}` : "";
            return `  ${name === packName ? "→" : "·"} ${name.padEnd(14)} ${plural(info.categories, "category").padStart(13)} ${plural(info.takes, "take").padStart(10)}${note}`;
          });
          ctx.ui.notify(`${rows.join("\n")}\n(→ is the pack in play)`, "info");
          return;
        }
        case "use": {
          if (!arg) return ctx.ui.notify(`Usage: /emote use <pack>  (${packNames().join(", ") || "none"})`, "info");
          const error = loadPack(arg);
          if (error) return ctx.ui.notify(`${error} - the pack in play is unchanged.`, "warning");
          configError = "";
          showStatus(ctx);
          ctx.ui.notify(`Soundpack ${packName}: ${plural(categories.size, "category")}, ${plural(totalTakes(), "take")}.`, "info");
          return;
        }
        case "rescan": {
          configError = loadPack(packName);
          if (configError) return ctx.ui.notify(configError, "warning");
          ctx.ui.notify(`Rescanned pack ${packName}: ${plural(categories.size, "category")}, ${plural(totalTakes(), "take")}.`, "info");
          return;
        }
        default: {
          const last = log[0];
          ctx.ui.notify(
            [
              `Emote audio ${cfg.enabled ? (cfg.muted ? "muted" : cfg.dryRun ? "dry" : "on") : "off"} · player ${player?.bin ?? "none"}`,
              `pack ${packName} · ${plural(totalTakes(), "take")} in ${plural(categories.size, "category")} (${soundsDir})${configError ? ` (${configError})` : ""}`,
              last ? `last heard: ${last.word} → ${last.category} (${last.outcome} ${last.at})` : "nothing heard yet",
              "usage: /emote on|off|mute|dry|stats|legend|log|test <folder or word>|set <key> <value>|packs|use <pack>|rescan",
            ].join("\n"),
            "info",
          );
        }
      }
    },
  });

  // ---------- lifecycle ----------

  pi.on("session_start", (_event, ctx) => {
    loadConfig();
    player = findPlayer();
    showStatus(ctx);

    if (!ctx.hasUI || !cfg.enabled) return;
    if (!cfg.dryRun && !player) {
      ctx.ui.notify(`Emote: no player found (tried ${PLAYERS.map((p) => p.bin).join(", ")}); matches will only be counted.`, "warning");
    }
    if (configError) ctx.ui.notify(`Emote: ${configError}`, "warning");
    if (totalTakes() === 0) ctx.ui.notify(`Emote: pack ${packName} has no audio files under ${soundsDir}.`, "warning");
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") partialWord = tail = "";
  });

  pi.on("message_update", (event, ctx) => {
    if (!cfg.enabled || event.message.role !== "assistant") return;
    const stream = event.assistantMessageEvent;
    if (stream.type === "thinking_delta" && stream.delta) {
      scan(stream.delta);
      showStatus(ctx);
    } else if (stream.type === "text_delta" && cfg.matchText && stream.delta) {
      scan(stream.delta);
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (!cfg.enabled) return;
    if (cfg.skipNestedTools && event.parentToolCallId) return;
    const category = triggerCategory(event.isError ? "tool_failure" : "tool_success");
    if (!category) return;
    trigger(category, event.toolName);
    showStatus(ctx);
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!cfg.enabled) return;
    const category = triggerCategory("handback");
    if (!category) return;
    trigger(category, event.aborted ? "aborted" : "settled");
    showStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const item of queue) item.entry.outcome = "cancelled";
    queue.length = 0;
    if (active) {
      try {
        active.kill();
      } catch {
        /* already gone */
      }
      active = null;
    }
    partialWord = tail = "";
  });
}
