import User from '../models/userModel.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

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

export { registerUser, loginUser };
