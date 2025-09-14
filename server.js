require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');

// Import custom modules
const GeminiAI = require('./geminiAI');
const SessionManager = require('./sessionManager');

class WhatsAppBotServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server, {
            cors: {
                origin: process.env.ALLOWED_ORIGINS || "*",
                methods: ["GET", "POST"],
                credentials: true
            },
            transports: ['websocket', 'polling'],
            pingTimeout: 60000,
            pingInterval: 25000
        });

        this.port = process.env.PORT || 10000;
        this.geminiAI = null;
        this.sessionManager = null;
        this.connectedClients = new Set();
        
        this.init();
    }

    async init() {
        try {
            console.log('🚀 Starting WhatsApp Auto Bot Server...');
            
            // Setup middleware
            this.setupMiddleware();
            
            // Setup routes
            this.setupRoutes();
            
            // Initialize AI
            this.geminiAI = new GeminiAI();
            
            // Initialize session manager
            this.sessionManager = new SessionManager(this.io, this.geminiAI);
            
            // Setup Socket.io
            this.setupSocketHandlers();
            
            // Setup cleanup handlers
            this.setupCleanupHandlers();
            
            // Start server
            this.startServer();
            
        } catch (error) {
            console.error('❌ Server initialization failed:', error.message);
            process.exit(1);
        }
    }

    setupMiddleware() {
        // CORS
        this.app.use(cors({
            origin: process.env.ALLOWED_ORIGINS || "*",
            credentials: true
        }));

        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Static files (for health check page)
        this.app.use(express.static('public'));

        // Security headers
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            next();
        });

        // Request logging
        this.app.use((req, res, next) => {
            const timestamp = new Date().toISOString();
            console.log(`📡 ${timestamp} - ${req.method} ${req.path} - ${req.ip}`);
            next();
        });

        console.log('✅ Middleware configured');
    }

    setupRoutes() {
        // Health check endpoint
        this.app.get('/', (req, res) => {
            const status = this.sessionManager ? this.sessionManager.getStatus() : { isReady: false };
            res.json({
                status: 'WhatsApp Auto Bot Server is running!',
                version: '1.0.0',
                timestamp: new Date().toISOString(),
                whatsapp: status,
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                connectedClients: this.connectedClients.size
            });
        });

        // API Routes
        this.app.get('/api/status', (req, res) => {
            try {
                const status = this.sessionManager ? this.sessionManager.getStatus() : null;
                const aiStats = this.geminiAI ? this.geminiAI.getStats() : null;
                
                res.json({
                    success: true,
                    server: {
                        uptime: process.uptime(),
                        memory: process.memoryUsage(),
                        connectedClients: this.connectedClients.size
                    },
                    whatsapp: status,
                    ai: aiStats
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Send message endpoint
        this.app.post('/api/send-message', async (req, res) => {
            try {
                const { to, message } = req.body;
                
                if (!to || !message) {
                    return res.status(400).json({
                        success: false,
                        error: 'Missing required fields: to, message'
                    });
                }

                if (!this.sessionManager || !this.sessionManager.isReady) {
                    return res.status(503).json({
                        success: false,
                        error: 'WhatsApp client is not ready'
                    });
                }

                const result = await this.sessionManager.sendMessage(to, message);
                res.json(result);

            } catch (error) {
                console.error('❌ API send message error:', error.message);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Clear chat history endpoint
        this.app.post('/api/clear-history/:contact', (req, res) => {
            try {
                const { contact } = req.params;
                
                if (this.geminiAI) {
                    this.geminiAI.clearChatHistory(contact);
                    res.json({ success: true, message: 'Chat history cleared' });
                } else {
                    res.status(503).json({ success: false, error: 'AI not available' });
                }
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Restart bot endpoint
        this.app.post('/api/restart', async (req, res) => {
            try {
                if (this.sessionManager) {
                    await this.sessionManager.restartClient();
                    res.json({ success: true, message: 'Bot restart initiated' });
                } else {
                    res.status(503).json({ success: false, error: 'Session manager not available' });
                }
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                success: false,
                error: 'Endpoint not found',
                availableEndpoints: [
                    'GET /',
                    'GET /api/status',
                    'POST /api/send-message',
                    'POST /api/clear-history/:contact',
                    'POST /api/restart'
                ]
            });
        });

        console.log('✅ Routes configured');
    }

    setupSocketHandlers() {
        this.io.on('connection', (socket) => {
            console.log(`🔌 Client connected: ${socket.id}`);
            this.connectedClients.add(socket.id);

            // Send current status to new client
            if (this.sessionManager) {
                const status = this.sessionManager.getStatus();
                socket.emit('connection_status', status);
            }

            // Handle start bot request
            socket.on('start_bot', async () => {
                try {
                    console.log(`🚀 Start bot requested by ${socket.id}`);
                    
                    if (!this.sessionManager) {
                        socket.emit('error', 'Session manager not initialized');
                        return;
                    }

                    if (this.sessionManager.isReady) {
                        socket.emit('ready');
                    } else {
                        await this.sessionManager.initializeClient();
                    }
                    
                } catch (error) {
                    console.error('❌ Start bot error:', error.message);
                    socket.emit('error', `Failed to start bot: ${error.message}`);
                }
            });

            // Handle stop bot request
            socket.on('stop_bot', async () => {
                try {
                    console.log(`⏹️ Stop bot requested by ${socket.id}`);
                    
                    if (this.sessionManager) {
                        await this.sessionManager.stopClient();
                    }
                    
                } catch (error) {
                    console.error('❌ Stop bot error:', error.message);
                    socket.emit('error', `Failed to stop bot: ${error.message}`);
                }
            });

            // Handle custom message send
            socket.on('send_message', async (data) => {
                try {
                    const { to, message } = data;
                    
                    if (!this.sessionManager || !this.sessionManager.isReady) {
                        socket.emit('error', 'WhatsApp client is not ready');
                        return;
                    }

                    const result = await this.sessionManager.sendMessage(to, message);
                    socket.emit('message_sent', result);
                    
                } catch (error) {
                    console.error('❌ Socket send message error:', error.message);
                    socket.emit('error', error.message);
                }
            });

            // Handle disconnect
            socket.on('disconnect', (reason) => {
                console.log(`❌ Client disconnected: ${socket.id} - ${reason}`);
                this.connectedClients.delete(socket.id);
            });

            // Handle errors
            socket.on('error', (error) => {
                console.error(`❌ Socket error from ${socket.id}:`, error.message);
            });
        });

        console.log('✅ Socket.io handlers configured');
    }

    setupCleanupHandlers() {
        // Graceful shutdown handlers
        const cleanup = async (signal) => {
            console.log(`\n🔄 Received ${signal}, starting graceful shutdown...`);
            
            try {
                // Stop accepting new connections
                this.server.close(() => {
                    console.log('✅ Server closed');
                });

                // Disconnect all socket clients
                this.io.close(() => {
                    console.log('✅ Socket.io closed');
                });

                // Stop WhatsApp client
                if (this.sessionManager) {
                    await this.sessionManager.stopClient();
                    console.log('✅ WhatsApp client stopped');
                }

                // Cleanup AI resources
                if (this.geminiAI) {
                    this.geminiAI.cleanup();
                    console.log('✅ AI resources cleaned');
                }

                console.log('✅ Graceful shutdown completed');
                process.exit(0);
                
            } catch (error) {
                console.error('❌ Error during shutdown:', error.message);
                process.exit(1);
            }
        };

        // Handle different termination signals
        process.on('SIGTERM', () => cleanup('SIGTERM'));
        process.on('SIGINT', () => cleanup('SIGINT'));
        process.on('SIGUSR2', () => cleanup('SIGUSR2')); // nodemon restart

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
            cleanup('uncaughtException');
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
            cleanup('unhandledRejection');
        });

        console.log('✅ Cleanup handlers configured');
    }

    startServer() {
        this.server.listen(this.port, '0.0.0.0', () => {
            console.log(`
🎉 ===================================
   WhatsApp Auto Bot Server Started!
🎉 ===================================

🌐 Server URL: http://localhost:${this.port}
🌍 Public URL: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${this.port}`}
📡 Socket.io: Ready for connections
🤖 AI Engine: Google Gemini
📱 WhatsApp: Ready to initialize
🔧 Environment: ${process.env.NODE_ENV || 'development'}

📋 Available Endpoints:
   GET  /                     - Health check
   GET  /api/status           - Detailed status
   POST /api/send-message     - Send custom message
   POST /api/clear-history/:contact - Clear chat history
   POST /api/restart          - Restart bot

🔗 Connect your frontend to: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${this.port}`}

Ready to receive connections! 🚀
            `);

            // Start periodic cleanup
            setInterval(() => {
                if (this.geminiAI) {
                    this.geminiAI.cleanup();
                }
            }, parseInt(process.env.CLEANUP_INTERVAL) || 3600000); // 1 hour
        });

        this.server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(`❌ Port ${this.port} is already in use`);
                process.exit(1);
            } else {
                console.error('❌ Server error:', error.message);
            }
        });
    }
}

// Start the server
if (require.main === module) {
    new WhatsAppBotServer();
}

module.exports = WhatsAppBotServer;
