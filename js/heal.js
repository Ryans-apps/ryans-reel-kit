// Clone stamp and spot heal, written from scratch for this app.
// Spot heal: find a nearby patch whose surrounding pixels best match the area around the spot,
// copy it in, then smooth out the colour difference at the seam (a membrane/Laplace fill).

export function cloneDab(ctx, snapshot, sx, sy, dx, dy, r, hardness = 0.5) {
  const d = Math.ceil(r * 2); if (d < 2) return;
  const tmp = cloneDab.tmp || (cloneDab.tmp = document.createElement('canvas'));
  tmp.width = d; tmp.height = d; const t = tmp.getContext('2d');
  t.clearRect(0, 0, d, d); t.drawImage(snapshot, sx - r, sy - r, d, d, 0, 0, d, d);
  t.globalCompositeOperation = 'destination-in';
  const g = t.createRadialGradient(r, r, r * hardness, r, r, r); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  t.fillStyle = g; t.fillRect(0, 0, d, d); t.globalCompositeOperation = 'source-over';
  ctx.drawImage(tmp, dx - r, dy - r);
}

// pix: canvas to edit. maskCanvas: same size, painted where to heal (alpha > 0).
export function spotHeal(pix, maskCanvas) {
  const W = pix.width, H = pix.height;
  const md = maskCanvas.getContext('2d').getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (md[(y * W + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return false;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, R = Math.ceil(Math.max(bw, bh) * 2.5) + 8, ring = 4;
  const rx0 = Math.max(0, x0 - R), ry0 = Math.max(0, y0 - R), rx1 = Math.min(W - 1, x1 + R), ry1 = Math.min(H - 1, y1 + R);
  const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
  const ctx = pix.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(rx0, ry0, rw, rh), px = img.data;
  const M = new Uint8Array(rw * rh); // 1 = fill
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) M[y * rw + x] = md[((y + ry0) * W + x + rx0) * 4 + 3] > 10 ? 1 : 0;
  // dilate to get the ring (pixels near the hole, not in it)
  const near = dilate(M, rw, rh, ring); const ringIdx = []; const holeIdx = [];
  for (let i = 0; i < M.length; i++) { if (M[i]) holeIdx.push(i); else if (near[i]) ringIdx.push(i); }
  const inner = dilate(M, rw, rh, ring + 1);
  const sample = ringIdx.filter((_, i) => i % Math.max(1, Math.floor(ringIdx.length / 400)) === 0);
  // search offsets
  const step = Math.max(2, Math.round(Math.max(bw, bh) / 6)); let best = null, bestCost = Infinity;
  const bx0 = x0 - rx0, by0 = y0 - ry0;
  for (let oy = -R; oy <= R; oy += step) for (let ox = -R; ox <= R; ox += step) {
    if (Math.abs(ox) < bw + ring && Math.abs(oy) < bh + ring) continue; // would overlap the hole
    if (bx0 - ring + ox < 0 || by0 - ring + oy < 0 || bx0 + bw + ring + ox >= rw || by0 + bh + ring + oy >= rh) continue;
    let cost = 0, ok = true;
    for (const i of sample) { const x = i % rw, y = (i / rw) | 0, j = (y + oy) * rw + x + ox; if (inner[j]) { ok = false; break; } const a = i * 4, b = j * 4; const dr = px[a] - px[b], dg = px[a + 1] - px[b + 1], db = px[a + 2] - px[b + 2]; cost += dr * dr + dg * dg + db * db; }
    if (!ok) continue; cost += (ox * ox + oy * oy) * 0.5; // prefer close patches
    if (cost < bestCost) { bestCost = cost; best = [ox, oy]; }
  }
  if (!best) best = [bw + ring + 2 <= R ? bw + ring + 2 : -(bw + ring + 2), 0];
  const [ox, oy] = best; const off = oy * rw + ox;
  // seam difference on the ring, then Laplace-fill it into the hole
  const n = rw * rh, D = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (const i of ringIdx) { const j = i + off; if (j < 0 || j >= n) continue; for (let c = 0; c < 3; c++) D[c][i] = px[i * 4 + c] - px[j * 4 + c]; }
  const iters = Math.min(500, Math.max(60, Math.max(bw, bh) * 2));
  for (let c = 0; c < 3; c++) {
    const d = D[c]; let mean = 0; for (const i of ringIdx) mean += d[i]; mean /= Math.max(1, ringIdx.length);
    for (const i of holeIdx) d[i] = mean;
    for (let k = 0; k < iters; k++) for (const i of holeIdx) d[i] = (d[i - 1] + d[i + 1] + d[i - rw] + d[i + rw]) * 0.25;
  }
  for (const i of holeIdx) { const j = i + off; if (j < 0 || j >= n) continue; for (let c = 0; c < 3; c++) px[i * 4 + c] = px[j * 4 + c] + D[c][i]; px[i * 4 + 3] = px[j * 4 + 3]; }
  ctx.putImageData(img, rx0, ry0);
  return true;
}
function dilate(M, w, h, r) {
  let a = M; for (let k = 0; k < r; k++) { const b = new Uint8Array(a); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (!a[i] && (a[i - 1] || a[i + 1] || a[i - w] || a[i + w])) b[i] = 1; } a = b; }
  return a;
}
