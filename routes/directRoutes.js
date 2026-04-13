import express from "express";
import * as directController from "../controller/directController.js";
import { isAuthenticated, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

router.post("/full", directController.cloneFullTemplate);
router.put("/createcopy/:id", directController.createCopy);
router.get("/getall", directController.getAllDirect);
router.get("/getmy", directController.getMyFeasibilities);
router.get("/getcollab", directController.getCollaborativeFeasibilities);
router.put("/save/:id", directController.saveMasterInput);
router.get("/analytics", directController.getAnalytics);
router.get("/analytics/datewise", directController.getDatewiseGrowthAnalytics);
router.get("/stories/:id", isAuthenticated, directController.getStoriesByDirectId);
router.post("/stories/:id", isAuthenticated, directController.addStory);
router.put("/updatestories/:id/:storyId", isAuthenticated, directController.updateStory);
router.put("/addcustomlink/:id", isAuthenticated, directController.addCustomLink);
router.put("/addfiles/:id", isAuthenticated, authorizeRoles("admin"), directController.addFiles);
router.put("/updatefile/:id/:fileId", isAuthenticated, authorizeRoles("admin"), directController.updateFile);
router.delete("/files/:id/:fileId", isAuthenticated, authorizeRoles("admin"), directController.deleteFile);
router.get("/files/:id/:fileId/serve", directController.serveFileContent);
router.put("/slides/:id/reorder", directController.reorderSlides);
router.post("/slides/:id", directController.createSlide);
router.put("/slides/:id/:slideId", directController.updateSlide);
router.delete("/slides/:id/:slideId", directController.deleteSlide);
router.get("/:id", directController.getFormulaTemplateById); // keep last so /stories/:id is matched first
router.put("/addcollab/:id", directController.addCollaborator);
router.put("/update-name/:id", directController.updatename);
router.put("/update-show-files-stories/:id", isAuthenticated, authorizeRoles("admin"), directController.updateShowFilesAndStories);
router.put("/update-show-slides/:id", isAuthenticated, authorizeRoles("admin"), directController.updateShowSlides);
router.put("/update-chat-bar-1/:id", isAuthenticated, authorizeRoles("admin"), directController.updateChatBar1);
router.put("/update-chat-bar-2/:id", isAuthenticated, authorizeRoles("admin"), directController.updateChatBar2);

export default router;
