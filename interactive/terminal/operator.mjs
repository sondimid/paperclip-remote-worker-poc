import { randomUUID } from 'node:crypto';
import { brokerClient, BrokerError } from '../../protocol.mjs';
import { alias, providers, requestId, validToken } from './protocol.mjs';

async function main([action, ...args], env) {
  const list = action === 'list' && args.length === 0;
  const open = action === 'open' && args.length === 2 && providers.includes(args[0]) && alias(args[1]);
  const status = action === 'status' && args.length === 1 && requestId(args[0]);
  if (!list && !open && !status) {
    console.error('Usage: list | open <codex|claude> <workspace-alias> | status <request-uuid>');
    return 1;
  }
  const { TERMINAL_OPERATOR_URL: url = 'http://127.0.0.1:3116/', TERMINAL_OPERATOR_TOKEN: token } = env;
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !validToken(token)) {
    throw new Error('invalid_local_operator_config');
  }
  const client = brokerClient(endpoint, token);
  const id = open ? randomUUID() : args[0];
  const showStatus = () => console.error(`Check with: status ${id} (do not open again until checked)`);
  if (open) console.log(`Request ID: ${id}`);
  try {
    const result = list ? await client('/terminal/worker') : status ? await client(`/terminal/open/${id}`)
      : await client('/terminal/open', { id, provider: args[0], workspace: args[1] });
    console.log(JSON.stringify(result, null, 2));
    if (open && result.status === 'pending') showStatus();
    return ['failed', 'unknown'].includes(result.status) ? 1 : 0;
  } catch (error) {
    console.error(error instanceof BrokerError ? error.message : 'No usable response from Terminal Broker');
    if (open && !(error instanceof BrokerError)) showStatus();
    return 1;
  }
}

try { process.exitCode = await main(process.argv.slice(2), process.env); }
catch { console.error('Invalid terminal operator configuration'); process.exitCode = 1; }
