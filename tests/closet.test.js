const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function loadApp() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const readers = [];
  const alerts = [];
  const canvases = [];
  const encodingCalls = [];
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

  const storage = new Map();
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
    alert: (message) => alerts.push(message),
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
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
        };
        canvases.push(canvas);
        return canvas;
      },
    },
    window: { scrollTo() {} },
    fetch: async () => ({ json: async () => ({ items: [] }) }),
  });

  vm.runInContext(script, context);
  return {
    context,
    readers,
    alerts,
    canvases,
    encodingCalls,
    element,
    setStorageFailure: (value) => { storageFailure = value; },
  };
}

test('a second Add click is ignored while an image is being prepared', async () => {
  const app = loadApp();
  app.element('itemName').value = 'Blue sweater';
  app.element('itemCategory').value = 'top';
  app.element('itemImage').files = [{ type: 'image/png' }];

  vm.runInContext('addItem(); addItem();', app.context);
  assert.equal(app.readers.length, 1);

  app.readers[0].result = 'data:image/png;base64,very-large-original';
  app.readers[0].onload();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(vm.runInContext('items.length', app.context), 6);
});

test('uploaded photos are resized before they are saved', async () => {
  const app = loadApp();
  app.element('itemName').value = 'Blue sweater';
  app.element('itemCategory').value = 'top';
  app.element('itemImage').files = [{ type: 'image/png' }];

  vm.runInContext('addItem()', app.context);
  app.readers[0].result = 'data:image/png;base64,very-large-original';
  app.readers[0].onload();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(vm.runInContext('items.at(-1).image', app.context), 'data:image/jpeg;base64,small');
  assert.deepEqual(
    { width: app.canvases[0].width, height: app.canvases[0].height },
    { width: 800, height: 533 },
  );
  assert.deepEqual(app.encodingCalls[0], ['image/jpeg', 0.7]);
});

test('a storage failure does not leave a phantom item or lock the form', () => {
  const app = loadApp();
  app.element('itemName').value = 'Blue sweater';
  app.element('itemCategory').value = 'top';
  app.setStorageFailure(true);

  assert.doesNotThrow(() => vm.runInContext('addItem()', app.context));
  assert.equal(vm.runInContext('items.length', app.context), 5);
  assert.match(app.alerts.at(-1), /couldn't save/i);

  app.setStorageFailure(false);
  assert.doesNotThrow(() => vm.runInContext('addItem()', app.context));
  assert.equal(vm.runInContext('items.length', app.context), 6);
});
