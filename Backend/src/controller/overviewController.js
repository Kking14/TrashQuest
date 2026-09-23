import { getAdminOverview } from '../services/overviewService.js';

const showAdminOverview = async (req, res) => {
    try {
        const overview = await getAdminOverview(req.query.page);
        res.status(200).json({ success: true, data: overview });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Could not load the overview. Please try again.' });
    }
};

export { showAdminOverview };
