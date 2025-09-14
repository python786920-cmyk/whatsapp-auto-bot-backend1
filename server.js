const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const WhatsAppHandler = require('./whatsapp-handler');
const AIReply = require('./ai-reply');

class WhatsAppBotServer {
    constructor() {
        this.app = express();
        this.server = createServer(this.app);
        this.io = new Server(this.server, {
            cors: {
                origin: process.env.CORS_ORIGINS?.split(',') || "*",
                methods: ["GET", "POST"],
                credentials: true
            },
            transports: ['websocket', 'polling']
        });
        
        this.whatsappHandler = new WhatsAppHandler();
        this.aiReply = new AIReply();
        this.activeSessions = new Map();
        this.dbPool = null;
        
        this.init();
    }
    
    async init() {
        try {
            await this.setupDatabase();
            this.setupMiddleware();
            this.setupRoutes();
            this.setupSocketIO();
            this.setupCronJobs();
            this.startServer();
            
            console.log('🚀 WhatsApp Bot Server initialized successfully');
        } catch (error) {
            console.error('❌ Server initialization failed:', error);
            process.exit(1);
        }
    }
    
    async setupDatabase() {
        try {
            this.dbPool = mysql.createPool({
                host: process.env.DB_HOST,
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                database: process.env.DB_NAME,
                port: parseInt(process.env.DB_PORT) || 3306,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
                idleTimeout: 60000,
                acquireTimeout: 60000
            });
            
            // Test connection
            const connection = await this.dbPool.getConnection();
            await connection.ping();
            connection.release();
            
            // Create tables if not exist
            await this.createTables();
            
            console.log('✅ Database connected successfully');
        } catch (error) {
            console.log('⚠️ Database connection failed, continuing without DB:', error.message);
            this.dbPool = null;
        }
    }
    
    async createTables() {
        if (!this.dbPool) return;
        
        const tables = {
            sessions: `
                CREATE TABLE IF NOT EXISTS whatsapp_sessions (
                    id VARCHAR(255) PRIMARY KEY,
                    phone_number VARCHAR(50),
                    status ENUM('connecting', 'connected', 'disconnected') DEFAULT 'connecting',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    messages_sent INT DEFAULT 0,
                    session_data TEXT
                )
            `,
            messages: `
                CREATE TABLE IF NOT EXISTS whatsapp_messages (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    session_id VARCHAR(255),
                    from_number VARCHAR(50),
                    to_number VARCHAR(50),
                    message_text TEXT,
                    ai_reply TEXT,
                    language VARCHAR(10),
                    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id) ON DELETE CASCADE
                )
            `,
            analytics: `
                CREATE TABLE IF NOT EXISTS bot_analytics (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    date DATE,
                    total_messages INT DEFAULT 0,
                    total_replies INT DEFAULT 0,
                    active_sessions INT DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_date (date)
                )
            `
        };
        
        for (const [name, query] of Object.entries(tables)) {
            try {
                await this.dbPool.execute(query);
                console.log(`✅ Table ${name} ready`);
            } catch (error) {
                console.error(`❌ Failed to create table ${name}:`, error);
            }
        }
    }
    
    setupMiddleware() {
        // Security middleware
        this.app.use(helmet({
            contentSecurityPolicy: false,
            crossOriginEmbedderPolicy: false
        }));
        
        // CORS
        this.app.use(cors({
            origin: process.env.CORS_ORIGINS?.split(',') || "*",
            credentials: true
        }));
        
        // Compression
        this.app.use(compression());
        
        // Rate limiting
        const limiter = rateLimit({
            windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 60000,
            max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 30,
            message: 'Too many requests, please try again later',
            standardHeaders: true,
            legacyHeaders: false
        });
        this.app.use(limiter);
        
        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
        
        // Request logging
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
            next();
        });
    }
    
    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                activeSessions: this.activeSessions.size
            });
        });
        
        // API Routes
        this.app.get('/api/status', async (req, res) => {
            try {
                const stats = await this.getSystemStats();
                res.json({
                    success: true,
                    data: stats
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        this.app.post('/api/send-message', async (req, res) => {
            try {
                const { sessionId, to, message } = req.body;
                
                if (!sessionId || !to || !message) {
                    return res.status(400).json({
                        success: false,
                        error: 'Missing required parameters'
                    });
                }
                
                const session = this.activeSessions.get(sessionId);
                if (!session || !session.isReady) {
                    return res.status(400).json({
                        success: false,
                        error: 'Session not ready'
                    });
                }
                
                await session.client.sendMessage(to, message);
                
                res.json({
                    success: true,
                    message: 'Message sent successfully'
                });
                
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        // Fallback route
        this.app.get('*', (req, res) => {
            res.status(404).json({
                success: false,
                error: 'Route not found'
            });
        });
        
        // Error handler
        this.app.use((error, req, res, next) => {
            console.error('❌ Express error:', error);
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        });
    }
    
    setupSocketIO() {
        this.io.on('connection', (socket) => {
            console.log(`📱 Client connected: ${socket.id}`);
            
            socket.emit('connected', {
                message: 'Connected to WhatsApp Bot Server',
                timestamp: new Date().toISOString()
            });
            
            // Generate QR Code
            socket.on('generate_qr', async (callback) => {
                try {
                    const sessionId = uuidv4();
                    console.log(`🔄 Generating QR for session: ${sessionId}`);
                    
                    const session = await this.createWhatsAppSession(sessionId, socket);
                    this.activeSessions.set(sessionId, session);
                    
                    if (callback) callback({ success: true, sessionId });
                    
                } catch (error) {
                    console.error('❌ QR generation failed:', error);
                    socket.emit('error', {
                        message: 'Failed to generate QR code',
                        error: error.message
                    });
                    if (callback) callback({ success: false, error: error.message });
                }
            });
            
            // Get Status
            socket.on('get_status', async (callback) => {
                try {
                    const stats = await this.getSystemStats();
                    if (callback) callback(stats);
                } catch (error) {
                    if (callback) callback({ error: error.message });
                }
            });
            
            // Handle disconnect
            socket.on('disconnect', () => {
                console.log(`📱 Client disconnected: ${socket.id}`);
            });
        });
    }
    
    async createWhatsAppSession(sessionId, socket) {
        const session = {
            id: sessionId,
            client: null,
            socket: socket,
            isReady: false,
            messagesSent: 0,
            lastActivity: Date.now()
        };
        
        try {
            // Create WhatsApp client
            session.client = await this.whatsappHandler.createClient(sessionId);
            
            // QR Code handler
            session.client.on('qr', async (qr) => {
                console.log('📷 QR Code generated for session:', sessionId);
                const qrcode = require('qrcode');
                const qrImage = await qrcode.toDataURL(qr);
                socket.emit('qr', qrImage);
            });
            
            // Ready handler
            session.client.on('ready', async () => {
                console.log('✅ WhatsApp ready for session:', sessionId);
                session.isReady = true;
                socket.emit('ready');
                
                // Save session to database
                await this.saveSession(sessionId, 'connected');
            });
            
            // Message handler
            session.client.on('message_create', async (message) => {
                if (message.fromMe) return; // Skip own messages
                
                try {
                    await this.handleIncomingMessage(message, session);
                } catch (error) {
                    console.error('❌ Message handling error:', error);
                }
            });
            
            // Disconnection handler
            session.client.on('disconnected', (reason) => {
                console.log(`📱 WhatsApp disconnected for session ${sessionId}:`, reason);
                session.isReady = false;
                socket.emit('disconnected', { reason });
                this.activeSessions.delete(sessionId);
            });
            
            // Authentication handlers
            session.client.on('authenticated', () => {
                console.log('🔐 WhatsApp authenticated for session:', sessionId);
                socket.emit('authenticated');
            });
            
            session.client.on('auth_failure', (message) => {
                console.log('❌ WhatsApp auth failure for session:', sessionId, message);
                socket.emit('auth_failure', { message });
                this.activeSessions.delete(sessionId);
            });
            
            // Initialize client
            await session.client.initialize();
            
            return session;
            
        } catch (error) {
            console.error('❌ Session creation failed:', error);
            throw error;
        }
    }
    
    async handleIncomingMessage(message, session) {
        try {
            const contact = await message.getContact();
            const fromNumber = contact.number;
            const messageText = message.body;
            
            console.log(`📥 Message from ${fromNumber}: ${messageText}`);
            
            // Rate limiting per user
            const rateLimitKey = `rate_${fromNumber}`;
            const now = Date.now();
            const rateLimit = this.rateLimits?.get(rateLimitKey);
            
            if (rateLimit && (now - rateLimit.lastMessage) < 30000) { // 30 seconds
                console.log(`⏱️ Rate limited: ${fromNumber}`);
                return;
            }
            
            this.rateLimits = this.rateLimits || new Map();
            this.rateLimits.set(rateLimitKey, { lastMessage: now });
            
            // Generate AI reply
            const aiReply = await this.aiReply.generateReply(messageText, fromNumber);
            
            if (aiReply) {
                // Simulate typing
                await message.getChat().then(chat => chat.sendStateTyping());
                
                // Random delay for human-like behavior
                const delay = Math.random() * (3000 - 1000) + 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
                
                // Send reply
                await message.reply(aiReply);
                
                session.messagesSent++;
                session.lastActivity = Date.now();
                
                // Emit to frontend
                session.socket.emit('message_sent', {
                    from: fromNumber,
                    originalMessage: messageText,
                    reply: aiReply,
                    timestamp: new Date().toISOString()
                });
                
                // Save to database
                await this.saveMessage(session.id, fromNumber, messageText, aiReply);
                
                console.log(`📤 Reply sent to ${fromNumber}: ${aiReply}`);
            }
            
        } catch (error) {
            console.error('❌ Message handling error:', error);
            
            // Send fallback reply
            try {
                const fallbackReply = process.env.FALLBACK_REPLY || 'Sorry, I encountered an issue. Please try again.';
                await message.reply(fallbackReply);
            } catch (fallbackError) {
                console.error('❌ Fallback reply failed:', fallbackError);
            }
        }
    }
    
    async saveSession(sessionId, status) {
        if (!this.dbPool) return;
        
        try {
            await this.dbPool.execute(
                'INSERT INTO whatsapp_sessions (id, status) VALUES (?, ?) ON DUPLICATE KEY UPDATE status = ?, last_active = NOW()',
                [sessionId, status, status]
            );
        } catch (error) {
            console.error('❌ Failed to save session:', error);
        }
    }
    
    async saveMessage(sessionId, fromNumber, messageText, aiReply) {
        if (!this.dbPool) return;
        
        try {
            await this.dbPool.execute(
                'INSERT INTO whatsapp_messages (session_id, from_number, message_text, ai_reply) VALUES (?, ?, ?, ?)',
                [sessionId, fromNumber, messageText, aiReply]
            );
            
            // Update session message count
            await this.dbPool.execute(
                'UPDATE whatsapp_sessions SET messages_sent = messages_sent + 1 WHERE id = ?',
                [sessionId]
            );
            
        } catch (error) {
            console.error('❌ Failed to save message:', error);
        }
    }
    
    async getSystemStats() {
        const stats = {
            activeSessions: this.activeSessions.size,
            totalMessagesSent: 0,
            uptime: Math.floor(process.uptime()),
            memory: process.memoryUsage(),
            timestamp: new Date().toISOString()
        };
        
        // Get total messages from sessions
        for (const session of this.activeSessions.values()) {
            stats.totalMessagesSent += session.messagesSent;
        }
        
        // Get database stats if available
        if (this.dbPool) {
            try {
                const [rows] = await this.dbPool.execute(
                    'SELECT SUM(messages_sent) as total FROM whatsapp_sessions'
                );
                if (rows[0] && rows[0].total) {
                    stats.totalMessagesSent = parseInt(rows[0].total);
                }
            } catch (error) {
                console.error('❌ Failed to get DB stats:', error);
            }
        }
        
        return stats;
    }
    
    setupCronJobs() {
        // Cleanup inactive sessions every 30 minutes
        cron.schedule('*/30 * * * *', () => {
            this.cleanupInactiveSessions();
        });
        
        // Update daily analytics at midnight
        cron.schedule('0 0 * * *', () => {
            this.updateDailyAnalytics();
        });
        
        console.log('⏰ Cron jobs scheduled');
    }
    
    cleanupInactiveSessions() {
        const now = Date.now();
        const timeout = parseInt(process.env.SESSION_TIMEOUT) || 3600000; // 1 hour
        
        for (const [sessionId, session] of this.activeSessions.entries()) {
            if (now - session.lastActivity > timeout) {
                console.log(`🧹 Cleaning up inactive session: ${sessionId}`);
                
                try {
                    if (session.client) {
                        session.client.destroy();
                    }
                } catch (error) {
                    console.error('❌ Session cleanup error:', error);
                }
                
                this.activeSessions.delete(sessionId);
            }
        }
    }
    
    async updateDailyAnalytics() {
        if (!this.dbPool) return;
        
        try {
            const today = new Date().toISOString().split('T')[0];
            const stats = await this.getSystemStats();
            
            await this.dbPool.execute(
                `INSERT INTO bot_analytics (date, total_messages, active_sessions) 
                 VALUES (?, ?, ?) 
                 ON DUPLICATE KEY UPDATE 
                 total_messages = ?, active_sessions = ?`,
                [today, stats.totalMessagesSent, stats.activeSessions, stats.totalMessagesSent, stats.activeSessions]
            );
            
            console.log('📊 Daily analytics updated');
        } catch (error) {
            console.error('❌ Analytics update failed:', error);
        }
    }
    
    startServer() {
        const port = process.env.PORT || 3000;
        
        this.server.listen(port, '0.0.0.0', () => {
            console.log(`🚀 Server running on port ${port}`);
            console.log(`📱 WebSocket server ready for connections`);
            console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
            console.log(`💾 Database: ${this.dbPool ? 'Connected' : 'Disconnected'}`);
        });
        
        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('📴 SIGTERM received, shutting down gracefully...');
            this.gracefulShutdown();
        });
        
        process.on('SIGINT', () => {
            console.log('📴 SIGINT received, shutting down gracefully...');
            this.gracefulShutdown();
        });
    }
    
    gracefulShutdown() {
        // Close all WhatsApp sessions
        for (const [sessionId, session] of this.activeSessions.entries()) {
            try {
                console.log(`📴 Closing session: ${sessionId}`);
                if (session.client) {
                    session.client.destroy();
                }
            } catch (error) {
                console.error('❌ Session shutdown error:', error);
            }
        }
        
        // Close database connections
        if (this.dbPool) {
            this.dbPool.end();
        }
        
        // Close server
        this.server.close(() => {
            console.log('✅ Server closed successfully');
            process.exit(0);
        });
    }
}

// Initialize server
new WhatsAppBotServer();

module.exports = WhatsAppBotServer;
