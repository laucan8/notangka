"""Quantise a melody + beat-level chords into NotAngka text (the format the web UI renders).

Text format (one music line per row):
    title: ...            header lines (title, artist, key, meter, tempo)
    @Reff                 section label for the next row
    [C]3 2 1 . | [Am]1 . 5(67) 0 |
    L: syl- la- ble _ ... lyrics for the previous row (one token per note, '_' = no syllable)

Beat tokens are separated by spaces; atoms inside one token share that beat
('56' = two 1/2-beat notes, '5(67)' = 1/2 + 1/4 + 1/4). '.' = hold, '0' = rest,
"'" = octave up dot, ',' = octave down dot, '#4' / 'b7' = accidentals.
"""
from __future__ import annotations

import numpy as np

from .theory import chord_name, degree_symbol, key_label

METERS = {"4/4": (4, False), "3/4": (3, False), "2/4": (2, False), "6/8": (2, True), "12/8": (4, True)}


def _pos(times, grid):
    """Seconds -> fractional beat index (linear extrapolation beyond grid)."""
    idx = np.arange(len(grid), dtype=float)
    t = np.asarray(times, float)
    p = np.interp(t, grid, idx)
    ibi0 = grid[1] - grid[0]
    ibi1 = grid[-1] - grid[-2]
    p = np.where(t < grid[0], (t - grid[0]) / ibi0, p)
    p = np.where(t > grid[-1], len(grid) - 1 + (t - grid[-1]) / ibi1, p)
    return p


def choose_base(melody, do_pc):
    """MIDI of the unmarked 'do' so that most notes need no octave dot."""
    if not melody:
        return 60 + do_pc
    ps = np.array([m[2] for m in melody])
    w = np.array([m[1] - m[0] for m in melody])
    best, bb = -1, 60 + do_pc
    for base in range(36 + do_pc, 84, 12):
        # window: low 5 (sol) .. high 1 counts as "near" too, with lower weight
        inside = ((ps >= base) & (ps < base + 12)).astype(float)
        near = ((ps >= base - 5) & (ps < base + 13)).astype(float) * 0.25
        sc = float(((inside + near) * (0.5 + w)).sum())
        if sc > best:
            best, bb = sc, base
    return bb


def quantise(melody, grid, R, compound, quant, fill_gap_beats):
    """Return list of (slot_on, slot_off, note_index) on a fine grid of R slots/beat, and per-beat grid."""
    if not melody:
        return [], {}
    on = _pos([m[0] for m in melody], grid)
    off = _pos([m[1] for m in melody], grid)
    beat_grid_choice: dict[int, int] = {}
    if compound:
        G_opts = [3]
    elif quant == "2":
        G_opts = [2]
    elif quant == "4":
        G_opts = [4]
    else:
        G_opts = [2, 4]
    # group onsets by beat (using finest grid)
    gmax = max(G_opts)
    beats_notes: dict[int, list[int]] = {}
    for i, o in enumerate(on):
        b = int(np.floor(np.round(o * gmax) / gmax))
        beats_notes.setdefault(b, []).append(i)
    slot_on = np.zeros(len(melody), int)
    for b, idxs in beats_notes.items():
        G = G_opts[0]
        if len(G_opts) > 1:
            q2 = np.round(on[idxs] * 2)
            e2 = np.abs(on[idxs] * 2 - q2).sum() / 2
            e4 = np.abs(on[idxs] * 4 - np.round(on[idxs] * 4)).sum() / 4
            collide = len(set(q2.tolist())) < len(idxs)
            if collide or (e2 - e4) > 0.075 * len(idxs):
                G = 4
        beat_grid_choice[b] = G
        for i in idxs:
            slot_on[i] = int(round(np.round(on[i] * G) / G * R))
    # dedupe identical onsets: keep the longer note
    order = sorted(range(len(melody)), key=lambda i: (slot_on[i], -(off[i] - on[i])))
    kept, last = [], None
    for i in order:
        if last is not None and slot_on[i] == last:
            continue
        kept.append(i)
        last = slot_on[i]
    events = []
    fill = int(round(fill_gap_beats * R))
    for k, i in enumerate(kept):
        s = slot_on[i]
        b = int(np.floor(off[i]))
        G = beat_grid_choice.get(b, G_opts[0])
        step = R // G
        e = int(round(off[i] * R / step)) * step
        e = max(e, s + 1)
        if k + 1 < len(kept):
            nxt = slot_on[kept[k + 1]]
            e = min(e, nxt)
            if nxt - e <= fill:
                e = nxt
        events.append((s, e, i))
    return events, beat_grid_choice


def _beat_atoms(syms, R, compound):
    """syms: R slot symbols for one beat ('N:i', 'H', 'R'). Returns DSL token pieces and note idx list."""
    divs = [1, 3] if compound else [1, 2, 4]
    divs = [d for d in divs if R % d == 0]
    for g in divs:
        size = R // g
        ok = True
        for k in range(g):
            grp = syms[k * size:(k + 1) * size]
            head = grp[0]
            rest_ok = "R" if head == "R" else "H"
            if any(x != rest_ok for x in grp[1:]):
                ok = False
                break
        if ok:
            break
    heads = [syms[k * (R // g)] for k in range(g)]
    if g == 4:  # merge pairs -> 8th + 16ths
        items = []
        for k in (0, 2):
            a, b = heads[k], heads[k + 1]
            if (b == "H" and a != "R") or (a == "R" and b == "R"):
                items.append([a])
            else:
                items.append([a, b])
        return items
    return [[h] for h in heads]


def build_text(melody, grid, labels, phase, meter, do_pc, tonic_pc, mode, bpm,
               syllables=None, quant="auto", fill_gap_beats=0.5, bars_per_line=4,
               title="", artist=""):
    N, compound = METERS.get(meter, (4, False))
    R = 3 if compound else 4
    events, _ = quantise(melody, grid, R, compound, quant, fill_gap_beats)
    base = choose_base(melody, do_pc)
    head = [f"title: {title or 'Tanpa judul'}"]
    if artist:
        head.append(f"artist: {artist}")
    head += [f"key: {key_label(tonic_pc, mode)}", f"meter: {meter}", f"tempo: {int(round(bpm))}", ""]
    if not events:
        return "\n".join(head + ["0 0 0 0 |"]), {"bars": 0}

    first_on, last_off = events[0][0], events[-1][1]
    beat0 = first_on // R
    # bar containing the first note
    bar_start_beat = phase + ((beat0 - phase) // N) * N
    pickup = (beat0 - bar_start_beat) >= max(1, N // 2) and N > 2
    start_beat = beat0 if pickup else bar_start_beat
    last_on_beat = events[-1][0] // R
    end_beat = phase + ((last_on_beat - phase) // N + 1) * N   # end of the bar holding the last onset
    if last_off > (end_beat + N / 2) * R:
        end_beat = phase + int(np.ceil((int(np.ceil(last_off / R)) - phase) / N)) * N
    # extend last note to the end of its bar
    s, e, i = events[-1]
    events[-1] = (s, max(e, end_beat * R), i)

    total = (end_beat - start_beat) * R
    off0 = start_beat * R
    slots = ["R"] * total
    for s, e, i in events:
        a, b = s - off0, min(e - off0, total)
        if a < 0 or a >= total:
            continue
        slots[a] = f"N:{i}"
        for k in range(a + 1, b):
            slots[k] = "H"

    def chord_at(beat):
        if 0 <= beat < len(labels):
            return labels[beat]
        return None

    # bar ranges in beats
    bars = []
    b = start_beat
    nxt = bar_start_beat + N if pickup else start_beat + N
    while b < end_beat:
        bars.append((b, nxt))
        b, nxt = nxt, nxt + N

    rows, row_tokens, row_sylls, bar_texts = [], [], [], []
    prev_chord = None
    lines_out = []
    bar_in_line = 0
    cur_line, cur_syl = [], []
    empty_run = []

    def note_sym(i):
        sym, octv = degree_symbol(melody[i][2], do_pc, base)
        return sym + ("'" * octv if octv > 0 else "," * (-octv))

    for bi, (b0, b1) in enumerate(bars):
        toks, syl = [], []
        all_rest = True
        for beat in range(b0, b1):
            sy = slots[(beat - start_beat) * R:(beat - start_beat + 1) * R]
            items = _beat_atoms(sy, R, compound)
            pieces = []
            for grp in items:
                strs = []
                for h in grp:
                    if h.startswith("N:"):
                        idx = int(h[2:])
                        strs.append(note_sym(idx))
                        syl.append((syllables or {}).get(idx) or "_")
                        all_rest = False
                    elif h == "H":
                        strs.append(".")
                        all_rest = False
                    else:
                        strs.append("0")
                pieces.append(strs[0] if len(strs) == 1 else "(" + "".join(strs) + ")")
            tok = "".join(pieces)
            if len(items) == 1 and len(items[0]) == 1:
                tok = pieces[0]
            ch = chord_at(beat)
            line_start = bar_in_line == 0 and beat == b0
            if ch is not None and (ch != prev_chord or line_start):
                tok = f"[{chord_name(ch[0], ch[1], do_pc)}]" + tok
            prev_chord = ch
            toks.append(tok)
        silent_bar = all_rest and all(chord_at(x) is None for x in range(b0, b1))
        if silent_bar:
            empty_run.append(1)
            if len(empty_run) >= 2:
                continue
        else:
            empty_run = []
        cur_line.append(" ".join(toks))
        cur_syl.extend(syl)
        is_pickup = pickup and bi == 0
        if not is_pickup:
            bar_in_line += 1
        if bar_in_line >= bars_per_line:
            lines_out.append((cur_line, cur_syl))
            cur_line, cur_syl, bar_in_line = [], [], 0
    if cur_line:
        lines_out.append((cur_line, cur_syl))

    body = []
    for k, (bl, sl) in enumerate(lines_out):
        end = " ||" if k == len(lines_out) - 1 else " |"
        body.append(" | ".join(bl) + end)
        if syllables and any(x != "_" for x in sl):
            body.append("L: " + " ".join(sl))
    return "\n".join(head + body), {"bars": len(bars), "pickup": bool(pickup), "base_midi": int(base)}
