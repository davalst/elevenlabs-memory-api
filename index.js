require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs').promises;

// Configuration
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn('⚠️ ANTHROPIC_API_KEY not found in environment variables');
}
const JWT_SECRET = process.env.JWT_SECRET || 'duuo-secret-key-change-in-production';

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
const PROMPT_FILE = path.join(DATA_DIR, 'system-prompt.txt');

// Data storage
const users = new Map();
const userMemory = new Map();
let userIdCounter = 1;
let systemPrompt = '';

// Initialize data on startup
async function initializeData() {
  try {
    // Create data directory if it doesn't exist
    await fs.mkdir(DATA_DIR, { recursive: true });
    console.log(`📁 Data directory ensured at ${DATA_DIR}`);
    
    // Load users
    try {
      const usersData = await fs.readFile(USERS_FILE, 'utf8');
      const loadedUsers = JSON.parse(usersData);
      Object.entries(loadedUsers).forEach(([id, user]) => {
        users.set(parseInt(id), user);
        userIdCounter = Math.max(userIdCounter, parseInt(id) + 1);
      });
      console.log(`📋 Loaded ${users.size} users`);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Error loading users:', error);
    }
    
    // Load memory
    try {
      const memoryData = await fs.readFile(MEMORY_FILE, 'utf8');
      const loadedMemory = JSON.parse(memoryData);
      Object.entries(loadedMemory).forEach(([key, value]) => userMemory.set(key, value));
      console.log(`🧠 Loaded ${userMemory.size} memory entries`);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Error loading memory:', error);
    }
    
    // Load system prompt
    try {
      systemPrompt = await fs.readFile(PROMPT_FILE, 'utf8');
      console.log('📝 Loaded system prompt:', systemPrompt.substring(0, 50) + '...');
    } catch (error) {
      console.error('Error loading system prompt:', error);
      systemPrompt = 'You are Duuo, an AI goal coach. Help users achieve their goals through supportive conversation.';
      await saveSystemPrompt();
    }
  } catch (error) {
    console.error('Error initializing data:', error);
  }
}

// Save functions
async function saveUsers() {
  const data = {};
  users.forEach((user, id) => data[id] = user);
  await fs.writeFile(USERS_FILE, JSON.stringify(data, null, 2));
}

async function saveMemory() {
  const data = {};
  userMemory.forEach((value, key) => data[key] = value);
  await fs.writeFile(MEMORY_FILE, JSON.stringify(data, null, 2));
}

async function saveSystemPrompt() {
  await fs.writeFile(PROMPT_FILE, systemPrompt);
  console.log('💾 Saved system prompt to:', PROMPT_FILE);
}

// Initialize data on startup
initializeData();

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
  res.json({ prompt: systemPrompt });
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
      prompt: systemPrompt 
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
      ...(details || {}),  // Safely merge details if they exist
      hobbies: details?.hobbies || existing.hobbies,  // Preserve existing hobbies if not in new details
      mood: details?.mood || existing.mood,  // Preserve existing mood if not in new details
      goals: details?.goals || existing.goals,  // Preserve existing goals if not in new details
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

// Helper function to handle memory operations for chat
async function handleChatMemory(action, user_id, message = null) {
  console.log('🧠 Chat memory ' + action + ' for user: ' + user_id);
  
  try {
    // Make internal request to memory endpoint
    const response = await fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/memory/remember', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        action,
        user_id,
        details: message ? extractInformationFromMessage(message) : null
      })
    });

    const result = await response.json();
    
    if (action === 'retrieve') {
      if (!result.userData) {
        return {
          message: result.message || "New user - building initial profile",
          isNewUser: true
        };
      }
      
      return {
        message: result.message,
        userData: result.userData,
        isNewUser: false,
        timeSinceLastCall: result.timeSinceLastCall,
        memoryAge: result.memoryAge
      };
    }
    
    if (action === 'store' && message) {
      return result;
    }
    
    return { success: false, error: 'Invalid action' };
  } catch (error) {
    console.error('❌ Memory operation failed:', error);
    throw error;
  }
}

// Helper function to extract information from messages
function extractInformationFromMessage(message) {
  const info = {};
  
  // Extract hobbies
  const hobbyMatch = message.toLowerCase().match(/(?:my hobby is|i love|i enjoy) (.*?)(?:\.|$)/i);
  if (hobbyMatch) {
    info.hobbies = hobbyMatch[1].trim();
    console.log('✅ Extracted hobby:', info.hobbies);
  }
  
  // Extract mood
  const moodMatch = message.toLowerCase().match(/(?:my mood is|i feel|i am) (.*?)(?:\.|$)/i);
  if (moodMatch) {
    info.mood = moodMatch[1].trim();
    console.log('✅ Extracted mood:', info.mood);
  }
  
  // Extract goals
  const goalMatch = message.toLowerCase().match(/(?:my goal is|want to|trying to|have a goal of|have a goal to) (.*?)(?:\.|$)/i);
  if (goalMatch) {
    info.goals = goalMatch[1].trim();
    console.log('✅ Extracted goal:', info.goals);
  }
  
  return info;
}

// Enhanced chat endpoint with proper LLM integration
app.post('/api/chat', async (req, res) => {
  try {
    console.log('📨 Chat request received:', {
      timestamp: new Date().toISOString(),
      body: req.body
    });

    // Verify JWT token
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      console.log('❌ No token provided');
      return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
      jwt.verify(token, JWT_SECRET);
      console.log('✅ JWT token verified');
    } catch (error) {
      console.log('❌ Invalid JWT token');
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { message, user_id, caller_id, mode } = req.body;
    
    console.log('👤 User details:', {
      user_id,
      caller_id,
      mode,
      message_length: message?.length
    });

    // Retrieve user memory
    const memoryResult = await handleChatMemory('retrieve', user_id);
    console.log('📖 Memory retrieval result:', memoryResult);
    
    let userContext = '';
    if (memoryResult.userData) {
      const { userData, timeSinceLastCall, memoryAge } = memoryResult;
      
      userContext = `User Information:
- Name: ${userData.fullname || user_id}
- Last interaction: ${timeSinceLastCall || 'First interaction'}
- Memory created: ${memoryAge || 'Just now'}
- Total conversations: ${userData.conversation_count || 1}

Previous Context:
${Object.entries(userData)
  .filter(([key, value]) => 
    !['phone_number', 'caller_id', 'email', 'first_created', 'last_updated', 'last_call_time', 'created_via', 'status'].includes(key) && 
    value && 
    typeof value === 'string'
  )
  .map(([key, value]) => `${key}: ${value}`)
  .join('\n')}`;

      console.log('📝 Generated user context:', userContext);
    } else {
      console.log('ℹ️ No existing user data found');
    }
    
    let aiResponse;
    
    try {
      // Use Anthropic API for enhanced responses
      const messages = [
        { role: 'user', content: message }
      ];

      console.log('🤖 Preparing Anthropic API call:', {
        message_count: messages.length,
        has_context: !!userContext,
        context_length: userContext?.length
      });
      
      aiResponse = await callAnthropicAPI(messages, userContext);
      console.log('✅ Anthropic API response received');
      
      // Store any new information from the message
      const storeResult = await handleChatMemory('store', user_id, message);
      if (storeResult.stored) {
        console.log('✅ Stored new information:', storeResult.stored);
      }
      
    } catch (error) {
      console.error('❌ Anthropic API error:', error);
      console.log('⚠️ Falling back to simple responses');
      aiResponse = generateSimpleAIResponse(message);
    }
    
    console.log('📤 Sending response to client');
    res.json({ response: aiResponse });
    
  } catch (error) {
    console.error('❌ Chat endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper function to generate simple AI responses
function generateSimpleAIResponse(message) {
  const responses = [
    "I understand. Can you tell me more about that?",
    "That's interesting. How does that make you feel?",
    "I see. What would you like to focus on?",
    "Thank you for sharing. What are your thoughts on this?",
    "I hear you. What would be most helpful for you right now?"
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

// Helper function to call Anthropic API
async function callAnthropicAPI(messages, userContext = '') {
  if (!ANTHROPIC_API_KEY) {
    console.error('⚠️ No Anthropic API key configured');
    console.error('Environment variables:', {
      NODE_ENV: process.env.NODE_ENV,
      ANTHROPIC_API_KEY_SET: !!process.env.ANTHROPIC_API_KEY,
      DATA_DIR: process.env.DATA_DIR
    });
    throw new Error('Anthropic API key not configured');
  }

  const systemMessage = userContext ? 
    `${systemPrompt}\n\nUser Context:\n${userContext}` : 
    systemPrompt;

  try {
    console.log('🤖 Calling Anthropic API...');
    if (userContext) {
      console.log('📝 Including user context:', userContext.substring(0, 100) + '...');
    }
    console.log('📝 System message:', systemMessage.substring(0, 100) + '...');
    
    const requestBody = {
      model: 'claude-3-opus-20240229',
      max_tokens: 1000,
      system: systemMessage,
      messages: messages.map(msg => ({
        role: msg.role === 'system' ? 'assistant' : msg.role,
        content: msg.content
      }))
    };
    
    console.log('📤 Request body:', JSON.stringify(requestBody, null, 2));
    console.log('🔑 API key configured:', !!ANTHROPIC_API_KEY, 'Length:', ANTHROPIC_API_KEY?.length);
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Anthropic API error:', {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        error: errorText
      });
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    console.log('✅ Anthropic API response:', JSON.stringify(data, null, 2));
    return data.content[0].text;
  } catch (error) {
    console.error('❌ Anthropic API call failed:', error);
    console.error('Stack trace:', error.stack);
    throw error;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});