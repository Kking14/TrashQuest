import assert from 'node:assert/strict';
import test from 'node:test';
import { createDisposalSession, getDisposalSessionTokens, selectAvailableClaims } from '../src/services/disposalService.js';
import DisposalClaim from '../src/models/disposalClaimModel.js';
import DisposalSession from '../src/models/disposalSessionModel.js';

const now = new Date('2026-09-25T10:00:00.000Z');

test('keeps successful pending claims when an earlier one has expired', () => {
    const claims = [
        { claimToken: 'old', status: 'pending', expiresAt: new Date('2026-09-25T09:59:59.000Z') },
        { claimToken: 'new', status: 'pending', expiresAt: new Date('2026-09-25T10:10:00.000Z') },
    ];
    const result = selectAvailableClaims(['old', 'new'], claims, now);
    assert.deepEqual(result.availableClaims.map((claim) => claim.claimToken), ['new']);
    assert.equal(result.skippedClaimCount, 1);
});

test('does not include claimed or missing tokens and de-duplicates retries', () => {
    const claims = [
        { claimToken: 'used', status: 'claimed', expiresAt: new Date('2026-09-25T10:10:00.000Z') },
        { claimToken: 'valid', status: 'pending', expiresAt: new Date('2026-09-25T10:10:00.000Z') },
    ];
    const result = selectAvailableClaims(['used', 'valid', 'valid', 'missing'], claims, now);
    assert.deepEqual(result.availableClaims.map((claim) => claim.claimToken), ['valid']);
    assert.equal(result.skippedClaimCount, 2);
});

test('older session remains redeemable while a later claim is pending', async () => {
    const originalSessionFind = DisposalSession.findOne;
    const originalSessionUpdate = DisposalSession.findOneAndUpdate;
    const originalClaimFind = DisposalClaim.findOne;
    const session = { code: 'TQ-ABC234', status: 'available', bin: 'bin-1',
        claimTokens: ['expired', 'valid'], expiresAt: new Date(0) };
    try {
        DisposalSession.findOne = async () => session;
        DisposalClaim.findOne = () => ({ select: () => ({ lean: async () => ({ _id: 'valid' }) }) });
        DisposalSession.findOneAndUpdate = async (query) => {
            assert.equal(query.code, session.code);
            assert.equal(Object.hasOwn(query, 'expiresAt'), false);
            return session;
        };
        assert.equal(await getDisposalSessionTokens(session.code, 'resident-1'), session);
    } finally {
        DisposalSession.findOne = originalSessionFind;
        DisposalSession.findOneAndUpdate = originalSessionUpdate;
        DisposalClaim.findOne = originalClaimFind;
    }
});

test('session creation records only valid successes and reports skipped claims', async () => {
    const originalClaimFind = DisposalClaim.find;
    const originalSessionCreate = DisposalSession.create;
    const bin = { _id: 'bin-1' };
    const claims = [
        { claimToken: 'expired', itemCount: 1, status: 'pending', expiresAt: new Date(0) },
        { claimToken: 'valid', itemCount: 2, status: 'pending', expiresAt: new Date(Date.now() + 60_000) },
    ];
    try {
        DisposalClaim.find = async () => claims;
        DisposalSession.create = async (session) => session;
        const result = await createDisposalSession(bin, ['expired', 'valid']);
        assert.deepEqual(result.session.claimTokens, ['valid']);
        assert.equal(result.session.itemCount, 2);
        assert.equal(result.session.expiresAt.getTime(), claims[1].expiresAt.getTime());
        assert.equal(result.skippedClaimCount, 1);
    } finally {
        DisposalClaim.find = originalClaimFind;
        DisposalSession.create = originalSessionCreate;
    }
});
