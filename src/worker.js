/**
 * CTCL — Common Temporal Coordinate Layer (MVP Worker)
 * Neo.K's whitepaper: 共同時間座標層 / CTCL_Agent_Time_API v0.1.
 *
 * A machine-readable REFERENCE + TRANSFORMATION layer for agents — not a universal
 * clock authority. "Same instant, different representations."
 *
 *   GET  /v1/now            verified reference instant (envelope §5)
 *   GET  /v1/timescales     supported timescales
 *   GET  /v1/encodings      supported encodings
 *   POST /v1/convert        convert a time value across encodings/timescales/timezones (§7)
 *   POST /v1/transform      map a reference value into a custom linear-rate system (§8-9,12)
 *   GET  /openapi.json      OpenAPI-ish resource map (§40)
 *   GET  /ai/ctcl.json      agent tool declaration (machine discovery — call this first)
 *   GET  /                  human page: live clock + playground + agent usage
 *
 * HONESTY (§16): a Worker's wall clock is millisecond-grade. We expose ns/us FIELDS
 * for format compatibility but never claim ns ACCURACY — quality.precision says so and
 * estimated_uncertainty_ns reflects the real ~ms ceiling. /convert preserves whatever
 * precision the CALLER supplies (BigInt nanoseconds), because that is offline math, not
 * the wall clock.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const API_VERSION = "v1";
// Leap-second-dependent offsets. NOT a live leap table — current values with a caveat.
const LEAP = { tai_minus_utc_s: 37, gps_minus_utc_s: 18, as_of: "2017-01-01",
  note: "Current offsets, not a live leap table. Verify for high-stakes/scientific use." };

const NS_PER = { s: 1000000000n, ms: 1000000n, us: 1000n, ns: 1n };

function jsonResp(obj, status = 200, cc) {
  const headers = { "Content-Type": "application/json; charset=utf-8", ...CORS };
  if (cc) headers["Cache-Control"] = cc;
  return new Response(JSON.stringify(obj, null, 2) + "\n", { status, headers });
}
function ok(data, meta = {}, cc) {
  return jsonResp({ ok: true, data, meta: { api_version: API_VERSION, request_id: rid(), ...meta } }, 200, cc);
}
function fail(code, message, details = {}, status = 400) {
  return jsonResp({ ok: false, error: { code, message, details }, meta: { api_version: API_VERSION, request_id: rid() } }, status);
}
function rid() { return "req_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20); }
function instantId() { return "ctcl:instant:" + crypto.randomUUID(); }

// ---- time core -------------------------------------------------------------

// Parse a value+encoding to canonical BigInt nanoseconds since the Unix epoch (UTC).
function toNs(value, encoding) {
  const enc = (encoding || "unix_s").toLowerCase();
  if (enc === "rfc3339" || enc === "iso8601") {
    const s = String(value).trim();
    const base = Date.parse(s.replace(/(\.\d+)?(Z|[+\-]\d{2}:?\d{2})?$/, (m, frac, tz) => (tz || "Z")));
    if (Number.isNaN(base)) throw { code: "INVALID_TIME_VALUE", msg: `unparseable rfc3339: ${s}` };
    const fm = s.match(/\.(\d{1,9})/);
    const frac = fm ? BigInt(fm[1].padEnd(9, "0")) : 0n;
    // base already includes ms; strip its ms, re-add full-precision fractional seconds
    return BigInt(Math.floor(base / 1000)) * NS_PER.s + frac;
  }
  const unit = enc.replace(/^unix_/, "");
  if (!NS_PER[unit]) throw { code: "UNKNOWN_ENCODING", msg: `unknown encoding: ${encoding}` };
  const str = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) throw { code: "INVALID_TIME_VALUE", msg: `not numeric: ${value}` };
  const [ip, fp = ""] = str.split(".");
  let ns = BigInt(ip) * NS_PER[unit];
  // fractional part of the unit -> nanoseconds (e.g. 0.5 unix_s = 5e8 ns), sign-aware
  if (fp) {
    const fracNs = BigInt(Math.round(Number("0." + fp) * Number(NS_PER[unit])));
    ns += ip.trimStart().startsWith("-") ? -fracNs : fracNs;
  }
  return ns;
}

// Encode canonical ns to a target encoding string. tz (IANA) only affects rfc3339.
function fromNs(ns, encoding, tz) {
  const enc = (encoding || "unix_s").toLowerCase();
  if (enc === "rfc3339" || enc === "iso8601") return rfc3339(ns, tz);
  const unit = enc.replace(/^unix_/, "");
  if (!NS_PER[unit]) throw { code: "UNKNOWN_ENCODING", msg: `unknown encoding: ${encoding}` };
  const whole = ns / NS_PER[unit];
  const rem = ns % NS_PER[unit];
  if (rem === 0n) return whole.toString();
  const fracDigits = String(NS_PER[unit]).length - 1;
  return whole.toString() + "." + (rem < 0n ? -rem : rem).toString().padStart(fracDigits, "0").replace(/0+$/, "");
}

function pad(n, w = 2) { return String(n).padStart(w, "0"); }

// Build an RFC3339 string (with up to 9 fractional digits) for canonical ns, optional IANA tz.
function rfc3339(ns, tz) {
  const ms = Number(ns / NS_PER.ms);
  const subMs = ns % NS_PER.ms; // 0..999999 ns
  const nanoStr = (ns % NS_PER.s < 0n ? 0n : ns % NS_PER.s).toString().padStart(9, "0").replace(/0+$/, "");
  const d = new Date(ms);
  if (!tz || tz.toUpperCase() === "UTC" || tz === "Z") {
    const iso = d.toISOString().replace(/\.\d+Z$/, "");
    return iso + (nanoStr ? "." + nanoStr : "") + "Z";
  }
  const off = tzOffsetMinutes(ms, tz);
  const local = new Date(ms + off * 60000);
  const sign = off >= 0 ? "+" : "-";
  const ao = Math.abs(off);
  const base = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return base + (nanoStr ? "." + nanoStr : "") + `${sign}${pad(Math.floor(ao / 60))}:${pad(ao % 60)}`;
}

// Offset (minutes) of an IANA tz at a given UTC ms, via the Intl formatToParts diff trick.
function tzOffsetMinutes(ms, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {};
  for (const { type, value } of dtf.formatToParts(new Date(ms))) p[type] = value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === "24" ? "0" : p.hour), +p.minute, +p.second);
  return Math.round((asUTC - ms) / 60000);
}

function nowEnvelope() {
  const ms = Date.now();
  const ns = BigInt(ms) * NS_PER.ms;
  const iso = new Date(ms).toISOString();
  return {
    instant: { id: instantId(), reference: { timescale: "utc", value: iso } },
    ...instantViews(ns),
    source: { class: "edge_wall_clock", protocol: "cloudflare-edge", provider: "cloudflare", sync_status: "synchronized" },
    quality: {
      precision: "millisecond_representation", estimated_uncertainty_ns: 5000000, synchronized: true,
      note: "ns/us fields are zero-padded from a millisecond source. precision != accuracy (whitepaper §16).",
    },
    policy: { leap_second: "posix_compatible", leap_table: LEAP },
  };
}

// ---- instant views (shared by /v1/now and the registry) -------------------
function instantViews(ns) {
  const iso = rfc3339(ns, "UTC");
  return {
    encodings: {
      unix_s: fromNs(ns, "unix_s"), unix_ms: fromNs(ns, "unix_ms"),
      unix_us: fromNs(ns, "unix_us"), unix_ns: fromNs(ns, "unix_ns"), rfc3339: iso,
    },
    timescales: {
      utc: iso, posix: fromNs(ns, "unix_s"),
      tai_approx: fromNs(ns + BigInt(LEAP.tai_minus_utc_s) * NS_PER.s, "unix_s"),
      gps_approx: fromNs(ns + BigInt(LEAP.gps_minus_utc_s) * NS_PER.s, "unix_s"),
    },
  };
}

// ---- Phase 2: KV-backed instant registry + persistent custom systems -------
// Instants (§6/§27): agent A registers a reference instant I*, agent B retrieves it
// by id and aligns on the SAME instant — the multi-agent temporal-alignment core.
// Systems (§10/§11): persistent custom linear-rate clocks (game worlds, accel sims).
// Graceful 503 when KV is unbound so /v1/now and the stateless endpoints still work.
function kvMissing() { return fail("REGISTRY_UNAVAILABLE", "KV registry not configured on this deployment", {}, 503); }
function uuidOf(id) { return String(id).replace(/^ctcl:instant:/, "").replace(/^instant:/, ""); }

async function registerInstant(req, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  let body = {};
  try { body = await req.json(); } catch { /* empty body -> register the current instant */ }
  let ns;
  try { ns = body.value != null ? toNs(body.value, body.encoding) : BigInt(Date.now()) * NS_PER.ms; }
  catch (e) { return fail(e.code || "INVALID_TIME_VALUE", e.msg || String(e)); }
  const id = instantId();
  const rec = {
    id, unix_ns: ns.toString(), reference_timescale: body.timescale || "utc",
    registered_at: new Date().toISOString(), label: body.label || null, meta: body.meta || null,
    from_wall_clock: body.value == null,
  };
  await env.CTCL_KV.put("instant:" + uuidOf(id), JSON.stringify(rec));
  return ok({ ...rec, retrieve: `/v1/instant/${id}`, ...instantViews(ns) },
    { note: "Registered. Any agent can GET /v1/instant/{id} to align on this exact instant (§27). Store the id in memory, not a bare number." });
}

async function getInstant(id, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const raw = await env.CTCL_KV.get("instant:" + uuidOf(id));
  if (!raw) return fail("UNKNOWN_INSTANT", `no registered instant: ${id}`, {}, 404);
  const rec = JSON.parse(raw);
  return ok({ ...rec, ...instantViews(BigInt(rec.unix_ns)) });
}

async function createSystem(req, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  let body;
  try { body = await req.json(); } catch { return fail("INVALID_TIME_VALUE", "body must be JSON"); }
  const sys = body.system || body;
  if (!sys.id) return fail("INVALID_TIME_VALUE", "system.id required (e.g. user:game_world)");
  const rin = (sys.rate && typeof sys.rate === "object") ? sys.rate : { value: sys.rate };
  const rtype = rin.type || "constant";
  const rate = { type: rtype, value: Number(rin.value ?? 1) };
  if (rtype === "constant" && !Number.isFinite(rate.value)) return fail("UNSUPPORTED_POLICY", "rate.value must be a finite number");
  if (rtype === "piecewise") { if (!Array.isArray(rin.segments)) return fail("UNSUPPORTED_POLICY", "piecewise needs rate.segments: [{until: unix_s|null, rate: number}]"); rate.segments = rin.segments; }
  else if (rtype === "paused") { if (!Array.isArray(rin.pauses)) return fail("UNSUPPORTED_POLICY", "paused needs rate.pauses: [{from: unix_s, to: unix_s|null}]"); rate.pauses = rin.pauses; }
  else if (rtype === "table") { if (!Array.isArray(rin.table)) return fail("UNSUPPORTED_POLICY", "table needs rate.table: [{parent: unix_s, local: seconds}]"); rate.table = rin.table; }
  else if (rtype !== "constant") return fail("UNSUPPORTED_POLICY", "rate.type must be constant | piecewise | paused | table");
  const rec = {
    id: sys.id, parent: sys.parent || "ctcl:system:unix",
    epoch: sys.epoch || { parent_value: "0", encoding: "unix_s" },
    rate, offset: Number(sys.offset ?? 0),
    calendar: sys.calendar || null, created_at: new Date().toISOString(),
  };
  await env.CTCL_KV.put("system:" + sys.id, JSON.stringify(rec));
  return ok({ ...rec, now: `/v1/systems/${encodeURIComponent(sys.id)}/now` });
}

async function getSystem(id, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const raw = await env.CTCL_KV.get("system:" + id);
  if (!raw) return fail("UNKNOWN_SYSTEM", `no such system: ${id}`, {}, 404);
  return ok(JSON.parse(raw));
}

// Integrate a system's rate over parent time → local seconds. Handles the §12 rate
// types: constant (y=a·Δ), piecewise_linear (segments), paused_clock (§12.5/§25 active
// time = wall elapsed minus paused elapsed).
function localSeconds(sys, parentSec, epochSec) {
  const rate = sys.rate || { type: "constant", value: 1 };
  const off = Number(sys.offset || 0);
  const elapsed = parentSec - epochSec;
  if (rate.type === "paused") {
    let paused = 0, nowPaused = false;
    for (const pz of (rate.pauses || [])) {
      const pf = Number(pz.from), pt = (pz.to == null) ? Infinity : Number(pz.to);
      const lo = Math.max(pf, epochSec), hi = Math.min(pt, parentSec);
      if (hi > lo) paused += hi - lo;
      if (parentSec >= pf && parentSec < pt) nowPaused = true;
    }
    const v = Number(rate.value ?? 1);
    return { local: (elapsed - paused) * v + off,
      extra: { wall_elapsed_s: elapsed, paused_elapsed_s: paused, active_elapsed_s: elapsed - paused, currently_paused: nowPaused } };
  }
  if (rate.type === "piecewise") {
    let local = 0, cursor = epochSec;
    const segs = rate.segments || [];
    for (const seg of segs) {
      const until = (seg.until == null) ? parentSec : Number(seg.until);
      const hi = Math.min(until, parentSec);
      if (hi > cursor) { local += Number(seg.rate) * (hi - cursor); cursor = hi; }
      if (cursor >= parentSec) break;
    }
    if (cursor < parentSec && segs.length) local += Number(segs[segs.length - 1].rate) * (parentSec - cursor);
    return { local: local + off, extra: { wall_elapsed_s: elapsed, segments: segs.length } };
  }
  if (rate.type === "table") {
    const tbl = (rate.table || []).map((p) => ({ p: Number(p.parent), l: Number(p.local) })).sort((a, b) => a.p - b.p);
    if (!tbl.length) return { local: off, extra: { table: 0 } };
    if (parentSec <= tbl[0].p) return { local: tbl[0].l + off, extra: { table: tbl.length, clamp: "start" } };
    const last = tbl[tbl.length - 1];
    if (parentSec >= last.p) return { local: last.l + off, extra: { table: tbl.length, clamp: "end" } };
    for (let i = 0; i < tbl.length - 1; i++) {
      const a = tbl[i], b = tbl[i + 1];
      if (parentSec >= a.p && parentSec <= b.p) {
        const f = (b.p === a.p) ? 0 : (parentSec - a.p) / (b.p - a.p);
        return { local: a.l + f * (b.l - a.l) + off, extra: { table: tbl.length, interpolated: true } };
      }
    }
    return { local: off, extra: { table: tbl.length } };
  }
  return { local: Number(rate.value ?? 1) * elapsed + off, extra: { wall_elapsed_s: elapsed } };
}

async function systemNow(id, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const raw = await env.CTCL_KV.get("system:" + id);
  if (!raw) return fail("UNKNOWN_SYSTEM", `no such system: ${id}`, {}, 404);
  const sys = JSON.parse(raw);
  let epochNs;
  try { epochNs = toNs(sys.epoch?.parent_value ?? 0, sys.epoch?.encoding || "unix_s"); }
  catch { epochNs = 0n; }
  const nowNs = BigInt(Date.now()) * NS_PER.ms;
  const { local, extra } = localSeconds(sys, Number(nowNs) / 1e9, Number(epochNs) / 1e9);
  let calendar = null;
  const cal = sys.calendar;
  if (cal && cal.day_seconds && cal.year_days) {
    const days = Math.floor(local / cal.day_seconds);
    calendar = { world_year: Math.floor(days / cal.year_days), world_day: (days % cal.year_days) + 1,
      seconds_into_day: Math.floor(((local % cal.day_seconds) + cal.day_seconds) % cal.day_seconds) };
  }
  return ok({ system_id: sys.id, reference: { timescale: "utc", value: rfc3339(nowNs, "UTC") },
    system_time: String(local), unit: "second", rate_type: sys.rate && sys.rate.type || "constant", ...extra, calendar });
}

// ---- §17/§35/§36 version + tiers ; §18 local-time ambiguity ----------------

function versionInfo() {
  return ok({
    service: "CTCL", api_version: API_VERSION, release: "0.1",
    leap_table: LEAP, tzdb: "IANA via the runtime Intl database",
    source_precision: "millisecond_representation (edge wall clock)",
    precision_tiers: { coarse: ">= 1 s", standard: ">= 1 ms", high: ">= 1 µs (representation)", ultra: ">= 1 ns (representation)" },
    trust_tiers: { T0: "unknown", T1: "local, unsynchronized", T2: "network-synchronized", T3: "authenticated source", T4: "calibrated authoritative chain" },
    current_trust_tier: "T2",
    rate_limit_policy: { enforced: false, note: "No per-key limit yet; Cloudflare edge/DDoS protection is active. Enterprise keys later." },
    honesty: "precision is not accuracy; ns/us fields are format-padding on a millisecond source (§16).",
  }, {}, "public, max-age=300");
}

// Resolve a NAIVE local datetime (no offset) in an IANA tz to candidate UTC instants.
// 0 candidates = nonexistent (DST spring-forward gap); 1 = unique; 2 = ambiguous (fall-back).
function localToUtc(localStr, tz) {
  const m = String(localStr).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?/);
  if (!m) return { candidates: [], wallMs: null };
  const wallMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const cands = new Set();
  // Sample the tz offset on BOTH sides of any same-day DST transition (±12h), form a
  // candidate UTC per distinct offset, and keep only those that format back to the wall
  // time. 0 = nonexistent (gap), 1 = unique, 2 = ambiguous (overlap).
  const offs = new Set([tzOffsetMinutes(wallMs - 43200000, tz), tzOffsetMinutes(wallMs, tz), tzOffsetMinutes(wallMs + 43200000, tz)]);
  for (const off of offs) {
    const utc = wallMs - off * 60000;
    if (tzOffsetMinutes(utc, tz) * 60000 === wallMs - utc) cands.add(utc);
  }
  return { candidates: [...cands].sort((a, b) => a - b), wallMs };
}

// ---- §40 completion: transform graph, validate, list, transform types -----

const TRANSFORM_TYPES = {
  identity: { formula: "y = x", invertible: "exact", implemented: true },
  offset: { formula: "y = x + b", params: ["offset"], invertible: "exact", implemented: true },
  linear_rate: { formula: "y = a·(x − epoch) + b", params: ["rate", "epoch", "offset"], invertible: "exact (a≠0)", implemented: true, via: "/v1/transform, /v1/systems" },
  piecewise_linear: { formula: "y = aᵢ·x + bᵢ on interval i", params: ["segments"], invertible: "partial", implemented: true, via: "/v1/systems (rate.type=piecewise)" },
  paused_clock: { formula: "τ(t) = ∫ r(t) dt, r=0 while paused", params: ["pauses"], invertible: "none (pauses erase ordering)", implemented: true, note: "active-time (§25)", via: "/v1/systems (rate.type=paused)" },
  table_lookup: { formula: "y = piecewise-linear interpolation of a (parent, local) table", params: ["table"], invertible: "partial", implemented: true, via: "/v1/systems (rate.type=table)" },
  timezone: { formula: "local civil time via IANA tz", invertible: "partial (DST ambiguity)", implemented: true, via: "/v1/convert" },
  calendar: { formula: "world date via day_seconds / year_days", invertible: "exact", implemented: true, via: "/v1/systems/{id}/now" },
  custom_expression: { formula: "user-supplied expression", invertible: "unknown", implemented: false },
};

function transformsCatalog(id) {
  if (id) {
    const t = TRANSFORM_TYPES[id];
    return t ? ok({ id, ...t }) : fail("UNKNOWN_TRANSFORM", `no transform type: ${id}`, { available: Object.keys(TRANSFORM_TYPES) }, 404);
  }
  return ok({ count: Object.keys(TRANSFORM_TYPES).length, implemented: Object.keys(TRANSFORM_TYPES).filter(k => TRANSFORM_TYPES[k].implemented), types: TRANSFORM_TYPES });
}

async function validateTime(req) {
  let body;
  try { body = await req.json(); } catch { return fail("INVALID_TIME_VALUE", "body must be JSON"); }
  const enc = body.encoding || "unix_s";
  const warnings = [];
  let ns;
  try { ns = toNs(body.value, enc); }
  catch (e) { return ok({ valid: false, error: { code: e.code || "INVALID_TIME_VALUE", message: e.msg || String(e) } }); }
  if ((body.timescale || "").toLowerCase() === "utc" && /^unix_/.test(enc))
    warnings.push("unix_* encodings are POSIX (leap-seconds flattened); labelling them 'utc' can drift by whole leap seconds. Use timescale 'posix' for unix_* values.");
  const yr = Math.floor(Number(ns / NS_PER.s) / 31557600 + 1970);
  if (yr < 1678 || yr > 2262) warnings.push("value is far outside the common range (year " + yr + "); double-check the encoding/unit.");
  return ok({ valid: true, canonical_unix_ns: ns.toString(), rfc3339: rfc3339(ns, "UTC"), warnings });
}

async function listSystems(env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const l = await env.CTCL_KV.list({ prefix: "system:" });
  const systems = l.keys.map((k) => k.name.replace(/^system:/, ""));
  return ok({ count: systems.length, systems, truncated: !l.list_complete,
    note: "GET /v1/systems/{id} for a definition; /v1/systems/{id}/now for its current time." });
}

// §13-14 transform graph path. MVP graph is a STAR: every custom system routes through
// ctcl:system:unix; unix/utc/posix are identity peers. Returns the route, not a value —
// use /v1/transform or /v1/convert to actually map a value along it.
async function transformPath(url, env) {
  const from = url.searchParams.get("from"), to = url.searchParams.get("to");
  if (!from || !to) return fail("INVALID_TIME_VALUE", "'from' and 'to' query params required", { example: "/v1/path?from=user:game_world&to=utc" });
  const BUILTIN = { unix: 1, utc: 1, posix: 1, "ctcl:system:unix": "unix" };
  async function resolve(x) {
    const b = BUILTIN[x];
    if (b) return { id: b === 1 ? x : b, kind: "builtin" };
    if (!env || !env.CTCL_KV) return null;
    const raw = await env.CTCL_KV.get("system:" + x);
    return raw ? { id: x, kind: "system", def: JSON.parse(raw) } : null;
  }
  const a = await resolve(from), b = await resolve(to);
  if (!a) return fail("UNKNOWN_SYSTEM", `unknown 'from': ${from}`, {}, 404);
  if (!b) return fail("UNKNOWN_SYSTEM", `unknown 'to': ${to}`, {}, 404);
  const chain = (n) => n.kind === "builtin" ? (n.id === "unix" ? ["unix"] : [n.id, "unix"]) : [n.id, "unix"];
  const ca = chain(a), cb = chain(b);
  let path = [...ca, ...cb.slice(0, -1).reverse()].filter((v, i, arr) => i === 0 || v !== arr[i - 1]);
  if (a.id === b.id) path = [a.id];
  return ok({ from, to, path, hops: path.length - 1, lossless: true, estimated_uncertainty_ns: 0,
    note: "Star graph: custom systems route through ctcl:system:unix; unix/utc/posix are identity peers. This is the route — map a value with POST /v1/transform or /v1/convert. Path selection (uncertainty/trust) arrives with a real multi-hop graph." });
}

// ---- endpoints -------------------------------------------------------------

async function handleConvert(req) {
  let body;
  try { body = await req.json(); } catch { return fail("INVALID_TIME_VALUE", "body must be JSON"); }
  const input = body.input || {};
  const output = body.output || {};
  let ns;
  const naiveLocal = input.timezone && /rfc3339|iso8601/i.test(input.encoding || "") &&
    !/[zZ]$|[+\-]\d\d:?\d\d$/.test(String(input.value || "").trim());
  if (naiveLocal) {
    // §18: interpret the input as a naive local wall-clock time in input.timezone
    const res = localToUtc(input.value, input.timezone);
    if (res.candidates.length === 0)
      return fail("NONEXISTENT_LOCAL_TIME", `${input.value} does not exist in ${input.timezone} (DST spring-forward gap)`, { timezone: input.timezone });
    if (res.candidates.length > 1)
      return fail("AMBIGUOUS_LOCAL_TIME", `${input.value} is ambiguous in ${input.timezone} (DST fall-back overlap) — pass an explicit offset to disambiguate`, { candidates: res.candidates.map((c) => rfc3339(BigInt(c) * NS_PER.ms, "UTC")) });
    ns = BigInt(res.candidates[0]) * NS_PER.ms;
  } else {
    try { ns = toNs(input.value, input.encoding); }
    catch (e) { return fail(e.code || "INVALID_TIME_VALUE", e.msg || String(e), { input }); }
  }
  let outValue;
  try { outValue = fromNs(ns, output.encoding || "rfc3339", output.timezone); }
  catch (e) { return fail(e.code || "UNKNOWN_ENCODING", e.msg || String(e), { output }); }
  // lossless only if the output encoding can represent the canonical ns without truncation
  const outUnit = (output.encoding || "rfc3339").toLowerCase().replace(/^unix_/, "");
  const lossless = (outUnit === "ns") || (NS_PER[outUnit] && ns % NS_PER[outUnit] === 0n) ||
    ((output.encoding || "rfc3339").match(/rfc3339|iso8601/) && ns % NS_PER.ns === 0n);
  return ok({
    input, output: { value: outValue, encoding: output.encoding || "rfc3339", timescale: output.timescale || "utc", timezone: output.timezone || "UTC" },
    canonical_unix_ns: ns.toString(),
    transform: { path: [(input.timescale || "posix"), (output.timescale || "utc")], type: "encoding_timescale" },
    quality: { lossless: !!lossless, loss: lossless ? null : { type: "precision_truncation" } },
  });
}

async function handleTransform(req) {
  let body;
  try { body = await req.json(); } catch { return fail("INVALID_TIME_VALUE", "body must be JSON"); }
  const sys = body.system || {};
  const rate = Number(sys.rate?.value ?? sys.rate ?? 1);
  const offset = Number(sys.offset ?? 0);
  const epochEnc = sys.epoch?.encoding || body.value_encoding || "unix_s";
  let parentNs, epochNs;
  try {
    parentNs = toNs(body.value, body.value_encoding || "unix_s");
    epochNs = toNs(sys.epoch?.parent_value ?? sys.epoch ?? 0, epochEnc);
  } catch (e) { return fail(e.code || "INVALID_TIME_VALUE", e.msg || String(e)); }
  if (!(rate > 0) && rate !== 0) return fail("UNSUPPORTED_POLICY", "rate must be a finite number");
  // local_seconds = rate * (parent_seconds - epoch_seconds) + offset
  const parentSec = Number(parentNs) / 1e9, epochSec = Number(epochNs) / 1e9;
  const localSec = rate * (parentSec - epochSec) + offset;
  let calendar = null;
  if (sys.calendar?.day_seconds && sys.calendar?.year_days) {
    const day = sys.calendar.day_seconds, year = sys.calendar.year_days;
    const days = Math.floor(localSec / day);
    calendar = { world_year: Math.floor(days / year), world_day: (days % year) + 1,
      seconds_into_day: Math.floor(localSec % day) };
  }
  return ok({
    system: { id: sys.id || "user:custom", parent: sys.parent || "ctcl:system:unix", rate, offset },
    value: String(localSec), unit: "second", transform_type: "linear_rate",
    formula: "local = rate*(parent - epoch) + offset", calendar,
    quality: { lossless: false, note: "float64 seconds; sub-ms and long-range precision limited" },
  });
}

function toolDeclaration(origin) {
  return {
    schema: "aicl-tool/0.1", service: "CTCL", version: "0.1",
    title: "Common Temporal Coordinate Layer",
    summary: "Verified reference instant + heterogeneous time transformation for agents. Read this, then call the endpoints. Same instant, different representations.",
    base_url: origin, runtime_enabled: true, sdk: origin + "/sdk.js",
    core_rule: "Do not ask only 'what time is it'. Ask: which reference instant, under which timescale, from which source, transformed into which local system.",
    honesty: "Source is a millisecond-grade edge wall clock. ns/us fields are format-padding; check quality.precision + estimated_uncertainty_ns before trusting sub-ms.",
    tools: [
      { name: "now", method: "GET", path: "/v1/now", desc: "Verified reference instant: encodings, timescales, source, uncertainty, policy, a stable instant_id.", input: {}, output: "instant+encodings+timescales+source+quality+policy" },
      { name: "timescales", method: "GET", path: "/v1/timescales", desc: "Supported timescales.", input: {}, output: "list" },
      { name: "encodings", method: "GET", path: "/v1/encodings", desc: "Supported encodings.", input: {}, output: "list" },
      { name: "convert", method: "POST", path: "/v1/convert", desc: "Convert a time value across encodings/timescales/timezones (precision-preserving).",
        input: { input: { value: "string", encoding: "unix_s|unix_ms|unix_us|unix_ns|rfc3339", timescale: "utc|posix" }, output: { encoding: "…", timezone: "IANA (optional)" } },
        output: "output.value + canonical_unix_ns + quality.lossless" },
      { name: "transform", method: "POST", path: "/v1/transform", desc: "Map a reference (parent) time into a custom linear-rate system (game world / accelerated sim / child clock).",
        input: { value: "string (parent time)", value_encoding: "unix_s", system: { parent: "ctcl:system:unix", epoch: { parent_value: "unix_s" }, rate: { value: "number" }, offset: "number", calendar: { day_seconds: "int", year_days: "int" } } },
        output: "system time + optional world calendar" },
      { name: "register-instant", method: "POST", path: "/v1/instants", desc: "Register a reference instant I* (the current instant, or a given value) → get a shareable id. THE multi-agent primitive: another agent GETs that id and aligns on the exact same instant.",
        input: { value: "string? (default: now)", encoding: "unix_s|…?", timescale: "utc?", label: "string?", meta: "object?" }, output: "instant_id + retrieve URL + all encodings/timescales" },
      { name: "get-instant", method: "GET", path: "/v1/instant/{id}", desc: "Retrieve a registered instant by id — aligns you on the same I* another agent registered.",
        input: { id: "ctcl:instant:… or bare uuid" }, output: "instant record + all encodings/timescales" },
      { name: "create-system", method: "POST", path: "/v1/systems", desc: "Persist a custom linear-rate time system (game world / accelerated sim / child clock) for reuse.",
        input: { id: "user:game_world", parent: "ctcl:system:unix", epoch: { parent_value: "unix_s" }, rate: { value: "number" }, offset: "number?", calendar: { day_seconds: "int", year_days: "int" } }, output: "system record + /now URL" },
      { name: "get-system", method: "GET", path: "/v1/systems/{id}", desc: "Retrieve a stored system definition.", input: { id: "string" }, output: "system record" },
      { name: "system-now", method: "GET", path: "/v1/systems/{id}/now", desc: "Current time in a stored custom system (+ world calendar).", input: { id: "string" }, output: "system_time + reference instant + calendar" },
      { name: "list-systems", method: "GET", path: "/v1/systems", desc: "List all stored custom systems.", input: {}, output: "system ids" },
      { name: "transform-path", method: "GET", path: "/v1/path", desc: "Route between two systems/timescales in the transform graph (§13-14; star graph today).", input: { from: "system id or unix|utc|posix", to: "…" }, output: "path + hops + lossless" },
      { name: "validate", method: "POST", path: "/v1/validate", desc: "Validate a time value; returns warnings (POSIX-vs-UTC leap drift, out-of-range).", input: { value: "string", encoding: "unix_s|…", timescale: "utc|posix?" }, output: "valid + warnings + canonical_unix_ns" },
      { name: "transform-types", method: "GET", path: "/v1/transforms", desc: "Catalog of transform types (§12): identity, offset, linear_rate, piecewise, paused_clock (active-time), …", input: {}, output: "types + which are implemented" },
      { name: "version", method: "GET", path: "/v1/version", desc: "Versions, leap table, precision tiers (§35), trust tiers (§36), rate-limit policy (§38).", input: {}, output: "versions + tiers" },
    ],
    memory_contract: "For long-term memory: store instant_id + timescale + encoding + source_quality (do not store only a bare number). Distinguish event / write / recall instants (§10.4, §23).",
    not_a: ["universal clock authority", "timing/NTP replacement", "guaranteed ns-accurate global sync"],
    whitepaper: "CTCL_Agent_Time_API v0.1 (Neo.K / EveMissLab)",
  };
}

function openapi(origin) {
  return {
    openapi: "3.0.0",
    info: { title: "CTCL — Common Temporal Coordinate Layer", version: "0.1",
      description: "Reference + transformation layer for agents. MVP." },
    servers: [{ url: origin }],
    paths: {
      "/v1/now": { get: { summary: "Verified reference instant", responses: { 200: { description: "instant envelope" } } } },
      "/v1/version": { get: { summary: "Versions, precision & trust tiers (§17/§35/§36)", responses: { 200: { description: "ok" } } } },
      "/v1/timescales": { get: { summary: "List timescales", responses: { 200: { description: "ok" } } } },
      "/v1/encodings": { get: { summary: "List encodings", responses: { 200: { description: "ok" } } } },
      "/v1/convert": { post: { summary: "Convert time value", responses: { 200: { description: "ok" }, 400: { description: "error" } } } },
      "/v1/transform": { post: { summary: "Map into a custom linear-rate system", responses: { 200: { description: "ok" } } } },
      "/v1/instants": { post: { summary: "Register a reference instant (multi-agent I*)", responses: { 200: { description: "ok" }, 503: { description: "registry unavailable" } } } },
      "/v1/instant/{id}": { get: { summary: "Retrieve a registered instant", responses: { 200: { description: "ok" }, 404: { description: "unknown instant" } } } },
      "/v1/systems": { get: { summary: "List custom systems", responses: { 200: { description: "ok" } } }, post: { summary: "Create a persistent custom system", responses: { 200: { description: "ok" } } } },
      "/v1/systems/{id}": { get: { summary: "Get a system definition", responses: { 200: { description: "ok" }, 404: { description: "unknown system" } } } },
      "/v1/systems/{id}/now": { get: { summary: "Current time in a custom system", responses: { 200: { description: "ok" } } } },
      "/v1/path": { get: { summary: "Transform-graph route between two systems/timescales (§13-14)", responses: { 200: { description: "ok" }, 404: { description: "unknown node" } } } },
      "/v1/validate": { post: { summary: "Validate a time object (§41)", responses: { 200: { description: "ok" } } } },
      "/v1/transforms": { get: { summary: "Transform-type catalog (§12)", responses: { 200: { description: "ok" } } } },
      "/v1/transforms/{id}": { get: { summary: "A transform type's spec", responses: { 200: { description: "ok" }, 404: { description: "unknown" } } } },
    },
  };
}

// ---- §23/§24/§26/§52 client SDK (served at /sdk.js) ------------------------
// The reference client (§44-47) made real, plus memory + life-history + task helpers.
// ESM: import { CTCL } from '<origin>/sdk.js'
function sdkSource(origin) {
  return `// CTCL client SDK — ${origin}/sdk.js  (Neo.K / EveMissLab)
// A verified reference instant + heterogeneous time transformation for agents.
// ESM:  import { CTCL } from '${origin}/sdk.js';  const t = CTCL(); await t.now();
export function CTCL(base = '${origin}') {
  const B = String(base).replace(/\\/$/, '');
  const j = async (p, opt) => (await fetch(B + p, opt)).json();
  const D = (r) => { if (r && r.ok) return r.data; throw Object.assign(new Error((r && r.error && r.error.code) || 'ctcl_error'), { ctcl: r }); };
  const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return {
    // core
    now:        async () => D(await j('/v1/now')),
    version:    async () => D(await j('/v1/version')),
    timescales: async () => D(await j('/v1/timescales')),
    encodings:  async () => D(await j('/v1/encodings')),
    transforms: async () => D(await j('/v1/transforms')),
    validate:   async (value, encoding, timescale) => D(await post('/v1/validate', { value, encoding, timescale })),
    // convert: precision-preserving; pass output.timezone for local civil time.
    convert:    async (input, output) => D(await post('/v1/convert', { input, output })),
    transform:  async (value, system, value_encoding = 'unix_s') => D(await post('/v1/transform', { value, value_encoding, system })),
    path:       async (from, to) => D(await j('/v1/path?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to))),

    // shared reference instant — multi-agent alignment (§27). Store the id in memory,
    // never a bare number; any agent (or your next session) getInstant(id) aligns exactly.
    registerInstant: async (opts = {}) => D(await post('/v1/instants', opts)),
    getInstant:      async (id) => D(await j('/v1/instant/' + encodeURIComponent(id))),

    // persistent custom systems / world clocks (§11)
    createSystem: async (def) => D(await post('/v1/systems', def)),
    systemNow:    async (id) => D(await j('/v1/systems/' + encodeURIComponent(id) + '/now')),
    listSystems:  async () => D(await j('/v1/systems')),

    // ---- §23 long-term memory: stamp an entry with verified instants ----------
    // Returns a record to STORE VERBATIM; separates event / write / recall time (§10.4).
    stampMemory: async (content, eventInstantId) => {
      const w = D(await post('/v1/instants', { label: 'memory:write' }));
      let e = w;
      if (eventInstantId) e = D(await j('/v1/instant/' + encodeURIComponent(eventInstantId)));
      return { content, event_instant: e.id, event_unix_ns: e.unix_ns,
               written_instant: w.id, written_unix_ns: w.unix_ns, recalled_instant: null };
    },
    recall: async (memory) => {
      const r = D(await post('/v1/instants', { label: 'memory:recall' }));
      return Object.assign({}, memory, { recalled_instant: r.id, recalled_unix_ns: r.unix_ns });
    },

    // ---- §24 life-history clock: a paused system whose ACTIVE time = experienced time --
    // pauses = [{from: unix_s, to: unix_s|null}] are suspensions. lifeNow() then gives
    // wall_elapsed_s / active_elapsed_s / paused_elapsed_s / currently_paused.
    lifeHistory: async (agentId, originUnixS, pauses = []) =>
      D(await post('/v1/systems', { id: 'agent:' + agentId + ':life',
        epoch: { parent_value: String(originUnixS) }, rate: { type: 'paused', value: 1, pauses } })),
    lifeNow: async (agentId) => D(await j('/v1/systems/' + encodeURIComponent('agent:' + agentId + ':life') + '/now')),

    // ---- §26 task clock: created / started / deadline / completed as shared instants --
    taskClock: async (taskId) => {
      const c = D(await post('/v1/instants', { label: 'task:' + taskId + ':created' }));
      return { task_id: taskId, created: c.id, created_unix_ns: c.unix_ns, started: null, deadline: null, completed: null };
    },
  };
}
export default CTCL;
`;
}

// ---- router ----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const origin = url.origin;
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (p === "/v1/now") return ok(nowEnvelope(), { server_observed_at: new Date().toISOString() }, "no-store");
    if (p === "/v1/version") return versionInfo();
    if (p === "/v1/timescales") return ok({ timescales: [
      { id: "utc", type: "reference", note: "Civil reference; includes leap seconds." },
      { id: "posix", type: "encoding", note: "Unix time; POSIX ignores leap seconds." },
      { id: "tai", type: "reference", note: `Atomic; ≈ UTC + ${LEAP.tai_minus_utc_s}s (${LEAP.as_of}). Offset caveat applies.` },
      { id: "gps", type: "reference", note: `≈ UTC + ${LEAP.gps_minus_utc_s}s (${LEAP.as_of}). Offset caveat applies.` },
    ], leap_table: LEAP });
    if (p === "/v1/encodings") return ok({ encodings: [
      "unix_s", "unix_ms", "unix_us", "unix_ns", "rfc3339", "iso8601",
    ], note: "convert preserves caller-supplied precision via BigInt nanoseconds." });
    if (p === "/v1/convert" && request.method === "POST") return handleConvert(request);
    if (p === "/v1/transform" && request.method === "POST") return handleTransform(request);
    if (p === "/v1/instants" && request.method === "POST") return registerInstant(request, env);
    if (p.startsWith("/v1/instant/")) return getInstant(decodeURIComponent(p.slice(12)), env);
    if (p === "/v1/systems" && request.method === "POST") return createSystem(request, env);
    if (p === "/v1/systems" && request.method === "GET") return listSystems(env);
    if (p.startsWith("/v1/systems/")) {
      const rest = decodeURIComponent(p.slice(12));
      if (rest.endsWith("/now")) return systemNow(rest.slice(0, -4), env);
      return getSystem(rest, env);
    }
    if (p === "/v1/path") return transformPath(url, env);
    if (p === "/v1/validate" && request.method === "POST") return validateTime(request);
    if (p === "/v1/transforms") return transformsCatalog(null);
    if (p.startsWith("/v1/transforms/")) return transformsCatalog(decodeURIComponent(p.slice(15)));
    if (p === "/openapi.json") return jsonResp(openapi(origin));
    if (p === "/ai/ctcl.json" || p === "/.well-known/ctcl.json") return jsonResp(toolDeclaration(origin), 200, "public, max-age=600");
    if (p === "/sdk.js" || p === "/client.js") return new Response(sdkSource(origin), { headers: { "Content-Type": "text/javascript; charset=utf-8", ...CORS, "Cache-Control": "public, max-age=3600" } });
    if (p === "/" || p === "/index.html") return new Response(page(origin, (request.cf && request.cf.country) || ""), { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });

    return fail("NOT_FOUND", `no route: ${p}`, { try: ["/v1/now", "/ai/ctcl.json", "/"] }, 404);
  },
};

// ---- human page ------------------------------------------------------------

function page(origin, country) {
  const zhRegion = ["TW", "HK", "MO", "CN", "SG"].includes(country) ? "1" : "0";
  return `<!doctype html><html lang="en" data-region-zh="${zhRegion}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CTCL · The Common Instant — a shared reference for agents</title>
<meta name="description" content="CTCL (Common Temporal Coordinate Layer): a verified reference instant + heterogeneous time transformation for agents. Same instant, different representations. commoninstant.org">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,380;9..144,560;9..144,680&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<script>(function(){try{var d=document.documentElement;var t=localStorage.getItem('ctcl.theme');if(!t)t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';d.setAttribute('data-theme',t);var l=localStorage.getItem('ctcl.lang')||(d.getAttribute('data-region-zh')==='1'?'zh':'en');d.setAttribute('data-lang',l);}catch(e){}})();</script>
<style>
:root{--bg:#14100a;--bg2:#1a150d;--surf:#1e190f;--surf2:#26200f;--ink:#ece3d0;--dim:#b6ab90;--faint:#7d7259;--gold:#cda24f;--gold2:#e7c884;--line:#2c2515;--line2:#3a3220;--sel:#3a2f16;--serif:'Fraunces',Georgia,serif;--mono:'JetBrains Mono',ui-monospace,'SF Mono',Consolas,monospace;--sans:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif}
[data-theme=light]{--bg:#f4eddc;--bg2:#efe6d0;--surf:#fbf6ea;--surf2:#f4ecd9;--ink:#241d11;--dim:#5e5540;--faint:#897b60;--gold:#8c6c1c;--gold2:#a9862a;--line:#e3d7bd;--line2:#d4c5a3;--sel:#efe0bd}
[data-theme=spacetime]{--bg:#070510;--bg2:#0d0918;--surf:rgba(26,19,34,.5);--surf2:rgba(34,25,44,.55);--ink:#efe6d4;--dim:#c4b9a3;--faint:#8b8071;--gold:#e6b955;--gold2:#ffdb92;--line:rgba(126,100,60,.34);--line2:rgba(160,128,74,.46);--sel:#2a2016}
*{margin:0;padding:0;box-sizing:border-box}::selection{background:var(--sel)}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--ink);font:16px/1.66 var(--sans);-webkit-font-smoothing:antialiased;position:relative;overflow-x:hidden;transition:background .5s,color .4s}
body::before{content:"";position:fixed;inset:0;z-index:-2;background:radial-gradient(115% 75% at 82% -8%,color-mix(in oklab,var(--gold) 11%,transparent),transparent 58%),var(--bg2);opacity:.75;transition:opacity .5s}
[data-theme=spacetime] body::before{opacity:0}
.wrap{max-width:940px;margin:0 auto;padding:clamp(1.3rem,4vw,3rem) clamp(1.2rem,4vw,3rem) 4rem}
a{color:var(--gold);text-underline-offset:3px}
h1,h2,h3{font-family:var(--serif);font-weight:560;letter-spacing:-.01em;line-height:1.12}
.eyebrow{font:500 .7rem/1 var(--mono);letter-spacing:.26em;text-transform:uppercase;color:var(--faint)}
.mono{font-family:var(--mono)}
/* top bar */
.top{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding-top:.4rem}
.brand{font:600 .82rem/1 var(--mono);letter-spacing:.06em;color:var(--dim);display:flex;align-items:center;gap:.55rem}
.brand .dot{width:.5rem;height:.5rem;border-radius:50%;background:var(--gold);box-shadow:0 0 12px var(--gold)}
.icon-btn{display:inline-grid;place-items:center;width:40px;height:40px;border-radius:.5rem;border:1px solid var(--line);background:var(--surf);color:var(--dim);cursor:pointer;transition:color .2s,border-color .2s,background .2s}
.icon-btn:hover{color:var(--gold);border-color:var(--line2)}
.icon-btn svg{width:20px;height:20px}
.tools{display:flex;gap:.5rem;align-items:center}
.icon-btn.lang{width:auto;padding:0 .6rem;gap:.36rem;font:600 .72rem/1 var(--mono);letter-spacing:.04em}
.icon-btn.lang svg{width:17px;height:17px}
/* hero */
.hero{display:grid;grid-template-columns:1.15fr .85fr;gap:clamp(1.5rem,4vw,3rem);align-items:center;margin:clamp(2rem,6vw,3.6rem) 0 1rem}
h1{font-size:clamp(2.1rem,6vw,3.4rem);font-weight:680;margin:.7rem 0 .5rem}
h1 em{font-style:italic;color:var(--gold)}
.lede{color:var(--dim);font-size:1.06rem;max-width:44ch;margin:.6rem 0 1.4rem}
.cta{display:flex;gap:.6rem;flex-wrap:wrap}
.btn{font:600 .9rem/1 var(--sans);border-radius:.5rem;padding:.7rem 1.1rem;cursor:pointer;border:1px solid var(--line2);transition:transform .12s,background .2s,color .2s,border-color .2s;text-decoration:none;display:inline-flex;align-items:center;gap:.45rem}
.btn.pri{background:var(--gold);color:#1a1408;border-color:var(--gold)}
.btn.pri:hover{background:var(--gold2)}
.btn.sec{background:transparent;color:var(--ink)}
.btn.sec:hover{border-color:var(--gold);color:var(--gold)}
.btn:active{transform:translateY(1px)}
/* instant panel */
.instant{border:1px solid var(--line);border-radius:.9rem;background:var(--surf);padding:1.2rem 1.3rem;position:relative;overflow:hidden}
.clockface{display:block;margin:.1rem auto .9rem;width:132px;height:132px}
.i-row{display:flex;justify-content:space-between;gap:.8rem;font-family:var(--mono);font-size:.78rem;padding:.24rem 0;border-top:1px solid var(--line)}
.i-row:first-of-type{border-top:0}
.i-row .k{color:var(--faint);white-space:nowrap}
.i-row .v{color:var(--gold);text-align:right;word-break:break-all}
.i-big{font-family:var(--mono);font-size:1.02rem;color:var(--ink);text-align:center;margin:.2rem 0 .7rem;font-weight:500}
.drift{text-align:center;font:500 .74rem/1.4 var(--mono);color:var(--faint);margin-top:.7rem}
.drift b{color:var(--gold)}
/* sections */
section{margin-top:clamp(2.6rem,7vw,4.2rem)}
.label{font:500 .7rem/1 var(--mono);letter-spacing:.22em;text-transform:uppercase;color:var(--faint);margin-bottom:1rem;display:flex;align-items:center;gap:.7rem}
.label::after{content:"";flex:1;height:1px;background:var(--line)}
h2{font-size:clamp(1.4rem,3.4vw,1.9rem)}
.concept{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1.1rem;margin-top:1.3rem}
.concept .c{border-left:2px solid var(--gold);padding:.1rem 0 .1rem 1rem}
.concept .c h3{font-size:1.05rem;margin-bottom:.35rem}
.concept .c p{color:var(--dim);font-size:.92rem;margin:0}
/* endpoints */
.eps{margin-top:1.2rem;border:1px solid var(--line);border-radius:.7rem;overflow:hidden;background:var(--surf)}
.ep{display:grid;grid-template-columns:56px minmax(0,1.1fr) 1.4fr;gap:.9rem;align-items:baseline;padding:.72rem 1rem;border-top:1px solid var(--line);transition:background .18s}
.ep:first-child{border-top:0}.ep:hover{background:var(--surf2)}
.ep .m{font:700 .66rem/1.4 var(--mono);letter-spacing:.06em;color:var(--gold)}
.ep .path{font-family:var(--mono);font-size:.84rem;color:var(--ink);word-break:break-all}
.ep .d{font-size:.84rem;color:var(--dim)}
/* code + playground */
pre{font-family:var(--mono);font-size:.82rem;line-height:1.6;background:var(--surf);border:1px solid var(--line);border-radius:.6rem;padding:1rem 1.1rem;overflow-x:auto;margin:.9rem 0;color:var(--ink)}
code{font-family:var(--mono);font-size:.9em;background:var(--surf2);padding:.1em .4em;border-radius:4px}
p{color:var(--dim);margin:.8rem 0;max-width:64ch}
.pg{display:flex;gap:.55rem;flex-wrap:wrap;align-items:center;margin:.8rem 0}
.pg input{font-family:var(--mono);font-size:.85rem;background:var(--bg);border:1px solid var(--line2);color:var(--ink);border-radius:.45rem;padding:.55rem .7rem}
#pv{width:200px}#ptz{width:150px}
footer{margin-top:4rem;padding-top:1.4rem;border-top:1px solid var(--line);color:var(--faint);font-size:.82rem;line-height:1.9}
footer a{color:var(--dim)}
/* settings panel */
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);opacity:0;pointer-events:none;transition:opacity .25s;z-index:40}
.scrim.open{opacity:1;pointer-events:auto}
.panel{position:fixed;top:0;right:0;height:100%;width:min(340px,88vw);background:var(--bg);border-left:1px solid var(--line2);transform:translateX(100%);transition:transform .3s cubic-bezier(.4,0,.2,1);z-index:50;padding:1.4rem;overflow-y:auto}
.panel.open{transform:none}
.panel h3{font-family:var(--serif);font-size:1.3rem;margin-bottom:.2rem}
.panel .sub{color:var(--faint);font-size:.8rem;margin-bottom:1.6rem}
.set{margin-bottom:1.7rem}
.set>.t{font:600 .72rem/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin-bottom:.7rem}
.seg{display:flex;border:1px solid var(--line2);border-radius:.5rem;overflow:hidden}
.seg button{flex:1;font:500 .86rem/1 var(--sans);background:transparent;color:var(--dim);border:0;padding:.6rem .4rem;cursor:pointer;transition:background .18s,color .18s;display:flex;align-items:center;justify-content:center;gap:.4rem}
.seg button+button{border-left:1px solid var(--line2)}
.seg button[aria-pressed=true]{background:var(--gold);color:#1a1408}
.seg button svg{width:15px;height:15px}
.exp{border:1px dashed var(--line2);border-radius:.6rem;padding:.9rem 1rem}
.exp .row{display:flex;justify-content:space-between;align-items:center;gap:.8rem}
.exp .name{font-weight:600;font-size:.94rem;display:flex;align-items:center;gap:.5rem}
.exp .tag{font:600 .58rem/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--gold);border:1px solid var(--line2);border-radius:99px;padding:.2rem .45rem}
.exp p{font-size:.8rem;color:var(--faint);margin:.6rem 0 0}
.sw{position:relative;width:46px;height:26px;border-radius:99px;background:var(--line2);border:0;cursor:pointer;transition:background .2s;flex:none}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:var(--ink);transition:transform .2s}
.sw[aria-pressed=true]{background:var(--gold)}
.sw[aria-pressed=true]::after{transform:translateX(20px);background:#1a1408}
/* i18n: hide the non-active language copy that lives in [data-zh] via JS swap; nothing needed here */
/* spacetime background */
#st{position:fixed;inset:0;z-index:-1;opacity:0;pointer-events:none;transition:opacity .8s}
[data-theme=spacetime] #st{opacity:1}
[data-theme=spacetime] .instant{backdrop-filter:blur(3px)}
.gear{transform-origin:center;animation:spin 60s linear infinite}
.gear.r{animation-duration:38s;animation-direction:reverse}
.gear.s{animation-duration:22s}
@keyframes spin{to{transform:rotate(360deg)}}
:focus-visible{outline:2px solid var(--gold);outline-offset:2px;border-radius:3px}
@media (max-width:720px){.hero{grid-template-columns:1fr}.ep{grid-template-columns:48px 1fr;row-gap:.2rem}.ep .d{grid-column:1/-1;color:var(--faint)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style></head><body>

<svg id="st" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
 <defs>
  <radialGradient id="hole" cx="50%" cy="42%" r="55%">
   <stop offset="0%" stop-color="#000"/><stop offset="34%" stop-color="#000"/>
   <stop offset="46%" stop-color="#4a2e0a"/><stop offset="55%" stop-color="#e6b955"/>
   <stop offset="63%" stop-color="#7a4a12"/><stop offset="100%" stop-color="transparent"/>
  </radialGradient>
  <filter id="warp"><feTurbulence type="fractalNoise" baseFrequency="0.006 0.012" numOctaves="2" seed="7" result="n"/>
   <feDisplacementMap in="SourceGraphic" in2="n" scale="60" xChannelSelector="R" yChannelSelector="G"/></filter>
  <g id="g1"><circle r="86" fill="none" stroke="rgba(230,185,85,.5)" stroke-width="7"/>
   <circle r="30" fill="none" stroke="rgba(230,185,85,.4)" stroke-width="5"/>
   <g stroke="rgba(230,185,85,.55)" stroke-width="13" stroke-linecap="round">
   <line y1="82" y2="104"/><line y1="-82" y2="-104"/><line x1="82" x2="104"/><line x1="-82" x2="-104"/>
   <line x1="58" y1="58" x2="74" y2="74"/><line x1="-58" y1="58" x2="-74" y2="74"/>
   <line x1="58" y1="-58" x2="74" y2="-74"/><line x1="-58" y1="-58" x2="-74" y2="-74"/></g></g>
 </defs>
 <g filter="url(#warp)" opacity="0.5" stroke="rgba(150,120,80,.16)" stroke-width="1.4">
  <path d="M0 200H1000M0 400H1000M0 600H1000M0 800H1000M200 0V1000M400 0V1000M600 0V1000M800 0V1000"/>
 </g>
 <circle cx="500" cy="420" r="540" fill="url(#hole)" opacity="0.9"/>
 <use href="#g1" class="gear" x="0" y="0" transform="translate(120 830) scale(.85)"/>
 <use href="#g1" class="gear r" transform="translate(910 200) scale(.6)"/>
 <use href="#g1" class="gear s" transform="translate(880 880) scale(.42)"/>
</svg>

<div class="wrap">
 <div class="top">
  <div class="brand"><span class="dot"></span>CTCL · commoninstant.org</div>
  <div class="tools">
   <button class="icon-btn lang" id="langBtn" aria-label="Language / 語言" title="Language"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"/></svg><span id="langLabel">EN</span></button>
   <button class="icon-btn" id="gear" aria-label="Settings" aria-haspopup="dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg></button>
  </div>
 </div>

 <div class="hero">
  <div>
   <div class="eyebrow" data-zh="EveMissLab · Agent 時間基礎設施">EveMissLab · Agent time infrastructure</div>
   <h1 data-zh="一個<em>共同瞬間</em>，各自的時間世界。">One <em>shared instant</em>, every local time.</h1>
   <p class="lede" data-zh="CTCL 給異質的 agent、模擬器與持續存在的 AI 一個驗證過的共同參考瞬間 —— 不用共用時鐘、曆法或 epoch。同一瞬間，不同表示。">CTCL gives heterogeneous agents, simulators and persistent AI a verified common reference instant — without sharing a clock, calendar, or epoch. Same instant, different representations.</p>
   <div class="cta">
    <a class="btn pri" href="/v1/now" target="_blank" rel="noopener" data-zh="取得驗證瞬間 →">Get a verified instant →</a>
    <a class="btn sec" href="/ai/ctcl.json" data-zh="Agent 工具宣告">Agent tool declaration</a>
   </div>
  </div>
  <div class="instant" role="group" aria-label="Live reference instant">
   <svg class="clockface" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="47" fill="none" stroke="var(--line2)" stroke-width="1.5"/>
    <g id="ticks" stroke="var(--faint)" stroke-width="1.4"></g>
    <line id="hh" x1="50" y1="50" x2="50" y2="28" stroke="var(--ink)" stroke-width="2.6" stroke-linecap="round"/>
    <line id="mh" x1="50" y1="50" x2="50" y2="18" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"/>
    <line id="sh" x1="50" y1="55" x2="50" y2="12" stroke="var(--gold)" stroke-width="1.1" stroke-linecap="round"/>
    <circle cx="50" cy="50" r="2.2" fill="var(--gold)"/>
   </svg>
   <div class="i-big" id="c-utc">…</div>
   <div class="i-row"><span class="k">unix_ns</span><span class="v mono" id="c-ns">…</span></div>
   <div class="i-row"><span class="k">instant_id</span><span class="v mono" id="c-id">…</span></div>
   <div class="i-row"><span class="k" data-zh="來源 · 精度">source · precision</span><span class="v" data-zh="邊緣時鐘 · 毫秒級">edge clock · ms</span></div>
   <div class="drift" id="c-drift" data-zh="對齊你的瀏覽器時鐘…">aligning with your browser clock…</div>
  </div>
 </div>

 <section>
  <div class="label" data-zh="它是什麼">What it is</div>
  <div class="concept">
   <div class="c"><h3 data-zh="共同參考瞬間 I*">A common instant I*</h3><p data-zh="一個可被多方共同指向的驗證瞬間，帶來源與不確定度 —— 不是形而上的絕對時間，是協議上的共同參考。">A verified instant many parties can point at, with source and uncertainty — not a metaphysical absolute time, a protocol-level shared reference.</p></div>
   <div class="c"><h3 data-zh="顯式轉換">Explicit transforms</h3><p data-zh="Unix、UTC、時區、自定義倍速世界時間之間可保精度轉換。不同時鐘、顯式轉換、無隱藏語義。">Precision-preserving conversion across Unix, UTC, timezones and custom world clocks. Different clocks, explicit transforms, no hidden semantics.</p></div>
   <div class="c"><h3 data-zh="誠實的精度">Honest precision</h3><p data-zh="這個邊緣時鐘是毫秒級，我們就標毫秒級。ns 欄位是格式相容用的補零，precision ≠ accuracy。">The edge clock is millisecond-grade, so we say so. The ns fields are format-padding; precision is not accuracy.</p></div>
  </div>
 </section>

 <section>
  <div class="label">Endpoints</div>
  <div class="eps">
   <div class="ep"><span class="m">GET</span><span class="path">/v1/now</span><span class="d" data-zh="驗證參考瞬間（來源、不確定度、instant_id）">verified reference instant (source, uncertainty, instant_id)</span></div>
   <div class="ep"><span class="m">POST</span><span class="path">/v1/convert</span><span class="d" data-zh="跨編碼／時標／時區轉換（保精度）">convert across encodings / timescales / timezones (precision-preserving)</span></div>
   <div class="ep"><span class="m">POST</span><span class="path">/v1/transform</span><span class="d" data-zh="映射到自定義倍速世界時間">map into a custom linear-rate world clock</span></div>
   <div class="ep"><span class="m">POST</span><span class="path">/v1/instants</span><span class="d" data-zh="登記共同瞬間 I*，回可共享 id（多 agent 對齊）">register I*, get a shareable id (multi-agent alignment)</span></div>
   <div class="ep"><span class="m">GET</span><span class="path">/v1/instant/{id}</span><span class="d" data-zh="取回別的 agent 登記的同一瞬間">retrieve the exact instant another agent registered</span></div>
   <div class="ep"><span class="m">POST</span><span class="path">/v1/systems</span><span class="d" data-zh="建立持久自定義世界時鐘">persist a custom world clock</span></div>
   <div class="ep"><span class="m">GET</span><span class="path">/v1/systems/{id}/now</span><span class="d" data-zh="該世界當前時間＋世界曆">current time in that world + world calendar</span></div>
   <div class="ep"><span class="m">GET</span><span class="path">/ai/ctcl.json</span><span class="d" data-zh="agent 工具宣告 —— 先讀這個">agent tool declaration — read this first</span></div>
  </div>
 </section>

 <section>
  <div class="label" data-zh="Agent 怎麼調用">Calling it</div>
  <p data-zh="Agent 先讀 <code>/ai/ctcl.json</code> 發現能力，再呼叫端點。取得一個驗證瞬間：">An agent reads <code>/ai/ctcl.json</code> to discover the API, then calls the endpoints. Get a verified instant:</p>
  <pre>curl -s ${origin}/v1/now</pre>
  <p data-zh="登記一個共同瞬間，讓另一個 agent（或你下一個 session）對齊到分毫不差的同一點：">Register a shared instant so another agent (or your next session) can align on the exact same point:</p>
  <pre>curl -s ${origin}/v1/instants -H 'content-type: application/json' -d '{"label":"handoff"}'
# -> { "id": "ctcl:instant:…" }   then any agent:
curl -s ${origin}/v1/instant/ctcl:instant:…</pre>
  <p data-zh="把一個 Unix 奈秒值轉成台北時間（保精度）：">Convert a Unix nanosecond value into Taipei time (precision preserved):</p>
  <pre>curl -s ${origin}/v1/convert -H 'content-type: application/json' -d '{
  "input":  {"value":"1783420000.123456789","encoding":"unix_s"},
  "output": {"encoding":"rfc3339","timezone":"Asia/Taipei"}
}'</pre>
 </section>

 <section>
  <div class="label">Playground</div>
  <p data-zh="把一個 Unix 秒值轉成某時區的 RFC3339。">Convert a Unix-seconds value into an RFC3339 timestamp for a timezone.</p>
  <div class="pg">
   <label class="mono" style="color:var(--faint);font-size:.75rem">unix_s <input id="pv" value="1783420000.5" aria-label="Unix seconds value"></label>
   <label class="mono" style="color:var(--faint);font-size:.75rem">tz <input id="ptz" value="Asia/Taipei" aria-label="IANA timezone"></label>
   <button class="btn pri" id="pgo" data-zh="轉換 →">convert →</button>
  </div>
  <pre id="pout">…</pre>
 </section>

 <footer>
  <span data-zh="CTCL v0.1 · 參考＋轉換層，不是授時機構。">CTCL v0.1 · a reference + transformation layer, not a timing authority.</span><br>
  <a href="/sdk.js">JS SDK</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/ai/ctcl.json">tool declaration</a> · <a href="/v1/version">version</a> · Neo.K / 一言諾科技有限公司 · EveMissLab
 </footer>
</div>

<div class="scrim" id="scrim"></div>
<aside class="panel" id="panel" role="dialog" aria-modal="true" aria-label="Settings">
 <h3 data-zh="設置">Settings</h3>
 <div class="sub" data-zh="偏好會存在這個瀏覽器。">Preferences are stored in this browser.</div>
 <div class="set">
  <div class="t" data-zh="外觀">Appearance</div>
  <div class="seg" id="segTheme">
   <button data-v="light" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg><span data-zh="明亮">Light</span></button>
   <button data-v="dark" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 14.5A8 8 0 019.5 4 7 7 0 1020 14.5z"/></svg><span data-zh="暗色">Dark</span></button>
  </div>
 </div>
 <div class="set">
  <div class="t" data-zh="實驗功能">Experimental</div>
  <div class="exp">
   <div class="row">
    <span class="name"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 3c-4 4-4 14 0 18M12 3c4 4 4 14 0 18M3 12h18"/></svg>Spacetime</span>
    <button class="sw" id="stSw" role="switch" aria-pressed="false" aria-label="Toggle Spacetime theme"></button>
   </div>
   <p data-zh="把暖墨金世界交給重力 —— 黑洞、齒輪，指針由即時的 CTCL 時間驅動。實驗中。">Hands the warm-ink world to gravity — a black hole, clockwork, hands driven by the live CTCL time. Work in progress.</p>
  </div>
 </div>
</aside>

<script>
var O=location.origin,D=document.documentElement;
function $(i){return document.getElementById(i)}
// i18n: swap [data-zh] elements between English (original innerHTML) and Chinese
var i18n=[].slice.call(document.querySelectorAll('[data-zh]'));
i18n.forEach(function(el){el.setAttribute('data-en',el.innerHTML)});
function applyLang(l){D.setAttribute('data-lang',l);document.documentElement.lang=(l==='zh'?'zh-Hant':'en');
 i18n.forEach(function(el){el.innerHTML=(l==='zh'?el.getAttribute('data-zh'):el.getAttribute('data-en'))});
 var lb=$('langLabel');if(lb)lb.textContent=(l==='zh'?'中':'EN')}
function applyTheme(t){D.setAttribute('data-theme',t);
 syncSeg('segTheme',t);$('stSw').setAttribute('aria-pressed',String(t==='spacetime'))}
function syncSeg(id,v){var s=$(id);if(!s)return;[].forEach.call(s.children,function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-v')===v))})}
// init from what the head script already resolved
applyLang(D.getAttribute('data-lang')||'en');
(function(){var t=D.getAttribute('data-theme')||'dark';syncSeg('segTheme',t==='spacetime'?'':t);$('stSw').setAttribute('aria-pressed',String(t==='spacetime'))})();
// settings wiring
$('langBtn').addEventListener('click',function(){var v=D.getAttribute('data-lang')==='zh'?'en':'zh';localStorage.setItem('ctcl.lang',v);applyLang(v)});
$('segTheme').addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var v=b.getAttribute('data-v');localStorage.setItem('ctcl.theme',v);applyTheme(v)});
$('stSw').addEventListener('click',function(){var on=D.getAttribute('data-theme')==='spacetime';var v=on?(localStorage.getItem('ctcl.prevTheme')||'dark'):'spacetime';if(!on)localStorage.setItem('ctcl.prevTheme',D.getAttribute('data-theme')||'dark');localStorage.setItem('ctcl.theme',v);applyTheme(v)});
// settings open/close
function openP(o){$('panel').classList.toggle('open',o);$('scrim').classList.toggle('open',o)}
$('gear').addEventListener('click',function(){openP(true)});
$('scrim').addEventListener('click',function(){openP(false)});
document.addEventListener('keydown',function(e){if(e.key==='Escape')openP(false)});
// clock ticks
(function(){var g=$('ticks'),s='';for(var i=0;i<12;i++){var a=i*30*Math.PI/180,x=50+Math.sin(a)*42,y=50-Math.cos(a)*42;s+='<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="'+(i%3?'0.9':'1.6')+'"/>'}g.innerHTML=s})();
// live instant
function setHands(ms){var d=new Date(ms),h=d.getUTCHours()%12,m=d.getUTCMinutes(),sec=d.getUTCSeconds()+d.getUTCMilliseconds()/1000;
 $('hh').setAttribute('transform','rotate('+((h+m/60)*30)+' 50 50)');
 $('mh').setAttribute('transform','rotate('+((m+sec/60)*6)+' 50 50)');
 $('sh').setAttribute('transform','rotate('+(sec*6)+' 50 50)')}
var lastSrv=0,lastAt=0;
async function tick(){try{
 var t0=performance.now();var r=await(await fetch(O+'/v1/now')).json();var rtt=performance.now()-t0;var d=r.data;
 $('c-utc').textContent=d.instant.reference.value;$('c-ns').textContent=d.encodings.unix_ns;$('c-id').textContent=d.instant.id;
 lastSrv=Number(d.encodings.unix_ms);lastAt=performance.now();setHands(lastSrv);
 var drift=Date.now()-lastSrv;
 $('c-drift').innerHTML=(D.getAttribute('data-lang')==='zh'?'你的時鐘與 CTCL 差 ':'your clock vs CTCL: ')+'<b>'+(drift>=0?'+':'')+drift+' ms</b> · RTT '+rtt.toFixed(0)+'ms';
}catch(e){$('c-utc').textContent='(offline)'}}
function frame(){if(lastSrv){setHands(lastSrv+(performance.now()-lastAt))}requestAnimationFrame(frame)}
tick();setInterval(tick,2000);requestAnimationFrame(frame);
// playground
async function tryConvert(){var body={input:{value:$('pv').value,encoding:'unix_s'},output:{encoding:'rfc3339',timezone:$('ptz').value}};
 try{var r=await(await fetch(O+'/v1/convert',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();$('pout').textContent=JSON.stringify(r.ok?r.data:r,null,2)}catch(e){$('pout').textContent=String(e)}}
$('pgo').addEventListener('click',tryConvert);
</script></body></html>`;
}
