import { registerUser, loginUser } from '../services/authService.js';
import bcrypt from 'bcryptjs';
import User from '../models/userModel.js';
import { getPasswordPolicyErrors } from '../utils/passwordPolicy.js';

const registerAccount = async (req, res) => {
    try {
        const user = await registerUser(req.body);
        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: {
                _id: user._id,
                name: user.name,
                firstName: user.firstName,
                lastName: user.lastName,
                middleInitial: user.middleInitial,
                email: user.email,
                role: user.role,
                points: user.points,
            },
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

const loginAccount = async (req, res) => {
    try {
        const { user, token } = await loginUser(req.body.email, req.body.password);
        res.status(200).json({
            success: true,
            message: 'User logged in successfully',
            data: {
                _id: user._id,
                name: user.name,
                firstName: user.firstName,
                lastName: user.lastName,
                middleInitial: user.middleInitial,
                email: user.email,
                role: user.role,
                points: user.points,
                token: token,
            }
        });
    } catch (error) {
        res.status(400).json({
            success: false,
            message: error.message,
        });
    }
};

const logoutAccount = async (req, res) => {
    res.status(200).json({
        success: true,
        message: 'User logged out successfully',
    });
};

const getProfile = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password');
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        res.status(200).json({
            success: true,
            message: 'User profile retrieved successfully',
            data: user,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

const updatePassword = async (req, res) => {
    try {
        const userID = req.user.id;
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required',
            });
        }

        const passwordErrors = getPasswordPolicyErrors(newPassword);
        if (passwordErrors.length > 0) {
            return res.status(400).json({ success: false, errors: passwordErrors });
        }

        const user = await User.findById(userID);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found',
            });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(400).json({
                success: false,
                message: 'Current password is incorrect',
            });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        user.password = hashedPassword;
        await user.save();

        res.status(200).json({
            success: true,
            message: 'Password updated successfully',
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
        });

    }
};

export {
    registerAccount,
    loginAccount,
    logoutAccount,
    getProfile,
    updatePassword,
};
