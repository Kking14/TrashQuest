import assert from 'node:assert/strict';
import test from 'node:test';
import Bin from '../src/models/binModel.js';
import Disposal from '../src/models/disposalModel.js';
import Quest from '../src/models/questModel.js';
import User from '../src/models/userModel.js';
import { getAdminOverview } from '../src/services/overviewService.js';

test('admin overview uses all-time totals and paged resident activity', async (t) => {
    let questFilter;
    let binFilter;
    let skipped;
    t.mock.method(User, 'aggregate', async () => [{ total: 240 }]);
    t.mock.method(User, 'countDocuments', async () => 26);
    t.mock.method(User, 'find', () => ({
        select() { return this; },
        sort() { return this; },
        skip(value) { skipped = value; return this; },
        limit() { return this; },
        async lean() { return [{ _id: 'resident-2', name: 'Resident Two', email: 'two@example.com' }]; },
    }));
    t.mock.method(Disposal, 'aggregate', async (pipeline) => pipeline[0].$match
        ? [{ _id: 'resident-2', disposals: 7, itemCount: 18, earnedPoints: 90, lastActivity: new Date('2026-09-20') }]
        : [{ items: 1234 }]);
    t.mock.method(Quest, 'countDocuments', async (filter) => { questFilter = filter; return 3; });
    t.mock.method(Bin, 'countDocuments', async (filter) => { binFilter = filter; return 2; });

    const overview = await getAdminOverview(2);

    assert.deepEqual(overview.metrics, {
        residentPointBalance: 240,
        itemsRecorded: 1234,
        currentQuests: 3,
        binsNeedingCollection: 2,
    });
    assert.equal(skipped, 25);
    assert.deepEqual(overview.pagination, { page: 2, pages: 2, total: 26 });
    assert.equal(overview.residents[0].itemCount, 18);
    assert.equal(overview.residents[0].earnedPoints, 90);
    assert.equal(questFilter.status, 'active');
    assert.ok(questFilter.$or.some((condition) => condition.startDate?.$lte instanceof Date));
    assert.deepEqual(binFilter, { $or: [{ status: 'needs_collection' }, { isFull: true }] });
});
