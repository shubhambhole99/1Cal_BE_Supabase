import express from "express";
import * as contactController from "../controller/contactController.js";

const router = express.Router();

router.get("/", contactController.listContacts);
router.post("/", contactController.createContact);
router.get("/:id", contactController.getContactById);
router.put("/:id", contactController.updateContact);
router.delete("/:id", contactController.deleteContact);

export default router;
