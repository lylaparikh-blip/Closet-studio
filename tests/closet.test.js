const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function createFakeIndexedDB(initialRecords = []) {
  const records = new Map(initialRecords.map((record) => [record.id, record]));
  let failWrites = false;

  const makeRequest = (tx, operation) => {
    const request = {};
    tx.pending += 1;
    queueMicrotask(() => {
      if (failWrites && tx.mode === 'readwrite') {
        request.error = new Error('IndexedDB write failed');
        tx.error = request.error;
        request.onerror?.();
        tx.onerror?.();
        return;
      }
      request.result = operation();
      request.onsuccess?.();
      tx.pending -= 1;
      if (tx.pending === 0) queueMicrotask(() => tx.oncomplete?.());
    });
    return request;
  };

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction(_name, mode = 'readonly') {
      const tx = {
        mode,
        pending: 0,
        objectStore() {
          return {
            getAll: () => makeRequest(tx, () => [...records.values()]),
            put: (record) => makeRequest(tx, () => records.set(record.id, record)),
            delete: (id) => makeRequest(tx, () => records.delete(id)),
          };
        },
      };
      return tx;
    },
  };

  return {
    api: {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = db;
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    },
    records,
    setFailure(value) { failWrites = value; },
  };
}

function loadApp(options = {}) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const readers = [];
  const alerts = [];
  const canvases = [];
  const encodingCalls = [];
  const createdUrls = [];
  const revokedUrls = [];
  const elements = new Map();

  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: id === 'filter' ? 'all' : '',
        files: [],
        innerHTML: '',
        textContent: '',
        disabled: false,
        classList: { add() {}, remove() {}, toggle() {} },
        showModal() {},
        close() {},
      });
    }
    return elements.get(id);
  };

  class FakeFileReader {
    constructor() { readers.push(this); }
    readAsDataURL() {}
  }

  class FakeImage {
    set src(value) {
      this._src = value;
      this.width = 2400;
      this.height = 1600;
      queueMicrotask(() => this.onload());
    }
  }

  const storage = new Map(Object.entries(options.localStorageValues || {}));
  const fakeIndexedDB = createFakeIndexedDB(options.indexedDbRecords || []);
  if (options.failIndexedDbWrite) fakeIndexedDB.setFailure(true);
  let storageFailure = false;
  const context = vm.createContext({
    console,
    queueMicrotask,
    Date,
    Math,
    Promise,
    Number,
    Error,
    FileReader: FakeFileReader,
    Image: FakeImage,
    Blob,
    Uint8Array,
    atob,
    indexedDB: fakeIndexedDB.api,
    alert: (message) => alerts.push(message),
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => {
        if (storageFailure) throw new Error('QuotaExceededError');
        storage.set(key, value);
      },
    },
    document: {
      getElementById: element,
      querySelectorAll: () => [],
      createElement: (tag) => {
        assert.equal(tag, 'canvas');
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          toDataURL: (...args) => {
            encodingCalls.push(args);
            return 'data:image/jpeg;base64,small';
          },
          toBlob: (callback, ...args) => {
            encodingCalls.push(args);
            callback(new Blob(['compressed-photo'], { type: 'image/jpeg' }));
          },
        };
        canvases.push(canvas);
        return canvas;
      },
    },
    window: { scrollTo() {} },
    URL: {
      createObjectURL: () => {
        const value = `blob:test-${createdUrls.length + 1}`;
        createdUrls.push(value);
        return value;
      },
      revokeObjectURL: (value) => revokedUrls.push(value),
    },
    fetch: async () => ({ json: async () => ({ items: [] }) }),
  });

  vm.runInContext(script, context);
  return {
    context,
    readers,
    alerts,
    canvases,
    encodingCalls,
    createdUrls,
    revokedUrls,
    element,
    setStorageFailure: (value) => { storageFailure = value; },
    storage,
    indexedDbRecords: fakeIndexedDB.records,
    setIndexedDbFailure: (value) => fakeIndexedDB.setFailure(value),
  };
}

test('IndexedDB storage reads, writes, and deletes complete item records', async () => {
  const app = loadApp({
    indexedDbRecords: [{ id: 9, name: 'Boots', category: 'shoes', photo: null }],
  });

  const stored = await vm.runInContext('getStoredItems()', app.context);
  assert.equal(stored[0].name, 'Boots');

  await vm.runInContext("putStoredItem({id:10,name:'Hat',category:'accessory',photo:null})", app.context);
  assert.equal(app.indexedDbRecords.get(10).name, 'Hat');

  await vm.runInContext('deleteStoredItem(10)', app.context);
  assert.equal(app.indexedDbRecords.has(10), false);
});

test('legacy localStorage items migrate once and retain their photos', async () => {
  const legacy = [{
    id: 20,
    name: 'Coat',
    category: 'top',
    image: 'data:image/jpeg;base64,YQ==',
  }];
  const app = loadApp({ localStorageValues: { closetItems: JSON.stringify(legacy) } });

  await vm.runInContext('appReady', app.context);

  const stored = app.indexedDbRecords.get(20);
  assert.equal(stored.name, 'Coat');
  assert.equal(stored.image, undefined);
  assert.equal(stored.photo.type, 'image/jpeg');
  assert.equal(app.storage.has('closetItems'), false);
});

test('failed legacy migration leaves the complete legacy closet untouched', async () => {
  const serialized = JSON.stringify([{ id: 21, name: 'Dress', category: 'dress' }]);
  const app = loadApp({
    localStorageValues: { closetItems: serialized },
    failIndexedDbWrite: true,
  });

  await assert.rejects(vm.runInContext('appReady', app.context));
  assert.equal(app.storage.get('closetItems'), serialized);
  assert.equal(app.indexedDbRecords.size, 0);
});

test('starter items seed only when IndexedDB and legacy storage are empty', async () => {
  const empty = loadApp();
  await vm.runInContext('appReady', empty.context);
  assert.equal(empty.indexedDbRecords.size, 5);

  const existing = loadApp({
    indexedDbRecords: [{ id: 40, name: 'Existing', category: 'top' }],
  });
  await vm.runInContext('appReady', existing.context);
  assert.deepEqual([...existing.indexedDbRecords.keys()], [40]);
});

test('a second Add click is ignored while an image is being prepared', async () => {
  const app = loadApp();
  await vm.runInContext('appReady', app.context);
  app.element('itemName').value = 'Blue sweater';
  app.element('itemCategory').value = 'top';
  app.element('itemImage').files = [{ type: 'image/png' }];

  const firstAdd = vm.runInContext('addItem()', app.context);
  vm.runInContext('addItem()', app.context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.readers.length, 1);

  app.readers[0].result = 'data:image/png;base64,very-large-original';
  app.readers[0].onload();
  await firstAdd;

  assert.equal(vm.runInContext('items.length', app.context), 6);
});

test('uploaded photos are resized into blobs before they are saved', async () => {
  const app = loadApp();
  await vm.runInContext('appReady', app.context);
  app.element('itemName').value = 'Blue sweater';
  app.element('itemCategory').value = 'top';
  app.element('itemImage').files = [{ type: 'image/png' }];

  const pendingAdd = vm.runInContext('addItem()', app.context);
  await new Promise((resolve) => setImmediate(resolve));
  app.readers[0].result = 'data:image/png;base64,very-large-original';
  app.readers[0].onload();
  await pendingAdd;

  const stored = app.indexedDbRecords.get(vm.runInContext('items.at(-1).id', app.context));
  assert.equal(stored.photo.type, 'image/jpeg');
  assert.equal(stored.image, undefined);
  assert.deepEqual(
    { width: app.canvases[0].width, height: app.canvases[0].height },
    { width: 800, height: 533 },
  );
  assert.deepEqual(app.encodingCalls[0], ['image/jpeg', 0.7]);
});

test('a storage failure does not leave a phantom item or lock the form', async () => {
  const app = loadApp();
  await vm.runInContext('appReady', app.context);
  app.element('itemName').value = 'Blue sweater';
  app.element('itemCategory').value = 'top';
  app.setIndexedDbFailure(true);

  await vm.runInContext('addItem()', app.context);
  assert.equal(vm.runInContext('items.length', app.context), 5);
  assert.match(app.alerts.at(-1), /couldn't save/i);

  app.setIndexedDbFailure(false);
  await vm.runInContext('addItem()', app.context);
  assert.equal(vm.runInContext('items.length', app.context), 6);
});

test('removing an item deletes its IndexedDB record before hiding it', async () => {
  const app = loadApp({
    indexedDbRecords: [{ id: 50, name: 'Jacket', category: 'top' }],
  });
  await vm.runInContext('appReady', app.context);

  await vm.runInContext('deleteItem(50)', app.context);

  assert.equal(app.indexedDbRecords.has(50), false);
  assert.equal(vm.runInContext('items.length', app.context), 0);
});

test('failed IndexedDB deletion preserves the visible item', async () => {
  const app = loadApp({
    indexedDbRecords: [{ id: 51, name: 'Skirt', category: 'bottom' }],
  });
  await vm.runInContext('appReady', app.context);
  app.setIndexedDbFailure(true);

  await vm.runInContext('deleteItem(51)', app.context);

  assert.equal(app.indexedDbRecords.has(51), true);
  assert.equal(vm.runInContext('items[0].name', app.context), 'Skirt');
  assert.match(app.alerts.at(-1), /couldn't remove/i);
});

test('rerendering revokes photo object URLs that are no longer displayed', async () => {
  const photo = new Blob(['photo'], { type: 'image/jpeg' });
  const app = loadApp({
    indexedDbRecords: [{ id: 52, name: 'Top', category: 'top', photo }],
  });
  await vm.runInContext('appReady', app.context);

  vm.runInContext('renderCloset()', app.context);

  assert.deepEqual(app.revokedUrls, ['blob:test-1']);
  assert.deepEqual(app.createdUrls, ['blob:test-1', 'blob:test-2']);
});

test('adding a photo leaves the rendered closet image URL active', async () => {
  const app = loadApp();
  await vm.runInContext('appReady', app.context);
  app.element('itemName').value = 'Sweater';
  app.element('itemCategory').value = 'top';
  app.element('itemImage').files = [{ type: 'image/png' }];

  const pendingAdd = vm.runInContext('addItem()', app.context);
  await new Promise((resolve) => setImmediate(resolve));
  app.readers[0].result = 'data:image/png;base64,YQ==';
  app.readers[0].onload();
  await pendingAdd;

  const renderedUrl = app.createdUrls.at(-1);
  assert.match(app.element('closetGrid').innerHTML, new RegExp(renderedUrl));
  assert.equal(app.revokedUrls.includes(renderedUrl), false);
});
