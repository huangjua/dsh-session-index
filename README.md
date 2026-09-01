# @dsh-external/dsh-session-index

> **一句话**：把 DSH 自己的会话历史（`session.jsonl.zstd`）变成可搜索、可摘要、可书签的资产——提供官方没有的 **CJK 子串检索**，索引构建全程不阻塞主线程。

DSH 的会话是压缩的 JSONL 事件日志，默认无法检索复用。本插件（对照 openai/codex 的非阻塞重构 v2）把这些历史变成模型的第二大脑：按 workspace/关键词列历史、全文搜索、确定性摘要、书签跳回。

## 核心亮点

- **CJK trigram 子串 + 拉丁子串检索**：官方 `session-query-sqlite` 只有整词匹配，本插件是唯一提供中文子串检索的实现。
- **非阻塞构建**：worker 池 + 单飞 + 可取消，构建期间主线程事件循环 p95 ~23ms。
- **会话级相关性排序**：fzy + atuin + mcfly + fzf 多源融合，三路径（meta/FTS/worker）口径一致。
- **书签跳回**：`session_index_bookmark` 落锚点 + 跳回，append-only sidecar，绝不碰会话文件。
- **崩溃安全**：index.json 每一刻都是完整合法快照，原子提交 + 硬链备份。

## 优点与权衡

| 👍 优点 | ⚠️ 权衡 / 边界 |
|---|---|
| 唯一提供中文子串检索的实现 | 强耦合 DSH 内部存储格式，DSH 升级即可能 break |
| 非阻塞 + 崩溃安全 | 依赖 `node:sqlite`（实验性 API） |
| 214 项测试覆盖 | 与官方 session-query-sqlite 功能重叠（两套索引） |

## 借鉴的优秀项目

| 项目 | 借鉴了什么 |
|---|---|
| openai/codex（commit 9ded177） | 非阻塞重构 v2 架构、48/96 字符 snippet、HEAD_RECORD_LIMIT |
| jhawthorn/fzy（commit 34b8886） | `fzyScore` 逐条 TS 翻译（CONSECUTIVE + bonus） |
| atuin `sort.rs` / mcfly `history.rs` | 命中档位 × 时间衰减、特征映射（workspace 亲缘、log1p 频率） |
| fzf `algo.go` | tiebreak 语义（score → length → begin → end → index） |

---

DSH 会话索引插件（toolkit）。对照 openai/codex（commit `9ded177`）的非阻塞重构 v2：
把 DSH 自己的 `~/.dsh/sessions/**/session.jsonl.zstd` 变成可搜索、可摘要的历史资产，
索引构建全程不阻塞主线程。

## 能力

| 工具 | 作用 |
|---|---|
| `session_index_status` | 查看/刷新会话索引状态（active/progress/lastReport，`cancel` 可取消后台构建） |
| `session_index_list` | 按 workspace / 关键词列出历史会话；`sort=time`（默认）支持 `cursor` 稳定分页（`nextCursor`）；`sort=relevance` 按相关性单页 top-k（不支持翻页，无 query 时退化为 frecency 排序） |
| `session_index_search` | 搜索历史会话；`mode=meta` 只搜元数据，`mode=full` 走 FTS（trigram）/ worker 池流式解压搜正文（Codex 式 48/96 字符上下文 snippet）。**会话级相关性排序**：meta / FTS / worker 三路径统一走 `src/rank.ts` 的 `sortSessions`（fzy 打分 + 命中档位 + 亲缘 + 时间衰减 + 频率 + bm25 证据），每会话(族)一条代表行。**`filter` 消息级筛选**（STAGE-1 Part B）：`role`=user/assistant/tool/any（FTS SQL / worker 按行过滤；meta 模式 tool=toolCallCounts>0 会话级近似、user/assistant 不过滤）+ `sinceMs/untilMs`（消息行无时间列 → 会话级 lastTime 闭区间，与 aichat-search 日期过滤同层） |
| `session_summary` | 生成单个会话的确定性摘要（标题、工作目录、时间跨度、事件统计、工具调用、首尾消息） |
| `session_index_bookmark` | 给重要会话点落书签（锚点 = `sessionId`+`messageId`）并找回。`add` 同锚点重复写 = 替换更新（幂等，aider 思想）；`list` 支持 label/note/title 过滤、会话不在索引标 `stale`（不自动删）；`remove` 按 `id` 或 `sessionId` 删除。跳回链：`session_summary`（无 messageId）或 `session_index_search` 的 SCROLL（`session_id`+`message_id`） |

> 注：`session_index_list` / `session_index_search` 与 dsh-local-memory 的同名工具
> （`session_list` / `session_search`）并存，本插件使用带索引前缀的名字。

## 架构（v2，对照 Codex）

```
session_index_status / session_index_list / session_index_search / session_summary
        │
        ▼
SessionIndexBuilder（按 root+indexFile 单例）
 ├─ 进程内 single-flight：active Promise 复用
 ├─ durable run-marker：~/.dsh/session-index/.tmp/build.lock（open 'wx'，>15min 陈旧抢占）
 ├─ 启动清理：stale build.lock + index.json.tmp.*（>24h）
 ├─ 主线程扫描 + 指纹 (size, mtimeMs, ctimeMs)
 ├─ Phase A（head pass）：变更文件只流式解压前 10 条（Codex HEAD_RECORD_LIMIT）
 │     → 先原子提交 quick index（detailMissing 标记）→ 崩溃/取消时旧索引或 quick index 可用
 ├─ Phase B（full pass）：变更文件全量解析 counts/toolCalls/lastAssistantText
 │     → WorkerPool：Math.min(4, availableParallelism-1)，单 worker 单文件，错误隔离
 ├─ merge：prune 消失文件；解析失败保留旧条目 + error；解析期间指纹变化标记 raced
 └─ 原子提交：唯一 tmp → fsync → 读回校验 → rename（可选 hardlink 备份 index.json.bak）
```

- **流式解析**（`streaming-parser.ts`）：fzstd.Decompress 流式逐行（DSH 文件是多帧拼接
  zstd，Node 22 `node:zlib` 只解第一帧）；`native-zstd.ts` 用 `node:zlib` 按帧切分解压
  加速（~3-4x），任帧失败自动回退 fzstd；末帧 fzstd 完整性校验防截断静默成功。
- **取消**：`orCancel` + worker 逐 chunk cooperative cancel；取消不提交最终快照。
- **性能实测**（149 文件 / ~100MB 压缩）：全量 force 构建 ~32s，增量 ~3s，
  构建期间主线程事件循环 p95 ~23ms（<50ms 验收线）。
- 崩溃安全不变式：index.json 每一刻都是完整合法的 version=1 快照。

## 会话级相关性排序（STAGE-1 Part A，`src/rank.ts`）

`session_index_list`（`sort=relevance`）与 `session_index_search`（meta/FTS/worker
三路径统一）的输出顺序由 `rank.ts` 的纯函数决定（零 LLM、零依赖、无 IO；只对已过滤
后的 ≤maxHits(≤500) 条目排序，红线约束见 `STAGE1_PROMPT.md`）：

- **打分器**：`fzyScore` —— jhawthorn/fzy `match.c`+`bonus.h`+`match.h` 的逐条 TS
  字面翻译（含 `CONSECUTIVE` 与 `bonus` 取 max、`n==m`→SCORE_MAX 短路、二维 bonus
  表、回溯求 begin/end）；Unicode 适配：码点数组遍历（CJK 整字匹配、非 ASCII 落全零
  bonus 行）。pinned 源见 `reference/borrow/fzy/`（commit `34b8886`）。
- **权重结构**：atuin `sort.rs`@`0eecc0b`（v18.7.1）命中档位 × 时间因子的会话域扩展
  ——exact/prefix/substring/fuzzy 四档加性权重 + 24h 桶指数衰减（半衰期 21 天）；
  mcfly `history.rs`@`8198910` 的特征映射（workspace 亲缘、log1p 频率；exit status
  等 shell 专属特征明确弃用）。
- **等分决序**：fzf `algo.go` 的 tiebreak 语义（score → length → begin → end → index）。
- **bm25 会话级聚合**：FTS 路径同一会话多条命中行按「最佳 rank」聚合（`aggregateBm25Rows`），
  与 LIKE/worker/meta 路径的 fzy 密度分量共用同一套总分公式，保证三路径口径一致；
  每会话(族)输出一条代表行（正文优先，FTS 代表行保留 messageId 供 SCROLL 锚点）。

## 消息级筛选（STAGE-1 Part B，`session_index_search` 的 `filter` 参数）

`session_index_search` 新增可选 `filter` 对象（`role` + `sinceMs/untilMs`），三路径统一
"filter → rank → 截断"（rank 不改；不带 filter 输出与改动前完全一致，回归锁定）：

- **`role`（消息级）**：`user`=user/message、`assistant`=assistant/message（dsh-session-search-toggle
  的 user/reply/tool 语义，`reply`=assistant，pinned 源见 `reference/borrow/dsh-session-search-toggle/` @ `5b2b2d9`）、
  `tool`=tool_name 非空。FTS 路径 SQL 加条件（`m.role = ?` / `m.tool_name != ''`）；worker 回退
  JS 按行过滤（`parseSearch` 命中行新增 `role/toolName` 加性字段，并首次为 `tool/call` 行产出
  命中——工具名子串命中、snippet 与 FTS 工具行一致留空）；meta 路径无消息粒度 →
  `role='tool'` 按 `toolCallCounts>0` 会话级近似（schema 注明），`user/assistant` 不过滤；
  full 模式下 `role∈{user,assistant}` 时跳过 meta 补充贡献（元数据-only 命中不冒充消息命中）。
- **`sinceMs/untilMs`（会话级时间闭区间）**：messages 表无时间列 → 降级为 `meta.lastTime`
  （FTS SQL `s.last_time` / worker 派发前 / meta 循环），含等于边界；与 aichat-search 0.3.0 的
  日期过滤（作用于会话级 modified 日期）同层（pinned 源见 `reference/borrow/aichat-search/` @ `2e5a33cd`）。
- render 在 filter 非默认时回显一行 `filter: role=… sinceMs=… untilMs=…`；零命中静态提示保留。
- 不新增依赖、不新增 Config 字段；SCROLL / `session_index_list` 不受影响。

## 边界测试补齐（STAGE-1 Part C，codex/ccfullsearch 翻译 + R2 旧格式首帧）

- **codex@9ded177 无 search/list 测试文件**（已核 `search.rs`/`list.rs` 均无 `#[cfg(test)]`）→
  按 0.3 项 3 以 `search.rs` 边界语义列测试清单（`reference/borrow/codex-tests/TEST_MATRIX.md`），
  逐条翻译进 `test/streaming-parser.test.ts`：json 转义查询（引号/反斜杠/中文按字面命中正文）、
  metadata-only 命中不返回（只认 user/assistant 消息文本）、空文本消息跳过、snippet 首尾截断
  （`... ` 前缀 / ` ...` 后缀 + `>>> <<<` 命中标记）、JSON.parse 坏行跳过且后续行仍命中。
- **ccfullsearch 0.16.0 `ripgrep.rs`**（`reference/borrow/ccfullsearch/`，pin `9419d1cd`）边界：
  native→fzstd 解码回退（既有回归）+ 本批补 `maxDecompressedBytes` 超限抛错、`maxLineBytes`
  超长行丢弃（oversized 不影响其余行）；工具层单文件损坏错误隔离（`test/index.test.ts`：
  构建 completed + failed≥1 + 其余会话正文命中不受影响；bad 正文路径被隔离——builder
  "解析失败保留旧条目 + error" 语义）。
- **R2 旧格式首帧**：`test/fixtures/{old-frame,header-frame}-session.jsonl.zstd`（同一行序列、
  仅帧切分不同；生成脚本 `test/fixtures/gen-old-frame.mjs`，node:zlib 逐段压帧拼接），断言
  `parseHead/parseFull/parseSearch` 两变体全字段等价——用测试固化"帧切分对行解析透明（免疫）"。

## 书签（STAGE-2 Part A，`session_index_bookmark`）

给"查"补上"记"与"跳回"：模型把重要会话点落书签，之后 `list` 过滤找回并拿到
`sessionId`+`messageId` 锚点，再用既有 `session_summary`（无 messageId）或
`session_index_search` 的 SCROLL（`session_id`+`message_id`）完成跳回。
零新依赖、零 LLM、不碰 `index.json` 提交语义。

- **存储（`src/bookmark.ts`，sidecar）**：`%DSH_HOME%\session-index\bookmarks.jsonl`
  （与 `fts.db` 同级）。append-only JSONL，每行一条 `{ v:1, id, sessionId, sessionFile,
  messageId|null, label, note|null, title, workspace, createdAt, updatedAt }`；
  `id` = sha1(锚点)（确定性、跨进程稳定，`remove by id`/幂等 upsert 可复现）。
  语义对照 `reference/codex/.../session_index.rs`（commit `9ded177`）：写入 per-path
  互斥 + `open('a')` 追加 + fsync（flush）、读取逐行容错（坏行跳过并计数）、
  同锚点最新行胜出（有效视图不重复 = aider `.aider.input.history` 去重/替换更新思想 C4，
  替换更新保留原 `createdAt`、刷新 `updatedAt/label/note`）；`remove` = 读全量 →
  过滤 → tmp+rename 原子重写（`remove_thread_name_entries` 语义）。
- **`add`**：`sessionId` 必填（id 或文件路径子串，经 `findSession` 解析，失败返回明确
  错误）；`label` 缺省 = `meta.title` 或首条用户消息前 80 字符（确定性，无 LLM）；
  同 `(sessionId, messageId)` 锚点重复 add = 替换更新。
- **`list`**：`query` 对 label/note/title 大小写不敏感子串过滤（`metaMatch` 归一化语义）；
  `limit` 默认 20 ≤ 100；按 `updatedAt` 倒序 → `id` 升序 → 文件序收口（确定性 tiebreak，
  与 `rank.ts` 的 index 收口同构）；会话不在当前索引（`findSession(loadIndex)`）标注
  `stale: true`（**不自动删除**——书签是派生数据，stale 仅提示）；索引未就绪时
  `indexReady: false` 并跳过 stale 判定。
- **`remove`**：`id`（精确一条）或 `sessionId`（该会话全部，大小写不敏感），二选一；
  **绝不删除会话文件**（有测试锁定）。
- **红线**：只读写本插件 sidecar；不进 `fts.db`、不进 `index.json`；builder / quick
  commit 不感知书签；可随时删除重建。
- 概念来源 `cuhaitiang0405-collab/dsh-indexbookmark`（「锚点+跳回」）；2026-08-27
  网络受限镜像不可达，按共同前提 0.3 降级记录见 `reference/borrow/dsh-indexbookmark/`。

## compaction 结论（STAGE-2 Part B，A4 评估 → 分支 1：不写钩子代码）

**结论：DSH 会话文件是 append-only 事件日志；compaction 只是追加事件，从不截断/重写
会话文件——continuity-v2 的 Pre/PostCompaction 钩子在 DSH 不适用（无"压缩前丢历史"
风险面），本插件不加钩子代码，既有 watcher + P1 delta 已覆盖。** 证据表见
`PLAN_v4.md`「STAGE-2 实施记录（Part B）」，要点：

- DSH 核心 `@deepseek-ai/dsh-compaction`（checkout 只读）：compaction 产出
  `compaction/start|summary|end|prune` **log-only** 会话事件，表面替换由紧随其后的
  checkpoint `user/message`（`source.kind=plugin, plugin=compact`）承担，且
  "replacement MUST be appended synchronously right after this event"——
  全部是**追加**，无文件级截断。
- `@deepseek-ai/dsh-session`：明确定义为 "Event-sourced session service: append-only
  session log ... the append-only log remains the source of truth"；
  `@deepseek-ai/dsh-session-persistence-jsonl`：每会话一个 append-only 文件，
  追加 = `open(path, "a")` + write + fsync；`truncate` 仅用于崩溃修复（撕尾帧）与
  部分写入回滚，**与 compaction 无关**。
- 本插件解析器对事件类型**无过滤**（`streaming-parser.ts:361` / `core.ts:162` 的
  `counts[type]++`）→ `compaction/*` 自动计入 `counts`，`session_summary` 原样输出。
- **线上实证（2026-08-27）**：335 个真实会话中 3 个含 compaction 事件（
  `compaction/start×3, summary×2, end×3, prune×14`），`session_summary` 对
  session-7ad17dae 输出 `compaction/prune=14`；6 个最近会话普查（30,291 事件）无
  compaction、解析 0 失败。
- **测试锁定（3 断言）**：`streaming-parser.test.ts`（parseFull 统计 compaction/*
  到 counts/events，含 checkpoint user/message）；`session-index-builder.test.ts`
  （追加 compaction 事件帧 → **delta 增量**收录、历史计数保留、lastTime/indexedBytes
  推进）；`index.test.ts`（工具层 `session_summary.counts` 输出 compaction/* 计数）。
- 对照参考 `Haustorium12/continuity-v2`（Pre/PostCompact 钩子，为"Claude Code 压缩会
  截断会话文件"而设）：2026-08-27 网络受限镜像不可达，降级记录见
  `reference/borrow/continuity-v2/`。

## LLM 会话摘要（STAGE-4，可选，红线 3 修订的唯一例外）

**红线 3 修订（用户 2026-08-27 批准，记录于 `work/PLAN_v4.md`）**：「零 LLM 文本
生成；唯一例外 = `llmSummary` 可选路径——`llmSummaryEnabled` 开关内、按需单会话、
缓存 sidecar、成本护栏（maxTokens=64 / 10s 超时 / 失败不重试 / 只在
`session_summary` 工具路径触发，构建/扫描路径禁止调用）。」

- **开关**：`Config.llmSummaryEnabled`（`z.boolean().default(true)`）。`false` →
  **完全零执行**：不读/写缓存、不触碰 `ctx.llm`（有测试锁定）。
- **Provider 抽象**（`src/llm-summary.ts`，DI 形状照 hermes PR#51125
  `EmbeddingProvider` ABC + resolve 工厂）：接口 `summarize(prompt, signal) → string`，
  测试注入 fake，生产实现走宿主 **`ctx.llm.stream`**（E1 复核：宿主只有流式对话
  API）＋ `BlockAssembler` 聚合；provider = 首个已注册路由、model = 该 provider
  首个 advertised 模型（**绝不写死 provider/model**，决议失败 → 确定性回退）。
- **成本护栏**：`maxTokens=64`；10s 超时（`AbortSignal.timeout`）；`temperature=0`；
  失败不重试、不缓存；只在 `session_summary` 单会话路径触发一次（status 健康快照
  只读缓存计数，其余四工具路径零调用，有测试锁定）。
- **输入构造（确定性、禁全文）**：title（前 120 码点）+ firstUserText（前 200）+
  lastAssistantText（前 500）+ counts 前 8 类 + toolCallCounts top5 + 时间跨度；
  prompt 按 pinned 源模板定稿（来源与 SHA 见 `work/PLAN_v4.md` STAGE-4 实施记录）；
  总字符硬上限 2000 / token 粗估 ≤1200（`estimateTokens`，测试锁定）。
- **输出**：一句话 ≤80 字（Unicode 码点截断双保险）。成功 → 附加
  `session_summary.llmSummary` 字段；禁用/失败 → 字段缺席、确定性摘要原样返回
  （fail-open，绝不半死）。
- **缓存 sidecar**：`%DSH_HOME%\session-index\llm-summary.jsonl`（append-only JSONL，
  存储/并发照抄 `src/bookmark.ts`＝codex session_index.rs 语义：逐行容错读、坏行跳过
  计数、同 sessionId 最新行胜出、mtime/size 指纹缓存、per-path 互斥追加 + fsync）。
  失效判据 = 会话文件 `(size, mtimeMs)` 变化；命中零调用；同 session 在飞 Promise
  复用（并发单飞）；只缓存成功结果。
- **可观测**：`session_index_status.llmSummaryHealth = { enabled, ok, cached,
  lastError, provider }`（`cached`=sidecar 有效条目数；`ok`=最近调用成功且 provider
  可用；`lastError` 为 `null` 或字符串，schema 用 oneOf 兼容 null）。

## 数据源与索引存储

- 默认读取 `%DSH_HOME%\sessions`（通常是 `C:\Users\admin\.dsh\sessions`）
- 文件格式：`session.jsonl.zstd`（Zstandard 压缩 JSONL，拼接多帧）
- 索引文件：`%DSH_HOME%\session-index\index.json`（只存元数据/摘要字段，不存正文）
- 回滚后手：每次提交前硬链 `index.json.bak`（旧快照）

## 构建 / 测试 / 装配

```bash
pnpm run check:dsh-contract  # 校验 alpha.3 依赖与实际解析的运行时图
pnpm run build               # bash scripts/build.sh（需 DSH_CHECKOUT，自动探测）
pnpm run typecheck           # tsc --noEmit
pnpm test                    # tsc -p tsconfig.test.json && node --test ".test-build/test/*.test.js"（214 个用例）
```

- 自动补扫：工具调用时若发现 `detailMissing` 条目或磁盘会话数与索引不一致，
  自动后台触发一次增量构建（force:false），索引自愈保鲜。
- 测试夹具：`test/fixtures/`（真实 alpha.3 会话样本、运行时生成的连续序号多帧样本、
  帧头跨块样本、截断损坏样本）。单元/集成覆盖：reverse scanner、原子提交、run-marker（含所有权
  校验）、worker 池（worker/inline 双路径、在飞 terminate、inline 有界并发、取消、
  错误隔离）、两阶段构建（首建/增量/force/prune/损坏/raced/单飞/取消/quick 检查点/
  detailMissing 补齐）、cursor 稳定分页（同 lastTime tie-break 回归）、native↔fzstd 等价回归。

## FTS 共存边界（与官方 dsh-session-query-sqlite）

已核实的当前事实（2026-08，web profile `~/.dsh/profiles/web/cordis.patch.yml`）：

- 官方 `@deepseek-ai/dsh-session-query-sqlite` 已启用：`path=C:/Users/admin/.dsh/storages/session-query.sqlite`、
  `openAt: first-search`（懒加载，侧栏未搜过则不建库、当前 0 行、不占盘）。定位：**可信后端**
  （`ctx.sessionQuery`）、**无模型面工具**（不向模型暴露任何工具）、FTS5 unicode61 **整词匹配**
  （无中文 trigram、无任何子串检索）、供**侧栏 UI** 使用。
- 本插件定位：**模型侧历史导航工具**，是唯一提供 **CJK trigram 子串 + 拉丁子串** 检索的实现。
- dsh-local-memory：profile 中已 disabled（cordis.patch.yml `disabled: true`），插件待重写，不与对齐。

### 共存契约（fail-open）

- 本插件**不消费** `ctx.sessionQuery`；官方服务任何状态（未配置 / 懒加载未建库 / 故障）**不影响
  本插件任何工具**——本插件自带完整回退（worker 流式搜索 / SCROLL 明确错误），绝不产生半死状态。
- 两库各自独立维护、互不写入：官方 `session-query.sqlite` 由官方服务自管理（本插件绝不触碰）；
  本插件只维护自己的 `~/.dsh/session-index/fts.db`（派生索引，可随时删库 force 重建）。

### ftsEnabled 开关（P2）

- `Config.ftsEnabled`（`z.boolean().default(true)`）：`false` 时完全跳过 `createSessionFts`
  （不 import `node:sqlite`、不打开/不创建 `fts.db`），`mode=full` 自动走 worker 流式回退，
  `session_index_search` 的 SCROLL 返回既有"FTS 不可用"错误对象。
- `session_index_status` 输出 FTS 健康快照：平铺 `fts`（boolean）与 `ftsSessions`（number）保留
  v1 兼容；嵌套 `ftsHealth = { enabled, ok, sessions, messages, dbSizeBytes, lastOptimizeAt,
  schemaVersion }`（`dbSizeBytes` 为 stat 结果、失败给 0 不抛错；`lastOptimizeAt` 读库内
  优化水印、缺省 0；`schemaVersion` 缺省 ''）。
- **何时考虑关 ftsEnabled**：部署方已有基于官方后端的检索工具、且不需要子串/CJK 检索时。

### 索引保留策略（P3，Hermes maybe_auto_prune_and_vacuum 适配）

- `Config.retentionDays`（`z.number().min(0).default(90)`，`0`=关闭）。判定：
  `max(lastTime, 文件 mtimeMs) < now - retentionDays×86400e3` 的条目从
  `index.json` 与 `fts.db`（sessions+messages 行）移除。
- **红线**：只作用于派生索引，**绝不删除/重命名/截断 `~/.dsh/sessions` 下的会话文件**
  （有测试锁定：prune 后文件仍在且字节不变）。
- **过滤进所有构建的底座**（`ftsBuildOptions` 统一携带 retentionDays）：watcher 事件 /
  对账 / 回填 / 工具 refresh 无论哪个先跑都按策略过滤——实测若不统一，先起的无过滤
  构建会单飞吸收保留构建（选项丢失）或把超龄条目重拾回索引（两轮线上竞态后定案）。
- watermark（`fts.db` state_meta `last_prune`/`last_prune_count`，跨进程共享）：
  启动专用通道 `maybeRetentionPrune` 距上次 <24h 跳过（每日一次）；VACUUM（内部先
  optimize）仅在本次 `pruned>0` 时执行，且只出现在启动路径（<50ms 事件循环红线）；
  仅 `completed` 状态写 watermark（skipped/failed 不记账，下次启动重试——实测 reload
  期间旧 fiber 的 run-marker 未及释放会撞出 skipped）。任何失败只 log 不抛出。
- 对账（启动 reconcile / 10s 回退扫描）用两侧保留调整后的可比计数（磁盘侧扣 mtime
  超龄文件、索引侧扣 max(lastTime, mtimeMs) 超龄条目），避免与保留清理互相抵消。
- `session_index_status` 输出 `retentionDays` 与 `ftsHealth.lastPruneAt/lastPruneCount`
  （render 一行：`retention: days=90 lastPrune=… count=N`）。
- BuildReport 新增可选字段 `pruned`（不破坏既有断言）。

## 已知限制

- 首次升级迁移（旧索引无 ctimeMs）会全量重扫一次（~32s），之后增量很快。
- `session_search mode=full` 会解压匹配 workspace 的会话，速度取决于会话数量。
- 摘要主体为确定性生成；可选 LLM 一句话（`llmSummaryEnabled`，见「LLM 会话摘要」节）
  默认开启、宿主可用时附加——失败自动省略（fail-open），不阻塞确定性摘要。
