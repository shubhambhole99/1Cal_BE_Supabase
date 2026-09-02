import express from "express";
import * as userController from "../controller/userController.js";
import { isAuthenticated } from "../middleware/auth.js";

const router = express.Router();

// Every users query selects the full row, so a missing grant column breaks all
// of them — login included. One cached ALTER ahead of the handlers keeps a
// database that has not seen this column yet from 500ing on every request.
router.use(async (req, res, next) => {
  try { await userController.ensureUserGrantCols(); } catch { /* handler will surface it */ }
  next();
});

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
