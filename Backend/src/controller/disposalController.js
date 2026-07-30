import { createDisposalClaim, claimDisposal, getUserDisposals, getAllDisposals } from '../services/disposalService.js';
 
// Called by the bin device (authenticated via device key) right after its
// sensor detects a disposal. req.bin comes from authenticateDevice middleware.
const registerDisposalClaim = async (req, res) => {
    try {
        const { wasteType, quantity } = req.body;
        const { claim, pointsAvailable } = await createDisposalClaim(req.bin, wasteType, quantity);
        res.status(201).json({
            success: true,
            message: 'Disposal claim created',
            data: {
                claimToken: claim.claimToken, // this is what the bin encodes as its QR code
                expiresAt: claim.expiresAt,
                pointsAvailable,
            },
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
// Called by the resident's app after scanning the QR code
const claimDisposalPoints = async (req, res) => {
    try {
        const { claimToken } = req.body;
        const disposal = await claimDisposal(claimToken, req.user.id);
        res.status(200).json({
            success: true,
            message: 'Points claimed successfully',
            data: disposal,
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
const getMyDisposals = async (req, res) => {
    try {
        const disposals = await getUserDisposals(req.user.id);
        res.status(200).json({ success: true, data: disposals });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
// Admin-facing disposal log table, filterable by waste type/user/date range
const getDisposalLogs = async (req, res) => {
    try {
        const { wasteType, userID, startDate, endDate } = req.query;
        const disposals = await getAllDisposals({ wasteType, userID, startDate, endDate });
        res.status(200).json({ success: true, data: disposals });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
export { registerDisposalClaim, claimDisposalPoints, getMyDisposals, getDisposalLogs };
