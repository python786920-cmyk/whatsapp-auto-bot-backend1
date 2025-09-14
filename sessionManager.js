const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');

class SessionManager {
    constructor(io, geminiAI) {
        this.io = io;
        this.geminiAI = geminiAI;
        this.client = null;
        this.isReady = false;
        this.qrRetries = 0;
        this.maxQrRetries = 3;
        this.messageCount = 0;
        this.activeChats = new Set();
        
        this.sessionPath = path.join(__dirname, 'sessions');
        this.ensureSessionDirectory();
        
        console.log('✅ Session Manager initialized');
    }

    // Ensure session directory exists
    ensureSessionDirectory() {
        if (!fs.existsSync(this.sessionPath)) {
            fs.mkdirSync(this.sessionPath, { recursive: true });
            console.log('📁 Created session directory');
        }
    }

    // Initialize WhatsApp client
    async initializeClient() {
        try {
            console.log('🚀 Initializing WhatsApp client...');
            
            this.client = new Client({
                authStrategy: new LocalAuth({
                    clientId: 'whatsapp-auto-bot',
                    dataPath: this.sessionPath
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-gpu'
                    ],
                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
                },
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
                }
            });

            this.setupEventHandlers();
            await this.client.initialize();
            
        } catch (error) {
            console.error('❌ Client initialization failed:', error.message);
            this.io.emit('error', 'Failed to initialize WhatsApp client');
            throw error;
        }
    }

    // Setup all event handlers
    setupEventHandlers() {
        // QR Code generation
        this.client.on('qr', async (qr) => {
            try {
                console.log('📱 QR Code generated');
                const qrCodeDataURL = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    quality: 0.92,
                    margin: 1,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    },
                    width: 256
                });
                
                this.io.emit('qr', qrCodeDataURL);
                this.qrRetries++;
                
                if (this.qrRetries > this.maxQrRetries) {
                    console.log('⚠️ Max QR retries reached, restarting...');
                    this.restartClient();
                }
                
            } catch (error) {
                console.error('❌ QR generation error:', error.message);
                this.io.emit('error', 'QR generation failed');
            }
        });

        // Authentication successful
        this.client.on('authenticated', () => {
            console.log('🔐 WhatsApp authenticated successfully');
            this.io.emit('authenticated');
            this.qrRetries = 0;
        });

        // Client ready
        this.client.on('ready', async () => {
            console.log('✅ WhatsApp client is ready!');
            this.isReady = true;
            this.io.emit('ready');
            
            // Get client info
            try {
                const clientInfo = this.client.info;
                console.log(`📱 Connected as: ${clientInfo.pushname} (${clientInfo.wid.user})`);
                
                // Start periodic stats update
                this.startStatsUpdater();
                
            } catch (error) {
                console.error('❌ Error getting client info:', error.message);
            }
        });

        // Message received
        this.client.on('message_create', async (message) => {
            await this.handleIncomingMessage(message);
        });

        // Message received (alternative event)
        this.client.on('message', async (message) => {
            await this.handleIncomingMessage(message);
        });

        // Client disconnected
        this.client.on('disconnected', (reason) => {
            console.log('❌ WhatsApp disconnected:', reason);
            this.isReady = false;
            this.io.emit('disconnected', reason);
            
            // Auto-reconnect after delay
            setTimeout(() => {
                console.log('🔄 Attempting to reconnect...');
                this.restartClient();
            }, 5000);
        });

        // Authentication failure
        this.client.on('auth_failure', (message) => {
            console.error('❌ Authentication failed:', message);
            this.io.emit('error', 'Authentication failed - please scan QR again');
        });

        // Error handling
        this.client.on('error', (error) => {
            console.error('❌ WhatsApp client error:', error.message);
            this.io.emit('error', error.message);
        });
    }

    // Handle incoming messages
    async handleIncomingMessage(message) {
        try {
            // Skip if bot is not ready or message is from self
            if (!this.isReady || message.fromMe) return;
            
            // Skip group messages (optional)
            if (message.from.includes('@g.us')) {
                console.log('📱 Skipping group message');
                return;
            }

            // Skip if message is too old (prevent spam on restart)
            const messageTime = new Date(message.timestamp * 1000);
            const now = new Date();
            const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
            
            if (messageTime < fiveMinutesAgo) {
                console.log('⏰ Skipping old message');
                return;
            }

            // Get contact info
            const contact = await message.getContact();
            const contactName = contact.name || contact.pushname || contact.number;
            const messageText = message.body.trim();

            console.log(`📨 Message from ${contactName}: ${messageText.substring(0, 50)}...`);

            // Skip empty messages or media-only messages for now
            if (!messageText || messageText.length < 1) {
                console.log('📱 Skipping empty/media message');
                return;
            }

            // Add to active chats
            this.activeChats.add(contact.number);

            // Generate AI reply
            const aiReply = await this.geminiAI.generateReply(
                messageText, 
                contact.number, 
                contactName
            );

            if (aiReply) {
                await this.sendReplyWithTyping(message, aiReply, contactName);
                this.messageCount++;
                
                // Emit reply event to frontend
                this.io.emit('message_reply', {
                    contact: contactName,
                    originalMessage: messageText,
                    reply: aiReply,
                    timestamp: new Date()
                });
            }

        } catch (error) {
            console.error('❌ Error handling message:', error.message);
            
            // Send fallback reply on error
            try {
                await message.reply("Sorry, kuch technical problem hai. Thoda baad try karo 😅");
            } catch (replyError) {
                console.error('❌ Failed to send fallback reply:', replyError.message);
            }
        }
    }

    // Send reply with human-like typing simulation
    async sendReplyWithTyping(message, reply, contactName) {
        try {
            const chat = await message.getChat();
            
            // Start typing indicator
            await chat.sendStateTyping();
            
            // Calculate realistic typing delay
            const typingDelayMin = parseInt(process.env.TYPING_DELAY_MIN) || 1000;
            const typingDelayMax = parseInt(process.env.TYPING_DELAY_MAX) || 3000;
            const baseDelay = typingDelayMin + Math.random() * (typingDelayMax - typingDelayMin);
            const charDelay = reply.length * 30; // 30ms per character
            const totalDelay = Math.min(baseDelay + charDelay, typingDelayMax);
            
            console.log(`⌨️ Typing for ${totalDelay}ms to ${contactName}...`);
            
            // Wait for typing simulation
            await this.sleep(totalDelay);
            
            // Stop typing and send reply
            await chat.clearState();
            await message.reply(reply);
            
            console.log(`✅ Reply sent to ${contactName}: ${reply}`);
            
        } catch (error) {
            console.error('❌ Error sending reply with typing:', error.message);
            throw error;
        }
    }

    // Send custom message
    async sendMessage(to, message) {
        try {
            if (!this.isReady) {
                throw new Error('WhatsApp client is not ready');
            }

            const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
            await this.client.sendMessage(chatId, message);
            
            console.log(`📤 Custom message sent to ${to}`);
            return { success: true };
            
        } catch (error) {
            console.error('❌ Error sending custom message:', error.message);
            return { success: false, error: error.message };
        }
    }

    // Get client status
    getStatus() {
        return {
            isReady: this.isReady,
            messageCount: this.messageCount,
            activeChats: this.activeChats.size,
            qrRetries: this.qrRetries,
            uptime: process.uptime()
        };
    }

    // Start periodic stats updater
    startStatsUpdater() {
        setInterval(() => {
            if (this.isReady) {
                this.io.emit('message_count', this.messageCount);
                this.io.emit('active_chats', this.activeChats.size);
                
                // Clean up old active chats (older than 1 hour)
                // This is simplified - in production, you'd track timestamps
                if (this.activeChats.size > 50) {
                    this.activeChats.clear();
                }
            }
        }, 30000); // Update every 30 seconds
    }

    // Restart client
    async restartClient() {
        try {
            console.log('🔄 Restarting WhatsApp client...');
            
            if (this.client) {
                await this.client.destroy();
            }
            
            this.isReady = false;
            this.qrRetries = 0;
            
            // Wait before reinitializing
            await this.sleep(3000);
            
            await this.initializeClient();
            
        } catch (error) {
            console.error('❌ Error restarting client:', error.message);
            this.io.emit('error', 'Failed to restart client');
        }
    }

    // Stop client
    async stopClient() {
        try {
            console.log('⏹️ Stopping WhatsApp client...');
            
            if (this.client) {
                this.isReady = false;
                await this.client.destroy();
                this.client = null;
            }
            
            this.io.emit('disconnected', 'Client stopped manually');
            console.log('✅ Client stopped successfully');
            
        } catch (error) {
            console.error('❌ Error stopping client:', error.message);
        }
    }

    // Cleanup sessions
    async cleanupSessions() {
        try {
            const sessionFiles = await fs.readdir(this.sessionPath);
            for (const file of sessionFiles) {
                if (file.startsWith('.')) continue;
                const filePath = path.join(this.sessionPath, file);
                await fs.remove(filePath);
            }
            console.log('🧹 Session files cleaned up');
        } catch (error) {
            console.error('❌ Error cleaning sessions:', error.message);
        }
    }

    // Utility function for delays
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = SessionManager;
