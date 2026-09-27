'use strict';
// Decision benchmark: BigInt vs safe-integer Number for minor-unit money.
// Measures (a) the hot-path add/compare throughput and (b) resident memory for
// per-account per-day state at 200k accounts x 7 slots x 5 arrays.
// Run: node --expose-gc scripts/bench-numeric.js
const N = 20_000_000;

function hotBig() {
  let bal = 0n; const amt = 12345n; let neg = 0;
  const t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { bal += (i & 1) ? amt : -amt; if (bal < 0n) neg++; }
  return Number(process.hrtime.bigint() - t) / 1e6;
}
function hotNum() {
  let bal = 0; const amt = 12345; let neg = 0;
  const t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    bal += (i & 1) ? amt : -amt;
    if (!Number.isSafeInteger(bal)) throw new Error('overflow');
    if (bal < 0) neg++;
  }
  return Number(process.hrtime.bigint() - t) / 1e6;
}
function mem(kind) {
  global.gc && global.gc();
  const before = process.memoryUsage().heapUsed;
  const A = 200_000, keep = [];
  for (let a = 0; a < A; a++) {
    const arrs = [];
    for (let k = 0; k < 5; k++) {
      if (kind === 'big') { const x = new Array(7); for (let d = 0; d < 7; d++) x[d] = BigInt(a * 1000 + d * 7919 + 2 ** 40); arrs.push(x); }
      else { const x = new Float64Array(7); for (let d = 0; d < 7; d++) x[d] = a * 1000 + d * 7919 + 2 ** 40; arrs.push(x); }
    }
    keep.push(arrs);
  }
  global.gc && global.gc();
  const mb = (process.memoryUsage().heapUsed - before) / 1048576;
  return { mb: mb.toFixed(1), n: keep.length };
}
console.log('hot loop BigInt ms', hotBig().toFixed(0));
console.log('hot loop Number ms', hotNum().toFixed(0));
console.log('memory BigInt   ', mem('big'));
console.log('memory Float64  ', mem('num'));
function memPacked() {
  global.gc && global.gc();
  const before = process.memoryUsage().heapUsed;
  const A = 200_000, keep = [];
  for (let a = 0; a < A; a++) { const x = new Float64Array(35); for (let d = 0; d < 35; d++) x[d] = a * 1000 + d; keep.push(x); }
  global.gc && global.gc();
  return { mb: ((process.memoryUsage().heapUsed - before) / 1048576).toFixed(1), n: keep.length };
}
console.log('memory packed F64', memPacked());
