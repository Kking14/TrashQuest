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
        required: [true, 'Target count is required'],
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

const Quest = mongoose.model('Quest', questSchema);

export default Quest;
