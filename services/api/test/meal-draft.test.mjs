import test from 'node:test';
import assert from 'node:assert/strict';
import { explicitPortion, mealDraft } from '../src/meal-draft.mjs';

test('explicit whole-meal proportions can produce drafts with the original note', () => {
  for (const [text, fraction] of [
    ['一半，汤没喝', 0.5], ['这餐我只吃了一半。', 0.5], ['我吃了约一半', 0.5], ['50%', 0.5],
    ['我吃了四分之一，剩下留着', 0.25], ['1/4', 0.25], ['全部', 1], ['我都吃完了', 1],
    ['这餐没有吃', 0], ['一口也没吃', 0],
  ]) assert.equal(explicitPortion(text), fraction, text);
  const meal = { id: 'meal-test', version: 3, confirmedAt: null };
  assert.deepEqual(mealDraft(meal, '一半，汤没喝'), {
    mealId: 'meal-test', expectedVersion: 3, portionFraction: 0.5, note: '一半，汤没喝',
  });
  assert.equal(mealDraft({ ...meal, confirmedAt: '2026-10-15T01:00:00Z' }, '一半'), null);
});

test('questions, plans, negations, other people and ingredient-level portions are not inferred', () => {
  for (const text of [
    '我想只吃一半', '如果吃一半', '我可能吃了一半', '是不是一半', '我没吃一半',
    '一半？', '一半可以吗', '不是一半', '一半，其实没有吃', '一半，另一半也吃了',
    '一半，米饭吃完了', '饭一半，菜吃完了', '我只喝了汤', '他吃了一半',
    '我没有吃一半，我全吃了', '我吃了一半，但是想再吃一点', '一半，计划留到明天',
    '全部，都是朋友吃的', '全部，汤没喝', '全部，还剩几口', '没有吃，但是喝了汤', '一半，记错了',
  ]) assert.equal(explicitPortion(text), null, text);
});
