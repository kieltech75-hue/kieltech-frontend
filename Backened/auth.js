const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { get, run } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';

async function registerUser({ name, email, password }) {
  const existing = await get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    throw new Error('User already exists');
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const result = await run(
    'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
    [name, email, hashedPassword]
  );
  return { id: result.id, name, email, is_admin: false };
}

async function loginUser({ email, password }) {
  const user = await get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    throw new Error('User not found');
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    throw new Error('Invalid password');
  }

  const token = jwt.sign({ id: user.id, email: user.email, is_admin: Boolean(user.is_admin) }, JWT_SECRET, { expiresIn: '7d' });
  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, is_admin: Boolean(user.is_admin) }
  };
}

async function getUserById(id) {
  const user = await get('SELECT * FROM users WHERE id = ?', [id]);
  if (!user) return null;
  return { ...user, is_admin: Boolean(user.is_admin) };
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { registerUser, loginUser, getUserById, verifyToken };
