import Bin from '../models/binModel.js';
import Disposal from '../models/disposalModel.js';
import Quest from '../models/questModel.js';
import User from '../models/userModel.js';
import mongoose from 'mongoose';

const PAGE_SIZE = 25;

const getAdminOverview = async (requestedPage = 1) => {
    const page = Math.max(1, Number.parseInt(requestedPage, 10) || 1);
    const now = new Date();
    const residentQuery = { role: 'user' };

    const [pointBalance, disposalTotals, currentQuests, binsNeedingCollection, residentCount] = await Promise.all([
        User.aggregate([
            { $match: residentQuery },
            { $group: { _id: null, total: { $sum: { $ifNull: ['$points', 0] } } } },
        ]),
        Disposal.aggregate([
            { $group: { _id: null, items: { $sum: { $ifNull: ['$itemCount', 1] } } } },
        ]),
        Quest.countDocuments({
            status: 'active',
            expiryDate: mongoose.trusted({ $gte: now }),
            $or: [
                { startDate: mongoose.trusted({ $exists: false }) },
                { startDate: mongoose.trusted({ $lte: now }) },
            ],
        }),
        Bin.countDocuments({ $or: [{ status: 'needs_collection' }, { isFull: true }] }),
        User.countDocuments(residentQuery),
    ]);

    const pages = Math.max(1, Math.ceil(residentCount / PAGE_SIZE));
    const safePage = Math.min(page, pages);
    const residents = await User.find(residentQuery)
        .select('name email')
        .sort({ name: 1, _id: 1 })
        .skip((safePage - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean();
    const residentIds = residents.map((resident) => resident._id);
    const activity = residentIds.length ? await Disposal.aggregate([
        { $match: { user: { $in: residentIds } } },
        {
            $group: {
                _id: '$user',
                disposals: { $sum: 1 },
                itemCount: { $sum: { $ifNull: ['$itemCount', 1] } },
                earnedPoints: { $sum: { $ifNull: ['$pointsAwarded', 0] } },
                lastActivity: { $max: '$createdAt' },
            },
        },
    ]) : [];
    const activityByUser = new Map(activity.map((entry) => [String(entry._id), entry]));

    return {
        metrics: {
            residentPointBalance: pointBalance[0]?.total || 0,
            itemsRecorded: disposalTotals[0]?.items || 0,
            currentQuests,
            binsNeedingCollection,
        },
        residents: residents.map((resident) => {
            const summary = activityByUser.get(String(resident._id));
            return {
                _id: resident._id,
                name: resident.name,
                email: resident.email,
                disposals: summary?.disposals || 0,
                itemCount: summary?.itemCount || 0,
                earnedPoints: summary?.earnedPoints || 0,
                lastActivity: summary?.lastActivity || null,
            };
        }),
        pagination: { page: safePage, pages, total: residentCount },
    };
};

export { getAdminOverview };
