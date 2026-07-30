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
        required: [true, 'Quantity (kg) is required'],
        min: 0,
    },
    pointsAwarded: {
        type: Number,
        required: true,
        min: 0,
    },
}, { timestamps: true });

const Disposal = mongoose.model('Disposal', disposalSchema);

export default Disposal;
