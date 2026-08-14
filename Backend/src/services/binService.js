import Bin from '../models/binModel.js';
import crypto from 'crypto';
 
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

const getOrCreateDeviceKey = async (binID) => {
    const bin = await Bin.findById(binID).select('+deviceApiKey');
    if (!bin) {
        throw new Error('Bin not found');
    }
    if (!bin.deviceApiKey) {
        bin.deviceApiKey = crypto.randomBytes(24).toString('hex');
        await bin.save();
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
 
const updateFullStatusFromSensor = async (bin, isFull) => {
    if (typeof isFull !== 'boolean') {
        throw new Error('isFull must be true or false');
    }
    if (bin.status === 'inactive') {
        throw new Error('This bin is currently inactive');
    }
    const fullnessChanged = bin.isFull !== isFull;
    bin.isFull = isFull;
    bin.status = isFull ? 'needs_collection' : 'active';
    bin.lastSensorUpdateAt = new Date();
    if (fullnessChanged || !bin.fullnessChangedAt) {
        bin.fullnessChangedAt = bin.lastSensorUpdateAt;
    }
    await bin.save();
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

const reactivateBin = async (binID) => {
    const bin = await Bin.findById(binID);
    if (!bin) {
        throw new Error('Bin not found');
    }
    if (bin.status !== 'inactive') {
        throw new Error('This bin is already active');
    }
    bin.status = bin.isFull ? 'needs_collection' : 'active';
    await bin.save();
    return bin;
};
 
// For rotating a bin's device key if it's ever leaked (e.g. device stolen
// or replaced).
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
    getOrCreateDeviceKey,
    updateBin,
    updateFullStatusFromSensor,
    deactivateBin,
    reactivateBin,
    regenerateDeviceKey,
};
