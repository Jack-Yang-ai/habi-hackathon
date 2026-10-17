/** Synthetic utterances only; never writes signals or meals to the App database. */
import { ContextTrigger, triggerPlan } from '../../services/api/src/trigger.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const trigger = new ContextTrigger({ JEV_URL: process.env.JEV_URL || 'http://127.0.0.1:8149' });
const cases = [
  { text: '我要去吃饭了', expected: 'capture_window' },
  { text: '你要不要吃？', expected: 'capture_window' },
  { text: '好啊，走吧', recentUtterances: ['你要不要一起吃午饭？'], expected: 'capture_window' },
  { text: '我正在吃午饭', expected: 'capture_window' },
  { text: '明天我们去吃火锅吧', expected: 'ignore' },
  { text: '我刚吃完饭', expected: 'cancel' },
  { text: '我要去吃饭了', speaker: 'unknown', sourceContext: 'unknown', expected: 'capture_window' },
  { text: '主播说我要去吃饭了', speaker: 'unknown', sourceContext: 'media', expected: 'ignore' },
  { text: '我不想吃了', expected: 'cancel' },
  { text: '今天天气不错', expected: 'defer' },
];
const reports = [];
for (let i = 0; i < cases.length; i++) {
  const { expected, ...fixture } = cases[i];
  const input = { signalId: `synthetic-${i}`, speaker: 'self', sourceContext: 'user-conversation',
    observedAt: new Date().toISOString(), ...fixture };
  const start = performance.now();
  const classification = await trigger.classify(input);
  const plan = triggerPlan(classification, input, { paused: false }, new Date());
  reports.push({ fixture: input.text, expected, classification, plan,
    elapsedMs: Math.round(performance.now() - start), passed: plan.action === expected });
}
await mkdir('output/validation', { recursive: true });
await writeFile('output/validation/jev-context.json', JSON.stringify({ checkedAt: new Date().toISOString(),
  fixtureOnly: true, device: 'Mac CPU, 2 threads', domainAccuracyValidated: false, reports }, null, 2));
console.log(JSON.stringify({ cases: reports.length, routingPassed: reports.filter(item => item.passed).length,
  modelAdvisoryOnly: true, modelTimingsMs: reports.filter(item => item.classification.modelAssessment)
    .map(item => item.classification.modelAssessment.wallMs) }));
if (reports.some(item => !item.passed)) process.exitCode = 1;
