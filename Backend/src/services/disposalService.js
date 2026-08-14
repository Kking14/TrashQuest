import crypto from 'crypto';
import mongoose from 'mongoose';
import Disposal from '../models/disposalModel.js';
import DisposalClaim from '../models/disposalClaimModel.js';
import DisposalSession from '../models/disposalSessionModel.js';
import Bin from '../models/binModel.js';
import User from '../models/userModel.js';
import { calculatePoints } from './pointsService.js';
import { updateQuestProgress } from './questService.js';
 
const CLAIM_EXPIRY_MINUTES = 3;
 
const SESSION_CODE_CHARACTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const generateSessionCode = () => {
    let code = 'TQ-';
    for (let index = 0; index < 6; index += 1) {
        code += SESSION_CODE_CHARACTERS[crypto.randomInt(SESSION_CODE_CHARACTERS.length)];
    }
    return code;
};

const createDisposalSession = async (bin, claimTokens) => {
    const uniqueTokens = [...new Set(claimTokens || [])];
    if (uniqueTokens.length === 0) {
        throw new Error('A disposal session needs at least one claim');
    }
    const claims = await DisposalClaim.find({
        claimToken: mongoose.trusted({ $in: uniqueTokens }),
        bin: bin._id,
    });
    if (claims.length !== uniqueTokens.length) {
        throw new Error('One or more disposal claims do not belong to this bin');
    }
    if (claims.some((claim) => claim.status !== 'pending' || claim.expiresAt < new Date())) {
        throw new Error('One or more disposal claims are no longer available');
    }

    let session;
    for (let attempt = 0; attempt < 5 && !session; attempt += 1) {
        try {
            session = await DisposalSession.create({
                bin: bin._id,
                code: generateSessionCode(),
                claimTokens: uniqueTokens,
                expiresAt: new Date(Math.min(...claims.map((claim) => claim.expiresAt.getTime()))),
            });
        } catch (error) {
            if (error.code !== 11000) throw error;
        }
    }
    if (!session) throw new Error('Could not create a unique session code');
    return session;
};

const getDisposalSessionTokens = async (sessionCode, userID) => {
    const code = sessionCode.trim().toUpperCase();
    const claimedAt = new Date();
    const session = await DisposalSession.findOneAndUpdate(
        { code, status: 'available', expiresAt: mongoose.trusted({ $gt: claimedAt }) },
        { $set: { status: 'claimed', claimedBy: userID, claimedAt } },
        { new: true }
    );
    if (!session) {
        const existingSession = await DisposalSession.findOne({ code }).select('status expiresAt').lean();
        if (!existingSession) throw new Error('Invalid session code');
        if (existingSession.status === 'claimed') throw new Error('This session has already been claimed');
        throw new Error('This session code has expired');
    }
    return session;
};
 
// Step 1: called by the bin device itself right after its sensor detects a
// disposal (wasteType/quantity come from the sensor, not a resident). This
// registers the physical event regardless of whether anyone scans the QR.
// Bin fullness is reported separately by the ultrasonic sensor. This returns a
// short-lived claim token for the bin to display as a QR code.
const createDisposalClaim = async (bin, wasteType, quantity, itemCount = 1, detectionId = null) => {
    if (bin.status === 'inactive') {
        throw new Error('This bin is currently inactive');
    }
    if (!bin.acceptedWasteTypes.includes(wasteType)) {
        throw new Error(`This bin does not accept ${wasteType}`);
    }
    const normalizedDetectionId = typeof detectionId === 'string' ? detectionId.trim() : '';
    if (normalizedDetectionId) {
        const existingClaim = await DisposalClaim.findOne({
            bin: bin._id,
            detectionId: normalizedDetectionId,
        });
        if (existingClaim) {
            return {
                claim: existingClaim,
                pointsAvailable: calculatePoints(existingClaim.wasteType, existingClaim.quantity),
                duplicate: true,
            };
        }
    }
 
    // Calculated now, at detection time, so the claim is a fixed offer that
    // can't be changed by delaying the scan.
    const pointsAvailable = calculatePoints(wasteType, quantity);
 
    const claimToken = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + CLAIM_EXPIRY_MINUTES * 60 * 1000);
 
    const claim = await DisposalClaim.create({
        bin: bin._id,
        wasteType,
        quantity,
        itemCount: Math.max(1, Math.floor(Number(itemCount) || 1)),
        detectionId: normalizedDetectionId || null,
        claimToken,
        expiresAt,
    });
 
    bin.lastDisposalAt = new Date();
    await bin.save();
 
    return { claim, pointsAvailable, duplicate: false };
};
 
// Step 2: called when a resident scans the QR and the app submits the token
// along with their own auth. This is the only point a resident is attached
// to the disposal.
const claimDisposal = async (claimToken, userID, disposalSession = null) => {
    const claimedAt = new Date();
    const claim = await DisposalClaim.findOneAndUpdate(
        { claimToken, status: 'pending', expiresAt: mongoose.trusted({ $gt: claimedAt }) },
        { $set: { status: 'claimed', claimedBy: userID, claimedAt } },
        { new: true }
    );
    if (!claim) {
        const existingClaim = await DisposalClaim.findOne({ claimToken }).select('status expiresAt').lean();
        if (!existingClaim) throw new Error('Invalid claim code');
        if (existingClaim.status === 'claimed') throw new Error('This code has already been claimed');
        throw new Error('This code has expired');
    }
 
    const bin = await Bin.findById(claim.bin);
    if (!bin) {
        throw new Error('Bin associated with this claim no longer exists');
    }
 
    const pointsAwarded = calculatePoints(claim.wasteType, claim.quantity);
 
    const disposal = await Disposal.create({
        user: userID,
        bin: bin._id,
        session: disposalSession?._id || null,
        sessionCode: disposalSession?.code || null,
        zone: bin.zone || 'default',
        wasteType: claim.wasteType,
        quantity: claim.quantity,
        itemCount: claim.itemCount || 1,
        pointsAwarded,
    });
 
    await User.findByIdAndUpdate(userID, { $inc: { points: pointsAwarded } });
 
    // A quest-tracking hiccup shouldn't roll back a disposal that already
    // happened and already paid out points - log and move on.
    let completedQuests = [];
    let questProgressUpdates = [];
    let questUpdateWarning = null;
    try {
        const questResult = await updateQuestProgress(
            userID,
            claim.wasteType,
            claim.quantity,
            claim.itemCount || 1
        );
        completedQuests = questResult.completedQuests;
        questProgressUpdates = questResult.progressUpdates;
    } catch (error) {
        console.error('Quest progress update failed:', error.message);
        questUpdateWarning = 'Your disposal was claimed, but quest progress could not be updated. Please contact the barangay admin.';
    }
 
    return { ...disposal.toObject(), completedQuests, questProgressUpdates, questUpdateWarning };
};
 
const getUserDisposals = async (userID) => {
    const disposals = await Disposal.find({ user: userID })
        .populate('bin', 'code location')
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();

    const grouped = new Map();
    for (const disposal of disposals) {
        const groupKey = disposal.session ? `session:${disposal.session}` : `legacy:${disposal._id}`;
        if (!grouped.has(groupKey)) {
            grouped.set(groupKey, {
                _id: disposal.session || disposal._id,
                sessionCode: disposal.sessionCode || null,
                isSession: Boolean(disposal.session),
                bin: disposal.bin,
                quantity: 0,
                pointsAwarded: 0,
                createdAt: disposal.createdAt,
                items: [],
            });
        }
        const entry = grouped.get(groupKey);
        entry.quantity += Number(disposal.quantity || 0);
        entry.pointsAwarded += Number(disposal.pointsAwarded || 0);
        entry.items.push({
            _id: disposal._id,
            wasteType: disposal.wasteType,
            quantity: disposal.quantity,
            pointsAwarded: disposal.pointsAwarded,
        });
        if (new Date(disposal.createdAt) > new Date(entry.createdAt)) {
            entry.createdAt = disposal.createdAt;
        }
    }

    return [...grouped.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
};

const getAllDisposals = async (filters = {}) => {
    const query = {};
    if (filters.wasteType) query.wasteType = filters.wasteType;
    if (filters.userID) query.user = filters.userID;
    if (filters.startDate || filters.endDate) {
        const dateRange = {};
        if (filters.startDate) dateRange.$gte = new Date(filters.startDate);
        if (filters.endDate) dateRange.$lte = new Date(filters.endDate);
        query.createdAt = mongoose.trusted(dateRange);
    }
 
    const disposals = await Disposal.find(query)
        .populate('user', 'name email')
        .populate('bin', 'code location')
        .sort({ createdAt: -1 })
        .limit(Math.min(1000, Math.max(1, Number(filters.limit) || 500)))
        .lean();
    return disposals;
};
 
export { createDisposalClaim, createDisposalSession, getDisposalSessionTokens, claimDisposal, getUserDisposals, getAllDisposals };
