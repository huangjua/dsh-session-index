/**
 * gen-old-frame.mjs — R2 旧格式首帧夹具生成（STAGE-1 Part C）
 *
 * 构造方式：同一行序列、两种帧切分，用 node:zlib zstdCompressSync 逐段压成独立
 * zstd 帧后按序拼接（与既有 big-session 多帧夹具同法；fzstd/native 均按帧边界
 * 透明解压，行解析对帧切分免疫——本夹具即用来"用测试固化"该免疫）：
 *  - old-frame-session.jsonl.zstd ：首帧 = [header + title + user1 + assistant1]
 *    （旧格式：header 与事件同帧），帧2 = [tool + user2]
 *  - header-frame-session.jsonl.zstd：首帧 = [header]（header 独占首帧），
 *    帧2 = [其余全部]
 *
 * 重跑：node test/fixtures/gen-old-frame.mjs（覆盖两个输出文件）。
 */
import { zstdCompressSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))
const t = (n) => 1000 + n * 1000
const lines = [
  JSON.stringify({ type: 'session', id: 'old-frame-session', createdAt: t(0), cwd: 'E:\\Do\\x', agentPreset: 'router-flash', time: t(0) }),
  JSON.stringify({ type: 'session/title', time: t(1), data: { title: '旧格式首帧夹具标题' } }),
  JSON.stringify({ type: 'user/message', time: t(2), data: { content: [{ type: 'text', text: '第一条用户消息内容 needle 在此' }] } }),
  JSON.stringify({ type: 'assistant/message', time: t(3), data: { message: { content: [{ type: 'text', text: '第一条助手回复 needle 也出现' }] } } }),
  JSON.stringify({ type: 'tool/call', time: t(4), data: { name: 'bash_needle_tool' } }),
  JSON.stringify({ type: 'user/message', time: t(5), data: { content: [{ type: 'text', text: '第二条用户消息内容' }] } }),
]
const frame = (slice) => zstdCompressSync(Buffer.from(slice.join('\n') + '\n', 'utf8'))
writeFileSync(join(dir, 'old-frame-session.jsonl.zstd'), Buffer.concat([
  frame([lines[0], lines[1], lines[2], lines[3]]),
  frame([lines[4], lines[5]]),
]))
writeFileSync(join(dir, 'header-frame-session.jsonl.zstd'), Buffer.concat([
  frame([lines[0]]),
  frame([lines[1], lines[2], lines[3], lines[4], lines[5]]),
]))
console.log('generated old-frame-session.jsonl.zstd + header-frame-session.jsonl.zstd')
