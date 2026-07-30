import Quest from '../models/questModel.js';
import User from '../models/userModel.js';

const createQuest = async (questData) => {
    const quest = await Quest.create(questData);
    return quest;
};

const getAllQuests = async () => {
    const quests = await Quest.find().sort({ createdAt: -1 });
    return quests;
};

const listActiveQuests = async (req) => {
    const quests = await Quest.find({
        status: 'active',
    }).sort({ expiryDate: 1 });
    return quests;
};

const joinQuest = async (questID, userID) => {
    const quest = await Quest.findById(questID);
    if (!quest) {
        throw new Error('Quest not found');
    }
    if (quest.status !== 'active' || quest.expiryDate < new Date()) {
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
const updateQuestProgress = async (userID, wasteType) => {
    const now = new Date();
    const quests = await Quest.find({
        status: 'active',
        expiryDate: { $gte: now },
        $or: [{ wasteType: null }, { wasteType }],
    });

    for (const quest of quests) {
        let participant = quest.participants.find((p) => p.user.toString() === userID);
        if (!participant) {
            quest.participants.push({ user: userID, progress: 0, completed: false });
            participant = quest.participants[quest.participants.length - 1];
        }
        if (participant.completed) continue;

        participant.progress += 1;

        if (participant.progress >= quest.targetCount) {
            participant.completed = true;
            participant.completedAt = new Date();
            await User.findByIdAndUpdate(userID, { $inc: { points: quest.pointsReward } });
        }

        await quest.save();
    }
};

const closeQuest = async (questID) => {
    const quest = await Quest.findByIdAndUpdate(questID, { status: 'closed' }, { new: true });
    if (!quest) {
        throw new Error('Quest not found');
    }
    return quest;
};

export { createQuest, getAllQuests, listActiveQuests, joinQuest, updateQuestProgress, closeQuest };
