# CTCL CommonInstant Web
## 共同時間座標層的公開協議入口、網站產品與機器可讀服務技術白皮書

**版本：v0.1**  
**日期：2026-07-11**  
**產品入口：CommonInstant.org**  
**理論基礎：CTCL — Common Temporal Coordinate Layer**  
**文件定位：網站產品技術白皮書／公開協議入口規劃／網站與 API 戰略文件**  
**提出者：Neo.K / EVEMISSLAB**

---

# 摘要

CTCL（Common Temporal Coordinate Layer，共同時間座標層）提出一個不同於一般世界時鐘或時區轉換器的核心問題：

> **不同 Agent、應用程式、模擬器、長期記憶系統與自定義時間世界，如何確認它們正在指向同一個參考瞬間？**

傳統時間網站主要處理：

- 某城市現在幾點；
- 不同時區如何換算；
- 跨國會議何時召開；
- 日光節約時間如何影響地方時間；
- 日出、日落、曆法與人類民用時間資訊。

這些產品已由成熟網站與資料服務長期發展。CTCL 不需要重複建立另一個大型民用時間入口，也不應把自身定位為「更複雜的世界時鐘」。

CommonInstant Web 的正確定位是：

> **CTCL 的公開協議入口、概念展示層、開發者試驗台、Agent 可讀時間服務與共同瞬間分享介面。**

CTCL 的最小結構為：

$$
\boxed{
I^\*
+
S
+
P
+
G_T
}
$$

其中：

- $I^\*$：共同參考瞬間；
- $S$：時間尺度與時間語義；
- $P$：來源、品質、不確定度與版本；
- $G_T$：異質時間系統的轉換圖。

任一系統 $i$ 可將共同參考瞬間映射為其局部時間：

$$
\tau_i=\Phi_i(I^\*)
$$

因此，不同系統不必共享相同的時鐘、Epoch、曆法、速率或顯示格式，只需保留可追溯的轉換關係。

本白皮書將 CommonInstant Web 定義為 CTCL 的 **Web Reference Surface**。它不承擔所有本地裝置功能，也不取代未來的 CTCL App；其主要職責是：

1. 解釋 CTCL；
2. 提供可立即操作的 MVP；
3. 暴露 REST、OpenAPI、MCP 與 Tool Declaration；
4. 建立與分享共同瞬間；
5. 轉換標準與自定義時間系統；
6. 顯示來源、版本、不確定度與邊界風險；
7. 將一般民用時間需求導向成熟外部工具；
8. 為 CTCL App、SDK 與第三方實作提供協議參考。

---

# 1. 產品背景

## 1.1 CTCL 不是一般時間網站

一般世界時鐘的核心流程通常為：

$$
\text{UTC}
\rightarrow
\text{Timezone Rule}
\rightarrow
\text{Local Civil Time}
\rightarrow
\text{Display}
$$

CTCL 的核心流程則為：

$$
\text{Reference Instant}
\rightarrow
\text{Temporal Context}
\rightarrow
\text{Transform Graph}
\rightarrow
\text{Heterogeneous Representations}
$$

兩者並不互斥，但處理不同層級的問題。

一般時間網站回答：

> 台北與倫敦現在分別幾點？

CTCL 回答：

> 一個共同事件在台北民用時間、Agent 活動時間、模擬世界時間、遊戲曆法與研究事件時間中分別如何表示？這些表示使用了哪些規則、版本與來源？轉換是否可逆、是否有損，是否落在異常邊界？

因此：

$$
\boxed{
\text{CommonInstant Web}
\neq
\text{World Clock Clone}
}
$$

---

## 1.2 為什麼仍然需要網站

即使 CTCL 的主要長期使用者可能是：

- Agent；
- 自動化系統；
- 應用程式；
- 模擬器；
- 機器人；
- 研究基礎設施；
- 長期 AI 記憶系統；

仍需要一個公開網站，因為：

1. 開發者需要理解協議；
2. 人類需要觀測 Agent 的時間行為；
3. 新使用者需要低成本試用；
4. API 需要文件與 Playground；
5. 共同瞬間需要可分享網址；
6. 轉換結果需要人工稽核；
7. 第三方實作者需要參考行為；
8. 搜尋引擎需要一個穩定的公開入口。

正確策略不是取消人類介面，而是：

$$
\boxed{
\text{Minimal Human Interface}
+
\text{Rich Machine Interface}
}
$$

---

# 2. 產品定位與邊界

## 2.1 一句話定位

> **CommonInstant Web 是讓人類、開發者、Agent 與應用程式建立、檢查、轉換與分享共同參考瞬間的 CTCL 官方公開入口。**

---

## 2.2 主要目標使用者

### 第一類：Agent 與應用開發者

需求：

- 取得共同參考瞬間；
- 將時間值轉換成明確語義；
- 保存 `instant_id`；
- 查詢轉換路徑；
- 取得來源、不確定度與版本；
- 測試 API；
- 複製 Tool Declaration。

### 第二類：模擬器、遊戲與數位孿生開發者

需求：

- 建立自定義 Epoch；
- 設定時間速率；
- 暫停與恢復；
- 建立父層—子層時間；
- 將模擬時間對齊現實參考瞬間。

### 第三類：多 Agent 與長期記憶系統

需求：

- 對齊共同事件；
- 區分事件時間、寫入時間與回憶時間；
- 保存 Agent 活動時間；
- 共享可追溯時間錨點。

### 第四類：研究者與人類觀測者

需求：

- 理解 CTCL；
- 檢查轉換；
- 驗證時間來源；
- 觀察異質時間系統；
- 建立可引用的共同瞬間頁面。

---

## 2.3 非目標

CommonInstant Web v0.x 不應以以下市場為主要目標：

- 大型城市世界時鐘；
- 天氣與旅遊時間入口；
- 日出日落服務；
- 民用假期資料庫；
- 個人鬧鐘；
- 一般會議排程 SaaS；
- 航班時間查詢；
- 大型曆法內容平台。

這些功能若由成熟工具提供，CommonInstant Web 可以：

- 清楚說明自身邊界；
- 提供推薦連結；
- 不複製其 UI；
- 不爬取其專有內容；
- 不以不必要功能污染 CTCL 核心。

---

# 3. 核心理論模型

## 3.1 共同參考瞬間

令：

$$
I^\*
$$

代表可被不同系統共同指向的參考瞬間。

系統 $i$ 的局部時間為：

$$
\tau_i=\Phi_i(I^\*)
$$

其中 $\Phi_i$ 可以包含：

- Epoch；
- 速率；
- 偏移；
- 曆法；
- 時區；
- 跳秒政策；
- 暫停區段；
- 分段線性規則；
- 模擬規則；
- 版本資訊。

---

## 3.2 時間系統

定義：

$$
\mathcal S_i
=
(
E_i,
\tau_i,
r_i,
\phi_i,
\Pi_i,
\Omega_i
)
$$

其中：

- $E_i$：Epoch；
- $\tau_i$：局部座標；
- $r_i$：速率；
- $\phi_i$：相位或偏移；
- $\Pi_i$：政策；
- $\Omega_i$：來源、版本、不確定度與有效區間。

---

## 3.3 轉換圖

令：

$$
G_T=(V,E)
$$

其中：

- $V$：時間系統；
- $E$：轉換算子。

轉換不是只有公式，還必須保存：

```text
source_system
target_system
transform_type
transform_version
valid_from
valid_to
uncertainty
lossless
invertibility
provenance
```

---

## 3.4 非無損假設

不是所有轉換都可逆或無損。

例如：

$$
\text{nanosecond}
\rightarrow
\text{second}
$$

可能發生精度截斷。

地方民用時間在 DST fold 中可能：

$$
\Phi^{-1}(t_{\text{local}})
=
\{I_1^\*,I_2^\*\}
$$

因此 CTCL 回傳結果應包含：

$$
\text{Result}
+
\text{Uncertainty}
+
\text{Version}
+
\text{Loss Report}
+
\text{Ambiguity}
$$

---

# 4. CommonInstant Web 的角色

CommonInstant Web 應同時扮演五種角色。

## 4.1 協議入口

清楚呈現：

- CTCL 是什麼；
- CTCL 不宣稱什麼；
- 如何取得共同瞬間；
- 如何使用轉換；
- 如何儲存時間 metadata。

## 4.2 Reference Implementation

網站 API 與頁面結果應作為官方參考行為之一。

第三方可以依照：

- Schema；
- 轉換行為；
- 錯誤碼；
- 版本規則；
- Provenance 格式；

建立自己的 CTCL Client 或 Server。

## 4.3 API Playground

允許使用者：

- 呼叫 `/v1/now`；
- 呼叫 `/v1/convert`；
- 建立自定義時間系統；
- 檢查轉換路徑；
- 複製 JSON；
- 下載範例。

## 4.4 共同瞬間分享層

建立：

```text
https://commoninstant.org/i/<instant_id>
```

接收者可以將同一瞬間投影至自己的時間系統。

## 4.5 生態路由層

若使用者需要一般民用時間工具，網站應主動說明：

```text
World clock / meeting planner / sunrise / travel time
→ mature external civil-time services

Agent / simulation / heterogeneous time alignment
→ CommonInstant / CTCL
```

---

# 5. 網站資訊架構

建議主導航：

```text
Home
Create Instant
Convert
Temporal Systems
Temporal Groups
Boundary Inspector
Developers
Protocol
Status
About
```

---

## 5.1 Home

首頁回答三個問題：

1. CTCL 是什麼？
2. 現在可以做什麼？
3. 它與普通世界時鐘有何不同？

首頁第一屏可顯示：

### Current Common Instant

```json
{
  "instant_id": "ctcl:instant:...",
  "reference": "2026-07-11T...",
  "timescale": "UTC",
  "source": "...",
  "uncertainty_ms": "...",
  "sync_status": "..."
}
```

首頁不應只顯示漂亮時鐘，而應顯示：

- 共同瞬間；
- 時間尺度；
- 來源；
- 不確定度；
- 轉換能力。

---

## 5.2 Create Instant

使用者建立一個可持久引用的共同瞬間。

輸出：

- `instant_id`；
- UTC 表示；
- Unix 編碼；
- 來源；
- 建立時間；
- 分享 URL；
- QR Code；
- JSON。

---

## 5.3 Convert

輸入可包括：

- Unix seconds；
- Unix milliseconds；
- RFC 3339；
- ISO 8601；
- IANA timezone；
- Custom Epoch；
- CTCL System ID；
- Instant ID。

輸出必須明確區分：

- value；
- encoding；
- timescale；
- local representation；
- transform path；
- transform version；
- ambiguity；
- loss。

---

## 5.4 Temporal Systems

建立與檢視自定義系統。

最小線性系統：

$$
\tau=aI+b
$$

進階系統：

- piecewise rate；
- pause／resume；
- custom calendar；
- event-triggered clock；
- parent-child nesting。

---

## 5.5 Temporal Groups

群組 $G$ 由多個時間系統構成：

$$
G^{(v)}
=
(
id,
members,
constraints,
owner,
version
)
$$

對同一瞬間：

$$
\mathcal E(I^\*,G)
=
\{
\tau_1,\tau_2,\dots,\tau_n
\}
$$

網站可提供：

> **One Instant, Many Worlds**

視圖。

---

## 5.6 Boundary Inspector

檢查：

- DST gap；
- DST fold；
- ambiguous local time；
- nonexistent local time；
- leap-second policy；
- transform version boundary；
- rate change；
- pause；
- clock rollback；
- custom policy transition。

輸出狀態：

$$
B(I,\mathcal S)
\in
\{
normal,
gap,
fold,
jump,
pause,
rate\_change,
policy\_change
\}
$$

---

## 5.7 Developers

包含：

- OpenAPI；
- REST Examples；
- MCP Adapter；
- Tool Declaration；
- SDK；
- CLI；
- Webhook；
- Error Codes；
- Changelog；
- Version Policy。

---

# 6. 模糊語義解析

## 6.1 問題

上游輸入可能是：

```text
Taipei
台北
TPE
台灣時間
明天下午三點
倫敦開盤前
```

CTCL 不應默認所有輸入已標準化。

---

## 6.2 解析流程

$$
\text{Ambiguous Input}
\rightarrow
\text{Temporal Candidates}
\rightarrow
\text{Canonical Context}
$$

建議工具：

```text
resolve_temporal_context
```

回傳：

```json
{
  "input": "Taipei",
  "candidates": [
    {
      "context_id": "iana:Asia/Taipei",
      "confidence": 0.99,
      "source": "IANA tzdb",
      "source_version": "..."
    }
  ]
}
```

---

## 6.3 不武斷解析

若輸入有歧義，返回候選：

$$
\{
(c_i,p_i,\Omega_i)
\}_{i=1}^{n}
$$

而不是自動隱藏歧義。

---

# 7. 條件式共同瞬間規劃

未來可提供：

```text
plan_shared_instant
```

給定限制：

$$
C_1,C_2,\dots,C_n
$$

求：

$$
I^\*
=
\operatorname*{argmax}_{I}
U(I\mid C_1,\dots,C_n)
$$

限制可包含：

- 人類工作時間；
- 維護窗口；
- GPU 可用時段；
- 市場開盤；
- 模擬狀態；
- Agent 任務期限；
- 低負載時段；
- 資料刷新時間。

輸出：

```json
{
  "instant_id": "...",
  "score": 0.91,
  "satisfied_constraints": [],
  "violated_constraints": [],
  "alternatives": [],
  "explanation": "..."
}
```

CommonInstant Web 不需要一開始做完整會議 SaaS；只需提供 CTCL 原生的限制求解展示。

---

# 8. API 架構

## 8.1 核心端點

```http
GET  /v1/now
GET  /v1/instants/{id}
POST /v1/instants
POST /v1/convert
POST /v1/transform
GET  /v1/path
POST /v1/systems
GET  /v1/systems/{id}
GET  /v1/systems/{id}/now
POST /v1/temporal-groups
POST /v1/temporal-groups/{id}/expand
POST /v1/resolve
POST /v1/boundaries/inspect
POST /v1/planner/shared-instant
```

---

## 8.2 標準回應封套

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "request_id": "req_...",
    "api_version": "v1",
    "server_observed_at": "..."
  }
}
```

錯誤：

```json
{
  "ok": false,
  "error": {
    "code": "AMBIGUOUS_LOCAL_TIME",
    "message": "...",
    "details": {}
  },
  "meta": {
    "request_id": "req_..."
  }
}
```

---

# 9. MCP 與其他介面

CTCL Core 不應被 MCP 綁死。

正確結構：

$$
\text{CTCL Core}
\rightarrow
\begin{cases}
REST\\
OpenAPI\\
MCP\\
SDK\\
CLI\\
Web
\end{cases}
$$

MCP 可以暴露：

```text
get_common_instant
convert_temporal_value
resolve_temporal_context
create_temporal_group
expand_instant_to_group
inspect_temporal_boundary
plan_shared_instant
```

但 MCP 是 Adapter，不是 CTCL 本體。

---

# 10. 信任與透明度

## 10.1 表示精度不等於測量準確度

若系統輸出九位小數，不代表具備奈秒級實際同步。

因此回傳應區分：

```text
representation_precision
estimated_accuracy
uncertainty
source
sync_status
```

---

## 10.2 來源與版本

每個重要結果保存：

```text
source
timescale
encoding
tzdb_version
leap_table_version
transform_version
policy_version
observed_at
validity
```

---

## 10.3 網站狀態頁

應提供：

- API status；
- clock source status；
- sync status；
- transform registry version；
- incident log；
- degraded mode；
- known limitations。

---

# 11. 安全模型

威脅：

- forged timestamp；
- stale sync；
- replay；
- transform poisoning；
- source spoofing；
- clock rollback；
- tzdb mismatch；
- uncertainty hiding；
- malicious custom expressions。

控制：

1. TLS；
2. rate limiting；
3. signed transform metadata；
4. allowlist；
5. monotonic checks；
6. replay detection；
7. version pinning；
8. audit logs；
9. sandboxed custom transforms；
10. explicit uncertainty。

---

# 12. 人類介面與外部工具路由

## 12.1 不自動判斷訪客「是人還是 Agent」

不建議依 Browser User-Agent 自動跳轉。

因為：

- 人類開發者會測試 API；
- Agent 可能透過瀏覽器；
- 自動跳轉降低可預期性。

應提供明確雙入口：

```text
For Agents & Systems
For Human Time Utilities
```

---

## 12.2 推薦外部成熟工具

建議文案：

> **正在尋找一般世界時鐘、跨時區會議、日出日落、假期或旅行時間工具？**  
> CommonInstant 專注於共同瞬間、Agent、模擬器與異質時間系統。一般民用時間需求可使用成熟的專業時間網站，例如 Timeanddate.com。

此策略的功能是：

- 清楚定義產品邊界；
- 不複製成熟市場；
- 尊重外部最佳實踐；
- 避免功能膨脹。

---

# 13. 網站 MVP 現況基線

目前 CommonInstant MVP 已具備或已形成的方向包括：

- 共同瞬間取得；
- `instant_id`；
- 標準編碼轉換；
- IANA 時區轉換；
- 自定義線性時間系統；
- 持久化自定義系統；
- 轉換路徑；
- 驗證資訊；
- Agent Tool Declaration；
- 來源與精度說明。

下一階段不應只增加更多時鐘顯示，而應強化：

1. Temporal Group；
2. Boundary Inspector；
3. Semantic Resolution；
4. Share Instant；
5. Developer Console；
6. Trust Panel。

---

# 14. 實作優先順序

## P0：MVP 穩定化

- Schema 固定；
- API version；
- error model；
- source disclosure；
- mobile layout；
- basic monitoring。

## P1：One Instant, Many Systems

$$
I^\*
\rightarrow
\{
\tau_1,\dots,\tau_n
\}
$$

這是最直觀的 CTCL 差異化展示。

## P2：Boundary Inspector

建立時間安全能力，而非只做轉換。

## P3：Temporal Group

將常用系統保存成版本化資源。

## P4：Share Instant

- URL；
- QR；
- JSON；
- signed payload。

## P5：Semantic Resolution

逐步處理城市、IANA ID、代碼與自然語言時間。

## P6：Constraint Planner

建立條件式共同瞬間規劃。

---

# 15. 與 CTCL App 的分工

## 15.1 網站負責

- 公開發現；
- 無安裝試用；
- 文件；
- API Playground；
- 共同瞬間分享；
- 參考實作；
- 公開狀態；
- 搜尋引擎入口。

## 15.2 App 負責

- 本地持久化；
- 裝置時鐘觀測；
- 離線轉換；
- 背景事件；
- 本地 API；
- Deep Link；
- App Intent；
- Agent Gateway；
- Temporal Workspace；
- 系統級端口。

---

## 15.3 共同底層

兩者共享：

```text
CTCL Core
Transform Registry
Instant Schema
Temporal System Schema
Policy Engine
Provenance
Versioning
Identity
Authentication
```

因此：

$$
\text{Web}
\neq
\text{App}
$$

但：

$$
\text{Web Core}
=
\text{App Core}
=
\text{CTCL Protocol Core}
$$

---

# 16. 商業與生態策略

## 16.1 公開層

免費：

- `/now`；
- 基礎轉換；
- 公開文件；
- 共享瞬間；
- 有限自定義系統。

## 16.2 Developer Tier

- 高配額；
- Temporal Groups；
- Webhooks；
- API keys；
- 歷史稽核；
- signed instant。

## 16.3 Enterprise Tier

- 私有部署；
- transform registry；
- custom source；
- SLA；
- audit；
- Agent fleet integration。

## 16.4 Open Protocol Strategy

CTCL 協議核心應可公開或部分開放，使：

- 第三方建立 Client；
- 第三方建立 Server；
- 學術研究驗證；
- 避免單一官方 App 成為唯一權威。

商業價值可集中於：

- 託管；
- 高可靠來源；
- 版本治理；
- 企業整合；
- 稽核；
- 開發者工具；
- App 端口。

---

# 17. 關鍵 KPI

不應只看普通網站流量。

建議：

- API successful calls；
- instant share count；
- transform success rate；
- ambiguity detection rate；
- boundary warning usage；
- developer key activation；
- SDK adoption；
- external CTCL implementation；
- App handoff count；
- transform version pinning rate。

---

# 18. 風險

## 18.1 被誤認為世界時鐘

對策：

- 首屏顯示共同瞬間與轉換圖概念；
- 不以城市列表作首頁核心；
- 明確外部工具推薦。

## 18.2 理論太抽象

對策：

- 任務入口；
- One Instant, Many Worlds；
- Playground；
- 範例。

## 18.3 宣稱過高精度

對策：

- 分離 representation 與 accuracy；
- 顯示 uncertainty；
- 誠實標示來源。

## 18.4 功能膨脹

對策：

- 保留 civil-time boundary；
- 將非核心需求導向外部工具；
- Policy-as-Roadmap。

## 18.5 MCP 過度綁定

對策：

- MCP 僅作 Adapter；
- 保留 REST、SDK、CLI。

---

# 19. 核心產品公理

## 公理一

$$
\boxed{
\text{Same Instant}
\neq
\text{Same Representation}
}
$$

## 公理二

$$
\boxed{
\text{Timestamp}
\neq
\text{Complete Temporal Semantics}
}
$$

## 公理三

$$
\boxed{
\text{Common Reference}
\neq
\text{Universal Absolute Time}
}
$$

## 公理四

$$
\boxed{
\text{Web Entry}
\neq
\text{Clock Website}
}
$$

## 公理五

$$
\boxed{
\text{CTCL Core}
\neq
\text{MCP}
}
$$

---

# 20. 結論

CommonInstant Web 的目標不是建立另一個龐大世界時鐘網站。

它的核心是：

> **把 CTCL 從理論與 API 草案轉化為可被看見、操作、驗證、分享與整合的公開協議入口。**

其最重要的網站體驗是：

$$
\boxed{
I^\*
\rightarrow
\{
\tau_{\text{human}},
\tau_{\text{agent}},
\tau_{\text{simulation}},
\tau_{\text{custom}}
\}
}
$$

也就是：

> **一個共同瞬間，可以在不同時間世界中被明確映射。**

CommonInstant Web 應保持：

- 人類可理解；
- Agent 可讀；
- 開發者可測；
- 協議可移植；
- 來源可追溯；
- 版本可治理；
- 邊界可檢查；
- 功能不膨脹。

其最終定位為：

$$
\boxed{
\text{CommonInstant Web}
=
\text{CTCL Public Gateway}
+
\text{Reference Surface}
+
\text{Developer Playground}
}
$$

---

# 附錄 A：首頁任務入口

```text
Create a Common Instant
Convert a Timestamp
Expand One Instant Across Systems
Inspect a Temporal Boundary
Create a Temporal Group
Open Developer Console
```

---

# 附錄 B：推薦外部工具聲明

> CommonInstant is designed for temporal interoperability among agents, applications, simulations, and custom time systems.  
> For conventional human-facing world clocks, meeting planners, calendars, sunrise/sunset data, and travel-time utilities, use mature civil-time services such as Timeanddate.com.

---

# 附錄 C：最小機器規則

```text
When temporal precision matters:
1. Retrieve or create a CTCL reference instant.
2. Preserve timescale and encoding.
3. Preserve source and uncertainty.
4. Convert through explicit transforms.
5. Store transform version.
6. Never silently infer timezone.
7. Check ambiguity and boundary conditions.
```

---

# 附錄 D：網站與 App 戰略關係

```text
CommonInstant Web
↓ public discovery / protocol / playground / sharing

CTCL Core
↓ shared schema / transforms / provenance / policy

CTCL Temporal Port App
↓ local node / workspace / gateway / control plane
```

---

**文件結束**
