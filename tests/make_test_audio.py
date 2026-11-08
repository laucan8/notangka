"""Synthesise piano-like test recordings of PUBLIC-DOMAIN melodies (for pipeline testing).

Usage: python tests/make_test_audio.py out_dir
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
rng = np.random.default_rng(7)


def tone(midi, dur, vel=0.8):
    f0 = 440 * 2 ** ((midi - 69) / 12)
    n = int((dur + 0.6) * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    B = 0.0004
    for h in range(1, 10):
        fh = f0 * h * np.sqrt(1 + B * h * h)
        if fh > SR / 2.2:
            break
        y += (1 / h ** 1.15) * np.sin(2 * np.pi * fh * t + rng.uniform(0, 6.28)) * np.exp(-t * (0.9 + 0.5 * h))
    att = np.minimum(1, t / 0.004)
    rel = np.where(t > dur, np.exp(-(t - dur) / 0.08), 1.0)
    return vel * y * att * rel


def render(events, total):
    out = np.zeros(int((total + 2) * SR))
    for t0, midi, dur, vel in events:
        t0 += rng.normal(0, 0.008)
        x = tone(midi, dur, vel)
        a = max(0, int(t0 * SR))
        out[a:a + len(x)] += x[: len(out) - a]
    out /= np.max(np.abs(out)) + 1e-9
    return 0.8 * out + rng.normal(0, 0.002, len(out))


CH = {"": [0, 4, 7], "m": [0, 3, 7], "7": [0, 4, 7, 10]}


def song(melody, chords, do_midi, bpm, beats_per_bar, pickup_beats=0):
    """melody: list of (semitones from do | None, beats). chords: per bar (degree, quality)."""
    spb = 60 / bpm
    ev = []
    t = 0.0
    for semi, beats in melody:
        if semi is not None:
            ev.append((t * spb, do_midi + semi, beats * spb * 0.95, 0.9))
        t += beats
    # accompaniment
    bar_t = pickup_beats
    for deg, q in chords:
        root = do_midi - 12 + deg
        while root > do_midi - 7:
            root -= 12
        ev.append((bar_t * spb, root - 12, beats_per_bar * spb * 0.9, 0.55))  # bass
        tri = [root + i for i in CH[q]]
        while max(tri) >= do_midi - 5:      # keep accompaniment below the melody
            tri = [x - 12 for x in tri]
        for b in range(1, beats_per_bar):
            for p in tri:
                ev.append(((bar_t + b) * spb, p, spb * 0.8, 0.28))
        bar_t += beats_per_bar
    return render(ev, max(t, bar_t) * spb)


# Amazing Grace (melody "New Britain", 1829; text 1779) — public domain. 3/4, pickup.
AG = [(-5, 1),
      (0, 2), (4, .5), (0, .5), (4, 2), (2, 1), (0, 2), (-3, 1), (-5, 2), (-5, 1),
      (0, 2), (4, .5), (0, .5), (4, 2), (2, .5), (4, .5), (7, 3), (7, 2), (4, 1),
      (7, 2), (4, .5), (0, .5), (4, 2), (2, 1), (0, 2), (-3, 1), (-5, 2), (-5, 1),
      (0, 2), (4, .5), (0, .5), (4, 2), (2, 1), (0, 3), (0, 3)]
AG_CH = [(0, ""), (0, "7"), (5, ""), (0, ""), (0, ""), (9, "m"), (7, ""), (7, ""),
         (0, ""), (0, "7"), (5, ""), (0, ""), (0, ""), (7, ""), (0, ""), (0, "")]

# Ode to Joy (Beethoven, 1824) — public domain. 4/4.
OJ = [(4, 1), (4, 1), (5, 1), (7, 1), (7, 1), (5, 1), (4, 1), (2, 1),
      (0, 1), (0, 1), (2, 1), (4, 1), (4, 1.5), (2, .5), (2, 2),
      (4, 1), (4, 1), (5, 1), (7, 1), (7, 1), (5, 1), (4, 1), (2, 1),
      (0, 1), (0, 1), (2, 1), (4, 1), (2, 1.5), (0, .5), (0, 2)]
OJ_CH = [(0, ""), (7, ""), (0, ""), (7, ""), (0, ""), (7, ""), (0, ""), (0, "")]

if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "test_audio")
    out.mkdir(parents=True, exist_ok=True)
    sf.write(out / "amazing_grace_E.wav", song(AG, AG_CH, 64, 84, 3, pickup_beats=1), SR)
    sf.write(out / "ode_to_joy_A.wav", song(OJ, OJ_CH, 69, 108, 4), SR)
    print("written to", out)
