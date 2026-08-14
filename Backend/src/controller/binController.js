import {
    createBin,
    getAllBins,
    getBinByCode,
    getOrCreateDeviceKey,
    updateBin,
    updateFullStatusFromSensor,
    deactivateBin,
    reactivateBin,
    regenerateDeviceKey,
} from '../services/binService.js';
 
const addBin = async (req, res) => {
    try {
        const bin = await createBin(req.body);
        res.status(201).json({
            success: true,
            message: 'Bin created successfully. Copy the device key to the station display.',
            data: {
                _id: bin._id,
                code: bin.code,
                location: bin.location,
                acceptedWasteTypes: bin.acceptedWasteTypes,
                status: bin.status,
                deviceApiKey: bin.deviceApiKey,
            },
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
const listBins = async (req, res) => {
    try {
        const bins = await getAllBins();
        res.status(200).json({ success: true, data: bins });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const revealDeviceKey = async (req, res) => {
    try {
        const bin = await getOrCreateDeviceKey(req.params.id);
        res.status(200).json({
            success: true,
            message: 'Device key retrieved',
            data: { _id: bin._id, code: bin.code, deviceApiKey: bin.deviceApiKey },
        });
    } catch (error) {
        res.status(404).json({ success: false, message: error.message });
    }
};
 
// Used by the resident app right after a QR scan, before a disposal is logged
const lookupBinByCode = async (req, res) => {
    try {
        const bin = await getBinByCode(req.params.code);
        res.status(200).json({ success: true, data: bin });
    } catch (error) {
        res.status(404).json({ success: false, message: error.message });
    }
};
 
const editBin = async (req, res) => {
    try {
        const bin = await updateBin(req.params.id, req.body);
        res.status(200).json({
            success: true,
            message: 'Bin updated successfully',
            data: bin,
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
const reportFullStatus = async (req, res) => {
    try {
        const bin = await updateFullStatusFromSensor(req.bin, req.body.isFull);
        res.status(200).json({
            success: true,
            message: bin.isFull ? 'Bin reported as full' : 'Bin reported as available',
            data: {
                _id: bin._id,
                code: bin.code,
                isFull: bin.isFull,
                status: bin.status,
                lastSensorUpdateAt: bin.lastSensorUpdateAt,
                fullnessChangedAt: bin.fullnessChangedAt,
            },
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
const removeBin = async (req, res) => {
    try {
        const bin = await deactivateBin(req.params.id);
        res.status(200).json({
            success: true,
            message: 'Bin deactivated successfully',
            data: bin,
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

const restoreBin = async (req, res) => {
    try {
        const bin = await reactivateBin(req.params.id);
        res.status(200).json({
            success: true,
            message: 'Bin reactivated successfully',
            data: bin,
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
// Rotates the bin's device key after a device swap or suspected key exposure.
const rotateDeviceKey = async (req, res) => {
    try {
        const bin = await regenerateDeviceKey(req.params.id);
        res.status(200).json({
            success: true,
            message: 'Device key regenerated. Copy the new key to the station display.',
            data: { _id: bin._id, code: bin.code, deviceApiKey: bin.deviceApiKey },
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
export { addBin, listBins, revealDeviceKey, lookupBinByCode, editBin, reportFullStatus, removeBin, restoreBin, rotateDeviceKey };
