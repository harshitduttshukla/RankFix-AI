import type { RequestHandler } from 'express';
import { projectRepository } from '../repositories/project.repository.js';
import { projectService } from '../services/project/project.service.js';
import { notFound } from '../utils/errors.js';

export const projectController = {
  list: (async (req, res) => {
    res.json({ items: await projectService.list(req.user!.id) });
  }) satisfies RequestHandler,

  create: (async (req, res) => {
    res.status(201).json(await projectService.create(req.user!.id, req.body));
  }) satisfies RequestHandler,

  get: (async (req, res) => {
    const access = await projectRepository.findAccessible(req.tenant!.projectId, req.user!.id);
    if (!access) throw notFound('Project');
    res.json({ ...access.project, role: access.role });
  }) satisfies RequestHandler,
};
