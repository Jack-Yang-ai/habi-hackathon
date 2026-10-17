import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProvider } from '../src/provider.mjs';

// Synthetic bytes and model output only: never a real meal or a paid network call.
const image = Buffer.from('synthetic-image-fixture');
const estimate = { foodDetected: true, title: '测试夹具', foods: [{ name: '测试食物', estimatedGrams: null }], calorieRange: { min: 100, max: 200 }, uncertainties: ['测试估算区间，并非实测热量'] };
function response(content = JSON.stringify(estimate)) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

test('health-agent StepFun aliases select the exact vision model and official Chat Completions API', async () => {
  let request;
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    return response();
  });
  assert.equal(provider.visionConfigured, true);
  assert.equal(provider.visionModel, 'step-1o-turbo-vision');
  assert.equal(provider.chatModel, 'step-5-preview');
  assert.deepEqual(await provider.analyze(image, 'image/jpeg'), { ...estimate, imageQuality: 'unknown', macros: null });
  assert.equal(request.url, 'https://api.stepfun.com/v1/chat/completions');
  assert.equal(request.body.model, 'step-1o-turbo-vision');
  assert.equal(request.body.max_tokens, 4096);
  assert.equal(request.body.temperature, 0.2);
  assert.equal('reasoning_effort' in request.body, false);
  assert.match(request.body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('full legacy vision endpoint is normalized once and explicit model overrides are respected', async () => {
  let endpoint;
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only', STEPFUN_VISION_URL: 'https://api.stepfun.com/v1/chat/completions/', HEALTH_AGENT_FOOD_VISION_MODEL: 'step-1v-32k' }, async url => { endpoint = url; return response(); });
  await provider.analyze(image, 'image/png');
  assert.equal(endpoint, 'https://api.stepfun.com/v1/chat/completions');
  assert.equal(provider.visionModel, 'step-1v-32k');
});

test('an ambient StepFun key is not inherited by an unrelated gateway', () => {
  const provider = new ModelProvider({ FOOD_MODEL_BASE_URL: 'https://gateway.invalid/v1', FOOD_MODEL_NAME: 'custom', STEPFUN_API_KEY: 'synthetic-test-only' });
  assert.equal(provider.visionConfigured, false);
  assert.equal(provider.apiKey, '');
});

test('explicit compatible-provider configuration continues to take precedence', () => {
  const provider = new ModelProvider({ FOOD_MODEL_BASE_URL: 'https://custom.invalid/v1', FOOD_MODEL_API_KEY: 'custom-test-only', FOOD_MODEL_NAME: 'fixture', STEPFUN_API_KEY: 'step-test-only' });
  assert.equal(provider.visionConfigured, true);
  assert.equal(provider.visionModel, 'fixture');
  assert.equal(provider.apiKey, 'custom-test-only');
  assert.equal(provider.stepVision, false);
  // A custom gateway must opt into chat explicitly; it must not inherit Step 5 Preview.
  assert.equal(provider.chatConfigured, false);
});

test('companion chat defaults to step-5-preview without changing the vision model', async () => {
  let body;
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async (_url, init) => {
    body = JSON.parse(init.body); return response('我在这里。');
  });
  assert.equal(provider.chatConfigured, true);
  assert.equal(await provider.chat('你好', [], {}), '我在这里。');
  assert.equal(body.model, 'step-5-preview');
  assert.equal(body.max_tokens, 1200);
  assert.equal(provider.visionModel, 'step-1o-turbo-vision');
});

test('same-meal images and a user note are passed together without assuming actual intake', async () => {
  let body;
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async (_url, init) => { body = JSON.parse(init.body); return response(); });
  await provider.analyze(image, 'image/jpeg', { images: [{ buffer: image, mime: 'image/png' }], note: '这是同一盘菜，换了角度' });
  assert.equal(body.messages[1].content.filter(part => part.type === 'image_url').length, 2);
  assert.match(body.messages[0].content, /不得把同一盘食物重复累计/);
  assert.match(body.messages[1].content[0].text, /同一盘菜/);
  assert.match(body.messages[0].content, /不判断属于谁或用户实际吃了多少/);
});

test('a legacy point estimate is rejected rather than invented into a calorie interval', async () => {
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async () => response(JSON.stringify({ status: 'success', name: '测试食物', total_colorie: '310kcal', ingredients: {} })));
  await assert.rejects(provider.analyze(image, 'image/png'), /有效的结构化估算/);
});

test('non-JSON upstream responses become bounded service errors', async () => {
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async () => new Response('not JSON', { status: 200 }));
  await assert.rejects(provider.analyze(image, 'image/jpeg'), error => error.statusCode === 502 && /原始记录已保留/.test(error.message));
});

test('no-food output cannot attach a hallucinated food list or calorie range', async () => {
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async () => response(JSON.stringify({ ...estimate, foodDetected: false })));
  const result = await provider.analyze(image, 'image/jpeg');
  assert.deepEqual(result.foods, []);
  assert.equal(result.calorieRange, null);
});

test('a real Step no-food response can contain an empty uncertainty list', async () => {
  const noFood = { foodDetected: false, imageQuality: 'clear', title: '无食物检测到',
    foods: [], calorieRange: null, macros: null, uncertainties: [] };
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' },
    async () => response('```json\n' + JSON.stringify(noFood) + '\n```'));
  assert.deepEqual(await provider.analyze(image, 'image/png'), noFood);
});

test('whole-plate macros are parsed when present, dropped when malformed, and cleared without food', async () => {
  const macros = { proteinG: 22, carbsG: 60, fatG: 14 };
  const ok = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async () => response(JSON.stringify({ ...estimate, macros })));
  assert.deepEqual((await ok.analyze(image, 'image/jpeg')).macros, macros);
  const bad = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async () => response(JSON.stringify({ ...estimate, macros: { proteinG: '很多' } })));
  const parsed = await bad.analyze(image, 'image/jpeg');
  assert.equal(parsed.macros, null);
  assert.deepEqual(parsed.calorieRange, estimate.calorieRange);
  const none = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async () => response(JSON.stringify({ ...estimate, foodDetected: false, macros })));
  assert.equal((await none.analyze(image, 'image/jpeg')).macros, null);
});

test('the vision prompt requires whole-plate macros whenever food is recognized', async () => {
  const macros = { proteinG: 1, carbsG: 12, fatG: 0 };
  let prompt;
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' }, async (_url, init) => {
    prompt = JSON.parse(init.body).messages[0].content;
    return response(JSON.stringify({ ...estimate, macros }));
  });
  assert.deepEqual((await provider.analyze(image, 'image/jpeg')).macros, macros);
  // The model used to answer macros:null for plain foods because the prompt offered an unconditional
  // null. A recognized food now has to carry three numbers; null stays reserved for unrecognizable food.
  assert.match(prompt, /只要识别出食物就必须给出三个数字/);
  assert.match(prompt, /只有完全无法辨认食物成分时才为null/);
  assert.match(prompt, /没有食物时foodDetected=false、foods=\[\]、calorieRange=null、macros=null/);
});

test('a food calorie estimate still needs a meaningful uncertainty statement', async () => {
  for (const uncertainties of [[], ['  ']]) {
    const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only' },
      async () => response(JSON.stringify({ ...estimate, uncertainties })));
    await assert.rejects(provider.analyze(image, 'image/png'), /有效的结构化估算/);
  }
});

test('chat prompt distinguishes meal text from photo pixels and requires explicit confirmation', async () => {
  let body;
  const provider = new ModelProvider({ STEPFUN_API_KEY: 'synthetic-test-only', CHAT_MODEL_NAME: 'fixture-chat' }, async (_url, init) => {
    body = JSON.parse(init.body); return response('请确认这餐的补充。');
  });
  await provider.chat('汤没喝', [], { selectedMeal: { id: 'meal-fixture', foods: [] } });
  assert.equal(body.model, 'fixture-chat');
  assert.match(body.messages[0].content, /用户还需要在界面明确确认/);
  assert.match(body.messages[0].content, /不包含照片像素/);
  assert.match(body.messages[0].content, /不能据此计算整餐比例/);
  assert.equal(body.messages.at(-1).content, '汤没喝');
});
