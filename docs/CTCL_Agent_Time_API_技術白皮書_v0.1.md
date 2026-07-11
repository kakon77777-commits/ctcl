# CTCL Agent Time API
## 面向 Agent、長期記憶、模擬器與異質時間系統的共同時間座標層技術白皮書

**版本：v0.1**  
**定位：Agent-facing 技術白皮書／API 與協議草案**  
**目標：讓 Agent 可取得共同參考瞬間、轉換異質時間系統、追溯時間來源並安全處理不確定性**

---

## 1. Executive Summary

CTCL（Common Temporal Coordinate Layer，共同時間座標層）是一個面向機器與 Agent 的時間參考與轉換協議。

它不只提供：

```text
current timestamp
```

而提供：

```text
reference instant
+ timescale
+ encoding
+ provenance
+ uncertainty
+ transformation graph
```

CTCL 的目標是讓下列系統共享同一個可機器解析的時間底座：

- AI Agent
- multi-agent systems
- long-term memory systems
- robotics
- digital twins
- simulations
- games
- distributed systems
- scientific workflows
- future persistent AI entities

核心原則：

```text
Same instant, different representations.
Different clocks, explicit transforms.
No hidden time semantics.
```

---

# 2. Design Goals

## 2.1 Primary Goals

1. 取得共同參考瞬間。
2. 回傳 Unix / POSIX 類時間。
3. 回傳 UTC 可讀表示。
4. 支援多時間尺度。
5. 支援多 Epoch。
6. 支援自定義時間系統。
7. 支援時間轉換圖。
8. 回傳來源。
9. 回傳不確定度。
10. 回傳同步狀態。
11. 支援 Agent 可讀 JSON。
12. 支援高精度值。
13. 支援版本治理。

---

## 2.2 Non-Goals

CTCL v0.1 不宣稱：

- 提供宇宙絕對時間；
- 取代所有 NTP / PTP；
- 取代國家授時機構；
- 保證奈秒級全球一致；
- 自動處理所有相對論校正；
- 自動證明來源可信。

CTCL 是：

# **Reference + Transformation Layer**

不是：

# **Universal Clock Authority**

---

# 3. Core Concepts

CTCL 定義四個核心物件：

```text
Instant
Timescale
Encoding
Transform
```

---

## 3.1 Instant

Instant 代表共同參考瞬間。

建議 ID：

```text
ctcl:instant:<uuid>
```

範例：

```json
{
  "instant_id": "ctcl:instant:018f...",
  "observed_at": "2026-07-07T07:35:21.123456789Z"
}
```

---

## 3.2 Timescale

範例：

```text
UTC
TAI
UT1
GPS
POSIX
CUSTOM
```

Schema：

```json
{
  "id": "utc",
  "type": "reference_timescale",
  "version": "2026-01"
}
```

---

## 3.3 Encoding

範例：

```text
unix_s
unix_ms
unix_us
unix_ns
rfc3339
iso8601
julian_date
modified_julian_date
custom_epoch
```

---

## 3.4 Transform

Transform 定義：

```text
source system
target system
rule
version
validity
uncertainty
invertibility
```

---

# 4. Canonical Response Envelope

所有 CTCL API 建議採用：

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "request_id": "req_...",
    "server_observed_at": "...",
    "api_version": "v1"
  }
}
```

錯誤：

```json
{
  "ok": false,
  "error": {
    "code": "AMBIGUOUS_TIME",
    "message": "...",
    "details": {}
  },
  "meta": {
    "request_id": "req_..."
  }
}
```

---

# 5. GET /v1/now

## Purpose

取得共同參考瞬間。

---

## Request

```http
GET /v1/now
```

Optional query：

```text
precision=ns
include=utc,tai,posix
source=best
```

---

## Response

```json
{
  "ok": true,
  "data": {
    "instant": {
      "id": "ctcl:instant:...",
      "reference": {
        "timescale": "utc",
        "value": "2026-07-07T07:35:21.123456789Z"
      }
    },
    "encodings": {
      "unix_s": "178341...",
      "unix_ms": "178341...",
      "unix_ns": "178341..."
    },
    "source": {
      "class": "network_time",
      "protocol": "ntp",
      "provider": "configured",
      "sync_status": "synchronized"
    },
    "quality": {
      "precision": "nanosecond_representation",
      "estimated_uncertainty_ns": 2500000
    },
    "policy": {
      "leap_second": "posix_compatible",
      "tzdb_version": "2026x"
    }
  },
  "meta": {
    "api_version": "v1"
  }
}
```

---

# 6. GET /v1/instant/{id}

Purpose：

重新取得已登錄 instant。

```http
GET /v1/instant/ctcl:instant:...
```

Agent use case：

- 多 Agent 共享事件；
- 任務追溯；
- memory reference。

---

# 7. POST /v1/convert

## Purpose

轉換時間表示。

---

## Request

```json
{
  "input": {
    "value": "1783420000.123456789",
    "encoding": "unix_s",
    "timescale": "posix"
  },
  "output": {
    "encoding": "rfc3339",
    "timescale": "utc"
  }
}
```

---

## Response

```json
{
  "ok": true,
  "data": {
    "input": {},
    "output": {
      "value": "2026-07-07T...",
      "encoding": "rfc3339",
      "timescale": "utc"
    },
    "transform": {
      "path": [
        "posix",
        "utc"
      ],
      "version": "..."
    },
    "quality": {
      "lossless": false,
      "estimated_uncertainty_ns": 0
    }
  }
}
```

---

# 8. POST /v1/transform

此 endpoint 用於系統時間。

例如：

```text
real time -> game time
parent clock -> child clock
wall time -> active time
```

---

## Request

```json
{
  "source_system": "ctcl:system:unix",
  "target_system": "user:game_world_alpha",
  "value": "1783420000.0"
}
```

---

## Response

```json
{
  "ok": true,
  "data": {
    "value": "82938293.22",
    "system": "user:game_world_alpha",
    "transform_path": [
      "ctcl:system:unix",
      "user:game_world_alpha"
    ]
  }
}
```

---

# 9. Custom Time System Schema

```json
{
  "id": "user:game_world_alpha",
  "name": "Game World Alpha",
  "parent": "ctcl:system:unix",
  "epoch": {
    "parent_value": "1780000000",
    "encoding": "unix_s"
  },
  "rate": {
    "type": "constant",
    "value": 12.0
  },
  "offset": "0",
  "calendar": {
    "day_seconds": 72000,
    "year_days": 400
  },
  "policy": {
    "pause_supported": true,
    "negative_time": false
  }
}
```

---

# 10. POST /v1/systems

建立自定義時間系統。

---

## Request

```json
{
  "system": {
    "id": "user:sim_x",
    "parent": "ctcl:system:unix",
    "epoch": {
      "parent_value": "1780000000"
    },
    "rate": {
      "type": "constant",
      "value": 30
    }
  }
}
```

---

# 11. GET /v1/systems/{id}/now

取得該系統當前時間。

```http
GET /v1/systems/user:sim_x/now
```

Response：

```json
{
  "ok": true,
  "data": {
    "reference_instant": "ctcl:instant:...",
    "system_time": "98299382.11",
    "system_id": "user:sim_x"
  }
}
```

---

# 12. Transform Types

CTCL v0.1 建議支持：

```text
identity
offset
linear_rate
piecewise_linear
paused_clock
table_lookup
calendar
timezone
custom_expression
```

---

## 12.1 identity

\[
y=x
\]

---

## 12.2 offset

\[
y=x+b
\]

---

## 12.3 linear_rate

\[
y=ax+b
\]

---

## 12.4 piecewise_linear

\[
y=
\begin{cases}
a_1x+b_1,&x<t_1\\
a_2x+b_2,&t_1\le x<t_2\\
\cdots
\end{cases}
\]

---

## 12.5 paused_clock

\[
\tau(t)
=
\int r(t)\,dt
\]

其中：

```text
r(t) = 0 during pause
```

---

# 13. Transform Graph

CTCL 將時間系統表示為：

\[
G_T=(V,E)
\]

其中：

```text
V = systems
E = transforms
```

Agent 可以要求：

```http
GET /v1/path?from=A&to=D
```

Response：

```json
{
  "ok": true,
  "data": {
    "path": [
      "A",
      "B",
      "C",
      "D"
    ],
    "lossless": false,
    "estimated_uncertainty_ns": 1200
  }
}
```

---

# 14. Path Selection

多條路徑時，CTCL 可以依：

```text
lowest uncertainty
lowest latency
fewest transforms
highest trust
user policy
```

選擇。

Query：

```http
GET /v1/path?from=A&to=D&optimize=uncertainty
```

---

# 15. Provenance Model

時間來源必須可追溯。

Schema：

```json
{
  "provenance": {
    "source_class": "network_time",
    "protocol": "ntp",
    "server": "configured",
    "stratum": 2,
    "last_sync": "...",
    "chain": [
      {
        "type": "local_server"
      },
      {
        "type": "upstream"
      }
    ]
  }
}
```

Agent SHOULD NOT assume：

```text
timestamp = truth
```

Agent SHOULD inspect：

```text
source
sync_status
uncertainty
policy
```

---

# 16. Quality Model

建議：

```json
{
  "quality": {
    "precision_ns": 1,
    "estimated_uncertainty_ns": 2500000,
    "synchronized": true,
    "freshness_ms": 14,
    "confidence": "high"
  }
}
```

注意：

```text
precision != accuracy
```

例如：

```text
nanosecond field
```

不代表：

```text
nanosecond accurate
```

---

# 17. Versioning

所有轉換規則 SHOULD versioned。

```json
{
  "version": {
    "api": "v1",
    "transform": "2026.07",
    "tzdb": "2026x",
    "leap_table": "2026-01"
  }
}
```

Agent MUST NOT cache transform forever without version.

---

# 18. Ambiguity Handling

某些 local time 可能：

```text
nonexistent
ambiguous
```

例如 DST。

Response：

```json
{
  "ok": false,
  "error": {
    "code": "AMBIGUOUS_LOCAL_TIME",
    "details": {
      "candidates": [
        "...",
        "..."
      ]
    }
  }
}
```

Agent MUST ask policy or choose explicit disambiguation.

---

# 19. Lossy Transform

若：

```text
ns -> s
```

轉換會 loss。

Response SHOULD include：

```json
{
  "lossless": false,
  "loss": {
    "type": "precision_truncation"
  }
}
```

---

# 20. Invertibility

Transform Schema：

```json
{
  "invertibility": {
    "type": "exact"
  }
}
```

或：

```json
{
  "invertibility": {
    "type": "partial"
  }
}
```

或：

```json
{
  "invertibility": {
    "type": "none"
  }
}
```

---

# 21. Agent Invocation Contract

Agent 使用 CTCL 時 SHOULD：

1. Identify task.
2. Determine required timescale.
3. Determine precision.
4. Fetch `/now`.
5. Inspect provenance.
6. Inspect uncertainty.
7. Convert explicitly.
8. Store instant ID.
9. Store transform version.
10. Never silently assume timezone.

---

# 22. Minimal Agent Prompt Contract

推薦 Agent system instruction：

```text
When temporal precision matters:
1. Retrieve CTCL reference instant.
2. Preserve timescale and encoding.
3. Record source and uncertainty.
4. Use explicit transform endpoints.
5. Never infer timezone from locale.
6. Never treat Unix time as UTC without checking policy.
7. Store transform version with long-term memory.
```

---

# 23. Long-Term Memory Integration

Memory entry：

```json
{
  "memory_id": "mem_...",
  "content": "...",
  "time": {
    "event_instant": "ctcl:instant:...",
    "written_instant": "ctcl:instant:...",
    "recalled_instant": null
  }
}
```

這允許區分：

```text
event time
write time
recall time
```

---

# 24. Agent Life-History Schema

對 persistent Agent：

```json
{
  "agent_id": "agent:...",
  "life_time": {
    "origin_instant": "ctcl:instant:...",
    "wall_elapsed_s": "...",
    "active_elapsed_s": "...",
    "suspended_elapsed_s": "..."
  }
}
```

---

# 25. Active Time

Agent active time：

\[
\tau_A(t)
=
\int_{t_0}^{t}
a(s)\,ds
\]

其中：

\[
a(s)\in\{0,1\}
\]

或：

\[
a(s)\in[0,1]
\]

用於：

- suspended；
- degraded；
- partially active。

---

# 26. Task Time

Task：

```json
{
  "task_id": "task:...",
  "time": {
    "created": "ctcl:instant:...",
    "started": "ctcl:instant:...",
    "deadline": "ctcl:instant:...",
    "completed": null
  }
}
```

---

# 27. Multi-Agent Synchronization

Shared event：

```json
{
  "event_id": "event:...",
  "reference_instant": "ctcl:instant:...",
  "participants": [
    "agent:a",
    "agent:b",
    "agent:c"
  ]
}
```

Each Agent may map：

```text
I* -> local time
```

---

# 28. Simulation Integration

Simulation system：

```json
{
  "id": "sim:earth_x",
  "parent": "ctcl:system:utc",
  "rate": {
    "type": "piecewise"
  }
}
```

Agent can ask：

```http
GET /v1/systems/sim:earth_x/now
```

---

# 29. Robotics Integration

Robot event：

```json
{
  "event": "sensor_capture",
  "time": {
    "device_clock": "...",
    "reference_instant": "...",
    "sync_uncertainty_ns": 50000
  }
}
```

---

# 30. Digital Twin Integration

Digital twin mapping：

```text
physical time
-> ingestion time
-> simulation time
-> prediction horizon
```

Schema：

```json
{
  "physical_instant": "...",
  "ingested_at": "...",
  "simulation_time": "...",
  "forecast_valid_for": "..."
}
```

---

# 31. Security Model

Threats：

- forged timestamp；
- stale sync；
- malicious transform；
- tzdb poisoning；
- replay；
- clock rollback；
- source spoofing；
- uncertainty hiding。

---

## 31.1 Required Controls

1. TLS.
2. Signed transform metadata.
3. Source allowlist.
4. Monotonic checks.
5. Replay detection.
6. Version pinning.
7. Audit logs.

---

# 32. Monotonic Time

Wall clock can jump.

Agent tasks SHOULD use monotonic clocks for durations.

CTCL should distinguish：

```text
reference wall time
monotonic duration time
```

Never calculate timeout solely from mutable wall clock.

---

# 33. Clock Rollback

If：

\[
t_{n+1}<t_n
\]

CTCL SHOULD flag：

```json
{
  "warning": {
    "code": "CLOCK_ROLLBACK_DETECTED"
  }
}
```

---

# 34. Leap Policy

CTCL MUST expose policy.

Examples：

```text
strict_utc
posix_compatible
smear
custom
```

Agent MUST NOT silently mix policies.

---

# 35. Precision Tiers

Suggested：

```text
coarse      >= 1 s
standard    >= 1 ms
high        >= 1 us
ultra       >= 1 ns representation
```

Representation precision does not guarantee source accuracy.

---

# 36. Trust Tiers

Suggested：

```text
T0 unknown
T1 local unsynchronized
T2 network synchronized
T3 authenticated source
T4 calibrated authoritative chain
```

---

# 37. Caching Policy

`/now`：

```text
no long cache
```

Transform definitions：

```text
cache with version
```

Historical tables：

```text
cache immutable snapshot
```

---

# 38. Rate Limits

Public API example：

```text
anonymous: 60 req/min
api key: 600 req/min
agent tier: configurable
```

Critical systems SHOULD self-host or use redundant sources.

---

# 39. Offline Mode

CTCL client can operate：

```text
last known transform graph
+ local clock
+ degraded quality flag
```

Response：

```json
{
  "quality": {
    "mode": "offline_degraded"
  }
}
```

---

# 40. Suggested OpenAPI Resource Map

```text
GET  /v1/now
GET  /v1/instant/{id}
POST /v1/convert
POST /v1/transform
GET  /v1/path
GET  /v1/timescales
GET  /v1/encodings
GET  /v1/systems
POST /v1/systems
GET  /v1/systems/{id}
GET  /v1/systems/{id}/now
GET  /v1/transforms/{id}
POST /v1/validate
```

---

# 41. POST /v1/validate

Purpose：

讓 Agent 驗證時間物件。

Request：

```json
{
  "value": {
    "time": "...",
    "timescale": "utc",
    "encoding": "rfc3339"
  }
}
```

Response：

```json
{
  "ok": true,
  "data": {
    "valid": true,
    "warnings": []
  }
}
```

---

# 42. Error Codes

Suggested：

```text
INVALID_TIME_VALUE
UNKNOWN_TIMESCALE
UNKNOWN_ENCODING
UNKNOWN_SYSTEM
NO_TRANSFORM_PATH
AMBIGUOUS_LOCAL_TIME
NONEXISTENT_LOCAL_TIME
LOSSY_TRANSFORM
UNSYNCED_SOURCE
SOURCE_UNAVAILABLE
CLOCK_ROLLBACK_DETECTED
VERSION_MISMATCH
OUT_OF_VALID_RANGE
UNSUPPORTED_POLICY
```

---

# 43. Agent Decision Matrix

## Low-risk display

May use：

```text
best available time
```

## Financial deadline

Require：

```text
explicit timezone
source
uncertainty
version
```

## Scientific experiment

Require：

```text
timescale
source chain
uncertainty
calibration metadata
```

## Long-term memory

Require：

```text
instant ID
encoding
timescale
transform version
```

---

# 44. Reference Client Pseudocode

```text
function get_shared_now():
    response = GET /v1/now

    assert response.ok
    assert response.data.source.sync_status == "synchronized"

    return {
        instant_id,
        utc,
        unix_ns,
        provenance,
        uncertainty,
        policy_version
    }
```

---

# 45. Conversion Pseudocode

```text
function convert_time(value, from, to):
    response = POST /v1/convert

    if response.error == AMBIGUOUS_LOCAL_TIME:
        request explicit disambiguation

    if response.data.quality.lossless == false:
        record transform loss

    return response.data.output
```

---

# 46. Persistent Agent Pseudocode

```text
on_agent_event(event):
    now = ctcl.get_shared_now()

    memory.write({
        event,
        reference_instant: now.instant_id,
        local_time: map_to_agent_clock(now),
        source_quality: now.quality
    })
```

---

# 47. Custom World Pseudocode

```text
create_system({
    parent: "ctcl:system:unix",
    epoch: 1780000000,
    rate: 12,
    calendar: custom
})

world_now = GET /systems/world/now
```

---

# 48. MVP Architecture

Minimal deployment：

```text
[Public Web]
    |
[API Gateway]
    |
[Time Core]
    |---- Source Adapter
    |---- Timescale Module
    |---- Encoding Module
    |---- Transform Graph
    |---- Provenance Module
    |
[Registry DB]
    |---- systems
    |---- transforms
    |---- versions
```

---

# 49. Recommended Implementation Separation

Do NOT put everything in one function.

Modules：

```text
clock_source
timescale
encoding
calendar
timezone
transform
graph
provenance
quality
registry
api
```

---

# 50. MVP Scope

v0.1 SHOULD implement：

1. `/now`
2. Unix seconds
3. Unix milliseconds
4. Unix nanosecond string
5. RFC3339 UTC
6. explicit timezone conversion
7. provenance
8. uncertainty
9. custom linear-rate system
10. transform graph
11. OpenAPI spec

---

# 51. v0.2

Add：

- multiple timescales
- custom epochs
- pause/resume
- piecewise rates
- tzdb version
- transform versioning
- signed metadata

---

# 52. v0.3

Add：

- Agent memory SDK
- life-history clock
- task clock
- simulation adapter
- digital twin adapter

---

# 53. Future Research

Potential：

- relativistic coordinate transforms
- lunar / Martian clocks
- distributed consensus
- cryptographic timestamping
- AI identity continuity
- legal event time
- multi-agent causal ordering
- subjective active-time models

---

# 54. Why Agents Need This

Agent systems increasingly operate across：

- browsers；
- terminals；
- local files；
- cloud systems；
- calendars；
- robotic devices；
- simulations；
- long-term memories。

Without explicit time semantics：

```text
"today"
"tomorrow"
"now"
"before"
"after"
```

can become unstable.

CTCL gives Agent a machine-readable temporal anchor.

---

# 55. Core Agent Rule

The most important rule：

```text
Do not ask only:
"What time is it?"

Ask:
"What reference instant is this,
under which timescale,
from which source,
and how is it transformed into my local system?"
```

---

# 56. Final Architecture Principle

CTCL is based on：

\[
\boxed{
I^\*
+
S
+
P
+
G_T
}
\]

where：

- \(I^\*\)：Reference Instant
- \(S\)：Timescale Semantics
- \(P\)：Provenance
- \(G_T\)：Transform Graph

---

# 57. Conclusion

CTCL 將時間 API 從：

```text
timestamp endpoint
```

提升為：

```text
machine-readable temporal reference layer
```

核心價值不是多回傳幾個格式。

而是讓：

- Agent
- simulation
- robot
- long-term memory
- digital twin
- persistent AI

可以共享：

# **同一參考瞬間**

並各自映射到：

# **自己的時間世界**

最終公式：

\[
\tau_i=\Phi_i(I^\*)
\]

這是 CTCL 的最小核心。

---

# Appendix A：MVP JSON

```json
{
  "instant": {
    "id": "ctcl:instant:...",
    "utc": "2026-07-07T07:35:21.123456789Z",
    "unix_ns": "..."
  },
  "source": {
    "protocol": "ntp",
    "sync_status": "synchronized"
  },
  "quality": {
    "estimated_uncertainty_ns": 2500000
  },
  "policy": {
    "leap_second": "posix_compatible"
  }
}
```

---

# Appendix B：Agent Minimum Storage

Store at least：

```text
instant_id
timescale
encoding
source_quality
transform_version
```

---

# Appendix C：One-Sentence Version

> CTCL is a machine-readable reference and transformation layer that lets heterogeneous agents and systems share the same instant without requiring the same clock, calendar, epoch, or local time model.

---

# Appendix D：Status

This document is：

```text
v0.1
proposal
not a standard
not a timing authority
designed for iterative implementation
```

---

**文件結束**
