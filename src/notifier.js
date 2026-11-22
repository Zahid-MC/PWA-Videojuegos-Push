/** Formato que entiende el service worker de Angular, incluida la acción al pulsar. */
export function toPayload({ title, body, url = '/', image, tag }) {
  return {
    notification: {
      title,
      body,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/badge-96x96.png',
      ...(image && { image }),
      // renotify: si reemplaza a otro aviso con la misma etiqueta, vuelve a sonar.
      ...(tag && { tag, renotify: true }),
      data: { onActionClick: { default: { operation: 'navigateLastFocusedOrOpen', url } } },
    },
  };
}

const isGone = (error) => error.statusCode === 404 || error.statusCode === 410;

// Google a veces responde 410 a una suscripción recién creada que sí es válida: durante este
// tiempo se reintenta antes de darla por perdida.
const GRACE = 2 * 60 * 1000;

/** Envía avisos y elimina las suscripciones que el navegador ya no reconoce (404 y 410). */
export function createNotifier({ store, send, retryDelays = [2000, 5000, 10000] }) {
  async function toOne(entry, message) {
    const payload = JSON.stringify(toPayload(message));
    const delays = Date.now() - entry.createdAt < GRACE ? [...retryDelays] : [];

    for (;;) {
      try {
        await send(entry.subscription, payload);
        return true;
      } catch (error) {
        if (!isGone(error)) {
          console.error('Envío fallido:', error.statusCode ?? error.message);
          return false;
        }
        if (delays.length === 0) {
          console.warn(`Suscripción eliminada (${error.statusCode}).`);
          store.remove(entry.subscription.endpoint);
          return false;
        }
        console.warn(`Suscripción nueva con ${error.statusCode}: se reintenta.`);
        await new Promise((resolve) => setTimeout(resolve, delays.shift()));
      }
    }
  }

  return {
    toOne,
    async toMany(entries, message) {
      const results = await Promise.all(entries.map((entry) => toOne(entry, message)));
      return results.filter(Boolean).length;
    },
  };
}
