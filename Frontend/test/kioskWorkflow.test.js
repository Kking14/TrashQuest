import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('  function handleWasteSorted(event)'), source.indexOf('  async function waitForNextItem()'));

test('sorted items wait for the done choice and accumulate without generating QR', () => {
  let items = [];
  let state;
  const context = vm.createContext({
    binWasteOptions: [{ value: 'Paper' }, { value: 'Plastic' }],
    setItems: (update) => { items = update(items); },
    setDetectedItem: (update) => update(null),
    setBusy: () => {},
    setNotice: () => {},
    setDisplayState: (next) => { state = next; },
    finishSession: () => assert.fail('QR must wait for the resident to choose Done'),
    window: { setTimeout: () => assert.fail('Sorting must not schedule QR generation') },
  });
  vm.runInContext(handler, context);
  context.handleWasteSorted({ detectionId: 'paper-1', wasteType: 'Paper', itemCount: 1, pointsAvailable: 5 });
  assert.equal(state, 'recognized');
  context.handleWasteSorted({ detectionId: 'plastic-2', wasteType: 'Plastic', itemCount: 1, pointsAvailable: 10 });
  assert.equal(state, 'recognized');
  assert.equal(items.length, 2);
  assert.equal(items.reduce((sum, item) => sum + item.pointsAvailable, 0), 15);
  context.handleWasteSorted({ detectionId: 'plastic-2', wasteType: 'Plastic', itemCount: 1, pointsAvailable: 10 });
  assert.equal(items.length, 2);
});

test('two papers then one paper display three items and fifteen points before Done', () => {
  let items = [];
  let state;
  const context = vm.createContext({
    binWasteOptions: [{ value: 'Paper' }],
    setItems: (update) => { items = update(items); },
    setDetectedItem: (update) => update(null),
    setBusy: () => {}, setNotice: () => {},
    setDisplayState: (next) => { state = next; },
    finishSession: () => assert.fail('QR must wait for Done'),
  });
  vm.runInContext(handler, context);
  context.handleWasteSorted({ detectionId: 'batch-1', wasteType: 'Paper', itemCount: 2, pointsAvailable: 10 });
  context.handleWasteSorted({ detectionId: 'batch-2', wasteType: 'Paper', itemCount: 1, pointsAvailable: 5 });
  assert.equal(items.reduce((sum, item) => sum + item.itemCount, 0), 3);
  assert.equal(items.reduce((sum, item) => sum + item.pointsAvailable, 0), 15);
  assert.equal(state, 'recognized');
});
