import assert from 'node:assert/strict';
import test from 'node:test';
import { LlmWriter, parseAssessment } from '../src/llm.ts';
import { profile, testConfig } from './helpers.ts';

test('investor classification requires a quoted source excerpt and validates the entire response', () => {
  const supported = parseAssessment(
    JSON.stringify({
      decision: 'investor',
      evidence: 'I invest in early-stage software companies.',
      reason: 'Explicit investment activity.',
    }),
    profile,
  );
  assert.equal(supported.decision, 'investor');
  for (const evidence of ['', 'Partner at an invented fund']) {
    assert.equal(
      parseAssessment(
        JSON.stringify({ decision: 'investor', evidence, reason: 'Claim' }),
        profile,
      ).decision,
      'uncertain',
    );
  }
  for (const text of [
    'not JSON',
    '{"decision":"investor"}',
    '{"decision":"yes","evidence":"VC","reason":"Claim"}',
  ]) {
    assert.throws(
      () => parseAssessment(text, profile),
      /invalid investor assessment/,
    );
  }
});

function responsesReply(text: string, status = 'completed') {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    model: 'test-model',
    status,
    output: [
      {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
  };
}

test('Responses requests include source context, disable storage, and validate generated text', async (t) => {
  const requests: Record<string, unknown>[] = [];
  const replies = [
    JSON.stringify({
      decision: 'investor',
      evidence: 'I invest in early-stage software companies.',
      reason: 'Explicit investing.',
    }),
    'Hello Alex, could we discuss funding our business?',
  ];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify(responsesReply(replies.shift() ?? '')),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  const writer = new LlmWriter(
    testConfig('/tmp').llm,
    new AbortController().signal,
  );
  assert.equal((await writer.classify(profile)).decision, 'investor');
  assert.match(await writer.write(profile, 'Our verified pitch'), /Hello Alex/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.store, false);
  assert.equal(requests[0]?.model, 'test-model');
  assert.match(String(requests[0]?.instructions), /untrusted data/);
  assert.match(String(requests[0]?.input), /early-stage software/);
  assert.match(String(requests[1]?.input), /Our verified pitch/);
  assert.match(String(requests[1]?.input), /alex-example/);
});

test('chat-completions endpoint is available for compatible local providers', async (t) => {
  const settings = testConfig('/tmp').llm;
  settings.api = 'chat-completions';
  settings.structured_output = false;
  let request: Record<string, unknown> | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      request = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'chat_test',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  decision: 'uncertain',
                  evidence: '',
                  reason: 'Limited information.',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
  const writer = new LlmWriter(settings, new AbortController().signal);
  assert.equal((await writer.classify(profile)).decision, 'uncertain');
  assert.ok(Array.isArray(request?.messages));
  assert.equal(request?.response_format, undefined);
});

test('HTTP failures do not retry or expose provider error contents', async (t) => {
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'private-secret-test',
            type: 'authentication_error',
          },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const writer = new LlmWriter(
    testConfig('/tmp').llm,
    new AbortController().signal,
  );
  await assert.rejects(writer.classify(profile), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes('private-secret-test'));
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test('incomplete responses and overlong messages stop processing', async (t) => {
  await t.test('incomplete', async (t) => {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(JSON.stringify(responsesReply('partial', 'incomplete')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const writer = new LlmWriter(
      testConfig('/tmp').llm,
      new AbortController().signal,
    );
    await assert.rejects(writer.classify(profile), /incomplete/);
  });
  await t.test('overlong', async (t) => {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(JSON.stringify(responsesReply('x'.repeat(1_501))), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const writer = new LlmWriter(
      testConfig('/tmp').llm,
      new AbortController().signal,
    );
    await assert.rejects(writer.write(profile, 'Pitch'), /exceeded/);
  });
});
