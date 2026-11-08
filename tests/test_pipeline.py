"""Smoke test on synthesised public-domain melodies:  python -m pytest -q tests  (or python tests/test_pipeline.py)"""
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import soundfile as sf  # noqa: E402

import make_test_audio as M  # noqa: E402
from notangka.pipeline import run_all  # noqa: E402


def _run(name, audio, meter):
    d = Path(tempfile.mkdtemp())
    wav = d / f"{name}.wav"
    sf.write(wav, audio, M.SR)
    return run_all(d / "job", file_path=wav, opts={"mode": "piano", "separate": False}, params={"meter": meter})


def test_ode_to_joy():
    r = _run("ode", M.song(M.OJ, M.OJ_CH, 69, 108, 4), "4/4")
    assert r["meta"]["key"] == "A"
    body = [l for l in r["text"].splitlines() if "|" in l]
    assert body[0].startswith("[A]3 3 4 5 | [E]5 4 3 2")


def test_amazing_grace_pickup_and_key():
    r = _run("ag", M.song(M.AG, M.AG_CH, 64, 84, 3, pickup_beats=1), "3/4")
    assert r["meta"]["key"] == "E" and r["meta"]["pickup"]
    body = [l for l in r["text"].splitlines() if "|" in l]
    assert body[0].startswith("[E]5, | [E]1 . 31 | 3 . 2")


if __name__ == "__main__":
    test_ode_to_joy()
    test_amazing_grace_pickup_and_key()
    print("OK")
