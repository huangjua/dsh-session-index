/**
 * atomic-write.ts — 原子提交 + stale tmp 清理 + durable run-marker
 *
 * 对齐 Codex compression.rs 的 materialize / persist_noclobber 与
 * CompressionRunMarker（create_new + 过期抢占 + Drop 清理）。
 *
 * 崩溃安全不变式：index.json 每一刻都是一个完整、合法、version=1 的
 * 旧版或新版快照；半成品只可能以 .tmp.* 存在，下次启动清理。
 */
import { open, mkdir, rename, unlink, readFile, link, readdir, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
let tmpSeq = 0;
/**
 * 原子写 JSON：
 * 1. 写唯一临时文件 index.json.tmp.<pid>.<seq>（'wx' no-clobber）；
 * 2. fh.sync()（fsync）；
 * 3. 读回 + JSON.parse 校验（失败 → 删 tmp、旧文件原封不动、抛错）；
 * 4. 可选 hardlink 备份；
 * 5. rename 覆盖（Windows 上 Node 走 MoveFileEx(REPLACE_EXISTING)）。
 */
export async function atomicWriteJson(indexFile, data, options = {}) {
    const dir = dirname(indexFile);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${basename(indexFile)}.tmp.${process.pid}.${tmpSeq++}`);
    const text = JSON.stringify(data);
    let fh = null;
    try {
        fh = await open(tmp, 'wx');
        await fh.writeFile(text, 'utf8');
        await fh.sync();
        await fh.close();
        fh = null;
        // 读回校验：失败则删 tmp，旧文件不变
        const back = await readFile(tmp, 'utf8');
        JSON.parse(back);
        if (options.validate && !options.validate(back)) {
            throw new Error('atomic write validation failed');
        }
        if (options.backup) {
            try {
                // C4：.bak 必须随每次提交滚动更新——旧实现 link() 在 .bak 已存在时 EEXIST
                // 被吞，备份永远停留在第一次成功时的版本，回滚防线名存实亡。先 unlink 再 link。
                const bak = `${indexFile}.bak`;
                await unlink(bak).catch(() => { });
                await link(indexFile, bak);
            }
            catch {
                /* 备份失败不阻断（无权限等） */
            }
        }
        await rename(tmp, indexFile);
    }
    catch (e) {
        if (fh) {
            try {
                await fh.close();
            }
            catch {
                /* 忽略 */
            }
        }
        try {
            await unlink(tmp);
        }
        catch {
            /* 忽略 */
        }
        throw e;
    }
}
/** 清理目录下的陈旧临时文件（Codex cleanup_stale_temps 语义）。返回删除数。 */
export async function cleanupStaleTemps(dir, options = {}) {
    const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    const now = Date.now();
    let names;
    try {
        names = await readdir(dir);
    }
    catch {
        return 0;
    }
    let removed = 0;
    for (const name of names) {
        if (options.match && !options.match.test(name))
            continue;
        const full = join(dir, name);
        try {
            const st = await stat(full);
            if (!st.isFile())
                continue;
            if (now - st.mtimeMs < maxAgeMs)
                continue;
            await unlink(full);
            removed++;
        }
        catch {
            /* 忽略（文件消失/无权限） */
        }
    }
    return removed;
}
/**
 * durable run-marker：跨进程/崩溃后重启的构建防重。
 * - open 'wx' 原子抢占，写入 pid + started_at；
 * - EEXIST → 读 mtime，超过 staleAfterMs（默认 15 分钟，DSH 构建分钟级）视为
 *   陈旧并删除重抢（Codex 6 小时阈值不适用）；
 * - 返回 null = 已有活跃/新鲜构建，调用方跳过本次构建。
 */
export class RunMarker {
    file;
    released = false;
    pid;
    constructor(file) {
        this.file = file;
        this.pid = process.pid;
    }
    static async acquire(markerFile, staleAfterMs = 15 * 60 * 1000) {
        await mkdir(dirname(markerFile), { recursive: true });
        const content = `pid=${process.pid} started_at=${new Date().toISOString()}\n`;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fh = await open(markerFile, 'wx');
                await fh.writeFile(content, 'utf8');
                await fh.close();
                return new RunMarker(markerFile);
            }
            catch (e) {
                const code = e?.code;
                if (code !== 'EEXIST')
                    throw e;
            }
            // 已存在：读 mtime 判断是否陈旧
            let st;
            try {
                st = await stat(markerFile);
            }
            catch {
                continue; // 竞争下被删 → 重试创建
            }
            if (Date.now() - st.mtimeMs < staleAfterMs)
                return null;
            try {
                await unlink(markerFile);
            }
            catch {
                return null; // 别人抢走了
            }
        }
        return null;
    }
    /**
     * 对应 Rust remove_on_drop：结束/catch/finally 时删除 marker。
     * 释放前校验所有权（P2-10）：若本构建超时被其他进程抢占（陈旧 marker 重抢），
     * 文件里已是别人的 pid，不得误删——否则 C 进程可能再闯进来。
     */
    async release() {
        if (this.released)
            return;
        this.released = true;
        try {
            const content = await readFile(this.file, 'utf8');
            if (!content.startsWith(`pid=${this.pid}`))
                return;
            await unlink(this.file);
        }
        catch {
            /* 文件已不存在（正常删除或从未创建成功） */
        }
    }
}
//# sourceMappingURL=atomic-write.js.map