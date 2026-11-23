import { readFile } from 'node:fs/promises';
import { runInteractiveWorker } from '../../worker.mjs';

const caFile = process.env.INTERACTIVE_WORKER_CA_FILE;

const abort = new AbortController();
process.once('disconnect', () => abort.abort());
let turns = 0;
const threadId = 'wss_fixture_thread';
const cliFixture = process.env.INTERACTIVE_WIRE_VERSION === '2' ? {
  cliProfiles: {},
  adapters: {
    codex: {
      async probe() { return { state: 'ready' }; },
      async runTurn(_profile, { input, sessionId, onProgress }) {
        onProgress('working');
        return { outcome: 'completed', sessionId: threadId, text: `${sessionId ? 'resumed' : 'new'}: ${input}` };
      },
    },
    claude: { async probe() { return { state: 'unsupported' }; } },
  },
} : {};
await runInteractiveWorker({
  ...cliFixture,
  brokerUrl: process.env.INTERACTIVE_WORKER_URL,
  workerToken: process.env.INTERACTIVE_WORKER_TOKEN,
  tlsCa: caFile ? await readFile(caFile, 'utf8') : undefined,
  workspaceProfile: JSON.parse(process.env.INTERACTIVE_WORKSPACE_PROFILE),
  signal: abort.signal,
  openSession: async ({ onEvent }) => ({
    threadId,
    async startTurn({ text }) {
      const turnId = `turn_${++turns}`;
      onEvent({ kind: 'delta', threadId, turnId, text: 'working' });
      onEvent({ kind: 'terminal', threadId, turnId, outcome: 'completed', text });
      return { turnId };
    },
    async close() {},
  }),
});
