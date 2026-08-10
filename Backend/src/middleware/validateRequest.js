import { getPasswordPolicyErrors } from '../utils/passwordPolicy.js';

const validateRegister = (req, res, next) => {
    const { firstName, lastName, middleInitial, email, password, confirmPassword } = req.body;
    const errors = [];

    if (typeof lastName !== 'string' || lastName.trim() === '') {
        errors.push('Last name is required');
    }

    if (typeof firstName !== 'string' || firstName.trim() === '') {
        errors.push('First name is required');
    }

    if (middleInitial && (typeof middleInitial !== 'string' || !/^[A-Za-z]$/.test(middleInitial.trim()))) {
        errors.push('Middle initial must be one letter');
    }

    if (typeof email !== 'string' || email.trim() === '') {
        errors.push('Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        errors.push('Enter a valid email address');
    }

    errors.push(...getPasswordPolicyErrors(password));
    if (password !== confirmPassword) errors.push('Passwords do not match');

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            errors,
        });
    }

    next();
};

const validateLogin = (req, res, next) => {
    const { email, password } = req.body;
    const errors = [];

    if (typeof email !== 'string' || email.trim() === '') {
        errors.push('Email is required');
    }

    if (typeof password !== 'string' || password === '') {
        errors.push('Password is required');
    }

    if (errors.length > 0) {
        return res.status(400).json({
            success: false,
            errors,
        });
    }

    next();
};

export { validateRegister, validateLogin };
