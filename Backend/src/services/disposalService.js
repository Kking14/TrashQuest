import crypto from 'crypto';
import Disposal from '../models/disposalModel.js';
import DisposalClaim from '../models/disposalClaimModel.js';
import Bin from '../models/binModel.js';
import User from '../models/userModel.js';
import { calculatePoints } from './pointsService.js';
import { updateQuestProgress } from './questService.js';
import { FULL_THRESHOLD } from './binService.js';
 
const CLAIM_EXPIRY_MINUTES = 3;
 
// Rough estimate of how much 1kg of waste raises a bin's fill level by.
// Tune this once real ultrasonic sensor data is available.
const FILL_INCREMENT_PER_KG = 2;
 
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
    const claim = await DisposalClaim.findOne({ claimToken });
    if (!claim) {
        throw new Error('Invalid claim code');
    }
    if (claim.status === 'claimed') {
        throw new Error('This code has already been claimed');
    }
    if (claim.status === 'expired' || claim.expiresAt < new Date()) {
        if (claim.status !== 'expired') {
            claim.status = 'expired';
            await claim.save();
        }
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
 
    claim.status = 'claimed';
    claim.claimedBy = userID;
    claim.claimedAt = new Date();
    await claim.save();
 
    // A quest-tracking hiccup shouldn't roll back a disposal that already
    // happened and already paid out points - log and move on.
    try {
        await updateQuestProgress(userID, claim.wasteType);
    } catch (error) {
        console.error('Quest progress update failed:', error.message);
    }
 
    return disposal;
};
 
const getUserDisposals = async (userID) => {
    const disposals = await Disposal.find({ user: userID })
        .populate('bin', 'code location')
        .sort({ createdAt: -1 });
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
        .sort({ createdAt: -1 });
    return disposals;
};
 
export { createDisposalClaim, claimDisposal, getUserDisposals, getAllDisposals };
