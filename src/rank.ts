/**
 * rank.ts — 会话级相关性排序（STAGE-1 Part A；borrowing-plan S1=A1+A2）
 *
 * ── 借鉴来源（共同前提 0.3：pinned 副本与 SHA 见 reference/borrow/DOWNLOAD_MANIFEST.csv）──
 *
 * 1. 打分器【唯一"直接搬"，对 reference/borrow/fzy/src/match.c + bonus.h + match.h
 *    @34b8886 的逐条翻译】 — jhawthorn/fzy（MIT）
 *
 *    移植对应关系（match.c 行号为 pinned commit 时点）：
 *      - 常量：match.h —— SCORE_MAX=+∞ / SCORE_MIN=−∞ / MATCH_MAX_LEN=1024，
 *        以及 match.c 顶部经 config 引入的 GAP/BONUS 六常量（值原样保留）；
 *      - precompute_bonus（match.c:43-51）：首字符虚拟前驱 last_ch='/'，
 *        逐位预计算边界奖励表；
 *      - COMPUTE_BONUS 宏（bonus.h:110）：**二维表语义**——先按"当前字符"类别
 *        选行（大写→states[2]、小写/数字→states[1]、其余→全零行），再按前一字符
 *        字面取列；即非字母数字的"当前字符"恒无奖励。TS 端口见 computeBonus()；
 *      - match_row 递推（match.c:70-108）：
 *          D[i][j] = max(M[i-1][j-1] + bonus[j], D[i-1][j-1] + CONSECUTIVE)
 *          （注释原文"consecutive doesn't stack with match_bonus"——两者取 max，
 *          **不求和**）；首行为 j*GAP_LEADING + bonus[j]；
 *          gap_score 按 (i==n-1) ? TRAILING : INNER 选档后随列累进进 M，
 *          最终结果直接读 M[n-1][m-1]（尾随/内部空隙惩罚已内嵌于累进）；
 *      - 短路分支（match.c:120-133）：haystack 超 MATCH_MAX_LEN 或 needle 更长 →
 *        SCORE_MIN；n==m（忽略大小写必相等）→ SCORE_MAX（回填 positions 0..n-1）；
 *      - 回溯（match.c:189-215）：从右下角向左上，优先落 D==M 的最优终点，
 *        CONSECUTIVE 分支强制前驱为配对（match_required），多解取首个相遇者。
 *    TS Unicode 适配（任务指定，唯一有意差异）：遍历改用 [...text] 码点数组
 *    （CJK 整字匹配、位置/距离按码点下标）；字符类别沿用 ASCII 三类 + 全零兜底——
 *    非 ASCII 一律落 states[0]，bonus 恒 0，与 locale=C 行为一致。比较前双方
 *    tolower（match.c setup_match_struct 同款），bonus 表查原始码点。
 *
 * 2. 权重结构 — atuinsh/atuin crates/atuin-history/src/sort.rs
 *    @0eecc0b（tag v18.7.1，MIT）。**实源形状**：prefix→×2.0、substring→×1.75、
 *    其他→×1.0 三档命中加成，乘性时间因子 1+1/diff_seconds（新近偏好刻意轻），
 *    无独立频率项。本移植按任务规范做会话域扩展：扩为 exact/prefix/substring/
 *    fuzzy 四档加性权重（档位结构同源：命中精确度分级）、衰减改为 24h 自然桶 +
 *    指数半衰期、补 log1p 频率项（频率思想来自调研对 atuin 历史系统的整体描述与
 *    mcfly 特征集，见 §3）。所有数值偏差均为声明过的会话域校准，非上游照搬。
 *    helix-editor/nucleo 仅作设计参考，未拷贝代码。
 *
 * 3. 特征集 — cantino/mcfly src/history/history.rs @8198910（MIT，调研 pin）
 *    只借特征设计，不借其训练/模型部分。会话域映射：
 *      ageFactor         → lastTime 时间桶衰减（24h 桶 + 指数半衰期）
 *      directoryOverlap  → 查询 workspace 子串命中 meta.workspace（亲缘加成）
 *      frequency/recency → log1p(命中行数或事件数)，长尾截断防霸榜
 *      occurrence / exitStatus / 会话循环时序 等 shell 专属特征 → **会话域不适用，
 *      明确弃用**（DSH 会话无进程退出码概念，也无"本次输入循环"）。
 *
 * 4. 等分决序 — junegunn/fzf src/algo/algo.go tiebreak 语义（MIT，HEAD f7ae439）：
 *      score → length → begin → end → index。只抄次序语义，不抄 Go 实现。
 *
 * ── 红线约束 ───────────────────────────────────────────────────────────────
 * 零 LLM、零新依赖、纯函数无 IO；调用方保证只喂"已过滤后的 ≤maxHits(≤500)"条目。
 * 跨路径口径一致性策略：主干分量（fzy 分 + 命中档位）在所有路径共用同一函数与
 * 常量，且主干权重上限（FUZZY 60 + 档位 24 = 84）严格大于全部分量增量上限之和
 * （workspace 10 + 衰减 8 + 频率 15 + bm25 证据 12 = 45）。因此标题互异的语料上
 * 三路径相对顺序由同一主干决定，路径特有证据只在主干接近时微调。
 *
 * 配置面（执行细节 7）：全部常量集中于此、不进 Config（零 token 成本）；后续如需
 * 调权可按需增加 rankWeights 配置，本期不做。
 */

import type { SessionMeta } from './core.js'

/* ══ fzy 打分常量（match.c 顶部定义，原样保留；match.h 提供 ±INFINITY/1024）═ */
/** SCORE_GAP_LEADING —— 首个命中之前的每列空隙惩罚 */
const SCORE_GAP_LEADING = -0.005
/** SCORE_GAP_TRAILING —— 最后一行的空隙档（随列累进即"最后命中之后的罚分"） */
const SCORE_GAP_TRAILING = -0.005
/** SCORE_GAP_INNER —— 中间行的空隙档（比头尾硬一个量级） */
const SCORE_GAP_INNER = -0.01
/** SCORE_MATCH_CONSECUTIVE —— 连续命中的相邻奖励（与 bonus 取 max，不叠加） */
const SCORE_MATCH_CONSECUTIVE = 1.0
/** SCORE_MATCH_SLASH —— bonus 表中 '/' 列的值 */
const SCORE_MATCH_SLASH = 0.9
/** SCORE_MATCH_WORD —— '-'、'_'、' ' 列的值 */
const SCORE_MATCH_WORD = 0.8
/** SCORE_MATCH_CAPITAL —— 小写→大写边界的值（states[2] 的小写段） */
const SCORE_MATCH_CAPITAL = 0.7
/** SCORE_MATCH_DOT —— '.' 列的值 */
const SCORE_MATCH_DOT = 0.6

/**
 * COMPUTE_BONUS(last_ch, ch)（bonus.h:78-110 的 TS 字面移植）：
 * 先由"当前字符"选行：uppercase→2；lowercase/digit→1；其它（含 CJK）→0（全零行）；
 * 再由"前一字符"字面取列。等价 switch 形式见下（行为与查表逐一相等）。
 */
function bonusIndexOf(cp: number): 0 | 1 | 2 {
  if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) return 1 // a-z 0-9
  if (cp >= 65 && cp <= 90) return 2 // A-Z
  return 0
}

function stateLookup(state: 0 | 1 | 2, prevCp: number): number {
  if (state === 0) return 0
  switch (prevCp) {
    case 47: return SCORE_MATCH_SLASH // '/'
    case 45: case 95: case 32: return SCORE_MATCH_WORD // '-' '_' ' '
    case 46: return SCORE_MATCH_DOT // '.'
    default:
      // states[2] 额外包含小写字母段（camelCase：islower(prev)&&isupper(cur)）
      return state === 2 && prevCp >= 97 && prevCp <= 122 ? SCORE_MATCH_CAPITAL : 0
  }
}

const computeBonus = (prevCp: number, chCp: number): number => stateLookup(bonusIndexOf(chCp), prevCp)

export interface FzyMatch {
  /** fzy 最终分（越大越好；n==m 短路时为 Infinity，对应上游 SCORE_MAX） */
  score: number
  /** 最优对齐的首个命中下标（码点下标；tiebreak begin 用） */
  start: number
  /** 最优对齐的末个命中下标（含） */
  end: number
}

/** 有序子序列存在性检查（对应 fzy::has_match 的 strcasechr 推进语义，大小写已折叠） */
function subsequenceOk(q: string[], h: string[]): boolean {
  let i = 0
  for (let j = 0; j < h.length && i < q.length; j++) {
    if (h[j] === q[i]) i++
  }
  return i === q.length
}

/** MATCH_MAX_LEN（match.h:14）：超长候选直接判不合格（上游返回 SCORE_MIN） */
const MATCH_MAX_LEN = 1024

/**
 * fzyScore —— match_positions（match.c:148-224）的 TS 字面移植（带位置回溯）。
 * 差异仅限任务指定的 Unicode 适配（码点数组）与本域包装。递推与回溯逐行对照
 * match.c 注释翻译。
 */
export function fzyScore(query: string, text: string): FzyMatch | null {
  // setup_match_struct：比较用小写副本（tolower），bonus 用原始字符
  const ho = [...text]
  const q = [...query.toLowerCase()]
  const h = ho.map((c) => c.toLowerCase())
  const n = q.length
  const m = h.length
  if (n === 0 || m === 0 || n > m || m > MATCH_MAX_LEN) return null // SCORE_MIN 分支
  if (!subsequenceOk(q, h)) return null
  if (n === m) {
    // match.c:127-133：长度相等 → 必完全一致（忽略大小写）→ SCORE_MAX + positions 直填
    return { score: Number.POSITIVE_INFINITY, start: 0, end: n - 1 }
  }

  // precompute_bonus（match.c:43-51）：last_ch 从 '/' 起步；bonus 查原始码点
  const bonus = new Float64Array(m)
  let lastCh = 47 /* '/' */
  for (let j = 0; j < m; j++) {
    const cp = ho[j].codePointAt(0)!
    bonus[j] = computeBonus(lastCh, cp)
    lastCh = cp
  }

  const NEG_INF = Number.NEGATIVE_INFINITY
  /* D[][]: 该位置以"配对"结尾的最优分；M[][]: 该位置的最优分（含空隙延伸态）。
   * 保留整表以便 match.c:189-215 的回溯（规模 ≤500 条目 × 短文本，可控）。 */
  const D: Float64Array[] = []
  const M: Float64Array[] = []
  for (let i = 0; i < n; i++) {
    D.push(new Float64Array(m).fill(NEG_INF))
    M.push(new Float64Array(m).fill(NEG_INF))
  }

  for (let i = 0; i < n; i++) {
    // match_row（match.c:70-108）：gap 档位按行选择
    const Di = D[i]
    const Mi = M[i]
    const lastD = i > 0 ? D[i - 1] : null
    const lastM = i > 0 ? M[i - 1] : null
    const gapScore = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER
    let prevScore = NEG_INF
    let prevD = NEG_INF
    let prevM = NEG_INF
    for (let j = 0; j < m; j++) {
      if (q[i] === h[j]) {
        let s = NEG_INF
        if (i === 0) {
          s = j * SCORE_GAP_LEADING + bonus[j]
        } else if (j > 0) {
          // consecutive match 不与 match_bonus 叠加（match.c:94 注释）→ 取 max
          s = Math.max(prevM + bonus[j], prevD + SCORE_MATCH_CONSECUTIVE)
        }
        // 先读上一行同列（写入 curr 之前——match.c 单缓冲复用同理成立，双矩阵更直白）
        prevD = lastD ? lastD[j] : NEG_INF
        prevM = lastM ? lastM[j] : NEG_INF
        Di[j] = s
        prevScore = Math.max(s, prevScore + gapScore)
        Mi[j] = prevScore
      } else {
        prevD = lastD ? lastD[j] : NEG_INF
        prevM = lastM ? lastM[j] : NEG_INF
        Di[j] = NEG_INF
        prevScore = prevScore + gapScore
        Mi[j] = prevScore
      }
    }
  }
  const score = M[n - 1][m - 1]

  // 回溯求位置（match.c:189-215 逐行翻译：多解取第一个相遇者；
  // CONSECUTIVE 分支要求前驱必须是配对单元 → match_required 门控）
  const positions = new Int32Array(n).fill(-1)
  let matchRequired = false
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (D[i][j] !== NEG_INF && (matchRequired || D[i][j] === M[i][j])) {
        matchRequired =
          i > 0 && j > 0 && M[i][j] === D[i - 1][j - 1] + SCORE_MATCH_CONSECUTIVE
        positions[i] = j
        break
      }
    }
  }
  return { score, start: positions[0], end: positions[n - 1] }
}

/* ══ atuin 权重结构的会话域常量（出处与校准理由见文件头 §2/§3 与各行注记）══ */
export const RANK_WEIGHTS = {
  /** fzy 归一分权重 —— 主干主项，完全主导排序方向。 */
  FUZZY: 60,
  /**
   * 命中类型加成（任务规范四档；atuin sort.rs 同源思想的会话域扩展，见文件头 §2）：
   * exact > prefix > substring > fuzzy。校准理由：档距 6（≈ 弱半档 fzy 差）；
   * exact↔substring 共差 12，必须小于 FUZZY 主导带（σ 映射后有效摆幅 ±60）——
   * 档位只能裁决模糊分接近时的先后，不能跨档翻转强 fuzzy 差异。
   */
  TIER_EXACT: 24,
  TIER_PREFIX: 18,
  TIER_SUBSTRING: 12,
  TIER_FUZZY: 6,
  /** workspace 亲缘（查询 workspace 子串命中 meta.workspace）；一次亲缘 ≈ 一档命中类型。 */
  WORKSPACE: 10,
  /**
   * 时间衰减权重（mcfly ageFactor 结构 → 会话 lastTime；24h 自然日桶 + 半衰期指数）。
   * HALF_LIFE_DAYS=21：1 周≈0.79、1 月≈0.37、90 天≈0.05 —— 近两周显著加权、
   * 三月近乎归零，符合"近期会话更可能相关"的导航直觉。
   */
  RECENCY: 8,
  RECENCY_HALF_LIFE_DAYS: 21,
  /** lastTime 缺失(≤0)时的兜底 raw：温和压低而非归零 */
  RECENCY_UNKNOWN: 0.3,
  /**
   * 频率项权重。raw = min(log1p(n), FREQUENCY_LOG_CAP)：
   * n = 该路径内命中行数（搜索）/ 事件总数（列表）。饱和点 log1p(n)=2.5（n≈11.2）
   * ——频率长尾不霸榜（mcfly max_selected_occurrences 截断思想同源）。
   */
  FREQUENCY: 6,
  FREQUENCY_LOG_CAP: 2.5,
  /**
   * BM25 正文证据权重（仅 FTS 路径注入；最佳 bm25 经 sigmoid 映射为对称 ± 分量）。
   * 校准理由：正文相关性是真信号，但只在 FTS 一路可得——若它能翻转主干差异，
   * 三路径就会同查不同序。故上限 12，定位次级证据。
   */
  BM25: 12,
} as const

export type HitTier = 'exact' | 'prefix' | 'substring' | 'fuzzy' | 'none'

export interface RankOpts {
  /** 当前时刻（ms）。测试注入保证确定性；缺省 Date.now() */
  now?: number
  /** 查询侧 workspace 子串（list/search 的 workspace 参数），用于亲缘加成 */
  queryWorkspace?: string
  /** 该路径内此会话的命中行数（密度/频率项数据来源） */
  hitRows?: number
  /** FTS 路径专用：该会话最佳（最小）bm25 值；未提供则分量缺省 */
  bestBm25?: number
}

export interface RankComponents {
  /** fzy 原始分（未乘权重，诊断/断言用；n==m 时为 Infinity） */
  fuzzyRaw: number
  /** fzy 归一分（σ 映射中心化 ±1 × 权重） */
  fuzzyTerm: number
  /** 命中档位 */
  tier: HitTier
  /** 档位加成（已乘权重） */
  tierTerm: number
  /** 亲缘加成（已乘权重） */
  workspaceTerm: number
  /** 时间衰减（已乘权重） */
  recencyTerm: number
  /** 频率项（已乘权重） */
  frequencyTerm: number
  /** bm25 正文证据（仅提供 bestBm25 时出现，已乘权重） */
  bm25Term?: number
  /** 参与打分的文本域与命中区间（tiebreak begin/end；无命中 -1/-1） */
  matchedField: 'title' | 'firstUserText' | ''
  matchStart: number
  matchEnd: number
}

export interface RankResult {
  score: number
  components: RankComponents
}

/** σ(x)∈(0,1)：把无量纲 fzy 原始分平滑归一到可比区间（输入限幅防溢出，∞ 安全钳到饱和段） */
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))))

const EVENT_TOTAL_CAP = 1000

function totalEvents(meta: SessionMeta): number {
  let n = 0
  for (const v of Object.values(meta.counts ?? {})) n += Number(v) || 0
  return Math.min(n, EVENT_TOTAL_CAP)
}

/**
 * 命中档位（四档；atuin sort.rs 同源思想的会话域扩展，见文件头 §2）。在选定文本域
 * （title 优先、firstUserText 后备，与 metaMatch 可见语义一致）上判定：
 * 完全相等 > 前缀 > 子串 > fuzzy。
 */
export function tierOf(queryLower: string, textLower: string, fz: FzyMatch | null): HitTier {
  if (!queryLower) return 'none'
  if (!textLower) return fz ? 'fuzzy' : 'none'
  if (textLower === queryLower) return 'exact'
  if (textLower.startsWith(queryLower)) return 'prefix'
  if (textLower.includes(queryLower)) return 'substring'
  return fz ? 'fuzzy' : 'none'
}

/**
 * scoreSession —— 纯函数打分；components 全字段可解释（测试断言/交付验证用）。
 */
export function scoreSession(meta: SessionMeta, query: string, opts: RankOpts = {}): RankResult {
  const now = opts.now ?? Date.now()
  const q = (query ?? '').toLowerCase()
  const title = (meta.title ?? '').toLowerCase()
  const firstUser = (meta.firstUserText ?? '').toLowerCase()

  // 主干：fzy 分 + 命中档位（title 优先，firstUserText 后备）
  let fz: FzyMatch | null = q ? fzyScore(q, title) : null
  let field: 'title' | 'firstUserText' | '' = fz ? 'title' : ''
  if (!fz && q) {
    fz = fzyScore(q, firstUser)
    if (fz) field = 'firstUserText'
  }
  const tierText = field === 'title' ? title : field === 'firstUserText' ? firstUser : ''
  const tier = tierOf(q, tierText, fz)
  const fuzzyRaw = fz?.score ?? 0
  const fuzzyTerm = fz ? RANK_WEIGHTS.FUZZY * (2 * sigmoid(fz.score) - 1) : 0
  const tierWeight =
    tier === 'exact'
      ? RANK_WEIGHTS.TIER_EXACT
      : tier === 'prefix'
        ? RANK_WEIGHTS.TIER_PREFIX
        : tier === 'substring'
          ? RANK_WEIGHTS.TIER_SUBSTRING
          : tier === 'fuzzy'
            ? RANK_WEIGHTS.TIER_FUZZY
            : 0

  // workspace 亲缘（mcfly directoryOverlap → 会话域）
  const ws = (opts.queryWorkspace ?? '').toLowerCase().trim()
  const workspaceTerm = ws && ws.length > 0 && (meta.workspace ?? '').toLowerCase().includes(ws) ? RANK_WEIGHTS.WORKSPACE : 0

  // 时间衰减（24h 自然日桶 + 半衰期指数；未来时间按 0 年龄保护）
  const ageMs = Math.max(0, now - (meta.lastTime ?? 0))
  const ageDays = Math.floor(ageMs / 86400e3)
  const recencyRaw = !(meta.lastTime > 0) ? RANK_WEIGHTS.RECENCY_UNKNOWN : Math.pow(2, -ageDays / RANK_WEIGHTS.RECENCY_HALF_LIFE_DAYS)
  const recencyTerm = RANK_WEIGHTS.RECENCY * recencyRaw

  // 频率（log1p + 饱和截断）
  const nFreq = opts.hitRows ?? totalEvents(meta)
  const frequencyTerm = RANK_WEIGHTS.FREQUENCY * Math.min(Math.log1p(Math.max(0, nFreq)), RANK_WEIGHTS.FREQUENCY_LOG_CAP)

  // bm25 正文证据（仅 FTS 路径）：sqlite bm25() 返回 ≤0，越小越相关
  let bm25Term: number | undefined
  if (typeof opts.bestBm25 === 'number' && Number.isFinite(opts.bestBm25)) {
    bm25Term = RANK_WEIGHTS.BM25 * (1 - 2 * sigmoid(opts.bestBm25)) // bm25=-∞ → +BM25；bm25=0 → −BM25
  }

  const score = fuzzyTerm + tierWeight + workspaceTerm + recencyTerm + frequencyTerm + (bm25Term ?? 0)
  return {
    score,
    components: {
      fuzzyRaw,
      fuzzyTerm,
      tier,
      tierTerm: tierWeight,
      workspaceTerm,
      recencyTerm,
      frequencyTerm,
      bm25Term,
      matchedField: field,
      matchStart: fz?.start ?? -1,
      matchEnd: fz?.end ?? -1,
    },
  }
}

/* ══ 排序入口（fzf tiebreak：score → length → begin → end → index）═══════ */

export interface RankEntry {
  meta: SessionMeta
  /** 路径注入的密度/正文证据（透传 scoreSession） */
  hitRows?: number
  bestBm25?: number
  /** sortSessions 回填（只读输出；不影响排序语义） */
  _rank?: RankResult
}

const cmpNum = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * sortSessions —— 在过滤之后调用（红线：严禁扩全集）。等分时按 fzf tiebreak
 * 语义决序：总分降序 → 目标文本长度升序（matchedField 文本；无命中的条目互比
 * 退化为各自 title 长度）→ begin 升序 → end 升序（命中窗更紧凑者优先）→
 * 原始下标升序收口。排序稳定确定：同输入（含 now 注入）必同输出。
 */
export function sortSessions<T extends RankEntry>(items: T[], query: string, opts: RankOpts = {}): T[] {
  const scored = items.map((it, idx) => ({
    idx,
    r: scoreSession(it.meta, query, { now: opts.now, queryWorkspace: opts.queryWorkspace, hitRows: it.hitRows, bestBm25: it.bestBm25 }),
  }))
  scored.forEach((s, i) => {
    ;(items[i] as RankEntry)._rank = s.r
  })
  const order = scored
    .map((s, i) => ({ s, i }))
    .sort((A, B) => {
      const ra = A.s.r.score
      const rb = B.s.r.score
      if (ra !== rb) return rb - ra
      const fa = A.s.r.components.matchedField || 'title'
      const fb = B.s.r.components.matchedField || 'title'
      const la = lenOf(fa, items[A.i].meta)
      const lb = lenOf(fb, items[B.i].meta)
      if (la !== lb) return la - lb
      const ba = A.s.r.components.matchStart
      const bb = B.s.r.components.matchStart
      if (ba !== bb) return cmpNum(ba, bb)
      const ea = A.s.r.components.matchEnd
      const eb = B.s.r.components.matchEnd
      if (ea !== eb) return cmpNum(ea, eb)
      return A.i - B.i
    })
  return order.map((o) => items[o.i])
}

function lenOf(field: string, meta: SessionMeta): number {
  if (field === 'title') return (meta.title ?? '').length
  if (field === 'firstUserText') return (meta.firstUserText ?? '').length
  return (meta.title ?? '').length
}

/* ══ bm25 会话级聚合（执行细节 4：二选一定案 = 「最佳 rank」策略）═════════ */

export interface Bm25Row {
  sessionId: string
  lineageRoot?: string
  /** sqlite bm25(messages_fts_trigram)：≤0，越小越相关 */
  bm25: number
}

export interface AggregatedBm25 {
  lineageKey: string
  /** 该会话（族）的最佳（最小）bm25 */
  best: number
  /** 该会话（族）累计命中行数（密度项来源） */
  hitRows: number
}

/**
 * aggregateBm25Rows —— 消息级行聚合为会话（lineage 族）级，「best-rank」策略。
 * 为什么选 best 而不是 top-k 平均（任务给的另一选项）：bm25 分布由文档长度/idf
 * 驱动，同一会话不同行长能拉开均值；best 单调可解释（"最像的那条消息"）、对
 * leader 干扰免疫、状态最少。若线上分布异常需要切换 top-k 平均，改动点集中在
 * 本函数 —— 由测试锁定当前选案（test/rank.test.ts bm25 聚合组）。
 */
export function aggregateBm25Rows(rows: Bm25Row[]): Map<string, AggregatedBm25> {
  const out = new Map<string, AggregatedBm25>()
  for (const r of rows) {
    const key = r.lineageRoot || r.sessionId
    const prev = out.get(key)
    if (!prev) out.set(key, { lineageKey: key, best: r.bm25, hitRows: 1 })
    else {
      if (r.bm25 < prev.best) prev.best = r.bm25
      prev.hitRows += 1
    }
  }
  return out
}
