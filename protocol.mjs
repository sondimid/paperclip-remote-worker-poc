export const workspaceId = 'canary';
export const operation = 'read-fixture';
export const jobIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const aliasPattern = /^[a-zA-Z0-9_-]{1,40}$/;
export const hashPattern = /^[0-9a-f]{64}$/;

export function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

export class BrokerError extends Error {
  constructor(status) {
    super(`Broker returned HTTP ${status}`);
    this.status = status;
  }
}

export function brokerClient(url, token, fetchImpl = fetch) {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
      || base.pathname !== '/' || base.search || base.hash || !token) {
    throw new Error('Invalid broker configuration');
  }
  return async (path, body, signal) => {
    const deadline = AbortSignal.timeout(4_000);
    const response = await fetchImpl(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok) throw new BrokerError(response.status);
    return response.json();
  };
}
