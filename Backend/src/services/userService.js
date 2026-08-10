import User from '../models/userModel.js';

const getAllUsers = async ({ page = 1, limit = 500, search = '', sortBy = 'name', sortOrder = 'asc' } = {}) => {
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 500));
    const allowedSortFields = ['name', 'email', 'points', 'status', 'createdAt'];
    const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'name';
    const query = search
        ? { $or: [
            { name: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
        ] }
        : {};
    const [users, total] = await Promise.all([
        User.find(query)
            .select('-password')
            .sort({ [safeSortBy]: sortOrder === 'desc' ? -1 : 1 })
            .skip((safePage - 1) * safeLimit)
            .limit(safeLimit)
            .lean(),
        User.countDocuments(query),
    ]);
    return { users, pagination: { page: safePage, limit: safeLimit, total, pages: Math.ceil(total / safeLimit) } };
}

const getUserById = async (userID) => {
    const user = await User.findById(userID).select('-password');
    if (!user) {
        throw new Error('User not found');
    }
    return user;
}

const updateUser = async (userID, updateData) => {
    const user = await User.findByIdAndUpdate(userID, {...updateData }, { new: true }).select('-password');
    if (!user) {
        throw new Error('User not found');
    }
    return user;
}

const deleteUser = async (userID) => {
    const user = await User.findByIdAndUpdate(
        userID,
        { status: 'inactive' },
        { new: true }
    ).select('-password');
    if (!user) {
        throw new Error('User not found');
    }
    return user;
}

export { getAllUsers, getUserById, updateUser, deleteUser };
