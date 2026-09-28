import User from '../models/userModel.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { hashResetCode, issuePasswordResetCode } from './userService.js';
import { assertEmailDeliveryConfigured, sendPasswordResetEmail } from './emailService.js';

const registerUser = async (userData) => {
    const { firstName, lastName, middleInitial, email, password } = userData;
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedMiddleInitial = middleInitial?.trim().charAt(0).toUpperCase() || null;
    const name = [firstName.trim(), normalizedMiddleInitial ? `${normalizedMiddleInitial}.` : null, lastName.trim()]
        .filter(Boolean)
        .join(' ');

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
        throw new Error('Email is already registered');
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
        name,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        middleInitial: normalizedMiddleInitial,
        email: normalizedEmail,
        password: hashedPassword,
        // role intentionally omitted - schema default ('user') applies
    });
    return user;
}

const loginUser = async (email, password) => {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
        throw new Error('Invalid email or password');
    } else {
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            throw new Error('Invalid email or password');
        }
    }

    if (user.status === 'inactive') {
        throw new Error('This account has been deactivated');
    }

    const token = jwt.sign({
        id: user._id,
        email: user.email,
        role: user.role,
    }, process.env.JWT_SECRET, {
        expiresIn: '7d',
        issuer: 'trashquest-api',
        audience: 'trashquest-web',
    });
    return { user, token };
};

const resetPasswordWithCode = async (email, code, newPassword) => {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase().replace(/[\s-]/g, '') : '';
    if (!normalizedEmail || !/^[A-HJ-NP-Z2-9]{12}$/.test(normalizedCode)) {
        throw new Error('Invalid or expired reset code');
    }
    const password = await bcrypt.hash(newPassword, 10);
    const user = await User.findOneAndUpdate(
        {
            email: normalizedEmail,
            status: 'active',
            passwordResetCodeHash: hashResetCode(normalizedCode),
            passwordResetExpiresAt: mongoose.trusted({ $gt: new Date() }),
        },
        {
            $set: { password },
            $unset: { passwordResetCodeHash: 1, passwordResetExpiresAt: 1 },
        }
    );
    if (!user) throw new Error('Invalid or expired reset code');
};

const requestPasswordResetEmail = async (email, sendEmail = sendPasswordResetEmail) => {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail) throw new Error('Email is required');
    if (sendEmail === sendPasswordResetEmail) assertEmailDeliveryConfigured();
    const user = await User.findOne({ email: normalizedEmail, role: 'user', status: 'active' })
        .select('_id name email');
    if (!user) return;

    const { code, expiresAt } = await issuePasswordResetCode(user._id);
    try {
        await sendEmail({ email: user.email, name: user.name, code, expiresAt });
    } catch (error) {
        await User.findByIdAndUpdate(user._id, {
            $unset: { passwordResetCodeHash: 1, passwordResetExpiresAt: 1 },
        });
        throw error;
    }
};

export { registerUser, loginUser, requestPasswordResetEmail, resetPasswordWithCode };
