// gta6-twitch-ccu-forecast-01 — ronde 1
// Forecaster: local-linear (kernel-weighted) regression of launch-day
// log-ratios on log hour-1 viewers, anchored on the observed hour-1
// viewers (p1) and the pre-release hype ratio (r01), pooled over
// comparable big-game launches. Deterministic, stdlib only, no network.
//
// Usage: MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
// Reads every *.in in the input dir, writes one *.out per *.in.

import * as fs from "node:fs";
import * as path from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const MAX_Q = 1e9;

type HourlyPoint = { from: string; viewers: number };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid];
  return (s[mid - 1] + s[mid]) / 2;
}

function sameInstant(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

interface PoolEntry {
  name: string;
  x: number; // ln(p1c)
  logR01c: number; // ln(r01c)
  lr: number[]; // lr[h] for h = 1..23 (hour h+1), index 0 unused
}

function buildPool(c: any, gameName: string): PoolEntry[] {
  const comparables: any[] = Array.isArray(c.comparables) ? c.comparables : [];
  // Sort by name first so every floating-point sum order is deterministic.
  const sorted = [...comparables].sort((a, b) => {
    const na = String(a?.name ?? "");
    const nb = String(b?.name ?? "");
    return na < nb ? -1 : na > nb ? 1 : 0;
  });
  const pool: PoolEntry[] = [];
  for (const comp of sorted) {
    if (!comp || typeof comp !== "object") continue;
    if (String(comp.name ?? "") === gameName) continue;
    const hourly: any[] = Array.isArray(comp.hourly) ? comp.hourly : [];
    const ds = String(comp.day_start ?? "");
    if (!ds) continue;
    let idx = -1;
    for (let i = 0; i < hourly.length; i++) {
      if (typeof hourly[i]?.from === "string" && sameInstant(hourly[i].from, ds)) {
        idx = i;
        break;
      }
    }
    if (idx < 0 || idx < 6 || idx + 23 >= hourly.length) continue;
    const day: HourlyPoint[] = hourly.slice(idx, idx + 24);
    if (day.length !== 24) continue;
    let ok = true;
    for (const p of day) {
      if (!isFiniteNumber(p?.viewers) || p.viewers <= 0) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const pre: number[] = [];
    for (let i = idx - 6; i < idx; i++) {
      const v = hourly[i]?.viewers;
      if (!isFiniteNumber(v)) {
        ok = false;
        break;
      }
      pre.push(v);
    }
    if (!ok) continue;
    const medPre = median(pre);
    if (!(medPre > 0)) continue;
    const p1c = day[0].viewers;
    if (!(p1c > 0)) continue;
    const r01c = p1c / medPre;
    const lr: number[] = new Array(24).fill(0);
    for (let h = 1; h <= 23; h++) {
      lr[h] = Math.log(day[h].viewers / day[0].viewers);
    }
    pool.push({ name: String(comp.name), x: Math.log(p1c), logR01c: Math.log(r01c), lr });
  }
  return pool;
}

function forecastCase(c: any): { hours: { hour: number; q: number[] }[] } {
  const gameName = String(c?.game?.name ?? "");

  // --- anchor: p1 and pre-release median (6 hourly points before day_start)
  const dayStart = String(c?.day_start ?? "");
  const hist: any[] = Array.isArray(c?.history_hourly) ? c.history_hourly : [];
  const dayStartMs = dayStart ? Date.parse(dayStart) : NaN;
  const preHist: number[] = [];
  for (const p of hist) {
    if (typeof p?.from !== "string") continue;
    // Strictly before day_start: compare parsed instants when possible
    // (robust to "+00:00" vs "Z" spellings), else fall back to ISO strings.
    const t = Date.parse(p.from);
    const before = Number.isFinite(t) && Number.isFinite(dayStartMs) ? t < dayStartMs : p.from < dayStart;
    if (before && isFiniteNumber(p.viewers)) preHist.push(p.viewers);
  }
  // If day_start is missing/unparseable, fall back to the last 6 points.
  const pre6 =
    preHist.length > 0 ? preHist.slice(-6) : hist.slice(-6).map((p: any) => p?.viewers).filter(isFiniteNumber);
  const median6 = median(pre6);

  let p1 = 0;
  const known: any[] = Array.isArray(c?.known) ? c.known : [];
  if (known.length > 0 && isFiniteNumber(known[0]?.viewers) && known[0].viewers > 0) {
    p1 = known[0].viewers;
  } else if (median6 > 0) {
    p1 = median6;
  } else {
    p1 = 1;
  }
  const r01 = median6 > 0 ? p1 / median6 : 1;
  const logP1 = Math.log(p1);
  const logR01 = Math.log(r01);

  // --- comparable pool
  const pool = buildPool(c, gameName);

  // --- per-hour local-linear regression on log-ratios
  const center: number[] = new Array(24).fill(0);
  const sdArr: number[] = new Array(24).fill(0.25);
  if (pool.length === 0) {
    // Degenerate fallback: flat forecast at p1 with a wide band.
    for (let h = 1; h <= 23; h++) {
      center[h] = 0;
      sdArr[h] = 0.25;
    }
  } else {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const e of pool) {
      if (e.x < minX) minX = e.x;
      if (e.x > maxX) maxX = e.x;
    }
    const xTarget = Math.min(maxX, Math.max(minX, logP1));
    for (let h = 1; h <= 23; h++) {
      // Gaussian kernel weights on log-p1 and log-r01.
      const w: number[] = new Array(pool.length);
      let wSum = 0;
      for (let i = 0; i < pool.length; i++) {
        const dx = (logP1 - pool[i].x) / 0.8;
        const dr = (logR01 - pool[i].logR01c) / 1.0;
        const wi = Math.exp(-(dx * dx)) * Math.exp(-(dr * dr));
        w[i] = wi;
        wSum += wi;
      }
      if (!(wSum > 0)) {
        center[h] = 0;
        sdArr[h] = 0.25;
        continue;
      }
      let mx = 0;
      let my = 0;
      for (let i = 0; i < pool.length; i++) {
        mx += w[i] * pool[i].x;
        my += w[i] * pool[i].lr[h];
      }
      mx /= wSum;
      my /= wSum;
      let num = 0;
      let den = 0;
      for (let i = 0; i < pool.length; i++) {
        const dx = pool[i].x - mx;
        num += w[i] * dx * (pool[i].lr[h] - my);
        den += w[i] * dx * dx;
      }
      const b = den === 0 ? 0 : num / den;
      const a = my - b * mx;
      center[h] = a + b * xTarget;
      let varSum = 0;
      for (let i = 0; i < pool.length; i++) {
        const resid = pool[i].lr[h] - (a + b * pool[i].x);
        varSum += w[i] * resid * resid;
      }
      const sd = Math.sqrt(varSum / wSum);
      sdArr[h] = Math.max(0.1, 0.85 * sd);
    }
  }

  // --- triangular smoothing across hours (±1), edges use available neighbours
  const centerS: number[] = new Array(24).fill(0);
  const sdS: number[] = new Array(24).fill(0);
  for (let h = 1; h <= 23; h++) {
    if (h === 1) {
      centerS[h] = (2 * center[1] + center[2]) / 3;
      sdS[h] = (2 * sdArr[1] + sdArr[2]) / 3;
    } else if (h === 23) {
      centerS[h] = (center[22] + 2 * center[23]) / 3;
      sdS[h] = (sdArr[22] + 2 * sdArr[23]) / 3;
    } else {
      centerS[h] = (center[h - 1] + 2 * center[h] + center[h + 1]) / 4;
      sdS[h] = (sdArr[h - 1] + 2 * sdArr[h] + sdArr[h + 1]) / 4;
    }
  }

  // --- quantiles
  const hours: { hour: number; q: number[] }[] = [];
  for (let h = 1; h <= 23; h++) {
    const q: number[] = [];
    let prev = 0;
    for (let k = 0; k < 5; k++) {
      let v = p1 * Math.exp(centerS[h] + Z[k] * sdS[h]);
      if (!Number.isFinite(v) || v <= 0) v = 1;
      if (v > MAX_Q) v = MAX_Q;
      v = Math.round(v * 100) / 100;
      if (v < prev) v = prev;
      if (v <= 0) v = prev > 0 ? prev : 0.01;
      if (v > MAX_Q) v = MAX_Q;
      q.push(v);
      prev = v;
    }
    hours.push({ hour: h + 1, q });
  }
  return { hours };
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(inputDir, f), "utf8");
    const c = JSON.parse(raw);
    const out = forecastCase(c);
    const outName = f.slice(0, -3) + ".out";
    fs.writeFileSync(path.join(outputDir, outName), JSON.stringify(out));
  }
}

main();
