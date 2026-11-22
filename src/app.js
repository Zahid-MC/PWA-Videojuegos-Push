import { createHash, timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  BadRequest,
  parseEndpoint,
  parseGameId,
  parseMessage,
  parsePreferences,
  parseRemindAt,
  parseSubscription,
} from './validation.js';

const digest = (value) => createHash('sha256').update(value).digest();
const MAX_REMINDERS = 20;

export function createApp({ store, catalog, notifier, jobs, config }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors({ origin: config.allowedOrigins }));
  app.use(express.json({ limit: '10kb' }));

  const api = express.Router();
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 60, legacyHeaders: false }), api);

  const requireAdmin = (req, res, next) => {
    const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
    if (!config.adminToken || !timingSafeEqual(digest(token), digest(config.adminToken))) {
      return res.status(401).json({ error: 'No autorizado.' });
    }
    next();
  };

  const requireSubscriber = (req) => {
    const entry = store.get(parseEndpoint(req.body?.endpoint));
    if (!entry) throw new BadRequest('Este dispositivo no está suscrito.');
    return entry;
  };

  api.get('/health', (_req, res) => res.json({ ok: true, suscripciones: store.count() }));

  // --- Clientes ---
  api.post('/subscribe', (req, res) => {
    const subscription = parseSubscription(req.body?.subscription);
    const isNew = store.upsert(subscription, parsePreferences(req.body?.preferences));
    // "silent" se usa al volver a registrar un dispositivo que ya había aceptado los avisos.
    // No se espera al envío: con reintentos puede tardar varios segundos.
    if (isNew && req.body?.silent !== true) {
      void notifier.toOne(store.get(subscription.endpoint), {
        title: 'Avisos activados',
        body: 'Te contaremos cuando llegue un juego que te interese.',
        url: '/avisos',
        tag: 'bienvenida',
      });
    }
    res.status(isNew ? 201 : 200).json({ ok: true });
  });

  api.post('/unsubscribe', (req, res) => {
    store.remove(parseEndpoint(req.body?.endpoint));
    res.json({ ok: true });
  });

  api.post('/test', async (req, res) => {
    const sent = await notifier.toOne(requireSubscriber(req), {
      title: 'Todo listo',
      body: 'Los avisos llegan bien a este dispositivo.',
      url: '/avisos',
      tag: 'prueba',
    });
    res.status(sent ? 200 : 502).json({ enviadas: sent ? 1 : 0 });
  });

  api.post('/reminders', async (req, res) => {
    const { endpoint } = requireSubscriber(req).subscription;
    const gameId = parseGameId(req.body.gameId);
    const remindAt = parseRemindAt(req.body.remindAt, Date.now());
    const others = store.remindersOf(endpoint).filter((item) => item.gameId !== gameId);
    if (others.length >= MAX_REMINDERS) {
      throw new BadRequest(`Puedes tener ${MAX_REMINDERS} recordatorios como máximo.`);
    }
    // El título sale del catálogo, no del cliente.
    const game = await catalog.find(gameId);
    if (!game) throw new BadRequest('El juego no existe.');
    store.setReminder({ endpoint, gameId, title: game.title, image: game.image, remindAt });
    res.status(201).json({ ok: true });
  });

  api.post('/reminders/cancel', (req, res) => {
    const { endpoint } = requireSubscriber(req).subscription;
    store.removeReminder(endpoint, parseGameId(req.body.gameId));
    res.json({ ok: true });
  });

  // --- Administración: requieren "Authorization: Bearer <ADMIN_TOKEN>" ---
  api.post('/push', requireAdmin, async (req, res) => {
    const message = parseMessage(req.body);
    res.json({ enviadas: await notifier.toMany(store.all(), message) });
  });

  api.post('/jobs/run', requireAdmin, async (_req, res) => {
    res.json({ recordatorios: await jobs.reminders(), juegos: await jobs.newGames() });
  });

  const gameJob = (run) => async (req, res) => {
    const result = await run(parseGameId(req.body?.gameId));
    if (!result) throw new BadRequest('El juego no existe.');
    res.json(result);
  };
  api.post('/jobs/new-game', requireAdmin, gameJob(jobs.simulateNewGame));
  api.post('/jobs/weekly', requireAdmin, gameJob(jobs.weekly));

  app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof BadRequest) return res.status(400).json({ error: error.message });
    if (error.status >= 400 && error.status < 500) {
      return res.status(error.status).json({ error: 'Petición no válida.' });
    }
    console.error(error);
    res.status(500).json({ error: 'Error interno.' });
  });

  return app;
}
