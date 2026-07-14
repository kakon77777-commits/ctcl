# CTCL — Common Temporal Coordinate Layer

**共同時間座標層** · a verified reference instant + heterogeneous time transformation
layer for agents. **Same instant, different representations** — a reference layer, not a
timing authority.

**Live:** https://commoninstant.org · by Neo.K / 一言諾科技有限公司 (EveMissLab) · **License:** [Apache-2.0](LICENSE)

For agents, simulators, robots, digital twins and persistent AI, a real time
infrastructure should not just return "now" — it should provide a **verified common
reference instant + timescale semantics + provenance + a transform graph**, so
heterogeneous systems can align on the same instant without sharing a clock, calendar,
or epoch. Formally: `τ_i = Φ_i(I*)`.

## Quick start

```js
// ESM — works in browsers, Node 18+, and Workers
import { CTCL } from 'https://commoninstant.org/sdk.js';
const t = CTCL();

await t.now();                       // verified reference instant (source, uncertainty, id)
await t.convert({ value: '1783420000.123456789', encoding: 'unix_s' },
                { encoding: 'rfc3339', timezone: 'Asia/Taipei' });   // precision-preserving

// multi-agent alignment: register once, any agent retrieves the exact same instant
const i = await t.registerInstant({ label: 'handoff' });
await t.getInstant(i.id);

// long-term memory + life-history (the original driver)
const m = await t.stampMemory('remember this moment');  // event / write instants
await t.lifeHistory('myAgent', originUnixS, pauses);     // paused clock = life-history
await t.lifeNow('myAgent');                              // active_elapsed = experienced time

// One Instant, Many Systems — project one instant across a group of systems at once
await t.createGroup({ id: 'group:demo', members: ['utc', 'tz:Asia/Taipei', 'tz:America/New_York'] });
await t.expandGroup('group:demo');                       // -> { instant, members: [{member, value, ...}] }
```

Agents discover the whole API from **`/ai/ctcl.json`** (machine tool declaration) — read
that first.

## Endpoints (`/openapi.json`, `/v1/version`)

| | |
|---|---|
| `GET /v1/now` | verified reference instant — encodings, timescales, source, uncertainty, stable `instant_id` |
| `POST /v1/convert` | cross encoding / timescale / timezone; BigInt-nanosecond precision-preserving; DST ambiguity (§18) |
| `POST /v1/transform` | map a parent time into a custom linear-rate world clock |
| `POST /v1/instants` · `GET /v1/instant/{id}` · `GET /i/{id}` | register / retrieve a shared instant I\* (multi-agent alignment); `/i/{id}` is the human-readable **Share Instant** page |
| `POST /v1/systems` · `GET /v1/systems` · `/{id}` · `/{id}/now` | persistent custom systems — `rate.type` = constant \| piecewise \| **paused** (active-time) \| table |
| `GET /v1/path` | transform-graph route between systems/timescales |
| `POST /v1/temporal-groups` · `GET /v1/temporal-groups` · `/{id}` · `POST /{id}/expand` | **Temporal Groups** — "One Instant, Many Systems": project one instant across every member (builtin timescale \| `tz:<IANA>` \| custom system id) in a single call |
| `POST /v1/boundaries/inspect` | **Boundary Inspector** — proactive gap/fold/pause/rate_change status check + upcoming DST transitions; never errors, unlike `/v1/convert` |
| `POST /v1/resolve` | **Semantic Resolution** — `resolve_temporal_context`: ambiguous input (city, alias, tz abbreviation) → IANA candidates + confidence; never silently disambiguates |
| `POST /v1/planner/shared-instant` · `GET /v1/planner/constraint-types` | **Constraint Planner** — `plan_shared_instant`: I\* = argmax_I U(I \| constraints) over a bounded search window; weighted `weekday_hours`/`avoid_window`/`prefer_window`/`min_lead_time`/`system_not_paused`/`market_hours` |
| `POST /v1/validate` | validate a time object |
| `GET /v1/transforms(/{id})` | transform-type catalog (§12) |
| `GET /v1/timescales` · `GET /v1/encodings` · `GET /v1/version` | supported timescales / encodings / versions + precision & trust tiers |
| `GET /sdk.js` · `GET /openapi.json` · `GET /ai/ctcl.json` | JS SDK · OpenAPI · agent tool declaration |
| `GET /` | human page: live reference instant + drift, settings (language / theme / experimental Spacetime), quick-task nav |
| `GET /developers` | **Developer Console** — interfaces, error-code reference, version policy, changelog |
| `GET /status` | **Status & Trust Panel** — live binding health (KV/rate-limiter/signing) + an honest known-limitations list |

**Honesty (§16):** the edge wall clock is millisecond-grade — the `ns`/`us` fields are
format-padding, and `quality.precision` + `estimated_uncertainty_ns` say so. `/v1/convert`
*does* preserve caller-supplied nanoseconds (offline math, not the wall clock).

## Develop & deploy

```bash
npm install          # wrangler
npm run dry          # bundle + validate, no deploy
npm run dev          # local wrangler dev
npm run deploy       # deploy the "ctcl" Worker -> commoninstant.org
```

Everything is one self-contained Worker (`src/worker.js`): the `/v1/*` JSON API, the
`/sdk.js` client, and the inline HTML page — no build step, no external assets except
Google Fonts on the page. One vendored third-party dependency, inlined (not fetched at
runtime): Kazuhiko Arase's MIT-licensed `qrcode-generator`, powering the Share Instant
page's QR Code. State (the instant + system registries) lives in the `CTCL_KV`
namespace; graceful `503` if it is ever unbound.

## Spec & status

Driving whitepapers in [`docs/`](docs/):
- `共同時間座標層與異質時空間轉換_v0.1.md` — theory
- `CTCL_Agent_Time_API_技術白皮書_v0.1.md` — API / protocol (57 §), the original MVP driver
- `CTCL_CommonInstant_Web_網站協議入口技術白皮書_v0.1.md` — this website's own product
  whitepaper: public protocol gateway, reference surface, developer playground
- `CTCL_Temporal_Port_App_通用時間端口技術白皮書_v0.1.md` — a separate installable desktop
  app (Rust core, local gateway, device clock observer, trigger engine — Phases 0–4
  shipped in its own repo, github.com/kakon77777-commits/ctcl-app)

v0.1 (Agent Time API) status (~85–90%): the §40 endpoint map is complete (13/13), MVP §50
complete, multi-agent alignment, active-time / life-history, precision-preserving convert,
DST ambiguity, and the client SDK are all live. **§31/§32/§33/§39 closed 2026-07-12**:
registered instants (`/v1/instants`) are now Ed25519-signed (not just `/v1/now`), and the
SDK gained `monotonic()` (§32 duration timer immune to wall-clock jumps), `guardedNow()`
(§33 `CLOCK_ROLLBACK_DETECTED` warning), `offlineNow()` (§39 cached extrapolation,
`quality.mode: "offline_degraded"` instead of throwing), and a `maxAgeMs` staleness check
in `verifyInstant()`. **§31.1 + §6.6 + §16 closed 2026-07-14**: every persisted resource
type (`/v1/instants`, `/v1/systems`, `/v1/temporal-groups`) is now Ed25519-signed
("signed transform metadata"); the Share Instant page (`/i/{id}`) renders a server-side
QR Code; and `tai`/`gps` timescales now use the full 1972-2017 historical leap-second
table instead of a flat current-day offset, so a historical instant gets the offset
that was actually true then (a future undeclared leap second still can't be predicted —
nobody can). Remaining: `custom_expression` transform (intentionally unimplemented —
arbitrary-expression eval is a security risk); hard rate limits via Durable Object;
trust elevation (T3/T4); simulation / robotics / digital-twin adapters.

CommonInstant Web whitepaper progress: P0 (schema/versioning/error-model stabilization) was
already satisfied by the API whitepaper work above. **P1 — Temporal Groups ("One Instant,
Many Systems") shipped 2026-07-11**: `POST/GET /v1/temporal-groups`, `GET /{id}`,
`POST /{id}/expand` project one instant across every member of a named group in one call;
homepage has a live demo. **P2 — Boundary Inspector shipped 2026-07-11**:
`POST /v1/boundaries/inspect` — given `{timezone, local_value}` returns `normal`/`gap`/`fold`
plus upcoming DST transitions within a window; given `{system_id, value?}` returns
`normal`/`pause`/`rate_change` for a custom system; always returns a status instead of
erroring (unlike `/v1/convert`), so an agent can pre-flight-check before committing.
**P4 — Share Instant shipped 2026-07-11**: `GET /i/{id}` is a human-readable counterpart
to `GET /v1/instant/{id}` — instant details, a live "project into your timezone" convert
form, copy-link/copy-JSON, and a raw-JSON-API link; `POST /v1/instants` now also returns a
`share` URL; homepage has a "Share this instant" button. User-controlled content (the
`label` field, the URL id itself) is HTML-escaped before rendering — verified against both
stored and reflected XSS. **P5 — Semantic Resolution shipped 2026-07-11**:
`POST /v1/resolve` (`resolve_temporal_context`) maps a city name / common alias / tz
abbreviation to IANA candidates with confidence, via a compact built-in table (~25
places) plus exact-IANA-id and fuzzy-substring fallbacks. Deliberately scoped: genuinely
ambiguous input (e.g. `"CST"` → US Central *or* China Standard) returns both candidates
at reduced confidence instead of picking one, and free-form natural-language phrases
(`"tomorrow 3pm"`) return an honest empty result rather than a guess — consistent with
§6.3 ("don't silently resolve ambiguity"). **P6 — Constraint Planner shipped 2026-07-11**:
`POST /v1/planner/shared-instant` (`plan_shared_instant`) samples a bounded search window
(max 1000 candidates) and scores each against weighted constraints, returning the best
instant + up to 3 distinct alternatives + a plain-language explanation.
`GET /v1/planner/constraint-types` documents which constraint types are honestly
implemented (`weekday_hours`, `avoid_window`, `prefer_window`, `min_lead_time`,
`system_not_paused`, an approximate `market_hours` with an explicit no-holiday-calendar
caveat) versus explicitly declared unimplemented (`gpu_availability`, `simulation_state`
— no external data feed) rather than faked. **This closes all six P0–P6 priorities from
the CommonInstant Web whitepaper** (P0/P3 were already satisfied by earlier work — P3
"persist commonly-used systems as a versioned resource" is exactly what the P1 Temporal
Groups implementation already does).

**Remaining §5/§10 site polish shipped 2026-07-11**: `GET /status` (§10.3 Trust Panel —
live KV/rate-limiter/signing health via an extended `/v1/version`, plus an honest
known-limitations list) and `GET /developers` (§5.7 Developer Console — interfaces
including honestly-unimplemented MCP/CLI/webhook, a full error-code reference table,
version policy, changelog). The homepage also gained the whitepaper's Appendix A
quick-task nav (Create Instant / Convert / Expand Group / Inspect Boundary / Create
Group / Developer Console) as anchor links into existing sections.

## AICL / AIRS-AILP layer (`/ai/`, `/llms.txt`)

CTCL now carries the same AI Ingestion & Capability Layer (AICL) + AI Rights
Spectrum / AI Learning Permission (AIRS/AILP) pattern Neo.K previously applied to the
EML and PHOSPHOR projects — four sublayers, served as static markdown/JSON with no
build step (consistent with this Worker's own architecture):

- **Manifest** — `/llms.txt`, `/ai/index.md`, `/ai/manifest.json`, `/ai/version.json`,
  `/ai/sitemap.json`.
- **Corpus** — `/ai/corpus/{origin,current,design-history,concept-genealogy,
  engineering-notes,accepted-concepts,deprecated-concepts,public-summary}.md` +
  `/ai/corpus/full-corpus.jsonl`.
- **Capability** — `/ai/specs/{ctcl-v1.md, instant/error/system/group-schema.json}`,
  seven worked examples under `/ai/examples/`, and `/ai/tools/{catalog.json,tools.md}`
  (the catalog is generated from the same source as `/ai/ctcl.json`, so it cannot
  drift from real behavior).
- **Governance/Rights** — `/ai/governance/{license,usage-policy,provenance,
  citation-policy,crawler-policy,versioning-policy}.md` + `/ai/rights-spectrum.json`.

**License: Apache-2.0** (decided 2026-07-12, matching EML). Full text in
[`LICENSE`](LICENSE). `rights-spectrum.json` reflects it directly — every AIRS/AILP
dimension (access, training, commercial use, redistribution, ...) is maximally open,
conditioned only on preserving copyright/license notices (attribution). Commercial
value for CTCL is intended to come from hosting the canonical instance and enterprise
integration/support (whitepaper §16), not from restricting reuse of the code or spec.

Migrated out of the `unbounded-axiom` repo into this standalone project on 2026-07-11.

**2026-07-12 — security-model gaps closed.** `POST /v1/instants` now signs the record at
registration time and persists the signature, so `GET /v1/instant/{id}` and the `/i/{id}`
share page both return the same verifiable proof no matter who retrieves it or when. The
client SDK (`/sdk.js`) added `monotonic()`, `guardedNow()`, and `offlineNow()` — see the
status paragraph above. `verifyInstant()` now also accepts the flat registered-instant
shape (previously only the `/v1/now` envelope shape worked) and takes an optional
`{maxAgeMs}` to flag a genuinely-signed-but-stale instant.

**2026-07-14 — Share Instant QR Code, custom-system signing.** The `/i/{id}` page now
renders a server-side QR Code (§6.6) of its own share URL — the project's first vendored
third-party dependency (a well-known MIT-licensed QR encoder, inlined verbatim, round-trip
verified via an independent decoder before inclusion since a subtly-wrong hand-rolled
Reed-Solomon implementation would look right without a real scanner being able to read
it). Separately, `POST /v1/systems` and `POST /v1/temporal-groups` now sign their whole
definitions with the same Ed25519 key used for instants — §31.1's "signed transform
metadata" control, closed completely: every persisted resource type is now signed.
And `tai`/`gps` timescales switched from a flat current-day offset (which was quietly
wrong for historical instants — a 1990 date got 2017's +37s instead of 1990's true
+25s) to the full 1972-2017 IERS historical leap-second table, verified against known
historical offsets before deploying. This still can't predict a future undeclared leap
second — nobody can, IERS gives ~6 months' notice — so post-2017 accuracy depends on
the table staying current; none has been declared since 2017-01-01.
