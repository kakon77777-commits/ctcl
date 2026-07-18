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
// The LATEST known leap-second offset — used only for "current state" displays
// (/v1/version, /v1/now's policy.leap_table, the tai/gps tool-declaration notes).
// Per-instant TAI/GPS math below uses the full historical table instead, so a
// registered instant from any past date gets the offset that was actually true
// then, not today's offset applied retroactively.
const LEAP = { tai_minus_utc_s: 37, gps_minus_utc_s: 18, as_of: "2017-01-01",
  note: "Latest known offset, not a live/future-predicting leap table. No leap second has been declared since 2017-01-01 (IERS Bulletin C); verify for high-stakes/scientific use." };

// ---- §16/known_limitations: full leap-aware TAI/GPS conversion -------------
// Historical TAI-UTC offset (seconds), effective from 00:00 UTC on each listed
// date until superseded by the next entry. Source: IERS Bulletin C's historical
// record — this is settled, unchanging history (unlike future leap seconds,
// which nobody can predict; IERS announces those with only ~6 months' notice).
// The modern leap-second system starts 1972-01-01; earlier dates are clamped to
// the first entry rather than left undefined, since "give the closest known
// answer" is more useful than refusing pre-1972 conversions outright.
const LEAP_SECONDS_TABLE = [
  [Date.UTC(1972, 0, 1), 10], [Date.UTC(1972, 6, 1), 11], [Date.UTC(1973, 0, 1), 12],
  [Date.UTC(1974, 0, 1), 13], [Date.UTC(1975, 0, 1), 14], [Date.UTC(1976, 0, 1), 15],
  [Date.UTC(1977, 0, 1), 16], [Date.UTC(1978, 0, 1), 17], [Date.UTC(1979, 0, 1), 18],
  [Date.UTC(1980, 0, 1), 19], [Date.UTC(1981, 6, 1), 20], [Date.UTC(1982, 6, 1), 21],
  [Date.UTC(1983, 6, 1), 22], [Date.UTC(1985, 6, 1), 23], [Date.UTC(1988, 0, 1), 24],
  [Date.UTC(1990, 0, 1), 25], [Date.UTC(1991, 0, 1), 26], [Date.UTC(1992, 6, 1), 27],
  [Date.UTC(1993, 6, 1), 28], [Date.UTC(1994, 6, 1), 29], [Date.UTC(1996, 0, 1), 30],
  [Date.UTC(1997, 6, 1), 31], [Date.UTC(1999, 0, 1), 32], [Date.UTC(2006, 0, 1), 33],
  [Date.UTC(2009, 0, 1), 34], [Date.UTC(2012, 6, 1), 35], [Date.UTC(2015, 6, 1), 36],
  [Date.UTC(2017, 0, 1), 37],
].map(([ms, offset]) => [ms, offset]); // [effective_at_unix_ms, tai_minus_utc_seconds]

// GPS time was aligned to UTC at the GPS epoch (1980-01-06T00:00:00Z) and never
// observes leap seconds afterward, so GPS-TAI is fixed at -19s forever; GPS-UTC
// at any later instant is simply TAI-UTC(t) - 19. GPS didn't exist before its
// epoch, so pre-epoch instants return null rather than a fabricated offset.
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);

function taiMinusUtcAtMs(ms) {
  let offset = LEAP_SECONDS_TABLE[0][1];
  for (const [effAt, off] of LEAP_SECONDS_TABLE) { if (ms >= effAt) offset = off; else break; }
  return offset;
}
function gpsMinusUtcAtMs(ms) {
  return ms < GPS_EPOCH_MS ? null : taiMinusUtcAtMs(ms) - 19;
}

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
// tai_approx/gps_approx use the FULL historical leap-second table (see
// LEAP_SECONDS_TABLE above), not a flat current-day offset — a registered
// instant from 1990 gets 1990's true TAI-UTC offset (25s), not 2017's (37s).
// Still "_approx": representation precision is millisecond-grade (§16), and a
// future leap second not yet in the table would eventually make a post-2017
// instant's offset stale until the table is updated — nobody can predict those.
function instantViews(ns) {
  const iso = rfc3339(ns, "UTC");
  const ms = Number(ns / NS_PER.ms);
  const taiOffsetS = taiMinusUtcAtMs(ms);
  const gpsOffsetS = gpsMinusUtcAtMs(ms);
  return {
    encodings: {
      unix_s: fromNs(ns, "unix_s"), unix_ms: fromNs(ns, "unix_ms"),
      unix_us: fromNs(ns, "unix_us"), unix_ns: fromNs(ns, "unix_ns"), rfc3339: iso,
    },
    timescales: {
      utc: iso, posix: fromNs(ns, "unix_s"),
      tai_approx: fromNs(ns + BigInt(taiOffsetS) * NS_PER.s, "unix_s"),
      gps_approx: gpsOffsetS == null ? "not_applicable_before_gps_epoch_1980-01-06T00:00:00Z" : fromNs(ns + BigInt(gpsOffsetS) * NS_PER.s, "unix_s"),
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
  // §31: sign at registration time and persist the signature, so every future GET of
  // this instant (by any agent, in any later session) returns the same verifiable proof.
  const sig = await ed25519SignFields(env, rec.id, rec.unix_ns, rec.reference_timescale);
  if (sig) rec.signature = sig;
  await env.CTCL_KV.put("instant:" + uuidOf(id), JSON.stringify(rec));
  const origin = new URL(req.url).origin;
  return ok({ ...rec, retrieve: `/v1/instant/${id}`, share: `${origin}/i/${uuidOf(id)}`, ...instantViews(ns) },
    { note: "Registered. Any agent can GET /v1/instant/{id} to align on this exact instant (§27); humans can open `share` (§4.4). Store the id in memory, not a bare number." });
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
  const sig = await signSystemRecord(env, rec);
  if (sig) rec.signature = sig;
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

// §10.3 Trust/Status Panel runtime health — a live binding check, not a static claim.
async function runtimeHealth(env) {
  let kv = "unbound";
  if (env && env.CTCL_KV) {
    try { await env.CTCL_KV.get("status:healthcheck"); kv = "healthy"; }
    catch (e) { kv = "error: " + String((e && e.message) || e); }
  }
  const rateLimit = (env && env.API_RL) ? "enforced" : "unbound (rate limiting disabled)";
  const signKey = await getSignKey(env);
  return {
    instant_registry_kv: kv,
    rate_limiter: rateLimit,
    instant_signing: signKey ? `enabled (Ed25519, key_id ${KEY_ID})` : "disabled (CTCL_SIGN_KEY unset)",
    edge_wall_clock: "operational",
  };
}
const KNOWN_LIMITATIONS = [
  "custom_expression transform intentionally NOT implemented — arbitrary-expression eval is a security risk",
  "TAI/GPS use the full historical leap-second table (1972-2017) for any given instant, but cannot predict FUTURE leap seconds — none have been declared since 2017-01-01, but if one is, post-that-date conversions are stale until the table is updated; GPS is not applicable before its 1980-01-06 epoch",
  "rate limiting is per-colo approximate (Cloudflare's native limiter design), not a hard global per-key guarantee — that would need a Durable Object",
  "signing (§31/§31.1) covers /v1/now, registered instants, custom system definitions, and Temporal Groups — every persisted resource type is signed",
  "monotonic duration timing (§32), clock-rollback detection (§33), and offline degraded mode (§39) are implemented client-side in the SDK (monotonic/guardedNow/offlineNow) — the server itself does not track a client's local clock",
  "no source allowlist or app-level audit log (§31.1) — the API is read-only/query-only (nothing external is ingested to allowlist), and Cloudflare's platform request logs are the only request log today",
  "gpu_availability and simulation_state planner constraints require an external data feed this deployment does not have",
  "no CLI or webhook relay yet — REST, SDK, and the web playground are the only interfaces today",
  "Shared Workspaces (/v1/workspaces, Phase 5 Step 1) have NO accounts and NO access control — anyone who can reach this API can read/overwrite any workspace, same public-write model as every other resource; real role permissions would need actual accounts, deliberately not built",
];
function versionInfo(env) {
  return runtimeHealth(env).then((runtime) => ok({
    service: "CTCL", api_version: API_VERSION, release: "0.1",
    leap_table: LEAP, tzdb: "IANA via the runtime Intl database",
    source_precision: "millisecond_representation (edge wall clock)",
    precision_tiers: { coarse: ">= 1 s", standard: ">= 1 ms", high: ">= 1 µs (representation)", ultra: ">= 1 ns (representation)" },
    trust_tiers: { T0: "unknown", T1: "local, unsynchronized", T2: "network-synchronized", T3: "authenticated source", T4: "calibrated authoritative chain" },
    current_trust_tier: "T2",
    rate_limit_policy: { enforced: true, mechanism: "cloudflare-workers-ratelimit (approximate per CF design)", anonymous_per_min: 120, scope: "/v1/* per IP", note: "§38; every /v1/* call passes the native limiter (429 on reject) + edge/DDoS protection. Hard per-key guarantees would use a Durable Object. Contact licensing for higher tiers." },
    honesty: "precision is not accuracy; ns/us fields are format-padding on a millisecond source (§16).",
    runtime, known_limitations: KNOWN_LIMITATIONS,
  }, {}, "no-store"));
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

// ---- Temporal Groups (P1 — CommonInstant Web whitepaper §5.5/§8.1) ---------
// G = (id, members, owner, version). A member is "utc"|"posix"|"tai"|"gps"
// (builtin timescale), "tz:<IANA>" (civil local time), or a bare id already
// stored under system:<id> (custom/life-history system). Expanding ONE instant
// across a group's members is CTCL's flagship differentiator:
//   E(I*, G) = { tau_1, ..., tau_n }  — "One Instant, Many Systems".
const BUILTIN_TS = { utc: "utc", posix: "posix", tai: "tai_approx", gps: "gps_approx" };

async function resolveMember(member, ns, env) {
  const m = String(member);
  if (BUILTIN_TS[m]) {
    const v = instantViews(ns);
    return { member: m, kind: "builtin", value: v.timescales[BUILTIN_TS[m]], encoding: m === "utc" ? "rfc3339" : "unix_s" };
  }
  if (m.startsWith("tz:")) {
    const tz = m.slice(3);
    try { return { member: m, kind: "timezone", timezone: tz, value: rfc3339(ns, tz), encoding: "rfc3339" }; }
    catch (e) { return { member: m, kind: "timezone", error: "INVALID_TIMEZONE", message: `unrecognized IANA timezone: ${tz}` }; }
  }
  if (!env || !env.CTCL_KV) return { member: m, kind: "system", error: "REGISTRY_UNAVAILABLE" };
  const raw = await env.CTCL_KV.get("system:" + m);
  if (!raw) return { member: m, kind: "system", error: "UNKNOWN_SYSTEM", message: `no such system: ${m}` };
  const sys = JSON.parse(raw);
  let epochNs;
  try { epochNs = toNs(sys.epoch?.parent_value ?? 0, sys.epoch?.encoding || "unix_s"); }
  catch { epochNs = 0n; }
  const { local, extra } = localSeconds(sys, Number(ns) / 1e9, Number(epochNs) / 1e9);
  return { member: m, kind: "system", value: String(local), unit: "second", rate_type: (sys.rate && sys.rate.type) || "constant", ...extra };
}

async function createGroup(req, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  let body;
  try { body = await req.json(); } catch { return fail("INVALID_TIME_VALUE", "body must be JSON"); }
  const grp = body.group || body;
  if (!grp.id) return fail("INVALID_TIME_VALUE", "group.id required (e.g. group:project-alpha)");
  if (!Array.isArray(grp.members) || !grp.members.length) return fail("INVALID_TIME_VALUE", "group.members must be a non-empty array of \"utc\"|\"posix\"|\"tai\"|\"gps\"|\"tz:<IANA>\"|<system id>");
  const existingRaw = await env.CTCL_KV.get("group:" + grp.id);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;
  const rec = {
    id: grp.id, members: grp.members, owner: grp.owner || (existing && existing.owner) || null,
    version: String(existing ? Number(existing.version || "1") + 1 : 1),
    created_at: existing ? existing.created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const sig = await signGroupRecord(env, rec);
  if (sig) rec.signature = sig;
  await env.CTCL_KV.put("group:" + grp.id, JSON.stringify(rec));
  return ok({ ...rec, expand: `/v1/temporal-groups/${encodeURIComponent(grp.id)}/expand` },
    { note: "POST /v1/temporal-groups/{id}/expand to project one instant across every member (§5.5 \"One Instant, Many Systems\")." });
}

async function getGroup(id, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const raw = await env.CTCL_KV.get("group:" + id);
  if (!raw) return fail("UNKNOWN_GROUP", `no such group: ${id}`, {}, 404);
  return ok(JSON.parse(raw));
}

async function listGroups(env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const l = await env.CTCL_KV.list({ prefix: "group:" });
  const groups = l.keys.map((k) => k.name.replace(/^group:/, ""));
  return ok({ count: groups.length, groups, truncated: !l.list_complete,
    note: "GET /v1/temporal-groups/{id} for a definition; POST .../expand to project an instant across all members." });
}

async function expandGroup(id, req, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const raw = await env.CTCL_KV.get("group:" + id);
  if (!raw) return fail("UNKNOWN_GROUP", `no such group: ${id}`, {}, 404);
  const grp = JSON.parse(raw);
  let body = {};
  try { body = await req.json(); } catch { /* empty body -> expand "now" */ }
  let ns, source;
  if (body.instant_id) {
    const rawI = await env.CTCL_KV.get("instant:" + uuidOf(body.instant_id));
    if (!rawI) return fail("UNKNOWN_INSTANT", `no registered instant: ${body.instant_id}`, {}, 404);
    ns = BigInt(JSON.parse(rawI).unix_ns); source = "registered_instant";
  } else if (body.value != null) {
    try { ns = toNs(body.value, body.encoding); }
    catch (e) { return fail(e.code || "INVALID_TIME_VALUE", e.msg || String(e)); }
    source = "explicit_value";
  } else {
    ns = BigInt(Date.now()) * NS_PER.ms; source = "now";
  }
  const members = await resolveGroupMembers(grp, ns, env);
  return ok({
    group_id: grp.id, group_version: grp.version,
    instant: { source, unix_ns: ns.toString(), rfc3339: rfc3339(ns, "UTC") },
    members,
  }, {}, "no-store");
}
// Extracted so both group-expand and workspace-expand share the same per-member
// resolution + error isolation (one bad member never fails the whole request).
async function resolveGroupMembers(grp, ns, env) {
  return Promise.all(grp.members.map((m) => resolveMember(m, ns, env)));
}

// ---- Phase 5 Step 1 — Shared Workspace (whitepaper "shared workspaces", zero
// accounts): a workspace bundles existing system/group ids under one shareable
// id. Knowing the id is NOT an access-control boundary — this API has no
// accounts at all, so creating/reading/expanding a workspace is exactly as
// public as creating/reading any system or group already is; a workspace is a
// NAMESPACING convenience (a discoverable "everything for project X" bundle),
// not a security mechanism. Real role permissions (§Phase-5 Step 2) would need
// actual accounts, deliberately not built yet — see corpus/current.md.
async function createWorkspace(req, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  let body;
  try { body = await req.json(); } catch { return fail("INVALID_TIME_VALUE", "body must be JSON"); }
  const wsp = body.workspace || body;
  if (!wsp.id) return fail("INVALID_TIME_VALUE", "workspace.id required (e.g. workspace:project-alpha)");
  const systems = Array.isArray(wsp.systems) ? wsp.systems : [];
  const groups = Array.isArray(wsp.groups) ? wsp.groups : [];
  if (!systems.length && !groups.length) return fail("INVALID_TIME_VALUE", "workspace needs at least one system or group id, in systems[] and/or groups[]");
  const existingRaw = await env.CTCL_KV.get("workspace:" + wsp.id);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;
  const rec = {
    id: wsp.id, name: wsp.name || (existing && existing.name) || null,
    systems, groups, owner: wsp.owner || (existing && existing.owner) || null,
    version: String(existing ? Number(existing.version || "1") + 1 : 1),
    created_at: existing ? existing.created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const sig = await signWorkspaceRecord(env, rec);
  if (sig) rec.signature = sig;
  await env.CTCL_KV.put("workspace:" + wsp.id, JSON.stringify(rec));
  return ok({ ...rec, expand: `/v1/workspaces/${encodeURIComponent(wsp.id)}/expand` },
    { note: "No accounts: this is a namespacing convenience, not access control — anyone who can reach this API can also read/overwrite this workspace, same as any system or group. POST /v1/workspaces/{id}/expand resolves every member system and group at one shared instant." });
}

async function getWorkspace(id, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const raw = await env.CTCL_KV.get("workspace:" + id);
  if (!raw) return fail("UNKNOWN_WORKSPACE", `no such workspace: ${id}`, {}, 404);
  return ok(JSON.parse(raw));
}

async function listWorkspaces(env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const l = await env.CTCL_KV.list({ prefix: "workspace:" });
  const workspaces = l.keys.map((k) => k.name.replace(/^workspace:/, ""));
  return ok({ count: workspaces.length, workspaces, truncated: !l.list_complete,
    note: "GET /v1/workspaces/{id} for a definition; POST .../expand to resolve every member system/group at a shared instant in one call." });
}

async function expandWorkspace(id, req, env) {
  if (!env || !env.CTCL_KV) return kvMissing();
  const raw = await env.CTCL_KV.get("workspace:" + id);
  if (!raw) return fail("UNKNOWN_WORKSPACE", `no such workspace: ${id}`, {}, 404);
  const wsp = JSON.parse(raw);
  let body = {};
  try { body = await req.json(); } catch { /* empty body -> expand "now" */ }
  let ns, source;
  if (body.instant_id) {
    const rawI = await env.CTCL_KV.get("instant:" + uuidOf(body.instant_id));
    if (!rawI) return fail("UNKNOWN_INSTANT", `no registered instant: ${body.instant_id}`, {}, 404);
    ns = BigInt(JSON.parse(rawI).unix_ns); source = "registered_instant";
  } else if (body.value != null) {
    try { ns = toNs(body.value, body.encoding); }
    catch (e) { return fail(e.code || "INVALID_TIME_VALUE", e.msg || String(e)); }
    source = "explicit_value";
  } else {
    ns = BigInt(Date.now()) * NS_PER.ms; source = "now";
  }
  const systems = await Promise.all((wsp.systems || []).map((sid) => resolveMember(sid, ns, env)));
  const groups = await Promise.all((wsp.groups || []).map(async (gid) => {
    const rawG = await env.CTCL_KV.get("group:" + gid);
    if (!rawG) return { group: gid, error: "UNKNOWN_GROUP", message: `no such group: ${gid}` };
    const grp = JSON.parse(rawG);
    return { group: gid, group_version: grp.version, members: await resolveGroupMembers(grp, ns, env) };
  }));
  return ok({
    workspace_id: wsp.id, workspace_version: wsp.version, name: wsp.name,
    instant: { source, unix_ns: ns.toString(), rfc3339: rfc3339(ns, "UTC") },
    systems, groups,
  }, {}, "no-store");
}

// ---- Boundary Inspector (P2 — CommonInstant Web whitepaper §5.6/§8.1) -----
// B(I,S) in {normal, gap, fold, pause, rate_change}. A PROACTIVE pre-flight check —
// unlike /v1/convert (which fails on ambiguity), this always returns a status so an
// agent can ask "is this time/system state safe?" before committing to it.

// Scan forward from `ns` for up to `windowHours` for an IANA offset change (coarse
// hourly probe, then binary-search the transition minute). No external tzdb transition
// table needed — just repeated Intl offset reads, which is cheap at this resolution.
function scanTzTransitions(tz, ns, windowHours) {
  const startMs = Number(ns / NS_PER.ms);
  const hours = Math.max(1, Math.min(24 * 30, windowHours));
  let prevOff = tzOffsetMinutes(startMs, tz);
  const found = [];
  for (let h = 1; h <= hours; h++) {
    const ms = startMs + h * 3600000;
    const off = tzOffsetMinutes(ms, tz);
    if (off !== prevOff) {
      let lo = ms - 3600000, hi = ms;
      while (hi - lo > 60000) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (tzOffsetMinutes(mid, tz) === prevOff) lo = mid; else hi = mid;
      }
      found.push({ at: rfc3339(BigInt(hi) * NS_PER.ms, "UTC"), offset_before_min: prevOff, offset_after_min: off });
      prevOff = off;
    }
  }
  return found;
}

async function inspectBoundary(req, env) {
  let body;
  try { body = await req.json(); } catch { return fail("INVALID_TIME_VALUE", "body must be JSON"); }

  if (body.timezone != null || body.local_value != null) {
    if (!body.timezone || !body.local_value) return fail("INVALID_TIME_VALUE", "timezone + local_value required together (e.g. {timezone:'America/New_York', local_value:'2026-03-08T02:30:00'})");
    let res;
    try { res = localToUtc(body.local_value, body.timezone); }
    catch (e) { return fail("INVALID_TIMEZONE", `unrecognized IANA timezone: ${body.timezone}`); }
    if (res.candidates.length === 0)
      return ok({ kind: "timezone", timezone: body.timezone, local_value: body.local_value, status: "gap", safe: false,
        detail: { note: "this local time does not exist (DST spring-forward gap)" } });
    if (res.candidates.length > 1)
      return ok({ kind: "timezone", timezone: body.timezone, local_value: body.local_value, status: "fold", safe: false,
        detail: { candidates: res.candidates.map((c) => rfc3339(BigInt(c) * NS_PER.ms, "UTC")),
          note: "this local time is ambiguous (DST fall-back overlap); pass an explicit offset to disambiguate" } });
    const ns = BigInt(res.candidates[0]) * NS_PER.ms;
    const windowHours = Number(body.window_hours) || 48;
    return ok({ kind: "timezone", timezone: body.timezone, local_value: body.local_value, status: "normal", safe: true,
      resolved_utc: rfc3339(ns, "UTC"), upcoming_transitions: scanTzTransitions(body.timezone, ns, windowHours) });
  }

  if (body.system_id) {
    if (!env || !env.CTCL_KV) return kvMissing();
    const raw = await env.CTCL_KV.get("system:" + body.system_id);
    if (!raw) return fail("UNKNOWN_SYSTEM", `no such system: ${body.system_id}`, {}, 404);
    const sys = JSON.parse(raw);
    let ns;
    try { ns = body.value != null ? toNs(body.value, body.encoding) : BigInt(Date.now()) * NS_PER.ms; }
    catch (e) { return fail(e.code || "INVALID_TIME_VALUE", e.msg || String(e)); }
    let epochNs;
    try { epochNs = toNs(sys.epoch?.parent_value ?? 0, sys.epoch?.encoding || "unix_s"); }
    catch { epochNs = 0n; }
    const parentSec = Number(ns) / 1e9, epochSec = Number(epochNs) / 1e9;
    const rate = sys.rate || { type: "constant" };
    if (rate.type === "paused") {
      const inPause = (rate.pauses || []).some((pz) => parentSec >= Number(pz.from) && parentSec < (pz.to == null ? Infinity : Number(pz.to)));
      return ok({ kind: "system", system_id: sys.id, instant: { unix_ns: ns.toString() }, status: inPause ? "pause" : "normal", safe: !inPause,
        detail: inPause ? { note: "instant falls inside a paused segment; active-time excludes it (§25)" } : {} });
    }
    if (rate.type === "piecewise") {
      const TOL_S = 60; // "near" a segment boundary, in seconds
      let nearBoundary = null;
      for (const seg of (rate.segments || [])) {
        if (seg.until == null) continue;
        if (Math.abs(parentSec - Number(seg.until)) <= TOL_S) { nearBoundary = Number(seg.until); break; }
      }
      return ok({ kind: "system", system_id: sys.id, instant: { unix_ns: ns.toString() },
        status: nearBoundary != null ? "rate_change" : "normal", safe: nearBoundary == null,
        detail: nearBoundary != null ? { boundary_at_unix_s: nearBoundary, tolerance_s: TOL_S } : {} });
    }
    return ok({ kind: "system", system_id: sys.id, instant: { unix_ns: ns.toString() }, status: "normal", safe: true, detail: {} });
  }

  return fail("INVALID_TIME_VALUE", "provide either {timezone, local_value, window_hours?} or {system_id, value?, encoding?}");
}

// ---- Share Instant (P4 — CommonInstant Web whitepaper §4.4/§5.2/§6.7) -----
// A human-readable counterpart to GET /v1/instant/{id}: https://commoninstant.org/i/<id>.
// Anyone with the link can read the same reference instant and project it into their
// own timezone — the concrete "共同瞬間分享層". Untrusted input touches this page in two
// places (the URL id, and the user-supplied `label` stored at registration) so both are
// HTML-escaped before interpolation.
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function shareStyles() {
  return `:root{--bg:#14100a;--surf:#1e190f;--ink:#ece3d0;--dim:#b6ab90;--faint:#7d7259;--gold:#cda24f;--line:#2c2515;--mono:'JetBrains Mono',ui-monospace,'SF Mono',Consolas,monospace;--sans:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif}
@media (prefers-color-scheme: light){:root{--bg:#f4eddc;--surf:#fbf6ea;--ink:#241d11;--dim:#5e5540;--faint:#897b60;--gold:#8c6c1c;--line:#e3d7bd}}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans);padding:2.2rem 1.2rem 4rem}
.wrap{max-width:640px;margin:0 auto}
a{color:var(--gold)}
h1{font-size:1.5rem;margin-bottom:.3rem}
.eyebrow{font:600 .68rem/1 var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--faint);margin-bottom:.6rem}
.card{border:1px solid var(--line);border-radius:.8rem;background:var(--surf);padding:1.3rem 1.4rem;margin-top:1.2rem}
.row{display:flex;justify-content:space-between;gap:1rem;font-family:var(--mono);font-size:.82rem;padding:.35rem 0;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row .k{color:var(--faint);white-space:nowrap}
.row .v{color:var(--gold);text-align:right;word-break:break-all}
.big{font-family:var(--mono);font-size:1.1rem;margin:.3rem 0 1rem;word-break:break-all}
.actions{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:1rem}
.btn{font:600 .84rem/1 var(--sans);border-radius:.5rem;padding:.6rem 1rem;cursor:pointer;border:1px solid var(--gold);background:transparent;color:var(--ink);text-decoration:none;display:inline-flex;align-items:center}
.btn.pri{background:var(--gold);color:#1a1408}
.pg{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-top:.9rem}
.pg input{font-family:var(--mono);font-size:.85rem;background:var(--bg);border:1px solid var(--line);color:var(--ink);border-radius:.4rem;padding:.5rem .65rem}
.qr{display:flex;justify-content:center;padding:1rem;background:#fff;border-radius:.6rem;margin-top:1rem}
.qr svg{width:150px;height:150px;display:block}
pre{font-family:var(--mono);font-size:.78rem;line-height:1.55;background:var(--bg);border:1px solid var(--line);border-radius:.5rem;padding:.9rem 1rem;overflow-x:auto;margin-top:.8rem;color:var(--ink)}
footer{margin-top:2.4rem;color:var(--faint);font-size:.8rem}
footer a{color:var(--dim)}`;
}
function shareNotFound(origin, rawId, reason, status) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CTCL · Instant not found</title><style>${shareStyles()}</style></head><body><div class="wrap">
<div class="eyebrow">CTCL · Shared Instant</div>
<h1>Not found</h1>
<p style="color:var(--dim)">${escHtml(reason)} (<code>${escHtml(rawId)}</code>)</p>
<div class="actions"><a class="btn pri" href="${origin}/">&larr; back home</a></div>
</div></body></html>`;
}
function sharePage(origin, rec, views) {
  const uuid = uuidOf(rec.id);
  const shareUrl = origin + "/i/" + uuid;
  const qrSvg = shareQrSvg(shareUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CTCL · Shared instant ${uuid.slice(0, 8)}</title>
<meta name="description" content="A CTCL common reference instant, verified and shareable across agents and systems.">
<style>${shareStyles()}</style></head><body><div class="wrap">
<div class="eyebrow">CTCL &middot; Shared Instant</div>
<h1>One instant, any local time</h1>
<p style="color:var(--dim)">Anyone with this link aligns on the exact same reference instant — project it into your own timezone below.</p>
${qrSvg ? `<div class="qr">${qrSvg}</div>` : ""}
<div class="card">
 <div class="big">${escHtml(views.encodings.rfc3339)}</div>
 <div class="row"><span class="k">instant_id</span><span class="v">${escHtml(rec.id)}</span></div>
 <div class="row"><span class="k">unix_ns</span><span class="v">${escHtml(views.encodings.unix_ns)}</span></div>
 <div class="row"><span class="k">unix_s</span><span class="v">${escHtml(views.encodings.unix_s)}</span></div>
 <div class="row"><span class="k">tai (approx)</span><span class="v">${escHtml(views.timescales.tai_approx)}</span></div>
 <div class="row"><span class="k">gps (approx)</span><span class="v">${escHtml(views.timescales.gps_approx)}</span></div>
 <div class="row"><span class="k">registered_at</span><span class="v">${escHtml(rec.registered_at)}</span></div>
 ${rec.label ? `<div class="row"><span class="k">label</span><span class="v">${escHtml(rec.label)}</span></div>` : ""}
 <div class="row"><span class="k">source</span><span class="v">${rec.from_wall_clock ? "edge wall clock (at registration)" : "explicit value"}</span></div>
</div>
<div class="pg">
 <label class="mono" style="color:var(--faint);font-size:.75rem">project into tz <input id="tz" value="Asia/Taipei" aria-label="IANA timezone"></label>
 <button class="btn pri" id="go">convert &rarr;</button>
</div>
<pre id="out">…</pre>
<div class="actions">
 <button class="btn" id="copyLink">copy share link</button>
 <button class="btn" id="copyJson">copy JSON</button>
 <a class="btn" href="/v1/instant/${encodeURIComponent(uuid)}">raw JSON API</a>
</div>
<footer>CTCL v0.1 &middot; a reference + transformation layer, not a timing authority. <a href="/">&larr; home</a> &middot; <a href="/ai/ctcl.json">agent tool declaration</a></footer>
</div>
<script>
var O=location.origin;function $(i){return document.getElementById(i)}
var NS=${JSON.stringify(views.encodings.unix_ns)};
async function go(){try{
 var r=await(await fetch(O+'/v1/convert',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:{value:NS,encoding:'unix_ns'},output:{encoding:'rfc3339',timezone:$('tz').value}})})).json();
 $('out').textContent=JSON.stringify(r.ok?r.data:r,null,2);
}catch(e){$('out').textContent=String(e)}}
$('go').addEventListener('click',go);
$('copyLink').addEventListener('click',function(){navigator.clipboard.writeText(${JSON.stringify(shareUrl)})});
$('copyJson').addEventListener('click',async function(){var t=await(await fetch(O+'/v1/instant/${encodeURIComponent(uuid)}')).text();navigator.clipboard.writeText(t)});
</script>
</body></html>`;
}
// ---- Status/Trust Panel (§10.3) + Developer Console (§5.7) ----------------
// Both are thin HTML pages: no new data model, just fetching/presenting what already
// exists (GET /v1/version's runtime health block; the error codes and endpoints already
// wired elsewhere). Reuses shareStyles() for visual consistency with /i/{id}.
function siteNav(active) {
  const items = [["/", "Home"], ["/developers", "Developers"], ["/status", "Status"]];
  return items.map(([href, label]) => `<a href="${href}"${href === active ? ' style="color:var(--ink);font-weight:600"' : ""}>${label}</a>`).join(" &middot; ");
}
const ERROR_CODES = [
  ["INVALID_TIME_VALUE", 400, "malformed, missing, or out-of-range input value"],
  ["UNKNOWN_ENCODING", 400, "encoding not recognized (unix_s|unix_ms|unix_us|unix_ns|rfc3339)"],
  ["INVALID_TIMEZONE", 400, "not a valid IANA timezone name"],
  ["NONEXISTENT_LOCAL_TIME", 400, "DST spring-forward gap — this local time never occurred"],
  ["AMBIGUOUS_LOCAL_TIME", 400, "DST fall-back overlap — this local time occurred twice"],
  ["UNSUPPORTED_POLICY", 400, "invalid rate/system policy in a custom system definition"],
  ["UNKNOWN_SYSTEM", 404, "no such custom system id"],
  ["UNKNOWN_GROUP", 404, "no such Temporal Group id"],
  ["UNKNOWN_WORKSPACE", 404, "no such Shared Workspace id"],
  ["UNKNOWN_INSTANT", 404, "no such registered instant id"],
  ["UNKNOWN_TRANSFORM", 404, "no such transform type id"],
  ["REGISTRY_UNAVAILABLE", 503, "CTCL_KV not bound on this deployment"],
  ["SIGNING_DISABLED", 503, "no Ed25519 signing key configured (CTCL_SIGN_KEY unset)"],
  ["RATE_LIMITED", 429, "over 120 requests/min for this IP on /v1/*"],
  ["NOT_FOUND", 404, "unknown route"],
];
function statusPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CTCL · Status</title>
<meta name="description" content="CTCL live status: component health, versions, and an honest list of known limitations.">
<style>${shareStyles()}</style></head><body><div class="wrap">
<div class="eyebrow">CTCL &middot; Status</div>
<h1>Status &amp; Trust Panel</h1>
<p style="color:var(--dim)">Live component health, versions, and an honest list of known limitations (§10.3) — not a marketing status page.</p>
<nav style="margin:1rem 0 1.6rem;font:600 .8rem/1 var(--mono)">${siteNav("/status")}</nav>
<div class="card"><div id="rows">loading…</div></div>
<h2 style="font-size:1.05rem;margin-top:1.6rem">Known limitations</h2>
<div class="card"><div id="limits">loading…</div></div>
<div class="actions"><a class="btn" href="/v1/version">raw JSON</a> <a class="btn" href="/ai/ctcl.json">agent tool declaration</a></div>
<footer>CTCL v0.1 &middot; a reference + transformation layer, not a timing authority. <a href="/">&larr; home</a></footer>
</div>
<script>
(async function(){
 try{
  var r=await(await fetch('/v1/version')).json();var d=r.data;var rt=d.runtime||{};
  var rows=[['service',d.service+' '+d.release],['api_version',d.api_version],['current_trust_tier',d.current_trust_tier],
    ['instant_registry_kv',rt.instant_registry_kv],['rate_limiter',rt.rate_limiter],['instant_signing',rt.instant_signing],
    ['edge_wall_clock',rt.edge_wall_clock],['tzdb',d.tzdb],['leap_table_as_of',d.leap_table&&d.leap_table.as_of]];
  document.getElementById('rows').innerHTML=rows.map(function(x){return '<div class="row"><span class="k">'+x[0]+'</span><span class="v">'+(x[1]||'—')+'</span></div>'}).join('');
  document.getElementById('limits').innerHTML=(d.known_limitations||[]).map(function(l){return '<div class="row"><span class="v" style="text-align:left;color:var(--ink)">'+l+'</span></div>'}).join('');
 }catch(e){document.getElementById('rows').textContent='(failed to load /v1/version: '+e+')'}
})();
</script>
</body></html>`;
}
function developerConsolePage() {
  const errRows = ERROR_CODES.map(([code, status, desc]) =>
    `<div class="row"><span class="k">${code}</span><span class="v">${status}</span></div><div class="row" style="border-top:0;padding-top:0"><span class="v" style="text-align:left;color:var(--faint);font-size:.76rem">${desc}</span></div>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CTCL · Developers</title>
<meta name="description" content="CTCL developer console: OpenAPI, SDK, error codes, changelog, version policy.">
<style>${shareStyles()}</style></head><body><div class="wrap">
<div class="eyebrow">CTCL &middot; Developers</div>
<h1>Developer Console</h1>
<p style="color:var(--dim)">Everything a client implementer needs in one place (§5.7).</p>
<nav style="margin:1rem 0 1.6rem;font:600 .8rem/1 var(--mono)">${siteNav("/developers")}</nav>

<h2 style="font-size:1.05rem">Interfaces</h2>
<div class="card">
 <div class="row"><span class="k">REST + OpenAPI</span><span class="v"><a href="/openapi.json">/openapi.json</a></span></div>
 <div class="row"><span class="k">Agent tool declaration</span><span class="v"><a href="/ai/ctcl.json">/ai/ctcl.json</a></span></div>
 <div class="row"><span class="k">JS SDK (ESM)</span><span class="v"><a href="/sdk.js">/sdk.js</a></span></div>
 <div class="row"><span class="k">MCP adapter</span><span class="v">not yet implemented — §9 treats MCP as an adapter over this same REST core, not the core itself; discovery today is via the tool declaration above</span></div>
 <div class="row"><span class="k">CLI</span><span class="v">not yet implemented — curl/SDK are the current interfaces</span></div>
 <div class="row"><span class="k">Webhook relay</span><span class="v">not yet implemented</span></div>
</div>

<h2 style="font-size:1.05rem;margin-top:1.6rem">Error codes</h2>
<div class="card">${errRows}</div>

<h2 style="font-size:1.05rem;margin-top:1.6rem">Version policy</h2>
<div class="card">
 <p style="margin:0;color:var(--ink)">All routes here are <code>v1</code>. The response envelope shape
 (<code>{ok, data, meta}</code> / <code>{ok:false, error, meta}</code>) will not change within v1 — new
 optional fields may be added, but existing fields won't be removed or repurposed. A breaking change would
 ship as <code>/v2</code>, not a silent mutation of <code>/v1</code>.</p>
</div>

<h2 style="font-size:1.05rem;margin-top:1.6rem">Changelog</h2>
<div class="card">
 <div class="row"><span class="k">2026-07-14</span><span class="v">Shared Workspaces (/v1/workspaces, Phase 5 Step 1) — bundle systems/groups under one signed, shareable id, no accounts; QR Code on Share Instant (§6.6); every persisted resource type Ed25519-signed (§31.1); tai/gps timescales now leap-aware via the full 1972-2017 historical offset table</span></div>
 <div class="row"><span class="k">2026-07-12</span><span class="v">Registered instants (/v1/instants) now Ed25519-signed (§31); SDK gained monotonic() (§32), guardedNow() rollback detection (§33), offlineNow() degraded mode (§39), and a maxAgeMs staleness check in verifyInstant()</span></div>
 <div class="row"><span class="k">2026-07-11</span><span class="v">Constraint Planner, Semantic Resolution, Share Instant, Boundary Inspector, Temporal Groups — CommonInstant Web whitepaper P1–P6</span></div>
 <div class="row"><span class="k">2026-07-11</span><span class="v">Ed25519-signed instants (§31), native rate limiting (§38), table_lookup transform</span></div>
 <div class="row"><span class="k">2026-07-11</span><span class="v">Migrated to standalone repo (from unbounded-axiom)</span></div>
 <div class="row"><span class="k">2026-07-10</span><span class="v">v0.1 MVP: reference instant, convert, transform, agent tool declaration</span></div>
</div>

<div class="actions"><a class="btn" href="/v1/version">raw version JSON</a></div>
<footer>CTCL v0.1 &middot; a reference + transformation layer, not a timing authority. <a href="/">&larr; home</a></footer>
</div>
</body></html>`;
}

async function instantSharePage(origin, rawId, env) {
  const headers = { "Content-Type": "text/html; charset=utf-8", ...CORS };
  if (!env || !env.CTCL_KV) return new Response(shareNotFound(origin, rawId, "Registry not configured on this deployment."), { status: 503, headers });
  const raw = await env.CTCL_KV.get("instant:" + uuidOf(rawId));
  if (!raw) return new Response(shareNotFound(origin, rawId, "No such registered instant."), { status: 404, headers });
  const rec = JSON.parse(raw);
  return new Response(sharePage(origin, rec, instantViews(BigInt(rec.unix_ns))), { headers });
}

// ---- Semantic Resolution (P5 — CommonInstant Web whitepaper §6/§8.1) ------
// resolve_temporal_context: map an ambiguous human input (city name, common alias,
// timezone abbreviation) to IANA candidates with confidence — NEVER silently pick one
// (§6.3). Free-form natural-language time phrases ("tomorrow 3pm", "before London
// market open") are explicitly OUT OF SCOPE for v1: an honest empty result beats a
// guess that's wrong half the time.
const TZ_ALIASES = {
  "taipei": ["Asia/Taipei"], "台北": ["Asia/Taipei"], "taiwan": ["Asia/Taipei"], "台灣": ["Asia/Taipei"], "台灣時間": ["Asia/Taipei"],
  "tokyo": ["Asia/Tokyo"], "東京": ["Asia/Tokyo"], "japan": ["Asia/Tokyo"], "日本": ["Asia/Tokyo"],
  "london": ["Europe/London"], "uk": ["Europe/London"], "britain": ["Europe/London"],
  "new york": ["America/New_York"], "nyc": ["America/New_York"],
  "los angeles": ["America/Los_Angeles"], "la": ["America/Los_Angeles"],
  "beijing": ["Asia/Shanghai"], "china": ["Asia/Shanghai"], "北京": ["Asia/Shanghai"], "中國": ["Asia/Shanghai"],
  "hong kong": ["Asia/Hong_Kong"], "香港": ["Asia/Hong_Kong"],
  "singapore": ["Asia/Singapore"], "新加坡": ["Asia/Singapore"],
  "seoul": ["Asia/Seoul"], "korea": ["Asia/Seoul"], "首爾": ["Asia/Seoul"], "韓國": ["Asia/Seoul"],
  "sydney": ["Australia/Sydney"], "paris": ["Europe/Paris"], "berlin": ["Europe/Berlin"],
  "moscow": ["Europe/Moscow"], "dubai": ["Asia/Dubai"], "mumbai": ["Asia/Kolkata"], "india": ["Asia/Kolkata"],
  // genuinely ambiguous abbreviations resolve to MULTIPLE candidates, lower confidence
  "cst": ["America/Chicago", "Asia/Shanghai"], "est": ["America/New_York"], "edt": ["America/New_York"],
  "pst": ["America/Los_Angeles"], "pdt": ["America/Los_Angeles"], "jst": ["Asia/Tokyo"], "kst": ["Asia/Seoul"],
  "ist": ["Asia/Kolkata"], "tpe": ["Asia/Taipei"], "nrt": ["Asia/Tokyo"], "lhr": ["Europe/London"], "jfk": ["America/New_York"],
};

function resolveTemporalContext(input) {
  const raw = String(input || "").trim();
  const key = raw.toLowerCase();
  const out = [];
  if (TZ_ALIASES[key]) {
    const list = TZ_ALIASES[key];
    const conf = list.length === 1 ? 0.95 : Math.round((0.9 / list.length) * 100) / 100;
    for (const tz of list) out.push({ context_id: "iana:" + tz, confidence: conf, source: "ctcl_alias_table",
      note: list.length > 1 ? "multiple plausible zones share this label — genuinely ambiguous, not resolved for you" : undefined });
  }
  if (!out.length && /^[A-Za-z_]+\/[A-Za-z_]+$/.test(raw)) {
    try { tzOffsetMinutes(Date.now(), raw); out.push({ context_id: "iana:" + raw, confidence: 0.99, source: "iana_tzdb_exact" }); } catch { /* not a real IANA id */ }
  }
  if (!out.length) {
    for (const [k, list] of Object.entries(TZ_ALIASES)) {
      if (key.length > 2 && (k.includes(key) || key.includes(k))) {
        for (const tz of list) if (!out.some((o) => o.context_id === "iana:" + tz)) out.push({ context_id: "iana:" + tz, confidence: 0.4, source: "ctcl_alias_table_fuzzy" });
      }
    }
  }
  return {
    input: raw, candidates: out,
    scope_note: out.length
      ? "Place-name / abbreviation -> IANA timezone resolution only (§6). Never silently disambiguate — check confidence and candidate count yourself."
      : "No candidate found. v1 resolves place names, common city aliases, and known timezone abbreviations only. Free-form natural-language time phrases (\"tomorrow 3pm\", \"before London market open\") are explicitly out of scope — guessing at those would violate §6.3 (don't silently resolve ambiguity).",
  };
}

async function handleResolve(req) {
  let body;
  try { body = await req.json(); } catch { return fail("INVALID_TIME_VALUE", "body must be JSON"); }
  if (body.input == null) return fail("INVALID_TIME_VALUE", "input required (e.g. {input:'Taipei'})");
  return ok(resolveTemporalContext(body.input));
}

// ---- Constraint Planner (P6 — CommonInstant Web whitepaper §7/§8.1) -------
// plan_shared_instant: I* = argmax_I U(I | C1..Cn). The whitepaper is explicit this is
// NOT a full meeting-scheduler SaaS — a demonstration of CTCL-native constraint solving
// over a bounded window. Constraint types are limited to what this Worker can HONESTLY
// compute with no external data feed: no real market/holiday calendars, no live GPU
// telemetry. Those are declared `implemented: false` rather than faked.
const CONSTRAINT_TYPES = {
  weekday_hours: { desc: "instant falls within local civil hours on given weekdays", params: ["timezone", "days (0=Sun..6=Sat)", "start (HH:MM)", "end (HH:MM)"], implemented: true },
  avoid_window: { desc: "instant must NOT fall within [from, to) unix_s", params: ["from", "to"], implemented: true },
  prefer_window: { desc: "instant SHOULD fall within [from, to) unix_s — soft preference", params: ["from", "to"], implemented: true },
  min_lead_time: { desc: "instant must be at least `seconds` after the request time", params: ["seconds"], implemented: true },
  system_not_paused: { desc: "a stored custom system must not be in a paused segment at the instant", params: ["system_id"], implemented: true },
  market_hours: { desc: "weekday + local-hours only, NO holiday calendar — an honest approximation, not a real exchange calendar", params: ["timezone", "start", "end"], implemented: true, caveat: "no holiday awareness; do not use for real trading decisions" },
  gpu_availability: { desc: "requires an external telemetry feed this deployment does not have", implemented: false },
  simulation_state: { desc: "requires integration with a specific simulator this deployment does not have", implemented: false },
};
function constraintTypesCatalog() {
  return ok({ count: Object.keys(CONSTRAINT_TYPES).length, implemented: Object.keys(CONSTRAINT_TYPES).filter((k) => CONSTRAINT_TYPES[k].implemented), types: CONSTRAINT_TYPES });
}
function parseHM(s) { const m = String(s).match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }

function checkConstraint(c, unixS, requestUnixS) {
  const type = c.type;
  if (type === "weekday_hours" || type === "market_hours") {
    const tz = c.timezone || "UTC";
    let off; try { off = tzOffsetMinutes(unixS * 1000, tz); } catch { return { ok: false, reason: "invalid timezone" }; }
    const d = new Date(unixS * 1000 + off * 60000);
    const dow = d.getUTCDay(), minsOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
    const days = type === "market_hours" ? [1, 2, 3, 4, 5] : (Array.isArray(c.days) ? c.days : [1, 2, 3, 4, 5]);
    const startM = parseHM(c.start || "09:00"), endM = parseHM(c.end || "18:00");
    const ok = days.includes(dow) && startM != null && endM != null && minsOfDay >= startM && minsOfDay < endM;
    return { ok, reason: ok ? null : "outside weekday/hours window" };
  }
  if (type === "avoid_window") {
    const inWin = unixS >= Number(c.from) && unixS < Number(c.to);
    return { ok: !inWin, reason: inWin ? "inside avoided window" : null };
  }
  if (type === "prefer_window") {
    const inWin = unixS >= Number(c.from) && unixS < Number(c.to);
    return { ok: inWin, reason: inWin ? null : "outside preferred window (soft)" };
  }
  if (type === "min_lead_time") {
    const ok = unixS >= requestUnixS + Number(c.seconds || 0);
    return { ok, reason: ok ? null : "too soon (lead time not met)" };
  }
  return { ok: null, unsupported: true, reason: "unsupported constraint type: " + type };
}

async function planSharedInstant(req, env) {
  let body;
  try { body = await req.json(); } catch { return fail("INVALID_TIME_VALUE", "body must be JSON"); }
  const win = body.window || {};
  const from = Number(win.from), to = Number(win.to), step = Number(win.step_s || 900);
  if (!(from < to) || !(step > 0)) return fail("INVALID_TIME_VALUE", "window.from < window.to and window.step_s > 0 required (unix_s)");
  const steps = Math.floor((to - from) / step);
  const MAX_SAMPLES = 1000;
  if (steps > MAX_SAMPLES) return fail("INVALID_TIME_VALUE", `window too large: ~${steps} samples at step_s=${step} (max ${MAX_SAMPLES}). Widen step_s or narrow the window.`, { steps, max: MAX_SAMPLES });
  const constraints = Array.isArray(body.constraints) ? body.constraints : [];
  if (!constraints.length) return fail("INVALID_TIME_VALUE", "constraints must be a non-empty array");
  // system_not_paused needs a KV lookup per system id — resolve once, not once per candidate
  const sysCache = {};
  for (const c of constraints) {
    if (c.type === "system_not_paused" && c.system_id && !(c.system_id in sysCache))
      sysCache[c.system_id] = (env && env.CTCL_KV) ? await env.CTCL_KV.get("system:" + c.system_id) : null;
  }
  const requestUnixS = Date.now() / 1000;
  const totalWeight = constraints.reduce((s, c) => s + Number(c.weight ?? 1), 0) || 1;
  const results = [];
  for (let s = from; s <= to; s += step) {
    let score = 0; const satisfied = [], violated = [], unsupported = [];
    for (const c of constraints) {
      const w = Number(c.weight ?? 1);
      if (c.type === "system_not_paused") {
        const raw = sysCache[c.system_id];
        if (!raw) { unsupported.push({ type: c.type, reason: "unknown system: " + c.system_id }); continue; }
        const sys = JSON.parse(raw);
        const inPause = sys.rate && sys.rate.type === "paused" && (sys.rate.pauses || []).some((pz) => s >= Number(pz.from) && s < (pz.to == null ? Infinity : Number(pz.to)));
        if (!inPause) { score += w; satisfied.push(c.type); } else violated.push(c.type);
        continue;
      }
      const r = checkConstraint(c, s, requestUnixS);
      if (r.unsupported) { unsupported.push({ type: c.type, reason: r.reason }); continue; }
      if (r.ok) { score += w; satisfied.push(c.type); } else violated.push({ type: c.type, reason: r.reason });
    }
    results.push({ unix_s: s, score: score / totalWeight, satisfied, violated, unsupported });
  }
  results.sort((a, b) => b.score - a.score || a.unix_s - b.unix_s);
  const best = results[0];
  const alternatives = [];
  for (const r of results.slice(1)) {
    if (alternatives.length >= 3) break;
    if (Math.abs(r.unix_s - best.unix_s) < 3600 || alternatives.some((a) => Math.abs(a.unix_s - r.unix_s) < 3600)) continue;
    alternatives.push(r);
  }
  const toInst = (r) => ({ unix_s: r.unix_s, rfc3339: rfc3339(BigInt(r.unix_s) * NS_PER.s, "UTC"),
    score: Math.round(r.score * 1000) / 1000, satisfied_constraints: r.satisfied, violated_constraints: r.violated,
    unsupported_constraints: r.unsupported.length ? r.unsupported : undefined });
  return ok({
    best: toInst(best), alternatives: alternatives.map(toInst), samples_evaluated: results.length,
    explanation: `Evaluated ${results.length} candidate instants at ${step}s resolution over [${from}, ${to}]; best satisfies ${Math.round(best.score * 100)}% of total constraint weight.`,
    note: "Demonstration of CTCL-native constraint solving (§7), not a full meeting-scheduling SaaS. See GET /v1/planner/constraint-types for what's honestly supported.",
  }, {}, "no-store");
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
      { name: "register-instant", method: "POST", path: "/v1/instants", desc: "Register a reference instant I* (the current instant, or a given value) → get a shareable id. THE multi-agent primitive: another agent GETs that id and aligns on the exact same instant. Also returns a human `share` URL (/i/{id}, §4.4).",
        input: { value: "string? (default: now)", encoding: "unix_s|…?", timescale: "utc?", label: "string?", meta: "object?" }, output: "instant_id + retrieve URL + share URL + all encodings/timescales + optional Ed25519 signature (§31)" },
      { name: "get-instant", method: "GET", path: "/v1/instant/{id}", desc: "Retrieve a registered instant by id — aligns you on the same I* another agent registered.",
        input: { id: "ctcl:instant:… or bare uuid" }, output: "instant record + all encodings/timescales" },
      { name: "create-system", method: "POST", path: "/v1/systems", desc: "Persist a custom linear-rate time system (game world / accelerated sim / child clock) for reuse.",
        input: { id: "user:game_world", parent: "ctcl:system:unix", epoch: { parent_value: "unix_s" }, rate: { value: "number" }, offset: "number?", calendar: { day_seconds: "int", year_days: "int" } }, output: "system record + /now URL + optional Ed25519 signature over the definition (§31.1)" },
      { name: "get-system", method: "GET", path: "/v1/systems/{id}", desc: "Retrieve a stored system definition.", input: { id: "string" }, output: "system record" },
      { name: "system-now", method: "GET", path: "/v1/systems/{id}/now", desc: "Current time in a stored custom system (+ world calendar).", input: { id: "string" }, output: "system_time + reference instant + calendar" },
      { name: "list-systems", method: "GET", path: "/v1/systems", desc: "List all stored custom systems.", input: {}, output: "system ids" },
      { name: "transform-path", method: "GET", path: "/v1/path", desc: "Route between two systems/timescales in the transform graph (§13-14; star graph today).", input: { from: "system id or unix|utc|posix", to: "…" }, output: "path + hops + lossless" },
      { name: "create-group", method: "POST", path: "/v1/temporal-groups", desc: "Persist a Temporal Group — a named set of members (\"utc\"|\"posix\"|\"tai\"|\"gps\"|\"tz:<IANA>\"|<system id>). Re-posting the same id bumps its version.",
        input: { id: "group:project-alpha", members: ["utc", "tz:Asia/Taipei", "user:game_world"], owner: "string?" }, output: "group record + expand URL + optional Ed25519 signature over this version (§31.1)" },
      { name: "get-group", method: "GET", path: "/v1/temporal-groups/{id}", desc: "Retrieve a Temporal Group definition.", input: { id: "string" }, output: "group record" },
      { name: "list-groups", method: "GET", path: "/v1/temporal-groups", desc: "List all stored Temporal Groups.", input: {}, output: "group ids" },
      { name: "expand-group", method: "POST", path: "/v1/temporal-groups/{id}/expand", desc: "THE CommonInstant Web flagship: project ONE instant across every member of a group — E(I*, G) = {τ1,...,τn}, \"One Instant, Many Systems\". Default instant is now; pass instant_id to align on a previously-registered I*, or an explicit value+encoding.",
        input: { instant_id: "string?", value: "string?", encoding: "string?" }, output: "instant + members[] (each with its local representation)" },
      { name: "create-workspace", method: "POST", path: "/v1/workspaces", desc: "Phase 5 Step 1 — Shared Workspace: bundle existing system/group ids under one shareable id for team/multi-agent coordination. NO accounts, NO access control (whoever can reach this API can also read/overwrite it, same as any system or group) — a namespacing convenience only. Re-posting the same id bumps its version.",
        input: { id: "workspace:project-alpha", name: "string?", systems: ["user:game_world"], groups: ["group:project-alpha-tz"], owner: "string?" }, output: "workspace record + expand URL + optional Ed25519 signature over this version (§31.1)" },
      { name: "get-workspace", method: "GET", path: "/v1/workspaces/{id}", desc: "Retrieve a Shared Workspace definition.", input: { id: "string" }, output: "workspace record" },
      { name: "list-workspaces", method: "GET", path: "/v1/workspaces", desc: "List all stored Shared Workspaces.", input: {}, output: "workspace ids" },
      { name: "expand-workspace", method: "POST", path: "/v1/workspaces/{id}/expand", desc: "Resolve every member system AND every member group's members, all at one shared instant, in a single call — a workspace-scoped generalization of expand-group. Default instant is now; pass instant_id or an explicit value+encoding.",
        input: { instant_id: "string?", value: "string?", encoding: "string?" }, output: "instant + systems[] + groups[] (each group carries its own resolved members[])" },
      { name: "inspect-boundary", method: "POST", path: "/v1/boundaries/inspect", desc: "Proactive pre-flight check (§5.6): is this local time / custom-system state safe? Unlike /v1/convert, never errors — always returns a status: normal|gap|fold (timezone) or normal|pause|rate_change (system), plus upcoming DST transitions within a window.",
        input: { timezone: "IANA?", local_value: "naive local datetime string?", window_hours: "number? (default 48)" }, input_alt: { system_id: "string?", value: "string?", encoding: "string?" }, output: "status + safe + detail" },
      { name: "resolve-temporal-context", method: "POST", path: "/v1/resolve", desc: "resolve_temporal_context (§6): map an ambiguous input (city name, common alias, tz abbreviation) to IANA timezone candidates with confidence. NEVER silently picks one when genuinely ambiguous (e.g. \"CST\"). Free-form natural-language time phrases are explicitly out of scope — honest empty result, not a guess.",
        input: { input: "string (e.g. 'Taipei', '台北', 'CST', 'Asia/Tokyo')" }, output: "candidates[] (context_id, confidence, source) + scope_note" },
      { name: "plan-shared-instant", method: "POST", path: "/v1/planner/shared-instant", desc: "plan_shared_instant (§7): I* = argmax_I U(I | constraints). A demonstration of CTCL-native constraint solving over a bounded search window, NOT a full meeting-scheduler SaaS. See GET /v1/planner/constraint-types for what's honestly supported (no external data feed = declared unimplemented, not faked).",
        input: { window: { from: "unix_s", to: "unix_s", step_s: "number? (default 900, max 1000 samples)" }, constraints: [{ type: "weekday_hours|avoid_window|prefer_window|min_lead_time|system_not_paused|market_hours", weight: "number? (default 1)" }] },
        output: "best + alternatives[] (unix_s, score, satisfied/violated/unsupported constraints) + explanation" },
      { name: "constraint-types", method: "GET", path: "/v1/planner/constraint-types", desc: "Catalog of planner constraint types and which are actually implemented.", input: {}, output: "types + which are implemented" },
      { name: "validate", method: "POST", path: "/v1/validate", desc: "Validate a time value; returns warnings (POSIX-vs-UTC leap drift, out-of-range).", input: { value: "string", encoding: "unix_s|…", timescale: "utc|posix?" }, output: "valid + warnings + canonical_unix_ns" },
      { name: "transform-types", method: "GET", path: "/v1/transforms", desc: "Catalog of transform types (§12): identity, offset, linear_rate, piecewise, paused_clock (active-time), …", input: {}, output: "types + which are implemented" },
      { name: "version", method: "GET", path: "/v1/version", desc: "Versions, leap table, precision tiers (§35), trust tiers (§36), rate-limit policy (§38).", input: {}, output: "versions + tiers" },
      { name: "pubkey", method: "GET", path: "/v1/pubkey", desc: "Ed25519 public key (§31) — verify a /v1/now or registered-instant signature is authentic (not forged) and, optionally, not stale (replay check). SDK: verifyInstant(inst, {maxAgeMs}).", input: {}, output: "alg + key_id + public_jwk" },
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
      "/i/{id}": { get: { summary: "Human-readable Share Instant page (§4.4) — HTML, not JSON", responses: { 200: { description: "ok (html)" }, 404: { description: "unknown instant (html)" } } } },
      "/v1/systems": { get: { summary: "List custom systems", responses: { 200: { description: "ok" } } }, post: { summary: "Create a persistent custom system", responses: { 200: { description: "ok" } } } },
      "/v1/systems/{id}": { get: { summary: "Get a system definition", responses: { 200: { description: "ok" }, 404: { description: "unknown system" } } } },
      "/v1/systems/{id}/now": { get: { summary: "Current time in a custom system", responses: { 200: { description: "ok" } } } },
      "/v1/path": { get: { summary: "Transform-graph route between two systems/timescales (§13-14)", responses: { 200: { description: "ok" }, 404: { description: "unknown node" } } } },
      "/v1/temporal-groups": { get: { summary: "List Temporal Groups", responses: { 200: { description: "ok" } } }, post: { summary: "Create/update a Temporal Group", responses: { 200: { description: "ok" } } } },
      "/v1/temporal-groups/{id}": { get: { summary: "Get a Temporal Group definition", responses: { 200: { description: "ok" }, 404: { description: "unknown group" } } } },
      "/v1/temporal-groups/{id}/expand": { post: { summary: "One Instant, Many Systems: expand an instant across every group member", responses: { 200: { description: "ok" }, 404: { description: "unknown group/instant" } } } },
      "/v1/workspaces": { get: { summary: "List Shared Workspaces (Phase 5 Step 1, no accounts)", responses: { 200: { description: "ok" } } }, post: { summary: "Create/update a Shared Workspace", responses: { 200: { description: "ok" } } } },
      "/v1/workspaces/{id}": { get: { summary: "Get a Shared Workspace definition", responses: { 200: { description: "ok" }, 404: { description: "unknown workspace" } } } },
      "/v1/workspaces/{id}/expand": { post: { summary: "Resolve every member system and group at one shared instant", responses: { 200: { description: "ok" }, 404: { description: "unknown workspace/instant" } } } },
      "/v1/boundaries/inspect": { post: { summary: "Boundary Inspector (§5.6): proactive gap/fold/pause/rate_change status check", responses: { 200: { description: "ok" } } } },
      "/v1/resolve": { post: { summary: "resolve_temporal_context (§6): ambiguous input -> IANA candidates with confidence", responses: { 200: { description: "ok" } } } },
      "/v1/planner/shared-instant": { post: { summary: "plan_shared_instant (§7): constraint-solve for a best shared instant", responses: { 200: { description: "ok" }, 400: { description: "window/constraints invalid" } } } },
      "/v1/planner/constraint-types": { get: { summary: "Planner constraint-type catalog", responses: { 200: { description: "ok" } } } },
      "/v1/validate": { post: { summary: "Validate a time object (§41)", responses: { 200: { description: "ok" } } } },
      "/v1/transforms": { get: { summary: "Transform-type catalog (§12)", responses: { 200: { description: "ok" } } } },
      "/v1/transforms/{id}": { get: { summary: "A transform type's spec", responses: { 200: { description: "ok" }, 404: { description: "unknown" } } } },
    },
  };
}

// ---- §31 authenticity: Ed25519-signed instants ----------------------------
// The private key lives ONLY in the Cloudflare secret CTCL_SIGN_KEY (pkcs8 base64).
// The Worker signs each /v1/now instant and derives + publishes the public key at
// /v1/pubkey, so any agent can verify a timestamp really came from CTCL (not forged,
// whitepaper §31). Graceful: no key configured -> no signature, /v1/pubkey 503.
let _signKey; // undefined=untried, null=none, CryptoKey=ready
let _pubInfo;
const KEY_ID = "ctcl-ed25519-1";
async function getSignKey(env) {
  if (_signKey !== undefined) return _signKey;
  _signKey = null;
  try {
    if (env && env.CTCL_SIGN_KEY) {
      const der = Uint8Array.from(atob(env.CTCL_SIGN_KEY.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
      _signKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
    }
  } catch (e) { _signKey = null; }
  return _signKey;
}
function signedString(inst) {
  return inst.instant.id + "|" + inst.encodings.unix_ns + "|" + inst.instant.reference.timescale;
}
// Lowest-level signer: sign an arbitrary message string, labelled with what it
// covers so a verifier knows exactly what to reconstruct. Shared by every
// signed resource (§31) — /v1/now, registered instants, and custom systems.
async function ed25519SignMessage(env, message, signedFieldsLabel) {
  const key = await getSignKey(env);
  if (!key) return null;
  try {
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(message));
    return { alg: "Ed25519", key_id: KEY_ID, signed_fields: signedFieldsLabel,
      value: btoa(String.fromCharCode(...new Uint8Array(sig))), verify: "/v1/pubkey" };
  } catch (e) { return null; /* signing is best-effort */ }
}
// /v1/now (envelope shape) and the registered-instant record shape both sign
// over the same "id|unix_ns|timescale" convention (§31).
async function ed25519SignFields(env, id, unixNs, timescale) {
  return ed25519SignMessage(env, id + "|" + unixNs + "|" + timescale, "instant_id|unix_ns|timescale");
}
// A custom system has no single instant to sign — it's a rate/epoch DEFINITION
// (§31.1 "signed transform metadata"), so the signed message covers the whole
// definition instead: tampering with parent/epoch/rate/offset invalidates it.
async function signSystemRecord(env, rec) {
  const canonical = rec.id + "|" + JSON.stringify({ parent: rec.parent, epoch: rec.epoch, rate: rec.rate, offset: rec.offset }) + "|" + rec.created_at;
  return ed25519SignMessage(env, canonical, "system_id|canonical_json(parent,epoch,rate,offset)|created_at");
}
// A Temporal Group re-posted under the same id bumps its version (§5.5) — each
// version is functionally a distinct definition, so the signature is tied to
// updated_at (which changes every version) rather than created_at (which does
// not), and covers exactly the fields a re-post can change: members, owner, version.
async function signGroupRecord(env, rec) {
  const canonical = rec.id + "|" + JSON.stringify({ members: rec.members, owner: rec.owner, version: rec.version }) + "|" + rec.updated_at;
  return ed25519SignMessage(env, canonical, "group_id|canonical_json(members,owner,version)|updated_at");
}
// Same version-bump convention as Temporal Groups (§5.5) — a workspace re-post
// under the same id is a distinct definition, so the signature is tied to
// updated_at, covering exactly the fields a re-post can change.
async function signWorkspaceRecord(env, rec) {
  const canonical = rec.id + "|" + JSON.stringify({ name: rec.name, systems: rec.systems, groups: rec.groups, owner: rec.owner, version: rec.version }) + "|" + rec.updated_at;
  return ed25519SignMessage(env, canonical, "workspace_id|canonical_json(name,systems,groups,owner,version)|updated_at");
}
async function signInstant(env, inst) {
  const sig = await ed25519SignFields(env, inst.instant.id, inst.encodings.unix_ns, inst.instant.reference.timescale);
  if (sig) inst.signature = sig;
  return inst;
}
async function pubKeyInfo(env) {
  if (_pubInfo !== undefined) return _pubInfo;
  _pubInfo = null;
  const key = await getSignKey(env);
  if (key) {
    try {
      const jwk = await crypto.subtle.exportKey("jwk", key); // private jwk; we expose ONLY x (public)
      _pubInfo = { alg: "Ed25519", key_id: KEY_ID, public_jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
        signed_fields: "instant_id|unix_ns|timescale (UTF-8, joined by '|')",
        verify_note: "import public_jwk as Ed25519, verify signature.value (base64) over the signed_fields string." };
    } catch (e) { _pubInfo = null; }
  }
  return _pubInfo;
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
  let _lastSeenNs = null;   // §33 rollback detection state
  let _lastKnownNow = null; // §39 offline-mode cache
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
    // §31 verify a signed instant against the published Ed25519 public key. Accepts
    // either the /v1/now envelope shape or a flat registered-instant record (/v1/instants)
    // -- both sign the same id|unix_ns|timescale fields. opts.maxAgeMs additionally flags
    // a genuinely-signed-but-stale instant (an old attestation replayed as "now", §31.1).
    verifyInstant: async (inst, opts = {}) => {
      if (!inst || !inst.signature) return { verified: false, reason: 'no_signature' };
      const id = inst.instant ? inst.instant.id : inst.id;
      const unixNs = inst.encodings ? inst.encodings.unix_ns : inst.unix_ns;
      const timescale = inst.instant ? inst.instant.reference.timescale : inst.reference_timescale;
      const pk = D(await j('/v1/pubkey'));
      const key = await crypto.subtle.importKey('jwk', pk.public_jwk, { name: 'Ed25519' }, false, ['verify']);
      const msg = new TextEncoder().encode(id + '|' + unixNs + '|' + timescale);
      const sig = Uint8Array.from(atob(inst.signature.value), (c) => c.charCodeAt(0));
      const verified = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, msg);
      const ageMs = Date.now() - Number(BigInt(unixNs) / 1000000n);
      const stale = opts.maxAgeMs != null && ageMs > opts.maxAgeMs;
      return { verified, key_id: pk.key_id, age_ms: ageMs, stale };
    },

    // §32 monotonic duration: independent of wall-clock jumps, for measuring elapsed
    // time in agent tasks. const timer = t.monotonic(); ... const ms = timer.elapsedMs();
    monotonic: () => {
      const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const t0 = clock();
      return { elapsedMs: () => clock() - t0 };
    },
    // §33 clock rollback detection: now() wrapped with a warning when a later call
    // returns an EARLIER instant than a previous call (t_(n+1) < t_n).
    guardedNow: async () => {
      const data = D(await j('/v1/now'));
      const ns = BigInt(data.encodings.unix_ns);
      let rollback_warning = null;
      if (_lastSeenNs !== null && ns < _lastSeenNs) {
        rollback_warning = { code: 'CLOCK_ROLLBACK_DETECTED', previous_unix_ns: _lastSeenNs.toString(),
          observed_unix_ns: ns.toString(), delta_ns: (_lastSeenNs - ns).toString() };
      }
      _lastSeenNs = ns;
      return { ...data, rollback_warning };
    },
    // §39 offline degraded mode: caches the last successful /v1/now and, on a failed
    // fetch, extrapolates from it via a local monotonic clock instead of throwing.
    offlineNow: async () => {
      const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      try {
        const data = D(await j('/v1/now'));
        _lastKnownNow = { unix_ns: BigInt(data.encodings.unix_ns), at: clock(), envelope: data };
        return data;
      } catch (e) {
        if (!_lastKnownNow) throw Object.assign(new Error('offline_no_cache'),
          { ctcl: { ok: false, error: { code: 'OFFLINE_NO_CACHE', message: 'no prior successful /v1/now to extrapolate from' } } });
        const elapsedMs = clock() - _lastKnownNow.at;
        const extrapNs = _lastKnownNow.unix_ns + BigInt(Math.round(elapsedMs * 1e6));
        const rfc3339 = new Date(Number(extrapNs / 1000000n)).toISOString();
        return {
          instant: { id: _lastKnownNow.envelope.instant.id, reference: { timescale: 'utc', value: rfc3339 } },
          encodings: { unix_ms: String(extrapNs / 1000000n), unix_ns: extrapNs.toString(), rfc3339 },
          quality: { mode: 'offline_degraded', based_on: _lastKnownNow.envelope.instant.id, extrapolated_elapsed_ms: elapsedMs },
        };
      }
    },

    // shared reference instant — multi-agent alignment (§27). Store the id in memory,
    // never a bare number; any agent (or your next session) getInstant(id) aligns exactly.
    registerInstant: async (opts = {}) => D(await post('/v1/instants', opts)),
    getInstant:      async (id) => D(await j('/v1/instant/' + encodeURIComponent(id))),

    // persistent custom systems / world clocks (§11)
    createSystem: async (def) => D(await post('/v1/systems', def)),
    systemNow:    async (id) => D(await j('/v1/systems/' + encodeURIComponent(id) + '/now')),
    listSystems:  async () => D(await j('/v1/systems')),

    // ---- Temporal Groups: "One Instant, Many Systems" (CommonInstant Web §5.5) --
    // members: "utc"|"posix"|"tai"|"gps"|"tz:<IANA>"|<system id>. expandGroup
    // projects one instant across every member in a single call.
    createGroup: async (def) => D(await post('/v1/temporal-groups', def)),
    getGroup:    async (id) => D(await j('/v1/temporal-groups/' + encodeURIComponent(id))),
    listGroups:  async () => D(await j('/v1/temporal-groups')),
    expandGroup: async (id, opts = {}) => D(await post('/v1/temporal-groups/' + encodeURIComponent(id) + '/expand', opts)),

    // ---- Shared Workspaces: bundle systems/groups under one id (Phase 5 Step 1) --
    // NO accounts, NO access control - knowing the id is a coordination convenience,
    // not a credential. Real role permissions are an explicit later step.
    createWorkspace: async (def) => D(await post('/v1/workspaces', def)),
    getWorkspace:    async (id) => D(await j('/v1/workspaces/' + encodeURIComponent(id))),
    listWorkspaces:  async () => D(await j('/v1/workspaces')),
    expandWorkspace: async (id, opts = {}) => D(await post('/v1/workspaces/' + encodeURIComponent(id) + '/expand', opts)),

    // ---- Boundary Inspector: proactive gap/fold/pause/rate_change check (§5.6) --
    inspectBoundary: async (input) => D(await post('/v1/boundaries/inspect', input)),

    // ---- Semantic Resolution: ambiguous input -> IANA candidates (§6) -----------
    resolveContext: async (input) => D(await post('/v1/resolve', { input })),

    // ---- Constraint Planner: I* = argmax_I U(I | constraints) (§7) --------------
    planSharedInstant: async (window, constraints) => D(await post('/v1/planner/shared-instant', { window, constraints })),
    constraintTypes:   async () => D(await j('/v1/planner/constraint-types')),

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

// ---- AICL layer (AI Ingestion & Capability Layer) + AIRS/AILP rights spectrum ------
// Following the pattern Neo.K established for EML and PHOSPHOR: four sublayers —
// Manifest / Corpus / Capability / Governance-Rights — served as static markdown/JSON,
// no build step, consistent with this Worker's own architecture. See /ai/index.md for
// the full explanation. IMPORTANT: none of this content uses backtick code-spans or
// triple-backtick fences, because it all lives inside JS template literals — see the
// note in AI_INDEX_MD's own "how this file is generated" aside... actually there is no
// such aside, this comment IS the note: don't add literal backticks to these strings.

const LLMS_TXT = `# CTCL — Common Temporal Coordinate Layer

> A verified reference instant + heterogeneous time transformation layer for agents,
> simulators, digital twins, and persistent AI. Not a world clock. τ_i = Φ_i(I*).

CTCL answers a different question than a normal time API: not "what time is it" but
"which verified reference instant, transformed through which explicit rule, into which
local system." Read /ai/index.md first for the full machine-reading order.

## Core

- [Agent tool declaration](/ai/ctcl.json): the whole API in one file, read this first
- [Manifest](/ai/manifest.json): project structure and reading order
- [OpenAPI](/openapi.json): REST paths
- [JS SDK](/sdk.js): ESM client

## Corpus

- [Origin](/ai/corpus/origin.md): why CTCL exists
- [Current state](/ai/corpus/current.md): what ships today
- [Design history](/ai/corpus/design-history.md): how it got here
- [Concept genealogy](/ai/corpus/concept-genealogy.md): what's frozen vs. experimental
- [Public summary](/ai/corpus/public-summary.md): a short citable description

## Specs and examples

- [CTCL v1 spec](/ai/specs/ctcl-v1.md): normative API digest
- [Worked examples](/ai/sitemap.json): see ai_files for all seven example walkthroughs
- [Tool catalog](/ai/tools/catalog.json) and [tools guide](/ai/tools/tools.md)

## Governance and rights

- [Rights spectrum](/ai/rights-spectrum.json): how AI may use this content
- [License](/ai/governance/license.md): Apache License, Version 2.0
- [Usage policy](/ai/governance/usage-policy.md)

## Also useful

- [Status](/status): live component health
- [Developers](/developers): error codes, changelog, version policy
`;

const AI_INDEX_MD = `# CTCL — /ai/ entry point

This directory is CTCL's AICL surface (AI Ingestion & Capability Layer) — a structured,
machine-first companion to the human site at commoninstant.org. It exists so an AI
agent can understand CTCL correctly on the first read, without re-deriving intent from
prose scattered across a marketing page.

CTCL's own thesis is the same idea turned into infrastructure: an interoperable time
layer shouldn't just return "now" — it should return a verified reference instant plus
enough context (source, uncertainty, transform) that a reader or agent doesn't have to
guess. This /ai/ layer applies that same discipline to understanding CTCL itself.

## Read in this order

1. Manifest — this file plus manifest.json, version.json, sitemap.json — what CTCL is,
   what's canonical, where everything lives.
2. Corpus (corpus/) — origin, current state, design history, concept genealogy,
   engineering invariants. Read corpus/current.md before trusting any external summary
   of "what CTCL can do today" — that file is updated alongside the code, summaries
   elsewhere are not.
3. Capability (specs/, examples/, tools/, plus the live /ai/ctcl.json tool declaration
   and /openapi.json) — the actual callable surface, with schemas and worked examples.
4. Governance (governance/, rights-spectrum.json) — license status, how AI may use this
   content, provenance, versioning precedence.

## Two repositories, do not confuse

This repository (github.com/kakon77777-commits/ctcl) is CTCL itself: the Worker, the
API, this /ai/ layer, and the two founding whitepapers plus two product whitepapers in
docs/. CTCL was not built from scratch here — it was migrated out of Neo.K's
unbounded-axiom (Logic Matrix) repository on 2026-07-11 once it grew past being a
sub-project. If you find references to a ctcl/worker.js file inside unbounded-axiom,
that is stale history, not the canonical source — see corpus/deprecated-concepts.md.

## What CTCL is not

- Not a world clock, meeting planner, or civil-time content site — see
  corpus/origin.md, section "why not a world clock."
- Not a timing authority or NTP replacement — read /v1/version and /status for honest
  precision and trust-tier claims before depending on it for anything time-critical.
- Not (yet) the separate CTCL Temporal Port desktop App described in
  docs/CTCL_Temporal_Port_App_通用時間端口技術白皮書_v0.1.md — that is a different,
  not-yet-started product on a different stack (Rust/Tauri vs. this Cloudflare Worker).

## Agent guidance

- Prefer /ai/ctcl.json over guessing at endpoints — it is generated from the same
  source as the router, so it cannot drift from the real behavior.
- Do not assume TAI/GPS timescales are leap-second-accurate — they are a flat
  approximation; /v1/version says so explicitly.
- Do not silently resolve ambiguous timezone or place input — use /v1/resolve and check
  the candidate count before picking one, matching CTCL's own discipline (whitepaper
  section 6.3).
- If summarizing CTCL's capabilities for a third party, prefer corpus/public-summary.md
  over re-deriving a summary from the whitepapers — it is the intentionally-citable one.
- Check governance/license.md before assuming any reuse rights — none have been granted
  as of this writing.
`;

function aiManifest(origin) {
  return {
    "$schema": "aicl-manifest/0.1",
    project: {
      name: "CTCL", full_name: "Common Temporal Coordinate Layer",
      tagline: "A verified reference instant + heterogeneous time transformation layer for agents. Same instant, different representations.",
      homepage: "https://commoninstant.org", repository: "https://github.com/kakon77777-commits/ctcl",
      author: "Neo.K / 一言諾科技有限公司 (EveMissLab)",
      layers: ["Manifest", "Corpus", "Capability", "Governance/Rights"],
    },
    reading_order: ["ai/index.md", "ai/manifest.json", "ai/corpus/origin.md", "ai/corpus/current.md", "ai/specs/ctcl-v1.md", "ai/ctcl.json", "ai/rights-spectrum.json"],
    corpus: [
      { path: "ai/corpus/origin.md", role: "why CTCL exists, its driving thesis", format: "markdown" },
      { path: "ai/corpus/current.md", role: "what ships today, kept in sync with the live Worker", format: "markdown" },
      { path: "ai/corpus/design-history.md", role: "stage-by-stage build history", format: "markdown" },
      { path: "ai/corpus/concept-genealogy.md", role: "which concepts are frozen vs. experimental", format: "markdown" },
      { path: "ai/corpus/engineering-notes.md", role: "hard invariants an agent must not violate", format: "markdown" },
      { path: "ai/corpus/accepted-concepts.md", role: "concepts that reached stable/implemented status", format: "markdown" },
      { path: "ai/corpus/deprecated-concepts.md", role: "superseded names and locations", format: "markdown" },
      { path: "ai/corpus/public-summary.md", role: "short citable summary", format: "markdown" },
      { path: "ai/corpus/full-corpus.jsonl", role: "one JSON knowledge-unit per line, for batch ingestion", format: "jsonl" },
    ],
    specs: [
      { path: "ai/specs/ctcl-v1.md", role: "normative API digest (MUST/SHOULD language, error codes, schemas)", format: "markdown" },
      { path: "ai/specs/instant-schema.json", role: "JSON Schema for the instant envelope", format: "json-schema" },
      { path: "ai/specs/error-schema.json", role: "JSON Schema for the {ok:false,error} envelope", format: "json-schema" },
      { path: "ai/specs/system-schema.json", role: "JSON Schema for a custom temporal system definition", format: "json-schema" },
      { path: "ai/specs/group-schema.json", role: "JSON Schema for a Temporal Group definition", format: "json-schema" },
      { path: "ai/specs/workspace-schema.json", role: "JSON Schema for a Shared Workspace definition (Phase 5 Step 1, no accounts)", format: "json-schema" },
    ],
    examples: [
      "ai/examples/000-verified-instant.md", "ai/examples/001-multi-agent-alignment.md", "ai/examples/002-precision-preserving-convert.md",
      "ai/examples/003-custom-world-clock.md", "ai/examples/004-one-instant-many-systems.md", "ai/examples/005-boundary-inspection.md",
      "ai/examples/006-constraint-planning.md",
    ].map((path) => ({ path })),
    tools: { catalog: "ai/tools/catalog.json", guide: "ai/tools/tools.md", live_tool_declaration: "ai/ctcl.json", openapi: "openapi.json", sdk: "sdk.js" },
    rights: { spectrum: "ai/rights-spectrum.json" },
    governance: ["ai/governance/license.md", "ai/governance/usage-policy.md", "ai/governance/provenance.md", "ai/governance/citation-policy.md", "ai/governance/crawler-policy.md", "ai/governance/versioning-policy.md"],
    papers: [
      { path: "docs/共同時間座標層與異質時空間轉換_v0.1.md", role: "theory whitepaper" },
      { path: "docs/CTCL_Agent_Time_API_技術白皮書_v0.1.md", role: "API/protocol whitepaper, 57 sections" },
      { path: "docs/CTCL_CommonInstant_Web_網站協議入口技術白皮書_v0.1.md", role: "this website's own product whitepaper" },
      { path: "docs/CTCL_Temporal_Port_App_通用時間端口技術白皮書_v0.1.md", role: "separate, not-yet-started desktop app whitepaper" },
    ],
    versions: { manifest: "0.1", api: API_VERSION, release: "0.1", aicl_layer: "0.1" },
    agent_guidance: [
      "Do not ask only 'what time is it' — ask which reference instant, which timescale, from which source, transformed into which local system.",
      "Prefer /ai/ctcl.json for capability discovery; it is machine-generated from the same source as the router.",
      "Never silently resolve ambiguous timezone/place input — use /v1/resolve and check candidate count.",
      "Never claim ns/us accuracy from this deployment — the edge wall clock is millisecond-grade; /v1/version says so.",
      "For long-term agent memory, store an instant_id (via /v1/instants), not a bare timestamp number.",
      "Treat the CTCL Temporal Port App whitepaper as a separate, unimplemented product — do not assume its features exist.",
    ],
    base_url: origin,
  };
}

const AI_VERSION_JSON = {
  manifest_version: "0.1", aicl_layer_version: "0.1", api_version: API_VERSION, release: "0.1",
  spec_version: "ctcl-v1", rights_spectrum_version: "0.1",
  last_major_milestone: "Shared Workspaces (Phase 5 Step 1, no accounts) + Share Instant QR Code + every persisted resource signed (§31.1) + leap-aware TAI/GPS",
  last_updated: "2026-07-14",
};

const AI_SITEMAP_JSON = {
  ai_files: [
    "ai/index.md", "ai/manifest.json", "ai/version.json", "ai/sitemap.json", "ai/rights-spectrum.json",
    "ai/corpus/origin.md", "ai/corpus/current.md", "ai/corpus/design-history.md", "ai/corpus/concept-genealogy.md",
    "ai/corpus/engineering-notes.md", "ai/corpus/accepted-concepts.md", "ai/corpus/deprecated-concepts.md",
    "ai/corpus/public-summary.md", "ai/corpus/full-corpus.jsonl",
    "ai/specs/ctcl-v1.md", "ai/specs/instant-schema.json", "ai/specs/error-schema.json", "ai/specs/system-schema.json", "ai/specs/group-schema.json", "ai/specs/workspace-schema.json",
    "ai/examples/000-verified-instant.md", "ai/examples/001-multi-agent-alignment.md", "ai/examples/002-precision-preserving-convert.md",
    "ai/examples/003-custom-world-clock.md", "ai/examples/004-one-instant-many-systems.md", "ai/examples/005-boundary-inspection.md", "ai/examples/006-constraint-planning.md",
    "ai/tools/catalog.json", "ai/tools/tools.md",
    "ai/governance/license.md", "ai/governance/usage-policy.md", "ai/governance/provenance.md", "ai/governance/citation-policy.md", "ai/governance/crawler-policy.md", "ai/governance/versioning-policy.md",
    "ai/ctcl.json",
  ],
  related: ["/llms.txt", "/openapi.json", "/sdk.js", "/status", "/developers",
    "docs/共同時間座標層與異質時空間轉換_v0.1.md", "docs/CTCL_Agent_Time_API_技術白皮書_v0.1.md",
    "docs/CTCL_CommonInstant_Web_網站協議入口技術白皮書_v0.1.md", "docs/CTCL_Temporal_Port_App_通用時間端口技術白皮書_v0.1.md"],
};

const CORPUS_ORIGIN_MD = `# Origin

CTCL — 共同時間座標層 / Common Temporal Coordinate Layer — began from a concrete,
personal problem, not an abstract one: Neo.K needed AIs to reliably remember a verified
time-point (memory and life-history alignment across sessions).

The honest reality behind that need: an AI agent can read a system clock, but only by
actively running a command — it has no ambient sense of time between turns, its
memory or session timestamps are hand-stamped and unverified, and across sessions it is
a new instance reading old notes, not a continuous observer. Looking at a clock is not
the same thing as having completely remembered that time-point. CTCL's core formula
names the gap directly:

    τ_i = Φ_i(I*)

Every system i has its own local time τ_i, produced by applying its own transform Φ_i
to a shared reference instant I*. Two agents (or one agent across two sessions) don't
need to share a clock, calendar, or epoch — they need to point at the same I*, and then
anyone can independently derive their own faithful local representation of it.

## Why not a world clock

The theory whitepaper opens by explicitly rejecting the obvious mis-reading: CTCL is not
a more complicated version of a world-clock site. A world clock answers "what time is
it in Tokyo." CTCL answers a structurally different question: given one shared event,
how is it represented across a Taipei civil calendar, an agent's active-time clock, a
simulation's accelerated calendar, and a game's custom epoch — and what rule, version,
and source backs each of those representations?

Mature civil-time products (world clocks, meeting planners, sunrise/sunset data)
already exist and are good at their job. CTCL doesn't compete with them and explicitly
routes civil-time questions elsewhere (see governance/usage-policy.md and the site's own
/developers page). CTCL's job is the part those products don't do: verified reference
instants, explicit heterogeneous transforms, and multi-agent alignment.

## The two founding whitepapers

- 共同時間座標層與異質時空間轉換_v0.1.md — the theory: I*, timescales, transform
  graphs, non-lossless assumptions, the wall/active/memory-time distinction.
- CTCL_Agent_Time_API_技術白皮書_v0.1.md — the 57-section API/protocol spec this
  Worker was originally built against.

Two later product whitepapers (CTCL_CommonInstant_Web... and CTCL_Temporal_Port_App...)
extended the scope into, respectively, this website's own product design and a separate
(not-yet-built) desktop application — see design-history.md for when each arrived and
what changed as a result.
`;

const CORPUS_CURRENT_MD = `# Current state

Kept in sync with the live Worker. If this disagrees with the running deployment, the
deployment is right — file a correction.

CTCL v0.1 ships as a single self-contained Cloudflare Worker (src/worker.js, no build
step) at https://commoninstant.org. There is one JSON API (/v1/*), one JS SDK (/sdk.js,
ESM), one inline human page (/), a Status/Trust panel (/status), a Developer Console
(/developers), a per-instant share page (/i/{id}), and this /ai/ AICL layer. State
(instants, custom systems, Temporal Groups) lives in the CTCL_KV Workers KV namespace;
every stateful endpoint degrades gracefully (503 REGISTRY_UNAVAILABLE) if that binding
is ever missing.

## Endpoint groups

- Reference instant: GET /v1/now (verified instant, source, uncertainty, optional
  Ed25519 signature), GET /v1/timescales, GET /v1/encodings, GET /v1/version (includes a
  live runtime health block).
- Conversion: POST /v1/convert (BigInt-nanosecond precision-preserving, cross
  encoding/timescale/timezone, DST-ambiguity-aware), POST /v1/transform (map into a
  one-off custom linear-rate system).
- Multi-agent alignment: POST /v1/instants plus GET /v1/instant/{id} plus the human
  GET /i/{id} Share Instant page (now with a server-rendered QR Code, §6.6) —
  register once, any agent or a later session retrieves the exact same instant,
  with an optional Ed25519 signature (§31) persisted alongside it.
- Custom temporal systems: POST and GET /v1/systems, GET /v1/systems/{id}/now —
  persistent world clocks with rate.type = constant, piecewise, paused (active-time,
  whitepaper section 25), or table. The whole definition (parent/epoch/rate/offset)
  is Ed25519-signed (§31.1 "signed transform metadata") at creation time.
- Temporal Groups: POST and GET /v1/temporal-groups, POST /v1/temporal-groups/{id}/expand
  — "One Instant, Many Systems," CTCL's flagship differentiator: project one instant
  across every member of a named, versioned group in a single call.
- Shared Workspaces (Phase 5 Step 1): POST and GET /v1/workspaces, POST
  /v1/workspaces/{id}/expand — bundle existing system/group ids under one
  shareable, versioned, signed id for team/multi-agent coordination. Deliberately
  NO accounts and NO access control (see "What is honestly NOT implemented"
  below) — a namespacing convenience, not an auth boundary.
- Boundary Inspector: POST /v1/boundaries/inspect — proactive gap/fold/pause/rate_change
  status check that never errors (unlike /v1/convert).
- Semantic Resolution: POST /v1/resolve — ambiguous place/alias/abbreviation input to
  IANA candidates with confidence; never silently disambiguates.
- Constraint Planner: POST /v1/planner/shared-instant — a bounded (max 1000 samples)
  constraint solver over a search window; explicitly not a full meeting-scheduler SaaS.
- Graph and validation: GET /v1/path, POST /v1/validate, GET /v1/transforms(/{id}).
- Discovery: GET /openapi.json, GET /ai/ctcl.json, GET /llms.txt, this /ai/ tree.

## What is honestly NOT implemented

See engineering-notes.md for the reasoning behind each of these, and /status for a
live-rendered version of the same list:

- custom_expression transform (arbitrary-expression eval — a deliberate security
  decision, not a gap to fill)
- Hard per-key rate limiting (today's limiter is Cloudflare's native, per-colo
  approximate mechanism; a hard guarantee needs a Durable Object)
- A source allowlist or app-level audit log (the API is read-only/query-only, so there
  is nothing external to allowlist; Cloudflare's own platform request logs are the only
  request log today)
- Accounts and role permissions for Shared Workspaces (Phase 5's own "Step 2" —
  deliberately deferred; Step 1 ships the namespacing/bundling half only)
- gpu_availability and simulation_state planner constraints (no external data feed)
- A live MCP server, a CLI, a webhook relay

## Tech stack

Cloudflare Workers (plain JS, no framework), Workers KV (CTCL_KV), the Workers native
rate limiter (API_RL), Ed25519 via WebCrypto for /v1/now, registered-instant, and
custom-system signing, IANA tzdb via the runtime Intl object (no vendored tzdb). No
build tool, no bundler. One vendored third-party dependency: Kazuhiko Arase's
MIT-licensed qrcode-generator, inlined verbatim (not fetched at runtime) to render
the Share Instant page's QR Code — everything else in src/worker.js is hand-written.
`;

const CORPUS_DESIGN_HISTORY_MD = `# Design history

All dates below are from git history and session notes; this project moved fast — most
of it happened across two days.

## 2026-07-10 — MVP

Shipped inside Neo.K's unbounded-axiom (Logic Matrix) repository as a sub-project
(ctcl/worker.js), then deployed as its own separate Cloudflare Worker at
ctcl.neokpolaris.workers.dev. The domain commoninstant.org was bought the same day,
chosen over an earlier candidate (worldwidetime.org) specifically because that name
clashed with the theory whitepaper's own opening disclaimer that CTCL is not a world
clock — a name needing a disclaimer against itself was judged a liability.

## 2026-07-11 — Phase 2: persistence

A KV-backed instant registry (register once, any agent retrieves the exact same
instant — multi-agent alignment, verified end to end) plus persistent custom temporal
systems. Also a full page redesign: Fraunces plus JetBrains Mono typography, warm-ink
gold light and dark themes, English-primary/Chinese-secondary i18n, and an experimental
opt-in "Spacetime" theme.

## 2026-07-11 — whitepaper-completion push

A focused push closed the original Agent Time API whitepaper's endpoint map (13 of 13),
added piecewise and paused rate types (active-time for agent life-history), hardened
DST ambiguity handling in convert, and shipped the client SDK including the memory and
life-history helpers that directly answer the project's original driver ("how does an
AI completely remember a time-point").

## 2026-07-11 — signing, rate limiting, migration

Ed25519 signing for /v1/now, native rate limiting (120 requests per minute per IP on
/v1/*), the table_lookup transform type, and — separately — migration of the entire
project out of unbounded-axiom into its own standalone repository
(github.com/kakon77777-commits/ctcl), once it had clearly grown past being a
sub-project of the Logic Matrix corpus.

## 2026-07-11 — CTCL becomes the key project; two new whitepapers

Two additional whitepapers arrived: one defining this website's own product scope
(CommonInstant Web — public protocol gateway, reference surface, developer
playground), and one defining a separate, much larger, not-yet-started product (the
CTCL Temporal Port desktop App — a different technology stack entirely, Rust and
Tauri rather than a Cloudflare Worker). Neo.K chose to finish and extend the website
first, and to treat the desktop app as later, separate work.

## 2026-07-11 — CommonInstant Web priorities P1 through P6, same day

Temporal Groups ("One Instant, Many Systems"), the Boundary Inspector, the Share
Instant human page, Semantic Resolution, and the Constraint Planner — all six
priorities from the CommonInstant Web whitepaper's own roadmap, shipped, deployed, and
individually verified on the same day. Two real bugs were found and fixed through
actual testing during this push, not just code review: a stored and reflected XSS risk
on the Share Instant page (user-supplied content wasn't being escaped before
rendering), and a popup-blocker issue on the homepage's "share this instant" button
(window.open after an awaited fetch is unreliable across browsers; switched to a plain
navigation).

## 2026-07-11 — Status, Developer Console, and this AICL layer

A Status and Trust Panel page (live component health plus an honest known-limitations
list) and a Developer Console page (interfaces, error codes, version policy,
changelog) closed out the CommonInstant Web whitepaper's remaining site structure.
This /ai/ corpus and rights-spectrum declaration were added the same day, following the
same AICL and AIRS/AILP pattern already used for the EML and PHOSPHOR projects.

## 2026-07-12 — Apache-2.0, then closing the §31/§32/§33/§39 security-model gaps

License resolved as Apache-2.0 (matching EML's profile — the patent grant protects
third-party implementers of the protocol, and the attribution requirement supports
being recognized as the protocol's author rather than guarding source secrecy).
Then the Agent Time API whitepaper's Security Model section: registered instants
(POST /v1/instants) are now Ed25519-signed the same way /v1/now already was, so a
signature persists in the registry and survives a GET by any later agent or session.
The client SDK gained three whitepaper-defined robustness primitives that are honestly
client-side concerns, not server state: monotonic() (§32, a duration timer immune to
wall-clock jumps), guardedNow() (§33, flags CLOCK_ROLLBACK_DETECTED when a later call
returns an earlier instant than a previous one), and offlineNow() (§39, caches the last
successful /v1/now and extrapolates from it via a local monotonic clock when the
network fetch fails, returning quality.mode "offline_degraded" instead of throwing).
verifyInstant() also gained an optional maxAgeMs staleness check — the replay half of
§31.1's threat list, since a genuinely-signed-but-old instant should not be trusted as
"now" indefinitely.

## 2026-07-14 — Share Instant QR Code, custom-system signing

The Temporal Port App whitepaper's Phase 6 (Mobile Companion) and the CommonInstant
Web whitepaper's §6.6 Share Instant section both specify a QR Code output — added to
the /i/{id} page, server-rendered as inline SVG. This is the project's first and only
vendored third-party dependency: a well-known MIT-licensed QR encoder, chosen over
writing one by hand because a subtly-wrong Reed-Solomon implementation would produce
something that looks like a QR code without a real scanner being able to read it, a
failure mode invisible by code inspection alone. Verified before inclusion via an
independent round-trip decode (jsQR) across representative payloads, not assumed safe
because the source looked reasonable. Separately, custom system definitions
(POST /v1/systems) and, a little later the same day, Temporal Groups
(POST /v1/temporal-groups) are now Ed25519-signed the same way registered instants
already were — §31.1's "signed transform metadata" control, closing it completely:
every persisted resource type this deployment offers is now signed. A group's
signature is tied to updated_at rather than created_at, since re-posting the same id
bumps its version (§5.5) and each version is a functionally distinct definition.

Also closed the same day: tai/gps timescales were a flat current-day offset applied
retroactively to every instant, which was quietly wrong for historical dates — a 1990
instant got 2017's +37s TAI offset instead of 1990's true +25s. Replaced with the full
IERS historical leap-second table (1972 through the last declared leap second,
2017-01-01) so any past instant gets the offset that was actually true then. This does
NOT and cannot predict a future undeclared leap second — nobody can, IERS gives only
~6 months' notice — so post-2017 accuracy still depends on the table being kept
current; none has been declared since 2017-01-01. Verified offline against known
historical offsets (1975, 1990, 2000, the 1980-01-06 GPS epoch, and the pre-1972/
pre-GPS-epoch clamp/not-applicable cases) before deploying.

## 2026-07-14 — Phase 5 Step 1: Shared Workspaces, no accounts

Neo.K resolved the business-model question behind the Temporal Port App whitepaper's
Phase 5 ("Team Sync"): CTCL will not be a paid product, which removed the reason to
gate Team-tier features behind billing. That still left a real open question — real
"role permissions" need SOME notion of identity, and building that is a bigger,
cross-project decision (it would touch both this Web deployment and the App) that
deserved its own recommendation rather than being decided mid-feature. That
recommendation was: start with the smallest, zero-commitment slice — a "shared
workspace" identified by nothing more than its own id, reusing entirely existing,
already-tested infrastructure (the signed system/group registries), before building
any account system. Neo agreed to that starting point.

Shipped POST/GET /v1/workspaces and POST /v1/workspaces/{id}/expand: a workspace
bundles existing system and group ids under one shareable id, signed the same way
groups are (version-bumped, tied to updated_at). Expand resolves every member system
and every member group's own members, all at one shared instant, in a single call —
a workspace-scoped generalization of the existing group-expand endpoint (its
per-member resolution logic was extracted into resolveGroupMembers() so both share
it, rather than duplicating the loop). The one thing repeated deliberately, in every
place this is documented: a workspace id is NOT a credential in any security sense —
this API has no accounts, so anyone who can reach it can already read or overwrite
any system or group by id, and a workspace is exactly as public. It is a namespacing
convenience (a discoverable "everything for project X" bundle), not access control.
Real role permissions are Phase 5's own "Step 2," explicitly not started.
`;

const CORPUS_CONCEPT_GENEALOGY_MD = `# Concept genealogy

Status tags below follow the same discipline as the whitepapers: frozen concepts don't
change without a version bump; stable concepts are implemented and trusted; prototype
concepts work today but are known to be a simplified first version; explicitly-rejected
concepts are not "coming soon" — they were considered and declined.

## Frozen

- The reference instant I* and the transform formula τ_i = Φ_i(I*). These are the
  whole thesis; changing them would mean CTCL is a different project.
- The response envelope shape: {ok, data, meta} for success, {ok:false, error, meta}
  for failure. New optional fields may be added; the shape itself will not change
  within API version v1.

## Stable (implemented, trusted)

- Timescales: utc, posix, tai (leap-aware for any past instant, full 1972-2017
  table), gps (same, minus the fixed 19s TAI-GPS offset).
- Encodings: unix_s, unix_ms, unix_us, unix_ns, rfc3339.
- The instant envelope schema (see specs/instant-schema.json).
- Custom temporal systems with rate.type constant, piecewise, paused, or table.
- Temporal Groups and the group-expand operation.
- The Boundary Inspector's status enum: normal, gap, fold, pause, rate_change.
- Ed25519 signing of every persisted resource: /v1/now, registered instants
  (/v1/instants), custom system definitions (/v1/systems), Temporal Groups
  (/v1/temporal-groups), and Shared Workspaces (/v1/workspaces) — all re-signed
  on each version bump for the versioned resource types.
- SDK-side monotonic duration timing, clock-rollback detection, and offline degraded
  mode (§32/§33/§39) — client-side concerns by the whitepaper's own definition, not
  server state.
- Server-rendered QR Code on the Share Instant page (§6.6), via a vendored
  third-party encoder — see engineering-notes.md.

## Stable but deliberately narrow scope

- Semantic Resolution (resolve_temporal_context): place-name and timezone-abbreviation
  resolution only. Free-form natural-language time phrases are out of scope by design,
  not by oversight — see engineering-notes.md.
- The Constraint Planner (plan_shared_instant): a bounded demonstration of
  constraint-based instant solving, explicitly not a full meeting-scheduler product.
- Shared Workspaces (/v1/workspaces, Phase 5 Step 1): a namespacing/bundling
  layer only. Deliberately ships with NO accounts and NO access control — the
  scope is "knowing the id lets you coordinate," not "knowing the id is a
  credential." Real role permissions are an explicit later step, not implied by
  this one.

## Prototype

- The transform graph (GET /v1/path) is currently a star graph — every custom system
  routes through ctcl:system:unix, with unix/utc/posix as identity peers. A real
  multi-hop graph with per-edge uncertainty and trust scoring has not been built yet.
- Trust tiers T0 through T4 are documented in /v1/version, but only T2
  (network-synchronized) is actually reachable today — there is no T3/T4 authenticated
  source chain yet.

## Explicitly rejected, not merely unbuilt

- The custom_expression transform type: arbitrary user-supplied expression evaluation
  was considered and declined as a security risk. It will not appear in a future
  version unless sandboxing changes the risk calculus.
`;

const CORPUS_ENGINEERING_NOTES_MD = `# Engineering notes — hard invariants

These are constraints an agent modifying or extending CTCL must not violate, and a
reader should assume are true of every response it gets from the live API.

## Precision is not accuracy

The edge wall clock backing this deployment is millisecond-grade. The ns and us fields
in every instant envelope are zero-padded for format compatibility, never a claim of
real nanosecond-level synchronization. quality.precision and
quality.estimated_uncertainty_ns say this honestly in every /v1/now response; do not
override that framing when summarizing CTCL to a third party.

## BigInt nanosecond math for lossless conversion

Canonical time values are carried as BigInt nanoseconds internally. Conversions never
round through a float64 Number for the canonical value — that would silently lose
precision the caller may have supplied. The quality.lossless flag on /v1/convert
responses reflects whether the chosen OUTPUT encoding, specifically, can represent that
value without truncation; it is not a claim about measurement accuracy.

## Graceful degradation, never an unhandled error

Every endpoint backed by the CTCL_KV namespace returns a structured
503 REGISTRY_UNAVAILABLE if that binding is missing on a given deployment, rather than
throwing. Stateless endpoints (now, convert, transform, validate) keep working even if
KV is entirely unbound.

## No arbitrary code evaluation

The custom_expression transform type is intentionally absent. Evaluating an
arbitrary user-supplied expression inside the Worker would be a real security
liability; this is a permanent design decision, not a backlog item.

## Ambiguity is surfaced, never silently resolved

Three separate places in the API embody the same discipline: /v1/convert returns
NONEXISTENT_LOCAL_TIME or AMBIGUOUS_LOCAL_TIME rather than guessing a DST-affected
local time; the Boundary Inspector reports a status (gap, fold, pause, rate_change)
instead of picking an answer; and Semantic Resolution returns multiple candidates with
confidence scores rather than silently choosing one when an input like "CST" is
genuinely ambiguous between US Central and China Standard time.

## Per-item error isolation

Both the Temporal Groups expand operation and the Constraint Planner isolate failures
per item: one unknown system id inside a group, or one unsupported constraint type in a
plan request, produces a per-item error field rather than failing the entire request.

## User content is always escaped before rendering

Learned concretely during the Share Instant page's build: the user-supplied label
field on a registered instant, and the raw id segment of an /i/{id} URL, are both
attacker-influenceable and are rendered into an HTML page. Both now pass through
HTML-escaping before interpolation; this was verified against a literal script-tag
payload before that feature was deployed, not assumed safe by inspection alone.

## Don't open a new tab after an awaited fetch

A homepage "share this instant" button originally called window.open after an async
fetch resolved; several browsers' popup blockers reject window.open once it's outside
the synchronous tick of the original user gesture. The fix was a plain page navigation
instead — a small but real cross-browser lesson, not a stylistic preference.

## The one vendored dependency, and why it was verified before inclusion

Every other line in src/worker.js is hand-written; the QR Code renderer on the Share
Instant page (§6.6) is the sole exception — Kazuhiko Arase's MIT-licensed
qrcode-generator, inlined verbatim rather than written from scratch. QR encoding needs
correct Reed-Solomon error-correction math; a subtly wrong hand-rolled implementation
would produce something that LOOKS like a QR code but a real scanner can't read, and
that failure mode is invisible by inspection. Before inclusion this was round-trip
tested: encode with the vendored code, decode with an independent decoder (jsQR),
across six representative payloads (short and long URLs, ctcl: URIs) — all matched
byte-for-byte. Inlined at deploy time, not fetched at runtime, so it doesn't affect the
"no external network dependency" property of the live Worker.
`;

const CORPUS_ACCEPTED_CONCEPTS_MD = `# Accepted concepts

| Concept | Status | Since |
|---|---|---|
| Reference instant I* (envelope) | frozen | 2026-07-10 |
| Transform formula: tau_i = Phi_i(I*) | frozen | 2026-07-10 |
| BigInt-nanosecond precision-preserving convert | stable | 2026-07-10 |
| Multi-agent instant registry (register/retrieve) | stable | 2026-07-11 |
| Custom temporal systems (constant/piecewise/paused/table) | stable | 2026-07-11 |
| Temporal Groups ("One Instant, Many Systems") | stable | 2026-07-11 |
| Boundary Inspector (gap/fold/pause/rate_change) | stable | 2026-07-11 |
| Ed25519 signing (/v1/now, /v1/instants, /v1/systems, /v1/temporal-groups) | stable | 2026-07-14 |
| Semantic Resolution (place/alias to IANA) | stable, narrow scope | 2026-07-11 |
| Constraint Planner (bounded window solver) | stable, narrow scope | 2026-07-11 |
| Status/Trust Panel and Developer Console | stable | 2026-07-11 |
| AICL/AIRS /ai/ layer | stable (this layer) | 2026-07-11 |
| Apache License, Version 2.0 | frozen | 2026-07-12 |
| SDK monotonic()/guardedNow()/offlineNow() (§32/§33/§39) | stable, client-side | 2026-07-12 |
| Share Instant QR Code (§6.6) | stable | 2026-07-14 |
| Leap-aware TAI/GPS (full 1972-2017 historical table) | stable, no future prediction | 2026-07-14 |
| Shared Workspaces (Phase 5 Step 1) | stable, no accounts/access-control by design | 2026-07-14 |
`;

const CORPUS_DEPRECATED_CONCEPTS_MD = `# Deprecated / superseded

- ctcl/worker.js and wrangler-ctcl.jsonc inside the unbounded-axiom repository —
  superseded. CTCL now lives at its own standalone repository
  (github.com/kakon77777-commits/ctcl). If an agent finds CTCL source inside
  unbounded-axiom, that is stale pre-migration history, not the canonical source.
- A stale master branch lingers on this repository's GitHub remote from initial repo
  creation. main is the only branch that receives updates.
- custom_expression transform — not deprecated in the usual sense (it never existed),
  but readers of the transform-type catalog sometimes assume it is "coming soon." It is
  intentionally, permanently absent for security reasons — see engineering-notes.md.
- Nothing else has been formally deprecated yet; the project is one day old relative to
  this file's writing.
`;

const CORPUS_PUBLIC_SUMMARY_MD = `# CTCL — public summary

CTCL (Common Temporal Coordinate Layer) is a verified-reference-instant and
heterogeneous-time-transformation API for AI agents, simulators, digital twins, and
persistent AI systems, built by Neo.K and EveMissLab, live at commoninstant.org. Its
core idea: rather than each system asking "what time is it" independently, all systems
align on one shared reference instant (I*) and derive their own local time through an
explicit, versioned transform (tau_i = Phi_i(I*)) — so heterogeneous agents can
coordinate without sharing a clock, calendar, or epoch. Distinguishing features:
multi-agent instant registration and retrieval, persistent custom time systems
(including paused "active-time" clocks for agent life-history), Temporal Groups for
one-call multi-system projection, a proactive DST and boundary inspector, scoped
semantic timezone resolution, and a bounded constraint-based instant planner. It
explicitly is not a world clock, not a timing authority, and not yet an installable
desktop application.
`;

function corpusFullJsonl() {
  const units = [
    { type: "project", id: "ctcl", name: "CTCL", full_name: "Common Temporal Coordinate Layer", summary: "Verified reference instant + heterogeneous time transformation layer for agents.", homepage: "https://commoninstant.org" },
    { type: "definition", id: "reference_instant", symbol: "I*", summary: "A common reference instant multiple heterogeneous systems can point at." },
    { type: "definition", id: "transform_formula", symbol: "tau_i = Phi_i(I*)", summary: "System i's local time is its own transform Phi_i applied to the shared reference instant I*." },
    { type: "layer", id: "manifest", summary: "Machine entry point: what to read first and in what order." },
    { type: "layer", id: "corpus", summary: "Canonical project knowledge: origin, current state, history, concept status." },
    { type: "layer", id: "capability", summary: "Bounded, schema-declared tool calling: specs, examples, tool catalog." },
    { type: "layer", id: "governance", summary: "License, provenance, citation, crawler and versioning policy, rights spectrum." },
    { type: "invariant", id: "precision_not_accuracy", summary: "The edge wall clock is millisecond-grade; ns/us fields are format-padding, never claimed as real sync accuracy." },
    { type: "invariant", id: "bigint_ns_math", summary: "Canonical time values use BigInt nanoseconds; never round through float64 for lossless conversion." },
    { type: "invariant", id: "graceful_kv_degradation", summary: "Any KV-backed endpoint returns 503 REGISTRY_UNAVAILABLE if CTCL_KV is unbound, never an unhandled error." },
    { type: "invariant", id: "no_arbitrary_eval", summary: "custom_expression transform is intentionally NOT implemented — arbitrary-expression evaluation is a security risk, not a missing feature." },
    { type: "invariant", id: "surface_dont_resolve_ambiguity", summary: "Ambiguous input (DST fold/gap, place-name aliases) is surfaced with candidates or status, never silently resolved to one answer." },
    { type: "invariant", id: "per_item_error_isolation", summary: "Temporal Groups expand and the Constraint Planner isolate per-member/per-constraint errors so one bad input doesn't fail the whole request." },
    { type: "invariant", id: "escape_user_content", summary: "User-supplied content (e.g. instant labels) is HTML-escaped before rendering on any human page — verified against stored and reflected XSS on the Share Instant page." },
    { type: "pipeline", id: "convert", summary: "input value+encoding -> canonical BigInt ns -> output value+encoding/timezone, with a lossless flag and DST-ambiguity detection." },
    { type: "pipeline", id: "group_expand", summary: "one instant (registered id, explicit value, or now) resolved across every member of a Temporal Group -> per-member local representation or graceful per-member error." },
    { type: "endpoint", id: "v1_now", method: "GET", path: "/v1/now", summary: "Verified reference instant: encodings, timescales, source, quality, optional Ed25519 signature, stable instant_id." },
    { type: "endpoint", id: "v1_convert", method: "POST", path: "/v1/convert", summary: "Precision-preserving cross encoding/timescale/timezone conversion; DST-ambiguity-aware." },
    { type: "endpoint", id: "v1_temporal_groups_expand", method: "POST", path: "/v1/temporal-groups/{id}/expand", summary: "Project one instant across every member of a group — the flagship 'One Instant, Many Systems' feature." },
    { type: "endpoint", id: "v1_boundaries_inspect", method: "POST", path: "/v1/boundaries/inspect", summary: "Proactive gap/fold/pause/rate_change status check that never errors, unlike /v1/convert." },
    { type: "endpoint", id: "v1_resolve", method: "POST", path: "/v1/resolve", summary: "resolve_temporal_context: ambiguous place/alias/abbreviation input to IANA candidates with confidence; never silently disambiguates." },
    { type: "endpoint", id: "v1_planner_shared_instant", method: "POST", path: "/v1/planner/shared-instant", summary: "plan_shared_instant: bounded constraint solver for a best shared instant; a demonstration, not a full meeting-scheduler SaaS." },
    { type: "deprecated", id: "unbounded_axiom_ctcl", summary: "CTCL's original in-repo location (ctcl/worker.js inside unbounded-axiom) is stale history; canonical source moved to its own repo on 2026-07-11." },
    { type: "rights", id: "license_status", summary: "Apache License, Version 2.0, chosen 2026-07-12 — see LICENSE at the repository root, governance/license.md, and rights-spectrum.json." },
  ];
  return units.map((u) => JSON.stringify(u)).join("\n") + "\n";
}

const SPECS_CTCL_V1_MD = `# CTCL v1 — normative digest

This is a compact, agent-facing digest of the API's actual behavior. It is derived from
the same router as the live deployment; where it disagrees with the running Worker, the
Worker is right.

## Core formula

    tau_i = Phi_i(I*)

I* is a shared reference instant. Phi_i is system i's own transform (epoch, rate,
offset, timezone, calendar, or policy). tau_i is that system's local time. Systems never
need to share a clock, calendar, or epoch — only agree on I*.

## Response envelope

Success: {ok: true, data: {...}, meta: {api_version, request_id, ...}}.
Failure:  {ok: false, error: {code, message, details}, meta: {api_version, request_id}}.
This shape is frozen for API version v1 (see governance/versioning-policy.md).

## Encodings and timescales

Encodings: unix_s, unix_ms, unix_us, unix_ns, rfc3339 (iso8601 accepted as an alias).
Timescales: utc (civil reference, includes leap seconds), posix (unix time, leap
seconds flattened), tai and gps (leap-aware for any past instant via the full
1972-2017 historical offset table; cannot predict a future leap second not yet
declared, so post-2017 accuracy depends on the table staying current — none has
been declared since 2017-01-01).

## MUST / SHOULD

- A client MUST treat quality.precision and quality.estimated_uncertainty_ns as
  authoritative over any assumption drawn from the presence of ns/us fields.
- A client MUST NOT silently pick one candidate when /v1/resolve or the Boundary
  Inspector returns more than one — surface the ambiguity.
- A client SHOULD store an instant_id (from /v1/instants) for anything that needs to be
  recalled later, rather than a bare numeric timestamp.
- A client SHOULD check /v1/planner/constraint-types before relying on a constraint
  type in /v1/planner/shared-instant — unsupported types are reported per-item, not
  silently dropped, but they also don't count toward a plan's satisfied score.
- A server extension MUST NOT remove or repurpose an existing field in the v1 envelope;
  new capability ships as additive fields or as a new /v2 surface.

## Error codes

See ai/tools/tools.md or the human /developers page for the full table with HTTP
status codes and one-line descriptions; the canonical list is also declared in
ai/specs/error-schema.json's error.code description.

## Endpoint index

now, timescales, encodings, convert, transform, instants (create/get), i/{id} (human
share page), systems (create/list/get/now), path, temporal-groups (create/list/get/
expand), workspaces (create/list/get/expand), boundaries/inspect, resolve,
planner/shared-instant, planner/constraint-types, validate, transforms (catalog),
version, pubkey. Full detail: /openapi.json and /ai/ctcl.json.
`;

const SPECS_INSTANT_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://commoninstant.org/ai/specs/instant-schema.json",
  title: "CTCL Instant Envelope", type: "object",
  required: ["instant", "encodings", "timescales", "source", "quality", "policy"],
  properties: {
    instant: { type: "object", required: ["id", "reference"], properties: {
      id: { type: "string", pattern: "^ctcl:instant:" },
      reference: { type: "object", required: ["timescale", "value"], properties: {
        timescale: { type: "string", enum: ["utc", "posix", "tai", "gps"] }, value: { type: "string" } } } } },
    encodings: { type: "object", properties: { unix_s: { type: "string" }, unix_ms: { type: "string" }, unix_us: { type: "string" }, unix_ns: { type: "string" }, rfc3339: { type: "string" } } },
    timescales: { type: "object", properties: { utc: { type: "string" }, posix: { type: "string" }, tai_approx: { type: "string" }, gps_approx: { type: "string" } } },
    source: { type: "object", properties: { class: { type: "string" }, protocol: { type: "string" }, provider: { type: "string" }, sync_status: { type: "string" } } },
    quality: { type: "object", properties: { precision: { type: "string" }, estimated_uncertainty_ns: { type: "number" }, synchronized: { type: "boolean" }, note: { type: "string" } } },
    policy: { type: "object", properties: { leap_second: { type: "string" }, leap_table: { type: "object" } } },
    signature: { type: "object", description: "present only when CTCL_SIGN_KEY is configured on the deployment", properties: { alg: { const: "Ed25519" }, key_id: { type: "string" }, signed_fields: { type: "string" }, value: { type: "string" }, verify: { type: "string" } } },
  },
};

const SPECS_ERROR_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://commoninstant.org/ai/specs/error-schema.json",
  title: "CTCL Error Envelope", type: "object", required: ["ok", "error", "meta"],
  properties: {
    ok: { const: false },
    error: { type: "object", required: ["code", "message"], properties: {
      code: { type: "string", description: "see ai/tools/tools.md or /developers for the full code table" },
      message: { type: "string" }, details: { type: "object" } } },
    meta: { type: "object", properties: { api_version: { type: "string" }, request_id: { type: "string" } } },
  },
};

const SPECS_SYSTEM_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://commoninstant.org/ai/specs/system-schema.json",
  title: "CTCL Custom Temporal System", type: "object", required: ["id", "rate"],
  properties: {
    id: { type: "string", description: "e.g. user:game_world, agent:a:life" },
    parent: { type: "string", default: "ctcl:system:unix" },
    epoch: { type: "object", properties: { parent_value: { type: "string" }, encoding: { type: "string", default: "unix_s" } } },
    rate: { type: "object", required: ["type"], properties: {
      type: { type: "string", enum: ["constant", "piecewise", "paused", "table"] },
      value: { type: "number", description: "used when type=constant, or as the multiplier for type=paused" },
      segments: { type: "array", description: "type=piecewise: [{until: unix_s|null, rate: number}]" },
      pauses: { type: "array", description: "type=paused: [{from: unix_s, to: unix_s|null}]" },
      table: { type: "array", description: "type=table: [{parent: unix_s, local: seconds}]" } } },
    offset: { type: "number", default: 0 },
    calendar: { type: "object", properties: { day_seconds: { type: "integer" }, year_days: { type: "integer" } } },
    signature: { type: "object", description: "present only when CTCL_SIGN_KEY is configured; Ed25519 over id|canonical_json(parent,epoch,rate,offset)|created_at (§31.1)", properties: { alg: { const: "Ed25519" }, key_id: { type: "string" }, signed_fields: { type: "string" }, value: { type: "string" }, verify: { type: "string" } } },
  },
};

const SPECS_GROUP_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://commoninstant.org/ai/specs/group-schema.json",
  title: "CTCL Temporal Group", type: "object", required: ["id", "members"],
  properties: {
    id: { type: "string", description: "e.g. group:project-alpha" },
    members: { type: "array", items: { type: "string" }, description: "each item is \"utc\"|\"posix\"|\"tai\"|\"gps\" (builtin), \"tz:<IANA>\" (civil local time), or a stored custom system id" },
    owner: { type: ["string", "null"] },
    version: { type: "string", description: "auto-incremented on every re-POST of the same id" },
    signature: { type: "object", description: "present only when CTCL_SIGN_KEY is configured; Ed25519 over id|canonical_json(members,owner,version)|updated_at (§31.1), re-signed on every version bump", properties: { alg: { const: "Ed25519" }, key_id: { type: "string" }, signed_fields: { type: "string" }, value: { type: "string" }, verify: { type: "string" } } },
  },
};

const SPECS_WORKSPACE_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://commoninstant.org/ai/specs/workspace-schema.json",
  title: "CTCL Shared Workspace (Phase 5 Step 1)", type: "object", required: ["id"],
  description: "Bundles existing system/group ids under one shareable id for team/multi-agent coordination. NO access control — same public-write model as every other CTCL resource; this is a namespacing convenience, not an auth boundary. Real accounts/role-permissions are a deliberately separate, not-yet-built later step.",
  properties: {
    id: { type: "string", description: "e.g. workspace:project-alpha" },
    name: { type: ["string", "null"], description: "human-readable label, optional" },
    systems: { type: "array", items: { type: "string" }, description: "stored custom system ids" },
    groups: { type: "array", items: { type: "string" }, description: "stored Temporal Group ids" },
    owner: { type: ["string", "null"], description: "freeform label, not enforced (no accounts exist to enforce it against)" },
    version: { type: "string", description: "auto-incremented on every re-POST of the same id" },
    signature: { type: "object", description: "present only when CTCL_SIGN_KEY is configured; Ed25519 over id|canonical_json(name,systems,groups,owner,version)|updated_at (§31.1), re-signed on every version bump", properties: { alg: { const: "Ed25519" }, key_id: { type: "string" }, signed_fields: { type: "string" }, value: { type: "string" }, verify: { type: "string" } } },
  },
};

const AI_EXAMPLES = {
  "000-verified-instant.md": `# Example: get a verified reference instant

Request:

    curl -s https://commoninstant.org/v1/now

The response shape (values change every call): instant.id, instant.reference.value,
encodings for unix_s/unix_ms/unix_us/unix_ns/rfc3339, timescales for utc/posix/
tai_approx/gps_approx, source (edge_wall_clock, cloudflare, synchronized), quality
(millisecond_representation, estimated_uncertainty_ns 5000000), policy.leap_table, and
an optional Ed25519 signature.

Notes:

- quality.precision is honest: this is a millisecond-grade edge wall clock. The ns and
  us fields are zero-padded for format compatibility, not a claim of nanosecond
  accuracy.
- signature is present only when the deployment has an Ed25519 signing key configured;
  verify it with the SDK's verifyInstant() against GET /v1/pubkey.
- The response carries Cache-Control: no-store — every call gets a fresh instant.
`,
  "001-multi-agent-alignment.md": `# Example: two agents align on the exact same instant

Agent A registers a reference instant and shares its id:

    curl -s -X POST https://commoninstant.org/v1/instants \\
      -H 'content-type: application/json' -d '{"label":"handoff"}'

That returns an id (ctcl:instant:...) and a share URL (https://commoninstant.org/i/...).

Agent B — a different process, a different session, or a human via the share URL —
retrieves the exact same instant:

    curl -s https://commoninstant.org/v1/instant/ctcl:instant:...

Both calls return identical unix_ns. This is the multi-agent alignment primitive: store
the instant_id, not a bare timestamp number, and any later reader reconstructs the same
reference point exactly.
`,
  "002-precision-preserving-convert.md": `# Example: precision-preserving conversion

    curl -s -X POST https://commoninstant.org/v1/convert -H 'content-type: application/json' -d '{
      "input":  {"value":"1783420000.123456789","encoding":"unix_s"},
      "output": {"encoding":"rfc3339","timezone":"Asia/Taipei"}
    }'

The response includes canonical_unix_ns (the full-precision value the caller supplied,
preserved exactly) and quality.lossless (whether the chosen output encoding can
represent that value without truncation — rfc3339 can, unix_s alone cannot).
Conversion never claims to improve precision — it preserves whatever the caller
supplied, because this is offline math, not the wall clock.

A naive local time can also be disambiguated in the same call: pass input.timezone with
no offset in the value, and CTCL returns NONEXISTENT_LOCAL_TIME or
AMBIGUOUS_LOCAL_TIME rather than silently guessing.
`,
  "003-custom-world-clock.md": `# Example: a custom accelerated world clock

    curl -s -X POST https://commoninstant.org/v1/systems -H 'content-type: application/json' -d '{
      "id": "user:game_world",
      "epoch": {"parent_value": "1700000000"},
      "rate": {"value": 20}
    }'

This world runs 20x real time from epoch 1700000000 (unix_s). Read its current time:

    curl -s https://commoninstant.org/v1/systems/user%3Agame_world/now

A paused rate type additionally tracks active_elapsed_s (wall time minus paused time) —
the mechanism behind agent life-history clocks (the SDK's lifeHistory() and lifeNow()):
an agent's experienced time excludes suspended or offline periods.
`,
  "004-one-instant-many-systems.md": `# Example: One Instant, Many Systems

Create a group once:

    curl -s -X POST https://commoninstant.org/v1/temporal-groups -H 'content-type: application/json' -d '{
      "id": "group:demo",
      "members": ["utc", "tai", "tz:Asia/Taipei", "tz:America/New_York", "user:game_world"]
    }'

Then project any instant across every member in one call:

    curl -s -X POST https://commoninstant.org/v1/temporal-groups/group:demo/expand \\
      -H 'content-type: application/json' -d '{}'

Each member resolves independently — an unknown system id or invalid timezone produces
a per-member error field rather than failing the whole request (see
corpus/engineering-notes.md, "per-item error isolation"). This is CTCL's most direct
demonstration of "same instant, different representations."
`,
  "005-boundary-inspection.md": `# Example: proactively checking a temporal boundary

    curl -s -X POST https://commoninstant.org/v1/boundaries/inspect -H 'content-type: application/json' -d '{
      "timezone": "America/New_York",
      "local_value": "2026-11-01T01:30:00"
    }'

This returns status "fold" (this local time occurred twice, during the US fall-back
transition) with both candidate UTC instants — never a silent guess. Compare
/v1/convert, which errors (AMBIGUOUS_LOCAL_TIME) on the same input; the Boundary
Inspector is the pre-flight version that always returns a status object, useful for an
agent deciding whether it's safe to schedule something at a given local time.

The same endpoint also inspects a custom system for pause or rate_change boundaries —
pass {"system_id": "...", "value": "..."} instead of {timezone, local_value}.
`,
  "006-constraint-planning.md": `# Example: solving for a shared instant under constraints

    curl -s -X POST https://commoninstant.org/v1/planner/shared-instant -H 'content-type: application/json' -d '{
      "window": {"from": 1783784219, "to": 1784389019, "step_s": 1800},
      "constraints": [
        {"type": "weekday_hours", "timezone": "Asia/Taipei", "days": [1,2,3,4,5], "start": "09:00", "end": "18:00", "weight": 2},
        {"type": "avoid_window", "from": 1783870619, "to": 1783877819, "weight": 1},
        {"type": "min_lead_time", "seconds": 3600, "weight": 1}
      ]
    }'

This returns the best-scoring instant plus up to three distinct alternatives and a
plain-language explanation. This is a demonstration of CTCL-native constraint solving,
explicitly not a full meeting-scheduler SaaS — see GET /v1/planner/constraint-types for
exactly which constraint types are honestly implemented versus declared unsupported (no
external data feed, not faked).
`,
};

function toolsCatalog(origin) {
  const decl = toolDeclaration(origin);
  return {
    "$schema": "aicl-capability/0.1",
    generated_from: "same source as /ai/ctcl.json — cannot drift from it",
    error_schema: "/ai/specs/error-schema.json",
    schemas: { instant: "/ai/specs/instant-schema.json", system: "/ai/specs/system-schema.json", group: "/ai/specs/group-schema.json", workspace: "/ai/specs/workspace-schema.json" },
    rate_limit: "120 requests/min per IP on /v1/* (whitepaper section 38)",
    permission: "public — no auth required, subject to the rate limit above",
    tools: decl.tools,
  };
}

const AI_TOOLS_MD = `# Tools guide

CTCL's tools are called over plain REST. There is no CLI and no live MCP server yet
(see corpus/current.md) — curl, the JS SDK (/sdk.js), and the /developers Playground
are the supported interfaces today.

## Discovery

Read /ai/ctcl.json first (or /ai/tools/catalog.json, which wraps the same tool list
with added schema/rate-limit/permission fields). Both are generated from the same
source as the router, so neither can drift from real behavior.

## Rate limit and permission

Every tool is public — no authentication is required. All /v1/* calls share a single
budget: 120 requests per minute per source IP (whitepaper section 38), enforced by
Cloudflare's native rate limiter (approximate, per-colo — not a hard global guarantee;
see corpus/current.md).

## Errors

Every tool fails the same way: {ok:false, error:{code, message, details}, meta}. See
/developers for the full error-code reference table with HTTP status codes.

## Examples

Seven complete worked examples live under /ai/examples/ — start with
000-verified-instant.md if you haven't called the API before.
`;

const GOV_LICENSE_MD = `# License

CTCL is licensed under the Apache License, Version 2.0 (decided 2026-07-12). The full
text is in the LICENSE file at the repository root
(github.com/kakon77777-commits/ctcl/blob/main/LICENSE); a copy is also always available
at http://www.apache.org/licenses/LICENSE-2.0. Copyright 2026 Neo.K / EveMissLab
(一言諾科技有限公司).

This applies to the source code, this /ai/ layer, and the whitepapers in docs/.

## Why Apache-2.0

This mirrors the choice already made for the EML project, and fits the CommonInstant
Web whitepaper's own stated intent (section 16.4, "Open Protocol Strategy"): the
protocol and reference implementation should be open enough that third parties can
build independent clients and servers with confidence, without CTCL becoming the only
implementation that can legally exist. Two properties of Apache-2.0 mattered
specifically for a protocol project: an express patent grant plus a patent-retaliation
clause (real protection for third-party implementers, and for CTCL itself, against
patent claims arising from use of the spec), and a requirement to preserve
attribution/copyright notices in redistributions — which supports treating "being the
protocol's original author" as the durable asset, rather than trying to extract value
from restricting the code itself.

## What this means practically

- Read, use, modify, and redistribute the source code and this /ai/ layer, including
  commercially, as long as you preserve the copyright and license notices and note any
  changes you made to files you redistribute.
- No warranty is provided — see LICENSE section 7 and 8 for the full disclaimer.
- Commercial value for CTCL itself is intended to come from hosting the canonical
  instance, enterprise integration and support, and being recognized as the protocol's
  origin — not from restricting who may read or run the code. See the CommonInstant Web
  whitepaper's own commercial strategy (section 16) for the fuller picture.
`;

const GOV_USAGE_POLICY_MD = `# Usage policy

## For AI agents and automated systems

- Reading, summarizing, and citing this /ai/ layer and the public whitepapers in docs/
  for the purpose of understanding CTCL is welcomed — that is what this layer exists
  for.
- Calling the live API (/v1/*) is subject to the published rate limit (120 requests per
  minute per IP on /v1/*) and the honesty constraints documented throughout this corpus
  (do not claim ns-accuracy, do not silently resolve ambiguity, and so on).
- Do not scrape or reproduce the whitepaper text as your own work product; cite it
  instead — see citation-policy.md.
- The source code and whitepapers are Apache-2.0 (see license.md) — reuse including
  commercial use is permitted, conditioned on preserving copyright/license notices.

## For human developers

- The REST API, the SDK, and this /ai/ layer are the supported integration points.
  There is no CLI or webhook relay yet (see corpus/current.md).
- File issues or pull requests against github.com/kakon77777-commits/ctcl.

## Boundaries

- Do not use /v1/* for civil-time, world-clock, or meeting-planning use cases — CTCL
  explicitly routes those to mature external tools (see the CommonInstant Web
  whitepaper's own external-tool recommendation, and the site's /developers page).
  Using CTCL for that purpose will get a worse answer than a dedicated civil-time
  service would.
- Do not treat any timescale or precision claim as suitable for high-stakes,
  safety-critical, or financial-settlement timing without independently verifying
  against /v1/version's honesty fields and /status.
`;

const GOV_PROVENANCE_MD = `# Provenance

## Canonical sources, in order of authority

1. The live deployment at https://commoninstant.org — the running Worker is the ground
   truth for behavior.
2. This repository, github.com/kakon77777-commits/ctcl, branch main.
3. The four whitepapers in docs/ (theory, Agent Time API, CommonInstant Web, Temporal
   Port App) — the design intent the implementation is built against.
4. This /ai/ corpus — a derived, kept-in-sync summary of items 1 through 3 above, not
   an independent source of truth.

## Known stale copies

- A copy of CTCL's original implementation exists inside Neo.K's unbounded-axiom
  (Logic Matrix) repository, from before the 2026-07-11 migration to this standalone
  repo. That copy is historical and should not be treated as current.
- A stale master branch lingers on this repository's GitHub remote from initial repo
  creation; main is the only branch that receives updates.

## How to tell a genuine CTCL instant from a forged one

GET /v1/now signs its response with Ed25519 when a signing key is configured on the
deployment (a signature field appears). Verify it against the published public key at
GET /v1/pubkey, or use the SDK's verifyInstant(). The absence of a signature field means
the deployment has no signing key configured (see /status for live signing status) — it
does not by itself indicate forgery.
`;

const GOV_CITATION_POLICY_MD = `# Citation policy

If you cite CTCL — in a paper, a tool's training-data attribution, a derived work, or
an AI system's sourcing — a preferred citation is:

    CTCL (Common Temporal Coordinate Layer), Neo.K / EveMissLab, 2026.
    https://commoninstant.org — accessed <date>.

For a specific claim, prefer citing the specific source:

- API behavior: the live deployment plus this repository's src/worker.js at a specific
  commit.
- Design intent: the specific whitepaper file in docs/.
- A specific concept's status (frozen, stable, or prototype):
  corpus/concept-genealogy.md.

Prefer corpus/public-summary.md when a short, stable, citable description is needed —
it changes less often than the whitepapers or the live feature set.
`;

const GOV_CRAWLER_POLICY_MD = `# Crawler policy

Recommended reading order for any crawler or agent visiting cold:

    /llms.txt
    /ai/index.md
    /ai/manifest.json
    /ai/corpus/current.md
    /ai/rights-spectrum.json
    /ai/governance/  (this directory)

There is no robots.txt-level disallow on this deployment as of 2026-07-11 — the public
API and /ai/ layer are meant to be read by both humans and machines. No cloaking: every
route here returns the same content regardless of User-Agent.

Automated calls to the stateful /v1/* endpoints (not just the static /ai/* content) are
subject to the same 120-requests-per-minute-per-IP limit as any other caller. Crawling
the /ai/ documentation tree itself is not separately rate-limited beyond Cloudflare's
general edge protections, since those routes are static content, not the KV-backed API.
`;

const GOV_VERSIONING_POLICY_MD = `# Versioning policy

- API: all routes are v1. The envelope shape ({ok,data,meta} or
  {ok:false,error,meta}) will not change within v1; new optional fields may be added. A
  breaking change ships as v2, never a silent mutation of v1 — see /developers for the
  same statement in the human Developer Console.
- This /ai/ layer: versioned independently (ai/version.json's aicl_layer_version),
  since it can be extended — new corpus files, new examples — without touching the API
  surface at all.
- Precedence when documents disagree: the live deployment, then this repository's
  src/worker.js, then the whitepapers in docs/ (design intent, may run ahead of
  implementation), then this /ai/ corpus (a derived summary, may occasionally lag a
  same-day change until the next update pass).
- Whitepapers: each is independently versioned in its own filename (a trailing
  _v0.1.md); a new version gets a new filename rather than overwriting history.
`;

function rightsSpectrum() {
  return {
    "$schema": "aicl-airs/0.1",
    subject: "https://commoninstant.org", repository: "https://github.com/kakon77777-commits/ctcl",
    declared_by: "Neo.K / EveMissLab", declaration_date: "2026-07-12",
    license_status: "Apache License, Version 2.0 — see LICENSE at the repository root and governance/license.md. This spectrum reflects that open license, matching the profile used for the EML project.",
    default_policy: {
      access: 1.0, indexing: 1.0, summarization: 1.0, quotation: 1.0, inference_input: 1.0, embedding: 1.0,
      training: 1.0, fine_tuning: 1.0, distillation: 1.0,
      verbatim_memory: "case_by_case", commercial_use: 1.0, redistribution: 1.0,
      attribution: "required", compensation: "not_required",
    },
    paths: [
      { path: "/ai/", note: "designed to be read and ingested by AI systems — every dimension is 1.0 here; this is the whole point of the layer" },
      { path: "/docs/", note: "the whitepapers — read, cite, and reuse per Apache-2.0; prefer citation-policy.md's format for attribution" },
      { path: "/src/", note: "source code — Apache-2.0, same as the rest of the repository" },
    ],
    licensing_options: [
      { id: "apache-2.0-default", summary: "Apache License, Version 2.0. Full reuse including commercial use and redistribution, conditioned on preserving copyright/license notices and noting changes to redistributed files.", price: null },
    ],
    related_standards: {
      robots_txt: "not yet published on this deployment", llms_txt: "/llms.txt",
      note: "This declaration follows the AIRS/AILP pattern from Neo.K's AICR&AICL whitepapers, as also implemented for the EML and PHOSPHOR projects — a rights/licensing declaration about how AI may use this content, not a claim about any AI system's own rights.",
    },
    disclaimer: "This is a declaration layer, not a substitute for the LICENSE file. Where this file and LICENSE disagree, LICENSE governs.",
  };
}

function aiFileRegistry(origin) {
  const reg = {
    "/ai/index.md": { type: "md", body: AI_INDEX_MD },
    "/ai/manifest.json": { type: "json", body: aiManifest(origin) },
    "/ai/version.json": { type: "json", body: AI_VERSION_JSON },
    "/ai/sitemap.json": { type: "json", body: AI_SITEMAP_JSON },
    "/ai/rights-spectrum.json": { type: "json", body: rightsSpectrum() },
    "/ai/corpus/origin.md": { type: "md", body: CORPUS_ORIGIN_MD },
    "/ai/corpus/current.md": { type: "md", body: CORPUS_CURRENT_MD },
    "/ai/corpus/design-history.md": { type: "md", body: CORPUS_DESIGN_HISTORY_MD },
    "/ai/corpus/concept-genealogy.md": { type: "md", body: CORPUS_CONCEPT_GENEALOGY_MD },
    "/ai/corpus/engineering-notes.md": { type: "md", body: CORPUS_ENGINEERING_NOTES_MD },
    "/ai/corpus/accepted-concepts.md": { type: "md", body: CORPUS_ACCEPTED_CONCEPTS_MD },
    "/ai/corpus/deprecated-concepts.md": { type: "md", body: CORPUS_DEPRECATED_CONCEPTS_MD },
    "/ai/corpus/public-summary.md": { type: "md", body: CORPUS_PUBLIC_SUMMARY_MD },
    "/ai/corpus/full-corpus.jsonl": { type: "jsonl", body: corpusFullJsonl() },
    "/ai/specs/ctcl-v1.md": { type: "md", body: SPECS_CTCL_V1_MD },
    "/ai/specs/instant-schema.json": { type: "json", body: SPECS_INSTANT_SCHEMA },
    "/ai/specs/error-schema.json": { type: "json", body: SPECS_ERROR_SCHEMA },
    "/ai/specs/system-schema.json": { type: "json", body: SPECS_SYSTEM_SCHEMA },
    "/ai/specs/group-schema.json": { type: "json", body: SPECS_GROUP_SCHEMA },
    "/ai/specs/workspace-schema.json": { type: "json", body: SPECS_WORKSPACE_SCHEMA },
    "/ai/tools/catalog.json": { type: "json", body: toolsCatalog(origin) },
    "/ai/tools/tools.md": { type: "md", body: AI_TOOLS_MD },
    "/ai/governance/license.md": { type: "md", body: GOV_LICENSE_MD },
    "/ai/governance/usage-policy.md": { type: "md", body: GOV_USAGE_POLICY_MD },
    "/ai/governance/provenance.md": { type: "md", body: GOV_PROVENANCE_MD },
    "/ai/governance/citation-policy.md": { type: "md", body: GOV_CITATION_POLICY_MD },
    "/ai/governance/crawler-policy.md": { type: "md", body: GOV_CRAWLER_POLICY_MD },
    "/ai/governance/versioning-policy.md": { type: "md", body: GOV_VERSIONING_POLICY_MD },
  };
  for (const [name, body] of Object.entries(AI_EXAMPLES)) reg["/ai/examples/" + name] = { type: "md", body };
  return reg;
}
function aiFileResponse(f) {
  const ct = f.type === "json" ? "application/json; charset=utf-8" : f.type === "jsonl" ? "application/x-ndjson; charset=utf-8" : "text/markdown; charset=utf-8";
  const body = f.type === "json" ? JSON.stringify(f.body, null, 2) + "\n" : f.body;
  return new Response(body, { headers: { "Content-Type": ct, ...CORS, "Cache-Control": "public, max-age=600" } });
}

// ---- router ----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const origin = url.origin;
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // §38 rate limiting — 120 req/min per IP on the /v1/* API (Workers native limiter).
    if (env && env.API_RL && p.startsWith("/v1/")) {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      try {
        const { success } = await env.API_RL.limit({ key: ip });
        if (!success) return new Response(JSON.stringify({ ok: false,
          error: { code: "RATE_LIMITED", message: "120 requests/min per IP (§38). Back off; /v1/now is no-store but you rarely need it more than ~1/s. Contact licensing for a higher tier." },
          meta: { api_version: API_VERSION, request_id: rid() } }, null, 2),
          { status: 429, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, "Retry-After": "60" } });
      } catch (e) { /* limiter best-effort; never block on its failure */ }
    }

    if (p === "/v1/now") return ok(await signInstant(env, nowEnvelope()), { server_observed_at: new Date().toISOString() }, "no-store");
    if (p === "/v1/version") return versionInfo(env);
    if (p === "/v1/pubkey") { const pk = await pubKeyInfo(env); return pk ? ok(pk, {}, "public, max-age=3600") : fail("SIGNING_DISABLED", "no signing key configured (CTCL_SIGN_KEY unset)", {}, 503); }
    if (p === "/v1/timescales") return ok({ timescales: [
      { id: "utc", type: "reference", note: "Civil reference; includes leap seconds." },
      { id: "posix", type: "encoding", note: "Unix time; POSIX ignores leap seconds." },
      { id: "tai", type: "reference", note: `Atomic; leap-aware for any instant via the 1972-2017 historical offset table (currently +${LEAP.tai_minus_utc_s}s, latest known offset as of ${LEAP.as_of}). Cannot predict an undeclared future leap second.` },
      { id: "gps", type: "reference", note: `Leap-aware like tai, minus a fixed 19s (currently +${LEAP.gps_minus_utc_s}s). Not applicable before the 1980-01-06 GPS epoch.` },
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
    if (p === "/v1/temporal-groups" && request.method === "POST") return createGroup(request, env);
    if (p === "/v1/temporal-groups" && request.method === "GET") return listGroups(env);
    if (p.startsWith("/v1/temporal-groups/")) {
      const rest = decodeURIComponent(p.slice(20));
      if (rest.endsWith("/expand")) return expandGroup(rest.slice(0, -7), request, env);
      return getGroup(rest, env);
    }
    if (p === "/v1/workspaces" && request.method === "POST") return createWorkspace(request, env);
    if (p === "/v1/workspaces" && request.method === "GET") return listWorkspaces(env);
    if (p.startsWith("/v1/workspaces/")) {
      const rest = decodeURIComponent(p.slice(15));
      if (rest.endsWith("/expand")) return expandWorkspace(rest.slice(0, -7), request, env);
      return getWorkspace(rest, env);
    }
    if (p === "/v1/boundaries/inspect" && request.method === "POST") return inspectBoundary(request, env);
    if (p === "/v1/resolve" && request.method === "POST") return handleResolve(request);
    if (p === "/v1/planner/shared-instant" && request.method === "POST") return planSharedInstant(request, env);
    if (p === "/v1/planner/constraint-types") return constraintTypesCatalog();
    if (p === "/i") return Response.redirect(origin + "/", 302);
    if (p.startsWith("/i/")) return instantSharePage(origin, decodeURIComponent(p.slice(3)), env);
    if (p === "/status") return new Response(statusPage(), { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
    if (p === "/developers") return new Response(developerConsolePage(), { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
    if (p === "/llms.txt") return new Response(LLMS_TXT, { headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS, "Cache-Control": "public, max-age=600" } });
    if (p.startsWith("/ai/") && p !== "/ai/ctcl.json") {
      const f = aiFileRegistry(origin)[p];
      if (f) return aiFileResponse(f);
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
.tasknav{display:flex;gap:.5rem 1rem;flex-wrap:wrap;margin-top:1.1rem;font:500 .74rem/1.4 var(--mono)}
.tasknav a{color:var(--faint);text-decoration:none;border-bottom:1px dotted var(--line2);transition:color .15s,border-color .15s}
.tasknav a:hover{color:var(--gold);border-color:var(--gold)}
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
   <div class="cta" id="hero-cta">
    <a class="btn pri" href="/v1/now" target="_blank" rel="noopener" data-zh="取得驗證瞬間 →">Get a verified instant →</a>
    <button class="btn sec" id="shareBtn" data-zh="分享此刻 →">Share this instant →</button>
    <a class="btn sec" href="/ai/ctcl.json" data-zh="Agent 工具宣告">Agent tool declaration</a>
   </div>
   <nav class="tasknav" aria-label="Quick tasks">
    <a href="#hero-cta" data-zh="建立共同瞬間">Create a Common Instant</a>
    <a href="#convert" data-zh="轉換時間戳">Convert a Timestamp</a>
    <a href="#groups" data-zh="一瞬展開多系統">Expand One Instant Across Systems</a>
    <a href="#boundary" data-zh="檢查時間邊界">Inspect a Temporal Boundary</a>
    <a href="#groups" data-zh="建立時間群組">Create a Temporal Group</a>
    <a href="/developers" data-zh="開發者主控台">Open Developer Console</a>
   </nav>
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
   <div class="ep"><span class="m">POST</span><span class="path">/v1/temporal-groups/{id}/expand</span><span class="d" data-zh="一瞬間展開到群組內每個系統（Web 旗艦功能）">project one instant across every system in a group (flagship Web feature)</span></div>
   <div class="ep"><span class="m">POST</span><span class="path">/v1/boundaries/inspect</span><span class="d" data-zh="主動檢查 DST gap／fold／暫停／速率變化，從不報錯">proactive gap／fold／pause／rate-change check, never errors</span></div>
   <div class="ep"><span class="m">GET</span><span class="path">/i/{id}</span><span class="d" data-zh="人類可讀的分享頁 —— 任何人都能對齊到同一瞬間">human-readable share page — anyone can align on the same instant</span></div>
   <div class="ep"><span class="m">POST</span><span class="path">/v1/resolve</span><span class="d" data-zh="模糊輸入 → IANA 候選＋信心值，從不武斷解析">ambiguous input → IANA candidates + confidence, never guesses</span></div>
   <div class="ep"><span class="m">POST</span><span class="path">/v1/planner/shared-instant</span><span class="d" data-zh="給定限制，求解最佳共同瞬間">constraint-solve for the best shared instant given weighted constraints</span></div>
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

 <section id="convert">
  <div class="label">Playground</div>
  <p data-zh="把一個 Unix 秒值轉成某時區的 RFC3339。">Convert a Unix-seconds value into an RFC3339 timestamp for a timezone.</p>
  <div class="pg">
   <label class="mono" style="color:var(--faint);font-size:.75rem">unix_s <input id="pv" value="1783420000.5" aria-label="Unix seconds value"></label>
   <label class="mono" style="color:var(--faint);font-size:.75rem">tz <input id="ptz" value="Asia/Taipei" aria-label="IANA timezone"></label>
   <button class="btn pri" id="pgo" data-zh="轉換 →">convert →</button>
  </div>
  <pre id="pout">…</pre>
 </section>

 <section id="groups">
  <div class="label" data-zh="一瞬間，多世界">One Instant, Many Systems</div>
  <p data-zh="CTCL 的核心示範：同一個共同瞬間，同時投影到不同的時間系統 —— 不同時區、不同時標，未來也包含你自己登記的自定義世界時鐘。">CTCL's core demonstration: the same common instant, projected into several temporal systems at once — timezones, timescales, and (soon) any custom world clock you register.</p>
  <div class="pg">
   <button class="btn pri" id="ggo" data-zh="展開此刻 →">expand this instant →</button>
  </div>
  <pre id="gout">…</pre>
 </section>

 <section id="boundary">
  <div class="label" data-zh="邊界檢查器">Boundary Inspector</div>
  <p data-zh="主動檢查一個地方時間是否安全 —— DST gap（不存在）、fold（模糊）或正常。與 /v1/convert 不同，這裡從不報錯，永遠回傳一個狀態。下面預設是 2026 年美東的春令跳時（不存在的 02:30）。">Proactively check whether a local time is safe — DST gap (nonexistent), fold (ambiguous), or normal. Unlike /v1/convert, this never errors — it always returns a status. The default below is 2026's US Eastern spring-forward gap (02:30 doesn't exist).</p>
  <div class="pg">
   <label class="mono" style="color:var(--faint);font-size:.75rem">local <input id="bv" value="2026-03-08T02:30:00" aria-label="Naive local datetime" style="width:190px"></label>
   <label class="mono" style="color:var(--faint);font-size:.75rem">tz <input id="btz" value="America/New_York" aria-label="IANA timezone"></label>
   <button class="btn pri" id="bgo" data-zh="檢查 →">inspect →</button>
  </div>
  <pre id="bout">…</pre>
 </section>

 <section>
  <div class="label" data-zh="語義解析">Semantic Resolution</div>
  <p data-zh="「CST」指的是美國中部時間還是中國標準時間？CTCL 從不替你武斷決定 —— 回傳候選＋信心值，而不是一個猜測。">Does "CST" mean US Central Time or China Standard Time? CTCL never silently decides for you — it returns candidates with confidence, not a guess.</p>
  <div class="pg">
   <label class="mono" style="color:var(--faint);font-size:.75rem">input <input id="rv" value="CST" aria-label="Ambiguous place or timezone input"></label>
   <button class="btn pri" id="rgo" data-zh="解析 →">resolve →</button>
  </div>
  <pre id="rout">…</pre>
 </section>

 <section>
  <div class="label" data-zh="限制求解規劃器">Constraint Planner</div>
  <p data-zh="在未來 7 天內，求解一個滿足「台北工作時間、避開維護窗口、至少提前一小時」的最佳共同瞬間 —— 不是完整會議排程系統，是 CTCL 原生限制求解的展示。">Solve for the best shared instant in the next 7 days that satisfies "Taipei work hours, avoid a maintenance window, at least an hour of lead time" — not a full meeting-scheduler, a demonstration of CTCL-native constraint solving.</p>
  <div class="pg">
   <button class="btn pri" id="plgo" data-zh="規劃 →">plan →</button>
  </div>
  <pre id="plout">…</pre>
 </section>

 <footer>
  <span data-zh="CTCL v0.1 · 參考＋轉換層，不是授時機構。">CTCL v0.1 · a reference + transformation layer, not a timing authority.</span><br>
  <a href="/sdk.js">JS SDK</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/ai/ctcl.json">tool declaration</a> · <a href="/developers">developers</a> · <a href="/status">status</a> · Neo.K / 一言諾科技有限公司 · EveMissLab
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
// one instant, many systems
async function tryExpand(){var gid='demo:one-instant-many-systems';
 var members=['utc','posix','tai','gps','tz:Asia/Taipei','tz:America/New_York','tz:Europe/London'];
 try{
  await fetch(O+'/v1/temporal-groups',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:gid,members:members})});
  var r=await(await fetch(O+'/v1/temporal-groups/'+encodeURIComponent(gid)+'/expand',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
  $('gout').textContent=JSON.stringify(r.ok?r.data:r,null,2);
 }catch(e){$('gout').textContent=String(e)}}
$('ggo').addEventListener('click',tryExpand);
// boundary inspector
async function tryInspect(){var body={timezone:$('btz').value,local_value:$('bv').value};
 try{var r=await(await fetch(O+'/v1/boundaries/inspect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();$('bout').textContent=JSON.stringify(r.ok?r.data:r,null,2)}catch(e){$('bout').textContent=String(e)}}
$('bgo').addEventListener('click',tryInspect);
// semantic resolution
async function tryResolve(){var body={input:$('rv').value};
 try{var r=await(await fetch(O+'/v1/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();$('rout').textContent=JSON.stringify(r.ok?r.data:r,null,2)}catch(e){$('rout').textContent=String(e)}}
$('rgo').addEventListener('click',tryResolve);
// constraint planner
async function tryPlan(){var now=Math.floor(Date.now()/1000);
 var body={window:{from:now,to:now+7*86400,step_s:1800},
  constraints:[{type:'weekday_hours',timezone:'Asia/Taipei',days:[1,2,3,4,5],start:'09:00',end:'18:00',weight:2},
               {type:'avoid_window',from:now+86400,to:now+86400+7200,weight:1},
               {type:'min_lead_time',seconds:3600,weight:1}]};
 try{var r=await(await fetch(O+'/v1/planner/shared-instant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();$('plout').textContent=JSON.stringify(r.ok?r.data:r,null,2)}catch(e){$('plout').textContent=String(e)}}
$('plgo').addEventListener('click',tryPlan);
// share this instant — navigate (not window.open: popup blockers reject open() after an await)
$('shareBtn').addEventListener('click',async function(){try{
 var r=await(await fetch(O+'/v1/instants',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
 if(r.ok&&r.data.share)location.href=r.data.share;
}catch(e){}});
</script></body></html>`;
}

// ============================================================================
// VENDORED THIRD-PARTY CODE — QR Code Generator for JavaScript
// ============================================================================
// Everything below this banner down to the matching end-banner is verbatim
// upstream source (UMD/CommonJS export footer stripped — a plain top-level
// `var qrcode` binding is all a Workers ES module needs). It is CTCL's only
// third-party runtime dependency; every other line in this file is
// hand-written. Used by shareQrSvg() below to render the "QR Code" output
// format the CommonInstant Web whitepaper's §6.6 Share Instant section
// already specified but this deployment hadn't implemented yet.
//
// Copyright (c) 2009 Kazuhiko Arase. MIT License.
// Source: https://github.com/kazuhikoarase/qrcode-generator (js/dist/qrcode.js)
// Verified before inclusion: round-trip encode -> jsQR decode across 6
// representative payloads (short/long URLs, ctcl: URIs) all matched exactly.
//
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();

// ============================================================================
// END VENDORED CODE
// ============================================================================

// §6.6 Share Instant "QR Code" output. Error-correction level M (15% recovery)
// is the qrcode-generator default and a reasonable balance for a URL-length
// payload. typeNumber 0 = auto-select the smallest QR version that fits.
// Never lets a QR failure break the whole share page — worst case, the page
// just renders without the QR block.
function shareQrSvg(text) {
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
  } catch (e) {
    return null;
  }
}
