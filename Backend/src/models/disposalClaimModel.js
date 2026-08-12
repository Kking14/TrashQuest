import mongoose from 'mongoose';
 
const disposalClaimSchema = new mongoose.Schema({
    bin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Bin',
        required: true,
    },
    // Detected by the bin's own sensor, not entered by the resident
    wasteType: {
        type: String,
        enum: ['Paper', 'Plastic', 'Tin Can'],
        required: [true, 'Waste type is required'],
    },
    quantity: {
        type: Number,
        required: [true, 'Quantity (kg) is required'],
        min: 0,
    },
    itemCount: {
        type: Number,
        min: 1,
        default: 1,
    },
    // What the bin's screen encodes as a QR code for the resident to scan
    claimToken: {
        type: String,
        required: true,
        unique: true,
    },
    status: {
        type: String,
        enum: ['pending', 'claimed', 'expired'],
        default: 'pending',
    },
    claimedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    claimedAt: {
        type: Date,
        default: null,
    },
    expiresAt: {
        type: Date,
        required: true,
    },
}, { timestamps: true });

// Claim/session documents are operational data, not permanent audit records.
// MongoDB removes them one day after their claim window expires.
disposalClaimSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });
disposalClaimSchema.index({ bin: 1, status: 1, expiresAt: 1 });
disposalClaimSchema.index({ claimedBy: 1, claimedAt: -1 });
 
const DisposalClaim = mongoose.model('DisposalClaim', disposalClaimSchema);
 
export default DisposalClaim;
