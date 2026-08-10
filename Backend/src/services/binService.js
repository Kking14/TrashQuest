import Bin from '../models/binModel.js';
import crypto from 'crypto';
 
const FULL_THRESHOLD = 90; // fill % at which a bin is flagged for collection
 
const createBin = async (binData) => {
    const existing = await Bin.findOne({ code: binData.code });
    if (existing) {
        throw new Error('A bin with this code already exists');
    }
    const bin = await Bin.create(binData);
    return bin;
};
 
const getAllBins = async () => {
    const bins = await Bin.find().sort({ code: 1 }).lean();
    return bins;
};
 
const getBinByCode = async (code) => {
    const bin = await Bin.findOne({ code });
    if (!bin) {
        throw new Error('Bin not found for this code');
    }
    return bin;
};
 
const getBinById = async (binID) => {
    const bin = await Bin.findById(binID);
    if (!bin) {
        throw new Error('Bin not found');
    }
    return bin;
};
 
const updateBin = async (binID, updateData) => {
    const bin = await Bin.findByIdAndUpdate(binID, updateData, { new: true });
    if (!bin) {
        throw new Error('Bin not found');
    }
    return bin;
};
 
// Called after a disposal is logged against this bin, and can also be
// called directly by an admin/sensor integration to set the level manually.
const updateFillLevel = async (binID, fillLevel) => {
    if (fillLevel < 0 || fillLevel > 100) {
        throw new Error('Fill level must be between 0 and 100');
    }
    const status = fillLevel >= FULL_THRESHOLD ? 'needs_collection' : 'active';
    const bin = await Bin.findByIdAndUpdate(
        binID,
        { fillLevel, status },
        { new: true }
    );
    if (!bin) {
        throw new Error('Bin not found');
    }
    return bin;
};
 
const deactivateBin = async (binID) => {
    const bin = await Bin.findByIdAndUpdate(
        binID,
        { status: 'inactive' },
        { new: true }
    );
    if (!bin) {
        throw new Error('Bin not found');
    }
    return bin;
};
 
// For rotating a bin's device key if it's ever leaked (e.g. device stolen
// or replaced). Returned once here, same as at creation.
const regenerateDeviceKey = async (binID) => {
    const bin = await Bin.findById(binID).select('+deviceApiKey');
    if (!bin) {
        throw new Error('Bin not found');
    }
    bin.deviceApiKey = crypto.randomBytes(24).toString('hex');
    await bin.save();
    return bin;
};
 
export {
    createBin,
    getAllBins,
    getBinByCode,
    getBinById,
    updateBin,
    updateFillLevel,
    deactivateBin,
    regenerateDeviceKey,
    FULL_THRESHOLD,
};
