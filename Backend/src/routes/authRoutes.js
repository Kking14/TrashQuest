import express from "express";
import { registerAccount, loginAccount, logoutAccount, getProfile, updatePassword} from "../controller/authController.js";

const router = express.Router();

router.post("/register", registerAccount);

router.post("/login", loginAccount);

router.post("/logout", logoutAccount);

router.get("/me/:id", getProfile);

router.put("/change-password/:id", updatePassword);


export default router;