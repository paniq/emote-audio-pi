# Emote Audio Pi Extension

Plays a short sound when the reasoning stream shows an emotional expression, so
you can tell what the model is doing from across the room without reading the
trace. Tool results get a musical cue: rising notes when a call worked, falling
notes when it failed. A two-note chime marks the point where the run settles and
the keyboard is the user's again.

The extension only plays audio. `config.json` picks a soundpack, and a pack's own
`config.json` decides which word fires which folder of takes.

## Usage

```bash
pi --extension ./emote-audio-pi
```

Pi loads a subdirectory through `index.ts`. In `settings.json` you can list the
directory itself as a package path.

## Configuration

Configuration has two levels: the top-level `config.json` picks the soundpack and
sets the shared defaults, and each pack's `config.json` holds its own mapping.
Each `categories` entry names one folder inside the pack: **the key is the folder
name**, `words` are the words that fire it (whole words, matched
case-insensitively in the reasoning stream), and `priority` entries keep their
slot in the queue. Event cues have no words; they name the outcome that fires
them.

```json
{
  "packsDir": "packs",
  "pack": "default",
  "settings": {
    "enabled": true,
    "muted": false,
    "dryRun": false,
    "matchText": false,
    "skipNestedTools": true,
    "cooldownMs": 2500,
    "minGapMs": 500,
    "maxQueue": 2
  }
}
```

Each pack is a directory with its own `config.json`:

```json
{
  "description": "the original takes",
  "settings": { "cooldownMs": 1500 },
  "categories": {
    "confusion": { "words": ["hmm", "hmmh", "hmmm"] },
    "tool_failure": { "trigger": "tool_failure", "priority": true },
    "handback": { "trigger": "handback", "priority": true }
  }
}
```

Add a word to a list and that word fires that folder, so `positive_assessment`
with `"words": ["good", "excellent"]` hears the same cue for both. A folder does
not need to match a word list: any name works as long as the pack names it. Each
list belongs to one pack, so two packs can send `good` to two different folders.

A `trigger` says what fires a folder: `word` is the default, and the event cues
are `tool_success`, `tool_failure` and `handback`, the last one sounding when the
run settles and typing is free again.

Settings:

| Key | Default | Meaning |
|-----|---------|---------|
| `packsDir` | `packs` | Top level: one directory per soundpack |
| `pack` | `default` | Top level: which pack to start on |
| `soundsDir` | the pack itself | Optional, per pack: subfolder holding the category folders |
| `enabled` | `true` | Master switch |
| `muted` | `false` | Count matches, play nothing |
| `dryRun` | `false` | Log what would play instead of playing it |
| `matchText` | `false` | Match assistant prose as well as reasoning |
| `skipNestedTools` | `true` | Ignore calls made by other tools (codemode scripts) |
| `cooldownMs` | `2500` | Minimum time between two sounds of the same category |
| `minGapMs` | `500` | Minimum time between any two sounds |
| `maxQueue` | `2` | Queue depth (the sound currently playing does not count) |

`hmm`, `fine`, `wait` and `good` are by far the most frequent markers, so
`cooldownMs` is the knob that decides how listenable this is.

## Soundpacks

One directory per pack under `packsDir`. A pack is its own `config.json` plus the
folders it names, so different packs can hold different audio for the same word.

```
packs/
  default/                the pack in play
    config.json
    confusion/take-01.wav
  robot/
    config.json
    confusion/boop-01.wav
```

The pack name is the directory name, and `description` in its `config.json` shows
in `/emote packs`. Which pack starts comes from `pack` in `config.json`, or from
`EMOTE_PACK` in the environment when that is set. `/emote use <pack>` switches
packs in a running session and writes nothing, so the next start reads `pack`
again.

Settings a pack names win over the top-level ones, so a pack can make itself
quieter without touching the shared defaults, and `/emote set` changes only the
values of the running session.

A pack with no `config.json`, or one that does not parse, is reported by
`/emote packs` and `/emote use`; the pack in play keeps running.

## Takes

Each category folder in the pack holds any number of audio files (`take-01.wav`,
`take-03.mp3`, …).
One take per category is picked at a time from a shuffled bag: every file in the
folder is heard once before any repeats, and the bag reshuffles when it runs dry.
A folder with two takes cycles two, a folder with one take repeats that one, and
an empty folder logs `no takes`. Any format your player accepts works, and the
extension plays whatever is there - it never synthesizes.

The default pack's `handback` takes come from `synth/handback.py`, which writes
the same ten files again on demand.

Players are tried in order: `paplay`, `pw-play`, `aplay`, `ffplay`, `mpv`.

## Runtime Commands

| Command | Description |
|---------|-------------|
| `/emote` | Status: pack, mode, player, takes, last thing heard |
| `/emote on` / `/emote off` | Enable or disable |
| `/emote mute` | Keep counting matches, play nothing |
| `/emote dry` | Log what would play instead of playing it |
| `/emote stats` | Counts per category, plus played/suppressed/dropped/failed |
| `/emote legend` | Folder → words → take count |
| `/emote log` | Last 20 matches with the outcome of each |
| `/emote test <folder or word>` | Play one take now, e.g. `/emote test ugh` |
| `/emote set <key> <value>` | cooldown \| gap \| queue \| text \| nested |
| `/emote packs` | Every pack under `packsDir`, with categories, takes and description |
| `/emote use <pack>` | Switch to a pack |
| `/emote rescan` | Re-read the pack's `config.json` and its folders |

Examples:

```
/emote packs                    packs under packsDir
/emote use robot                switch to another pack
/emote legend
/emote test confusion          ← fires whatever the pack's confusion folder holds
/emote stats
```

## How It Works

1. `session_start` → reads `config.json`, loads the pack it names, scans that
   pack's folders for takes, finds a player
2. `message_update` → thinking deltas are scanned character by character, so a word
   split across two deltas is still caught when it completes
3. A completed word looks up its category, the cooldown is checked, and a take is
   pulled from that category's round-robin bag
4. One sound plays at a time on a single channel with a small queue; matches inside
   the cooldown are logged as `suppressed` rather than played
5. `tool_result` → the category whose `trigger` is `tool_success` or `tool_failure`
6. `agent_settled` → the `handback` category, once Pi has no automatic work left
   and the user can type again
7. `session_shutdown` → kills the player process and clears the queue

Status line while running: `🎧 emote on · default · hmm → confusion`.

## Files

```
emote-audio-pi/
  README.md               this doc
  config.json             pack selection and shared settings
  index.ts                the extension
  packs/<pack>/           one directory per soundpack
    config.json           that pack's mapping and setting overrides
    <folder>/             the takes for one category
  synth/handback.py       generates the default pack's handback takes
```
