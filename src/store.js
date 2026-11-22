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

  const without = (endpoint, gameId) =>
    data.reminders.filter((item) => item.endpoint !== endpoint || item.gameId !== gameId);

  return {
    count: () => Object.keys(data.subscriptions).length,
    all: () => Object.values(data.subscriptions),
    get: (endpoint) =>
      Object.hasOwn(data.subscriptions, endpoint) ? data.subscriptions[endpoint] : undefined,
    upsert(subscription, preferences) {
      const isNew = !Object.hasOwn(data.subscriptions, subscription.endpoint);
      const createdAt = isNew ? Date.now() : data.subscriptions[subscription.endpoint].createdAt;
      data.subscriptions[subscription.endpoint] = { subscription, preferences, createdAt };
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
      data.reminders = [...without(reminder.endpoint, reminder.gameId), reminder];
      save();
    },
    removeReminder(endpoint, gameId) {
      data.reminders = without(endpoint, gameId);
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
