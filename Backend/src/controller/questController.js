import {
    createQuest,
    getAllQuests,
    listActiveQuests,
    joinQuest,
    closeQuest,
    updateQuest,
    deleteQuest,
} from '../services/questService.js';
 
const addQuest = async (req, res) => {
    try {
        const quest = await createQuest(req.body);
        res.status(201).json({ success: true, message: 'Quest created successfully', data: quest });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
const listQuests = async (req, res) => {
    try {
        const quests = await getAllQuests();
        res.status(200).json({ success: true, data: quests });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
// Resident-facing: quests they can currently join
const listAvailableQuests = async (req, res) => {
    try {
        const quests = await listActiveQuests(req);
        res.status(200).json({ success: true, data: quests });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
const joinAQuest = async (req, res) => {
    try {
        const quest = await joinQuest(req.params.id, req.user.id);
        res.status(200).json({ success: true, message: 'Joined quest successfully', data: quest });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
const endQuest = async (req, res) => {
    try {
        const quest = await closeQuest(req.params.id);
        res.status(200).json({ success: true, message: 'Quest closed', data: quest });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const editQuest = async (req, res) => {
    try {
        const quest = await updateQuest(req.params.id, req.body);
        res.status(200).json({ success: true, message: 'Quest updated successfully', data: quest });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const removeQuest = async (req, res) => {
    try {
        await deleteQuest(req.params.id);
        res.status(200).json({ success: true, message: 'Quest deleted successfully' });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

export { addQuest, listQuests, listAvailableQuests, joinAQuest, endQuest, editQuest, removeQuest };
