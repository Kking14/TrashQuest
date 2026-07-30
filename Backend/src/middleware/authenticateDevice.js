import Bin from '../models/binModel.js';
 
// The bin device (e.g. Raspberry Pi at the station) sends its key on every
// request instead of a resident JWT - it's registering a physical event
// before anyone has scanned anything.
const authenticateDevice = async (req, res, next) => {
    const deviceKey = req.headers['x-device-key'];
 
    if (!deviceKey) {
        return res.status(401).json({
            success: false,
            message: 'Device key is required',
        });
    }
 
    try {
        const bin = await Bin.findOne({ deviceApiKey: deviceKey }).select('+deviceApiKey');
        if (!bin) {
            return res.status(401).json({
                success: false,
                message: 'Invalid device key',
            });
        }
        req.bin = bin;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: 'Device authentication failed',
        });
    }
};
 
export default authenticateDevice;