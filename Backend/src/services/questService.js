import Quest from '../models/questModel.js';
import User from '../models/userModel.js';

const createQuest = async (questData) => {
    const quest = await Quest.create(questData);
    return quest;
};

const getAllQuests = async () => {
    const quests = await Quest.find().sort({ createdAt: -1 }).limit(500).lean();
    return quests.map((quest) => ({
        ...quest,
        participantCount: quest.participants?.length || 0,
        participants: [],
    }));
};

const listActiveQuests = async (req) => {
    const now = new Date();
    const quests = await Quest.find({
        $or: [
            {
                status: 'active',
                expiryDate: { $gte: now },
                $or: [{ startDate: { $exists: false } }, { startDate: { $lte: now } }],
            },
            {
                participants: {
                    $elemMatch: { user: req.user.id, completed: true },
                },
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
const updateQuestProgress = async (userID, wasteType, quantityKg = 0) => {
    const now = new Date();
    const quests = await Quest.find({
        status: 'active',
        expiryDate: { $gte: now },
        $and: [
            { $or: [{ startDate: { $exists: false } }, { startDate: { $lte: now } }] },
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

        participant.progress += 1;
        participant.weightProgressKg = (participant.weightProgressKg || 0) + Number(quantityKg || 0);

        const countTargetMet = !quest.targetCount || participant.progress >= quest.targetCount;
        const weightTargetMet = !quest.targetWeightKg || participant.weightProgressKg >= quest.targetWeightKg;
        if (countTargetMet && weightTargetMet) {
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
