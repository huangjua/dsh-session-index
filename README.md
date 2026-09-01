<div align="center">

# 🔍 dsh-session-index

**Full-text session search & bookmarking engine for DSH**  
*Native CJK Substring Search • Non-Blocking Worker Pool • Multi-Signal Ranking • Jump-Back Bookmarks*

[![DSH Suite](https://img.shields.io/badge/DSH_Power_Suite-Session_Index-purple?style=flat-square)](https://github.com/huangjua)
[![CJK Search](https://img.shields.io/badge/CJK_Search-FTS5_Trigram-success?style=flat-square)](#)
[![License](https://img.shields.io/badge/License-BSD--3--Clause-orange?style=flat-square)](LICENSE)

[Features](#-key-features) • [Quick Start](#-quick-start) • [DSH Power Suite](#-dsh-power-suite) • [Tools](#-available-tools) • [Architecture](#-architecture) • [简体中文](README_zh.md)

</div>

---

### 💡 Why dsh-session-index?

DSH archives past conversations as compressed `.jsonl.zstd` event logs. Built-in search only supports exact whole-word Latin tokens, making Chinese searches return zero results, while full-pass decompression freezes the UI.

**`dsh-session-index` transforms dead logs into an instantly queryable second brain:**
- 🇨🇳 **Native CJK & Latin Substring FTS**: Engineered with FTS5 trigrams. The *only* implementation allowing Chinese substring & code fragment matching across historical turns.
- 🚀 **Non-Blocking Worker Pool**: Streaming decompression with multi-core workers. Keeps main-thread event loop lag strictly under `p95 < 23ms`.
- 🎯 **Multi-Signal Relevance Ranking**: Combines `fzy` fuzzy scoring, 21-day half-life recency decay, and workspace affinity (adapted from Atuin and McFly).
- 🔖 **Deterministic Bookmarking & Jump-Back**: Drop anchors at `(sessionId, messageId)` to quickly revisit past breakthroughs without modifying original archive files.

---

## 🚀 Quick Start

### Installation

```bash
# In your DSH plugin environment
dev_inject_plugin @dsh-external/dsh-session-index
```

### Typical Usage Flow

1. **Search with Chinese / Substring**: Run `session_index_search query="重构 认证中间件" mode="full"`.
2. **Review Relevance-Ranked Hits**: Inspect Codex-style snippet previews with exact message IDs.
3. **Drop a Bookmark**: Save critical moments via `session_index_bookmark action="add" label="JWT Auth Fix"`.

---

## 🧩 DSH Power Suite

This plugin is part of the **DSH Agent Power Suite** — 4 modular, zero-hard-dependency plugins forming a complete closed-loop developer workflow:

```mermaid
graph LR
    M["🧠 <b>dsh-local-memory</b><br/><i>1. Remember rules & prefs</i>"] 
    --> E["⚡ <b>dsh-context-economy</b><br/><i>2. Save 80%+ tokens reading code</i>"]
    --> A["🛡️ <b>dsh-evidence</b><br/><i>3. Tamper-proof audit receipts</i>"]
    --> S["🔍 <b>dsh-session-index</b><br/><i>4. CJK search & bookmarks</i>"]
    --> M

    style M fill:#e8f4fd,stroke:#2b7de9,stroke-width:2px;
    style E fill:#eef9f2,stroke:#1e8e3e,stroke-width:2px;
    style A fill:#fef7e0,stroke:#f29900,stroke-width:2px;
    style S fill:#f3e8fd,stroke:#8430ce,stroke-width:2px;
```

| Plugin | Role in Suite | Synergy with Session Index |
|---|---|---|
| 🔍 **[dsh-session-index](https://github.com/huangjua/dsh-session-index)** | **Session Search** (Current) | Provides high-speed CJK search and bookmarking across compressed session archives. |
| 🧠 **[dsh-local-memory](https://github.com/huangjua/dsh-local-memory)** | **Memory Layer** | Curates high-level memories. Memory curation belongs to local-memory; log search belongs here. |
| 🛡️ **[dsh-evidence](https://github.com/huangjua/dsh-evidence)** | **Audit & Receipts** | Allows searching past sessions to find past evidence bundles, audit logs, and claim anchors. |
| ⚡ **[dsh-context-economy](https://github.com/huangjua/dsh-context-economy)** | **Context Economy** | Compact pointer output generates 80%+ smaller session logs, reducing search index load. |

---

## 📖 Deep Dive & Reference

<details>
<summary><b>🛠️ Available Tools (5 Tools)</b></summary>

| Tool | Description |
|---|---|
| `session_index_status` | Inspect / refresh indexing state (active, progress, worker health, retention). |
| `session_index_list` | List sessions by workspace with stable cursor pagination or relevance sorting. |
| `session_index_search` | Search sessions in `mode=meta` or `mode=full` (FTS/Worker) with `role` and time filters. |
| `session_summary` | Generate deterministic summaries (timestamps, event breakdown, tool calls, optional LLM 1-liner). |
| `session_index_bookmark` | Add/list/remove bookmarks anchored at `(sessionId, messageId)` for instant jump-back. |

</details>

<details>
<summary><b>🏗️ Architecture & Non-Blocking Pipeline</b></summary>

```text
session_index_status / session_index_list / session_index_search / session_summary
        │
        ▼
SessionIndexBuilder (Singleton per root + indexFile)
 ├─ Single-flight Promise deduplication
 ├─ Durable run-marker: ~/.dsh/session-index/.tmp/build.lock
 ├─ Phase A (Head Pass): Stream-decompress first 10 records ➡️ quick index
 ├─ Phase B (Full Pass): Full event counts & assistant text ➡️ WorkerPool
 └─ Atomic Commit: Unique tmpfile ➡️ fsync ➡️ validate ➡️ rename
```

</details>

<details>
<summary><b>⚖️ Technical Trade-offs & Boundaries</b></summary>

| Advantage | Trade-off / Boundary |
|---|---|
| Unique CJK trigram search implementation | Couplings to DSH's compressed session storage format |
| Non-blocking worker pool (lag < 23ms) | Requires `node:sqlite` for FTS index |
| 214 test cases covering crash consistency & streaming | Dual index co-exists with official session query service |

</details>

<details>
<summary><b>🧪 Building & Testing</b></summary>

```bash
pnpm run check:dsh-contract  # Contract validation
pnpm run build               # Build TypeScript to lib/
npm test                     # Run 214 test cases
```

</details>

<details>
<summary><b>🙏 Credits & Prior Art</b></summary>

- **OpenAI Codex** (`commit 9ded177`): Non-blocking v2 architecture, snippet previews, `HEAD_RECORD_LIMIT`.
- **jhawthorn/fzy**: `fzyScore` TypeScript translation (consecutive matching & bonus matrix).
- **Atuin & McFly**: Hit tiers × exponential time-decay scoring.
- **fzf**: Tie-break determinism algorithm.

</details>

---

<div align="center">
<sub>Part of the <a href="https://github.com/huangjua">DSH Agent Power Suite</a>. Licensed under BSD-3-Clause.</sub>
</div>
