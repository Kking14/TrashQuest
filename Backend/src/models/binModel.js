import mongoose from 'mongoose';
import crypto from 'crypto';
 
const binSchema = new mongoose.Schema({
    code: {
        type: String,
        required: [true, 'Bin code is required'],
        unique: true,
        trim: true,
    },
    zone: {
        type: String,
        default: 'default',
        trim: true,
    },
    location: {
        type: String,
        default: null,
    },
    acceptedWasteTypes: {
        type: [String],
        enum: ['Paper', 'Plastic', 'Tin Can'],
        default: ['Paper', 'Plastic', 'Tin Can'],
    },
    capacity: {
        type: Number,
        default: 100,
    },
    fillLevel: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
    },
    lastDisposalAt: {
        type: Date,
        default: null,
    },
    status: {
        type: String,
        enum: ['active', 'needs_collection', 'inactive'],
        default: 'active',
    },
    // Secret the bin's own device (e.g. Raspberry Pi) sends on every request
    // so the backend can trust it as that specific bin, without a resident
    // being logged in. select: false keeps it out of normal queries/JSON —
    // only shown once at creation and refetched explicitly for auth checks.
    deviceApiKey: {
        type: String,
        unique: true,
        select: false,
        default: () => crypto.randomBytes(24).toString('hex'),
    },
}, { timestamps: true });

binSchema.index({ status: 1, fillLevel: -1 });
binSchema.index({ zone: 1, status: 1 });
 
const Bin = mongoose.model('Bin', binSchema);
 
export default Bin;
