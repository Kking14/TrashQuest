import { createDisposalClaim, createDisposalSession, getDisposalSessionTokens, claimDisposal, getUserDisposals, getAllDisposals } from '../services/disposalService.js';
 
// Called by the bin device (authenticated via device key) right after its
// sensor detects a disposal. req.bin comes from authenticateDevice middleware.
const registerDisposalClaim = async (req, res) => {
    try {
        const { wasteType, quantity, itemCount } = req.body;
        const { claim, pointsAvailable } = await createDisposalClaim(req.bin, wasteType, quantity, itemCount);
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

const registerDisposalSession = async (req, res) => {
    try {
        const session = await createDisposalSession(req.bin, req.body.claimTokens);
        res.status(201).json({
            success: true,
            message: 'Disposal session created',
            data: { sessionCode: session.code, expiresAt: session.expiresAt },
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
// Called by the resident's app after scanning the QR code
const claimDisposalPoints = async (req, res) => {
    try {
        const disposalSession = req.body.sessionCode
            ? await getDisposalSessionTokens(req.body.sessionCode, req.user.id)
            : null;
        const submittedTokens = disposalSession
            ? disposalSession.claimTokens
            : Array.isArray(req.body.claimTokens) ? req.body.claimTokens : [req.body.claimToken];
        const claimTokens = [...new Set(submittedTokens.filter(
            (token) => typeof token === 'string' && token.trim()
        ))];
        if (claimTokens.length === 0) {
            throw new Error('No claim codes were provided');
        }
        if (claimTokens.length > 10) {
            throw new Error('A disposal session cannot contain more than 10 claim codes');
        }

        const disposals = [];
        for (const claimToken of claimTokens) {
            disposals.push(await claimDisposal(claimToken, req.user.id, disposalSession));
        }
        const totalPoints = disposals.reduce(
            (sum, disposal) => sum + (disposal.pointsAwarded || 0),
            0
        );
        const completedQuests = [...new Map(
            disposals
                .flatMap((disposal) => disposal.completedQuests || [])
                .map((quest) => [quest._id.toString(), quest])
        ).values()];
        const questProgressUpdates = disposals.flatMap((disposal) => disposal.questProgressUpdates || []);
        const questUpdateWarnings = disposals
            .map((disposal) => disposal.questUpdateWarning)
            .filter(Boolean);
        res.status(200).json({
            success: true,
            message: 'Session points claimed successfully',
            data: { disposals, totalPoints, completedQuests, questProgressUpdates, questUpdateWarnings },
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
        const { wasteType, userID, startDate, endDate, limit } = req.query;
        const disposals = await getAllDisposals({ wasteType, userID, startDate, endDate, limit });
        res.status(200).json({ success: true, data: disposals });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};
 
export { registerDisposalClaim, registerDisposalSession, claimDisposalPoints, getMyDisposals, getDisposalLogs };
