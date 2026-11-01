# Emote Audio Pi Extension

Plays a short sound when the reasoning stream shows an emotional expression, so
you can tell what the model is doing from across the room without reading the
trace. Tool results get a musical cue: rising notes when a call worked, falling
notes when it failed.

The extension only plays audio. `config.json` decides which word fires which
folder of takes.

## Usage

```bash
pi --extension ./emote-audio-pi
```

Pi loads a subdirectory through `index.ts`. In `settings.json` you can list the
directory itself as a package path.

## Configuration

`config.json` is the only startup configuration. Each `categories` entry is one
folder under `soundsDir`: **the key is the folder name**, `words` are the words
that fire it (whole words, matched case-insensitively in the reasoning stream),
and `priority` entries keep their slot in the queue. Tool cues have no words;
they name the outcome that fires them.

```json
{
  "soundsDir": "sounds",
  "settings": {
    "enabled": true,
    "muted": false,
    "dryRun": false,
    "matchText": false,
    "skipNestedTools": true,
    "cooldownMs": 2500,
    "minGapMs": 500,
    "maxQueue": 2
  },
  "categories": {
    "confusion": { "words": ["hmm", "hmmh", "hmmm"] },
    "tool_failure": { "trigger": "tool_failure", "priority": true }
  }
}
```

Add a word to a list and that word fires that folder, so `positive_assessment`
with `"words": ["good", "excellent"]` hears the same cue for both. A folder does
not need to match a word list: any name works as long as `config.json` names it.

Settings:

| Key | Default | Meaning |
|-----|---------|---------|
| `soundsDir` | `sounds` | Folder holding one subfolder per category |
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

## Takes

Each folder holds any number of audio files (`take-01.wav`, `take-03.mp3`, …).
One take per category is picked at a time from a shuffled bag: every file in the
folder is heard once before any repeats, and the bag reshuffles when it runs dry.
A folder with two takes cycles two, a folder with one take repeats that one, and
an empty folder logs `no takes`. Any format your player accepts works, and the
extension plays whatever is there - it never synthesizes.

Players are tried in order: `paplay`, `pw-play`, `aplay`, `ffplay`, `mpv`.

## Runtime Commands

| Command | Description |
|---------|-------------|
| `/emote` | Status: mode, player, takes, last thing heard |
| `/emote on` / `/emote off` | Enable or disable |
| `/emote mute` | Keep counting matches, play nothing |
| `/emote dry` | Log what would play instead of playing it |
| `/emote stats` | Counts per category, plus played/suppressed/dropped/failed |
| `/emote legend` | Folder → words → take count |
| `/emote log` | Last 20 matches with the outcome of each |
| `/emote test <folder or word>` | Play one take now, e.g. `/emote test ugh` |
| `/emote set <key> <value>` | cooldown \| gap \| queue \| text \| nested |
| `/emote rescan` | Pick up files you dropped into a folder |

Examples:

```
/emote legend
/emote test confusion          ← fires whatever sounds/confusion/ holds
/emote set cooldown 4000
/emote stats
```

## How It Works

1. `session_start` → reads `config.json`, scans `soundsDir` for takes, finds a player
2. `message_update` → thinking deltas are scanned character by character, so a word
   split across two deltas is still caught when it completes
3. A completed word looks up its category, the cooldown is checked, and a take is
   pulled from that category's round-robin bag
4. One sound plays at a time on a single channel with a small queue; matches inside
   the cooldown are logged as `suppressed` rather than played
5. `tool_result` → the category whose `trigger` is `tool_success` or `tool_failure`
6. `session_shutdown` → kills the player process and clears the queue

Status line while running: `🎧 emote on · hmm → confusion`.

## Files

```
emote-audio-pi/
  config.json           word and tool mapping, settings
  emote-audio-pi.md     this doc
  index.ts              the extension
  sounds/<folder>/      the takes (placeholders for now)
```
