import Quest from '../models/questModel.js';
import User from '../models/userModel.js';
import mongoose from 'mongoose';

const createQuest = async (questData) => {
    const quest = await Quest.create(questData);
    return quest;
};

const getAllQuests = async () => {
    const quests = await Quest.find()
        .populate('participants.user', 'name email')
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();
    return quests.map((quest) => ({
        ...quest,
        participantCount: quest.participants?.length || 0,
        completedCount: quest.participants?.filter((participant) => participant.completed).length || 0,
        completedParticipants: (quest.participants || [])
            .filter((participant) => participant.completed)
            .map((participant) => ({
                _id: participant.user?._id || participant.user,
                name: participant.user?.name || 'Resident',
                email: participant.user?.email || '',
                completedAt: participant.completedAt,
            })),
        participants: [],
    }));
};

const listActiveQuests = async (req) => {
    const now = new Date();
    const quests = await Quest.find({
        $or: [
            {
                status: 'active',
                expiryDate: mongoose.trusted({ $gte: now }),
                $or: [
                    { startDate: mongoose.trusted({ $exists: false }) },
                    { startDate: mongoose.trusted({ $lte: now }) },
                ],
            },
            {
                participants: mongoose.trusted({
                    $elemMatch: { user: req.user.id, completed: true },
                }),
            },
        ],
    }).sort({ expiryDate: 1 }).limit(200).lean();
    return quests.map((quest) => ({
        ...quest,
        participants: (quest.participants || []).filter(
            (participant) => participant.user.toString() === req.user.id
        ),
    }));
};

const joinQuest = async (questID, userID) => {
    const quest = await Quest.findById(questID);
    if (!quest) {
        throw new Error('Quest not found');
    }
    if (quest.status !== 'active' || (quest.startDate && quest.startDate > new Date()) || quest.expiryDate < new Date()) {
        throw new Error('This quest is no longer active');
    }

    const alreadyJoined = quest.participants.some((p) => p.user.toString() === userID);
    if (alreadyJoined) {
        throw new Error('You have already joined this quest');
    }

    quest.participants.push({ user: userID, progress: 0, completed: false });
    await quest.save();
    return quest;
};

// Called right after a disposal claim is completed. Matching active quests
// automatically track the resident; no manual join is required.
const updateQuestProgress = async (userID, wasteType, quantityKg = 0, itemCount = 1) => {
    const now = new Date();
    const completedQuests = [];
    const progressUpdates = [];
    const quests = await Quest.find({
        status: 'active',
        expiryDate: mongoose.trusted({ $gte: now }),
        $and: [
            { $or: [
                { startDate: mongoose.trusted({ $exists: false }) },
                { startDate: mongoose.trusted({ $lte: now }) },
            ] },
            { $or: [{ wasteType: null }, { wasteType }] },
        ],
    });

    for (const quest of quests) {
        let participant = quest.participants.find((p) => p.user.toString() === userID);
        if (!participant) {
            quest.participants.push({ user: userID, progress: 0, completed: false });
            participant = quest.participants[quest.participants.length - 1];
        }
        if (participant.completed) continue;

        participant.progress += Math.max(1, Math.floor(Number(itemCount) || 1));
        const disposalGrams = Number(quantityKg || 0) * 1000;
        const existingGrams = participant.weightProgressGrams
            || Number(participant.weightProgressKg || 0) * 1000;
        participant.weightProgressGrams = existingGrams + disposalGrams;

        const countTargetMet = !quest.targetCount || participant.progress >= quest.targetCount;
        const targetGrams = quest.targetWeightGrams || Number(quest.targetWeightKg || 0) * 1000;
        const weightTargetMet = !targetGrams || participant.weightProgressGrams >= targetGrams;
        if (countTargetMet && weightTargetMet) {
            participant.completed = true;
            participant.completedAt = new Date();
            await User.findByIdAndUpdate(userID, { $inc: { points: quest.pointsReward } });
            completedQuests.push({
                _id: quest._id,
                title: quest.title,
                pointsReward: quest.pointsReward,
            });
        }

        await quest.save();
        progressUpdates.push({
            _id: quest._id,
            title: quest.title,
            wasteType: quest.wasteType,
            progress: participant.progress,
            targetCount: quest.targetCount,
            weightProgressGrams: participant.weightProgressGrams,
            targetWeightGrams: targetGrams,
            completed: participant.completed,
        });
    }
    return { completedQuests, progressUpdates };
};

const closeQuest = async (questID) => {
    const quest = await Quest.findByIdAndUpdate(questID, { status: 'closed' }, { new: true });
    if (!quest) {
        throw new Error('Quest not found');
    }
    return quest;
};

const updateQuest = async (questID, questData) => {
    const allowedFields = [
        'title', 'description', 'wasteType', 'targetCount', 'targetWeightGrams',
        'pointsReward', 'frequency', 'startDate', 'expiryDate', 'status',
    ];
    const updates = Object.fromEntries(
        allowedFields
            .filter((field) => Object.prototype.hasOwnProperty.call(questData, field))
            .map((field) => [field, questData[field]])
    );
    if (Object.prototype.hasOwnProperty.call(updates, 'targetWeightGrams')) {
        updates.targetWeightKg = null;
    }
    const quest = await Quest.findById(questID);
    if (!quest) throw new Error('Quest not found');
    quest.set(updates);
    await quest.save();
    return quest;
};

const deleteQuest = async (questID) => {
    const quest = await Quest.findByIdAndDelete(questID);
    if (!quest) throw new Error('Quest not found');
    return quest;
};

export { createQuest, getAllQuests, listActiveQuests, joinQuest, updateQuestProgress, closeQuest, updateQuest, deleteQuest };
