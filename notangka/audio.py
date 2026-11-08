"""Audio acquisition (YouTube / local file) and optional source separation."""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path


def has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def ffmpeg_ok() -> bool:
    return shutil.which("ffmpeg") is not None


def download_youtube(url: str, workdir: Path, progress=None, cookies_browser: str = "") -> tuple[Path, dict]:
    """Download best audio from a YouTube (or any yt-dlp supported) URL -> WAV.

    Returns (wav_path, info) where info has title/uploader/duration/id."""
    import yt_dlp

    workdir.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(workdir / "source.%(ext)s")

    def hook(d):
        if progress and d.get("status") == "downloading":
            tot = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if tot:
                progress(d.get("downloaded_bytes", 0) / tot)

    opts = {
        "format": "bestaudio/best",
        "outtmpl": out_tmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
    }
    if cookies_browser:
        opts["cookiesfrombrowser"] = (cookies_browser,)
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except Exception as ex:
        msg = str(ex)
        if "not a bot" in msg or "Sign in" in msg or "429" in msg:
            raise RuntimeError(
                "YouTube meminta verifikasi (anti-bot). Pilih 'Cookies dari browser' (mis. Chrome) di Opsi "
                "analisis, pastikan sudah login YouTube di browser itu, lalu coba lagi. Alternatif: upload file audio.")
        if "JavaScript runtime" in msg or "js-runtimes" in msg:
            raise RuntimeError("yt-dlp butuh JavaScript runtime. Install: brew install deno")
        raise RuntimeError(f"Download gagal: {msg[-400:]}")
    src = workdir / "source.wav"
    if not src.exists():
        cands = sorted(workdir.glob("source.*"))
        if not cands:
            raise RuntimeError("Download gagal: file audio tidak ditemukan.")
        src = cands[0]
    meta = {
        "title": info.get("title") or "Tanpa judul",
        "artist": info.get("artist") or info.get("uploader") or "",
        "duration": info.get("duration"),
        "youtube_id": info.get("id") if "youtube" in (info.get("extractor") or "") else None,
        "url": url,
    }
    return to_wav(src, workdir / "audio.wav"), meta


def to_wav(src: Path, dst: Path, sr: int = 44100) -> Path:
    """Convert any audio/video file to mono WAV with ffmpeg."""
    if not ffmpeg_ok():
        raise RuntimeError("ffmpeg tidak ditemukan. Install: brew install ffmpeg")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", str(sr), str(dst)]
    subprocess.run(cmd, check=True)
    return dst


def separate_vocals(wav: Path, workdir: Path, device: str = "cpu") -> tuple[Path, Path]:
    """Split into vocals / accompaniment with Demucs (htdemucs). Returns (vocals, no_vocals)."""
    if not has_module("demucs"):
        raise RuntimeError("Demucs belum terinstall (pip install -r requirements-extra.txt)")
    out = workdir / "stems"
    cmd = [sys.executable, "-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs",
           "-d", device, "-o", str(out), str(wav)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("Demucs gagal: " + (r.stderr or r.stdout)[-800:])
    d = out / "htdemucs" / wav.stem
    voc, acc = d / "vocals.wav", d / "no_vocals.wav"
    if not voc.exists() or not acc.exists():
        raise RuntimeError("Output Demucs tidak ditemukan")
    return voc, acc


def save_json(obj, path: Path):
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1))


def load_json(path: Path):
    return json.loads(path.read_text())
