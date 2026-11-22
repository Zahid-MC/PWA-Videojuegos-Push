import { releaseReminders } from './library.js';

const releaseMessage = ({ gameId, title, image }, soon) => ({
  title: soon ? `Mañana sale ${title}` : `Ya salió ${title}`,
  body: soon ? 'Lo tienes guardado. Prepárate para jugar.' : 'Lo tenías guardado. ¿Empezamos?',
  url: `/juego/${gameId}`,
  image,
  tag: `lanzamiento-${gameId}`,
});

const reminderMessage = ({ gameId, title, image }) => ({
  title: `Tienes pendiente ${title}`,
  body: 'Lo dejaste programado en tu biblioteca. ¿Jugamos?',
  url: `/juego/${gameId}`,
  image,
  tag: `recordatorio-${gameId}`,
});

/** Casos de negocio: juego nuevo, recordatorio, lanzamiento y juego de la semana. */
export function createJobs({ store, catalog, notifier }) {
  const announce = (game) =>
    notifier.toMany(
      store
        .all()
        .filter(
          ({ preferences: { newGames, genres } }) =>
            newGames && (genres.length === 0 || genres.includes(game.genre)),
        ),
      {
        title: `Nuevo en el catálogo: ${game.title}`,
        body: `${game.genre} gratuito. Mira los detalles y guárdalo en tu biblioteca.`,
        url: `/juego/${game.id}`,
        image: game.image,
        tag: `nuevo-${game.id}`,
      },
    );

  return {
    async newGames() {
      const games = await catalog.list({ fresh: true });
      const known = new Set(store.knownGameIds());
      store.setKnownGameIds(games.map((game) => game.id));
      // La primera vez solo se toma la referencia: no hay con qué comparar.
      if (known.size === 0) return { nuevos: 0, enviadas: 0 };

      const added = games.filter((game) => !known.has(game.id));
      let sent = 0;
      for (const game of added.slice(0, 3)) sent += await announce(game);
      return { nuevos: added.length, enviadas: sent };
    },

    /** Para la demostración: anuncia un juego existente como si acabara de llegar. */
    async simulateNewGame(id) {
      const game = await catalog.find(id);
      return game ? { juego: game.title, enviadas: await announce(game) } : null;
    },

    async reminders(now = Date.now()) {
      let sent = 0;
      for (const reminder of store.takeDue(now)) {
        const entry = store.get(reminder.endpoint);
        if (!entry) continue;

        const isRelease = reminder.kind === 'release' || reminder.kind === 'release-soon';
        if (isRelease) {
          // Los lanzamientos se retrasan: se confirma la fecha antes de avisar.
          const game = await catalog.find(reminder.gameId).catch(() => undefined);
          if (game && game.releaseDate !== reminder.releaseDate) {
            store.removeReminder(reminder.endpoint, game.id, ['release', 'release-soon']);
            releaseReminders(reminder.endpoint, game, now).forEach((item) =>
              store.setReminder(item),
            );
            continue;
          }
          if (!entry.preferences.releases) continue;
        }

        const message = isRelease
          ? releaseMessage(reminder, reminder.kind === 'release-soon')
          : reminderMessage(reminder);
        if (await notifier.toOne(entry, message)) sent += 1;
      }
      return { enviadas: sent };
    },

    /** Para la demostración: avisa del lanzamiento a quienes tienen guardado ese juego. */
    async simulateRelease(id) {
      const game = await catalog.find(id);
      if (!game) return null;
      const enviadas = await notifier.toMany(
        store.all().filter((entry) => entry.preferences.releases && entry.saved?.includes(game.id)),
        releaseMessage({ gameId: game.id, title: game.title, image: game.image }, false),
      );
      return { juego: game.title, enviadas };
    },

    async weekly(id) {
      const game = await catalog.find(id);
      if (!game) return null;
      const enviadas = await notifier.toMany(
        store.all().filter((entry) => entry.preferences.weekly),
        {
          title: `Juego de la semana: ${game.title}`,
          body: `Nuestra elección en ${game.genre}. Gratis, como siempre.`,
          url: `/juego/${game.id}`,
          image: game.image,
          tag: 'semana',
        },
      );
      return { juego: game.title, enviadas };
    },
  };
}
