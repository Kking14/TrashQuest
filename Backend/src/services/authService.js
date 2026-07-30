import User from '../models/userModel.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const registerUser = async (userData) => {
    const { name, email, password } = userData; // role removed - clients can't set their own role

    const existingUser = await User.findOne({ email });
    if (existingUser) {
        throw new Error('Email is already registered');
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
        name,
        email,
        password: hashedPassword,
        // role intentionally omitted - schema default ('user') applies
    });
    return user;
}

const loginUser = async (email, password) => {
    const user = await User.findOne({ email });
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
    }, process.env.JWT_SECRET, { expiresIn: '7d' });
    return { user, token };
};

export { registerUser, loginUser };
