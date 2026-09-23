import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_REWARD_IMAGE_BYTES, validateRewardImage } from '../src/utils/rewardImage.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test('accepts a small JPEG reward photo', () => {
    assert.doesNotThrow(() => validateRewardImage(jpeg, 'image/jpeg'));
});

test('rejects a wrong content type or non-JPEG bytes', () => {
    assert.throws(() => validateRewardImage(jpeg, 'image/png'), /JPEG/);
    assert.throws(() => validateRewardImage(Buffer.from('not an image'), 'image/jpeg'), /not a JPEG/);
});

test('rejects an oversized reward photo', () => {
    const oversized = Buffer.alloc(MAX_REWARD_IMAGE_BYTES + 1);
    oversized.set(jpeg);
    assert.throws(() => validateRewardImage(oversized, 'image/jpeg'), /smaller than 400 KB/);
});
