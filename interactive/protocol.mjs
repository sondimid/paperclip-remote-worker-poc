import { createHash } from 'node:crypto';
import { exactKeys, jobIdPattern } from '../protocol.mjs';

export const frameBytes = 16_384;
export const inputBytes = 4_096;
export const finalBytes = 8_192;
export const leaseMaxMs = 10_000;
export const turnMaxMs = 120_000;
export const workerPath = '/worker/connect';
export const matchesId = value => typeof value === 'string' && jobIdPattern.test(value);
export const boundedText = (value, limit) => typeof value === 'string' && Buffer.byteLength(value) <= limit;
const positiveInt = value => Number.isSafeInteger(value) && value > 0;
const ids = ['runId', 'attemptId'];
const fields = {
  resume: ['bootId', 'active'], ready: [],
  start: [...ids, 'issueId', 'workspaceId', 'input', 'leaseMs', 'turnMs'],
  interrupt: ids, ack: [...ids, 'seq', 'leaseMs'],
  event: [...ids, 'seq', 'kind', 'threadId', 'turnId', 'text'],
  terminal: [...ids, 'seq', 'outcome', 'threadId', 'turnId', 'text'],
};
const providerId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const providers = ['codex', 'claude'];
export const capabilityStates = ['checking', 'unsupported', 'policy_unverified', 'auth_unverified', 'ready'];
export const fullFinalBytes = 256 * 1024;
export const finalPartBytes = 3072;
export const maxProgressFrames = 66;
export const maxCliFrames = maxProgressFrames + Math.ceil(fullFinalBytes / finalPartBytes) + 1;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const cliFields = { ...fields,
  capabilities: ['codex', 'claude'],
  start: [...fields.start, 'provider', 'conversationId', 'resume'],
  final_part: [...ids, 'seq', 'threadId', 'turnId', 'index', 'chunk'],
  terminal: [...ids, 'seq', 'outcome', 'threadId', 'turnId', 'bytes', 'sha256', 'reason'],
};
export const failureReasons = ['cli_failed', 'cli_cancelled', 'output_invalid', 'output_limit', 'resume_unavailable', 'policy_unverified', 'deadline'];

export function verifyCliFinal(parts, terminal) {
  const bytes = Buffer.concat(parts, parts.reduce((sum, part) => sum + part.length, 0));
  if (bytes.length !== terminal.bytes || sha256(bytes) !== terminal.sha256) throw new Error('final_checksum');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!text.trim()) throw new Error('final_empty');
  return text;
}

export function parseWorkerFrame(rawFrame) {
  if (Buffer.byteLength(rawFrame) > frameBytes) throw new Error('frame_size');
  const frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(rawFrame)));
  const schema = frame?.v === 1 ? fields : frame?.v === 2 ? cliFields : null;
  if (!schema || !Object.hasOwn(schema, frame.type)
      || !exactKeys(frame, ['v', 'type', ...schema[frame.type]])) throw new Error('frame_shape');
  if (frame.type === 'capabilities' && !providers.every(key => capabilityStates.includes(frame[key]))) throw new Error('frame_capabilities');
  if ('runId' in frame && !ids.every(key => matchesId(frame[key]))) throw new Error('frame_identity');
  if (frame.type === 'resume' && (!matchesId(frame.bootId) || (frame.active !== null
      && (!exactKeys(frame.active, ids) || !ids.every(key => matchesId(frame.active[key])))))) throw new Error('frame_resume');
  if (frame.type === 'start' && (!matchesId(frame.issueId) || frame.workspaceId !== 'interactive-sample'
      || !boundedText(frame.input, inputBytes) || !frame.input.trim() || !positiveInt(frame.leaseMs)
      || frame.leaseMs > leaseMaxMs || !positiveInt(frame.turnMs) || frame.turnMs > turnMaxMs)) throw new Error('frame_start');
  if (frame.type === 'ack' && (!Number.isSafeInteger(frame.seq) || frame.seq < 0
      || !Number.isSafeInteger(frame.leaseMs) || frame.leaseMs < 0 || frame.leaseMs > leaseMaxMs)) throw new Error('frame_ack');
  if (frame.type === 'event' && (!positiveInt(frame.seq) || !providerId(frame.threadId) || !providerId(frame.turnId)
      || !['started', 'delta', 'gap'].includes(frame.kind) || !boundedText(frame.text, 1024)
      || (frame.kind !== 'delta' && frame.text !== ''))) throw new Error('frame_event');
  if (frame.v === 2 && frame.type === 'start' && (!providers.includes(frame.provider) || !matchesId(frame.conversationId)
      || typeof frame.resume !== 'boolean')) throw new Error('frame_cli_start');
  if (frame.type === 'final_part') {
    if (!positiveInt(frame.seq) || !matchesId(frame.threadId) || frame.turnId !== frame.attemptId
        || !Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index >= Math.ceil(fullFinalBytes / finalPartBytes)
        || typeof frame.chunk !== 'string' || !frame.chunk.length || frame.chunk.length > finalPartBytes * 4 / 3
        || Buffer.from(frame.chunk, 'base64').toString('base64') !== frame.chunk) throw new Error('frame_final_part');
  }
  if (frame.v === 2 && frame.type === 'terminal') {
    const { outcome, bytes, sha256: hash, reason, seq } = frame;
    if (!positiveInt(seq) || !matchesId(frame.threadId) || frame.turnId !== frame.attemptId
        || !['completed', 'interrupted', 'failed', 'unknown'].includes(outcome)
        || (outcome === 'completed' ? (!positiveInt(bytes) || bytes > fullFinalBytes
          || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || reason !== null)
          : (bytes !== 0 || hash !== null || !failureReasons.includes(reason)))) throw new Error('frame_cli_terminal');
  }
  if (frame.v === 1 && frame.type === 'terminal' && (!positiveInt(frame.seq) || !['completed', 'interrupted', 'failed', 'unknown'].includes(frame.outcome)
      || !boundedText(frame.text, finalBytes) || (frame.outcome !== 'completed' && frame.text !== '')
      || !((providerId(frame.threadId) && providerId(frame.turnId))
        || (frame.threadId === null && frame.turnId === null && ['failed', 'unknown'].includes(frame.outcome))))) throw new Error('frame_terminal');
  return frame;
}
