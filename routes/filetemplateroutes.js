import express from "express";
import * as filetemplatecontroller from "../controller/filetemplatecontroller.js";

const router = express.Router();

router.post("/", filetemplatecontroller.createFileTemplate);
router.get("/", filetemplatecontroller.getAllFileTemplates);
router.get("/:id", filetemplatecontroller.getFileTemplateById);
router.put("/:id", filetemplatecontroller.updateFileTemplate);
router.delete("/:id", filetemplatecontroller.deleteFileTemplate);

export default router;
