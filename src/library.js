import { BadRequest, LIBRARY_STATUSES } from './validation.js';

const DAY = 24 * 60 * 60 * 1000;
const MAX_REMINDERS = 20;
const RELEASE_KINDS = ['release', 'release-soon'];

// La API solo da el día: se avisa a las 15:00 UTC (9:00 en el centro de México).
const releaseTime = (game) => Date.parse(`${game.releaseDate}T15:00:00Z`);
const formatDate = (date) => date.split('-').reverse().join('/');

/** Avisos de lanzamiento que corresponden a un juego: el día anterior y el mismo día. */
export function releaseReminders(endpoint, game, now) {
  const releaseAt = releaseTime(game);
  const base = { endpoint, gameId: game.id, title: game.title, image: game.image };
  return [
    { ...base, kind: 'release-soon', remindAt: releaseAt - DAY, releaseDate: game.releaseDate },
    { ...base, kind: 'release', remindAt: releaseAt, releaseDate: game.releaseDate },
  ].filter((item) => item.remindAt > now);
}

/** Avisos al guardar, mover o quitar juegos, y seguimiento de sus lanzamientos. */
export function createLibrary({ store, catalog, notifier }) {
  const describe = (game, action, upcoming) => {
    const wait = `Sale el ${formatDate(game.releaseDate)} y te avisaremos.`;
    return {
      wish: {
        title: `Guardado: ${game.title}`,
        body: upcoming ? `Está en Quiero jugar. ${wait}` : 'Está en tu lista Quiero jugar.',
      },
      playing: {
        title: `Jugando: ${game.title}`,
        body: 'Está en tu lista Jugando. ¡Que lo disfrutes!',
      },
      done: {
        title: `Terminado: ${game.title}`,
        body: 'Está en tu lista Terminado. ¿Cuál será el siguiente?',
      },
      removed: {
        title: `Eliminado: ${game.title}`,
        body: 'Ya no está en tu biblioteca y se cancelaron sus recordatorios.',
      },
    }[action];
  };

  return {
    async change({ subscription: { endpoint }, preferences }, gameId, action) {
      // Al eliminar, los recordatorios se cancelan aunque el catálogo no responda.
      if (action === 'removed') store.removeSaved(endpoint, gameId);

      const game = await catalog.find(gameId);
      if (!game) {
        if (action === 'removed') return;
        throw new BadRequest('El juego no existe.');
      }

      let upcoming = false;
      if (action !== 'removed') {
        store.addSaved(endpoint, gameId);
        store.removeReminder(endpoint, gameId, RELEASE_KINDS);
        const reminders = action === 'done' ? [] : releaseReminders(endpoint, game, Date.now());
        reminders.forEach((item) => store.setReminder(item));
        upcoming = reminders.length > 0 && preferences.releases;
      }

      const entry = store.get(endpoint);
      if (!entry || !preferences.library) return;
      // No se espera al envío: con reintentos puede tardar varios segundos.
      void notifier.toOne(entry, {
        ...describe(game, action, upcoming),
        url: action === 'removed' ? '/biblioteca' : `/juego/${game.id}`,
        image: game.image,
        tag: `biblioteca-${game.id}`,
      });
    },

    /** Reconstruye lo que el servidor sabe del dispositivo (tras reiniciarse o volver la red). */
    async sync({ subscription: { endpoint } }, items, now = Date.now()) {
      const games = new Map((await catalog.list()).map((game) => [game.id, game]));
      const known = items.filter((item) => games.has(item.gameId));
      const saved = new Set(known.map((item) => item.gameId));

      const manual = known
        .filter((item) => item.remindAt > now)
        .slice(0, MAX_REMINDERS)
        .map(({ gameId, remindAt }) => {
          const { title, image } = games.get(gameId);
          return { endpoint, gameId, title, image, kind: 'manual', remindAt };
        });
      const releases = known
        .filter((item) => item.status !== 'done')
        .flatMap((item) => releaseReminders(endpoint, games.get(item.gameId), now));
      // Los que ya vencieron pero aún no se enviaron no deben perderse.
      const overdue = store
        .remindersOf(endpoint)
        .filter((item) => item.remindAt <= now && saved.has(item.gameId));

      store.replaceLibrary(endpoint, [...saved], [...overdue, ...manual, ...releases]);
    },

    setManualReminder({ subscription: { endpoint } }, game, remindAt) {
      const others = store
        .remindersOf(endpoint)
        .filter((item) => item.kind === 'manual' && item.gameId !== game.id);
      if (others.length >= MAX_REMINDERS) {
        throw new BadRequest(`Puedes tener ${MAX_REMINDERS} recordatorios como máximo.`);
      }
      const { id: gameId, title, image } = game;
      store.setReminder({ endpoint, gameId, title, image, kind: 'manual', remindAt });
    },
  };
}

export const isLibraryAction = (value) => value === 'removed' || LIBRARY_STATUSES.includes(value);
