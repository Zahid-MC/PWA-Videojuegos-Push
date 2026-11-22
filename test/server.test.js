import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createCatalog } from '../src/catalog.js';
import { createJobs } from '../src/jobs.js';
import { createNotifier } from '../src/notifier.js';
import { createStore } from '../src/store.js';

let games, store, jobs, sent, sendError, server, base, app;

const raw = (id, genre) => ({ id, title: `Juego ${id}`, genre, thumbnail: 'https://t/x.jpg' });
const sub = (name) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${name}`,
  keys: { p256dh: 'p', auth: 'a' },
});
const post = (path, body, token) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
const join = (name, preferences) =>
  post('/subscribe', { subscription: sub(name), silent: true, preferences });
const inOneMinute = () => new Date(Date.now() + 60_000).toISOString();

before(async () => {
  server = createServer((req, res) => app(req, res));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());
beforeEach(() => {
  games = [raw(1, 'Shooter'), raw(2, ' MMORPG')];
  sent = [];
  sendError = null;
  store = createStore(null);
  const catalog = createCatalog(async () => ({ ok: true, json: async () => games }));
  const send = async (subscription, payload) => {
    if (sendError) throw sendError;
    sent.push({
      to: subscription.endpoint.split('/').at(-1),
      ...JSON.parse(payload).notification,
    });
  };
  const notifier = createNotifier({ store, send, retryDelays: [1, 1] });
  jobs = createJobs({ store, catalog, notifier });
  const config = { adminToken: 'secreto', allowedOrigins: ['https://app.test'] };
  app = createApp({ store, catalog, notifier, jobs, config });
});

test('suscribirse da la bienvenida una sola vez', async () => {
  assert.equal((await post('/subscribe', { subscription: sub('a') })).status, 201);
  assert.equal((await post('/subscribe', { subscription: sub('a') })).status, 200);
  assert.deepEqual(
    sent.map((item) => item.title),
    ['Avisos activados'],
  );
});

test('volver a registrarse en silencio no envía nada', async () => {
  await join('a');
  assert.equal(store.count(), 1);
  assert.equal(sent.length, 0);
});

test('rechaza endpoints que no son servicios push', async () => {
  const bad = [
    'http://fcm.googleapis.com/x',
    'https://localhost/x',
    'https://evil.com/fcm.googleapis.com',
    'https://fcm.googleapis.com.evil.com/x',
    'nada',
  ];
  for (const endpoint of bad) {
    const response = await post('/subscribe', { subscription: { ...sub('a'), endpoint } });
    assert.equal(response.status, 400, endpoint);
  }
  assert.equal(store.count(), 0);
});

test('/push y los trabajos exigen el token', async () => {
  for (const path of ['/push', '/jobs/run', '/jobs/new-game', '/jobs/weekly']) {
    assert.equal((await post(path, {})).status, 401, path);
    assert.equal((await post(path, {}, 'malo')).status, 401, path);
  }
});

test('/push llega a todos y solo admite rutas internas', async () => {
  await join('a');
  await join('b');
  const ok = await post('/push', { title: 'Hola', body: 'Mundo', url: '/juego/1' }, 'secreto');
  assert.deepEqual(await ok.json(), { enviadas: 2 });
  for (const url of ['https://evil.com', '//evil.com', 'javascript:x']) {
    const response = await post('/push', { title: 'a', body: 'b', url }, 'secreto');
    assert.equal(response.status, 400, url);
  }
});

test('un juego nuevo solo avisa a quien sigue su género', async () => {
  await join('todos');
  await join('mmo', { genres: ['MMORPG'] });
  await join('tiros', { genres: ['Shooter'] });
  await join('no', { newGames: false });
  assert.deepEqual(await jobs.newGames(), { nuevos: 0, enviadas: 0 });
  games = [...games, raw(3, ' MMORPG')];
  assert.deepEqual(await jobs.newGames(), { nuevos: 1, enviadas: 2 });
  assert.deepEqual(sent.map((item) => item.to).sort(), ['mmo', 'todos']);
  assert.equal(sent[0].data.onActionClick.default.url, '/juego/3');
  assert.deepEqual(await jobs.newGames(), { nuevos: 0, enviadas: 0 });
});

test('el recordatorio llega una vez y solo a su dispositivo', async () => {
  await join('a');
  await join('b');
  const body = { endpoint: sub('a').endpoint, gameId: 1, remindAt: inOneMinute() };
  assert.equal((await post('/reminders', body)).status, 201);
  assert.equal((await post('/reminders', body)).status, 201);
  const later = Date.now() + 120_000;
  assert.deepEqual(await jobs.reminders(), { enviadas: 0 });
  assert.deepEqual(await jobs.reminders(later), { enviadas: 1 });
  assert.deepEqual(await jobs.reminders(later), { enviadas: 0 });
  assert.deepEqual(
    sent.map((item) => [item.to, item.title]),
    [['a', 'Tienes pendiente Juego 1']],
  );
});

test('valida y cancela recordatorios', async () => {
  const { endpoint } = sub('a');
  const ask = async (extra) =>
    (await post('/reminders', { endpoint, gameId: 1, remindAt: inOneMinute(), ...extra })).status;
  assert.equal(await ask(), 400, 'sin suscripción');
  await join('a');
  assert.equal(await ask({ gameId: 99 }), 400, 'juego inexistente');
  assert.equal(await ask({ remindAt: '2020-01-01' }), 400, 'fecha pasada');
  assert.equal(await ask(), 201);
  await post('/reminders/cancel', { endpoint, gameId: 1 });
  assert.deepEqual(await jobs.reminders(Date.now() + 120_000), { enviadas: 0 });
});

test('el juego de la semana respeta las preferencias', async () => {
  await join('si');
  await join('no', { weekly: false });
  const response = await post('/jobs/weekly', { gameId: 1 }, 'secreto');
  assert.deepEqual(await response.json(), { juego: 'Juego 1', enviadas: 1 });
});

test('elimina las suscripciones caducadas', async () => {
  await join('a');
  sendError = Object.assign(new Error('gone'), { statusCode: 410 });
  await post('/push', { title: 'a', body: 'b' }, 'secreto');
  assert.equal(store.count(), 0);
});

test('reintenta si una suscripción nueva da 410 por error', async () => {
  await join('a');
  let calls = 0;
  const send = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('gone'), { statusCode: 410 });
  };
  const notifier = createNotifier({ store, send, retryDelays: [1] });
  assert.equal(await notifier.toOne(store.all()[0], { title: 'a', body: 'b' }), true);
  assert.equal(calls, 2);
  assert.equal(store.count(), 1);
});

test('no reintenta con suscripciones antiguas', async () => {
  await join('a');
  store.get(sub('a').endpoint).createdAt = 0;
  let calls = 0;
  const gone = Object.assign(new Error('gone'), { statusCode: 410 });
  const notifier = createNotifier({
    store,
    send: async () => {
      calls += 1;
      throw gone;
    },
  });
  assert.equal(await notifier.toOne(store.all()[0], { title: 'a', body: 'b' }), false);
  assert.equal(calls, 1);
  assert.equal(store.count(), 0);
});

test('CORS solo permite los orígenes configurados', async () => {
  const ask = async (origin) =>
    (await fetch(`${base}/health`, { headers: { origin } })).headers.get(
      'access-control-allow-origin',
    );
  assert.equal(await ask('https://app.test'), 'https://app.test');
  assert.equal(await ask('https://evil.com'), null);
});
