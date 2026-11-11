// NotAngka AI worker — semua model berjalan di browser (ONNX Runtime Web: WebGPU bila ada, WASM bila tidak).
//  1) pisah vokal  : MDX-Net Kim_Vocal_2 (UVR) — STFT 7680/1024, 3072 bin x 256 frame
//  2) transkripsi  : Spotify basic-pitch (ONNX), batch per jendela 2 detik
//  3) lirik        : Whisper (transformers.js, *_timestamped) dengan timestamp per kata
//  4) fitur ketukan: spectral-flux onset envelope dari campuran
import { pipeline, env as tenv } from "@huggingface/transformers";
import * as ort from "onnxruntime-web/webgpu";
import { outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } from "@spotify/basic-pitch/esm/toMidi.js";
import { makeFFT } from "./fft.js";

tenv.allowLocalModels = false;

const MDX_URLS = [
  "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Kim_Vocal_2.onnx",
  "https://huggingface.co/memoavatar/memo/resolve/main/misc/vocal_separator/Kim_Vocal_2.onnx",
];
const MDX = { nfft: 7680, hop: 1024, dimF: 3072, dimT: 256, comp: 1.009 };
const BP = { N: 43844, hop: 36164, olapFrames: 30, fps: 86, sr: 22050 };

const post = (m, tr) => self.postMessage(m, tr || []);
let curId = 0;
const progress = (stage, p, msg) => post({ type: "progress", id: curId, stage, p: Math.max(0, Math.min(1, p)), msg });
const tick = () => new Promise(r => setTimeout(r, 0));

/* ---------------- device ---------------- */
let GPU = null;
async function detectGPU() {
  if (GPU) return GPU;
  GPU = { ok: false, f16: false };
  try {
    if (self.navigator && navigator.gpu) {
      const a = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (a) { GPU.ok = true; GPU.f16 = a.features.has("shader-f16"); }
    }
  } catch (e) {}
  return GPU;
}

/* ---------------- model download with persistent cache ---------------- */
async function fetchCached(urls, label) {
  urls = Array.isArray(urls) ? urls : [urls];
  let cache = null;
  try { cache = await caches.open("notangka-models-v1"); } catch (e) {}
  if (cache) for (const u of urls) { const hit = await cache.match(u); if (hit) return new Uint8Array(await hit.arrayBuffer()); }
  let lastErr = null;
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const total = +r.headers.get("content-length") || 0;
      const reader = r.body.getReader(); const chunks = []; let got = 0, lastT = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        chunks.push(value); got += value.length;
        const now = Date.now();
        if (now - lastT > 250) { lastT = now; progress("download", total ? got / total : 0, `Mengunduh ${label}… ${(got / 1e6).toFixed(0)}${total ? " / " + (total / 1e6).toFixed(0) : ""} MB (sekali saja)`); }
      }
      const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
      if (cache) { try { await cache.put(url, new Response(buf)); } catch (e) {} }
      return buf;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Gagal mengunduh ${label}: ${lastErr && lastErr.message}`);
}
const sessions = {};
async function getSession(key, urls, label) {
  if (sessions[key]) return sessions[key];
  const g = await detectGPU();
  const buf = await fetchCached(urls, label);
  progress("download", 1, `Menyiapkan ${label}…`);
  let s = null;
  if (g.ok) { try { s = await ort.InferenceSession.create(buf, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" }); } catch (e) { s = null; } }
  if (!s) s = await ort.InferenceSession.create(buf, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  sessions[key] = s;
  return s;
}

/* ---------------- DSP helpers ---------------- */
function firLowpass(numTaps, fc) {           // fc = cutoff / samplerate
  const h = new Float32Array(numTaps), M = (numTaps - 1) / 2; let s = 0;
  for (let k = 0; k < numTaps; k++) {
    const x = k - M, sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * k / (numTaps - 1)) + 0.08 * Math.cos(4 * Math.PI * k / (numTaps - 1));
    h[k] = sinc * w; s += h[k];
  }
  for (let k = 0; k < numTaps; k++) h[k] /= s;
  return h;
}
const H2 = firLowpass(63, 0.23);              // 44.1k -> 22.05k (cut ~10 kHz)
function down2(x) {
  const n = Math.floor(x.length / 2), y = new Float32Array(n), L = H2.length, M = (L - 1) >> 1;
  for (let i = 0; i < n; i++) {
    const c = 2 * i; let s = 0;
    for (let k = 0; k < L; k++) { const j = c + k - M; if (j >= 0 && j < x.length) s += x[j] * H2[k]; }
    y[i] = s;
  }
  return y;
}
const H16 = firLowpass(47, 7400 / 22050);
function to16k(x22) {                         // 22.05k -> 16k (lowpass + linear interpolation)
  const L = H16.length, M = (L - 1) >> 1, f = new Float32Array(x22.length);
  for (let i = 0; i < x22.length; i++) { let s = 0; for (let k = 0; k < L; k++) { const j = i + k - M; if (j >= 0 && j < x22.length) s += x22[j] * H16[k]; } f[i] = s; }
  const n = Math.floor(x22.length * 16000 / 22050), y = new Float32Array(n), r = 22050 / 16000;
  for (let i = 0; i < n; i++) { const t = i * r, a = Math.floor(t), b = Math.min(a + 1, f.length - 1), w = t - a; y[i] = f[a] * (1 - w) + f[b] * w; }
  return y;
}
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
const hann = n => { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };
const reflectIdx = (i, L) => { if (i < 0) i = -i; if (i >= L) i = 2 * (L - 1) - i; return i < 0 ? 0 : i >= L ? L - 1 : i; };

/* ---------------- onset envelope (spectral flux) ---------------- */
function onsetEnvelope(x) {                   // x @ 22050 Hz -> {env, low, fps}
  const nfft = 2048, hop = 512, fft = makeFFT(nfft), win = hann(nfft), half = nfft / 2;
  const T = 1 + Math.floor(x.length / hop);
  const nB = 72, fmin = 30, fmax = 8000, edges = [];
  for (let b = 0; b <= nB; b++) edges.push(Math.round((fmin * Math.pow(fmax / fmin, b / nB)) * nfft / BP.sr));
  const lowBands = []; for (let b = 0; b < nB; b++) if (edges[b + 1] * BP.sr / nfft < 180) lowBands.push(b);
  const db = new Float32Array(T * nB);
  const ar = new Float64Array(nfft), ai = new Float64Array(nfft), yr = new Float64Array(nfft), yi = new Float64Array(nfft);
  let gmax = -1e9;
  for (let t = 0; t < T; t += 2) {
    for (let i = 0; i < nfft; i++) {
      ar[i] = x[reflectIdx(t * hop + i - half, x.length)] * win[i];
      ai[i] = t + 1 < T ? x[reflectIdx((t + 1) * hop + i - half, x.length)] * win[i] : 0;
    }
    fft.forward(ar, ai, yr, yi);
    for (let q = 0; q < 2 && t + q < T; q++) {
      for (let b = 0; b < nB; b++) {
        let e = 0;
        for (let k = Math.max(1, edges[b]); k < Math.max(edges[b] + 1, edges[b + 1]); k++) {
          const k2 = (nfft - k) % nfft;
          // unpack two real spectra from one complex FFT
          const re = q === 0 ? 0.5 * (yr[k] + yr[k2]) : 0.5 * (yi[k] + yi[k2]);
          const im = q === 0 ? 0.5 * (yi[k] - yi[k2]) : -0.5 * (yr[k] - yr[k2]);
          e += re * re + im * im;
        }
        const v = 10 * Math.log10(e + 1e-10); db[(t + q) * nB + b] = v; if (v > gmax) gmax = v;
      }
    }
  }
  const env = new Float32Array(T), low = new Float32Array(T);
  for (let t = 1; t < T; t++) {
    let s = 0, sl = 0;
    for (let b = 0; b < nB; b++) {
      const a = Math.max(db[t * nB + b], gmax - 80), p = Math.max(db[(t - 1) * nB + b], gmax - 80);
      const d = Math.max(0, a - p); s += d;
    }
    for (const b of lowBands) { const a = Math.max(db[t * nB + b], gmax - 80), p = Math.max(db[(t - 1) * nB + b], gmax - 80); sl += Math.max(0, a - p); }
    env[t] = s / nB; low[t] = lowBands.length ? sl / lowBands.length : 0;
  }
  return { env, low, fps: BP.sr / hop };
}

/* ---------------- MDX-Net vocal separation ---------------- */
async function separate(mix) {               // mix @ 44.1 kHz mono -> vocals
  const sess = await getSession("mdx", MDX_URLS, "model pemisah vokal (67 MB)");
  const { nfft, hop, dimF, dimT, comp } = MDX;
  const trim = nfft / 2, chunk = hop * (dimT - 1), gen = chunk - 2 * trim;
  const N = mix.length, pad = gen + trim - (N % gen), total = trim + N + pad;
  const m = new Float32Array(total); m.set(mix, trim);
  const res = new Float32Array(total);
  const fft = makeFFT(nfft), win = hann(nfft), nb = nfft / 2 + 1;
  const ar = new Float64Array(nfft), ai = new Float64Array(nfft), yr = new Float64Array(nfft), yi = new Float64Array(nfft);
  const inp = new Float32Array(4 * dimF * dimT);
  const PL = chunk + nfft;                    // padded (center) length of one chunk
  const ola = new Float64Array(PL), wsum = new Float64Array(PL);
  for (let t = 0; t < dimT; t++) for (let i = 0; i < nfft; i++) wsum[t * hop + i] += win[i] * win[i];
  const part = new Float32Array(chunk);
  const nChunks = Math.ceil(total / chunk);
  const inName = sess.inputNames[0], outName = sess.outputNames[0];
  for (let c = 0; c < nChunks; c++) {
    const start = c * chunk;
    part.fill(0); part.set(m.subarray(start, Math.min(start + chunk, total)));
    // STFT (center, reflect) — two real frames per complex FFT
    for (let t = 0; t < dimT; t += 2) {
      for (let i = 0; i < nfft; i++) {
        ar[i] = part[reflectIdx(t * hop + i - trim, chunk)] * win[i];
        ai[i] = t + 1 < dimT ? part[reflectIdx((t + 1) * hop + i - trim, chunk)] * win[i] : 0;
      }
      fft.forward(ar, ai, yr, yi);
      for (let q = 0; q < 2 && t + q < dimT; q++) {
        for (let f = 0; f < dimF; f++) {
          const f2 = (nfft - f) % nfft;
          let re, im;
          if (q === 0) { re = 0.5 * (yr[f] + yr[f2]); im = 0.5 * (yi[f] - yi[f2]); }
          else { re = 0.5 * (yi[f] + yi[f2]); im = -0.5 * (yr[f] - yr[f2]); }
          if (f < 3) { re = 0; im = 0; }
          const tt = t + q;
          inp[(0 * dimF + f) * dimT + tt] = re; inp[(1 * dimF + f) * dimT + tt] = im;
          inp[(2 * dimF + f) * dimT + tt] = re; inp[(3 * dimF + f) * dimT + tt] = im;
        }
      }
    }
    const out = (await sess.run({ [inName]: new ort.Tensor("float32", inp, [1, 4, dimF, dimT]) }))[outName].data;
    // ISTFT of the averaged (L+R)/2 spectrum — two frames per inverse FFT
    ola.fill(0);
    for (let t = 0; t < dimT; t += 2) {
      for (let k = 0; k < nfft; k++) { ar[k] = 0; ai[k] = 0; }
      for (let q = 0; q < 2 && t + q < dimT; q++) {
        const tt = t + q;
        for (let f = 0; f < nb; f++) {
          let re = 0, im = 0;
          if (f < dimF) {
            re = 0.5 * (out[(0 * dimF + f) * dimT + tt] + out[(2 * dimF + f) * dimT + tt]);
            im = 0.5 * (out[(1 * dimF + f) * dimT + tt] + out[(3 * dimF + f) * dimT + tt]);
          }
          // Z = A + iB  with hermitian extension
          if (q === 0) { ar[f] += re; ai[f] += im; if (f > 0 && f < nfft - f) { ar[nfft - f] += re; ai[nfft - f] -= im; } }
          else { ar[f] -= im; ai[f] += re; if (f > 0 && f < nfft - f) { ar[nfft - f] += im; ai[nfft - f] += re; } }
        }
      }
      fft.inverse(ar, ai, yr, yi);
      for (let i = 0; i < nfft; i++) {
        ola[t * hop + i] += yr[i] * win[i];
        if (t + 1 < dimT) ola[(t + 1) * hop + i] += yi[i] * win[i];
      }
    }
    const n = Math.min(chunk, total - start);
    for (let i = 0; i < n; i++) { const w = wsum[i + trim]; res[start + i] = w > 1e-8 ? ola[i + trim] / w : 0; }
    progress("separate", (c + 1) / nChunks, `Memisahkan vokal… ${c + 1}/${nChunks}`);
    await tick();
  }
  const vocals = new Float32Array(N);
  for (let i = 0; i < N; i++) vocals[i] = res[trim + i] * comp;
  return vocals;
}

/* ---------------- basic-pitch ---------------- */
const frameTime = f => f * 256 / 22050 - ((256 / 22050) * (172 - 43844 / 256) + 0.0018) * Math.floor(f / 172);
async function basicPitch(x, bpUrl, label, stageP0, stageP1, minFreq = null) {
  const sess = await getSession("bp", bpUrl, "model not (0,2 MB)");
  const g = await detectGPU();
  const pre = (BP.olapFrames * 256) / 2;
  const padded = new Float32Array(pre + x.length); padded.set(x, pre);
  const starts = []; for (let i = 0; i < padded.length; i += BP.hop) starts.push(i);
  const B = g.ok ? 16 : 4, nOrig = Math.floor(x.length * BP.fps / BP.sr), olap = BP.olapFrames / 2;
  const frames = [], onsets = [], contours = [];
  for (let b0 = 0; b0 < starts.length; b0 += B) {
    const nb = Math.min(B, starts.length - b0), inp = new Float32Array(nb * BP.N);
    for (let w = 0; w < nb; w++) { const s = starts[b0 + w]; inp.set(padded.subarray(s, Math.min(s + BP.N, padded.length)), w * BP.N); }
    const out = await sess.run({ "serving_default_input_2:0": new ort.Tensor("float32", inp, [nb, BP.N, 1]) });
    const note = out["StatefulPartitionedCall:1"].data, onset = out["StatefulPartitionedCall:2"].data, cont = out["StatefulPartitionedCall:0"].data;
    for (let w = 0; w < nb; w++) for (let f = olap; f < 172 - olap; f++) {
      if (frames.length >= nOrig) break;
      const o88 = (w * 172 + f) * 88, o264 = (w * 172 + f) * 264;
      frames.push(Array.from(note.subarray(o88, o88 + 88)));
      onsets.push(Array.from(onset.subarray(o88, o88 + 88)));
      contours.push(Array.from(cont.subarray(o264, o264 + 264)));
    }
    progress("notes", stageP0 + (stageP1 - stageP0) * Math.min(1, (b0 + nb) / starts.length), `Transkripsi not (${label})…`);
    await tick();
  }
  const ev = noteFramesToTime(addPitchBendsToNoteEvents(contours, outputToNotesPoly(frames, onsets, 0.5, 0.3, 6, true, null, minFreq, true, 11)));
  const raw = ev.map(n => [n.startTimeSeconds, n.startTimeSeconds + n.durationSeconds, n.pitchMidi, n.amplitude]).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const times = new Float64Array(frames.length); for (let f = 0; f < frames.length; f++) times[f] = frameTime(f);
  return { raw, notes: extendSustain(raw, frames, times), frames, onsets, times };
}
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
function extendSustain(notes, frames, times, rel = 0.45, floor = 0.2, maxExt = 3.0) {
  const nF = frames.length; if (!nF) return notes;
  const byPitch = new Map();
  for (const n of notes) { if (!byPitch.has(n[2])) byPitch.set(n[2], []); byPitch.get(n[2]).push(n[0]); }
  return notes.map(([s, e, p, a]) => {
    const k = p - 21; if (k < 0 || k >= 88) return [s, e, p, a];
    const i0 = lowerBound(times, s), i1 = lowerBound(times, e);
    let peak = 0; for (let i = i0; i < Math.max(i1, i0 + 1) && i < nF; i++) peak = Math.max(peak, frames[i][k]);
    const thr = Math.max(floor, rel * peak);
    let limit = e + maxExt; for (const t of byPitch.get(p)) if (t > s + 0.02) limit = Math.min(limit, t - 0.01);
    let j = i1; const jmax = Math.min(nF - 1, lowerBound(times, limit));
    while (j < jmax && frames[j][k] >= thr) j++;
    return [s, Math.max(e, times[Math.min(j, nF - 1)]), p, a];
  });
}
function frameFeatures(frames) {
  const nF = frames.length, chroma = new Float32Array(nF * 12), bass = new Float32Array(nF * 12), energy = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const fr = frames[f]; let en = 0;
    for (let k = 0; k < 88; k++) {
      const v = fr[k], midi = k + 21; en += v;
      if (midi >= 36 && midi < 96) chroma[f * 12 + midi % 12] += v;
      if (midi >= 28 && midi < 55) bass[f * 12 + midi % 12] += v;
    }
    energy[f] = en;
  }
  return { chroma, bass, energy };
}

/* ---------------- Whisper (lyrics) ---------------- */
let ASR = null, asrKey = "";
async function getASR(size, forceCPU) {
  const g = await detectGPU();
  const gpu = g.ok && !forceCPU;
  const key = size + (gpu ? "-gpu" : "-cpu");
  if (ASR && asrKey === key) return ASR;
  const dtype = gpu ? (g.f16 ? { encoder_model: "fp16", decoder_model_merged: "q4f16" } : { encoder_model: "fp32", decoder_model_merged: "q4" })
                    : { encoder_model: "q8", decoder_model_merged: "q8" };
  const files = {};
  ASR = await pipeline("automatic-speech-recognition", `onnx-community/whisper-${size}_timestamped`, {
    device: gpu ? "webgpu" : "wasm", dtype,
    progress_callback: d => {
      if (d.status === "progress" && d.total) {
        files[d.file] = [d.loaded, d.total];
        let L = 0, T = 0; for (const k in files) { L += files[k][0]; T += files[k][1]; }
        progress("download", L / T, `Mengunduh model lirik (Whisper ${size})… ${(L / 1e6).toFixed(0)} / ${(T / 1e6).toFixed(0)} MB (sekali saja)`);
      }
    },
  });
  asrKey = key;
  return ASR;
}
function speechSegments(x, sr, maxLen = 28) {
  const hop = Math.round(0.05 * sr), n = Math.floor(x.length / hop), e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = rms(x, i * hop, (i + 1) * hop);
  const sorted = Float32Array.from(e).sort(), ref = sorted[Math.floor(sorted.length * 0.95)] || 1e-6;
  const active = e.map(v => (v > 0.08 * ref ? 1 : 0));
  const segs = []; let i = 0;
  while (i < n) {
    while (i < n && !active[i]) i++;
    if (i >= n) break;
    let a = Math.max(0, i - 4), b = a, lastActive = i;
    while (b < n && (b - a) * hop / sr < maxLen) { if (active[b]) lastActive = b; if (b - lastActive > 30) break; b++; }   // 1.5 s silence ends a segment
    if ((b - a) * hop / sr >= maxLen) {      // cut at quietest point in last 6 s
      let best = b, bv = Infinity;
      for (let k = Math.max(a + 1, b - Math.round(6 * sr / hop)); k < b; k++) if (e[k] < bv) { bv = e[k]; best = k; }
      b = best;
    }
    b = Math.min(n, Math.max(b, lastActive + 4));
    if ((b - a) * hop / sr > 0.8) segs.push([a * hop, Math.min(x.length, b * hop)]);
    i = b;
  }
  return segs;
}
const HALLU = /(terima kasih telah menonton|thanks for watching|subtitle|subscribe|amara\.org|♪|\[music\]|\(music\))/i;
async function transcribe(x16, lang, size) {
  const segs = speechSegments(x16, 16000);
  const words = [];
  let asr = await getASR(size, false), triedCPU = !(await detectGPU()).ok;
  for (let s = 0; s < segs.length; s++) {
    const [a, b] = segs[s], off = a / 16000;
    progress("lyrics", s / Math.max(1, segs.length), `Transkripsi lirik… bagian ${s + 1}/${segs.length}`);
    const opt = { return_timestamps: "word", task: "transcribe" };
    if (lang) opt.language = lang;
    let out;
    try { out = await asr(x16.slice(a, b), opt); }
    catch (e) { if (triedCPU) throw e; triedCPU = true; asr = await getASR(size, true); out = await asr(x16.slice(a, b), opt); }
    const chunks = (out && out.chunks) || [];
    if (!chunks.length && out && out.text && out.text.trim() && !triedCPU) {   // word timestamps failed on GPU -> retry on CPU
      triedCPU = true; asr = await getASR(size, true); out = await asr(x16.slice(a, b), opt);
    }
    for (const c of (out.chunks || [])) {
      const w = (c.text || "").trim(); if (!w || HALLU.test(w)) continue;
      const st = c.timestamp && c.timestamp[0], en = c.timestamp && c.timestamp[1];
      if (st == null || isNaN(st)) continue;
      words.push({ w, start: st + off, end: (en == null || isNaN(en) ? st + 0.3 : en) + off });
    }
    await tick();
  }
  // drop runaway repetitions (classic whisper hallucination)
  const clean = [];
  for (const w of words) { const k = clean.length; if (k >= 3 && clean[k - 1].w === w.w && clean[k - 2].w === w.w && clean[k - 3].w === w.w) continue; clean.push(w); }
  return clean;
}

/* ---------------- main ---------------- */
self.onmessage = async (e) => {
  const d = e.data || {};
  if (d.type === "probe") { post({ type: "probe", gpu: await detectGPU() }); return; }
  if (d.type !== "run") return;
  curId = d.id;
  const opts = d.opts || {}, mix = d.mix44, t0 = performance.now(), timing = {};
  try {
    const g = await detectGPU();
    post({ type: "info", id: d.id, gpu: g });
    const mix22 = down2(mix);
    progress("analysis", 0, "Menganalisis ketukan…");
    const on = onsetEnvelope(mix22);
    let vocals = null, ratio = 0, useVocal = false;
    if (opts.separate !== "off") {
      const ts = performance.now();
      vocals = await separate(mix);
      timing.separate = performance.now() - ts;
      let sv = 0, sa = 0; for (let i = 0; i < mix.length; i++) { const v = vocals[i], a = mix[i] - v; sv += v * v; sa += a * a; }
      ratio = Math.sqrt(sv / Math.max(1e-12, sa));
      useVocal = opts.separate === "on" || ratio > 0.2;
    }
    let acc22 = mix22, voc22 = null;
    if (vocals) {
      const acc = new Float32Array(mix.length); for (let i = 0; i < mix.length; i++) acc[i] = mix[i] - vocals[i];
      acc22 = down2(acc);
      if (useVocal) voc22 = down2(vocals);
    }
    const tn = performance.now();
    const harm = await basicPitch(acc22, opts.bpUrl, useVocal ? "musik" : "audio", 0, useVocal ? 0.5 : 1);
    let mel = harm;
    if (useVocal) {
      mel = await basicPitch(voc22, opts.bpUrl, "vokal", 0.5, 1, 70);
      // drop notes where the separated vocal is (almost) silent — separation residue / bleed
      const hop = 1102, ne = Math.floor(voc22.length / hop), en = new Float32Array(ne);
      for (let i = 0; i < ne; i++) en[i] = rms(voc22, i * hop, (i + 1) * hop);
      const ref = Float32Array.from(en).sort()[Math.floor(ne * 0.95)] || 1e-6;
      const keep = n => { const a = Math.floor(n[0] * 20), b = Math.max(a + 1, Math.ceil(n[1] * 20)); let s = 0, c = 0; for (let i = a; i < b && i < ne; i++) { s += en[i]; c++; } return c && s / c > 0.2 * ref; };
      mel = { ...mel, notes: mel.notes.filter(keep), raw: mel.raw.filter(keep) };
    }
    timing.notes = performance.now() - tn;
    const feats = frameFeatures(harm.frames);
    let words = [];
    if (opts.lyrics) {
      const tl = performance.now();
      words = await transcribe(to16k(useVocal ? voc22 : mix22), opts.lang || null, opts.whisper || "base");
      timing.lyrics = performance.now() - tl;
    }
    timing.total = performance.now() - t0;
    const times = Float32Array.from(harm.times);
    post({ type: "result", id: d.id, data: {
      melNotes: mel.notes, melNotesRaw: mel.raw, harmNotes: harm.notes, harmNotesRaw: harm.raw,
      times, chroma: feats.chroma, bass: feats.bass, energy: feats.energy,
      onsetEnv: on.env, lowEnv: on.low, envFps: on.fps, duration: mix.length / 44100,
      ratio, useVocal, separated: !!vocals, words, gpu: g, timing,
    } }, [times.buffer, feats.chroma.buffer, feats.bass.buffer, feats.energy.buffer, on.env.buffer, on.low.buffer]);
  } catch (err) {
    post({ type: "error", id: d.id, message: (err && err.message) || String(err) });
  }
};
