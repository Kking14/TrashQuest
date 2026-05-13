import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'Name is required'],
        trim: true
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
        minlength: 6,
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

const User = mongoose.model('User', userSchema);

export default User;