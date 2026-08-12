import mongoose from 'mongoose';

const participantSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    progress: {
        type: Number,
        default: 0,
    },
    weightProgressKg: {
        type: Number,
        default: 0,
    },
    weightProgressGrams: {
        type: Number,
        default: 0,
    },
    completed: {
        type: Boolean,
        default: false,
    },
    completedAt: {
        type: Date,
        default: null,
    },
}, { _id: false });

const questSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Title is required'],
        trim: true,
    },
    description: {
        type: String,
        default: null,
    },
    // null = any waste type counts toward this quest
    wasteType: {
        type: String,
        enum: ['Paper', 'Plastic', 'Tin Can', null],
        default: null,
    },
    targetCount: {
        type: Number,
        default: null,
        min: 1,
    },
    targetWeightKg: {
        type: Number,
        default: null,
        min: 0.001,
    },
    targetWeightGrams: {
        type: Number,
        default: null,
        min: 1,
    },
    pointsReward: {
        type: Number,
        required: [true, 'Points reward is required'],
        min: 0,
    },
    zone: {
        type: String,
        default: null,
    },
    frequency: {
        type: String,
        enum: ['daily', 'weekly'],
        default: 'daily',
    },
    startDate: {
        type: Date,
        default: Date.now,
    },
    expiryDate: {
        type: Date,
        required: [true, 'Expiry date is required'],
    },
    status: {
        type: String,
        enum: ['active', 'closed'],
        default: 'active',
    },
    participants: {
        type: [participantSchema],
        default: [],
    },
}, { timestamps: true });

questSchema.pre('validate', function validateQuestTarget(next) {
    if (!this.targetCount && !this.targetWeightGrams && !this.targetWeightKg) {
        return next(new Error('Set an item target, a weight target, or both'));
    }
    return next();
});

questSchema.index({ status: 1, startDate: 1, expiryDate: 1 });
questSchema.index({ wasteType: 1, status: 1, expiryDate: 1 });

const Quest = mongoose.model('Quest', questSchema);

export default Quest;
