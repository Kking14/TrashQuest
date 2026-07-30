import { getAllUsers, getUserById, updateUser, deleteUser } from '../services/userService.js';

const listUsers = async (req, res) => {
    try {
        const users = await getAllUsers();
        res.status(200).json({ success: true, data: users });
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
        // role and password are intentionally excluded here - role changes and
        // password resets should go through dedicated, more tightly guarded
        // flows (e.g. updatePassword in authController.js), not a generic
        // profile-edit endpoint.
        const { role, password, ...safeUpdates } = req.body;
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