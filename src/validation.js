// El servidor hace POST a la URL de cada suscripción: solo se aceptan servicios push conocidos
// para que nadie lo use como intermediario contra otras direcciones.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /\.push\.apple\.com$/,
];

export const LIBRARY_STATUSES = ['wish', 'playing', 'done'];

export class BadRequest extends Error {
  status = 400;
}

/** 410: la app debe volver a registrarse y reintentar. */
export class NotSubscribed extends BadRequest {
  status = 410;
}

const isText = (value, max) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function parseSubscription(value) {
  const { endpoint, keys } = value ?? {};
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BadRequest('La suscripción no es válida.');
  }
  const trusted =
    url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((host) => host.test(url.hostname));
  if (
    !trusted ||
    endpoint.length > 1000 ||
    !isText(keys?.p256dh, 200) ||
    !isText(keys?.auth, 100)
  ) {
    throw new BadRequest('La suscripción no es válida.');
  }
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export function parsePreferences(value) {
  const genres = Array.isArray(value?.genres)
    ? value.genres.filter((genre) => isText(genre, 40)).slice(0, 30)
    : [];
  return {
    newGames: value?.newGames !== false,
    weekly: value?.weekly !== false,
    library: value?.library !== false,
    releases: value?.releases !== false,
    genres: [...new Set(genres)],
  };
}

export function parseEndpoint(value) {
  if (!isText(value, 1000)) throw new BadRequest('Falta el endpoint de la suscripción.');
  return value;
}

export function parseGameId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new BadRequest('El juego no es válido.');
  return value;
}

const MAX_DELAY = 60 * 24 * 60 * 60 * 1000;

export function parseRemindAt(value, now) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(time) || time <= now || time > now + MAX_DELAY) {
    throw new BadRequest('La fecha debe ser futura y de 60 días como máximo.');
  }
  return time;
}

const MAX_LIBRARY = 200;

export function parseLibrary(value) {
  if (!Array.isArray(value) || value.length > MAX_LIBRARY) {
    throw new BadRequest(`La biblioteca debe tener ${MAX_LIBRARY} juegos como máximo.`);
  }
  return value.map((item) => {
    if (!LIBRARY_STATUSES.includes(item?.status)) throw new BadRequest('El estado no es válido.');
    const remindAt = typeof item.remindAt === 'string' ? Date.parse(item.remindAt) : NaN;
    return { gameId: parseGameId(item.gameId), status: item.status, remindAt };
  });
}

export function parseMessage(value) {
  if (!isText(value?.title, 80) || !isText(value?.body, 200)) {
    throw new BadRequest('Se necesita un título (80) y un mensaje (200 caracteres).');
  }
  const url = value.url ?? '/';
  if (typeof url !== 'string' || !/^\/(?!\/)[\w\-/]*$/.test(url)) {
    throw new BadRequest('La url debe ser una ruta interna de la app.');
  }
  return { title: value.title.trim(), body: value.body.trim(), url };
}
