import { getAllUsers, getUserById, updateUser, deleteUser } from '../services/userService.js';

const listUsers = async (req, res) => {
    try {
        const { users, pagination } = await getAllUsers(req.query);
        res.status(200).json({ success: true, data: users, pagination });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const getUser = async (req, res) => {
    try {
        const user = await getUserById(req.params.id);
        res.status(200).json({ success: true, data: user });
    } catch (error) {
        res.status(404).json({ success: false, message: error.message });
    }
};

const editUser = async (req, res) => {
    try {
        const allowedFields = ['status', 'zone'];
        const safeUpdates = Object.fromEntries(
            Object.entries(req.body).filter(([key]) => allowedFields.includes(key))
        );
        if (Object.keys(safeUpdates).length === 0) {
            return res.status(400).json({ success: false, message: 'No permitted fields were provided' });
        }
        const user = await updateUser(req.params.id, safeUpdates);
        res.status(200).json({ success: true, message: 'User updated successfully', data: user });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const removeUser = async (req, res) => {
    try {
        const user = await deleteUser(req.params.id);
        res.status(200).json({ success: true, message: 'User deactivated successfully', data: user });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

export { listUsers, getUser, editUser, removeUser };
