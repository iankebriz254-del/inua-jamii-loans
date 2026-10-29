const express = require('express');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

let mailer = null;
if(GMAIL_USER && GMAIL_APP_PASSWORD){
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD.replace(/\s/g, '') }
  });
  console.log('Email sender configured for', GMAIL_USER);
} else {
  console.log('Email sender NOT configured — GMAIL_USER or GMAIL_APP_PASSWORD is missing in environment variables.');
}

async function notifyNewApplication(app_){
  if(!mailer){
    console.log('Skipping email notification — mailer is not configured.');
    return;
  }
  console.log('Sending new-application email for', app_.name);
  const waLink = `https://wa.me/254${app_.phone.replace(/^0/, '')}`;
  try{
    await mailer.sendMail({
      from: GMAIL_USER,
      to: GMAIL_USER,
      subject: `New loan application — ${app_.name}`,
      html: `
        <h2>New Tumaini Loans application</h2>
        <p><b>Name:</b> ${app_.name}</p>
        <p><b>Phone:</b> ${app_.phone}</p>
        <p><b>Category:</b> ${app_.category}</p>
        <p><b>Amount:</b> KSh ${app_.amount}</p>
        <p><b>Repayment period:</b> ${app_.term}</p>
        <p><b>National ID:</b> ${app_.idnum}</p>
        <p><b>Next of kin:</b> ${app_.kin}</p>
        <p><a href="${waLink}">Message ${app_.name} on WhatsApp</a></p>
        <p><a href="https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'tumaini-loans.onrender.com'}/admin">Open admin page</a></p>
      `
    });
  } catch(e){
    console.error('Email notification failed:', e.message);
  }
}

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

function adminAuth(req, res, next){
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'Please log in again.' });
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    if(payload.role !== 'admin') throw new Error('not admin');
    next();
  } catch(e){
    res.status(401).json({ error: 'Please log in again.' });
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
    const user = await db.collection('users').findOne({ _id: new ObjectId(req.userId) });
    if(!user) return res.status(404).json({ error: 'Account not found.' });
    const record = {
      userId: req.userId, name: user.name, phone: user.phone,
      category, amount, term, idnum, kin, status: 'Under review', updatedAt: new Date()
    };
    await db.collection('applications').updateOne(
      { userId: req.userId },
      { $set: record },
      { upsert: true }
    );
    notifyNewApplication(record);
    res.json({ ok: true });
  } catch(e){
    console.error(e);
    res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if(!ADMIN_PASSWORD) return res.status(500).json({ error: 'Admin login is not set up yet.' });
  if(password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

app.get('/api/admin/applications', requireDb, adminAuth, async (req, res) => {
  try{
    const applications = await db.collection('applications').find().sort({ updatedAt: -1 }).toArray();
    res.json({ applications });
  } catch(e){
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.post('/api/admin/applications/:id/status', requireDb, adminAuth, async (req, res) => {
  try{
    const { status } = req.body || {};
    const allowed = ['Under review', 'Approved', 'Rejected', 'Disbursed'];
    if(!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    await db.collection('applications').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch(e){
    console.error(e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Tumaini Loans server running on port ${PORT}`);
});
