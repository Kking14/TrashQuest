import mongoose from 'mongoose';

const disposalSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    bin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Bin',
        required: true,
    },
    session: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'DisposalSession',
        default: null,
    },
    sessionCode: {
        type: String,
        default: null,
        uppercase: true,
        trim: true,
    },
    zone: {
        type: String,
        default: 'default',
    },
    wasteType: {
        type: String,
        enum: ['Paper', 'Plastic', 'Tin Can'],
        required: [true, 'Waste type is required'],
    },
    quantity: {
        type: Number,
        default: 0,
        min: 0,
    },
    estimatedGrams: { type: Number, min: 0, default: null },
    itemCount: {
        type: Number,
        min: 1,
        max: 100,
        default: 1,
    },
    detectionId: { type: String, trim: true, maxlength: 100, default: null },
    confidence: { type: Number, min: 0, max: 1, default: null },
    source: { type: String, trim: true, maxlength: 40, default: null },
    pointsAwarded: {
        type: Number,
        required: true,
        min: 0,
    },
}, { timestamps: true });

disposalSchema.index({ user: 1, createdAt: -1 });
disposalSchema.index({ user: 1, session: 1, createdAt: -1 });
disposalSchema.index({ bin: 1, createdAt: -1 });
disposalSchema.index({ wasteType: 1, createdAt: -1 });
disposalSchema.index({ createdAt: -1 });

const Disposal = mongoose.model('Disposal', disposalSchema);

export default Disposal;
