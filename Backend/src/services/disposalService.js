import crypto from 'crypto';
import Disposal from '../models/disposalModel.js';
import DisposalClaim from '../models/disposalClaimModel.js';
import DisposalSession from '../models/disposalSessionModel.js';
import Bin from '../models/binModel.js';
import User from '../models/userModel.js';
import { calculatePoints } from './pointsService.js';
import { updateQuestProgress } from './questService.js';
import { FULL_THRESHOLD } from './binService.js';
 
const CLAIM_EXPIRY_MINUTES = 3;
 
// Rough estimate of how much 1kg of waste raises a bin's fill level by.
// Tune this once real ultrasonic sensor data is available.
const FILL_INCREMENT_PER_KG = 2;
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
    const claims = await DisposalClaim.find({ claimToken: { $in: uniqueTokens }, bin: bin._id });
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
        { code, status: 'available', expiresAt: { $gt: claimedAt } },
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
// registers the physical event - so the bin's fill level updates immediately
// regardless of whether anyone ever scans the resulting QR - and returns a
// short-lived claim token for the bin to display as a QR code.
const createDisposalClaim = async (bin, wasteType, quantity) => {
    if (bin.status === 'inactive') {
        throw new Error('This bin is currently inactive');
    }
    if (!bin.acceptedWasteTypes.includes(wasteType)) {
        throw new Error(`This bin does not accept ${wasteType}`);
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
        claimToken,
        expiresAt,
    });
 
    bin.fillLevel = Math.min(100, bin.fillLevel + quantity * FILL_INCREMENT_PER_KG);
    bin.lastDisposalAt = new Date();
    if (bin.fillLevel >= FULL_THRESHOLD) {
        bin.status = 'needs_collection';
    }
    await bin.save();
 
    return { claim, pointsAvailable };
};
 
// Step 2: called when a resident scans the QR and the app submits the token
// along with their own auth. This is the only point a resident is attached
// to the disposal.
const claimDisposal = async (claimToken, userID) => {
    const claimedAt = new Date();
    const claim = await DisposalClaim.findOneAndUpdate(
        { claimToken, status: 'pending', expiresAt: { $gt: claimedAt } },
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
        zone: bin.zone || 'default',
        wasteType: claim.wasteType,
        quantity: claim.quantity,
        pointsAwarded,
    });
 
    await User.findByIdAndUpdate(userID, { $inc: { points: pointsAwarded } });
 
    // A quest-tracking hiccup shouldn't roll back a disposal that already
    // happened and already paid out points - log and move on.
    try {
        await updateQuestProgress(userID, claim.wasteType, claim.quantity);
    } catch (error) {
        console.error('Quest progress update failed:', error.message);
    }
 
    return disposal;
};
 
const getUserDisposals = async (userID) => {
    const disposals = await Disposal.find({ user: userID })
        .populate('bin', 'code location')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
    return disposals;
};

const getAllDisposals = async (filters = {}) => {
    const query = {};
    if (filters.wasteType) query.wasteType = filters.wasteType;
    if (filters.userID) query.user = filters.userID;
    if (filters.startDate || filters.endDate) {
        query.createdAt = {};
        if (filters.startDate) query.createdAt.$gte = new Date(filters.startDate);
        if (filters.endDate) query.createdAt.$lte = new Date(filters.endDate);
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
