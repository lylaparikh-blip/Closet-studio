# IndexedDB Closet Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store at least 100 photographed closet items locally in current Safari and Chrome without accounts, a backend, or files beyond the existing static app and its tests.

**Architecture:** IndexedDB becomes the durable store for complete closet-item records, including compressed JPEG blobs. The app retains its in-memory item array and keeps saved outfit ID lists in localStorage; a one-time transaction migrates legacy localStorage items before deleting the old copy.

**Tech Stack:** HTML, browser JavaScript, IndexedDB, Canvas and Blob APIs, Node.js built-in test runner and VM.

## Global Constraints

- Keep the application in `index.html` with no build step or backend.
- Do not require accounts or collect identity information.
- Keep closets local to each browser and device.
- Preserve existing closet data during the upgrade.
- Resize uploaded photos to a maximum dimension of 800 pixels and encode them as JPEG blobs at 70% quality.
- Keep saved outfits in `localStorage` as arrays of item IDs.
- Do not update visible in-memory state until the corresponding IndexedDB write succeeds.

---

### Task 1: IndexedDB item storage adapter

**Files:**
- Modify: `index.html`
- Modify: `tests/closet.test.js`

**Interfaces:**
- Consumes: Browser `indexedDB` implementation.
- Produces: `openClosetDb() -> Promise<IDBDatabase>`, `getStoredItems() -> Promise<Item[]>`, `putStoredItem(item) -> Promise<void>`, and `deleteStoredItem(id) -> Promise<void>`.

- [ ] **Step 1: Extend the test harness with a deterministic IndexedDB fake**

Add `createFakeIndexedDB(initialRecords = [])` to `tests/closet.test.js`. Its `open('closetStudio', 1)` request must trigger `onupgradeneeded`, expose an `items` object store keyed by `id`, and implement asynchronous `getAll`, `put`, and `delete` requests plus transaction `oncomplete`/`onerror` callbacks. Return `{ api, records, failNextTransaction() }` so tests assert durable records rather than fake call counts.

- [ ] **Step 2: Write failing adapter behavior tests**

Add tests with literal expected records:

```js
test('IndexedDB storage reads, writes, and deletes complete item records', async () => {
  const stored = [{ id: 9, name: 'Boots', category: 'shoes', photo: null }];
  const app = loadApp({ indexedDbRecords: stored });
  await vm.runInContext('appReady', app.context);
  assert.equal(vm.runInContext('items[0].name', app.context), 'Boots');

  await vm.runInContext("putStoredItem({id:10,name:'Hat',category:'accessory',photo:null})", app.context);
  assert.equal(app.indexedDbRecords.get(10).name, 'Hat');

  await vm.runInContext('deleteStoredItem(10)', app.context);
  assert.equal(app.indexedDbRecords.has(10), false);
});
```

- [ ] **Step 3: Run the adapter test and verify RED**

Run: `node --test --test-name-pattern="IndexedDB storage" tests/closet.test.js`

Expected: FAIL because `appReady`, `putStoredItem`, and `deleteStoredItem` do not exist.

- [ ] **Step 4: Implement the minimal adapter in `index.html`**

Add constants `DB_NAME = 'closetStudio'`, `DB_VERSION = 1`, and `ITEM_STORE = 'items'`. `openClosetDb` creates the object store with `{ keyPath: 'id' }` during upgrade. Each operation wraps request and transaction completion in a Promise, rejects with the original request or transaction error, and closes no shared database connection during the page lifecycle.

- [ ] **Step 5: Run the complete suite and verify GREEN**

Run: `node --test tests/closet.test.js`

Expected: all tests PASS with no uncaught errors.

- [ ] **Step 6: Commit the adapter**

```bash
git add index.html tests/closet.test.js
git commit -m "Add IndexedDB closet storage adapter"
```

### Task 2: Safe legacy migration and initialization

**Files:**
- Modify: `index.html`
- Modify: `tests/closet.test.js`

**Interfaces:**
- Consumes: Task 1 storage functions and `dataUrlToBlob(dataUrl) -> Blob`.
- Produces: `migrateLegacyItems() -> Promise<boolean>`, `initializeCloset() -> Promise<void>`, and global `appReady` startup promise.

- [ ] **Step 1: Write failing migration tests**

Add separate tests proving:

```js
test('legacy localStorage items migrate once and retain their photos', async () => {
  const legacy = [{ id: 20, name: 'Coat', category: 'top', image: 'data:image/jpeg;base64,YQ==' }];
  const app = loadApp({ localStorageValues: { closetItems: JSON.stringify(legacy) } });
  await vm.runInContext('appReady', app.context);
  const stored = app.indexedDbRecords.get(20);
  assert.equal(stored.name, 'Coat');
  assert.equal(stored.image, undefined);
  assert.equal(stored.photo.type, 'image/jpeg');
  assert.equal(app.storage.has('closetItems'), false);
});

test('failed migration leaves the complete legacy closet untouched', async () => {
  const serialized = JSON.stringify([{ id: 21, name: 'Dress', category: 'dress' }]);
  const app = loadApp({ localStorageValues: { closetItems: serialized }, failIndexedDbWrite: true });
  await assert.rejects(vm.runInContext('appReady', app.context));
  assert.equal(app.storage.get('closetItems'), serialized);
  assert.equal(app.indexedDbRecords.size, 0);
});
```

Also test that starter items are inserted only when both IndexedDB and legacy storage are empty.

- [ ] **Step 2: Run migration tests and verify RED**

Run: `node --test --test-name-pattern="legacy|starter" tests/closet.test.js`

Expected: FAIL because migration and asynchronous initialization are absent.

- [ ] **Step 3: Implement migration and startup**

Implement `dataUrlToBlob` by splitting the data URL at the comma, decoding base64 with `atob`, copying bytes into `Uint8Array`, and constructing a Blob with the declared MIME type. Migrate all legacy items in one read-write transaction. Delete `localStorage.getItem('closetItems')` only from the transaction's `oncomplete` path. If no data exists, persist `starterItems` into IndexedDB. Set `appReady = initializeCloset()` and call initial rendering only after it resolves.

- [ ] **Step 4: Run the complete suite and verify GREEN**

Run: `node --test tests/closet.test.js`

Expected: all migration, seeding, and existing behavior tests PASS.

- [ ] **Step 5: Commit migration and initialization**

```bash
git add index.html tests/closet.test.js
git commit -m "Migrate closet items to IndexedDB"
```

### Task 3: Blob-based add, display, and remove flows

**Files:**
- Modify: `index.html`
- Modify: `tests/closet.test.js`

**Interfaces:**
- Consumes: Task 1 item operations and Task 2 `appReady`.
- Produces: `resizeImage(file, onSuccess, onError)` returning an 800-pixel, 70%-quality JPEG Blob; `photoUrl(item) -> string`; and `releasePhotoUrls() -> void`.

- [ ] **Step 1: Write failing add and delete sequencing tests**

Adapt the upload fake to implement `canvas.toBlob(callback, 'image/jpeg', 0.7)`. Assert that a successful add stores a Blob before the in-memory array grows. Add transaction failure tests asserting the array and rendered closet remain unchanged. Add deletion tests proving the IndexedDB record disappears before the visible item is removed and that failed deletion preserves both.

- [ ] **Step 2: Write failing object-URL lifecycle test**

Supply a fake `URL` object that records real returned values and revocations:

```js
test('rerendering revokes photo object URLs that are no longer displayed', async () => {
  const photo = new Blob(['photo'], { type: 'image/jpeg' });
  const app = loadApp({ indexedDbRecords: [{ id: 30, name: 'Top', category: 'top', photo }] });
  await vm.runInContext('appReady', app.context);
  vm.runInContext('renderCloset(); renderCloset()', app.context);
  assert.deepEqual(app.revokedUrls, ['blob:test-1']);
});
```

- [ ] **Step 3: Run the UI storage tests and verify RED**

Run: `node --test --test-name-pattern="Blob|object URL|failed deletion|successful add" tests/closet.test.js`

Expected: FAIL because image encoding still returns a data URL and UI mutations still use localStorage persistence.

- [ ] **Step 4: Implement Blob encoding and durable sequencing**

Replace `canvas.toDataURL` with `canvas.toBlob`, rejecting a null blob through the existing image error path. `finishAdd` awaits `putStoredItem` before pushing to `items`. `deleteItem` awaits `deleteStoredItem` before filtering `items`. Both paths always release the submission lock or preserve the item on failure.

- [ ] **Step 5: Implement shared photo URL handling**

Keep a `Map<number, string>` of active object URLs. `photoUrl(item)` returns the existing URL or creates one from `item.photo`. `releasePhotoUrls()` revokes every URL and clears the map before full closet rerenders and on `pagehide`. Use `photoUrl` in closet cards, builder slots, and saved outfits. Emoji-only starter items remain unchanged.

- [ ] **Step 6: Run the complete suite and verify GREEN**

Run: `node --test tests/closet.test.js`

Expected: all tests PASS with no warnings or uncaught rejections.

- [ ] **Step 7: Commit the integrated item flows**

```bash
git add index.html tests/closet.test.js
git commit -m "Store closet photos as IndexedDB blobs"
```

### Task 4: Final verification and pull request

**Files:**
- Verify: `index.html`
- Verify: `tests/closet.test.js`
- Verify: `docs/superpowers/specs/2026-08-09-indexeddb-closet-storage-design.md`

**Interfaces:**
- Consumes: Completed Tasks 1–3.
- Produces: Verified branch and draft pull request targeting `lylaparikh-blip/Closet-studio:main`.

- [ ] **Step 1: Run static and regression checks**

Run: `git diff --check && node --test tests/closet.test.js`

Expected: exit code 0 and every test PASS.

- [ ] **Step 2: Inspect the final scope**

Run: `git status -sb && git diff origin/main...HEAD --stat && git log --oneline origin/main..HEAD`

Expected: only the storage implementation, tests, design, and plan appear; no unrelated files.

- [ ] **Step 3: Push the branch to the authenticated fork**

```bash
git push -u fork agent/indexeddb-closet-storage
```

- [ ] **Step 4: Open the draft PR**

Create a draft PR from `vandan:agent/indexeddb-closet-storage` into `lylaparikh-blip/Closet-studio:main`. Its description must explain the localStorage capacity problem, automatic migration, no-account architecture, browser/device isolation, error behavior, and exact verification command.
