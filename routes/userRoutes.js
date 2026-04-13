import express from "express";
import * as userController from "../controller/userController.js";
import { isAuthenticated } from "../middleware/auth.js";

const router = express.Router();

router.get("/", userController.getAllUsers);
router.put("/check", isAuthenticated, userController.checkloginvalidity);
router.put("/checkuser", userController.verifyUserPhoneData);
router.put("/editpass", userController.resetPassword);
router.get("/:id", userController.getUserById);
router.post("/create", userController.createUser);
router.post("/login", userController.login);
router.put("/:id", userController.updateUser);
router.delete("/:id", userController.deleteUser);

export default router;
