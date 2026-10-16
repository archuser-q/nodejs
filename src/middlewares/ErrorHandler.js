import { AppError } from "../utils/AppError.js";

export const NotFound = (req, res) => {
    res.status(404).json({
        message: 'API not found'
    })
}

export const ErrorHandler = (err, req, res, next) => {
    if (err instanceof AppError){
        return res.status(err.status).json({
            message: err.message
        });
    }
    if (err.code === '23505') {
        return res.status(409).json({ message: 'Already exists' });
    }
    if (err.code === '23503') {
        return res.status(400).json({ message: 'Related record not found' });
    }
    console.error(err);
    res.status(500).json({
        message: 'Internal server error'
    })
}