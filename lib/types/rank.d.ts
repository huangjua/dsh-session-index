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
import type { SessionMeta } from './core.js';
export interface FzyMatch {
    /** fzy 最终分（越大越好；n==m 短路时为 Infinity，对应上游 SCORE_MAX） */
    score: number;
    /** 最优对齐的首个命中下标（码点下标；tiebreak begin 用） */
    start: number;
    /** 最优对齐的末个命中下标（含） */
    end: number;
}
/**
 * fzyScore —— match_positions（match.c:148-224）的 TS 字面移植（带位置回溯）。
 * 差异仅限任务指定的 Unicode 适配（码点数组）与本域包装。递推与回溯逐行对照
 * match.c 注释翻译。
 */
export declare function fzyScore(query: string, text: string): FzyMatch | null;
export declare const RANK_WEIGHTS: {
    /** fzy 归一分权重 —— 主干主项，完全主导排序方向。 */
    readonly FUZZY: 60;
    /**
     * 命中类型加成（任务规范四档；atuin sort.rs 同源思想的会话域扩展，见文件头 §2）：
     * exact > prefix > substring > fuzzy。校准理由：档距 6（≈ 弱半档 fzy 差）；
     * exact↔substring 共差 12，必须小于 FUZZY 主导带（σ 映射后有效摆幅 ±60）——
     * 档位只能裁决模糊分接近时的先后，不能跨档翻转强 fuzzy 差异。
     */
    readonly TIER_EXACT: 24;
    readonly TIER_PREFIX: 18;
    readonly TIER_SUBSTRING: 12;
    readonly TIER_FUZZY: 6;
    /** workspace 亲缘（查询 workspace 子串命中 meta.workspace）；一次亲缘 ≈ 一档命中类型。 */
    readonly WORKSPACE: 10;
    /**
     * 时间衰减权重（mcfly ageFactor 结构 → 会话 lastTime；24h 自然日桶 + 半衰期指数）。
     * HALF_LIFE_DAYS=21：1 周≈0.79、1 月≈0.37、90 天≈0.05 —— 近两周显著加权、
     * 三月近乎归零，符合"近期会话更可能相关"的导航直觉。
     */
    readonly RECENCY: 8;
    readonly RECENCY_HALF_LIFE_DAYS: 21;
    /** lastTime 缺失(≤0)时的兜底 raw：温和压低而非归零 */
    readonly RECENCY_UNKNOWN: 0.3;
    /**
     * 频率项权重。raw = min(log1p(n), FREQUENCY_LOG_CAP)：
     * n = 该路径内命中行数（搜索）/ 事件总数（列表）。饱和点 log1p(n)=2.5（n≈11.2）
     * ——频率长尾不霸榜（mcfly max_selected_occurrences 截断思想同源）。
     */
    readonly FREQUENCY: 6;
    readonly FREQUENCY_LOG_CAP: 2.5;
    /**
     * BM25 正文证据权重（仅 FTS 路径注入；最佳 bm25 经 sigmoid 映射为对称 ± 分量）。
     * 校准理由：正文相关性是真信号，但只在 FTS 一路可得——若它能翻转主干差异，
     * 三路径就会同查不同序。故上限 12，定位次级证据。
     */
    readonly BM25: 12;
};
export type HitTier = 'exact' | 'prefix' | 'substring' | 'fuzzy' | 'none';
export interface RankOpts {
    /** 当前时刻（ms）。测试注入保证确定性；缺省 Date.now() */
    now?: number;
    /** 查询侧 workspace 子串（list/search 的 workspace 参数），用于亲缘加成 */
    queryWorkspace?: string;
    /** 该路径内此会话的命中行数（密度/频率项数据来源） */
    hitRows?: number;
    /** FTS 路径专用：该会话最佳（最小）bm25 值；未提供则分量缺省 */
    bestBm25?: number;
}
export interface RankComponents {
    /** fzy 原始分（未乘权重，诊断/断言用；n==m 时为 Infinity） */
    fuzzyRaw: number;
    /** fzy 归一分（σ 映射中心化 ±1 × 权重） */
    fuzzyTerm: number;
    /** 命中档位 */
    tier: HitTier;
    /** 档位加成（已乘权重） */
    tierTerm: number;
    /** 亲缘加成（已乘权重） */
    workspaceTerm: number;
    /** 时间衰减（已乘权重） */
    recencyTerm: number;
    /** 频率项（已乘权重） */
    frequencyTerm: number;
    /** bm25 正文证据（仅提供 bestBm25 时出现，已乘权重） */
    bm25Term?: number;
    /** 参与打分的文本域与命中区间（tiebreak begin/end；无命中 -1/-1） */
    matchedField: 'title' | 'firstUserText' | '';
    matchStart: number;
    matchEnd: number;
}
export interface RankResult {
    score: number;
    components: RankComponents;
}
/**
 * 命中档位（四档；atuin sort.rs 同源思想的会话域扩展，见文件头 §2）。在选定文本域
 * （title 优先、firstUserText 后备，与 metaMatch 可见语义一致）上判定：
 * 完全相等 > 前缀 > 子串 > fuzzy。
 */
export declare function tierOf(queryLower: string, textLower: string, fz: FzyMatch | null): HitTier;
/**
 * scoreSession —— 纯函数打分；components 全字段可解释（测试断言/交付验证用）。
 */
export declare function scoreSession(meta: SessionMeta, query: string, opts?: RankOpts): RankResult;
export interface RankEntry {
    meta: SessionMeta;
    /** 路径注入的密度/正文证据（透传 scoreSession） */
    hitRows?: number;
    bestBm25?: number;
    /** sortSessions 回填（只读输出；不影响排序语义） */
    _rank?: RankResult;
}
/**
 * sortSessions —— 在过滤之后调用（红线：严禁扩全集）。等分时按 fzf tiebreak
 * 语义决序：总分降序 → 目标文本长度升序（matchedField 文本；无命中的条目互比
 * 退化为各自 title 长度）→ begin 升序 → end 升序（命中窗更紧凑者优先）→
 * 原始下标升序收口。排序稳定确定：同输入（含 now 注入）必同输出。
 */
export declare function sortSessions<T extends RankEntry>(items: T[], query: string, opts?: RankOpts): T[];
export interface Bm25Row {
    sessionId: string;
    lineageRoot?: string;
    /** sqlite bm25(messages_fts_trigram)：≤0，越小越相关 */
    bm25: number;
}
export interface AggregatedBm25 {
    lineageKey: string;
    /** 该会话（族）的最佳（最小）bm25 */
    best: number;
    /** 该会话（族）累计命中行数（密度项来源） */
    hitRows: number;
}
/**
 * aggregateBm25Rows —— 消息级行聚合为会话（lineage 族）级，「best-rank」策略。
 * 为什么选 best 而不是 top-k 平均（任务给的另一选项）：bm25 分布由文档长度/idf
 * 驱动，同一会话不同行长能拉开均值；best 单调可解释（"最像的那条消息"）、对
 * leader 干扰免疫、状态最少。若线上分布异常需要切换 top-k 平均，改动点集中在
 * 本函数 —— 由测试锁定当前选案（test/rank.test.ts bm25 聚合组）。
 */
export declare function aggregateBm25Rows(rows: Bm25Row[]): Map<string, AggregatedBm25>;
