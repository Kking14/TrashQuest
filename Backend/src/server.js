import express from "express";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import binRoutes from "./routes/binRoutes.js";
import disposalRoutes from "./routes/disposalRoutes.js";
import questRoutes from "./routes/questRoutes.js";
import rewardRoutes from "./routes/rewardRoutes.js";
import { connectDB } from "./config/db.js";
import dotenv from "dotenv";
 
dotenv.config();
const PORT = process.env.PORT || 5001;
 
const app = express();
 
connectDB();
 
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/bins", binRoutes);
app.use("/api/disposals", disposalRoutes);
app.use("/api/quests", questRoutes);
app.use("/api/rewards", rewardRoutes);
 
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});