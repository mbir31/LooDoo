/**
 * Minimal in-memory Firestore double.
 *
 * It implements just the surface LooDoo touches (doc/collection refs, getDoc,
 * getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query helpers) so the
 * multiplayer transport can be exercised in tests - including several
 * independent "clients" that share one database.
 *
 * State lives on globalThis so that `vi.resetModules()` can produce fresh
 * service instances (fresh local caches) while the database stays shared.
 */

export interface FakeDbState {
  docs: Map<string, any>;
  listeners: Map<string, Array<{ id: number; cb: (snap: any) => void; err?: (e: any) => void }>>;
  snapshotCache: Map<string, Map<string, any>>;
  writes: number;
  failWrites: boolean;
  offline: boolean;
}

const KEY = '__loodoo_fake_db__';

export function getFakeDb(): FakeDbState {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = {
      docs: new Map<string, any>(),
      listeners: new Map<string, any[]>(),
      snapshotCache: new Map<string, Map<string, any>>(),
      writes: 0,
      failWrites: false,
      offline: false,
    } satisfies FakeDbState;
  }
  return g[KEY] as FakeDbState;
}

export function resetFakeDb(): void {
  const g = globalThis as any;
  g[KEY] = undefined;
  getFakeDb();
}

let listenerSeq = 0;
let autoIdSeq = 0;

/** Firestore-style random document id (20 chars, roughly base62). */
function autoId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 20; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  autoIdSeq += 1;
  return `${out.slice(0, 18)}${String(autoIdSeq % 100).padStart(2, '0')}`;
}

export interface FakeRef {
  path: string;
  id: string;
  parentPath: string;
  isCollection: boolean;
}

export interface FakeQuery {
  path: string;
  isCollection: boolean;
  constraints: Array<{ type: string; field?: string; op?: string; value?: any; n?: number }>;
}

function ref(path: string, isCollection: boolean): FakeRef {
  const parts = path.split('/');
  return {
    path,
    id: parts[parts.length - 1],
    parentPath: parts.slice(0, -1).join('/'),
    isCollection,
  };
}

function childDocs(state: FakeDbState, collectionPath: string): Array<{ id: string; ref: FakeRef; data: any }> {
  const result: Array<{ id: string; ref: FakeRef; data: any }> = [];
  for (const [path, data] of state.docs.entries()) {
    const parts = path.split('/');
    if (parts.length % 2 !== 0) continue; // collections have odd segment counts
    const parent = parts.slice(0, -1).join('/');
    if (parent === collectionPath) {
      result.push({ id: parts[parts.length - 1], ref: ref(path, false), data });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function applyConstraints(
  entries: Array<{ id: string; ref: FakeRef; data: any }>,
  constraints: FakeQuery['constraints']
) {
  let out = entries;
  for (const c of constraints) {
    if (c.type === 'where' && c.field) {
      out = out.filter((e) => (e.data as any)?.[c.field!] === c.value);
    }
    if (c.type === 'orderBy' && c.field) {
      const field = c.field;
      out = out.slice().sort((a, b) => {
        const av = (a.data as any)?.[field];
        const bv = (b.data as any)?.[field];
        return (av ?? 0) > (bv ?? 0) ? 1 : (av ?? 0) < (bv ?? 0) ? -1 : 0;
      });
    }
    if (c.type === 'limit') {
      out = out.slice(0, c.n ?? 1);
    }
  }
  return out;
}

function makeQuerySnapshot(
  state: FakeDbState,
  key: string,
  entries: Array<{ id: string; ref: FakeRef; data: any }>
) {
  const previous = state.snapshotCache.get(key) ?? new Map<string, any>();
  const docs = entries.map((e) => ({
    id: e.id,
    ref: e.ref,
    exists: () => true,
    data: () => e.data,
  }));

  const changes: any[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = entry.id;
    seen.add(id);
    const before = previous.get(id);
    if (before === undefined) {
      changes.push({ type: 'added', doc: docs.find((d) => d.id === id) });
    } else if (JSON.stringify(before) !== JSON.stringify(entry.data)) {
      changes.push({ type: 'modified', doc: docs.find((d) => d.id === id) });
    }
  }
  for (const id of previous.keys()) {
    if (!seen.has(id)) {
      changes.push({
        type: 'removed',
        doc: { id, ref: ref(`${key.split('::')[0]}/${id}`, false), data: () => previous.get(id) },
      });
    }
  }

  const next = new Map<string, any>();
  for (const entry of entries) next.set(entry.id, entry.data);
  state.snapshotCache.set(key, next);

  return {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    docChanges: () => changes,
    forEach: (cb: (doc: any) => void) => docs.forEach(cb),
  };
}

function notify(state: FakeDbState, path: string): void {
  const docData = state.docs.has(path) ? state.docs.get(path) : undefined;

  for (const [key, listeners] of state.listeners.entries()) {
    if (listeners.length === 0) continue;

    // Document listener: key === path
    if (key === path) {
      const snap = {
        exists: () => docData !== undefined,
        id: path.split('/').pop(),
        ref: ref(path, false),
        data: () => docData,
      };
      listeners.forEach((l) => l.cb(snap));
      continue;
    }

    // Collection / query listener: key === `${path}::${constraints}`
    if (key.startsWith(`${path}::`)) {
      const constraints: FakeQuery['constraints'] = JSON.parse(key.slice(path.length + 2) || '[]');
      const entries = applyConstraints(childDocs(state, path), constraints);
      const snap = makeQuerySnapshot(state, key, entries);
      listeners.forEach((l) => l.cb(snap));
    }
  }
}

export function fakeFirestoreModule() {
  return {
    // --- refs -------------------------------------------------------------
    // Supports `doc(db, 'rooms', id)`, `doc(collectionRef, docId)` and the
    // auto-id form `doc(collectionRef)` / `doc(db, 'rooms')` that the app uses
    // for reactions and P2P signalling.
    doc: (dbRef: any, ...segments: string[]) => {
      if (segments.length === 0) {
        if (dbRef && typeof dbRef === 'object' && typeof dbRef.path === 'string') {
          return ref(`${dbRef.path}/${autoId()}`, false);
        }
        throw new Error('fake firestore: doc() needs a path');
      }
      const base = dbRef && typeof dbRef === 'object' && typeof dbRef.path === 'string' ? dbRef.path : '';
      return ref(base ? `${base}/${segments.join('/')}` : segments.join('/'), false);
    },
    collection: (dbRef: any, ...segments: string[]) => {
      if (segments.length === 0) {
        if (dbRef && typeof dbRef === 'object' && typeof dbRef.path === 'string') {
          return ref(`${dbRef.path}/${autoId()}`, true);
        }
        throw new Error('fake firestore: collection() needs a path');
      }
      const base = dbRef && typeof dbRef === 'object' && typeof dbRef.path === 'string' ? dbRef.path : '';
      return ref(base ? `${base}/${segments.join('/')}` : segments.join('/'), true);
    },
    // --- query helpers ----------------------------------------------------
    query: (source: FakeRef | FakeQuery, ...constraints: any[]) => ({
      path: (source as any).path,
      isCollection: true,
      constraints: constraints.filter(Boolean),
    }),
    where: (field: string, op: string, value: any) => ({ type: 'where', field, op, value }),
    orderBy: (field: string, dir?: string) => ({ type: 'orderBy', field, dir }),
    limit: (n: number) => ({ type: 'limit', n }),

    // --- reads ------------------------------------------------------------
    getDoc: async (refOrQuery: any) => {
      const state = getFakeDb();
      if (state.offline) throw new Error('unavailable');
      const data = state.docs.get(refOrQuery.path);
      return {
        exists: () => data !== undefined,
        id: refOrQuery.id,
        ref: refOrQuery,
        data: () => data,
      };
    },
    getDocs: async (refOrQuery: any) => {
      const state = getFakeDb();
      if (state.offline) throw new Error('unavailable');
      const constraints = (refOrQuery as FakeQuery).constraints ?? [];
      const entries = applyConstraints(childDocs(state, refOrQuery.path), constraints);
      return makeQuerySnapshot(state, `${refOrQuery.path}::${JSON.stringify(constraints)}`, entries);
    },

    // --- writes -----------------------------------------------------------
    setDoc: async (refOrQuery: any, data: any) => {
      const state = getFakeDb();
      state.writes += 1;
      if (state.failWrites) throw new Error('permission-denied');
      if (state.offline) throw new Error('unavailable');
      state.docs.set(refOrQuery.path, JSON.parse(JSON.stringify(data)));
      notify(state, refOrQuery.path);
      notify(state, refOrQuery.parentPath);
    },
    updateDoc: async (refOrQuery: any, partial: any) => {
      const state = getFakeDb();
      state.writes += 1;
      if (state.failWrites) throw new Error('permission-denied');
      if (state.offline) throw new Error('unavailable');
      const existing = state.docs.get(refOrQuery.path) ?? {};
      state.docs.set(refOrQuery.path, { ...existing, ...JSON.parse(JSON.stringify(partial)) });
      notify(state, refOrQuery.path);
      notify(state, refOrQuery.parentPath);
    },
    deleteDoc: async (refOrQuery: any) => {
      const state = getFakeDb();
      state.writes += 1;
      if (state.failWrites) throw new Error('permission-denied');
      if (state.offline) throw new Error('unavailable');
      state.docs.delete(refOrQuery.path);
      notify(state, refOrQuery.path);
      notify(state, refOrQuery.parentPath);
    },

    // --- realtime ---------------------------------------------------------
    onSnapshot: (refOrQuery: any, cb: any, errCb?: any) => {
      const state = getFakeDb();
      const constraints = (refOrQuery as FakeQuery).constraints;
      const key = refOrQuery.isCollection === false
        ? refOrQuery.path
        : `${refOrQuery.path}::${JSON.stringify(constraints ?? [])}`;
      if (!state.listeners.has(key)) state.listeners.set(key, []);
      const id = ++listenerSeq;
      state.listeners.get(key)!.push({ id, cb, err: errCb });

      // Deliver the current value immediately (mirrors Firestore behaviour).
      // notify() expects a *path*, not the listener key.
      Promise.resolve().then(() => notify(state, refOrQuery.path));

      return () => {
        const arr = state.listeners.get(key);
        if (!arr) return;
        const idx = arr.findIndex((l) => l.id === id);
        if (idx >= 0) arr.splice(idx, 1);
      };
    },

    enableNetwork: async () => {
      getFakeDb().offline = false;
    },
    disableNetwork: async () => {
      getFakeDb().offline = true;
    },
  };
}

/** Test helper: read a document straight out of the fake database. */
export function peekDoc(path: string): any {
  return getFakeDb().docs.get(path);
}
