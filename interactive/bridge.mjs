import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { boundedText, capabilityStates, failureReasons, finalBytes, finalPartBytes, fullFinalBytes, inputBytes, matchesId,
  maxCliFrames, parseWorkerFrame, providers, sha256, verifyCliFinal } from './protocol.mjs';

const assignmentStatuses = new Set(['todo', 'in_progress']);
const followupStatuses = new Set(['backlog', ...assignmentStatuses]);
const runningStatus = new Set(['in_progress']);
const waitingStatus = new Set(['backlog']);
const pending = new Set(['queued', 'dispatched', 'running']);
const assignmentInput = 'Read the lab fixture in the configured workspace and reply with the fixture label. Do not modify files.';

function client(base, key, runId) {
  const origin = new URL(base);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash || !key) throw new Error('Invalid bridge endpoint');
  return async (method, path, body, expectedBytes) => {
    const multipart = body instanceof FormData;
    const response = await fetch(new URL(path, origin), {
      method, redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${key}`, ...(!multipart && { 'Content-Type': 'application/json' }),
        ...(runId ? { 'X-Paperclip-Run-Id': runId } : {}) },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${runId ? 'Paperclip' : 'Broker'} ${method} returned HTTP ${response.status}`);
    if (expectedBytes === undefined) return response.json();
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > expectedBytes) throw new Error('Attachment length mismatch');
      chunks.push(Buffer.from(chunk));
    }
    if (length !== expectedBytes) throw new Error('Attachment length mismatch');
    return Buffer.concat(chunks, length);
  };
}
function exactWakeComment(context) {
  const ids = context.wakeCommentIds;
  if (ids != null && (!Array.isArray(ids) || ids.length !== 1 || !matchesId(ids[0]))) throw new Error('Ambiguous wake comment batch');
  const candidates = [ids?.[0], context.wakeCommentId, context.commentId].filter(value => value != null);
  if (!candidates.length || !candidates.every(id => matchesId(id) && id === candidates[0])) throw new Error('Missing or conflicting wake comment');
  return candidates[0];
}

function splitCliInput(input) {
  if (typeof input !== 'string') return { input };
  const match = /^\s*\/(codex|claude)(?=\s|$)\s*/.exec(input);
  return match ? { provider: match[1], input: input.slice(match[0].length) } : { provider: null, input };
}

async function saveCliReply(api, { path, companyId, agentId, issueId, runId, inputRef, provider, text, verify }) {
  const bytes = Buffer.from(text);
  let attachmentId;
  const header = `Remote interactive lab | ${provider} | run ${runId}\n\n`;
  let body = header + text;
  if (bytes.length > finalBytes || /[\u0000\r]/.test(text)) {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'text/plain' }), 'remote-cli-reply.txt');
    const attachment = await api('POST', `/api/companies/${companyId}/issues/${issueId}/attachments`, form);
    const checksum = sha256(bytes);
    if (!matchesId(attachment.id) || attachment.issueId !== issueId || attachment.companyId !== companyId
        || attachment.createdByAgentId !== agentId || attachment.originatingRunId !== runId
        || attachment.byteSize !== bytes.length || attachment.sha256 !== checksum) throw new Error('Attachment metadata mismatch');
    attachmentId = attachment.id;
    const downloaded = await api('GET', `/api/attachments/${attachmentId}/content`, undefined, bytes.length);
    if (!downloaded.equals(bytes)) throw new Error('Attachment content mismatch');
    body = header + 'Phản hồi đầy đủ nằm trong tệp đính kèm `remote-cli-reply.txt`.';
  }
  verify(await api('GET', path), runningStatus);
  const matches = comment => matchesId(comment?.id) && comment.issueId === issueId
    && comment.authorAgentId === agentId && comment.createdByRunId === runId && comment.body === body;
  let saved;
  try {
    saved = await api('POST', `${path}/comments`, { body, ...(attachmentId && { attachmentIds: [attachmentId] }) });
  } catch {
    // Paperclip chỉ dedup POST comment cho user. Đối soát, tuyệt đối không POST lại.
    const comments = await api('GET', `${path}/comments?after=${inputRef}&order=asc&limit=50`);
    if (!Array.isArray(comments)) throw new Error('Reply reconciliation failed');
    const audited = comments.filter(comment => comment.issueId === issueId && comment.authorAgentId === agentId && comment.createdByRunId === runId);
    if (audited.length !== 1) throw new Error('Reply reconciliation failed');
    [saved] = audited;
  }
  if (!matches(saved)) throw new Error('Paperclip did not confirm the audited comment');
  if (attachmentId) {
    const attachments = await api('GET', `${path}/attachments`);
    if (!Array.isArray(attachments) || !attachments.some(item => item.id === attachmentId && item.issueCommentId === saved.id
        && item.originatingRunId === runId)) throw new Error('Paperclip did not confirm the attachment link');
  }
  return saved;
}

export async function runInteractiveIssue(env, issueBinding) {
  const { issueId, projectId, workspaceId } = issueBinding;
  const version = Number(env.INTERACTIVE_WIRE_VERSION ?? 1);
  if (![1, 2].includes(version)) throw new Error('Invalid wire version');
  const cliMode = version === 2;
  const runId = env.PAPERCLIP_RUN_ID, agentId = env.PAPERCLIP_AGENT_ID, companyId = env.PAPERCLIP_COMPANY_ID;
  if (![runId, agentId, companyId, issueId, projectId].every(matchesId) || workspaceId !== 'interactive-sample') {
    throw new Error('Invalid run binding');
  }
  const api = client(env.PAPERCLIP_API_URL, env.PAPERCLIP_API_KEY, runId);
  const broker = client(env.INTERACTIVE_BROKER_URL, env.INTERACTIVE_BRIDGE_TOKEN);
  const path = `/api/issues/${issueId}`;
  const run = await api('GET', `/api/heartbeat-runs/${runId}`);
  const context = run.contextSnapshot;
  if (run.id !== runId || run.agentId !== agentId || run.companyId !== companyId || context?.issueId !== issueId
      || (context.taskId != null && context.taskId !== issueId) || (env.PAPERCLIP_TASK_ID && env.PAPERCLIP_TASK_ID !== issueId)) {
    throw new Error('Run did not prove bound issue');
  }
  function verify(issue, statuses) {
    if (issue?.id !== issueId || issue.assigneeAgentId !== agentId || issue.companyId !== companyId
        || issue.projectId !== projectId || !statuses.has(issue.status)
        || (cliMode && (issue.conversationAgentId || (issue.executionRunId && issue.executionRunId !== runId)))) {
      throw new Error('Issue binding or ownership changed');
    }
  }
  let inputRef, input, eligibleStatuses, requestedProvider, provider;
  if (run.invocationSource === 'assignment' && context.wakeReason === 'issue_assigned'
      && context.wakeCommentIds == null && context.wakeCommentId == null && context.commentId == null) {
    if (cliMode) {
      verify(await api('GET', path), followupStatuses);
      console.log(JSON.stringify({ event: 'interactive_assignment_ignored', runId, issueId }));
      return;
    }
    eligibleStatuses = assignmentStatuses;
    verify(await api('GET', path), eligibleStatuses);
    inputRef = 'assignment';
    input = assignmentInput;
  } else if (context.wakeReason === 'issue_commented') {
    eligibleStatuses = followupStatuses;
    verify(await api('GET', path), eligibleStatuses);
    inputRef = exactWakeComment(context);
    const comment = await api('GET', `${path}/comments/${inputRef}`);
    if (comment.id !== inputRef || comment.issueId !== issueId || !comment.authorUserId || comment.authorAgentId
        || comment.createdByRunId || comment.runId || comment.authorType !== 'user') throw new Error('Wake comment has no verified human author');
    input = comment.body;
    if (cliMode) {
      if (comment.authorUserId !== env.INTERACTIVE_CHAT_USER_ID) throw new Error('Wake author is not allowed for CLI Chat');
      ({ provider: requestedProvider, input } = splitCliInput(input));
    }
  } else throw new Error('Run wake is not supported');
  if (!boundedText(input, inputBytes) || !input.trim()) throw new Error('Input outside lab bounds');
  if (cliMode) {
    const readiness = await broker('GET', `/readiness?provider=${requestedProvider ?? 'current'}`);
    if (readiness.provider === null) throw new Error('Select /codex or /claude first');
    if (!readiness.online) throw new Error('CLI worker is offline');
    if (readiness.dispatchable !== true) {
      const state = capabilityStates.includes(readiness.capability) ? readiness.capability : 'checking';
      throw new Error(`CLI not dispatchable: ${state === 'ready' ? 'busy_or_disarmed' : state}`);
    }
    provider = readiness.provider;
    if (!providers.includes(provider) || (requestedProvider && provider !== requestedProvider)) throw new Error('Provider mismatch');
  }
  verify(await api('POST', `${path}/checkout`, { agentId, expectedStatuses: [...eligibleStatuses] }), runningStatus);
  const submission = await broker('POST', '/runs', { runId, agentId, companyId, projectId, issueId, workspaceId, inputRef, input,
    ...(cliMode && { provider: requestedProvider }) });
  const conversationId = submission.conversationId;
  if (submission.runId !== runId || !pending.has(submission.state)
      || (cliMode && (submission.provider !== provider || !matchesId(conversationId)))) throw new Error('Broker did not confirm a pending dispatch');
  const deadline = AbortSignal.timeout(150_000);
  let cursor = 0, attemptId, threadId, turnId, terminal, partBytes = 0, finalText;
  const parts = [];
  while (true) {
    deadline.throwIfAborted();
    const page = await broker('GET', `/runs/${runId}/events?after=${cursor}`);
    if (page.runId !== runId || !Array.isArray(page.events) || page.cursor !== cursor + page.events.length
        || (cliMode && (page.provider !== provider || page.conversationId !== conversationId || page.cursor > maxCliFrames))) {
      throw new Error('Broker cursor mismatch');
    }
    for (const raw of page.events) {
      const frame = parseWorkerFrame(JSON.stringify(raw));
      if (frame.v !== version || !['event', 'terminal', ...(cliMode ? ['final_part'] : [])].includes(frame.type)
          || frame.runId !== runId || frame.seq !== ++cursor || (attemptId && frame.attemptId !== attemptId) || terminal
          || (cliMode && (frame.threadId !== conversationId || frame.turnId !== frame.attemptId))) throw new Error('Broker event identity mismatch');
      attemptId ??= frame.attemptId;
      if (frame.type === 'terminal') terminal = frame;
      else if (frame.type === 'final_part') {
        const part = Buffer.from(frame.chunk, 'base64');
        if (!threadId || frame.index !== parts.length || (parts.length && parts.at(-1).length !== finalPartBytes)
            || (partBytes += part.length) > fullFinalBytes) throw new Error('Broker final part mismatch');
        parts.push(part);
      } else if (parts.length) throw new Error('Progress after final part');
      else if (frame.kind === 'started') {
        if (cursor !== 1) throw new Error('Duplicate turn start');
        ({ threadId, turnId } = frame);
        console.log(JSON.stringify({ event: 'interactive_started', runId, threadId, turnId }));
      } else if (frame.threadId === threadId && frame.turnId === turnId) {
        console.log(JSON.stringify({ event: frame.kind === 'gap' ? 'interactive_gap' : 'interactive_delta', text: frame.text }));
      } else throw new Error('Broker turn mismatch');
    }
    if (terminal || !pending.has(page.state)) {
      if (page.state !== 'completed' || terminal?.outcome !== 'completed' || !threadId || !turnId
          || terminal.threadId !== threadId || terminal.turnId !== turnId || (!cliMode && !terminal.text.trim())) {
        const reason = terminal?.reason ?? page.result?.reason;
        if (cliMode && failureReasons.includes(reason)) throw new Error(`CLI turn failed: ${reason}`);
        throw new Error('No verified completed turn');
      }
      finalText = cliMode ? verifyCliFinal(parts, terminal) : terminal.text;
      break;
    }
    await delay(500, undefined, { signal: deadline });
  }
  verify(await api('GET', path), runningStatus);
  let saved;
  if (cliMode) saved = await saveCliReply(api, { path, companyId, agentId, issueId, runId, inputRef, provider, text: finalText, verify });
  else {
    const body = `Remote interactive lab | run ${runId}\n\n${finalText}`;
    // Không tự retry POST nếu phản hồi bị mất: release này không dedup clientRequestId cho agent.
    saved = await api('POST', `${path}/comments`, { body });
    if (!matchesId(saved.id) || saved.issueId !== issueId || saved.authorAgentId !== agentId || saved.body !== body) {
      throw new Error('Paperclip did not confirm the result comment');
    }
  }
  // Park this completed lab turn before exit; in_progress implies unfinished work to legacy recovery.
  verify(await api('GET', path), runningStatus);
  verify(await api('PATCH', path, { status: 'backlog' }), waitingStatus);
  console.log(JSON.stringify({ event: 'interactive_complete', runId, issueId, commentId: saved.id }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runInteractiveIssue(process.env, { projectId: process.argv[2], issueId: process.argv[3], workspaceId: 'interactive-sample' });
  } catch (error) {
    const safe = /^(?:(?:Paperclip|Broker) (?:GET|POST|PATCH) returned HTTP \d{3}|Select \/codex or \/claude first|CLI worker is offline|CLI (?:not dispatchable|turn failed): [a-z_]+)$/.test(error.message)
      ? error.message : 'context, transport, or result was not confirmed';
    console.error(`Interactive bridge failed: ${safe}`);
    process.exitCode = 1;
  }
}
