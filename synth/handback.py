#!/usr/bin/env python3
"""Synthesize the handback takes for the default soundpack.

A handback cue is a two-note call and response: the model's note, a short rest,
then a higher note that rings longer - the turn is over and input is free again.
The notes are bells, with inharmonic partials, a short attack and a soft release,
so the cue reads as a chime rather than a melody and stays apart from the rising
and falling tool cues.

Each take rolls its own pitch, interval, rest and note lengths, and each roll
comes from the take's seed, so rerunning the script writes the same ten files
again. Takes are 16-bit mono PCM at 22050 Hz like the rest of the pack, and
takes land at the same peak level as the rest of the pack.

Needs numpy. Run from the extension directory:

    python3 synth/handback.py
"""

import argparse
import random
import wave
from pathlib import Path

import numpy as np

SR = 22050
RATIOS = (1.0, 2.76, 5.40, 8.93)  # inharmonic bell partials
GAINS = (1.0, 0.45, 0.24, 0.11)
DECAYS = (0.35, 0.18, 0.11, 0.06)  # share of the note each partial rings for
ATTACK = 0.004
RELEASE = 0.025  # the note's last breath, so nothing ends with a click
PEAK = 0.34
TAKES = 10
INTERVALS = (4 / 3, 3 / 2, 5 / 4, 9 / 8, 2.0)  # the response sits above the call


def bell(freq: float, seconds: float, gain: float, rng: random.Random) -> np.ndarray:
    n = int(seconds * SR)
    t = np.arange(n) / SR
    detune = 1.0 + rng.uniform(-0.004, 0.004)
    out = np.zeros(n)
    for ratio, partial_gain, ring in zip(RATIOS, GAINS, DECAYS):
        out += partial_gain * np.sin(2 * np.pi * freq * ratio * detune * t) * np.exp(-t / (seconds * ring))
    ramp = min(int(ATTACK * SR), n)
    out[:ramp] *= np.linspace(0.0, 1.0, ramp)
    tail = min(int(RELEASE * SR), n - ramp)
    out[n - tail:] *= np.linspace(1.0, 0.0, tail)
    return out * gain


def take(seed: int) -> np.ndarray:
    rng = random.Random(seed)
    call_freq = rng.uniform(520.0, 700.0)
    response_freq = call_freq * rng.choice(INTERVALS)
    call = bell(call_freq, rng.uniform(0.28, 0.40), rng.uniform(0.85, 1.0), rng)
    rest = np.zeros(int(rng.uniform(0.14, 0.24) * SR))
    response = bell(response_freq, rng.uniform(0.45, 0.65), rng.uniform(0.75, 1.0), rng)

    out = np.concatenate([call, rest, response])
    peak = float(np.max(np.abs(out)))
    return out if peak == 0 else out * (PEAK / peak)


def main() -> None:
    here = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Write the handback takes of the default pack.")
    parser.add_argument("--out", default=str(here / "packs" / "default" / "handback"))
    parser.add_argument("--takes", type=int, default=TAKES)
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(1, args.takes + 1):
        samples = take(i)
        with wave.open(str(out_dir / f"take-{i:02d}.wav"), "wb") as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(SR)
            f.writeframes((samples * 32768).astype("<i2").tobytes())
        print(f"take-{i:02d}.wav {len(samples) / SR:.2f}s")


if __name__ == "__main__":
    main()
