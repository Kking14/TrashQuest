import {
    createBin,
    getAllBins,
    getBinByCode,
    updateBin,
    updateFillLevel,
    deactivateBin,
    regenerateDeviceKey,
} from '../services/binService.js';
 
const addBin = async (req, res) => {
    try {
        const bin = await createBin(req.body);
        res.status(201).json({
            success: true,
            message: 'Bin created successfully. Save the deviceApiKey now - it will not be shown again.',
            data: {
                _id: bin._id,
                code: bin.code,
                location: bin.location,
                acceptedWasteTypes: bin.acceptedWasteTypes,
                capacity: bin.capacity,
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
 
// For manual admin correction, or an ultrasonic-sensor integration to call
const setFillLevel = async (req, res) => {
    try {
        const bin = await updateFillLevel(req.params.id, req.body.fillLevel);
        res.status(200).json({
            success: true,
            message: 'Bin fill level updated',
            data: bin,
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
 
// Rotates the bin's device key (e.g. after a device swap) - shown once, same as creation
const rotateDeviceKey = async (req, res) => {
    try {
        const bin = await regenerateDeviceKey(req.params.id);
        res.status(200).json({
            success: true,
            message: 'Device key regenerated. Save it now - it will not be shown again.',
            data: { _id: bin._id, code: bin.code, deviceApiKey: bin.deviceApiKey },
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
export { addBin, listBins, lookupBinByCode, editBin, setFillLevel, removeBin, rotateDeviceKey };
