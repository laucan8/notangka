"""Beat grid, chroma features, key detection, chord recognition, downbeat estimation."""
from __future__ import annotations

import numpy as np

from .theory import QUALITIES, SIMPLE_QUALS, EXTENDED_QUALS, diatonic_chords

SR = 22050
HOP = 512

# Krumhansl-Kessler key profiles
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


# ---------------------------------------------------------------- features
def compute_features(mix_path, harmony_path=None, bpm_hint=None):
    """Heavy, cache-able audio features.

    mix_path: full mix (beats). harmony_path: accompaniment stem for chroma (or None = mix)."""
    import librosa

    y, _ = librosa.load(str(mix_path), sr=SR, mono=True)
    dur = len(y) / SR
    onset_env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median)
    kw = {"bpm": float(bpm_hint)} if bpm_hint else {}
    tempo, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=SR, hop_length=HOP,
                                           tightness=120, units="time", **kw)
    tempo = float(np.atleast_1d(tempo)[0])

    yh_src = y
    if harmony_path:
        yh_src, _ = librosa.load(str(harmony_path), sr=SR, mono=True)
    yh = librosa.effects.harmonic(yh_src, margin=2.0)
    chroma = librosa.feature.chroma_cqt(y=yh, sr=SR, hop_length=HOP, bins_per_octave=36,
                                        fmin=librosa.note_to_hz("C2"), n_octaves=5)
    C = np.abs(librosa.cqt(yh, sr=SR, hop_length=HOP, fmin=librosa.note_to_hz("C1"),
                           n_bins=36, bins_per_octave=12))
    bass = C.reshape(3, 12, -1).sum(axis=0)
    rms = librosa.feature.rms(y=yh_src, hop_length=HOP)[0]
    # low-frequency onset envelope (bass/kick hits mark downbeats)
    S = np.abs(librosa.stft(y, hop_length=HOP, n_fft=2048))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    low = S[freqs < 180]
    low_onset = np.maximum(0, np.diff(np.log1p(low.sum(axis=0)), prepend=0))
    n = min(chroma.shape[1], bass.shape[1], len(rms), len(low_onset), len(onset_env))
    return {
        "duration": dur, "tempo": tempo, "beats": np.asarray(beats, float),
        "chroma": chroma[:, :n].astype(np.float32), "bass": bass[:, :n].astype(np.float32),
        "rms": rms[:n].astype(np.float32), "low_onset": low_onset[:n].astype(np.float32),
        "onset_env": onset_env[:n].astype(np.float32),
        "frame_times": librosa.frames_to_time(np.arange(n), sr=SR, hop_length=HOP).astype(np.float32),
    }


# ---------------------------------------------------------------- beat grid
def beat_grid(raw_beats, duration, onset_env, frame_times, factor=1.0):
    """Regularised beat grid covering the whole track, with tempo factor (x2, x1/2, x1/3...)."""
    b = np.asarray(raw_beats, float)
    if len(b) < 4:  # fallback: 90 bpm
        b = np.arange(0, duration, 60 / 90)
    if factor >= 1.5:
        k = int(round(factor))
        nb = []
        for i in range(len(b) - 1):
            nb.extend(b[i] + (b[i + 1] - b[i]) * j / k for j in range(k))
        nb.append(b[-1])
        b = np.array(nb)
    elif factor <= 0.75:
        k = int(round(1 / factor))
        strength = np.interp(b, frame_times, onset_env)
        phase = int(np.argmax([strength[p::k].mean() for p in range(k)]))
        b = b[phase::k]
    ibi = float(np.median(np.diff(b)))
    pre = []
    t = b[0] - ibi
    while t > -0.5 * ibi:
        pre.append(t)
        t -= ibi
    post = []
    t = b[-1] + ibi
    while t < duration + ibi:
        post.append(t)
        t += ibi
    return np.concatenate([np.array(pre[::-1]), b, np.array(post)]), 60.0 / ibi


def beat_sync(feat, frame_times, grid, agg=np.median):
    """Aggregate frame features (d x n) between consecutive grid points -> d x (len(grid)-1)."""
    idx = np.searchsorted(frame_times, grid)
    out = np.zeros((feat.shape[0], len(grid) - 1), np.float32)
    for i in range(len(grid) - 1):
        a, b = idx[i], max(idx[i + 1], idx[i] + 1)
        if a >= feat.shape[1]:
            break
        out[:, i] = agg(feat[:, a:b], axis=1)
    return out


# ---------------------------------------------------------------- key
def detect_key(chroma_beats, melody=None, weights=None):
    """Krumhansl-Schmuckler on summed chroma (+ melody pitch-class histogram)."""
    prof = (chroma_beats * (weights if weights is not None else 1)).sum(axis=1)
    prof = prof / (prof.sum() + 1e-9)
    if melody:
        h = np.zeros(12)
        for s, e, p, *_ in melody:
            h[p % 12] += e - s
        prof = prof + 0.6 * h / (h.sum() + 1e-9)
    best, res = -2, (0, "major")
    for t in range(12):
        for mode, P in (("major", KK_MAJOR), ("minor", KK_MINOR)):
            r = np.corrcoef(prof, np.roll(P, t))[0, 1]
            if r > best:
                best, res = r, (t, mode)
    return res[0], res[1], float(best)


def refine_mode(tonic, mode, labels):
    """Decide major vs relative minor using chord statistics (same 'do' either way)."""
    do = (tonic + 3) % 12 if mode == "minor" else tonic
    rel_minor = (do + 9) % 12
    seq = [l for l in labels if l is not None]
    if not seq:
        return tonic, mode
    dur_I = sum(1 for r, q in seq if r == do and q in ("", "maj7"))
    dur_vi = sum(1 for r, q in seq if r == rel_minor and q in ("m", "m7"))
    last = seq[-1]
    first = seq[0]
    score_minor = (dur_vi - dur_I) / max(1, len(seq)) * 4
    score_minor += 1.0 if last == (rel_minor, "m") else (-1.0 if last == (do, "") else 0)
    score_minor += 0.5 if first == (rel_minor, "m") else (-0.5 if first == (do, "") else 0)
    if score_minor > 0.6:
        return rel_minor, "minor"
    return do, "major"


# ---------------------------------------------------------------- chords
def _templates(quals):
    names, T = [], []
    for root in range(12):
        for q in quals:
            iv, w = QUALITIES[q]
            t = np.zeros(12)
            for i, ww in zip(iv, w):
                t[(root + i) % 12] = ww
            names.append((root, q))
            T.append(t / np.linalg.norm(t))
    return names, np.array(T)


def recognize_chords(chroma_b, bass_b, energy_b, do_pc=None, vocab="simple",
                     note_chroma_b=None, p_stay=0.88):
    """Beat-level chord labels via template matching + Viterbi. Returns list of (root, qual) or None."""
    quals = SIMPLE_QUALS if vocab == "simple" else EXTENDED_QUALS
    names, T = _templates(quals)
    X = chroma_b.copy()
    X = X / (np.linalg.norm(X, axis=0, keepdims=True) + 1e-9)
    if note_chroma_b is not None:
        Nc = note_chroma_b / (np.linalg.norm(note_chroma_b, axis=0, keepdims=True) + 1e-9)
        has = (note_chroma_b.sum(axis=0) > 0)
        X[:, has] = 0.5 * X[:, has] + 0.5 * Nc[:, has]
        X = X / (np.linalg.norm(X, axis=0, keepdims=True) + 1e-9)
    S = T @ X  # (n_chords, n_beats) cosine
    # penalise 4-note chords slightly so triads win ties
    for k, (r, q) in enumerate(names):
        if len(q) > 1 and q != "m":
            S[k] -= 0.035
    # bass support for the root
    B = bass_b / (bass_b.max(axis=0, keepdims=True) + 1e-9)
    for k, (r, q) in enumerate(names):
        S[k] += 0.10 * B[r] - 0.03 * (1 - B[r])
    if do_pc is not None:
        dia = diatonic_chords(do_pc)
        for k, nm in enumerate(names):
            if nm in dia:
                S[k] += 0.04
    # 'no chord' state for silence
    e = energy_b / (np.median(energy_b[energy_b > 0]) + 1e-9) if np.any(energy_b > 0) else energy_b
    silent = e < 0.12
    n_states = len(names) + 1
    beta = 22.0
    E = np.vstack([S * beta, np.full((1, S.shape[1]), 0.55 * beta)])
    E[:-1, silent] -= 40
    E[-1, ~silent] -= 6
    logA = np.full((n_states, n_states), np.log((1 - p_stay) / (n_states - 1)))
    np.fill_diagonal(logA, np.log(p_stay))
    nb = S.shape[1]
    D = np.zeros((n_states, nb))
    P = np.zeros((n_states, nb), int)
    D[:, 0] = E[:, 0]
    for t in range(1, nb):
        M = D[:, t - 1][:, None] + logA
        P[:, t] = np.argmax(M, axis=0)
        D[:, t] = M[P[:, t], np.arange(n_states)] + E[:, t]
    path = np.zeros(nb, int)
    path[-1] = int(np.argmax(D[:, -1]))
    for t in range(nb - 1, 0, -1):
        path[t - 1] = P[path[t], t]
    labels = [None if k == len(names) else names[k] for k in path]
    return labels, S, names


def simplify_chords(labels, S, names, mode="auto", phase=0, beats_per_bar=4):
    """Enforce a chord rhythm: 'beat' | 'auto' (min 2 beats) | 'half' | 'bar'."""
    labels = list(labels)
    n = len(labels)
    idx = {nm: k for k, nm in enumerate(names)}
    if mode in ("half", "bar"):
        seg = beats_per_bar if mode == "bar" else max(1, beats_per_bar // 2)
        if beats_per_bar == 3 and mode == "half":
            seg = 3
        start = phase % seg - seg if phase % seg else 0
        for a in range(start, n, seg):
            lo, hi = max(0, a), min(n, a + seg)
            if hi <= lo:
                continue
            cand = [l for l in labels[lo:hi] if l is not None]
            if not cand:
                continue
            scores = {}
            for l in set(cand):
                scores[l] = float(S[idx[l], lo:hi].sum()) + 0.05 * cand.count(l)
            best = max(scores, key=scores.get)
            for i in range(lo, hi):
                labels[i] = best if labels[i] is not None else None
        return labels
    if mode == "auto":
        changed = True
        while changed:
            changed = False
            segs = []
            i = 0
            while i < n:
                j = i
                while j + 1 < n and labels[j + 1] == labels[i]:
                    j += 1
                segs.append((i, j))
                i = j + 1
            for si, (a, b) in enumerate(segs):
                if labels[a] is None or b - a + 1 >= 2:
                    continue
                prev = labels[segs[si - 1][0]] if si > 0 else None
                nxt = labels[segs[si + 1][0]] if si + 1 < len(segs) else None
                opts = [o for o in (prev, nxt) if o is not None]
                if not opts:
                    continue
                best = max(opts, key=lambda o: S[idx[o], a:b + 1].sum())
                for k in range(a, b + 1):
                    labels[k] = best
                changed = True
                break
    return labels


# ---------------------------------------------------------------- downbeat
def estimate_downbeat_phase(labels, low_onset_b, beats_per_bar, onset_b=None):
    """Pick bar phase where chord changes + bass hits line up best."""
    n = len(labels)
    change = np.array([1.0 if i > 0 and labels[i] != labels[i - 1] and labels[i] is not None else 0.0
                       for i in range(n)])
    lo = low_onset_b / (np.percentile(low_onset_b, 95) + 1e-9)
    lo = np.clip(lo, 0, 1.5)
    scores = []
    for p in range(beats_per_bar):
        sel = np.arange(p, n, beats_per_bar)
        sc = change[sel].mean() * 2.0 + lo[sel].mean() * 0.8
        if onset_b is not None:
            on = onset_b / (np.percentile(onset_b, 95) + 1e-9)
            sc += 0.3 * on[sel].mean()
        scores.append(sc)
    return int(np.argmax(scores)), scores


def note_chroma_per_beat(notes, grid):
    """Duration-weighted pitch-class histogram of notes per beat interval."""
    nb = len(grid) - 1
    out = np.zeros((12, nb), np.float32)
    if not notes:
        return out
    for s, e, p, a in notes:
        i0 = max(0, np.searchsorted(grid, s, "right") - 1)
        i1 = min(nb - 1, np.searchsorted(grid, e, "right") - 1)
        for i in range(i0, i1 + 1):
            ov = min(e, grid[i + 1]) - max(s, grid[i])
            if ov > 0:
                w = ov * a * (1.6 if p < 55 else 1.0)
                out[p % 12, i] += w
    return out
