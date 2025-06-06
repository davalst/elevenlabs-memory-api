const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Simple in-memory storage for MVP
let userMemory = new Map();

// ElevenLabs memory tool endpoint
app.post('/api/memory/remember', (req, res) => {
  const { action, user_id, details } = req.body;
  
  console.log(`🧠 Memory ${action} for user: ${user_id}`);
  
  if (action === 'retrieve') {
    const userData = userMemory.get(user_id);
    
    if (!userData) {
      console.log('📝 New user detected');
      return res.json({ 
        message: "New user - focus on building rapport and learning about them!",
        isNewUser: true 
      });
    }
    
    console.log('📖 Retrieved memory:', userData);
    return res.json({
      message: `Welcome back ${userData.fullname || user_id}! I remember our previous conversations.`,
      userData: userData,
      isNewUser: false
    });
  }
  
  if (action === 'store') {
    const existing = userMemory.get(user_id) || {};
    const updated = { 
      ...existing, 
      ...details, 
      last_updated: new Date().toISOString(),
      conversation_count: (existing.conversation_count || 0) + 1
    };
    userMemory.set(user_id, updated);
    
    console.log('💾 Stored memory:', updated);
    return res.json({ 
      success: true, 
      message: `Remembered details about ${updated.fullname || user_id}` 
    });
  }
  
  res.status(400).json({ error: 'Invalid action. Use "store" or "retrieve"' });
});

// Post-call webhook from ElevenLabs
app.post('/webhook/elevenlabs', (req, res) => {
  console.log('📞 Post-call webhook received');
  const { data } = req.body;
  
  // Extract user ID (try multiple sources)
  const user_id = data?.conversation_initiation_client_data?.dynamic_variables?.user_id || 
                  data?.metadata?.caller_number || 
                  data?.conversation_id ||
                  'anonymous_' + Date.now();
  
  console.log(`👤 Processing post-call for user: ${user_id}`);
  
  // Store data from your ElevenLabs data collection
  if (data?.data_collection) {
    const existing = userMemory.get(user_id) || {};
    const updated = {
      ...existing,
      ...data.data_collection,
      last_conversation_date: new Date().toISOString(),
      conversation_summary: data?.analysis?.transcript_summary || 'No summary available',
      call_successful: data?.analysis?.call_successful || false
    };
    
    userMemory.set(user_id, updated);
    console.log(`📋 Updated user profile for ${user_id}`);
  }
  
  res.status(200).json({ message: 'Post-call data processed successfully' });
});

// Debug endpoint to see all memory
app.get('/debug/memory', (req, res) => {
  const allMemory = {};
  for (let [key, value] of userMemory.entries()) {
    allMemory[key] = value;
  }
  res.json({
    total_users: userMemory.size,
    memory_data: allMemory
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: '🧠 ElevenLabs Memory API is running!',
    endpoints: {
      memory_tool: '/api/memory/remember',
      webhook: '/webhook/elevenlabs', 
      debug: '/debug/memory'
    },
    stored_users: userMemory.size,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Memory API running on port ${PORT}`);
  console.log(`🔗 Your Repl URL: https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`);
  console.log(`📝 Add this URL to ElevenLabs tools and webhooks`);
});
