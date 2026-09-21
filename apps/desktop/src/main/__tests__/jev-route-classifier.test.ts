import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJevRouteClassifier } from '../unified-session/jev-route-classifier.js';
import type { BoundedModelRouteRequest, BoundedModelRouteDecision } from '../unified-session/model-intent-resolver.js';

const request: BoundedModelRouteRequest = {
  text: '帮我接着修登录问题', baseline: 'clarify',
  candidates: [{ id: 'work-0', kind: 'work', project: 'Maka', work: '登录修复' }],
};
const fallbackDecision: BoundedModelRouteDecision = { intent: 'discussion', targetId: null, confidence: 1, evidence: [] };
function response(choice = 'work-0', confidence = 0.95, probabilities = { discussion: 0.02, clarify: 0.03, 'work-0': 0.95 }) {
  return new Response(JSON.stringify({ answers: { route: { type: 'choice', choice, confidence, probabilities } } }));
}

test('disabled or unconfigured Jev never makes a request', async () => {
  for (const settings of [{ enabled: false, apiKey: 'key' }, { enabled: true, apiKey: '' }]) {
    let calls = 0;
    const classify = createJevRouteClassifier({
      getSettings: async () => settings, fallback: async () => { calls++; return fallbackDecision; },
      fetch: async () => { assert.fail('unexpected Jev request'); },
    });
    assert.equal(await classify(request), fallbackDecision);
    assert.equal(calls, 1);
  }
});

test('uses the typed Choice API and maps only supplied targets', async () => {
  const classify = createJevRouteClassifier({
    getSettings: async () => ({ enabled: true, apiKey: 'test-key' }),
    fallback: async () => { assert.fail('unexpected fallback'); },
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'jev-1.13.0');
      assert.deepEqual(body.state, request);
      assert.deepEqual(Object.keys(body.questions.route.criteria), ['discussion', 'clarify', 'work-0']);
      assert.equal(body.reasoning_effort, undefined);
      assert.ok(init?.signal);
      return response();
    },
  });
  assert.deepEqual(await classify(request), {
    intent: 'resume_work', targetId: 'work-0', confidence: 0.95, evidence: ['Jev structured route decision'],
  });
});

test('uncertain discussion and target choices clarify without calling the fallback', async () => {
  for (const choice of ['discussion', 'work-0']) {
    const classify = createJevRouteClassifier({
      getSettings: async () => ({ enabled: true, apiKey: 'key' }),
      fallback: async () => { assert.fail('uncertainty must not become a new model guess'); },
      fetch: async () => response(choice, 0.7, { discussion: 0.5, clarify: 0.1, 'work-0': 0.4 }),
    });
    assert.equal((await classify(request)).intent, 'clarify');
  }
});

test('auth, network, timeout, malformed response and invented targets fall back', async () => {
  const failures: Array<typeof globalThis.fetch> = [
    async () => new Response('secret provider body', { status: 401 }),
    async () => { throw new Error('network'); },
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
    async () => new Response('not json'),
    async () => response('work-invented'),
    async () => response('work-0', 2),
    async () => response('work-0', 0.99, { discussion: 0, clarify: 0, 'work-0': 0.1 }),
  ];
  for (const fetch of failures) {
    let calls = 0;
    const classify = createJevRouteClassifier({
      getSettings: async () => ({ enabled: true, apiKey: 'key' }), fetch,
      fallback: async (input) => { assert.equal(input, request); calls++; return fallbackDecision; },
    });
    assert.equal(await classify(request), fallbackDecision);
    assert.equal(calls, 1);
  }
});

test('settings changes apply without restarting the classifier', async () => {
  const settings = { enabled: true, apiKey: 'key' };
  let calls = 0;
  const classify = createJevRouteClassifier({
    getSettings: async () => settings,
    fetch: async () => { calls++; return response(); },
    fallback: async () => fallbackDecision,
  });
  await classify(request);
  settings.enabled = false;
  assert.equal(await classify(request), fallbackDecision);
  assert.equal(calls, 1);
});
