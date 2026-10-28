const express = require('express');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

let db;
async function startDb(){
  if(!MONGODB_URI){
    console.error('MONGODB_URI is not set. Add it in Render → Environment.');
    return;
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('tumaini_loans');
  console.log('Connected to MongoDB');
}
startDb().catch(err => console.error('MongoDB connection error:', err));

function requireDb(req, res, next){
  if(!db) return res.status(503).json({ error: 'Server is still starting up, try again in a moment.' });
  next();
}

function auth(req, res, next){
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'Please log in again.' });
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch(e){
    res.status(401).json({ error: 'Your session expired, please log in again.' });
  }
}

app.post('/api/signup', requireDb, async (req, res) => {
  try{
    const { name, phone, password } = req.body || {};
    if(!name || !phone || !password || password.length < 6){
      return res.status(400).json({ error: 'Please fill in all fields (password needs 6+ characters).' });
    }
    const existing = await db.collection('users').findOne({ phone });
    if(existing) return res.status(400).json({ error: 'An account with this phone number already exists.' });
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await db.collection('users').insertOne({ name, phone, passwordHash, createdAt: new Date() });
    const token = jwt.sign({ userId: result.insertedId.toString() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, name });
  } catch(e){
    console.error(e);
    res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
});

app.post('/api/login', requireDb, async (req, res) => {
  try{
    const { phone, password } = req.body || {};
    if(!phone || !password) return res.status(400).json({ error: 'Please fill in both fields.' });
    const user = await db.collection('users').findOne({ phone });
    if(!user) return res.status(400).json({ error: 'No account found with this phone number.' });
    const match = await bcrypt.compare(password, user.passwordHash);
    if(!match) return res.status(400).json({ error: 'Incorrect password.' });
    const token = jwt.sign({ userId: user._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, name: user.name });
  } catch(e){
    console.error(e);
    res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
});

app.get('/api/me', requireDb, auth, async (req, res) => {
  try{
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });
    if(!user) return res.status(404).json({ error: 'Account not found.' });
    const application = await db.collection('applications').findOne({ userId: req.userId });
    res.json({ name: user.name, application: application || null });
  } catch(e){
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/apply', requireDb, auth, async (req, res) => {
  try{
    const { category, amount, term, idnum, kin } = req.body || {};
    if(!amount || !idnum || !kin){
      return res.status(400).json({ error: 'Please fill in all required fields.' });
    }
    await db.collection('applications').updateOne(
      { userId: req.userId },
      { $set: { userId: req.userId, category, amount, term, idnum, kin, status: 'Under review', updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(e){
    console.error(e);
    res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Tumaini Loans server running on port ${PORT}`);
});
