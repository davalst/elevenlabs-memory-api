const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises;

const app = express();
app.use(cors());
app.use(express.json());

// Add CORS headers middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Serve static files with caching disabled
app.use(express.static(__dirname, {
  etag: false,
  lastModified: false,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Serve admin files with caching disabled
app.use('/admin', express.static(path.join(__dirname, 'admin'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// File paths for persistence
const DATA_DIR = process.env.NODE_ENV === 'production' 
  ? '/opt/render/project/src/data'
  : path.join(__dirname, 'data');

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const PROMPT_FILE = path.join(DATA_DIR, 'system_prompt.txt');

// Enhanced memory storage with persistence
let userMemory = new Map();
let users = new Map();
let userIdCounter = 1;

// System prompt storage
let systemPrompt = '';

// Initialize data directory and load data
async function initializeData() {
  try {
    // Create data directory if it doesn't exist
    await fs.mkdir(DATA_DIR, { recursive: true });
    console.log(`📁 Data directory ensured at ${DATA_DIR}`);
    
    // Load users
    try {
      const userData = await fs.readFile(USERS_FILE, 'utf-8');
      const loadedUsers = JSON.parse(userData);
      users = new Map(Object.entries(loadedUsers));
      userIdCounter = Math.max(...Array.from(users.keys())) + 1;
      console.log('👥 Loaded users from persistent storage');
    } catch (error) {
      console.log('Creating new users file');
      await fs.writeFile(USERS_FILE, '{}');
    }
    
    // Load memory
    try {
      const memoryData = await fs.readFile(MEMORY_FILE, 'utf-8');
      const loadedMemory = JSON.parse(memoryData);
      userMemory = new Map(Object.entries(loadedMemory));
      console.log('🧠 Loaded memory from persistent storage');
    } catch (error) {
      console.log('Creating new memory file');
      await fs.writeFile(MEMORY_FILE, '{}');
    }
    
    // Load system prompt
    try {
      const promptData = await fs.readFile(PROMPT_FILE, 'utf-8');
      systemPrompt = promptData;
      console.log('🤖 Loaded system prompt from persistent storage');
    } catch (error) {
      console.log('Creating new system prompt file');
      await fs.writeFile(PROMPT_FILE, '');
    }
    
  } catch (error) {
    console.error('Error initializing data:', error);
  }
}

// Save data to disk
async function saveUsers() {
  const data = Object.fromEntries(users);
  await fs.writeFile(USERS_FILE, JSON.stringify(data, null, 2));
}

async function saveMemory() {
  const data = Object.fromEntries(userMemory);
  await fs.writeFile(MEMORY_FILE, JSON.stringify(data, null, 2));
}

// Save system prompt to file
async function saveSystemPrompt() {
  await fs.writeFile(PROMPT_FILE, systemPrompt);
}

// Initialize data on startup
initializeData();

// JWT secret (in production, use environment variable)
const JWT_SECRET = process.env.JWT_SECRET || 'duuo-secret-key-change-in-production';

// Helper function to get time since last call
function getTimeSinceLastCall(lastCallTime) {
  if (!lastCallTime) return null;
  
  const now = new Date();
  const lastCall = new Date(lastCallTime);
  const diffMinutes = Math.round((now - lastCall) / (1000 * 60));
  
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} minutes ago`;
  if (diffMinutes < 1440) return `${Math.round(diffMinutes / 60)} hours ago`;
  return `${Math.round(diffMinutes / 1440)} days ago`;
}

// ================================
// ADMIN PANEL ENDPOINTS
// ================================

// Get all users
app.get('/admin/users', (req, res) => {
  const userList = Array.from(users.values()).map(user => ({
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phoneNumber: user.phoneNumber,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin
  }));
  
  res.json(userList);
});

// Create new user
app.post('/admin/users', async (req, res) => {
  try {
    const { email, password, fullName, phoneNumber } = req.body;
    
    if (!email || !password || !fullName || !phoneNumber) {
      return res.status(400).json({ error: 'Email, password, full name, and phone number are required' });
    }
    
    // Validate phone number format (basic validation)
    if (!phoneNumber.match(/^\+[1-9]\d{1,14}$/)) {
      return res.status(400).json({ error: 'Phone number must be in international format (+1234567890)' });
    }
    
    // Check if user already exists (email or phone)
    for (let user of users.values()) {
      if (user.email === email) {
        return res.status(400).json({ error: 'User with this email already exists' });
      }
      if (user.phoneNumber === phoneNumber) {
        return res.status(400).json({ error: 'User with this phone number already exists' });
      }
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create user
    const newUser = {
      id: userIdCounter++,
      email,
      password: hashedPassword,
      fullName,
      phoneNumber,
      createdAt: new Date().toISOString(),
      lastLogin: null,
      isActive: true
    };
    
    users.set(newUser.id, newUser);
    await saveUsers();
    
    // Create initial memory entry for this user
    const initialMemory = {
      fullname: fullName,
      phone_number: phoneNumber,
      email: email,
      first_created: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      conversation_count: 0,
      created_via: 'admin_panel',
      status: 'registered'
    };
    
    userMemory.set(fullName, initialMemory);
    await saveMemory();
    
    console.log(`👤 New user created: ${email} (${fullName}) - Memory initialized`);
    
    res.status(201).json({
      message: 'User created successfully with initial memory',
      user: {
        id: newUser.id,
        email: newUser.email,
        fullName: newUser.fullName,
        phoneNumber: newUser.phoneNumber
      }
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user
app.delete('/admin/users/:id', (req, res) => {
  const userId = parseInt(req.params.id);
  
  if (users.has(userId)) {
    const user = users.get(userId);
    
    // Delete user from users table
    users.delete(userId);
    
    // Find and delete associated memories
    const memoriesToDelete = [];
    
    // Search for memories by phone number, email, or full name
    for (let [key, memoryData] of userMemory.entries()) {
      if (
        memoryData.phone_number === user.phoneNumber ||
        memoryData.email === user.email ||
        memoryData.fullname === user.fullName ||
        key === user.fullName
      ) {
        memoriesToDelete.push(key);
      }
    }
    
    // Delete all matching memories
    memoriesToDelete.forEach(key => {
      userMemory.delete(key);
      console.log(`🗑️ Deleted memory for: ${key}`);
    });
    
    console.log(`🗑️ User deleted: ${user.email} (${user.fullName}) - ${memoriesToDelete.length} memory entries removed`);
    
    res.json({ 
      message: 'User and associated memories deleted successfully',
      deletedMemories: memoriesToDelete.length
    });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// System prompt endpoints
app.get('/admin/system-prompt', (req, res) => {
  res.json({ systemPrompt: systemPrompt });
});

app.post('/admin/system-prompt', async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required and must be a string' });
    }
    
    systemPrompt = prompt;
    await saveSystemPrompt();
    console.log('🤖 System prompt updated');
    
    res.json({ 
      message: 'System prompt updated successfully',
      systemPrompt: systemPrompt 
    });
  } catch (error) {
    console.error('Error updating system prompt:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ================================
// AUTHENTICATION ENDPOINTS
// ================================

// User login
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    const user = Array.from(users.values()).find(u => u.email === email);
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const isValidPassword = await bcrypt.compare(password, user.password);
    
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify token
app.get('/auth/verify', (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users.get(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    res.json({
      valid: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber
      }
    });
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// ================================
// MOBILE APP ENDPOINTS
// ================================

// Serve mobile app
app.get('/mobile', (req, res) => {
  res.sendFile(path.join(__dirname, 'mobile.html'));
});

// ================================
// MEMORY ENDPOINTS
// ================================

// Get user memories endpoint
app.get('/api/memory/user/:userId', (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.userId);
    
    // Verify JWT token
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
      jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Find user memory
    let userData = userMemory.get(userId);
    
    // If not found by exact match, try partial match
    if (!userData) {
      for (let [key, data] of userMemory.entries()) {
        if (key.includes(userId) || userId.includes(key.split(' ')[0])) {
          userData = data;
          break;
        }
      }
    }
    
    if (userData) {
      res.json(userData);
    } else {
      res.status(404).json({ error: 'No memories found for this user' });
    }
    
  } catch (error) {
    console.error('Memory retrieval error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Enhanced memory tool endpoint
app.post('/api/memory/remember', async (req, res) => {
  const { action, user_id, details, caller_id } = req.body;
  
  console.log(`🧠 Memory ${action} for user: ${user_id}, caller: ${caller_id}`);
  
  if (action === 'retrieve') {
    // Find user by name (primary method) OR by phone number
    let userData = null;
    let foundKey = null;
    
    // First try to find by phone number (most reliable for returning callers)
    if (caller_id && caller_id !== 'undefined' && !caller_id.includes('{{')) {
      for (let [key, data] of userMemory.entries()) {
        if (data.phone_number === caller_id || data.caller_id === caller_id) {
          userData = data;
          foundKey = key;
          console.log(`🎯 Found user by phone number: ${foundKey} (${caller_id})`);
          break;
        }
      }
    }
    
    // If not found by phone, try by name
    if (!userData && user_id) {
      // Try exact match first
      userData = userMemory.get(user_id);
      foundKey = user_id;
      
      // If not found, try partial match (e.g., "David" matches "David Alston")
      if (!userData) {
        for (let [key, data] of userMemory.entries()) {
          if (key.includes(user_id) || user_id.includes(key.split(' ')[0])) {
            userData = data;
            foundKey = key;
            console.log(`📝 Found user by name match: ${foundKey}`);
            break;
          }
        }
      }
    }
    
    if (!userData) {
      console.log('📝 New user detected');
      return res.json({ 
        message: "New user - focus on building rapport and learning about them!",
        isNewUser: true,
        caller_id: caller_id
      });
    }
    
    // Calculate time since last call
    const timeSince = getTimeSinceLastCall(userData.last_call_time);
    
    // Add context about when memories were created
    const memoryAge = getTimeSinceLastCall(userData.first_created || userData.last_call_time);
    
    console.log('📖 Retrieved memory:', userData);
    return res.json({
      message: `Welcome back ${userData.fullname || foundKey}! Your last call was ${timeSince}.`,
      userData: userData,
      isNewUser: false,
      timeSinceLastCall: timeSince,
      memoryAge: memoryAge,
      lastCallTime: userData.last_call_time,
      caller_id: caller_id,
      contextNote: `Memory created: ${memoryAge}. Use this to understand if events mentioned have likely happened yet.`
    });
  }
  
  if (action === 'store') {
    const storageKey = user_id || caller_id || 'unknown_user';
    
    const existing = userMemory.get(storageKey) || {};
    const updated = { 
      ...existing, 
      ...details,
      phone_number: caller_id && caller_id !== 'undefined' && !caller_id.includes('{{') ? caller_id : existing.phone_number,
      caller_id: caller_id || existing.caller_id,
      last_updated: new Date().toISOString(),
      last_call_time: new Date().toISOString(),
      first_created: existing.first_created || new Date().toISOString(),
      conversation_count: (existing.conversation_count || 0) + 1
    };
    
    userMemory.set(storageKey, updated);
    await saveMemory();
    
    console.log('💾 Stored memory with phone:', updated);
    return res.json({ 
      success: true, 
      message: `Remembered details about ${updated.fullname || storageKey}`,
      caller_id: caller_id,
      phone_stored: updated.phone_number
    });
  }
  
  res.status(400).json({ error: 'Invalid action. Use "store" or "retrieve"' });
});

// Clear all memories endpoint
app.post('/api/memory/clear-all', (req, res) => {
  console.log('🗑️ Clearing all memories...');
  const userCount = userMemory.size;
  userMemory.clear();
  
  console.log(`✅ Cleared ${userCount} user records`);
  res.json({ 
    message: 'All memories cleared successfully',
    cleared_users: userCount,
    total_users: userMemory.size 
  });
});

// Memory cleanup endpoint
app.post('/api/memory/cleanup', (req, res) => {
  console.log('🧹 Starting memory cleanup...');
  
  // Fix David's duplicate entries
  const davidAlston = userMemory.get('David Alston');
  const david = userMemory.get('David');
  
  if (davidAlston && david) {
    // Merge the entries, keeping the most recent data
    const merged = {
      ...david,
      ...davidAlston,
      first_created: david.last_call_time < davidAlston.last_call_time ? david.last_call_time : davidAlston.last_call_time,
      conversation_count: (david.conversation_count || 0) + (davidAlston.conversation_count || 0)
    };
    
    userMemory.set('David Alston', merged);
    userMemory.delete('David');
    console.log('✅ Merged David entries');
  }
  
  // Fix any broken entries
  const brokenEntries = [];
  for (let [key, data] of userMemory.entries()) {
    if (key.includes('{{') || key.includes('undefined')) {
      brokenEntries.push(key);
    }
  }
  
  brokenEntries.forEach(key => {
    const data = userMemory.get(key);
    if (data.fullname) {
      userMemory.set(data.fullname, data);
      userMemory.delete(key);
      console.log(`✅ Fixed broken entry: ${key} → ${data.fullname}`);
    }
  });
  
  res.json({ 
    message: 'Memory cleanup completed',
    total_users: userMemory.size 
  });
});

// Post-call webhook
app.post('/webhook/elevenlabs', async (req, res) => {
  console.log('📞 Post-call webhook received');
  const { data } = req.body;
  
  // Extract caller ID and user ID
  const caller_id = data?.metadata?.caller_number || 
                   data?.conversation_initiation_client_data?.dynamic_variables?.caller_id ||
                   data?.metadata?.from_number;
  
  const user_id = data?.conversation_initiation_client_data?.dynamic_variables?.user_id || 
                  data?.conversation_id ||
                  'anonymous_' + Date.now();
  
  console.log(`👤 Processing post-call for user: ${user_id}, caller: ${caller_id}`);
  
  // Find existing user by caller_id first, then by user_id
  let existingKey = null;
  let existing = {};
  
  if (caller_id) {
    for (let [key, userData] of userMemory.entries()) {
      if (userData.caller_id === caller_id || userData.phone_number === caller_id) {
        existingKey = key;
        existing = userData;
        break;
      }
    }
  }
  
  if (!existingKey) {
    existing = userMemory.get(user_id) || {};
    existingKey = user_id;
  }
  
  // Store enhanced data from ElevenLabs data collection
  if (data?.data_collection) {
    const updated = {
      ...existing,
      ...data.data_collection,
      caller_id: caller_id,
      phone_number: caller_id || existing.phone_number,
      last_conversation_date: new Date().toISOString(),
      last_call_time: new Date().toISOString(),
      first_created: existing.first_created || new Date().toISOString(),
      conversation_summary: data?.analysis?.transcript_summary || 'No summary available',
      call_successful: data?.analysis?.call_successful || false,
      call_duration: data?.metadata?.duration || 0
    };
    
    userMemory.set(existingKey, updated);
    await saveMemory();
    console.log(`📋 Updated user profile for ${existingKey} (caller: ${caller_id})`);
  }
  
  res.status(200).json({ message: 'Post-call data processed successfully' });
});

// Debug memory endpoint
app.get('/debug/memory', (req, res) => {
  console.log('🔍 Debug memory request received');
  
  const memoryData = Array.from(userMemory.entries()).map(([key, value]) => ({
    key,
    ...value,
    memory_size: JSON.stringify(value).length
  }));
  
  res.json({
    total_users: userMemory.size,
    memory_entries: memoryData,
    timestamp: new Date().toISOString()
  });
});

// Enhanced health check
app.get('/', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Content-Type', 'application/json');
  res.status(200).json({ 
    status: '🧠 Duuo Memory API v8.0',
    features: [
      'Smart name-based memory lookup',
      'Temporal context awareness', 
      'Memory cleanup and deduplication',
      'User authentication system',
      'Admin panel for user management',
      'JWT token authentication',
      'Progressive Web App (Mobile)',
      'Voice Integration',
      'Memory Viewer'
    ],
    endpoints: {
      memory_tool: '/api/memory/remember',
      postcall_webhook: '/webhook/elevenlabs', 
      debug: '/debug/memory',
      cleanup: '/api/memory/cleanup',
      clear_all: '/api/memory/clear-all',
      admin_panel: '/admin',
      auth_login: '/auth/login',
      auth_verify: '/auth/verify',
      mobile_app: '/mobile',
      user_memory: '/api/memory/user/:userId'
    },
    stored_users: userMemory.size,
    registered_users: users.size,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Duuo Memory API v8.0 running on port ${PORT}`);
  console.log(`👥 Admin panel available at: /admin`);
  console.log(`📱 Mobile app available at: /mobile`);
  console.log(`🔐 Authentication system ready!`);
});
