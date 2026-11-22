const API = 'https://www.freetogame.com/api/games';
const TTL = 30 * 60 * 1000;

const ALIASES = {
  'Card Game': 'Card',
  'Action Game': 'Action',
  ARPG: 'Action RPG',
  MMOARPG: 'MMORPG',
  MMO: 'MMORPG',
};

// Debe coincidir con normalizeGenre() de la app Angular.
export const normalizeGenre = (genre) => {
  const clean = genre.trim();
  return ALIASES[clean] ?? clean;
};

/** Catálogo con caché de 30 minutos para no saturar la API pública. */
export function createCatalog(fetchFn = fetch) {
  let games = [];
  let loadedAt = 0;

  return {
    async list({ fresh = false } = {}) {
      if (!fresh && games.length && Date.now() - loadedAt < TTL) return games;
      const response = await fetchFn(API, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`FreeToGame respondió ${response.status}`);
      const raw = await response.json();
      if (!Array.isArray(raw)) throw new Error('FreeToGame devolvió un formato inesperado');
      games = raw.map((game) => ({
        id: game.id,
        title: game.title,
        genre: normalizeGenre(game.genre),
        image: game.thumbnail,
      }));
      loadedAt = Date.now();
      return games;
    },
    async find(id) {
      return (await this.list()).find((game) => game.id === id);
    },
  };
}
