import assert from 'node:assert/strict';
import test from 'node:test';
import Quest from '../src/models/questModel.js';
import { listActiveQuests } from '../src/services/questService.js';

test('resident catalog includes scheduled quests while joining remains time-gated', async () => {
    const originalFind = Quest.find;
    const scheduled = {
        _id: 'quest-1', status: 'active',
        startDate: new Date(Date.now() + 60_000),
        expiryDate: new Date(Date.now() + 120_000),
        participants: [],
    };
    try {
        Quest.find = (filter) => {
            const activeClause = filter.$or.find((entry) => entry.status === 'active');
            assert.equal(Object.hasOwn(activeClause, 'startDate'), false);
            return { sort: () => ({ limit: () => ({ lean: async () => [scheduled] }) }) };
        };
        const result = await listActiveQuests({ user: { id: 'resident-1' } });
        assert.equal(result[0]._id, scheduled._id);
    } finally {
        Quest.find = originalFind;
    }
});
