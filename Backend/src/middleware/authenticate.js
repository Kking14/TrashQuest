import jwt from 'jsonwebtoken';

const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({
            success: false,
            message: 'No token, authorization denied'
        });
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ success: false, message: 'Invalid authorization header' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, {
            issuer: 'trashquest-api',
            audience: 'trashquest-web',
            algorithms: ['HS256'],
        });

        req.user = decoded;

        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: 'Token is not valid'
        });
    }
};

export default authenticate;
