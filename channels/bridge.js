// Dual-Agent Channel Bridge - Production Version
// This adapter bridges Qwen Code channels to the dual-agent HTTP API
// Usage: Import and use getBridge() to interact with dual-agent from channel adapters

const http = require('http');
const https = require('https');
const EventEmitter = require('events');

const DUAL_AGENT_HOST = process.env.DUAL_AGENT_HOST || '127.0.0.1';
const DUAL_AGENT_PORT = process.env.DUAL_AGENT_PORT || 3000;

class DualAgentBridge extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.baseURL = `http://${DUAL_AGENT_HOST}:${DUAL_AGENT_PORT}`;
  }

  // Send message to dual-agent and return response
  async sendToDualAgent(chatId, message, options = {}) {
    const sessionKey = chatId;
    
    if (!this.sessions.has(sessionKey)) {
      this.sessions.set(sessionKey, {
        messages: [],
        busy: false,
        queue: []
      });
    }
    
    const session = this.sessions.get(sessionKey);
    
    if (session.busy) {
      if (options.dispatchMode === 'collect') {
        session.queue.push(message);
        return `任务进行中，已排队。完成前不会处理新消息。`;
      } else if (options.dispatchMode === 'followup') {
        session.queue.push(message);
        return `已排队为第 ${session.queue.length} 条消息，空闲后自动处理。`;
      } else {
        session.busy = false;
        session.queue = [];
      }
    }
    
    session.busy = true;
    
    try {
      const response = await this.callAPI('/api/channel/chat', { 
        message, 
        chatId,
        dispatchMode: options.dispatchMode || 'steer'
      });
      
      if (response.success) {
        session.messages.push({ role: 'user', content: message });
        session.messages.push({ role: 'assistant', content: response.result });
        
        this.emit('response', { chatId, result: response.result });
        return response.result;
      } else {
        throw new Error(response.error || 'Unknown error');
      }
    } catch (error) {
      this.emit('error', { chatId, error });
      throw error;
    } finally {
      session.busy = false;
      
      while (session.queue.length > 0 && !session.busy) {
        const nextMsg = session.queue.shift();
        this.sendToDualAgent(chatId, nextMsg, options).catch(err => {
          console.error('[bridge] Failed to process queued message:', err);
        });
      }
    }
  }

  // Make HTTP POST request to dual-agent
  async callAPI(endpoint, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint, this.baseURL);
      const opts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      };

      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ success: false, error: data || 'Invalid response' });
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('Request timeout (2 minutes)'));
      });

      req.write(JSON.stringify(body));
      req.end();
    });
  }

  getSession(chatId) {
    return this.sessions.get(chatId);
  }

  clearSession(chatId) {
    this.sessions.delete(chatId);
  }

  listSessions() {
    const sessions = [];
    for (const [key, session] of this.sessions) {
      sessions.push({
        chatId: key,
        messageCount: session.messages.length,
        busy: session.busy,
        queueLength: session.queue.length
      });
    }
    return sessions;
  }
}

// Singleton instance
let bridgeInstance = null;

function getBridge() {
  if (!bridgeInstance) {
    bridgeInstance = new DualAgentBridge();
  }
  return bridgeInstance;
}

module.exports = { DualAgentBridge, getBridge };

