import express from "express";
import * as templateController from "../controller/templateController.js";

const router = express.Router();

router.put("/update-order", templateController.updateTemplateOrder);
router.put("/:id", templateController.updateCurrentVersion);
router.put("/copy/:ids", templateController.copyTemplate);
router.put("/", templateController.getAllTemplates);
router.post("/create", templateController.createTemplate);
router.get("/:id", templateController.getTemplateById);
router.put("/update/:id", templateController.updateTemplate);
router.put("/updateblocks/:id", templateController.updatePageBlocks);
router.put("/updatecontent/:id", templateController.updatePageContent);
router.put("/toggle/:id", templateController.toggleTemplateStatus);
router.put("/delete/:id", templateController.deleteTemplate);
router.get("/admin-access/:id", templateController.getAdminAccess);
router.put("/admin-access/:id", templateController.updateAdminAccess);

export default router;
