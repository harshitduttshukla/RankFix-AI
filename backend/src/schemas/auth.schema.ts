import { z } from 'zod';

const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const RegisterBody = z.object({
  email,
  password: z.string().min(10, 'Password must be at least 10 characters').max(128),
  name: z.string().trim().min(1).max(100).optional(),
  organizationName: z.string().trim().min(1).max(100).optional(),
});

export const LoginBody = z.object({
  email,
  password: z.string().min(1).max(128),
});

export type RegisterInput = z.infer<typeof RegisterBody>;
export type LoginInput = z.infer<typeof LoginBody>;
