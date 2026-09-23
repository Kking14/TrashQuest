import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePickupCode, normalizePickupCode } from '../src/utils/pickupCode.js';

test('pickup codes are formatted, readable, and different', () => {
    const codes = new Set(Array.from({ length: 100 }, generatePickupCode));
    assert.equal(codes.size, 100);
    for (const code of codes) {
        assert.match(code, /^TQ-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
        assert.equal(normalizePickupCode(code), code);
    }
});

test('pickup code entry accepts lowercase and omitted separators', () => {
    assert.equal(normalizePickupCode(' tqabcde23456 '), 'TQ-ABCDE-23456');
    assert.equal(normalizePickupCode('tq-abcde-23456'), 'TQ-ABCDE-23456');
});

test('pickup code entry rejects ambiguous and malformed codes', () => {
    for (const value of ['', 'TQ-ABCDO-23456', 'TQ-ABCDE-2345', null]) {
        assert.throws(() => normalizePickupCode(value), /valid 10-character/);
    }
});
