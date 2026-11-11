/* NotAngka browser engine — audio → not angka, 100% di browser (tanpa server).
 * Port dari pipeline Python (notangka/*.py). Butuh vendor/basic-pitch.js (window.NotAngkaBP).
 */
(function (global) {
"use strict";

/* ---------------- basic-pitch frame timing ---------------- */
const SR = 22050, HOP = 256, ANNOT_N = Math.floor(SR / HOP) * 2, AUDIO_N = SR * 2 - HOP;
const WIN_OFF = (HOP / SR) * (ANNOT_N - AUDIO_N / HOP) + 0.0018;
const frameTime = f => f * HOP / SR - WIN_OFF * Math.floor(f / ANNOT_N);
const FRAME_DT = HOP / SR - WIN_OFF / ANNOT_N;           // effective seconds per frame

/* ---------------- theory ---------------- */
const SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const FLAT = ["C","Db","D","Eb","E","F","Gb","G","Ab","A","Bb","B"];
const KEY_NAMES = ["C","Db","D","Eb","E","F","F#","G","Ab","A","Bb","B"];
const FLAT_DO = new Set([1, 3, 5, 8, 10]);
const QUAL = {"": [[0,4,7],[1,.85,.85]], m: [[0,3,7],[1,.85,.85]], "7": [[0,4,7,10],[1,.8,.8,.65]],
              maj7: [[0,4,7,11],[1,.8,.8,.65]], m7: [[0,3,7,10],[1,.8,.8,.65]]};
const DEGREE = {0:"1",1:"#1",2:"2",3:"#2",4:"3",5:"4",6:"#4",7:"5",8:"#5",9:"6",10:"b7",11:"7"};
const METERS = {"4/4":[4,false],"3/4":[3,false],"2/4":[2,false],"6/8":[2,true],"12/8":[4,true]};
const KK_MAJ = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
const KK_MIN = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
const mod = (a, n = 12) => ((a % n) + n) % n;
const pcName = (pc, doPc) => (doPc != null && FLAT_DO.has(mod(doPc)) ? FLAT : SHARP)[mod(pc)];
const keyLabel = (t, mode) => mode === "minor" ? pcName(t, mod(t + 3)) + "m" : KEY_NAMES[mod(t)];
const doOf = (t, mode) => mode === "minor" ? mod(t + 3) : mod(t);
function diatonic(d) {
  return new Set([[d,""],[d+2,"m"],[d+4,"m"],[d+5,""],[d+7,""],[d+9,"m"],[d+7,"7"],[d+2,"m7"],[d+9,"m7"],[d,"maj7"],[d+5,"maj7"]]
    .map(([r, q]) => mod(r) + ":" + q));
}
function parseKey(s) {
  s = String(s || "").trim(); if (!s) return null;
  const minor = /m$/.test(s) && !/maj$/.test(s);
  let n = minor ? s.slice(0, -1) : s; n = n[0].toUpperCase() + n.slice(1);
  let pc = SHARP.indexOf(n); if (pc < 0) pc = FLAT.indexOf(n);
  if (pc < 0) throw new Error("Nada dasar tidak dikenal: " + s);
  return [pc, minor ? "minor" : "major"];
}

/* ---------------- small math helpers ---------------- */
const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
const upperBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; };
function percentile(a, q) { if (!a.length) return 0; const s = Float64Array.from(a).sort(); const p = (s.length - 1) * q / 100, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); }
function median(a) { return percentile(a, 50); }
function interp(x, xs, ys) { if (x <= xs[0]) return ys[0]; if (x >= xs[xs.length - 1]) return ys[ys.length - 1]; const i = upperBound(xs, x) - 1; const t = (x - xs[i]) / (xs[i + 1] - xs[i]); return ys[i] + t * (ys[i + 1] - ys[i]); }
const roundHalfEven = x => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; };

/* ---------------- notes: sustain, ghosts, melody ---------------- */
function extendSustain(notes, frames, times, rel = 0.45, floor = 0.2, maxExt = 3.0) {
  const nF = frames.length; if (!nF) return notes;
  const byPitch = new Map();
  for (const n of notes) { if (!byPitch.has(n[2])) byPitch.set(n[2], []); byPitch.get(n[2]).push(n[0]); }
  return notes.map(([s, e, p, a]) => {
    const k = p - 21; if (k < 0 || k >= 88) return [s, e, p, a];
    const i0 = lowerBound(times, s), i1 = lowerBound(times, e);
    let peak = 0;
    for (let i = i0; i < Math.max(i1, i0 + 1) && i < nF; i++) peak = Math.max(peak, frames[i][k]);
    const thr = Math.max(floor, rel * peak);
    let limit = e + maxExt;
    for (const t of byPitch.get(p)) if (t > s + 0.02) limit = Math.min(limit, t - 0.01);
    let j = i1; const jmax = Math.min(nF - 1, lowerBound(times, limit));
    while (j < jmax && frames[j][k] >= thr) j++;
    return [s, Math.max(e, times[Math.min(j, nF - 1)]), p, a];
  });
}
function removeHarmonicGhosts(notes, tol = 0.05, endTol = 0.15) {
  const order = notes.map((n, i) => i).sort((a, b) => notes[a][0] - notes[b][0]);
  const starts = order.map(i => notes[i][0]);
  return notes.filter((n, i) => {
    const [s, e, p, a] = n;
    for (let q = lowerBound(starts, s - tol); q < starts.length && starts[q] <= s + tol; q++) {
      const j = order[q]; if (j === i) continue;
      const [, ej, pj, aj] = notes[j];
      const d = p - pj;
      if ((d === 12 || d === 19 || d === 24) && a < 0.75 * aj && Math.abs(e - ej) < endTol) return false;
    }
    return true;
  });
}
function intervalPen(d) { d = Math.abs(d); return d <= 2 ? 0 : d <= 5 ? 0.12 : d <= 7 ? 0.3 : d < 12 ? 0.6 : d === 12 ? 0.9 : 2.0; }

function extractMelody(notes, minPitch = 55, maxPitch = 96, minDur = 0.07, onsetTol = 0.05, minAmpRel = 0.18, window = 10) {
  if (!notes.length) return [];
  const ampRef = percentile(notes.map(n => n[3]), 90) + 1e-9;
  const cand = removeHarmonicGhosts(notes).filter(n => n[2] >= minPitch && n[2] <= maxPitch && (n[1] - n[0]) >= minDur && n[3] >= minAmpRel * ampRef);
  if (!cand.length) return [];
  cand.sort((a, b) => a[0] - b[0] || b[2] - a[2]);
  const clusters = [];
  for (const n of cand) { if (clusters.length && n[0] - clusters[clusters.length - 1][0][0] <= onsetTol) clusters[clusters.length - 1].push(n); else clusters.push([n]); }
  const opts = clusters.map(c => c.slice().sort((a, b) => b[2] - a[2]).slice(0, 3));
  const tops = opts.map(o => o[0][2]), t0 = clusters.map(c => c[0][0]);
  const K = opts.length, NEG = -1e18, REST = 0.4;
  const reward = (k, j) => { const n = opts[k][j]; return 1.0 + (j === 0 ? 0.5 : -0.4 * j) + 0.3 * Math.min(1, n[3] / ampRef) + 0.2 * Math.min(1, (n[1] - n[0]) / 0.6); };
  const skipCost = (prev, m) => (prev[1] > t0[m] + 0.05) ? (tops[m] <= prev[2] ? 0.05 : 0.7) : (tops[m] < prev[2] - 2 ? 0.35 : 0.75);
  const interruptPen = (prev, n) => { if (prev[1] <= n[0] + 0.05) return 0; const drop = prev[2] - n[2]; return drop <= 2 ? 0.1 : 0.3 + 0.12 * drop; };
  const best = opts.map(o => o.map(() => NEG)), back = opts.map(o => o.map(() => null));
  const gbest = new Array(K).fill(NEG), garg = new Array(K).fill(null);
  let runMax = NEG, runArg = null;
  for (let k = 0; k < K; k++) {
    const kf = k - window - 1;
    if (kf >= 0 && gbest[kf] > NEG && gbest[kf] + REST * kf > runMax) { runMax = gbest[kf] + REST * kf; runArg = [kf, garg[kf]]; }
    for (let j = 0; j < opts[k].length; j++) {
      const n = opts[k][j], r = reward(k, j);
      let val = r - 0.5 * Math.min(k, 3), bp = null;
      if (runArg) { const v = runMax - REST * (k - 1) + r; if (v > val) { val = v; bp = runArg; } }
      for (let k2 = Math.max(0, k - window); k2 < k; k2++) {
        for (let j2 = 0; j2 < opts[k2].length; j2++) {
          const b = best[k2][j2]; if (b <= NEG) continue;
          const n2 = opts[k2][j2];
          let sc = b + r - intervalPen(n[2] - n2[2]) - interruptPen(n2, n);
          for (let m = k2 + 1; m < k; m++) sc -= skipCost(n2, m);
          if (sc > val) { val = sc; bp = [k2, j2]; }
        }
      }
      best[k][j] = val; back[k][j] = bp;
      if (val > gbest[k]) { gbest[k] = val; garg[k] = j; }
    }
  }
  let k = 0; for (let i = 1; i < K; i++) if (gbest[i] > gbest[k]) k = i;
  let j = garg[k]; const path = [];
  while (k != null && j != null) { path.push(opts[k][j]); const bp = back[k][j]; if (!bp) break; [k, j] = bp; }
  path.reverse();
  let mel = path.map(n => n.slice());
  for (let i = 0; i < mel.length - 1; i++) mel[i][1] = Math.min(mel[i][1], mel[i + 1][0]);
  // merge same-pitch re-onsets caused by octave-below attacks
  const onsSorted = notes.map(n => [n[0], n[2]]).sort((a, b) => a[0] - b[0]);
  const onsT = onsSorted.map(x => x[0]);
  const merged = [];
  for (const n of mel) {
    const L = merged[merged.length - 1];
    if (L && n[2] === L[2] && L[1] >= n[0] - 0.06) {
      let octave = false;
      for (let q = lowerBound(onsT, n[0] - 0.05); q < onsT.length && onsT[q] <= n[0] + 0.05; q++) { const d = n[2] - onsSorted[q][1]; if (d === 12 || d === 24) octave = true; }
      const ratio = n[3] / (L[3] + 1e-9);
      if ((octave && ratio < 0.65) || ratio < 0.45) { L[1] = Math.max(L[1], n[1]); continue; }
    }
    merged.push(n);
  }
  const out = [];
  for (const n of merged) {
    const L = out[out.length - 1];
    if (L && n[2] === L[2] && n[0] - L[1] < 0.03 && (L[1] - L[0]) < 0.09) { L[1] = n[1]; continue; }
    if (n[1] - n[0] >= 0.05) out.push(n);
  }
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1][2], b = out[i][2], c = out[i + 1][2];
    if (Math.abs(b - a) >= 12 && Math.abs(b - c) >= 12 && Math.abs(a - c) <= 5) out[i][2] = b - 12 * Math.round((b - (a + c) / 2) / 12);
  }
  return out;
}
function accompanimentNotes(notes, melody) {
  const keys = new Set(melody.map(m => m[0].toFixed(2) + ":" + m[2]));
  return notes.filter(n => !keys.has(n[0].toFixed(2) + ":" + n[2]));
}

/* ---------------- beat tracking (Ellis DP, like librosa) ---------------- */
function estimateTempo(env, fps, startBpm = 120) {
  const n = env.length, mean = env.reduce((s, x) => s + x, 0) / n;
  const x = env.map(v => v - mean);
  const minLag = Math.floor(fps * 60 / 320), maxLag = Math.min(n - 1, Math.ceil(fps * 60 / 30));
  let best = -Infinity, bestLag = Math.round(fps * 60 / startBpm);
  const ac = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) { let s = 0; for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag]; ac[lag] = s / (n - lag); }
  for (let lag = Math.max(minLag, 1); lag <= maxLag; lag++) {
    const bpm = 60 * fps / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm) - Math.log2(startBpm), 2));
    const v = ac[lag] * prior;
    if (v > best) { best = v; bestLag = lag; }
  }
  // parabolic refinement
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) { const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1]; const den = a - 2 * b + c; if (den !== 0) lag = bestLag + 0.5 * (a - c) / den; }
  return 60 * fps / lag;
}
function trackBeats(env, fps, bpm, tightness = 120) {
  const n = env.length; if (n < 4) return [];
  let mean = 0; for (const v of env) mean += v; mean /= n;
  let sd = 0; for (const v of env) sd += (v - mean) ** 2; sd = Math.sqrt(sd / Math.max(1, n - 1)) || 1;
  const on = env.map(v => v / sd);
  const period = fps * 60 / bpm;
  const P = Math.round(period);
  const W = []; for (let i = -P; i <= P; i++) W.push(Math.exp(-0.5 * Math.pow(i * 32 / period, 2)));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = -P; k <= P; k++) { const j = i + k; if (j >= 0 && j < n) s += on[j] * W[k + P]; } local[i] = s; }
  const wStart = -2 * P, wEnd = -Math.round(period / 2);
  const txwt = []; for (let w = wStart; w <= wEnd; w++) txwt.push(-tightness * Math.pow(Math.log(-w / period), 2));
  const cum = new Float64Array(n), backl = new Int32Array(n).fill(-1);
  const maxLocal = Math.max(...local);
  let first = true;
  for (let i = 0; i < n; i++) {
    let bestV = -Infinity, bestJ = -1;
    for (let w = wStart, q = 0; w <= wEnd; w++, q++) { const j = i + w; if (j < 0) continue; const v = cum[j] + txwt[q]; if (v > bestV) { bestV = v; bestJ = j; } }
    cum[i] = local[i] + (bestJ >= 0 ? bestV : 0);
    if (first && local[i] < 0.01 * maxLocal) backl[i] = -1; else { backl[i] = bestJ; first = false; }
  }
  // last beat: last local max of cum above half the median of local maxima
  const maxima = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(i);
  if (!maxima.length) return [];
  const med = median(maxima.map(i => cum[i]));
  let last = maxima[maxima.length - 1];
  for (let q = maxima.length - 1; q >= 0; q--) if (cum[maxima[q]] >= 0.5 * med) { last = maxima[q]; break; }
  const beats = []; let b = last;
  while (b >= 0) { beats.push(b); b = backl[b]; }
  beats.reverse();
  // trim weak leading/trailing beats
  const rms = Math.sqrt(beats.reduce((s, i) => s + local[i] * local[i], 0) / beats.length);
  let a = 0, z = beats.length;
  while (a < z && local[beats[a]] < 0.5 * rms) a++;
  while (z > a && local[beats[z - 1]] < 0.5 * rms) z--;
  return beats.slice(a, z);
}
function beatGrid(raw, duration, envT, env, factor = 1) {
  let b = raw.slice();
  if (b.length < 4) { b = []; for (let t = 0; t < duration; t += 60 / 90) b.push(t); }
  if (factor >= 1.5) {
    const k = Math.round(factor), nb = [];
    for (let i = 0; i < b.length - 1; i++) for (let j = 0; j < k; j++) nb.push(b[i] + (b[i + 1] - b[i]) * j / k);
    nb.push(b[b.length - 1]); b = nb;
  } else if (factor <= 0.75) {
    const k = Math.round(1 / factor);
    const str = b.map(t => interp(t, envT, env));
    let bestP = 0, bestS = -Infinity;
    for (let p = 0; p < k; p++) { let s = 0, c = 0; for (let i = p; i < b.length; i += k) { s += str[i]; c++; } if (c && s / c > bestS) { bestS = s / c; bestP = p; } }
    b = b.filter((_, i) => i >= bestP && (i - bestP) % k === 0);
  }
  const d = []; for (let i = 1; i < b.length; i++) d.push(b[i] - b[i - 1]);
  const ibi = median(d);
  const pre = []; let t = b[0] - ibi; while (t > -0.5 * ibi) { pre.push(t); t -= ibi; }
  const post = []; t = b[b.length - 1] + ibi; while (t < duration + ibi) { post.push(t); t += ibi; }
  return { grid: pre.reverse().concat(b, post), bpm: 60 / ibi };
}

/* ---------------- per-beat features ---------------- */
function beatSync(frameFeat, dim, times, grid, agg) {
  // frameFeat: Float32Array (nFrames*dim). Returns array of Float64Array(dim) per beat interval.
  const nB = grid.length - 1, out = [];
  for (let i = 0; i < nB; i++) {
    const a = lowerBound(times, grid[i]); let b = lowerBound(times, grid[i + 1]); if (b <= a) b = a + 1;
    const v = new Float64Array(dim);
    const nF = times.length;
    if (a >= nF) { out.push(v); continue; }
    const bb = Math.min(b, nF);
    if (agg === "median") {
      for (let d = 0; d < dim; d++) { const tmp = []; for (let f = a; f < bb; f++) tmp.push(frameFeat[f * dim + d]); v[d] = median(tmp); }
    } else if (agg === "max") {
      for (let d = 0; d < dim; d++) { let m = 0; for (let f = a; f < bb; f++) m = Math.max(m, frameFeat[f * dim + d]); v[d] = m; }
    } else {
      for (let d = 0; d < dim; d++) { let s = 0; for (let f = a; f < bb; f++) s += frameFeat[f * dim + d]; v[d] = s / Math.max(1, bb - a); }
    }
    out.push(v);
  }
  return out;
}
function noteChromaPerBeat(notes, grid) {
  const nB = grid.length - 1, out = Array.from({ length: nB }, () => new Float64Array(12));
  for (const [s, e, p, a] of notes) {
    const i0 = Math.max(0, upperBound(grid, s) - 1), i1 = Math.min(nB - 1, upperBound(grid, e) - 1);
    for (let i = i0; i <= i1; i++) { const ov = Math.min(e, grid[i + 1]) - Math.max(s, grid[i]); if (ov > 0) out[i][mod(p)] += ov * a * (p < 55 ? 1.6 : 1.0); }
  }
  return out;
}

/* ---------------- key ---------------- */
function corr(a, b) { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let num = 0, da = 0, db = 0; for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return num / Math.sqrt(da * db + 1e-12); }
function detectKey(chromaB, melody, weights) {
  const prof = new Float64Array(12);
  chromaB.forEach((c, i) => { const w = weights ? weights[i] : 1; for (let k = 0; k < 12; k++) prof[k] += c[k] * w; });
  let s = prof.reduce((x, y) => x + y, 0) + 1e-9; for (let k = 0; k < 12; k++) prof[k] /= s;
  if (melody && melody.length) { const h = new Float64Array(12); melody.forEach(([a, b, p]) => h[mod(p)] += b - a); const hs = h.reduce((x, y) => x + y, 0) + 1e-9; for (let k = 0; k < 12; k++) prof[k] += 0.6 * h[k] / hs; }
  let best = -2, res = [0, "major"];
  for (let t = 0; t < 12; t++) for (const [mode, P] of [["major", KK_MAJ], ["minor", KK_MIN]]) {
    const rot = P.map((_, i) => P[mod(i - t)]);
    const r = corr(Array.from(prof), rot); if (r > best) { best = r; res = [t, mode]; }
  }
  return res;
}
function refineMode(tonic, mode, labels) {
  const d = mode === "minor" ? mod(tonic + 3) : tonic, rm = mod(d + 9);
  const seq = labels.filter(Boolean); if (!seq.length) return [tonic, mode];
  const dI = seq.filter(([r, q]) => r === d && (q === "" || q === "maj7")).length;
  const dvi = seq.filter(([r, q]) => r === rm && (q === "m" || q === "m7")).length;
  const last = seq[seq.length - 1], first = seq[0];
  let sc = (dvi - dI) / Math.max(1, seq.length) * 4;
  sc += (last[0] === rm && last[1] === "m") ? 1 : (last[0] === d && last[1] === "") ? -1 : 0;
  sc += (first[0] === rm && first[1] === "m") ? 0.5 : (first[0] === d && first[1] === "") ? -0.5 : 0;
  return sc > 0.6 ? [rm, "minor"] : [d, "major"];
}

/* ---------------- chords ---------------- */
function templates(quals) {
  const names = [], T = [];
  for (let r = 0; r < 12; r++) for (const q of quals) {
    const [iv, w] = QUAL[q]; const t = new Float64Array(12);
    iv.forEach((x, i) => t[mod(r + x)] = w[i]);
    const nrm = Math.hypot(...t); names.push([r, q]); T.push(t.map(v => v / nrm));
  }
  return [names, T];
}
const norm12 = v => { const n = Math.hypot(...v) + 1e-9; return v.map(x => x / n); };
function recognizeChords(chromaB, bassB, energyB, doPc, vocab, noteChromaB, pStay = 0.88) {
  const quals = vocab === "simple" ? ["", "m"] : ["", "m", "7", "maj7", "m7"];
  const [names, T] = templates(quals);
  const nB = chromaB.length, nC = names.length;
  const X = chromaB.map((c, i) => {
    let x = norm12(c);
    if (noteChromaB && noteChromaB[i].some(v => v > 0)) { const y = norm12(noteChromaB[i]); x = norm12(x.map((v, k) => 0.5 * v + 0.5 * y[k])); }
    return x;
  });
  const S = names.map(() => new Float64Array(nB));
  const dia = doPc != null ? diatonic(doPc) : null;
  for (let i = 0; i < nB; i++) {
    const bmax = Math.max(...bassB[i]) + 1e-9;
    for (let k = 0; k < nC; k++) {
      let s = 0; for (let d = 0; d < 12; d++) s += T[k][d] * X[i][d];
      const [r, q] = names[k];
      if (q.length > 1 && q !== "m") s -= 0.035;
      const B = bassB[i][r] / bmax; s += 0.10 * B - 0.03 * (1 - B);
      if (dia && dia.has(r + ":" + q)) s += 0.04;
      S[k][i] = s;
    }
  }
  const pos = energyB.filter(v => v > 0); const med = pos.length ? median(pos) : 1;
  const silent = energyB.map(v => v / (med + 1e-9) < 0.12);
  const nS = nC + 1, beta = 22, la = Math.log((1 - pStay) / (nS - 1)), ls = Math.log(pStay);
  const E = (st, i) => st === nC ? 0.55 * beta - (silent[i] ? 0 : 6) : S[st][i] * beta - (silent[i] ? 40 : 0);
  let D = new Float64Array(nS); for (let s = 0; s < nS; s++) D[s] = E(s, 0);
  const Pm = [new Int32Array(nS)];
  for (let i = 1; i < nB; i++) {
    let bestPrev = 0; for (let s = 1; s < nS; s++) if (D[s] > D[bestPrev]) bestPrev = s;
    const nd = new Float64Array(nS), pm = new Int32Array(nS);
    for (let s = 0; s < nS; s++) {
      const stay = D[s] + ls, sw = D[bestPrev] + la;
      if (stay >= sw || bestPrev === s) { nd[s] = stay; pm[s] = s; } else { nd[s] = sw; pm[s] = bestPrev; }
      nd[s] += E(s, i);
    }
    D = nd; Pm.push(pm);
  }
  const path = new Int32Array(nB); let b = 0; for (let s = 1; s < nS; s++) if (D[s] > D[b]) b = s;
  path[nB - 1] = b; for (let i = nB - 1; i > 0; i--) path[i - 1] = Pm[i][path[i]];
  const labels = Array.from(path, k => k === nC ? null : names[k]);
  return { labels, S, names };
}
const sameLab = (a, b) => (a === b) || (a && b && a[0] === b[0] && a[1] === b[1]);
function simplifyChords(labels, S, names, mode, phase, N) {
  labels = labels.slice(); const n = labels.length;
  const idx = l => names.findIndex(x => x[0] === l[0] && x[1] === l[1]);
  if (mode === "half" || mode === "bar") {
    let seg = mode === "bar" ? N : Math.max(1, Math.floor(N / 2)); if (N === 3 && mode === "half") seg = 3;
    const start = mod(phase, seg) ? mod(phase, seg) - seg : 0;
    for (let a = start; a < n; a += seg) {
      const lo = Math.max(0, a), hi = Math.min(n, a + seg); if (hi <= lo) continue;
      const cand = labels.slice(lo, hi).filter(Boolean); if (!cand.length) continue;
      let bestL = null, bestS = -Infinity;
      for (const l of cand) { const k = idx(l); let s = 0; for (let i = lo; i < hi; i++) s += S[k][i]; s += 0.05 * cand.filter(x => sameLab(x, l)).length; if (s > bestS) { bestS = s; bestL = l; } }
      for (let i = lo; i < hi; i++) if (labels[i]) labels[i] = bestL;
    }
    return labels;
  }
  if (mode === "auto") {
    let changed = true;
    while (changed) {
      changed = false; const segs = [];
      for (let i = 0; i < n;) { let j = i; while (j + 1 < n && sameLab(labels[j + 1], labels[i])) j++; segs.push([i, j]); i = j + 1; }
      for (let si = 0; si < segs.length; si++) {
        const [a, b] = segs[si]; if (!labels[a] || b - a + 1 >= 2) continue;
        const prev = si > 0 ? labels[segs[si - 1][0]] : null, nxt = si + 1 < segs.length ? labels[segs[si + 1][0]] : null;
        const options = [prev, nxt].filter(Boolean); if (!options.length) continue;
        let bestO = options[0], bestS = -Infinity;
        for (const o of options) { const k = idx(o); let s = 0; for (let i = a; i <= b; i++) s += S[k][i]; if (s > bestS) { bestS = s; bestO = o; } }
        for (let k = a; k <= b; k++) labels[k] = bestO;
        changed = true; break;
      }
    }
  }
  return labels;
}
function downbeatPhase(labels, lowB, onB, N) {
  const n = labels.length;
  const change = labels.map((l, i) => (i > 0 && l && !sameLab(l, labels[i - 1])) ? 1 : 0);
  const p95 = percentile(lowB, 95) + 1e-9, o95 = percentile(onB, 95) + 1e-9;
  let bestP = 0, bestS = -Infinity;
  for (let p = 0; p < N; p++) {
    let c = 0, lo = 0, on = 0, m = 0;
    for (let i = p; i < n; i += N) { c += change[i]; lo += Math.min(1.5, lowB[i] / p95); on += onB[i] / o95; m++; }
    if (!m) continue;
    const sc = c / m * 2 + lo / m * 0.8 + 0.3 * on / m;
    if (sc > bestS) { bestS = sc; bestP = p; }
  }
  return bestP;
}

/* ---------------- notation (quantise → text) ---------------- */
function posOf(t, grid) {
  if (t < grid[0]) return (t - grid[0]) / (grid[1] - grid[0]);
  if (t > grid[grid.length - 1]) return grid.length - 1 + (t - grid[grid.length - 1]) / (grid[grid.length - 1] - grid[grid.length - 2]);
  const i = Math.min(grid.length - 2, upperBound(grid, t) - 1);
  return i + (t - grid[i]) / (grid[i + 1] - grid[i]);
}
function chooseBase(melody, doPc) {
  if (!melody.length) return 60 + doPc;
  let best = -1, bb = 60 + doPc;
  for (let base = 36 + doPc; base < 84; base += 12) {
    let sc = 0;
    for (const [s, e, p] of melody) { const inside = (p >= base && p < base + 12) ? 1 : 0; const near = (p >= base - 5 && p < base + 13) ? 0.25 : 0; sc += (inside + near) * (0.5 + (e - s)); }
    if (sc > best) { best = sc; bb = base; }
  }
  return bb;
}
function quantise(melody, grid, R, compound, quant, fillGap) {
  if (!melody.length) return [];
  const on = melody.map(m => posOf(m[0], grid)), off = melody.map(m => posOf(m[1], grid));
  const Gopts = compound ? [3] : quant === "2" ? [2] : quant === "4" ? [4] : [2, 4];
  const gmax = Math.max(...Gopts), choice = new Map(), byBeat = new Map();
  on.forEach((o, i) => { const b = Math.floor(roundHalfEven(o * gmax) / gmax); if (!byBeat.has(b)) byBeat.set(b, []); byBeat.get(b).push(i); });
  const slotOn = new Array(melody.length).fill(0);
  for (const [b, idxs] of byBeat) {
    let G = Gopts[0];
    if (Gopts.length > 1) {
      const q2 = idxs.map(i => roundHalfEven(on[i] * 2));
      const e2 = idxs.reduce((s, i, q) => s + Math.abs(on[i] * 2 - q2[q]), 0) / 2;
      const e4 = idxs.reduce((s, i) => s + Math.abs(on[i] * 4 - roundHalfEven(on[i] * 4)), 0) / 4;
      const collide = new Set(q2).size < idxs.length;
      if (collide || (e2 - e4) > 0.075 * idxs.length) G = 4;
    }
    choice.set(b, G);
    for (const i of idxs) slotOn[i] = Math.round(roundHalfEven(on[i] * G) / G * R);
  }
  const order = melody.map((_, i) => i).sort((a, b) => slotOn[a] - slotOn[b] || (off[b] - on[b]) - (off[a] - on[a]));
  const kept = []; let last = null;
  for (const i of order) { if (last !== null && slotOn[i] === last) continue; kept.push(i); last = slotOn[i]; }
  const fill = Math.round(fillGap * R), ev = [];
  kept.forEach((i, k) => {
    const s = slotOn[i], G = choice.get(Math.floor(off[i])) || Gopts[0], step = R / G;
    let e = Math.round(off[i] * R / step) * step; e = Math.max(e, s + 1);
    if (k + 1 < kept.length) { const nx = slotOn[kept[k + 1]]; e = Math.min(e, nx); if (nx - e <= fill) e = nx; }
    ev.push([s, e, i]);
  });
  return ev;
}
function beatAtoms(syms, R, compound) {
  const divs = (compound ? [1, 3] : [1, 2, 4]).filter(d => R % d === 0);
  let g = divs[divs.length - 1];
  for (const d of divs) {
    const size = R / d; let ok = true;
    for (let k = 0; k < d && ok; k++) { const grp = syms.slice(k * size, (k + 1) * size); const head = grp[0]; const want = head === "R" ? "R" : "H"; if (grp.slice(1).some(x => x !== want)) ok = false; }
    if (ok) { g = d; break; }
  }
  const heads = []; for (let k = 0; k < g; k++) heads.push(syms[k * (R / g)]);
  if (g === 4) {
    const items = [];
    for (const k of [0, 2]) { const a = heads[k], b = heads[k + 1]; if ((b === "H" && a !== "R") || (a === "R" && b === "R")) items.push([a]); else items.push([a, b]); }
    return items;
  }
  return heads.map(h => [h]);
}
function buildText(melody, grid, labels, phase, meter, doPc, tonic, mode, bpm, o = {}) {
  const [N, compound] = METERS[meter] || [4, false], R = compound ? 3 : 4;
  const ev = quantise(melody, grid, R, compound, o.quant || "auto", o.fillGap ?? 0.5);
  const base = chooseBase(melody, doPc);
  const head = [`title: ${o.title || "Tanpa judul"}`]; if (o.artist) head.push(`artist: ${o.artist}`);
  head.push(`key: ${keyLabel(tonic, mode)}`, `meter: ${meter}`, `tempo: ${Math.round(bpm)}`, "");
  if (!ev.length) return { text: head.concat(["0 0 0 0 |"]).join("\n"), bars: 0, pickup: false };
  const firstOn = ev[0][0], lastOff = ev[ev.length - 1][1];
  const beat0 = Math.floor(firstOn / R);
  const barStart = phase + Math.floor((beat0 - phase) / N) * N;
  const pickup = (beat0 - barStart) >= Math.max(1, Math.floor(N / 2)) && N > 2;
  const startBeat = pickup ? beat0 : barStart;
  const lastOnBeat = Math.floor(ev[ev.length - 1][0] / R);
  let endBeat = phase + (Math.floor((lastOnBeat - phase) / N) + 1) * N;   // end of the bar holding the last onset
  if (lastOff > (endBeat + N / 2) * R) endBeat = phase + Math.ceil((Math.ceil(lastOff / R) - phase) / N) * N;
  ev[ev.length - 1][1] = Math.max(ev[ev.length - 1][1], endBeat * R);
  const total = (endBeat - startBeat) * R, off0 = startBeat * R;
  const slots = new Array(total).fill("R");
  for (const [s, e, i] of ev) { const a = s - off0, b = Math.min(e - off0, total); if (a < 0 || a >= total) continue; slots[a] = "N:" + i; for (let k = a + 1; k < b; k++) slots[k] = "H"; }
  const chordAt = b => (b >= 0 && b < labels.length) ? labels[b] : null;
  const bars = []; let b = startBeat, nx = pickup ? barStart + N : startBeat + N;
  while (b < endBeat) { bars.push([b, nx]); b = nx; nx += N; }
  const noteSym = i => { const rel = melody[i][2] - base; const oct = Math.floor(rel / 12), semi = mod(rel); return DEGREE[semi] + (oct > 0 ? "'".repeat(oct) : ",".repeat(-oct)); };
  const syl = o.syllables || null;
  let prev = null, barInLine = 0, cur = [], curSyl = [], emptyRun = 0; const lines = [];
  bars.forEach(([b0, b1], bi) => {
    const toks = [], sy = []; let allRest = true;
    for (let beat = b0; beat < b1; beat++) {
      const items = beatAtoms(slots.slice((beat - startBeat) * R, (beat - startBeat + 1) * R), R, compound);
      const pieces = items.map(grp => {
        const strs = grp.map(h => { if (h.startsWith("N:")) { const idx = +h.slice(2); sy.push((syl && syl[idx]) || "_"); allRest = false; return noteSym(idx); } if (h === "H") { allRest = false; return "."; } return "0"; });
        return strs.length === 1 ? strs[0] : "(" + strs.join("") + ")";
      });
      let tok = pieces.join("");
      const ch = chordAt(beat), lineStart = barInLine === 0 && beat === b0;
      if (ch && (!sameLab(ch, prev) || lineStart)) tok = `[${pcName(ch[0], doPc)}${ch[1]}]` + tok;
      prev = ch; toks.push(tok);
    }
    let silent = allRest; for (let x = b0; x < b1 && silent; x++) if (chordAt(x)) silent = false;
    if (silent) { emptyRun++; if (emptyRun >= 2) return; } else emptyRun = 0;
    cur.push(toks.join(" ")); curSyl.push(...sy);
    if (!(pickup && bi === 0)) barInLine++;
    if (barInLine >= (o.barsPerLine || 4)) { lines.push([cur, curSyl]); cur = []; curSyl = []; barInLine = 0; }
  });
  if (cur.length) lines.push([cur, curSyl]);
  const body = [];
  lines.forEach(([bl, sl], k) => { body.push(bl.join(" | ") + (k === lines.length - 1 ? " ||" : " |")); if (syl && sl.some(x => x !== "_")) body.push("L: " + sl.join(" ")); });
  return { text: head.concat(body).join("\n"), bars: bars.length, pickup, base };
}

/* ---------------- audio helpers ---------------- */
async function decodeTo22k(arrayBuffer) {
  const AC = global.AudioContext || global.webkitAudioContext;
  const ac = new AC();
  const dec = await new Promise((res, rej) => { const p = ac.decodeAudioData(arrayBuffer.slice(0), res, rej); if (p && p.then) p.then(res, rej); });
  try { ac.close(); } catch (e) {}
  const len = Math.ceil(dec.duration * SR);
  const OAC = global.OfflineAudioContext || global.webkitOfflineAudioContext;
  const off = new OAC(1, len, SR);
  const src = off.createBufferSource(); src.buffer = dec; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

/* ---------------- main API ---------------- */
let modelPromise = null;
function getModel(url) {
  if (!global.NotAngkaBP) throw new Error("Model AI belum dimuat");
  if (!modelPromise) modelPromise = Promise.resolve(new global.NotAngkaBP.BasicPitch(url));
  return modelPromise;
}
const DEFAULTS = { meter: "4/4", tempo_factor: 1, phase_shift: 0, key_override: "", chord_vocab: "simple", chord_rate: "auto",
  quant: "auto", fill_gap: 0.5, bars_per_line: 4, melody_min_pitch: null, sustain: true };

async function analyze(pcm, opts = {}, progress = () => {}) {
  const BP = global.NotAngkaBP;
  const bp = await getModel(opts.modelUrl || "model/model.json");
  const duration = pcm.length / SR;
  progress(0.02, "Transkripsi not (AI)…");
  const frames = [], onsets = [], contours = [];
  await bp.evaluateModel(pcm, (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); }, p => progress(0.02 + 0.78 * p, "Transkripsi not (AI)…"));
  progress(0.82, "Analisis ketukan & chord…");
  await new Promise(r => setTimeout(r, 0));
  const evs = BP.noteFramesToTime(BP.addPitchBendsToNoteEvents(contours, BP.outputToNotesPoly(frames, onsets, 0.5, 0.3, 6)));
  const notesRaw = evs.map(n => [n.startTimeSeconds, n.startTimeSeconds + n.durationSeconds, n.pitchMidi, n.amplitude]).sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const nF = frames.length, times = new Float64Array(nF);
  for (let f = 0; f < nF; f++) times[f] = frameTime(f);
  const notes = extendSustain(notesRaw, frames, times);
  // frame-level features
  const env = new Float64Array(nF), low = new Float32Array(nF), chroma = new Float32Array(nF * 12), bass = new Float32Array(nF * 12), energy = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const fr = frames[f], on = onsets[f], pr = f ? frames[f - 1] : null;
    let s = 0, flux = 0, lo = 0, en = 0;
    for (let k = 0; k < 88; k++) {
      s += on[k]; if (pr) flux += Math.max(0, fr[k] - pr[k]); en += fr[k];
      const midi = k + 21;
      if (midi < 55) lo += on[k];
      if (midi >= 36 && midi < 96) chroma[f * 12 + (midi % 12)] += fr[k];
      if (midi >= 28 && midi < 55) bass[f * 12 + (midi % 12)] += fr[k];
    }
    env[f] = s + 0.5 * flux; low[f] = lo; energy[f] = en;
  }
  const fps = 1 / FRAME_DT;
  const bpm0 = opts.bpm_hint ? +opts.bpm_hint : estimateTempo(Array.from(env), fps, 120);
  const beatFrames = trackBeats(Array.from(env), fps, bpm0, 120);
  const rawBeats = beatFrames.map(f => times[f]);
  frames.length = 0; onsets.length = 0; contours.length = 0;
  const cache = { notes, notesRaw, times: Array.from(times), env: Array.from(env), low, chroma, bass, energy, rawBeats, duration,
    title: opts.title || "", artist: opts.artist || "", source: opts.source || "" };
  progress(0.95, "Menyusun not angka…");
  const res = notate(cache, { meter: opts.meter || "4/4", ...(opts.params || {}) });
  progress(1, "Selesai");
  return { ...res, cache };
}

function notate(cache, params = {}) {
  const P = { ...DEFAULTS, ...params };
  const notes = P.sustain ? cache.notes : cache.notesRaw;
  const melody = extractMelody(notes, +(P.melody_min_pitch || 55));
  const [N] = METERS[P.meter] || [4, false];
  const { grid, bpm } = beatGrid(cache.rawBeats, cache.duration, cache.times, cache.env, +P.tempo_factor || 1);
  const t = cache.times;
  const chromaB = beatSync(cache.chroma, 12, t, grid, "median");
  const bassB = beatSync(cache.bass, 12, t, grid, "median");
  const energyB = beatSync(cache.energy, 1, t, grid, "mean").map(v => v[0]);
  const lowB = beatSync(Float32Array.from(cache.low), 1, t, grid, "max").map(v => v[0]);
  const onB = beatSync(Float32Array.from(cache.env), 1, t, grid, "max").map(v => v[0]);
  const noteChroma = noteChromaPerBeat(accompanimentNotes(notes, melody), grid);
  let tonic, kmode;
  const ko = parseKey(P.key_override);
  if (ko) [tonic, kmode] = ko; else [tonic, kmode] = detectKey(chromaB, melody, energyB);
  let doPc = doOf(tonic, kmode);
  let { labels, S, names } = recognizeChords(chromaB, bassB, energyB, doPc, P.chord_vocab, noteChroma);
  if (!ko) { [tonic, kmode] = refineMode(tonic, kmode, labels); doPc = doOf(tonic, kmode); }
  let phase = downbeatPhase(labels, lowB, onB, N);
  phase = mod(phase + (+P.phase_shift || 0), N);
  labels = simplifyChords(labels, S, names, P.chord_rate, phase, N);
  const r = buildText(melody, grid, labels, phase, P.meter, doPc, tonic, kmode, bpm,
    { quant: P.quant, fillGap: +P.fill_gap, barsPerLine: +P.bars_per_line, title: cache.title, artist: cache.artist });
  const meta = { title: cache.title, artist: cache.artist, mode: "browser", key: keyLabel(tonic, kmode), do: KEY_NAMES[doPc],
    bpm: Math.round(bpm * 10) / 10, phase, n_melody_notes: melody.length, has_words: false, params: P, bars: r.bars, pickup: r.pickup };
  return { text: r.text, meta };
}

global.NotAngkaEngine = { analyze, notate, decodeTo22k, SR, DEFAULTS,
  _t: { extractMelody, estimateTempo, trackBeats, detectKey, recognizeChords, buildText, frameTime } };
})(typeof window !== "undefined" ? window : globalThis);
