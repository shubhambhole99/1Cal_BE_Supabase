import express from "express";
import * as billController from "../controller/billController.js";
import { isAuthenticated } from "../middleware/auth.js";

const router = express.Router();

router.post("/", isAuthenticated, billController.createBill);
router.get("/", isAuthenticated, billController.listBills);
router.get("/:id", isAuthenticated, billController.getBillById);
router.put("/:id", isAuthenticated, billController.updateBill);
router.delete("/:id", isAuthenticated, billController.deleteBill);

export default router;
