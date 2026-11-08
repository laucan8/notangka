# NotAngka — YouTube → Not Angka + Chord + Lirik

Aplikasi lokal (jalan di Mac kamu) yang mengubah **link YouTube** (cover piano, lagu asli, dll) atau **file audio** menjadi
lembar **not angka**: melodi tangan kanan (angka 1–7, titik oktaf, garis harga not) dan **chord** di atasnya untuk
tangan kiri / gitar. Bisa **transpose**, kasih **saran capo gitar**, dan **lirik** (otomatis via Whisper atau tempel manual).

## 0. Halaman online

**https://laucan8.github.io/notangka/** — tempel link YouTube di sana. Halaman ini terhubung otomatis ke server
NotAngka yang berjalan di Mac kamu (`./run.sh`), jadi audio diproses di komputer sendiri (gratis & privat).
Tanpa server lokal, halaman tetap bisa dipakai untuk melihat contoh, transpose, capo, lirik, putar, dan edit.
Gunakan Chrome (izinkan akses jaringan lokal jika diminta); di Safari buka `http://127.0.0.1:8765`.

## 1. Setup (sekali saja, macOS)

```bash
git clone https://github.com/laucan8/notangka.git
cd notangka
bash setup_mac.sh                # inti: not + chord   (~400 MB)
# atau
bash setup_mac.sh --full         # + pisah vokal (Demucs) + lirik otomatis (Whisper)  (~2 GB, disarankan)
```

Butuh [Homebrew](https://brew.sh). Skrip memasang `python@3.11`, `ffmpeg`, dan `deno` (dipakai yt-dlp untuk YouTube),
lalu membuat virtualenv `.venv`. Model Whisper (±250–500 MB) diunduh otomatis saat pertama dipakai.

## 2. Menjalankan

```bash
./run.sh            # atau double-click NotAngka.command
```

Browser terbuka di `http://127.0.0.1:8765`. Tempel link YouTube → **Proses**. Lagu 4 menit: ±30–60 detik (inti),
±2–5 menit jika pakai Demucs + Whisper di M1.

Command line juga bisa:

```bash
source .venv/bin/activate
python -m notangka.cli "https://youtu.be/xxxx" --meter 4/4 --lyrics --lang id -o lagu.txt
```

## 3. Fitur di halaman hasil

| Fitur | Keterangan |
|---|---|
| **Transpose (do = …)** | Not angka itu relatif (movable do): **angka tidak berubah**, yang berubah `do = …` dan nama chord. Contoh lagu asli E → pilih do = C: angka sama, chord E→C, A→F, B→G. Tombol −½ / +½ untuk geser per semitone. |
| **Capo gitar** | Tetap bunyi di nada pilihan, tapi chord ditulis dalam bentuk mudah. "Saran gitar" menampilkan kombinasi capo + bentuk kunci terbaik (C/G/D/A/E, atau Am/Em/Dm untuk lagu minor). |
| **Lirik on/off** | Lirik di bawah not; beberapa baris `L:` = bait 1, 2, … |
| **Putar** | Melodi + chord diputar dengan synth sederhana (bunyi sesuai transpose) dan not yang sedang diputar disorot — untuk cek hasil vs video. Klik sebuah not untuk mulai dari situ. Kecepatan 60–120%. |
| **Koreksi deteksi** | Ubah birama, tempo (÷2 / ×2), geser awal birama, paksa nada dasar, jenis/irama chord, resolusi ritme, batas bawah melodi — dihitung ulang dalam ±1 detik tanpa proses audio ulang. |
| **Edit** | Teks not angka bisa diedit langsung; tampilan ter-update otomatis. Ada fitur **Tempel lirik → bagi ke not**. |
| **Cetak / PDF** | Print browser → "Save as PDF". Panel kontrol otomatis disembunyikan. |
| **Simpan / Riwayat** | Editan tersimpan; hasil sebelumnya bisa dibuka lagi dari "Riwayat". |
| **MIDI** | Unduh hasil transkripsi mentah (semua not) untuk dibuka di GarageBand/MuseScore. |

## 4. Format teks

```
title: Judul
key: E            <- nada dasar asli; minor ditulis C#m (do = relatif mayor, konvensi Indonesia)
meter: 4/4
tempo: 92

@Reff
[E]3 2 1 . | [C#m]1 . 5(67) 0 | [A]6 . . 0 | [B]5 . . . ||
L: ka- ta- kan _ pa- da _ ku
```

- `1`–`7` not, `0` diam, `.` tahan · `5'` titik atas, `5,` titik bawah · `#4` / `b7` kres / mol
- **Spasi = ketukan.** `56` = 2 not dalam 1 ketukan (garis 1), `5(67)` = ½ + ¼ + ¼, `(56)7` = ¼ + ¼ + ½
- `[Am]` chord di atas not berikutnya · `|` birama, `||` akhir · `@Verse` label baris berikutnya
- `L:` lirik baris di atasnya: 1 token per not (bukan untuk `.`/`0`), `_` = lewati, `~` = spasi dalam satu token

## 5. Tips agar hasil akurat

1. **Paling bagus:** video piano solo yang jelas (melodi di tangan kanan, tanpa banyak efek), atau **lagu asli dengan
   vokal + Demucs** (melodi diambil dari suara penyanyi, chord dari musik).
2. Pilih **birama** yang benar sebelum proses (lagu ballad 6/8 / 12/8 sering terdeteksi sebagai 4/4).
3. Jika chord berubah di tempat aneh → *Koreksi → Geser awal birama* (+1/+2/+3).
4. Jika tempo dua kali lipat (banyak garis bawah) → *Tempo ÷2*; kalau terlalu jarang → *×2*.
5. Jika not iringan ikut masuk ke melodi → naikkan *Batas bawah melodi* ke C4 atau E4.
6. Gunakan **Putar** + video berdampingan untuk menemukan not yang salah, lalu perbaiki di **Edit**.

## 6. Batasan & risiko (penting)

- **Akurasi tidak 100%.** Transkripsi otomatis realistis ±70–85% benar untuk audio yang bersih; ritme (garis harga)
  dan oktaf adalah bagian paling sering perlu dikoreksi. Chord mayor/minor relatif andal; chord 7/sus/slash terbatas.
- **YouTube** kadang meminta verifikasi anti-bot → pilih *Opsi analisis → Cookies dari browser* (Chrome/Safari, harus
  sudah login YouTube), atau upload file audio. Jika download tiba-tiba gagal, update: `pip install -U "yt-dlp[default]"`.
- Mengunduh dari YouTube secara teknis di luar ketentuan layanan YouTube; gunakan untuk latihan pribadi.
  Lirik lagu berhak cipta — jangan sebarkan lembar hasil yang memuat lirik lengkap.
- Lirik otomatis (Whisper) pada nyanyian bisa salah dengar; pembagian suku kata bersifat heuristik.

## 7. Troubleshooting

| Masalah | Solusi |
|---|---|
| `ffmpeg tidak ditemukan` | `brew install ffmpeg` |
| `yt-dlp butuh JavaScript runtime` | `brew install deno` |
| Demucs/Whisper "belum terinstall" | `source .venv/bin/activate && pip install -r requirements-extra.txt` |
| Port 8765 dipakai | `NOTANGKA_PORT=8800 ./run.sh`, lalu ubah alamat server di ikon ⚙ halaman online |
| Halaman online tidak terhubung | Pastikan `./run.sh` jalan; di Chrome izinkan "akses jaringan lokal"; atau buka `http://127.0.0.1:8765` |
| Mau coba Demucs pakai GPU M1 | `NOTANGKA_DEMUCS_DEVICE=mps ./run.sh` (eksperimental; default cpu) |

## 8. Struktur

```
app.py                 server FastAPI + API job
docs/index.html        UI (juga dipublikasikan via GitHub Pages): input YouTube, render not angka, transpose, capo, lirik, putar, edit, cetak
notangka/audio.py      download YouTube (yt-dlp), konversi, Demucs
notangka/transcribe.py basic-pitch (Spotify) → not; ekstraksi melodi (top-voice + kontinuitas)
notangka/analysis.py   beat, chroma, nada dasar (Krumhansl), chord (template + Viterbi), awal birama
notangka/notation.py   kuantisasi ritme → teks not angka
notangka/lyrics.py     Whisper + pemenggalan suku kata (ID/EN) + penempatan ke not
tests/                 audio uji sintetis (lagu public domain) + smoke test
```
