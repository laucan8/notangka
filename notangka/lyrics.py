"""Optional lyric transcription (faster-whisper / openai-whisper) and syllable-to-note alignment."""
from __future__ import annotations

import re

from .audio import has_module

VOWELS = set("aeiouyAEIOUYàáâäèéêëìíîïòóôöùúûü")
DIGRAPHS = ("ng", "ny", "kh", "sy", "ch", "sh", "th", "ph", "gh", "wh", "ck")


def whisper_available() -> bool:
    return has_module("faster_whisper") or has_module("whisper")


def transcribe_words(audio_path, language=None, model_size="small"):
    """Return (words, lang): words = list of {w, start, end} with word-level timestamps."""
    words = []
    if has_module("faster_whisper"):
        from faster_whisper import WhisperModel
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segs, info = model.transcribe(str(audio_path), language=language or None,
                                   word_timestamps=True, vad_filter=True,
                                   condition_on_previous_text=False)
        for seg in segs:
            for w in seg.words or []:
                t = w.word.strip()
                if t:
                    words.append({"w": t, "start": float(w.start), "end": float(w.end)})
        return words, getattr(info, "language", language or "")
    if has_module("whisper"):
        import whisper
        model = whisper.load_model(model_size)
        res = model.transcribe(str(audio_path), language=language or None, word_timestamps=True)
        for seg in res.get("segments", []):
            for w in seg.get("words", []):
                t = w["word"].strip()
                if t:
                    words.append({"w": t, "start": float(w["start"]), "end": float(w["end"])})
        return words, res.get("language", language or "")
    raise RuntimeError("Whisper belum terinstall (pip install -r requirements-extra.txt)")


ID_DIPHTHONG_END = ("ai", "au", "oi", "ei")


def syllabify(word: str, lang: str = "") -> list[str]:
    """Heuristic syllable split. lang='id' -> Indonesian rules, otherwise English-ish."""
    core = re.sub(r"[^\w'’-]", "", word)
    if len(core) <= 2:
        return [word]
    low = core.lower()
    n = len(low)
    is_v = [c in VOWELS for c in low]
    indo = lang.startswith("id")
    if low[0] == "y" or indo:
        is_v = [v and c != "y" for v, c in zip(is_v, low)]
    if not indo:
        # silent final e (make, time, love) — but keep consonant+le (lit-tle, ta-ble)
        if low.endswith("e") and n >= 3 and not is_v[-2] and sum(is_v[:-1]) >= 1 and low[-2] != "l":
            is_v[-1] = False
        # past tense -ed after a consonant other than t/d is not a syllable (saved, played)
        if low.endswith("ed") and n > 3 and low[-3] not in "td" and sum(is_v[:-2]) >= 1:
            is_v[-2] = False
    # vowel nuclei
    groups = []
    i = 0
    while i < n:
        if is_v[i]:
            j = i
            if indo:
                # every vowel is its own nucleus except word-final diphthongs (pantai, pulau)
                if i + 1 < n and is_v[i + 1] and i + 2 == n and low[i:i + 2] in ID_DIPHTHONG_END:
                    j = i + 1
            else:
                while j + 1 < n and is_v[j + 1]:
                    j += 1
            groups.append((i, j))
            i = j + 1
        else:
            i += 1
    if not indo and len(groups) >= 2 and low.endswith("le") and n > 3 and not is_v[-3]:
        # consonant + le forms its own syllable: lit-tle, twin-kle
        groups[-1] = (n - 1, n - 1)
    if len(groups) <= 1:
        return [word]
    cuts = []
    for (a1, b1), (a2, b2) in zip(groups, groups[1:]):
        cons = low[b1 + 1:a2]
        k = len(cons)
        if not indo and a2 == n - 1 and low.endswith("le"):
            cut = a2 - 2                      # ...|Cle (lit-tle, ta-ble)
        elif k == 0:
            cut = a2                          # vowel hiatus: di|a
        elif k == 1:
            cut = b1 + 1                      # V|CV
        elif cons[-2:] in DIGRAPHS:
            cut = a2 - 2                      # la|ngit, me|nya
        else:
            cut = a2 - 1                      # VC|CV
        cuts.append(max(cut, b1 + 1))
    parts, prev = [], 0
    for c in cuts:
        parts.append(core[prev:c])
        prev = c
    parts.append(core[prev:])
    parts = [p for p in parts if p]
    return parts or [word]


def align(words, melody, tol=0.30, lang=""):
    """Assign syllables to melody notes. Returns {note_index: syllable_text}."""
    out: dict[int, str] = {}
    if not words or not melody:
        return out
    onsets = [m[0] for m in melody]
    used = set()
    last_idx = -1
    for w in words:
        sylls = syllabify(w["w"], lang)
        lo, hi = w["start"] - tol, max(w["end"], w["start"] + 0.15)
        cand = [i for i, t in enumerate(onsets) if lo <= t < hi and i not in used and i > last_idx]
        if not cand:
            nxt = [i for i, t in enumerate(onsets) if t >= w["start"] and i not in used and i > last_idx]
            if nxt and onsets[nxt[0]] - w["start"] < 0.6:
                cand = [nxt[0]]
        if not cand:
            if last_idx >= 0:  # attach to previous note
                out[last_idx] = out.get(last_idx, "").rstrip("-") + "~" + w["w"]
            continue
        k = len(sylls)
        if len(cand) >= k:
            for j, s in enumerate(sylls):
                out[cand[j]] = s + ("-" if j < k - 1 else "")
                used.add(cand[j])
            last_idx = cand[k - 1]
        else:
            for j, ci in enumerate(cand):
                if j < len(cand) - 1:
                    out[ci] = sylls[j] + "-"
                else:
                    out[ci] = "".join(sylls[j:])
                used.add(ci)
            last_idx = cand[-1]
    # sanitize: DSL tokens cannot contain spaces
    return {i: re.sub(r"\s+", "~", s) for i, s in out.items()}
