const assert = require('node:assert/strict');
const { test } = require('node:test');
const yok = require('../dist/commands/yok/yok.js').default;

for (const [random, percent, filled] of [[0, 0, 0], [0.5, 50, 10], [0.999, 100, 20]]) {
  test(`/yok displays a matching ASCII bar for ${percent}%`, async t => {
    t.mock.method(Math, 'random', () => random);
    let response;
    await yok.execute({
      user: '<@caller>',
      options: {
        getUser: () => null,
        getString: () => 'крутий',
      },
      reply: async payload => { response = payload; },
    });
    const bar = `[${'#'.repeat(filled)}${'-'.repeat(20 - filled)}]`;
    assert.equal(response.content, `<@caller> **крутий** на **${percent}%**\n\`${bar}\``);
  });
}

test('/yok uses the selected user when provided', async t => {
  t.mock.method(Math, 'random', () => 0.5);
  let response;
  await yok.execute({
    user: '<@caller>',
    options: {
      getUser: () => '<@target>',
      getString: () => 'крутий',
    },
    reply: async payload => { response = payload; },
  });
  assert.match(response.content, /^<@target>/);
});
