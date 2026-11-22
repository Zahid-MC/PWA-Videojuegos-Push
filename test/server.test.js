import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createCatalog } from '../src/catalog.js';
import { createJobs } from '../src/jobs.js';
import { createLibrary } from '../src/library.js';
import { createNotifier } from '../src/notifier.js';
import { createStore } from '../src/store.js';

let games, store, jobs, sent, sendError, server, base, app;

const raw = (id, genre, release_date = '2020-01-01') => ({
  id,
  title: `Juego ${id}`,
  genre,
  thumbnail: 'https://t/x.jpg',
  release_date,
});
const DAY = 24 * 60 * 60 * 1000;
const dayFromNow = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
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
  const library = createLibrary({ store, catalog, notifier });
  app = createApp({ store, catalog, notifier, jobs, library, config });
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
  for (const path of ['/push', '/jobs/run', '/jobs/new-game', '/jobs/weekly', '/jobs/release']) {
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
  assert.equal(await ask(), 410, 'sin suscripción');
  await join('a');
  assert.equal(await ask({ gameId: 99 }), 400, 'juego inexistente');
  assert.equal(await ask({ remindAt: '2020-01-01' }), 400, 'fecha pasada');
  assert.equal(await ask(), 201);
  await post('/reminders/cancel', { endpoint, gameId: 1 });
  assert.deepEqual(await jobs.reminders(Date.now() + 120_000), { enviadas: 0 });
});

const change = (name, gameId, action) =>
  post('/library', { endpoint: sub(name).endpoint, gameId, action });
const sync = (name, items) => post('/library/sync', { endpoint: sub(name).endpoint, items });

test('avisa al guardar, mover y eliminar, solo a ese dispositivo', async () => {
  await join('a');
  await join('b');
  for (const action of ['wish', 'playing', 'done', 'removed']) {
    assert.equal((await change('a', 1, action)).status, 200, action);
  }
  assert.deepEqual(
    sent.map((item) => [item.to, item.title]),
    [
      ['a', 'Guardado: Juego 1'],
      ['a', 'Jugando: Juego 1'],
      ['a', 'Terminado: Juego 1'],
      ['a', 'Eliminado: Juego 1'],
    ],
  );
  assert.ok(sent.every((item) => item.renotify && item.tag === 'biblioteca-1'));
});

test('valida los cambios de biblioteca', async () => {
  assert.equal((await change('a', 1, 'wish')).status, 410);
  await join('a');
  assert.equal((await change('a', 1, 'otra')).status, 400);
  assert.equal((await change('a', 1, 'constructor')).status, 400);
  assert.equal((await change('a', 99, 'wish')).status, 400);
  assert.equal((await change('a', 'x', 'wish')).status, 400);
  assert.equal(sent.length, 0);
});

test('se pueden silenciar los avisos de biblioteca', async () => {
  await join('a', { library: false });
  await change('a', 1, 'wish');
  assert.equal(sent.length, 0);
  assert.deepEqual(store.all()[0].saved, [1]);
});

test('eliminar cancela los recordatorios de ese juego', async () => {
  await join('a');
  const { endpoint } = sub('a');
  await post('/reminders', { endpoint, gameId: 1, remindAt: inOneMinute() });
  await post('/reminders', { endpoint, gameId: 2, remindAt: inOneMinute() });
  await change('a', 1, 'removed');
  assert.deepEqual(
    store.remindersOf(endpoint).map((item) => item.gameId),
    [2],
  );
});

test('un juego guardado avisa la víspera y el día que sale', async () => {
  games.push(raw(5, 'RPG', dayFromNow(10)));
  await join('a');
  await change('a', 5, 'wish');
  assert.match(sent[0].body, /Sale el \d\d\/\d\d\/\d{4} y te avisaremos/);
  assert.deepEqual(await jobs.reminders(Date.now() + 8 * DAY), { enviadas: 0 });
  assert.deepEqual(await jobs.reminders(Date.now() + 10 * DAY), { enviadas: 1 });
  assert.deepEqual(await jobs.reminders(Date.now() + 12 * DAY), { enviadas: 1 });
  assert.deepEqual(await jobs.reminders(Date.now() + 12 * DAY), { enviadas: 0 });
  assert.deepEqual(
    sent.slice(1).map((item) => item.title),
    ['Mañana sale Juego 5', 'Ya salió Juego 5'],
  );
});

test('el aviso de lanzamiento convive con un recordatorio manual', async () => {
  games.push(raw(5, 'RPG', dayFromNow(10)));
  await join('a');
  const { endpoint } = sub('a');
  await change('a', 5, 'wish');
  await post('/reminders', { endpoint, gameId: 5, remindAt: inOneMinute() });
  const kinds = () =>
    store
      .remindersOf(endpoint)
      .map((item) => item.kind)
      .sort();
  assert.deepEqual(kinds(), ['manual', 'release', 'release-soon']);
  await post('/reminders/cancel', { endpoint, gameId: 5 });
  assert.deepEqual(kinds(), ['release', 'release-soon']);
  await change('a', 5, 'done');
  assert.deepEqual(kinds(), []);
});

test('si el lanzamiento se retrasa, se reprograma sin avisar', async () => {
  games.push(raw(5, 'RPG', dayFromNow(3)));
  await join('a');
  await change('a', 5, 'wish');
  sent = [];
  games[games.length - 1].release_date = dayFromNow(40);
  await jobs.newGames();
  assert.deepEqual(await jobs.reminders(Date.now() + 5 * DAY), { enviadas: 0 });
  assert.equal(sent.length, 0);
  assert.deepEqual(await jobs.reminders(Date.now() + 39.9 * DAY), { enviadas: 1 });
});

test('la sincronización reconstruye la biblioteca sin notificar', async () => {
  games.push(raw(5, 'RPG', dayFromNow(10)));
  await join('a');
  const { endpoint } = sub('a');
  await post('/reminders', { endpoint, gameId: 2, remindAt: inOneMinute() });
  const response = await sync('a', [
    { gameId: 1, status: 'wish', remindAt: inOneMinute() },
    { gameId: 5, status: 'playing' },
    { gameId: 99, status: 'done' },
  ]);
  assert.equal(response.status, 200);
  assert.equal(sent.length, 0);
  assert.deepEqual(store.all()[0].saved, [1, 5]);
  assert.deepEqual(
    store.remindersOf(endpoint).map((item) => [item.gameId, item.kind]),
    [
      [1, 'manual'],
      [5, 'release-soon'],
      [5, 'release'],
    ],
  );
  assert.equal((await sync('a', [{ gameId: 1, status: 'x' }])).status, 400);
  assert.equal((await sync('a', 'nada')).status, 400);
  // Volver a registrarse no borra lo guardado.
  await join('a');
  assert.deepEqual(store.all()[0].saved, [1, 5]);
});

test('la demostración de lanzamiento llega a quien guardó el juego', async () => {
  await join('a');
  await join('b');
  await join('c', { releases: false });
  await change('a', 1, 'wish');
  await change('c', 1, 'wish');
  const response = await post('/jobs/release', { gameId: 1 }, 'secreto');
  assert.deepEqual(await response.json(), { juego: 'Juego 1', enviadas: 1 });
  assert.equal(sent.at(-1).title, 'Ya salió Juego 1');
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
