import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "your_secret_key";
// hello
export function isAuthenticated(req, res, next) {
  try {
    const token = req.get("Authorization");
    if (!token) {
      return res.status(401).json({ message: "invalid token request" });
    }
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        console.error("[auth] JWT verify error:", err.message);
        return res.status(403).json({ error: "Forbidden - Invalid Token" });
      }
      req.user = user;
      next();
    });
  } catch (err) {
    console.error(err);
    res.status(401).json({ message: "invalid token request" });
  }
}

export function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "roles not allowed" });
    }
    next();
  };
}
