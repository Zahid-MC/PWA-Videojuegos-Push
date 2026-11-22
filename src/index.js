import webpush from 'web-push';
import { createApp } from './app.js';
import { createCatalog } from './catalog.js';
import { createJobs } from './jobs.js';
import { createNotifier } from './notifier.js';
import { createStore } from './store.js';

const env = process.env;
const required = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'ADMIN_TOKEN'];
const missing = required.filter((name) => !env[name]);
if (missing.length) {
  console.error(`Faltan variables de entorno: ${missing.join(', ')}. En local: "npm run keys".`);
  process.exit(1);
}

webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

const store = createStore(env.DATA_FILE ?? 'data/store.json');
const catalog = createCatalog();
const notifier = createNotifier({
  store,
  send: (subscription, payload) =>
    webpush.sendNotification(subscription, payload, { TTL: 86400, timeout: 10000 }),
});
const jobs = createJobs({ store, catalog, notifier });
const config = {
  adminToken: env.ADMIN_TOKEN,
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

const every = (ms, name, job) => {
  const run = () => job().catch((error) => console.error(`${name}:`, error.message));
  run();
  setInterval(run, ms);
};
every(20_000, 'Recordatorios', () => jobs.reminders());
every(6 * 60 * 60 * 1000, 'Juegos nuevos', () => jobs.newGames());

const port = Number(env.PORT ?? 3000);
createApp({ store, catalog, notifier, jobs, config }).listen(port, () => {
  console.log(`Servidor de avisos en http://localhost:${port}/api/health`);
});
