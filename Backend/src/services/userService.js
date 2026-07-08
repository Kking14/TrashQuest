import User from '../models/userModel.js';

const getAllUsers = async () => {
    const users = await User.find().select('-password');
    return users;
}

const getUserById = async (userID) => {
    const user = await User.findById(userID).select('-password');
    if (!user) {
        throw new Error('User not found');
    }
    return user;
}

const updateUser = async (userID, updateData) => {
    const user = await User.findByIdAndUpdate(userID, updateData, { new: true }).select('-password');
    if (!user) {
        throw new Error('User not found');
    }
    return user;
}

const deleteUser = async (userID) => {
    const user = await User.findByIdAndDelete(
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