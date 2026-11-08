"""Polyphonic note transcription (Spotify basic-pitch) and melody extraction."""
from __future__ import annotations

import contextlib
import io
import logging
from pathlib import Path

import numpy as np

# Note tuple: (onset_s, offset_s, midi_pitch, amplitude)


def _model_path():
    from basic_pitch import FilenameSuffix, build_icassp_2022_model_path, ICASSP_2022_MODEL_PATH
    try:
        import onnxruntime  # noqa: F401
        p = build_icassp_2022_model_path(FilenameSuffix.onnx)
        if p.exists():
            return p
    except ImportError:
        pass
    return ICASSP_2022_MODEL_PATH


def transcribe_notes(audio_path: Path, onset_threshold=0.5, frame_threshold=0.3,
                     min_note_ms=70.0, fmin=None, fmax=None):
    """Run basic-pitch. Returns (notes list, pretty_midi object)."""
    logging.getLogger().setLevel(logging.ERROR)
    with contextlib.redirect_stdout(io.StringIO()):
        from basic_pitch.inference import predict
        out, midi, events = predict(
            str(audio_path), _model_path(),
            onset_threshold=onset_threshold, frame_threshold=frame_threshold,
            minimum_note_length=min_note_ms, minimum_frequency=fmin, maximum_frequency=fmax,
            melodia_trick=True,
        )
    notes = sorted((float(s), float(e), int(p), float(a)) for s, e, p, a, *_ in events)
    from basic_pitch.note_creation import model_frames_to_time
    post = np.asarray(out["note"], dtype=np.float16)          # frames x 88 (MIDI 21..108)
    times = model_frames_to_time(post.shape[0]).astype(np.float32)
    return notes, midi, post, times


def extend_sustain(notes, post, times, rel=0.45, floor=0.2, max_ext=3.0):
    """Extend note offsets while the frame activation stays high (piano decay truncates offsets)."""
    if post is None or len(times) == 0:
        return notes
    fps = 1.0 / float(np.median(np.diff(times[:200])))
    out = []
    by_pitch: dict[int, list[float]] = {}
    for s, e, p, a in notes:
        by_pitch.setdefault(p, []).append(s)
    for s, e, p, a in notes:
        k = p - 21
        if not 0 <= k < post.shape[1]:
            out.append((s, e, p, a))
            continue
        i0 = int(np.searchsorted(times, s))
        i1 = int(np.searchsorted(times, e))
        peak = float(post[i0:max(i1, i0 + 1), k].max()) if i1 > i0 else float(post[min(i0, len(post) - 1), k])
        thr = max(floor, rel * peak)
        nxt = [t for t in by_pitch[p] if t > s + 0.02]
        limit = min([e + max_ext] + [t - 0.01 for t in nxt])
        j = i1
        jmax = min(len(times) - 1, int(np.searchsorted(times, limit)))
        while j < jmax and float(post[j, k]) >= thr:
            j += 1
        e2 = max(e, float(times[min(j, len(times) - 1)]))
        out.append((s, e2, p, a))
    return out


def remove_harmonic_ghosts(notes, tol=0.05, end_tol=0.15):
    """Drop weak notes that are octave/12th/2-octave overtones of a stronger note with the same
    onset AND offset (a real doubled melody note usually has its own duration)."""
    keep = []
    arr = np.array([(n[0], n[2], n[3], n[1]) for n in notes]) if notes else np.zeros((0, 4))
    for i, n in enumerate(notes):
        s, e, p, a = n
        ghost = False
        if len(arr):
            near = np.abs(arr[:, 0] - s) <= tol
            for j in np.where(near)[0]:
                if j == i:
                    continue
                pj, aj, ej = arr[j, 1], arr[j, 2], arr[j, 3]
                if (p - pj) in (12, 19, 24) and a < 0.75 * aj and abs(e - ej) < end_tol:
                    ghost = True
                    break
        if not ghost:
            keep.append(n)
    return keep


def _interval_pen(d):
    d = abs(d)
    if d <= 2:
        return 0.0
    if d <= 5:
        return 0.12
    if d <= 7:
        return 0.3
    if d < 12:
        return 0.6
    if d == 12:
        return 0.9
    return 2.0


def extract_melody(notes, min_pitch=55, max_pitch=96, min_dur=0.07, onset_tol=0.05,
                   min_amp_rel=0.18, window=10):
    """Melody = top voice with continuity (dynamic programming over onset clusters).

    Each cluster of simultaneous onsets offers its top-3 notes; the path rewards high/loud notes,
    penalises big leaps and penalises 'interrupting' a still-sounding melody note with a lower
    (accompaniment) note. Skipping clusters is allowed (melody rests / held notes)."""
    if not notes:
        return []
    amps = np.array([n[3] for n in notes])
    amp_ref = float(np.percentile(amps, 90)) + 1e-9
    clean = remove_harmonic_ghosts(notes)
    cand = [n for n in clean if min_pitch <= n[2] <= max_pitch
            and (n[1] - n[0]) >= min_dur and n[3] >= min_amp_rel * amp_ref]
    if not cand:
        return []
    cand.sort(key=lambda n: (n[0], -n[2]))
    clusters: list[list] = []
    for n in cand:
        if clusters and n[0] - clusters[-1][0][0] <= onset_tol:
            clusters[-1].append(n)
        else:
            clusters.append([n])
    opts = [sorted(c, key=lambda n: -n[2])[:3] for c in clusters]
    tops = [o[0][2] for o in opts]
    t0 = [c[0][0] for c in clusters]
    K = len(opts)
    NEG = -1e18

    def reward(k, j):
        n = opts[k][j]
        return 1.0 + (0.5 if j == 0 else -0.4 * j) + 0.3 * min(1.0, n[3] / amp_ref) \
            + 0.2 * min(1.0, (n[1] - n[0]) / 0.6)

    def skip_cost(prev, m):
        """Cost of NOT picking cluster m while 'prev' is the current melody note."""
        sounding = prev[1] > t0[m] + 0.05
        if sounding:
            return 0.05 if tops[m] <= prev[2] else 0.7
        return 0.35 if tops[m] < prev[2] - 2 else 0.75

    def interrupt_pen(prev, n):
        if prev[1] <= n[0] + 0.05:
            return 0.0
        drop = prev[2] - n[2]
        if drop <= 2:
            return 0.1
        return 0.3 + 0.12 * drop

    best = [[NEG] * len(o) for o in opts]
    back: list[list] = [[None] * len(o) for o in opts]
    gbest = [NEG] * K
    garg = [None] * K
    REST = 0.4
    run_max, run_arg = NEG, None   # max over k2 <= k-window-1 of gbest[k2] + REST*k2
    for k in range(K):
        k_far = k - window - 1
        if k_far >= 0 and gbest[k_far] > NEG and gbest[k_far] + REST * k_far > run_max:
            run_max, run_arg = gbest[k_far] + REST * k_far, (k_far, garg[k_far])
        for j, n in enumerate(opts[k]):
            r = reward(k, j)
            val, bp = r - 0.5 * min(k, 3), None   # fresh start (small penalty)
            if run_arg is not None:
                v = run_max - REST * (k - 1) + r
                if v > val:
                    val, bp = v, run_arg
            for k2 in range(max(0, k - window), k):
                for j2, n2 in enumerate(opts[k2]):
                    b = best[k2][j2]
                    if b <= NEG:
                        continue
                    sc = b + r - _interval_pen(n[2] - n2[2]) - interrupt_pen(n2, n)
                    for m in range(k2 + 1, k):
                        sc -= skip_cost(n2, m)
                    if sc > val:
                        val, bp = sc, (k2, j2)
            best[k][j], back[k][j] = val, bp
            if val > gbest[k]:
                gbest[k], garg[k] = val, j
    # backtrack from the best end
    k = int(np.argmax(gbest))
    j = garg[k]
    path = []
    while k is not None and j is not None:
        path.append(opts[k][j])
        bp = back[k][j]
        if bp is None:
            break
        k, j = bp
    path.reverse()
    mel = [list(n) for n in path]
    for i in range(len(mel) - 1):
        mel[i][1] = min(mel[i][1], mel[i + 1][0])

    # merge same-pitch re-onsets that coincide with an octave-below attack (harmonic ghost)
    all_on = np.array([(n[0], n[2]) for n in notes])
    merged = []
    for n in mel:
        if merged and n[2] == merged[-1][2] and merged[-1][1] >= n[0] - 0.06:
            near = all_on[np.abs(all_on[:, 0] - n[0]) <= 0.05]
            octave_hit = any((n[2] - q) in (12, 24) for q in near[:, 1])
            ratio = n[3] / (merged[-1][3] + 1e-9)
            if (octave_hit and ratio < 0.65) or ratio < 0.45:
                merged[-1][1] = max(merged[-1][1], n[1])
                continue
        merged.append(n)
    mel = merged
    # merge tiny fragments: very short note followed by same pitch -> join
    out = []
    for n in mel:
        if out and n[2] == out[-1][2] and n[0] - out[-1][1] < 0.03 and (out[-1][1] - out[-1][0]) < 0.09:
            out[-1][1] = n[1]
            continue
        if n[1] - n[0] >= 0.05:
            out.append(n)
    # fix isolated octave jumps (x, x+12, x) -> fold back
    for i in range(1, len(out) - 1):
        a, b, c = out[i - 1][2], out[i][2], out[i + 1][2]
        if abs(b - a) >= 12 and abs(b - c) >= 12 and abs(a - c) <= 5:
            out[i][2] = b - 12 * round((b - (a + c) / 2) / 12)
    return [tuple(n) for n in out]


def accompaniment_notes(notes, melody, tol=0.05):
    """Notes not belonging to the melody line (used as a harmony cue for chords)."""
    mel_keys = {(round(m[0], 2), m[2]) for m in melody}
    res = []
    for n in notes:
        if (round(n[0], 2), n[2]) in mel_keys:
            continue
        res.append(n)
    return res
