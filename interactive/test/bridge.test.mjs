import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { runInteractiveIssue } from '../bridge.mjs';

async function fixture(t, mode) {
  const [companyId, agentId, projectId, issueId, runId, commentId, attemptId] = Array.from({ length: 7 }, () => randomUUID());
  const assignment = ['assignment', 'wrong', 'unpromoted'].includes(mode);
  const issue = { id: issueId, companyId, projectId, assigneeAgentId: agentId,
    status: assignment && mode !== 'unpromoted' ? 'todo' : 'backlog' };
  const binding = { projectId, issueId, workspaceId: 'interactive-sample' };
  const contextSnapshot = assignment ? { issueId, wakeReason: 'issue_assigned' }
    : { issueId, wakeReason: 'issue_commented', commentId, wakeCommentId: commentId, wakeCommentIds: mode === 'batch' ? [commentId, randomUUID()] : [commentId] };
  if (mode === 'wrong') contextSnapshot.issueId = randomUUID();
  if (mode === 'repair') contextSnapshot.wakeReason = 'issue_disposition_repair';
  const run = { id: runId, agentId, companyId, invocationSource: assignment ? 'assignment' : 'automation', contextSnapshot };
  const headers = [], submissions = [], writes = [];
  const path = `/api/issues/${issueId}`;
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = parts.length ? JSON.parse(Buffer.concat(parts)) : undefined;
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    headers.push({ url: req.url, method: req.method, run: req.headers['x-paperclip-run-id'], auth: req.headers.authorization });
    if (req.url === `/api/heartbeat-runs/${runId}`) return send(run);
    if (req.url === path && req.method === 'PATCH') {
      writes.push(body);
      if (mode === 'park-rejected') return send({}, 409);
      issue.status = body.status;
      return send(issue);
    }
    if (req.url === path) return send(issue);
    if (req.url === `${path}/checkout`) {
      if (!body.expectedStatuses.includes(issue.status)) return send({}, 409);
      issue.status = 'in_progress';
      return send(issue);
    }
    if (req.url === `${path}/comments/${commentId}`) return send({ id: commentId, issueId,
      authorUserId: mode === 'agent' ? null : 'local-human', authorType: mode === 'agent' ? 'agent' : 'user', body: 'fixture follow-up' });
    if (req.url === `${path}/comments`) {
      writes.push(body);
      if (mode === 'lost') return res.destroy();
      return send({ id: commentId, issueId, authorAgentId: agentId, body: body.body });
    }
    if (req.url === '/runs') { submissions.push(body); return send({ runId, state: 'dispatched' }, 201); }
    if (req.url === `/runs/${runId}/events?after=0`) {
      const ids = { v: 1, runId, attemptId, threadId: 'fixture_thread', turnId: 'fixture_turn' };
      const outcome = mode === 'unknown' ? 'unknown' : 'completed';
      return send({ runId, state: outcome, cursor: 3, events: [
        { ...ids, type: 'event', seq: 1, kind: 'started', text: '' },
        { ...ids, type: 'event', seq: 2, kind: 'delta', text: 'fixture delta' },
        { ...ids, type: 'terminal', seq: 3, outcome, text: outcome === 'completed' ? 'fixture final' : '' },
      ] });
    }
    send({}, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { PAPERCLIP_RUN_ID: runId, PAPERCLIP_COMPANY_ID: companyId, PAPERCLIP_AGENT_ID: agentId,
    PAPERCLIP_API_URL: base, PAPERCLIP_API_KEY: 'fake-paperclip', INTERACTIVE_BROKER_URL: base, INTERACTIVE_BRIDGE_TOKEN: 'fake-bridge' };
  return { run: () => runInteractiveIssue(env, binding), issue, runId, commentId, submissions, writes, headers };
}

test('dispatchOnlyBoundWake', async t => {
  const good = await fixture(t, 'assignment');
  await good.run();
  assert.equal(good.submissions[0].inputRef, 'assignment');
  const wrong = await fixture(t, 'wrong');
  await assert.rejects(wrong.run(), /bound issue/);
  assert.equal(wrong.submissions.length, 0);
  const unpromoted = await fixture(t, 'unpromoted');
  await assert.rejects(unpromoted.run(), /binding or ownership/);
  assert.equal(unpromoted.submissions.length, 0);
  const repair = await fixture(t, 'repair');
  await assert.rejects(repair.run(), /wake is not supported/);
  assert.equal(repair.submissions.length, 0);
  assert.equal(repair.writes.length, 0);
});
test('skipBatchAndUnprovedHumanComment', async t => {
  for (const mode of ['batch', 'agent']) {
    const f = await fixture(t, mode);
    await assert.rejects(f.run(), /comment/i);
    assert.equal(f.submissions.length, 0);
  }
});
test('checkOutParkedIssueThenAuditReplyAndPark', async t => {
  const f = await fixture(t, 'comment');
  await f.run();
  assert.equal(f.submissions[0].inputRef, f.commentId);
  assert.equal(f.submissions[0].input, 'fixture follow-up');
  assert.equal(f.issue.status, 'backlog');
  assert.ok(f.headers.filter(h => h.url.startsWith('/api/') && ['POST', 'PATCH'].includes(h.method)).every(h => h.run === f.runId));
  assert.ok(f.headers.filter(h => h.url.startsWith('/runs')).every(h => !h.run && h.auth === 'Bearer fake-bridge'));
  assert.deepEqual(f.writes, [{ body: `Remote interactive lab | run ${f.runId}\n\nfixture final` }, { status: 'backlog' }]);
});
test('rejectUnknownOrUnconfirmedWrite', async t => {
  const unknown = await fixture(t, 'unknown');
  await assert.rejects(unknown.run(), /No verified completed turn/);
  assert.equal(unknown.writes.length, 0);
  const lost = await fixture(t, 'lost');
  await assert.rejects(lost.run());
  assert.equal(lost.writes.length, 1);
  const rejected = await fixture(t, 'park-rejected');
  await assert.rejects(rejected.run(), /Paperclip PATCH returned HTTP 409/);
  assert.equal(rejected.writes.length, 2);
  assert.equal(rejected.issue.status, 'in_progress');
});
