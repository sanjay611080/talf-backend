import { NextFunction, Request, Response } from 'express';

// Forwards async route handler rejections to the Express error handler.
export function asyncHandler(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}
