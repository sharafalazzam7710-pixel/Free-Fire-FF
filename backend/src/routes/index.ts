import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tournamentsRouter from "./tournaments";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tournamentsRouter);

export default router;
