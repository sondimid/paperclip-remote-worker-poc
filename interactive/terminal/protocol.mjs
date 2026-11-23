import { aliasPattern, exactKeys, jobIdPattern } from '../../protocol.mjs';

export const version = 'terminal-1';
export const workerPath = '/worker/connect';
export const frameBytes = 4096;
export const maxWorkspaces = 32;
export const maxRequests = 128;
export const receiptMs = 8000;
export const retentionMs = 300_000;
export const providers = ['codex', 'claude'];
export const alias = value => typeof value === 'string' && aliasPattern.test(value);
export const requestId = value => typeof value === 'string' && jobIdPattern.test(value);
export const validToken = value => typeof value === 'string' && /^[\x21-\x7e]{24,256}$/.test(value);
const failureReasons = ['workspace_unavailable', 'provider_unavailable', 'launcher_failed', 'busy'];
const unknownReasons = ['launcher_timeout', 'receipt_timeout', 'worker_disconnected'];
const selectionKeys = ['id', 'provider', 'workspace'];
const selection = value => requestId(value.id) && providers.includes(value.provider) && alias(value.workspace);
const unique = (values, limit, check) => Array.isArray(values) && values.length <= limit && values.every(check)
  && new Set(values).size === values.length;

export const validOpenRequest = value => exactKeys(value, selectionKeys) && selection(value);
export const terminalFrame = (type, fields = {}) => JSON.stringify({ v: version, type, ...fields });

export function decodeJson(raw) {
  if (Buffer.byteLength(raw) > frameBytes) throw new Error('frame_size');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
}

export function parseTerminalFrame(raw, fromWorker) {
  const frame = decodeJson(raw);
  if (frame?.v === version) {
    const keys = (...fields) => exactKeys(frame, ['v', 'type', ...fields]);
    if (fromWorker && frame.type === 'hello' && keys('workerId', 'providers', 'workspaces')
      && alias(frame.workerId) && unique(frame.providers, providers.length, value => providers.includes(value))
      && unique(frame.workspaces, maxWorkspaces, alias)) return frame;
    if (fromWorker && frame.type === 'receipt' && keys('id', 'status', 'reason') && requestId(frame.id)
      && ((frame.status === 'spawned' && frame.reason === null)
        || (frame.status === 'failed' && failureReasons.includes(frame.reason))
        || (frame.status === 'unknown' && frame.reason === 'launcher_timeout'))) return frame;
    if (!fromWorker && frame.type === 'ready' && keys()) return frame;
    if (!fromWorker && frame.type === 'open' && keys(...selectionKeys) && selection(frame)) return frame;
  }
  throw new Error('protocol_rejected');
}

export const sameSelection = (left, right) => left.provider === right.provider && left.workspace === right.workspace;
export const removeExpired = (entries, now) => {
  for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id);
};
export const unknownReceipt = (reason) => {
  if (!unknownReasons.includes(reason)) throw new Error('invalid_receipt');
  return { status: 'unknown', reason };
};
