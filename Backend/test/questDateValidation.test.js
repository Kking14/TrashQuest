import test from 'node:test';
import assert from 'node:assert/strict';
import Quest from '../src/models/questModel.js';

test('quest rejects an end date earlier than its start date', async () => {
    const quest = new Quest({
        title: 'Invalid schedule',
        targetCount: 1,
        pointsReward: 10,
        startDate: new Date('2026-09-30T08:00:00Z'),
        expiryDate: new Date('2026-09-28T08:00:00Z'),
    });

    await assert.rejects(
        quest.validate(),
        /end date must be later than the start date/i
    );
});

test('quest accepts an end date later than its start date', async () => {
    const quest = new Quest({
        title: 'Valid schedule',
        targetCount: 1,
        pointsReward: 10,
        startDate: new Date('2026-09-28T08:00:00Z'),
        expiryDate: new Date('2026-09-30T08:00:00Z'),
    });

    await assert.doesNotReject(quest.validate());
});
