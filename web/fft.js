// Mixed-radix complex FFT (radix 4/2/3/5, kissfft-style recursion), forward = e^{-2πi kn/N}.
export function makeFFT(n) {
  const factors = [], mlist = [];
  let m = n, p = 4;
  while (m > 1) {
    while (m % p) { p = p === 4 ? 2 : p === 2 ? 3 : p + 2; if (p * p > m) p = m; }
    m /= p; factors.push(p); mlist.push(m);
  }
  const twr = new Float64Array(n), twi = new Float64Array(n);
  for (let k = 0; k < n; k++) { const a = -2 * Math.PI * k / n; twr[k] = Math.cos(a); twi[k] = Math.sin(a); }
  const sr = new Float64Array(8), si = new Float64Array(8);
  let OR, OI, IR, II;
  function bfly2(o, fs, m) {
    for (let k = 0; k < m; k++) {
      const a = o + k, b = a + m, t = k * fs;
      const tr = OR[b] * twr[t] - OI[b] * twi[t], ti = OR[b] * twi[t] + OI[b] * twr[t];
      OR[b] = OR[a] - tr; OI[b] = OI[a] - ti; OR[a] += tr; OI[a] += ti;
    }
  }
  function bfly4(o, fs, m) {
    const m2 = 2 * m, m3 = 3 * m;
    for (let k = 0; k < m; k++) {
      const a = o + k, t1 = k * fs, t2 = 2 * k * fs, t3 = 3 * k * fs;
      const s0r = OR[a + m] * twr[t1] - OI[a + m] * twi[t1], s0i = OR[a + m] * twi[t1] + OI[a + m] * twr[t1];
      const s1r = OR[a + m2] * twr[t2] - OI[a + m2] * twi[t2], s1i = OR[a + m2] * twi[t2] + OI[a + m2] * twr[t2];
      const s2r = OR[a + m3] * twr[t3] - OI[a + m3] * twi[t3], s2i = OR[a + m3] * twi[t3] + OI[a + m3] * twr[t3];
      const s5r = OR[a] - s1r, s5i = OI[a] - s1i;
      const f0r = OR[a] + s1r, f0i = OI[a] + s1i;
      const s3r = s0r + s2r, s3i = s0i + s2i, s4r = s0r - s2r, s4i = s0i - s2i;
      OR[a + m2] = f0r - s3r; OI[a + m2] = f0i - s3i;
      OR[a] = f0r + s3r; OI[a] = f0i + s3i;
      OR[a + m] = s5r + s4i; OI[a + m] = s5i - s4r;
      OR[a + m3] = s5r - s4i; OI[a + m3] = s5i + s4r;
    }
  }
  function bflyG(o, fs, m, p) {
    for (let u = 0; u < m; u++) {
      for (let q = 0, k = o + u; q < p; q++, k += m) { sr[q] = OR[k]; si[q] = OI[k]; }
      for (let q1 = 0, k = u; q1 < p; q1++, k += m) {
        let ar = sr[0], ai = si[0], tw = 0;
        for (let q = 1; q < p; q++) {
          tw += fs * k; if (tw >= n) tw %= n;
          ar += sr[q] * twr[tw] - si[q] * twi[tw]; ai += sr[q] * twi[tw] + si[q] * twr[tw];
        }
        OR[o + k] = ar; OI[o + k] = ai;
      }
    }
  }
  function work(o, i, fs, f) {
    const p = factors[f], m = mlist[f];
    if (m === 1) { for (let k = 0; k < p; k++) { OR[o + k] = IR[i + k * fs]; OI[o + k] = II[i + k * fs]; } }
    else for (let k = 0; k < p; k++) work(o + k * m, i + k * fs, fs * p, f + 1);
    if (p === 4) bfly4(o, fs, m); else if (p === 2) bfly2(o, fs, m); else bflyG(o, fs, m, p);
  }
  // out-of-place: (inR, inI) -> (outR, outI)
  function forward(inR, inI, outR, outI) { IR = inR; II = inI; OR = outR; OI = outI; work(0, 0, 1, 0); }
  function inverse(inR, inI, outR, outI) {   // conj trick, scaled 1/n
    for (let k = 0; k < n; k++) inI[k] = -inI[k];
    forward(inR, inI, outR, outI);
    for (let k = 0; k < n; k++) { inI[k] = -inI[k]; outR[k] /= n; outI[k] = -outI[k] / n; }
  }
  return { n, forward, inverse, factors };
}
