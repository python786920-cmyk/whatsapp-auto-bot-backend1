const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

class WhatsAppHandler {
    constructor() {
        this.clients = new Map();
        this.sessionPath = './sessions';
        this.maxSessions = parseInt(process.env.MAX_SESSIONS) || 10;
        this.puppeteerOptions = this.getPuppeteerOptions();
        
        this.ensureSessionDirectory();
    }
    
    async ensureSessionDirectory() {
        try {
            await fs.access(this.sessionPath);
        } catch {
            await fs.mkdir(this.sessionPath, { recursive: true });
            console.log('📁 Sessions directory created');
        }
    }
    
    getPuppeteerOptions() {
        // Optimized for Render.com deployment
        const baseOptions = {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-translate',
                '--disable-web-security',
                '--allow-running-insecure-content',
                '--no-default-browser-check',
                '--disable-logging',
                '--disable-notifications',
                '--remote-debugging-port=9222'
            ]
        };
        
        // Use system Chrome on Render.com
        if (process.env.PUPPETEER_EXECUTABLE_PATH) {
            baseOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
        }
        
        return baseOptions;
    }
    
    async createClient(sessionId) {
        if (this.clients.has(sessionId)) {
            console.log(`♻️ Reusing existing client for session: ${sessionId}`);
            return this.clients.get(sessionId);
        }
        
        if (this.clients.size >= this.maxSessions) {
            throw new Error(`Maximum sessions limit reached (${this.maxSessions})`);
        }
        
        console.log(`🔄 Creating new WhatsApp client for session: ${sessionId}`);
        
        try {
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: sessionId,
                    dataPath: this.sessionPath
                }),
                puppeteer: this.puppeteerOptions,
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
                }
            });
            
            // Enhanced error handling
            client.on('loading_screen', (percent, message) => {
                console.log(`📱 [${sessionId}] Loading: ${percent}% - ${message}`);
            });
            
            client.on('authenticated', () => {
                console.log(`🔐 [${sessionId}] WhatsApp authenticated successfully`);
            });
            
            client.on('auth_failure', (msg) => {
                console.error(`❌ [${sessionId}] Authentication failed:`, msg);
                this.clients.delete(sessionId);
            });
            
            client.on('ready', () => {
                console.log(`✅ [${sessionId}] WhatsApp is ready!`);
                this.logClientInfo(client, sessionId);
            });
            
            client.on('message', async (message) => {
                // Message handling will be done in server.js
                console.log(`📥 [${sessionId}] Message received from: ${message.from}`);
            });
            
            client.on('disconnected', (reason) => {
                console.log(`📱 [${sessionId}] WhatsApp disconnected:`, reason);
                this.clients.delete(sessionId);
                this.cleanupSession(sessionId);
            });
            
            // Store client reference
            this.clients.set(sessionId, client);
            
            return client;
            
        } catch (error) {
            console.error(`❌ Failed to create client for session ${sessionId}:`, error);
            throw error;
        }
    }
    
    async logClientInfo(client, sessionId) {
        try {
            const info = client.info;
            if (info) {
                console.log(`📞 [${sessionId}] Phone: ${info.wid.user}`);
                console.log(`👤 [${sessionId}] Name: ${info.pushname}`);
                console.log(`📱 [${sessionId}] Platform: ${info.platform}`);
            }
        } catch (error) {
            console.log(`⚠️ [${sessionId}] Could not get client info:`, error.message);
        }
    }
    
    async sendMessage(sessionId, to, message, options = {}) {
        const client = this.clients.get(sessionId);
        if (!client) {
            throw new Error(`Session ${sessionId} not found`);
        }
        
        try {
            // Format phone number if needed
            const formattedNumber = this.formatPhoneNumber(to);
            
            // Add typing simulation if enabled
            if (process.env.TYPING_SIMULATION === 'true') {
                const chat = await client.getChatById(formattedNumber);
                await chat.sendStateTyping();
                
                // Calculate typing delay based on message length
                const typingDelay = Math.min(message.length * 50, 3000);
                await new Promise(resolve => setTimeout(resolve, typingDelay));
            }
            
            // Send message
            const sentMessage = await client.sendMessage(formattedNumber, message, options);
            
            console.log(`📤 [${sessionId}] Message sent to ${to}: ${message.substring(0, 50)}...`);
            return sentMessage;
            
        } catch (error) {
            console.error(`❌ [${sessionId}] Failed to send message:`, error);
            throw error;
        }
    }
    
    async sendMedia(sessionId, to, mediaPath, caption = '', options = {}) {
        const client = this.clients.get(sessionId);
        if (!client) {
            throw new Error(`Session ${sessionId} not found`);
        }
        
        try {
            const media = MessageMedia.fromFilePath(mediaPath);
            const formattedNumber = this.formatPhoneNumber(to);
            
            const sentMessage = await client.sendMessage(formattedNumber, media, {
                caption,
                ...options
            });
            
            console.log(`📎 [${sessionId}] Media sent to ${to}`);
            return sentMessage;
            
        } catch (error) {
            console.error(`❌ [${sessionId}] Failed to send media:`, error);
            throw error;
        }
    }
    
    formatPhoneNumber(number) {
        // Remove all non-numeric characters
        let formatted = number.replace(/\D/g, '');
        
        // Add country code if missing (assuming India +91)
        if (!formatted.startsWith('91') && formatted.length === 10) {
            formatted = '91' + formatted;
        }
        
        // Ensure proper WhatsApp format
        if (!formatted.includes('@c.us')) {
            formatted += '@c.us';
        }
        
        return formatted;
    }
    
    async getClientStatus(sessionId) {
        const client = this.clients.get(sessionId);
        if (!client) {
            return { status: 'not_found', isReady: false };
        }
        
        try {
            const state = await client.getState();
            return {
                status: state || 'unknown',
                isReady: client.info !== null,
                info: client.info,
                puppeteerConnected: client.pupBrowser?.isConnected() || false
            };
        } catch (error) {
            return {
                status: 'error',
                isReady: false,
                error: error.message
            };
        }
    }
    
    async getAllSessions() {
        const sessions = [];
        for (const [sessionId, client] of this.clients.entries()) {
            const status = await this.getClientStatus(sessionId);
            sessions.push({
                sessionId,
                ...status,
                createdAt: client.createdAt || new Date().toISOString()
            });
        }
        return sessions;
    }
    
    async destroySession(sessionId) {
        const client = this.clients.get(sessionId);
        if (!client) {
            console.log(`⚠️ Session ${sessionId} not found for destruction`);
            return false;
        }
        
        try {
            console.log(`📴 Destroying session: ${sessionId}`);
            
            await client.destroy();
            this.clients.delete(sessionId);
            
            // Clean up session files
            await this.cleanupSession(sessionId);
            
            console.log(`✅ Session ${sessionId} destroyed successfully`);
            return true;
            
        } catch (error) {
            console.error(`❌ Failed to destroy session ${sessionId}:`, error);
            this.clients.delete(sessionId); // Remove from memory anyway
            return false;
        }
    }
    
    async cleanupSession(sessionId) {
        try {
            const sessionDir = path.join(this.sessionPath, `session-${sessionId}`);
            
            // Check if directory exists
            try {
                await fs.access(sessionDir);
                await fs.rm(sessionDir, { recursive: true, force: true });
                console.log(`🧹 Cleaned up session directory: ${sessionId}`);
            } catch (error) {
                // Directory doesn't exist or already cleaned
                console.log(`📁 Session directory already clean: ${sessionId}`);
            }
        } catch (error) {
            console.error(`❌ Failed to cleanup session ${sessionId}:`, error);
        }
    }
    
    async cleanupAllSessions() {
        console.log('🧹 Starting cleanup of all sessions...');
        
        const sessionIds = Array.from(this.clients.keys());
        const cleanupPromises = sessionIds.map(sessionId => this.destroySession(sessionId));
        
        await Promise.allSettled(cleanupPromises);
        
        console.log('✅ All sessions cleanup completed');
    }
    
    async restartSession(sessionId) {
        console.log(`🔄 Restarting session: ${sessionId}`);
        
        // Destroy existing session
        await this.destroySession(sessionId);
        
        // Wait a bit before recreating
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Create new session
        return await this.createClient(sessionId);
    }
    
    async getQRCode(sessionId) {
        const client = this.clients.get(sessionId);
        if (!client) {
            throw new Error(`Session ${sessionId} not found`);
        }
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('QR code generation timeout'));
            }, 60000); // 1 minute timeout
            
            client.once('qr', (qr) => {
                clearTimeout(timeout);
                resolve(qr);
            });
            
            client.once('ready', () => {
                clearTimeout(timeout);
                reject(new Error('Already authenticated'));
            });
            
            client.once('auth_failure', (msg) => {
                clearTimeout(timeout);
                reject(new Error(`Authentication failed: ${msg}`));
            });
            
            // Initialize if not already done
            if (!client.pupBrowser) {
                client.initialize().catch(reject);
            }
        });
    }
    
    // Utility methods for message handling
    async isValidWhatsAppNumber(number) {
        try {
            const formattedNumber = this.formatPhoneNumber(number);
            // This would require an active client to check
            // For now, just validate format
            return formattedNumber.includes('@c.us') && formattedNumber.length > 12;
        } catch {
            return false;
        }
    }
    
    extractPhoneFromMessage(message) {
        try {
            if (message.from) {
                return message.from.replace('@c.us', '');
            }
            return null;
        } catch {
            return null;
        }
    }
    
    async getContactInfo(sessionId, number) {
        const client = this.clients.get(sessionId);
        if (!client) {
            throw new Error(`Session ${sessionId} not found`);
        }
        
        try {
            const formattedNumber = this.formatPhoneNumber(number);
            const contact = await client.getContactById(formattedNumber);
            
            return {
                number: contact.number,
                name: contact.name || contact.pushname,
                isMyContact: contact.isMyContact,
                profilePicUrl: await contact.getProfilePicUrl().catch(() => null)
            };
        } catch (error) {
            console.error(`❌ Failed to get contact info:`, error);
            return null;
        }
    }
    
    // Health check method
    async healthCheck() {
        const health = {
            totalSessions: this.clients.size,
            activeSessions: 0,
            readySessions: 0,
            errorSessions: 0,
            sessions: []
        };
        
        for (const [sessionId, client] of this.clients.entries()) {
            try {
                const status = await this.getClientStatus(sessionId);
                health.sessions.push({ sessionId, ...status });
                
                if (status.isReady) health.readySessions++;
                if (status.status === 'error') health.errorSessions++;
                if (client.pupBrowser?.isConnected()) health.activeSessions++;
                
            } catch (error) {
                health.errorSessions++;
                health.sessions.push({
                    sessionId,
                    status: 'error',
                    error: error.message
                });
            }
        }
        
        return health;
    }
    
    // Graceful shutdown
    async shutdown() {
        console.log('📴 WhatsApp Handler shutting down...');
        await this.cleanupAllSessions();
        console.log('✅ WhatsApp Handler shutdown complete');
    }
}

module.exports = WhatsAppHandler;
