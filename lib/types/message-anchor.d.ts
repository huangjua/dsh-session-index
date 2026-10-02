export interface MessageIdentity {
    anchorId: string;
    eventSeq: number;
    eventType: string;
    sourceMessageId?: string;
    callId?: string;
    generation: number;
    identityEvidence: string;
}
/** Original writer IDs survive seq changes; a seq fallback is generation/body bound. */
export declare function messageIdentity(sessionId: string, generation: number, event: {
    seq: number;
    type: string;
    data: Record<string, unknown>;
}, text: string, toolName?: string): MessageIdentity;
