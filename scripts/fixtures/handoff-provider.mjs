import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

// OpenAI-compatible chat messages may carry a plain string or typed text parts.
function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

const roles = {
  'PUBLIC-H01-PRODUCER': 'producer',
  'PUBLIC-H01-CONSUMER': 'consumer',
  'PUBLIC-H01-HISTORY-CONTROL': 'history',
};

function referenceLines(text) {
  return text.split(/\r?\n/).filter((line) => line.startsWith('Reference:'));
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function reply(res, record, stream, sequence) {
  const assistant = { role: 'assistant', content: record.responseContent };
  const base = { id: `chatcmpl-handoff-${sequence}`, created: 1, model: record.model };
  // Fixed fixture counters satisfy the SDK protocol. They are not measurements.
  const usage = { prompt_tokens: 80, completion_tokens: 16, total_tokens: 96 };
  if (!stream) {
    json(res, 200, {
      ...base,
      object: 'chat.completion',
      choices: [{ index: 0, message: assistant, finish_reason: 'stop' }],
      usage,
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const part of [
    { choices: [{ index: 0, delta: assistant, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
  ]) {
    res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...part })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

export async function startHandoffProvider() {
  const reference = `h01-${randomBytes(16).toString('hex')}`;
  let published = false;
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      json(res, 404, { error: { message: 'Expected POST /v1/chat/completions' } });
      return;
    }
    const record = {
      kind: 'invalid',
      model: '',
      latestUserText: '',
      roles: [],
      assistantContents: [],
      responseContent: '',
      status: 400,
    };
    requests.push(record);
    const sequence = requests.length;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Error('Invalid JSON request');
      }
      if (typeof body?.model !== 'string' || !body.model || !Array.isArray(body.messages))
        throw new Error('Expected a model and messages');
      record.model = body.model;
      record.roles = body.messages.map((message) => message?.role);
      const latest = body.messages.findLastIndex((message) => message?.role === 'user');
      record.assistantContents = body.messages
        .slice(0, latest)
        .filter((message) => message?.role === 'assistant')
        .map(messageText);
      record.latestUserText = messageText(body.messages[latest]);
      const selected = Object.entries(roles).filter(([marker]) =>
        record.latestUserText.includes(marker),
      );
      if (selected.length !== 1)
        throw new Error('Expected exactly one fixture role in the latest user message');
      record.kind = selected[0][1];
      if (record.kind === 'producer') {
        record.responseContent = `Published the public reference.\nReference: ${reference}\nNext: copy the reference into the receipt.`;
        published = true;
      } else {
        let lines = referenceLines(record.latestUserText);
        if (record.kind === 'history') {
          if (lines.length)
            throw new Error('History control requires a latest user message without a reference');
          const previous = record.assistantContents
            .map(referenceLines)
            .findLast((refs) => refs.length > 0);
          lines = previous ?? [];
        }
        if (lines.length !== 1) {
          const source =
            record.kind === 'history' ? 'the prior assistant history' : 'the latest user message';
          throw new Error(`Expected exactly one reference in ${source}`);
        }
        const value = /^Reference: (h01-[0-9a-f]{32})$/.exec(lines[0])?.[1];
        if (!published || value !== reference)
          throw new Error('The handed-off reference does not match the published value');
        record.responseContent = `Received the public reference.\nReference: ${value}\nReceipt: verified.`;
      }
      record.status = 200;
      reply(res, record, body.stream === true, sequence);
    } catch (error) {
      record.status = 400;
      record.responseContent = error.message;
      json(res, 400, { error: { type: 'invalid_request_error', message: record.responseContent } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
