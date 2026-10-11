import test from "node:test";
import assert from "node:assert/strict";

type StorageEventLike = { key: string | null; newValue: string | null };
type StorageListener = (event: StorageEventLike) => void;

const COMMAND_HISTORY_STORAGE_KEY = "netcatty:commandHistory";

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
 * the DOM globals must exist before the dynamic import below.
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
    },
    configurable: true,
  });
  return (key: string, newValue: string | null) => {
    for (const listener of listeners) listener({ key, newValue });
  };
}

const storage = installLocalStorage();
const dispatchStorageEvent = installWindow();

const {
  clearHistory,
  flushCommandHistoryStore,
  queryHistory,
  recordCommand,
} = await import("./autocomplete/commandHistoryStore.ts");

function readPersistedCommands(): string[] {
  const raw = storage.get(COMMAND_HISTORY_STORAGE_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { entries: Array<{ command: string }> };
  return parsed.entries.map((entry) => entry.command);
}

test("an external clear invalidates the cached history and cannot be resurrected", () => {
  storage.clear();
  clearHistory();

  recordCommand("stale-command --flag", "host-1");
  flushCommandHistoryStore();
  assert.ok(queryHistory("stale", { hostId: "host-1" }).length > 0);

  // Simulate another renderer (main window or a detached terminal popup)
  // clearing the shared localStorage entry.
  const cleared = JSON.stringify({ entries: [], version: 1 });
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
