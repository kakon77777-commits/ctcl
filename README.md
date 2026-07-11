# CTCL — Common Temporal Coordinate Layer

**共同時間座標層** · a verified reference instant + heterogeneous time transformation
layer for agents. **Same instant, different representations** — a reference layer, not a
timing authority.

**Live:** https://commoninstant.org · by Neo.K / 一言諾科技有限公司 (EveMissLab)

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
| `POST /v1/instants` · `GET /v1/instant/{id}` | register / retrieve a shared instant I\* (multi-agent alignment) |
| `POST /v1/systems` · `GET /v1/systems` · `/{id}` · `/{id}/now` | persistent custom systems — `rate.type` = constant \| piecewise \| **paused** (active-time) \| table |
| `GET /v1/path` | transform-graph route between systems/timescales |
| `POST /v1/temporal-groups` · `GET /v1/temporal-groups` · `/{id}` · `POST /{id}/expand` | **Temporal Groups** — "One Instant, Many Systems": project one instant across every member (builtin timescale \| `tz:<IANA>` \| custom system id) in a single call |
| `POST /v1/boundaries/inspect` | **Boundary Inspector** — proactive gap/fold/pause/rate_change status check + upcoming DST transitions; never errors, unlike `/v1/convert` |
| `POST /v1/validate` | validate a time object |
| `GET /v1/transforms(/{id})` | transform-type catalog (§12) |
| `GET /v1/timescales` · `GET /v1/encodings` · `GET /v1/version` | supported timescales / encodings / versions + precision & trust tiers |
| `GET /sdk.js` · `GET /openapi.json` · `GET /ai/ctcl.json` | JS SDK · OpenAPI · agent tool declaration |
| `GET /` | human page: live reference instant + drift, settings (language / theme / experimental Spacetime) |

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
Google Fonts on the page. State (the instant + system registries) lives in the
`CTCL_KV` namespace; graceful `503` if it is ever unbound.

## Spec & status

Driving whitepapers in [`docs/`](docs/):
- `共同時間座標層與異質時空間轉換_v0.1.md` — theory
- `CTCL_Agent_Time_API_技術白皮書_v0.1.md` — API / protocol (57 §), the original MVP driver
- `CTCL_CommonInstant_Web_網站協議入口技術白皮書_v0.1.md` — this website's own product
  whitepaper: public protocol gateway, reference surface, developer playground
- `CTCL_Temporal_Port_App_通用時間端口技術白皮書_v0.1.md` — a separate, not-yet-started
  installable desktop app (Rust core, local gateway, device clock observer) — future work

v0.1 (Agent Time API) status (~80–85%): the §40 endpoint map is complete (13/13), MVP §50
complete, multi-agent alignment, active-time / life-history, precision-preserving convert,
DST ambiguity, and the client SDK are all live. Remaining: `custom_expression` transform
(intentionally unimplemented — arbitrary-expression eval is a security risk); enforcement
layers (signed metadata beyond `/v1/now`, hard rate limits via Durable Object, trust
elevation); offline mode; simulation / robotics / digital-twin adapters; full leap-aware
TAI/GPS conversion.

CommonInstant Web whitepaper progress: P0 (schema/versioning/error-model stabilization) was
already satisfied by the API whitepaper work above. **P1 — Temporal Groups ("One Instant,
Many Systems") shipped 2026-07-11**: `POST/GET /v1/temporal-groups`, `GET /{id}`,
`POST /{id}/expand` project one instant across every member of a named group in one call;
homepage has a live demo. **P2 — Boundary Inspector shipped 2026-07-11**:
`POST /v1/boundaries/inspect` — given `{timezone, local_value}` returns `normal`/`gap`/`fold`
plus upcoming DST transitions within a window; given `{system_id, value?}` returns
`normal`/`pause`/`rate_change` for a custom system; always returns a status instead of
erroring (unlike `/v1/convert`), so an agent can pre-flight-check before committing.
Remaining Web-whitepaper priorities: P3 persisted-group polish, P4 Share Instant
(`/i/<id>`), P5 semantic resolution (`resolve_temporal_context`), P6 constraint planner
(`plan_shared_instant`).

Migrated out of the `unbounded-axiom` repo into this standalone project on 2026-07-11.
