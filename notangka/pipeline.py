"""End-to-end pipeline with on-disk cache so notation can be re-generated cheaply."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

import numpy as np

from . import analysis as A
from .audio import download_youtube, has_module, load_json, save_json, separate_vocals, to_wav
from .lyrics import align, transcribe_words, whisper_available
from .notation import METERS, build_text
from .theory import KEY_NAMES, SHARP, FLAT, do_of
from .transcribe import accompaniment_notes, extend_sustain, extract_melody, transcribe_notes

NOTATION_DEFAULTS = {
    "meter": "4/4",
    "tempo_factor": 1.0,
    "phase_shift": 0,
    "key_override": "",        # e.g. "E" or "C#m"
    "chord_vocab": "simple",   # simple | extended
    "chord_rate": "auto",      # beat | auto | half | bar
    "quant": "auto",           # auto | 2 | 4
    "fill_gap": 0.5,           # beats; shorter gaps are tied into the previous note
    "bars_per_line": 4,
    "melody_min_pitch": None,  # MIDI; None = mode default
    "lyrics": True,
    "sustain": True,           # extend truncated piano notes using frame activations
}


def features_available():
    return {
        "basic_pitch": has_module("basic_pitch"),
        "yt_dlp": has_module("yt_dlp"),
        "demucs": has_module("demucs"),
        "whisper": whisper_available(),
    }


def parse_key(s: str):
    s = (s or "").strip()
    if not s:
        return None
    minor = s.endswith("m") and not s.endswith("maj")
    name = s[:-1] if minor else s
    name = name[0].upper() + name[1:]
    if name in SHARP:
        pc = SHARP.index(name)
    elif name in FLAT:
        pc = FLAT.index(name)
    else:
        raise ValueError(f"Nada dasar tidak dikenal: {s}")
    return pc, ("minor" if minor else "major")


def analyze(job_dir: Path, url: str | None = None, file_path: Path | None = None,
            opts: dict | None = None, progress=lambda p, m: None):
    """Heavy stage: acquire audio, (separate), transcribe, features, (lyrics). Results cached in job_dir."""
    opts = {"mode": "auto", "separate": True, "lyrics": False, "lyrics_lang": "",
            "whisper_model": "small", "bpm_hint": None, "cookies_browser": "", **(opts or {})}
    job_dir.mkdir(parents=True, exist_ok=True)
    meta = {"title": "", "artist": "", "youtube_id": None, "url": url}

    progress(0.02, "Mengambil audio…")
    if url:
        wav, info = download_youtube(url, job_dir, lambda f: progress(0.02 + 0.1 * f, "Download audio…"),
                                     cookies_browser=opts.get("cookies_browser") or "")
        meta.update(info)
    else:
        wav = to_wav(file_path, job_dir / "audio.wav")
        meta["title"] = opts.get("title") or Path(file_path).stem
    meta["audio"] = str(wav)

    mode = opts["mode"]
    melody_src, harmony_src = wav, None
    stems_ok = False
    if opts.get("separate") and mode != "piano" and has_module("demucs"):
        progress(0.15, "Memisahkan vokal & musik (Demucs)… bisa 1–3 menit")
        try:
            voc, acc = separate_vocals(wav, job_dir, device=os.environ.get("NOTANGKA_DEMUCS_DEVICE", "cpu"))
            stems_ok = True
        except Exception as ex:  # keep going without stems
            meta["warning"] = f"Separasi vokal gagal, lanjut tanpa separasi: {ex}"
    if stems_ok:
        if mode == "auto":
            import librosa
            yv, _ = librosa.load(str(voc), sr=11025)
            ya, _ = librosa.load(str(acc), sr=11025)
            ratio = float(np.sqrt(np.mean(yv ** 2)) / (np.sqrt(np.mean(ya ** 2)) + 1e-9))
            meta["vocal_ratio"] = ratio
            mode = "vocal" if ratio > 0.25 else "piano"
        if mode == "vocal":
            melody_src, harmony_src = voc, acc
    if mode == "auto":
        mode = "piano"
    meta["mode"] = mode

    progress(0.42, "Transkripsi not (basic-pitch)…")
    fmin = 80.0 if mode == "vocal" else None
    notes, midi, post, ptimes = transcribe_notes(melody_src, fmin=fmin)
    midi.write(str(job_dir / "transcription.mid"))
    save_json(notes, job_dir / "notes_raw.json")
    save_json(extend_sustain(notes, post, ptimes), job_dir / "notes.json")

    progress(0.62, "Analisis ketukan, nada dasar & chord…")
    feats = A.compute_features(wav, harmony_src, bpm_hint=opts.get("bpm_hint"))
    np.savez_compressed(job_dir / "features.npz", **{k: v for k, v in feats.items()
                                                     if isinstance(v, np.ndarray)},
                        duration=feats["duration"], tempo=feats["tempo"])

    words, lang = [], ""
    if opts.get("lyrics"):
        if whisper_available():
            progress(0.78, "Transkripsi lirik (Whisper)… bisa beberapa menit")
            try:
                words, lang = transcribe_words(melody_src if mode == "vocal" else wav,
                                               opts.get("lyrics_lang") or None, opts.get("whisper_model", "small"))
            except Exception as ex:
                meta["warning"] = f"Transkripsi lirik gagal: {ex}"
        else:
            meta["warning"] = "Whisper belum terinstall — lirik bisa ditempel manual di editor."
    save_json(words, job_dir / "words.json")
    meta["lang"] = lang
    save_json(meta, job_dir / "meta.json")
    progress(0.95, "Menyusun not angka…")
    return meta


def notate(job_dir: Path, params: dict | None = None) -> dict:
    """Cheap stage: melody/beat grid/key/chords/quantisation -> NotAngka text."""
    P = {**NOTATION_DEFAULTS, **(params or {})}
    meta = load_json(job_dir / "meta.json")
    nfile = "notes.json" if P["sustain"] else "notes_raw.json"
    notes = [tuple(n) for n in load_json(job_dir / nfile)]
    words = load_json(job_dir / "words.json") if (job_dir / "words.json").exists() else []
    F = np.load(job_dir / "features.npz")
    mode = meta.get("mode", "piano")

    min_pitch = P["melody_min_pitch"] or (45 if mode == "vocal" else 55)
    melody = extract_melody(notes, min_pitch=int(min_pitch))

    N, compound = METERS.get(P["meter"], (4, False))
    grid, bpm = A.beat_grid(F["beats"], float(F["duration"]), F["onset_env"], F["frame_times"],
                            float(P["tempo_factor"]))
    ft = F["frame_times"]
    chroma_b = A.beat_sync(F["chroma"], ft, grid)
    bass_b = A.beat_sync(F["bass"], ft, grid)
    energy_b = A.beat_sync(F["rms"][None], ft, grid, np.mean)[0]
    low_b = A.beat_sync(F["low_onset"][None], ft, grid, np.max)[0]
    on_b = A.beat_sync(F["onset_env"][None], ft, grid, np.max)[0]
    note_chroma = None
    if mode == "piano":
        note_chroma = A.note_chroma_per_beat(accompaniment_notes(notes, melody), grid)

    if P["key_override"]:
        tonic, kmode = parse_key(P["key_override"])
    else:
        tonic, kmode, _ = A.detect_key(chroma_b, melody, weights=energy_b)
    do_pc = do_of(tonic, kmode)
    labels, S, names = A.recognize_chords(chroma_b, bass_b, energy_b, do_pc, P["chord_vocab"], note_chroma)
    if not P["key_override"]:
        tonic, kmode = A.refine_mode(tonic, kmode, labels)
        do_pc = do_of(tonic, kmode)
    phase, _ = A.estimate_downbeat_phase(labels, low_b, N, on_b)
    phase = (phase + int(P["phase_shift"])) % N
    labels = A.simplify_chords(labels, S, names, P["chord_rate"], phase, N)

    syl = align(words, melody, lang=meta.get("lang", "")) if (P["lyrics"] and words) else None
    bpm_out = bpm / 1.0
    text, info = build_text(melody, grid, labels, phase, P["meter"], do_pc, tonic, kmode, bpm_out,
                            syllables=syl, quant=P["quant"], fill_gap_beats=float(P["fill_gap"]),
                            bars_per_line=int(P["bars_per_line"]),
                            title=meta.get("title", ""), artist=meta.get("artist", ""))
    (job_dir / "result.txt").write_text(text)
    out_meta = {
        "title": meta.get("title"), "artist": meta.get("artist"), "mode": mode,
        "youtube_id": meta.get("youtube_id"), "url": meta.get("url"),
        "key": text.split("key: ")[1].split("\n")[0], "do": KEY_NAMES[do_pc],
        "bpm": round(bpm, 1), "phase": phase, "n_melody_notes": len(melody),
        "has_words": bool(words), "warning": meta.get("warning"), "params": P, **info,
    }
    save_json(out_meta, job_dir / "result_meta.json")
    return {"text": text, "meta": out_meta}


def run_all(job_dir: Path, url=None, file_path=None, opts=None, params=None, progress=lambda p, m: None):
    analyze(job_dir, url, file_path, opts, progress)
    res = notate(job_dir, params)
    progress(1.0, "Selesai")
    return res


def cleanup_heavy(job_dir: Path):
    """Remove big intermediate files (stems, source downloads)."""
    shutil.rmtree(job_dir / "stems", ignore_errors=True)
    for p in job_dir.glob("source.*"):
        p.unlink(missing_ok=True)
