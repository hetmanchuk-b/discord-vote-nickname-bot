const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MessageFlags, ComponentType } = require('discord.js');
const { normalizeMovieReview } = require('../dist/movies/review-store.js');
const { renderMovieReviewForm, renderMovieReviewPage, parseMovieReviewAction, parseMovieReviewSubmit } = require('../dist/movies/review-render.js');
const interactionCreate = require('../dist/events/interaction-create.js').default;
const id = '11111111-2222-4333-8444-555555555555';
const context = { postId: id, guildId: '700000000000000001', channelId: '700000000000000002', messageId: '700000000000000003', userId: '700000000000000004' };
const version = '900000000000000001';
const editor = { text: 'An existing review.', containsSpoilers: true, version };
const data = { title: 'Movie', imdbId: 'tt3896198', page: 0, count: 2, revealed: false,
  review: { userId: context.userId, text: 'SECRET || @everyone [click](https://example.com)', containsSpoilers: true, version, score: 8, updatedAt: new Date('2026-11-01T12:00:00Z') } };
function button(action = `movie:review:write:${id}`, ephemeral = false) {
  const calls = []; const interaction = { ...context, customId: action, id: '900000000000000002', user: { id: context.userId, bot: false },
    message: { id: context.messageId, flags: { has: value => ephemeral && value === MessageFlags.Ephemeral } },
    isChatInputCommand: () => false, isButton: () => true,
    client: { movies: { reviewEditor: async () => editor, reviewPage: async () => data, writeReview: async () => 'saved' } },
    showModal: async value => calls.push(['modal', value.toJSON()]), reply: async value => calls.push(['reply', value]), followUp: async value => calls.push(['follow', value]),
    deferReply: async value => calls.push(['defer', value]), deferUpdate: async () => calls.push(['deferUpdate']), editReply: async value => calls.push(['edit', value]), calls };
  return interaction;
}
test('review text is trimmed, plain text bounded, and blanks/null bytes rejected', () => {
  assert.equal(normalizeMovieReview('  Worth watching!\n '), 'Worth watching!');
  assert.equal(normalizeMovieReview('x'.repeat(1000)).length, 1000);
  for (const value of ['', '  \n\t', 'x'.repeat(1001), 'a\0b', null]) assert.throws(() => normalizeMovieReview(value), error => error.code === 'invalid-review');
});
test('review forms prefill text/spoilers and expose an explicit unchecked delete option only for an existing review', () => {
  const form = renderMovieReviewForm(context, editor).toJSON();
  assert.ok(form.custom_id.length <= 100); assert.deepEqual(parseMovieReviewSubmit(form.custom_id), { postId: id, messageId: context.messageId, baseVersion: version });
  assert.equal(form.components.length, 3);
  assert.equal(form.components[0].component.type, ComponentType.TextInput);
  assert.equal(form.components[0].component.value, editor.text); assert.equal(form.components[0].component.max_length, 1000);
  assert.equal(form.components[0].component.required, false);
  assert.equal(form.components[1].component.type, ComponentType.Checkbox); assert.equal(form.components[1].component.default, true);
  assert.equal(form.components[2].component.custom_id, 'delete'); assert.equal(form.components[2].component.default, false);
  assert.match(form.components[0].description, /видимі учасникам сервера/);
  const blank = renderMovieReviewForm(context, { text: null, containsSpoilers: false, version: '0' }).toJSON();
  assert.equal(blank.components.length, 2); assert.equal(blank.components[0].component.value, undefined);
});
test('review protocols validate UUIDs, source message bindings, versions, and bounded page numbers', () => {
  assert.deepEqual(parseMovieReviewAction(`movie:review:read:${id}`), { action: 'read', postId: id });
  assert.deepEqual(parseMovieReviewAction(`movie:review:page:${id}:${context.messageId}:2`), { action: 'page', postId: id, messageId: context.messageId, page: 2 });
  for (const value of [`movie:review:show:${id}:${context.messageId}:2`, `movie:review:page:${id}:${context.messageId}:1000001`, `movie:review:page:${id}:${context.messageId}:-1`, `movie:review:edit:${id}:${context.messageId}:2`, 'movie:review:read:no-uuid']) assert.equal(parseMovieReviewAction(value), null);
  for (const value of [`movie:review:save:${id}:bad:0`, `movie:review:save:${id}:${context.messageId}:-1`]) assert.equal(parseMovieReviewSubmit(value), null);
});
test('private review pages never include hidden spoiler text and reveal consent binds the exact review version', () => {
  const payload = renderMovieReviewPage(context, data);
  assert.doesNotMatch(JSON.stringify(payload), /SECRET|@everyone|example\.com/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  const buttons = payload.components.flatMap(row => row.toJSON().components);
  const reveal = buttons.find(value => value.label === 'Показати спойлери');
  assert.deepEqual(parseMovieReviewAction(reveal.custom_id), { action: 'show', postId: id, messageId: context.messageId, version });
  assert.ok(buttons.every(value => value.custom_id.length <= 100));
  const shown = renderMovieReviewPage(context, { ...data, revealed: true });
  assert.match(shown.embeds[0].toJSON().description, /SECRET/);
  assert.ok(shown.embeds[0].toJSON().description.includes('\\[click]')); // Masked links cannot disguise their destination.
  assert.ok(!shown.components.flatMap(row => row.toJSON().components).some(value => value.label === 'Показати спойлери'));
});
test('empty review lists and unrated reviewers are supported independently of numeric ratings', () => {
  const empty = renderMovieReviewPage(context, { ...data, review: null, count: 0 });
  assert.match(empty.embeds[0].toJSON().description, /ще немає/); assert.equal(empty.components.length, 1);
  const unrated = renderMovieReviewPage(context, { ...data, review: { ...data.review, score: null, containsSpoilers: false } });
  assert.equal(unrated.embeds[0].toJSON().fields[1].value, 'Без оцінки');
});
test('public write button opens the existing review modal, without deferring or posting review text publicly', async () => {
  const interaction = button(); let input;
  interaction.client.movies.reviewEditor = async value => { input = value; return editor; };
  await interactionCreate.execute(interaction);
  assert.deepEqual(input, context); assert.deepEqual(interaction.calls.map(value => value[0]), ['modal']);
});
test('slow editor reads time out before the modal acknowledgement deadline and never open a late form', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const interaction = button(); let release;
  interaction.client.movies.reviewEditor = () => new Promise(resolve => { release = resolve; });
  const operation = interactionCreate.execute(interaction);
  t.mock.timers.tick(1800); await operation;
  assert.deepEqual(interaction.calls.map(value => value[0]), ['reply']);
  assert.equal(interaction.calls[0][1].flags, MessageFlags.Ephemeral);
  release(editor); await Promise.resolve();
  assert.equal(interaction.calls.some(value => value[0] === 'modal'), false);
});
test('read buttons reply privately; pagination/reveal only edit already-ephemeral messages', async () => {
  const read = button(`movie:review:read:${id}`); await interactionCreate.execute(read);
  assert.equal(read.calls[0][0], 'defer'); assert.equal(read.calls[0][1].flags, MessageFlags.Ephemeral);
  assert.equal(read.calls[1][0], 'edit');
  const page = button(`movie:review:page:${id}:${context.messageId}:1`, true); page.message.id = '800000000000000001'; let input;
  page.client.movies.reviewPage = async (value, index) => { input = { value, index }; return data; };
  await interactionCreate.execute(page); assert.equal(page.calls[0][0], 'deferUpdate'); assert.deepEqual(input, { value: context, index: 1 });
  const publicForgery = button(page.customId, false); let readCalled = false;
  publicForgery.client.movies.reviewPage = async () => { readCalled = true; return data; };
  await interactionCreate.execute(publicForgery); assert.equal(readCalled, false); assert.equal(publicForgery.calls[0][1].flags, MessageFlags.Ephemeral);
});
test('modal submissions always write as the current user, preserve base version, and privately confirm deletion', async () => {
  const interaction = button(); let input;
  Object.assign(interaction, { customId: `movie:review:save:${id}:${context.messageId}:${version}`,
    isButton: () => false, isModalSubmit: () => true,
    fields: { getTextInputValue: () => 'Review', getCheckbox: field => field === 'delete', fields: new Map([['delete', true]]) } });
  interaction.client.movies.writeReview = async value => { input = value; return 'deleted'; };
  await interactionCreate.execute(interaction);
  assert.deepEqual(input, { ...context, interactionId: interaction.id, baseVersion: version, text: 'Review', containsSpoilers: false, delete: true });
  assert.equal(interaction.calls[0][1].flags, MessageFlags.Ephemeral); assert.match(interaction.calls[1][1].content, /видалено.*не змінено/);
});
test('review handlers reject bots/DMs, ignore unrelated modals, and sanitize driver/SDK failures', async () => {
  for (const change of [{ guildId: null }, { user: { id: context.userId, bot: true } }]) {
    const interaction = Object.assign(button(), change); let called = false;
    interaction.client.movies.reviewEditor = async () => { called = true; return editor; };
    await interactionCreate.execute(interaction); assert.equal(called, false);
  }
  const failed = button(); failed.client.movies.reviewEditor = async () => { throw new Error('private DATABASE_URL and secret'); };
  await interactionCreate.execute(failed); assert.doesNotMatch(JSON.stringify(failed.calls), /DATABASE_URL|secret/);
  const other = button('other-modal'); other.isButton = () => false; other.isModalSubmit = () => true;
  await interactionCreate.execute(other); assert.equal(other.calls.length, 0);
});
