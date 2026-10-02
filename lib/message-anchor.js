import { createHash } from 'node:crypto';
function hash(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Original writer IDs survive seq changes; a seq fallback is generation/body bound. */
export function messageIdentity(sessionId, generation, event, text, toolName = '') {
    const nested = event.type === 'user/message' ? event.data : event.data.message;
    const message = nested && typeof nested === 'object' ? nested : undefined;
    const source = message?.source && typeof message.source === 'object'
        ? message.source : undefined;
    const sourceMessageId = typeof message?.id === 'string' && message.id.length > 0 ? message.id : undefined;
    const rawCallId = event.type === 'tool/call' ? event.data.callId ?? event.data.id : source?.callId;
    const callId = typeof rawCallId === 'string' && rawCallId.length > 0 ? rawCallId : undefined;
    const identityEvidence = hash([text, toolName]);
    const originalId = sourceMessageId ?? callId;
    const anchorId = originalId !== undefined
        ? `a1:${hash([sessionId, event.type, sourceMessageId ? 'message' : 'call', originalId])}`
        : `a1s:${hash([sessionId, event.type, generation, event.seq, identityEvidence])}`;
    return {
        anchorId, eventSeq: event.seq, eventType: event.type, generation, identityEvidence,
        ...sourceMessageId ? { sourceMessageId } : {},
        ...callId ? { callId } : {},
    };
}
//# sourceMappingURL=message-anchor.js.map