/**
 * rank.test.ts — STAGE-1 Part A 会话级相关性排序（纯函数层）
 *
 * 覆盖（验收清单映射）：
 *  - fzy 打分性质（对 pinned match.c 的数值级断言，全部按 match_row 递推手推，
 *    容差 1e-9）：相邻连续命中加分 / 中间空隙罚单调 / 早命中加分 / 词界 bonus 链
 *    (slash>word>dot) / 大小写不敏感 / camelCase CAPITAL 原始码点语义 /
 *    等长短路 SCORE_MAX / CJK NonWord 几何与 ASCII 等价
 *  - tie-break 确定性：同分输入顺序保持（稳定序，与 id 无关）
 *  - bm25 会话聚合：最佳 rank 策略（含 lineage 族归并与行计数）
 *  - 组件可解释性：tier/tierTerm/workspace/recency/frequency(log 截断)/bm25 分量
 *  - 主干主导排序：fzy 强者压过时间新但标题弱者
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  fzyScore,
  scoreSession,
  sortSessions,
  aggregateBm25Rows,
  tierOf,
  RANK_WEIGHTS,
} from '../src/rank.js'
import type { RankEntry } from '../src/rank.js'
import type { SessionMeta } from '../src/core.js'

const APPROX = 1e-9

/** 构造测试用 SessionMeta（填满必填字段） */
function mkMeta(partial: Partial<SessionMeta> & { id: string }): SessionMeta {
  return {
    file: partial.file ?? `/s/${partial.id}/session.jsonl.zstd`,
    size: 1234,
    mtimeMs: 1786900000000,
    createdAt: 1786800000000,
    lastTime: 1786900000000,
    title: '',
    firstUserText: '',
    lastAssistantText: '',
    agentPreset: 'router-flash',
    counts: {},
    toolNames: [],
    toolCallCounts: {},
    ...partial,
  } as SessionMeta
}

describe('fzy 打分器（对照 pinned match.c 的数值断言）', () => {
  it('连续命中加分：相邻对齐独占巨额奖励；跨空隙跌落 back 后按内隙严格单调', () => {
    // 三例几何同构（首命中前缀一列 x），仅命中间空隙数不同：
    //   'xab' 相邻 → a@1,b@2；'xayb' 一空隙 → a@1,b@3；'xayyb' 两空隙 → a@1,b@4
    const adjacent = fzyScore('ab', 'xab')!
    const gap1 = fzyScore('ab', 'xayb')!
    const gap2 = fzyScore('ab', 'xayyb')!
    // 手推（match_row 语义）：相邻走 CONSECUTIVE(+1) 分支 → 0.995；
    // 跨空隙丢掉 consecutive 且按列累进 INNER：起点 −0.005、每空隙列 −0.01。
    // —— 这正是 fzy 的打分直觉："连贯子串命中"与"跳字模糊"之间是断崖而非斜坡。
    assert.ok(Math.abs(adjacent.score - 0.995) < APPROX, `adjacent=${adjacent.score}`)
    assert.ok(Math.abs(gap1.score - -0.015) < APPROX, `gap1=${gap1.score}`)
    assert.ok(Math.abs(gap2.score - -0.025) < APPROX, `gap2=${gap2.score}`)
    assert.ok(adjacent.score > gap1.score && gap1.score > gap2.score)
    assert.ok(gap2.score - gap1.score < 0 && Math.abs((gap1.score - gap2.score) - 0.01) < APPROX,
      '空隙每多一列恰降 INNER')
    assert.deepEqual([adjacent.start, adjacent.end], [1, 2])
    assert.deepEqual([gap2.start, gap2.end], [1, 4])
  })

  it('早命中加分：同一查询更靠前的对齐显著更高（LEADING + 后续链条放大）', () => {
    const early = fzyScore('te', 'tez')!
    const late = fzyScore('te', 'zte')!
    // 手推：early 最优链终值 1.9 − 尾随 TRAILING×1 = 1.895；late 无平局要素 0.995
    assert.ok(Math.abs(early.score - 1.895) < APPROX, `early=${early.score}`)
    assert.ok(Math.abs(late.score - 0.995) < APPROX, `late=${late.score}`)
    assert.equal(late.start, 1)
    assert.ok(early.score > late.score)
  })

  it('词界 bonus 链（bonus.h 二维表逐条）：slash > word > dot > 无分隔', () => {
    const slash = fzyScore('fz', 'a/fz')!
    const word = fzyScore('fz', 'a-fz')!
    const dot = fzyScore('fz', 'a.fz')!
    const none = fzyScore('fz', 'azfz')!
    // 手推（同构布局 a?fz，命中 f@2,z@3；差异只在 j2 边界奖：SLASH .9 / WORD .8 /
    // DOT .6 / 0；首行起点 j*LEADING=−0.01；第二跳 consec +1，无尾随列）：
    assert.ok(Math.abs(slash.score - 1.89) < APPROX, `slash=${slash.score}`)
    assert.ok(Math.abs(word.score - 1.79) < APPROX, `word=${word.score}`)
    assert.ok(Math.abs(dot.score - 1.59) < APPROX, `dot=${dot.score}`)
    assert.ok(Math.abs(none.score - 0.99) < APPROX, `none=${none.score}`)
    assert.ok(slash.score > word.score && word.score > dot.score && dot.score > none.score)
  })

  it('camelCase CAPITAL：配对字符本身是大写驼峰时 +SCORE_MATCH_CAPITAL（原始码点语义）', () => {
    const camel = fzyScore('ba', 'fooBar')!
    const plain = fzyScore('ba', 'foobar')!
    // 小写化后几何完全一致，唯一差异是配对 'B'（prev 'o' 小写 → states[2] CAPITAL 0.7）；
    // 手推含尾随列：camel 终值 1.68、plain 0.98，差恰为 0.7
    assert.ok(Math.abs(camel.score - 1.68) < APPROX, `camel=${camel.score}`)
    assert.ok(Math.abs(plain.score - 0.98) < APPROX, `plain=${plain.score}`)
    assert.ok(Math.abs((camel.score - plain.score) - 0.7) < APPROX)
  })

  it('大小写不敏感：查询大小写折叠后结果完全相同', () => {
    const a = fzyScore('AB', 'a-b')!
    const b = fzyScore('ab', 'a-b')!
    assert.equal(a.score, b.score)
    assert.deepEqual([a.start, a.end], [b.start, b.end])
    assert.ok(Number.isFinite(a.score))
  })

  it('等长短路：n==m 直接 SCORE_MAX 并回填满区间（match.c:127-133）', () => {
    const eq = fzyScore('te', 'TE')!
    assert.equal(eq.score, Number.POSITIVE_INFINITY)
    assert.deepEqual([eq.start, eq.end], [0, 1])
  })

  it('CJK 码点路径与 ASCII 行为等价：NonWord 几何同构 → 数值/区间全等', () => {
    // 双方每个字符都落 bonus 表第 0 行（无任何边界奖），纯几何互推
    const ascii = fzyScore('@#', '@ #')!
    const cjk = fzyScore('好嘛', '好 嘛')!
    // 手推：零 bonus 下 M 终值 = 连续两跳通过 M 路径的 −0.01（第二行自 row0 空隙态承接）
    assert.ok(Math.abs(ascii.score - -0.01) < APPROX, `ascii=${ascii.score}`)
    assert.equal(cjk.score, ascii.score)
    assert.deepEqual([cjk.start, cjk.end], [ascii.start, ascii.end])
    assert.deepEqual([cjk.start, cjk.end], [0, 2])
  })

  it('多行递推：三字符查询跨两处词界（D/M 协同 + 尾行 TRAILING 终值）', () => {
    // 'a_b_c'：两处词界各给 WORD 0.8；第二跳经 M 路径（上一行空隙态）转移时会
    // 加上当前对齐位的 bonus → 终值 2.48（含行内 INNER 累进与末行无尾随列）
    const m = fzyScore('abc', 'a_b_c')!
    assert.ok(Math.abs(m.score - 2.48) < APPROX, `score=${m.score}`)
    assert.deepEqual([m.start, m.end], [0, 4])
  })

  it('失配返回 null：有序子序列检查（fzy has_match）与超长上限', () => {
    assert.equal(fzyScore('xy', 'yx'), null, '乱序子串不应匹配')
    assert.equal(fzyScore('', 'abc'), null, '空查询无意义')
    assert.equal(fzyScore('abcd', 'abc'), null, 'needle 长于 haystack')
    // 真正的有序子序列仍可命中（含离散跳列）
    assert.ok(fzyScore('xz', 'xqyqz') !== null)
  })
})

describe('tie-break 确定性（fzf 语义）', () => {
  const NOW = 1786900000000
  function sameEverything(id: string): SessionMeta {
    return mkMeta({ id, title: '统一标题的会话', lastTime: NOW, counts: { 'user/message': 3 } })
  }

  it('全部分量相同时保持输入顺序（稳定序，不因 id 改变）', () => {
    const forward: RankEntry[] = [
      { meta: sameEverything('aaa') },
      { meta: sameEverything('bbb') },
      { meta: sameEverything('ccc') },
    ]
    const outForward = sortSessions([...forward], '', { now: NOW })
    assert.deepEqual(
      outForward.map((e) => e.meta.id),
      ['aaa', 'bbb', 'ccc'],
      '原序输入 → 原序输出',
    )
    const reversed = [...forward].reverse()
    const outReversed = sortSessions(reversed, '', { now: NOW })
    assert.deepEqual(
      outReversed.map((e) => e.meta.id),
      ['ccc', 'bbb', 'aaa'],
      '倒序输入 → 倒序输出（确定性 = 只由输入序决定）',
    )
  })

  it('_rank 回填：分数与组件随排序产出', () => {
    const items: RankEntry[] = [{ meta: mkMeta({ id: 'x', title: 'fts trigram search' }) }]
    sortSessions(items, 'fts', { now: NOW })
    const r = items[0]._rank
    assert.ok(r, '_rank 应回填')
    assert.equal(r!.components.tier, 'prefix')
  })
})

describe('bm25 会话级聚合（best-rank 策略锁定）', () => {
  it('同会话取最佳（最小 bm25），行数累计', () => {
    const rows = [
      { sessionId: 's1', bm25: -6.2 },
      { sessionId: 's1', bm25: -8.9 },
      { sessionId: 's1', bm25: -3.1 },
      { sessionId: 's2', bm25: -4.0 },
    ]
    const agg = aggregateBm25Rows(rows)
    assert.equal(agg.size, 2)
    assert.deepEqual(agg.get('s1'), { lineageKey: 's1', best: -8.9, hitRows: 3 })
    assert.deepEqual(agg.get('s2'), { lineageKey: 's2', best: -4.0, hitRows: 1 })
  })

  it('lineageRoot 归并：父会话族共享一个聚合键', () => {
    const rows = [
      { sessionId: 'child', lineageRoot: 'parent', bm25: -2 },
      { sessionId: 'parent', lineageRoot: 'parent', bm25: -5 },
    ]
    const agg = aggregateBm25Rows(rows)
    assert.equal(agg.size, 1)
    assert.deepEqual(agg.get('parent'), { lineageKey: 'parent', best: -5, hitRows: 2 })
  })
})

describe('scoreSession 组件可解释性 + 会话域特征', () => {
  const NOW = 1786900000000

  it('prefix 档位/亲缘/衰减/频率各分量符合公式（可解释断言）', () => {
    const meta = mkMeta({
      id: 'study',
      title: 'FTS Trigram Search 设计',
      firstUserText: '随便什么正文',
      workspace: 'E:\\Do\\StudyDesk',
      lastTime: NOW - 24 * 3600e3, // 整 1 天
      counts: { 'user/message': 10 },
    })
    const r = scoreSession(meta, 'fts', { now: NOW, queryWorkspace: 'studydesk' })
    const c = r.components
    assert.equal(c.tier, 'prefix')
    assert.equal(c.tierTerm, RANK_WEIGHTS.TIER_PREFIX)
    assert.equal(c.workspaceTerm, RANK_WEIGHTS.WORKSPACE)
    // 24h 桶 = 1 天 → raw = 2^(-1/21)
    const expectRecency = RANK_WEIGHTS.RECENCY * Math.pow(2, -1 / RANK_WEIGHTS.RECENCY_HALF_LIFE_DAYS)
    assert.ok(Math.abs(c.recencyTerm - expectRecency) < APPROX)
    // 频率：log1p(10) 未触顶
    assert.ok(Math.abs(c.frequencyTerm - RANK_WEIGHTS.FREQUENCY * Math.log1p(10)) < APPROX)
    assert.equal(c.bm25Term, undefined, '未提供 bestBm25 时分量缺省')
    assert.equal(r.score, c.fuzzyTerm + c.tierTerm + c.workspaceTerm + c.recencyTerm + c.frequencyTerm)
  })

  it('频率长尾截断：log1p 触顶后不再增长（防霸榜）', () => {
    const meta = mkMeta({ id: 'big', title: 't', counts: { 'user/message': 500, 'tool/call': 500 } })
    const big = scoreSession(meta, '', { now: NOW })
    const huge = scoreSession(mkMeta({ id: 'huge', title: 't', counts: { x: 100000 } }), '', { now: NOW })
    assert.ok(Math.abs(big.components.frequencyTerm - RANK_WEIGHTS.FREQUENCY * RANK_WEIGHTS.FREQUENCY_LOG_CAP) < APPROX)
    assert.equal(huge.components.frequencyTerm, big.components.frequencyTerm, '触顶后相等')
  })

  it('bm25 正文证据分量：仅 FTS 路径注入，越负越相关单调增', () => {
    const meta = mkMeta({ id: 'e', title: 'deploy runbook' })
    const weak = scoreSession(meta, 'runbook', { bestBm25: -1 })
    const strong = scoreSession(meta, 'runbook', { bestBm25: -30 })
    assert.ok(typeof weak.components.bm25Term === 'number')
    assert.ok(strong.components.bm25Term! > weak.components.bm25Term!)
    // 上限受权重约束（次级证据）
    assert.ok(strong.components.bm25Term! <= RANK_WEIGHTS.BM25 + APPROX)
  })

  it('主干主导：fzy 强命中压过"更新但标题弱"的会话（跨路径一致性的权重前提）', () => {
    const NOW2 = Date.now()
    const strong = mkMeta({ id: 'strong', title: 'sqlite trigram migration plan', lastTime: NOW2 - 40 * 86400e3 })
    const freshWeak = mkMeta({ id: 'weak', title: 'miscellaneous notes about anything else', lastTime: NOW2 })
    const out = sortSessions<RankEntry>([{ meta: strong }, { meta: freshWeak }], 'sqlite', { now: NOW2 })
    assert.equal(out[0].meta.id, 'strong')
    assert.ok(out[0]._rank!.score > out[1]._rank!.score)
  })
})

describe('tierOf（四档，atuin 同源思想会话域扩展）', () => {
  it('exact > prefix > substring > fuzzy > none 五态判定', () => {
    assert.equal(tierOf('abc', 'abc', null), 'exact')
    assert.equal(tierOf('abc', 'abcdef', null), 'prefix')
    assert.equal(tierOf('abc', 'xxabcxx', null), 'substring')
    assert.equal(tierOf('axc', 'xxaxxcxx', fzyScore('axc', 'xxaxxcxx')), 'fuzzy')
    assert.equal(tierOf('', 'anything', null), 'none')
  })
})
