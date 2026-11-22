import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const empty = () => ({ subscriptions: {}, reminders: [], knownGameIds: [] });

/** Almacén en memoria con copia en un archivo JSON (filePath null = solo memoria). */
export function createStore(filePath) {
  let data = empty();
  if (filePath) {
    try {
      data = { ...empty(), ...JSON.parse(readFileSync(filePath, 'utf8')) };
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('No se pudo leer el almacén:', error.message);
    }
  }

  const save = () => {
    if (!filePath) return;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(`${filePath}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${filePath}.tmp`, filePath);
  };

  /** Recordatorios menos los de ese juego (solo los tipos indicados, o todos). */
  const without = (endpoint, gameId, kinds) =>
    data.reminders.filter(
      (item) =>
        item.endpoint !== endpoint ||
        item.gameId !== gameId ||
        (kinds && !kinds.includes(item.kind)),
    );

  return {
    count: () => Object.keys(data.subscriptions).length,
    all: () => Object.values(data.subscriptions),
    get: (endpoint) =>
      Object.hasOwn(data.subscriptions, endpoint) ? data.subscriptions[endpoint] : undefined,
    upsert(subscription, preferences) {
      const isNew = !Object.hasOwn(data.subscriptions, subscription.endpoint);
      const { createdAt, saved } = isNew
        ? { createdAt: Date.now(), saved: [] }
        : data.subscriptions[subscription.endpoint];
      data.subscriptions[subscription.endpoint] = { subscription, preferences, createdAt, saved };
      save();
      return isNew;
    },
    remove(endpoint) {
      delete data.subscriptions[endpoint];
      data.reminders = data.reminders.filter((item) => item.endpoint !== endpoint);
      save();
    },
    remindersOf: (endpoint) => data.reminders.filter((item) => item.endpoint === endpoint),
    setReminder(reminder) {
      const { endpoint, gameId, kind } = reminder;
      data.reminders = [...without(endpoint, gameId, [kind]), reminder];
      save();
    },
    removeReminder(endpoint, gameId, kinds) {
      data.reminders = without(endpoint, gameId, kinds);
      save();
    },
    addSaved(endpoint, gameId) {
      const entry = this.get(endpoint);
      if (!entry) return;
      entry.saved = [...new Set([...(entry.saved ?? []), gameId])];
      save();
    },
    removeSaved(endpoint, gameId) {
      const entry = this.get(endpoint);
      if (!entry) return;
      entry.saved = (entry.saved ?? []).filter((id) => id !== gameId);
      data.reminders = without(endpoint, gameId);
      save();
    },
    replaceLibrary(endpoint, saved, reminders) {
      // Pudo darse de baja mientras se consultaba el catálogo.
      if (!Object.hasOwn(data.subscriptions, endpoint)) return;
      data.subscriptions[endpoint].saved = saved;
      data.reminders = [
        ...data.reminders.filter((item) => item.endpoint !== endpoint),
        ...reminders,
      ];
      save();
    },
    /** Extrae los recordatorios vencidos para que ninguno se envíe dos veces. */
    takeDue(now) {
      const due = data.reminders.filter((item) => item.remindAt <= now);
      if (due.length) {
        data.reminders = data.reminders.filter((item) => item.remindAt > now);
        save();
      }
      return due;
    },
    knownGameIds: () => data.knownGameIds,
    setKnownGameIds(ids) {
      data.knownGameIds = ids;
      save();
    },
  };
}
