import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { authLimiter } from '../middleware/rate-limit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { LoginBody, RegisterBody } from '../schemas/auth.schema.js';

export const authRoutes = Router();

authRoutes.get('/csrf', authController.csrf);
authRoutes.post('/register', authLimiter, validate({ body: RegisterBody }), authController.register);
authRoutes.post('/login', authLimiter, validate({ body: LoginBody }), authController.login);
authRoutes.post('/refresh', authLimiter, authController.refresh);
authRoutes.post('/logout', authController.logout);
authRoutes.get('/me', requireAuth, authController.me);
