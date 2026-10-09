import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import {
  LlmWriter,
  parseAssessment,
  hasMessagePlaceholders,
} from '../src/llm.ts';
import { describeLlmError } from '../src/llm-error.ts';
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

test('explicit angel headlines qualify as grounded evidence even with another profession', () => {
  for (const source of [
    { ...profile, text: 'Christopher Example\nAngel Investor' },
    { ...profile, text: 'Example Person\nTech PR and Angel Investor' },
    {
      ...profile,
      text: 'Example Person\nEntrepreneur',
      searchRole: 'Founder | Angel Investor',
    },
  ]) {
    assert.equal(
      parseAssessment(
        JSON.stringify({
          decision: 'investor',
          evidence: 'Angel Investor',
          reason: 'Self-attributed angel investing.',
        }),
        source,
      ).decision,
      'investor',
    );
  }
  assert.equal(
    parseAssessment(
      JSON.stringify({
        decision: 'investor',
        evidence: 'Angel Investor',
        reason: 'Unsupported claim.',
      }),
      { ...profile, text: 'Entrepreneur', searchRole: 'Advisor' },
    ).decision,
    'uncertain',
  );
});

test('classification sends the queued headline and labeled section data without duplicating source text', async (t) => {
  let input: { profile: Record<string, unknown> } | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      input = JSON.parse(request.input);
      return new Response(
        JSON.stringify(
          responsesReply(
            JSON.stringify({
              decision: 'investor',
              evidence: 'Angel Investor',
              reason: 'Explicit headline.',
            }),
          ),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
  const candidate = {
    ...profile,
    searchRole: 'Tech PR | Angel Investor',
    sections: {
      header: 'Tech PR | Angel Investor',
      about: '',
      experience: 'Startup investing',
    },
    text: 'HEADER\nTech PR | Angel Investor\n\nEXPERIENCE\nStartup investing',
  };
  const writer = new LlmWriter(
    testConfig('/tmp').llm,
    new AbortController().signal,
  );
  assert.equal((await writer.classify(candidate)).decision, 'investor');
  assert.equal(input?.profile.searchRole, candidate.searchRole);
  assert.equal(input?.profile.text, candidate.text);
  assert.equal(input?.profile.sections, undefined);
});

test('message requests contain configured founder facts, the business pitch, and attributed investment examples', async (t) => {
  for (const api of ['responses', 'chat-completions'] as const) {
    await t.test(api, async (t) => {
      const settings = testConfig('/tmp').llm;
      settings.api = api;
      let sent: Record<string, unknown> | undefined;
      t.mock.method(
        globalThis,
        'fetch',
        async (_url: unknown, init: RequestInit) => {
          const request = JSON.parse(String(init.body));
          sent = JSON.parse(
            api === 'responses' ? request.input : request.messages[1].content,
          );
          const content =
            'Hello Alex, our business helps clinics automate scheduling. Could we discuss our seed round? Sam';
          const reply =
            api === 'responses'
              ? responsesReply(content)
              : {
                  id: 'chat_test',
                  object: 'chat.completion',
                  created: 1,
                  model: 'test-model',
                  choices: [
                    {
                      index: 0,
                      finish_reason: 'stop',
                      message: { role: 'assistant', content },
                    },
                  ],
                };
          return new Response(JSON.stringify(reply), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      );
      const context = {
        founder_name: 'Sam',
        business_name: 'ClinicFlow',
        funding_stage: 'Seed',
        funding_ask: 'Raising EUR 500,000',
        industry: 'Healthcare software',
      };
      const source = {
        ...profile,
        text: 'Angel Investor\nI invested in ClinicTools, which provides software for clinics.',
      };
      const writer = new LlmWriter(settings, new AbortController().signal);
      await writer.write(
        source,
        'We automate scheduling for clinics.',
        context,
      );
      assert.deepEqual(sent?.outreach, context);
      assert.equal(sent?.pitch, 'We automate scheduling for clinics.');
      assert.match(JSON.stringify(sent?.profile), /I invested in ClinicTools/);
    });
  }
});

test('placeholder checks reject unfinished templates while allowing normal punctuation and acronyms', () => {
  for (const value of [
    '[Your Name]',
    '[Company Name]',
    '[Investor Name]',
    '[Funding Amount]',
    '<business_name>',
    '{{founder_name}}',
    'TODO',
    'TBD',
  ]) {
    assert.equal(hasMessagePlaceholders(`Hello Alex, ${value}`), true, value);
  }
  for (const value of [
    'Hello Alex, could we talk? Sam',
    'We develop artificial intelligence [AI] tools.',
    'Our revenue grew 20% < 30%.',
  ]) {
    assert.equal(hasMessagePlaceholders(value), false, value);
  }
});

test('a generated placeholder stops processing rather than being accepted as a finished message', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify(
          responsesReply('Hello Alex, could we discuss funding? [Your Name]'),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const writer = new LlmWriter(
    testConfig('/tmp').llm,
    new AbortController().signal,
  );
  await assert.rejects(
    writer.write(profile, 'Our business pitch'),
    /unresolved placeholders.*Queue row remains working/,
  );
});

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

test('HTTP failures expose provider diagnostics, redact the key, and do not retry', async (t) => {
  const settings = testConfig('/tmp').llm;
  settings.api_key = 'private-secret-test';
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          error: {
            message: 'Invalid API key: private-secret-test',
            type: 'authentication_error',
            code: 'invalid_api_key',
          },
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'x-request-id': 'req_failure',
          },
        },
      ),
  );
  const writer = new LlmWriter(settings, new AbortController().signal);
  await assert.rejects(writer.classify(profile), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /Invalid API key: \[redacted\]/);
    assert.match(error.message, /Provider code: invalid_api_key/);
    assert.match(error.message, /Request ID: req_failure/);
    assert.ok(!error.message.includes('private-secret-test'));
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test('network failures retain nested socket diagnostics and request context', async (t) => {
  const settings = testConfig('/tmp').llm;
  settings.base_url = 'http://192.168.0.2:11434/v1';
  settings.api = 'chat-completions';
  const socket = Object.assign(
    new Error('connect ECONNREFUSED 192.168.0.2:11434'),
    {
      code: 'ECONNREFUSED',
      syscall: 'connect',
      address: '192.168.0.2',
      port: 11434,
    },
  );
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', {
      cause: new AggregateError([socket]),
    });
  });
  const writer = new LlmWriter(settings, new AbortController().signal);
  await assert.rejects(writer.classify(profile), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /classification failed/);
    assert.match(
      error.message,
      /Connection failed before receiving an HTTP response/,
    );
    assert.match(error.message, /192\.168\.0\.2:11434\/v1\/chat\/completions/);
    assert.match(error.message, /code=ECONNREFUSED/);
    assert.match(error.message, /address=192\.168\.0\.2; port=11434/);
    assert.match(error.message, /model: test-model/);
    assert.match(error.message, /Queue row remains working/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test('timeouts and DNS errors have explicit bounded diagnostics without source content', () => {
  const settings = testConfig('/tmp').llm;
  const timeout = describeLlmError(
    new OpenAI.APIConnectionTimeoutError(),
    settings,
    'message generation',
  );
  assert.match(timeout, /Request timed out/);
  assert.match(timeout, new RegExp(`${settings.timeout_ms} ms`));
  const dns = Object.assign(
    new Error('getaddrinfo ENOTFOUND ollama.internal'),
    {
      code: 'ENOTFOUND',
      hostname: 'ollama.internal',
    },
  );
  assert.match(
    describeLlmError(
      new OpenAI.APIConnectionError({ cause: dns }),
      settings,
      'classification',
    ),
    /hostname=ollama.internal/,
  );
  const message = `Bearer secret-token https://user:password@example.com ${settings.api_key} ${profile.text}\u001b\n${'x'.repeat(5000)}`;
  const safe = describeLlmError(
    new Error(message),
    settings,
    'classification',
    [profile.text],
  );
  for (const secret of [
    'secret-token',
    'user:password',
    settings.api_key,
    profile.text,
    '\u001b',
  ]) {
    assert.ok(!safe.includes(secret));
  }
  assert.ok(safe.length < 4000);
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
