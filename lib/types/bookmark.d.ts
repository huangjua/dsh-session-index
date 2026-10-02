/** 书签 sidecar 文件名（codex SESSION_INDEX_FILE 惯例；与 fts.db 同级） */
export declare const BOOKMARK_FILE_NAME = "bookmarks.jsonl";
/** 行结构版本（version 前置供未来迁移；读取只接受 v===1） */
export declare const BOOKMARK_VERSION = 2;
/** label 缺省截断长度（任务执行细节：meta.title 或 firstUserText 前 80 字符） */
export declare const DEFAULT_LABEL_MAX = 80;
/** list limit 上限（任务执行细节：默认 20，≤100） */
export declare const BOOKMARK_LIST_LIMIT_DEFAULT = 20;
export declare const BOOKMARK_LIST_LIMIT_MAX = 100;
/** 单条书签（v:1 行结构） */
export interface Bookmark {
    v: number;
    /** 确定性 id（锚点哈希；跨进程/重启稳定，remove-by-id / upsert 可复现） */
    id: string;
    sessionId: string;
    sessionFile: string;
    /** 消息锚点（SCROLL 用）；缺省 = null（会话级书签） */
    messageId: number | null;
    anchorId?: string;
    anchorStatus?: 'resolved' | 'session' | 'unresolved';
    unresolvedReason?: string;
    legacyEvidence?: {
        identityEvidence: string;
        anchorId?: string;
    };
    [key: string]: unknown;
    label: string;
    note: string | null;
    title: string;
    workspace: string;
    createdAt: number;
    updatedAt: number;
}
/** add 输入（createdAt/updatedAt 由存储层填充） */
export interface BookmarkInput {
    sessionId: string;
    sessionFile: string;
    messageId?: number | null;
    anchorId?: string;
    label: string;
    note?: string | null;
    title: string;
    workspace: string;
}
/** 缺省 sidecar 路径：%DSH_HOME%\session-index\bookmarks.jsonl（与 fts.db 同级） */
export declare function defaultBookmarkFile(dshHome: string): string;
/**
 * 锚点键：(sessionId, messageId) 归一化。messageId 缺省 = null（会话级书签）。
 * 同锚点重复 add = 替换更新（aider 幂等思想）。
 */
export declare function anchorKey(sessionId: string, messageId: number | null | undefined, anchorId?: string): string;
/**
 * id = sha1(锚点键) 十六进制。
 *
 * 为什么选确定性锚点哈希而非短随机（任务执行细节二选一）：
 * - 跨进程/跨重启稳定：同一锚点永远同一 id → remove-by-id 可复现、upsert
 *   去重天然成立（同锚点的所有行共享同一 id）；
 * - 短随机在并发 append 下会产生同锚点多条不同 id 的行，破坏"不产生重复
 *   有效行"的幂等约束。
 * node:crypto 内建，零新依赖。
 */
export declare function bookmarkIdFor(sessionId: string, messageId: number | null | undefined, anchorId?: string): string;
/**
 * label 缺省 = meta.title 或 firstUserText 前 80 字符（确定性，无 LLM）。
 * title 非空用 title；否则用首条用户消息；两者皆空 → ''。
 */
export declare function defaultLabel(title: string, firstUserText: string): string;
/** 显式失效（add/remove 后调用），防同 ms 同 size 撞车。 */
export declare function invalidateBookmarkCache(path: string): void;
/** 校验并归一化一行书签；形状不符（含 v!==1，未来迁移前奏）→ null（计坏行）。 */
export declare function normalizeBookmark(obj: unknown): Bookmark | null;
/**
 * 解析 JSONL 文本：逐行 JSON.parse 容错（坏行跳过并计数，照 codex 容错读）；
 * 同锚点重复行取最新（尾扫描语义：后出现者覆盖先出现者）。
 */
export declare function parseBookmarkLines(text: string): {
    bookmarks: Bookmark[];
    skippedBad: number;
};
/**
 * 整读 + 容错 + 最新胜出；mtimeMs+size 指纹缓存（照 core.ts loadIndex 模式），
 * 每次工具调用只读一次。仅文件缺失 → 空列表；其它读取错误传播给调用方。
 */
export declare function readBookmarks(path: string): Promise<{
    bookmarks: Bookmark[];
    skippedBad: number;
}>;
/**
 * 追加一条书签（幂等 upsert）：
 * - 同锚点已存在 → replaced=true；新行继承原 createdAt、刷新 updatedAt/label/note
 *  （aider 替换更新思想）；
 * - 保留已有 JSONL 行，新行与原文件一起 fsync + rename；跨进程互斥覆盖整个写入；
 * - 返回本次写入的最新行。
 */
export declare function addBookmark(path: string, input: BookmarkInput, now?: number): Promise<{
    bookmark: Bookmark;
    replaced: boolean;
}>;
export interface RemoveBookmarksOptions {
    /** 按书签 id（精确）删除一条 */
    id?: string;
    /** 按 sessionId（精确，大小写不敏感）删除该会话全部书签 */
    sessionId?: string;
}
/**
 * 删除书签（codex remove_thread_name_entries 语义）。**绝不删除会话文件**。
 * 返回删除行数；无匹配则不动文件返回 0；文件缺失返回 0（codex NotFound → Ok）。
 */
export declare function removeBookmarks(path: string, opts: RemoveBookmarksOptions): Promise<number>;
/** list 过滤：对 label/note/title 大小写不敏感子串匹配（复用 metaMatch 归一化语义） */
export declare function bookmarkMatches(b: Bookmark, query: string): boolean;
/**
 * list 排序：updatedAt 倒序 → id 升序 → 原顺序（文件序）收口。
 * 等分决序沿用 rank.ts 的确定性 tiebreak 语义（fzf：score→…→index；本域无
 * fzy 分，取最后一道确定性收口 = 原始下标，与 sortSessions 的 index 收口同构）。
 * 同输入必同输出。
 */
export declare function sortBookmarks(bookmarks: Bookmark[]): Bookmark[];
export interface LegacyBookmarkResolution {
    status: 'resolved' | 'unresolved' | 'ambiguous' | 'session-missing' | 'anchor-replaced';
    anchorId?: string;
    evidence?: string;
}
export type BookmarkResolver = (bookmark: Bookmark) => Promise<LegacyBookmarkResolution>;
/** Explicit dry run / migration. Search and list never write migrated data. */
export declare function migrateBookmarks(path: string, resolver: BookmarkResolver, options?: {
    dryRun?: boolean;
    backupPath?: string;
}): Promise<{
    version: number;
    dryRun: boolean;
    records: number;
    counts: {
        resolved: number;
        unresolved: number;
        ambiguous: number;
        'session-missing': number;
        'anchor-replaced': number;
        session: number;
        alreadyMigrated: number;
    };
    entries: {
        line: number;
        id: string;
        sessionId: string;
        status: string;
        reason?: string;
    }[];
    sourceHash: string;
}>;
