import mongoose from 'mongoose';
 
const redemptionSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    pointsSpent: {
        type: Number,
        required: true,
    },
    status: {
        type: String,
        enum: ['pending', 'claimed'],
        default: 'pending',
    },
    redeemedAt: {
        type: Date,
        default: Date.now,
    },
    claimedAt: {
        type: Date,
        default: null,
    },
});
 
const rewardSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true,
    },
    description: {
        type: String,
        default: null,
    },
    pointsCost: {
        type: Number,
        required: [true, 'Points cost is required'],
        min: 0,
    },
    stock: {
        type: Number,
        required: [true, 'Stock is required'],
        min: 0,
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active',
    },
    redemptions: {
        type: [redemptionSchema],
        default: [],
    },
}, { timestamps: true });
 
const Reward = mongoose.model('Reward', rewardSchema);
 
export default Reward;