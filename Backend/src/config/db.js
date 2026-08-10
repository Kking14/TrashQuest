import mongoose from "mongoose";
import dns from "dns";

dns.setServers([
    '1.1.1.1',
    '8.8.8.8'
])

export const connectDB = async () => {
    try {
        mongoose.set('sanitizeFilter', true);
        mongoose.set('strictQuery', true);
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB connected successfully");
    } catch (error) {
        console.error("MongoDB connection error:", error);
        process.exit(1);
    }
}
