const getPasswordPolicyErrors = (password) => {
    if (typeof password !== 'string') return ['Password is required'];
    const errors = [];
    if (password.length < 8) errors.push('Password must be at least 8 characters long');
    if (password.length > 128) errors.push('Password must not exceed 128 characters');
    if (!/[a-z]/.test(password)) errors.push('Password must include a lowercase letter');
    if (!/[A-Z]/.test(password)) errors.push('Password must include an uppercase letter');
    if (!/\d/.test(password)) errors.push('Password must include a number');
    return errors;
};

export { getPasswordPolicyErrors };
