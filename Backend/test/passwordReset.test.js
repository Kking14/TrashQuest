import assert from 'node:assert/strict';
import test from 'node:test';
import User from '../src/models/userModel.js';
import { hashResetCode } from '../src/services/userService.js';
import { requestPasswordResetEmail, resetPasswordWithCode } from '../src/services/authService.js';

test('emailed password reset code is hashed and can be used only once', async () => {
    const originalFindOne = User.findOne;
    const originalFindById = User.findById;
    const originalFindByIdAndUpdate = User.findByIdAndUpdate;
    const originalFindOneAndUpdate = User.findOneAndUpdate;
    const resident = { _id: 'resident-1', email: 'resident@example.com', role: 'user', status: 'active', password: 'old-hash' };
    let savedHash = null;
    let expiresAt = null;
    let emailPayload = null;
    try {
        User.findOne = () => ({ select: async () => resident });
        User.findById = () => ({ select: async () => resident });
        User.findByIdAndUpdate = async (_id, update) => {
            savedHash = update.$set.passwordResetCodeHash;
            expiresAt = update.$set.passwordResetExpiresAt;
            return resident;
        };
        User.findOneAndUpdate = async (filter, update) => {
            if (filter.passwordResetCodeHash !== savedHash || expiresAt <= filter.passwordResetExpiresAt.$gt) return null;
            resident.password = update.$set.password;
            savedHash = null;
            return resident;
        };
        await requestPasswordResetEmail(resident.email, async (payload) => {
            emailPayload = payload;
        });
        const { code } = emailPayload;
        assert.equal(code.length, 12);
        assert.equal(emailPayload.email, resident.email);
        assert.equal(savedHash, hashResetCode(code));
        assert.notEqual(savedHash, code);
        await resetPasswordWithCode(resident.email, code, 'NewSecurePass123!');
        assert.match(resident.password, /^\$2/);
        await assert.rejects(resetPasswordWithCode(resident.email, code, 'AnotherSecurePass123!'), /Invalid or expired reset code/);
    } finally {
        User.findOne = originalFindOne;
        User.findById = originalFindById;
        User.findByIdAndUpdate = originalFindByIdAndUpdate;
        User.findOneAndUpdate = originalFindOneAndUpdate;
    }
});

test('password reset request does not reveal an unknown email', async () => {
    const originalFindOne = User.findOne;
    let emailSent = false;
    try {
        User.findOne = () => ({ select: async () => null });
        await requestPasswordResetEmail('unknown@example.com', async () => {
            emailSent = true;
        });
        assert.equal(emailSent, false);
    } finally {
        User.findOne = originalFindOne;
    }
});
