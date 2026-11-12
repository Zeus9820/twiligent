import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAiMetadata } from '../../lib/aiMetadata.ts';
const json = '{"title":"Gaming clip","description":"A gameplay moment","summary":"A scene"}';
test('reads legacy and chat completion responses', () => {
    assert.equal(parseAiMetadata({ response: json }).title, 'Gaming clip');
    assert.equal(parseAiMetadata({ choices: [{ message: { content: json } }] }).description, 'A gameplay moment');
});
test('handles reasoning, fences and text content blocks', () => {
    assert.equal(parseAiMetadata({ response: '<think>analysis</think>```json\n' + json + '\n```' }).title, 'Gaming clip');
    assert.equal(parseAiMetadata({ choices: [{ message: { content: [{ type: 'text', text: json }] } }] }).summary, 'A scene');
});
test('rejects truncation, empty and invalid metadata', () => {
    for (const result of [null, { response: 'not json' }, { response: 'null' }, { response: '{"title":"","description":"x"}' }, { choices: [{ finish_reason: 'length', message: { content: '{"title":' } }] }]) assert.throws(() => parseAiMetadata(result));
});

test('accepts complete validated metadata despite token-limit finish flag', () => {
    assert.equal(parseAiMetadata({ choices: [{ finish_reason: 'length', message: { content: json } }] }).title, 'Gaming clip');
});
