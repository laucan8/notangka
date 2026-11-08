"""Command line:  python -m notangka.cli <link-youtube | file-audio> [opsi]"""
import argparse
import sys
import time
from pathlib import Path

from .pipeline import run_all


def main(argv=None):
    ap = argparse.ArgumentParser(description="YouTube/audio -> not angka + chord")
    ap.add_argument("source", help="link YouTube atau path file audio/video")
    ap.add_argument("--meter", default="4/4", choices=["4/4", "3/4", "2/4", "6/8", "12/8"])
    ap.add_argument("--mode", default="auto", choices=["auto", "piano", "vocal"])
    ap.add_argument("--no-separate", action="store_true", help="jangan pakai Demucs")
    ap.add_argument("--lyrics", action="store_true", help="transkripsi lirik (Whisper)")
    ap.add_argument("--lang", default="", help="bahasa lirik: id / en (kosong = otomatis)")
    ap.add_argument("--key", default="", help="paksa nada dasar asli, mis. E atau C#m")
    ap.add_argument("--cookies", default="", help="ambil cookies YouTube dari browser: chrome/safari/firefox")
    ap.add_argument("-o", "--out", help="simpan hasil ke file .txt")
    a = ap.parse_args(argv)
    is_url = a.source.startswith(("http://", "https://"))
    jd = Path("data/cli") / time.strftime("%Y%m%d-%H%M%S")
    opts = {"mode": a.mode, "separate": not a.no_separate, "lyrics": a.lyrics,
            "lyrics_lang": a.lang, "cookies_browser": a.cookies}
    res = run_all(jd, url=a.source if is_url else None, file_path=None if is_url else Path(a.source),
                  opts=opts, params={"meter": a.meter, "key_override": a.key},
                  progress=lambda p, m: print(f"[{int(p*100):3d}%] {m}", file=sys.stderr))
    if a.out:
        Path(a.out).write_text(res["text"])
        print(f"Tersimpan: {a.out}", file=sys.stderr)
    else:
        print(res["text"])


if __name__ == "__main__":
    main()
