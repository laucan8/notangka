"""NotAngka local web app.  Jalankan:  python app.py   lalu buka http://127.0.0.1:8765"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import traceback
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from notangka import __version__
from notangka.pipeline import NOTATION_DEFAULTS, analyze, features_available, notate

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("NOTANGKA_DATA", ROOT / "data")) / "jobs"
DATA.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get("NOTANGKA_PORT", "8765"))

app = FastAPI(title="NotAngka", version=__version__)

# Halaman online (GitHub Pages) boleh memanggil server lokal ini. Tambah origin lain via NOTANGKA_ORIGINS.
ORIGINS = ["https://laucan8.github.io", f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"]
ORIGINS += [o.strip() for o in os.environ.get("NOTANGKA_ORIGINS", "").split(",") if o.strip()]
# allow_private_network: Chrome mengizinkan halaman https publik memanggil 127.0.0.1
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["*"], allow_headers=["*"],
                   allow_private_network=True)
pool = ThreadPoolExecutor(max_workers=1)   # audio jobs are heavy: one at a time
JOBS: dict[str, dict] = {}
LOCK = threading.Lock()


def _jd(job_id: str) -> Path:
    if not re.fullmatch(r"[\w-]{4,64}", job_id):
        raise HTTPException(400, "id tidak valid")
    return DATA / job_id


def _set(job_id, **kw):
    with LOCK:
        JOBS.setdefault(job_id, {}).update(kw)
        st = dict(JOBS[job_id])
    (_jd(job_id) / "status.json").write_text(json.dumps(st, ensure_ascii=False))


def _status(job_id):
    if job_id in JOBS:
        return dict(JOBS[job_id])
    f = _jd(job_id) / "status.json"
    if f.exists():
        return json.loads(f.read_text())
    raise HTTPException(404, "job tidak ditemukan")


def _run(job_id, url, file_path, opts, params):
    jd = _jd(job_id)
    try:
        _set(job_id, status="running", progress=0.01, message="Mulai…")
        analyze(jd, url=url or None, file_path=file_path, opts=opts,
                progress=lambda p, m: _set(job_id, progress=round(p, 3), message=m))
        res = notate(jd, params)
        _set(job_id, status="done", progress=1.0, message="Selesai", title=res["meta"].get("title"))
    except Exception as ex:  # report to UI
        traceback.print_exc()
        _set(job_id, status="error", message=str(ex) or ex.__class__.__name__)


@app.get("/")
def index():
    return FileResponse(ROOT / "docs" / "index.html")


@app.get("/api/health")
def health():
    return {"ok": True, "version": __version__, "features": features_available(),
            "defaults": NOTATION_DEFAULTS}


@app.post("/api/jobs")
async def create_job(url: str = Form(""), options: str = Form("{}"), params: str = Form("{}"),
                     file: UploadFile | None = File(None)):
    if not url and file is None:
        raise HTTPException(400, "Isi link YouTube atau pilih file audio.")
    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    jd = _jd(job_id)
    jd.mkdir(parents=True)
    fpath = None
    if file is not None and file.filename:
        ext = Path(file.filename).suffix or ".bin"
        fpath = jd / f"upload{ext}"
        with fpath.open("wb") as f:
            shutil.copyfileobj(file.file, f)
    _set(job_id, status="queued", progress=0, message="Antre…", created=time.time(),
         source=url or (file.filename if file else ""))
    opts = json.loads(options or "{}")
    if fpath is not None:
        opts["title"] = Path(file.filename).stem
    pool.submit(_run, job_id, url.strip(), fpath, opts, json.loads(params or "{}"))
    return {"id": job_id}


@app.get("/api/jobs")
def list_jobs():
    items = []
    for d in sorted(DATA.iterdir(), reverse=True):
        st = d / "status.json"
        if not st.exists():
            continue
        s = json.loads(st.read_text())
        meta = {}
        if (d / "result_meta.json").exists():
            meta = json.loads((d / "result_meta.json").read_text())
        items.append({"id": d.name, "status": s.get("status"), "title": meta.get("title") or s.get("source"),
                      "key": meta.get("key"), "created": s.get("created")})
    return items[:50]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    st = _status(job_id)
    jd = _jd(job_id)
    if st.get("status") == "done":
        txt = jd / ("edited.txt" if (jd / "edited.txt").exists() else "result.txt")
        st["text"] = txt.read_text()
        st["edited"] = (jd / "edited.txt").exists()
        st["meta"] = json.loads((jd / "result_meta.json").read_text())
    return st


@app.post("/api/jobs/{job_id}/renotate")
def renotate(job_id: str, params: dict = Body(...)):
    jd = _jd(job_id)
    if not (jd / "features.npz").exists():
        raise HTTPException(409, "Analisis belum selesai")
    try:
        res = notate(jd, params)
    except Exception as ex:
        traceback.print_exc()
        raise HTTPException(500, str(ex))
    (jd / "edited.txt").unlink(missing_ok=True)
    return res


@app.post("/api/jobs/{job_id}/save")
def save(job_id: str, body: dict = Body(...)):
    jd = _jd(job_id)
    (jd / "edited.txt").write_text(body.get("text", ""))
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
def delete(job_id: str):
    shutil.rmtree(_jd(job_id), ignore_errors=True)
    JOBS.pop(job_id, None)
    return {"ok": True}


@app.get("/api/jobs/{job_id}/midi")
def midi(job_id: str):
    f = _jd(job_id) / "transcription.mid"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="audio/midi", filename=f"{job_id}.mid")


@app.get("/api/jobs/{job_id}/audio")
def audio(job_id: str):
    f = _jd(job_id) / "audio.wav"
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="audio/wav")


# file statis UI (engine.js, vendor/, model/) — dipasang paling akhir agar /api/* tetap diutamakan
app.mount("/", StaticFiles(directory=ROOT / "docs", html=True), name="docs")


if __name__ == "__main__":
    import uvicorn
    url = f"http://127.0.0.1:{PORT}"
    print(f"\n  NotAngka berjalan di {url}  (Ctrl+C untuk berhenti)\n")
    if not os.environ.get("NOTANGKA_NO_BROWSER"):
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
