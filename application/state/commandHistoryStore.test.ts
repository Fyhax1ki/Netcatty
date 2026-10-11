import test from "node:test";
import assert from "node:assert/strict";

import {
  STORAGE_KEY_COMMAND_HISTORY,
  STORAGE_KEY_COMMAND_HISTORY_CLEARED,
} from "../../infrastructure/config/storageKeys";

type StorageEventLike = { key: string | null; newValue: string | null };
type StorageListener = (event: StorageEventLike) => void;

type DeferredRead = { resolve: (value: string) => void };

const COMMAND_HISTORY_STORAGE_KEY = STORAGE_KEY_COMMAND_HISTORY;

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
    configurable: true,
  });
  return store;
}

/**
 * The store registers its cross-window `storage` listener at module load, so
 * the DOM globals must exist before the dynamic imports below.
 */
function installWindow(): (key: string, newValue: string | null) => void {
  const listeners = new Set<StorageListener>();
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: (type: string, listener: StorageListener) => {
        if (type === "storage") listeners.add(listener);
      },
      removeEventListener: (type: string, listener: StorageListener) => {
        if (type === "storage") listeners.delete(listener);
      },
      netcatty: undefined as unknown,
    },
    configurable: true,
  });
  return (key: string, newValue: string | null) => {
    for (const listener of listeners) listener({ key, newValue });
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const storage = installLocalStorage();
const dispatchStorageEvent = installWindow();

const {
  clearHistory,
  flushCommandHistoryStore,
  getCommandHistoryClearGeneration,
  hasCommandHistoryBeenCleared,
  markCommandHistoryCleared,
  queryHistory,
  recordCommand,
  subscribeCommandHistoryCleared,
} = await import("./commandHistoryStore.ts");
const { seedLocalShellHistoryFromHistfiles } = await import(
  "../../components/terminal/autocomplete/localShellHistorySeed.ts"
);

function readPersistedCommands(): string[] {
  const raw = storage.get(COMMAND_HISTORY_STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { entries: Array<{ command: string }> };
  return parsed.entries.map((entry) => entry.command);
}

function readPersistedGeneration(): number {
  const raw = storage.get(COMMAND_HISTORY_STORAGE_KEY);
  if (!raw) return 0;
  const parsed = JSON.parse(raw) as { clearGeneration?: number };
  return typeof parsed.clearGeneration === "number" ? parsed.clearGeneration : 0;
}

test("an external clear invalidates the cached history and cannot be resurrected", () => {
  storage.clear();
  clearHistory();

  recordCommand("stale-command --flag", "host-1");
  flushCommandHistoryStore();
  assert.ok(queryHistory("stale", { hostId: "host-1" }).length > 0);

  // Simulate another renderer (main window or a detached terminal popup)
  // clearing the shared localStorage entry.
  const cleared = JSON.stringify({ entries: [], version: 1, clearGeneration: 1 });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, cleared);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, cleared);

  // The stale module-local cache must be dropped immediately.
  assert.equal(queryHistory("stale", { hostId: "host-1" }).length, 0);

  // A later recordCommand must persist only the new command, never the stale
  // snapshot it still held in memory.
  recordCommand("fresh-command", "host-1");
  flushCommandHistoryStore();
  assert.deepEqual(readPersistedCommands(), ["fresh-command"]);
});

test("clearHistory persists synchronously and cancels a pending debounced write", async () => {
  storage.clear();
  clearHistory();

  recordCommand("pending-command", "host-1");
  // No flush: the debounced write is still scheduled.
  clearHistory();
  assert.deepEqual(readPersistedCommands(), []);

  // Wait past the debounce window to prove the cancelled write cannot restore
  // the entries.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(readPersistedCommands(), []);
});

test("a local clear bumps the generation and notifies subscribers", () => {
  storage.clear();
  clearHistory();

  const before = getCommandHistoryClearGeneration();
  let notified = 0;
  const unsubscribe = subscribeCommandHistoryCleared(() => {
    notified += 1;
  });

  recordCommand("notify-local", "host-1");
  clearHistory();

  assert.equal(getCommandHistoryClearGeneration(), before + 1);
  assert.equal(readPersistedGeneration(), before + 1);
  assert.equal(notified, 1);

  unsubscribe();
  clearHistory();
  assert.equal(notified, 1);
});

test("an external clear notifies subscribers, while an external record does not", () => {
  storage.clear();
  clearHistory();

  const baseline = getCommandHistoryClearGeneration();
  let notified = 0;
  const unsubscribe = subscribeCommandHistoryCleared(() => {
    notified += 1;
  });

  // A normal record from another renderer keeps the generation: no clear event.
  const recorded = JSON.stringify({ entries: [], version: 1, clearGeneration: baseline });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, recorded);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, recorded);
  assert.equal(notified, 0);

  // A clear from another renderer bumps the generation: subscribers fire.
  const cleared = JSON.stringify({ entries: [], version: 1, clearGeneration: baseline + 1 });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, cleared);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, cleared);
  assert.equal(notified, 1);
  assert.equal(getCommandHistoryClearGeneration(), baseline + 1);

  unsubscribe();
});

test("a histfile import that started before a clear is discarded", async () => {
  storage.clear();
  clearHistory();

  const hostId = `local-seed-clear-${Date.now()}`;
  const deferredReads: DeferredRead[] = [];
  (window as unknown as { netcatty?: unknown }).netcatty = {
    getHomeDir: async () => "/home/demo",
    readLocalFile: () =>
      new Promise<string>((resolve) => {
        deferredReads.push({ resolve });
      }),
  };

  const seedPromise = seedLocalShellHistoryFromHistfiles(hostId, "macos");
  // Let the seeder resolve getHomeDir and reach the histfile reads.
  await waitFor(() => deferredReads.length === 4);

  // The user clears history while the bridge reads are still pending.
  clearHistory();

  for (const deferred of deferredReads) {
    deferred.resolve(": 1700000000:0;echo seeded\n");
  }

  assert.equal(await seedPromise, 0);
  assert.equal(queryHistory("echo", { hostId, limit: 5 }).length, 0);

  // The host is marked seeded so a later open cannot re-import the deleted
  // commands.
  assert.equal(await seedLocalShellHistoryFromHistfiles(hostId, "macos"), 0);
  assert.equal(queryHistory("echo", { hostId, limit: 5 }).length, 0);
});

test("markCommandHistoryCleared persists a tombstone for histfile seeding", () => {
  storage.clear();
  assert.equal(hasCommandHistoryBeenCleared(), false);

  markCommandHistoryCleared();

  assert.equal(hasCommandHistoryBeenCleared(), true);
  assert.equal(storage.get(STORAGE_KEY_COMMAND_HISTORY_CLEARED), "true");
});

test("a first-time histfile import is skipped once history has been cleared", async () => {
  storage.clear();
  clearHistory();
  markCommandHistoryCleared();

  const hostId = `local-seed-tombstone-${Date.now()}`;
  (window as unknown as { netcatty?: unknown }).netcatty = {
    getHomeDir: async () => "/home/demo",
    readLocalFile: async () => ": 1700000000:0;echo resurrected\n",
  };

  assert.equal(await seedLocalShellHistoryFromHistfiles(hostId, "macos"), 0);
  assert.equal(queryHistory("echo", { hostId, limit: 5 }).length, 0);
});

test("an external clear also drops in-memory compose-bar recall", async () => {
  const composeBar = await import("./composeBarHistoryStore.ts");
  storage.clear();
  clearHistory();
  composeBar.pruneComposeBarHistory([]);
  composeBar.recordComposeBarHistory("session-1", "echo compose");
  assert.deepEqual(composeBar.getComposeBarHistory("session-1"), ["echo compose"]);

  let notified = 0;
  const unsubscribe = composeBar.subscribeComposeBarHistoryCleared(() => {
    notified += 1;
  });

  // Simulate another renderer clearing command history. The compose-bar store
  // follows the same clear event, so a detached popup drops its recall too.
  const cleared = JSON.stringify({
    entries: [],
    version: 1,
    clearGeneration: getCommandHistoryClearGeneration() + 1,
  });
  storage.set(COMMAND_HISTORY_STORAGE_KEY, cleared);
  dispatchStorageEvent(COMMAND_HISTORY_STORAGE_KEY, cleared);

  assert.deepEqual(composeBar.getComposeBarHistory("session-1"), []);
  assert.equal(notified, 1);

  unsubscribe();
});
