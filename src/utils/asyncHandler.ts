import { NextFunction, Request, Response } from 'express';

/**
 * Wraps an async Express route handler so a rejected promise (e.g. a Supabase
 * write failure) is forwarded to the centralized error handler instead of
 * leaving the request hanging.
 */
export function asyncHandler(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}
