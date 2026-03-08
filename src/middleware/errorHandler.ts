import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { Prisma } from '@prisma/client';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let error = err.message;

  if (err instanceof AppError || (err as any).isOperational) {
    statusCode = (err as any).statusCode || 500;
    message = err.message;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    statusCode = 400;
    switch (err.code) {
      case 'P2002':
        message = 'Unique constraint violation';
        error = `A record with this ${(err.meta?.target as string[])?.join(', ')} already exists`;
        break;
      case 'P2025':
        message = 'Record not found';
        error = 'The requested record does not exist';
        break;
      case 'P2003':
        message = 'Foreign key constraint violation';
        error = 'Related record not found';
        break;
      default:
        message = 'Database error';
        error = err.message;
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    statusCode = 400;
    message = 'Validation error';
    error = 'Invalid data provided';
  }

  logger.error(`[${req.method}] ${req.path} >> StatusCode: ${statusCode}, Message: ${message}`, {
    errorMessage: error,
    errorStack: err.stack,
    body: req.body,
    params: req.params,
    query: req.query,
  });

  res.status(statusCode).json({
    success: false,
    message,
    error: process.env.NODE_ENV === 'development' ? error : undefined,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });
};

export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
