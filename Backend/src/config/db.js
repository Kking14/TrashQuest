import mongoose from "mongoose";
import dns from "dns";

dns.setServers([
    '1.1.1.1',
    '8.8.8.8'
])

let connectionPromise;

export const connectDB = async () => {
    if (mongoose.connection.readyState === 1) return mongoose.connection;
    if (!connectionPromise) {
        mongoose.set('sanitizeFilter', true);
        mongoose.set('strictQuery', true);
        connectionPromise = mongoose.connect(process.env.MONGO_URI)
            .then(() => {
                console.log("MongoDB connected successfully");
                return mongoose.connection;
            })
            .catch((error) => {
                connectionPromise = undefined;
                throw error;
            });
    }
    return connectionPromise;
};
