import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true
    },
    firstName: {
        type: String,
        trim: true,
        default: null,
    },
    lastName: {
        type: String,
        trim: true,
        default: null,
    },
    middleInitial: {
        type: String,
        trim: true,
        uppercase: true,
        maxlength: 1,
        default: null,
    },
    email: {
        type: String, 
        required: [true, 'Email is required'],
        unique: true,
        lowercase: true, 
        trim: true
    },
    password: {
        type: String, 
        required: [true, 'Password is required'],
        minlength: 8,
        maxlength: 128,
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    zone: {
        type: String,
        default: null,
    }, 
    qrCode: {
        type: String,
        default: null,
    },
    points: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    },

}, { timestamps: true });

userSchema.index({ role: 1, status: 1, name: 1 });
userSchema.index({ status: 1, createdAt: -1 });

const User = mongoose.model('User', userSchema);

export default User;
