import mongoose from 'mongoose';

const disposalSessionSchema = new mongoose.Schema({
    bin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Bin',
        required: true,
    },
    code: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
    },
    claimTokens: {
        type: [String],
        required: true,
        validate: [(tokens) => tokens.length > 0, 'A session needs at least one claim'],
    },
    expiresAt: {
        type: Date,
        required: true,
    },
    status: {
        type: String,
        enum: ['available', 'claimed', 'expired'],
        default: 'available',
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
}, { timestamps: true });

disposalSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });
disposalSessionSchema.index({ bin: 1, status: 1, expiresAt: 1 });
disposalSessionSchema.index({ claimedBy: 1, claimedAt: -1 });

const DisposalSession = mongoose.model('DisposalSession', disposalSessionSchema);

export default DisposalSession;
