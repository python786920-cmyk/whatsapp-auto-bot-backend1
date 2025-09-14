const axios = require('axios');

class AIReply {
    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY;
        this.model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
        this.apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
        
        this.conversationHistory = new Map(); // Store conversation history
        this.rateLimits = new Map(); // Rate limiting per user
        
        // AI personality and behavior settings
        this.botName = process.env.BOT_NAME || 'WhatsApp Assistant';
        this.personality = process.env.BOT_PERSONALITY || 'friendly_helpful_human_like';
        this.fallbackReply = process.env.FALLBACK_REPLY || 'Sorry yaar, thoda issue ho gaya. Tum bolo kya chahiye?';
        
        // Language detection patterns
        this.languagePatterns = {
            hindi: /[\u0900-\u097F]/,
            english: /^[a-zA-Z\s.,!?'"]*$/,
            hinglish: /(?=.*[a-zA-Z])(?=.*[\u0900-\u097F])|(?=.*[a-zA-Z])(?=.*(?:hai|hain|kya|kaise|kaha|kab|kyun|jo|ki|ka|ke|ko|me|se|pe|par))/i,
            urdu: /[\u0600-\u06FF]/,
            bengali: /[\u0980-\u09FF]/,
            tamil: /[\u0B80-\u0BFF]/,
            gujarati: /[\u0A80-\u0AFF]/,
            marathi: /[\u0900-\u097F]/
        };
        
        this.initializeSystem();
    }
    
    initializeSystem() {
        if (!this.apiKey) {
            console.error('❌ GEMINI_API_KEY not found in environment variables');
            throw new Error('Gemini API key is required');
        }
        
        console.log('🤖 AI Reply system initialized');
        console.log(`🎭 Personality: ${this.personality}`);
        console.log(`🌍 Multi-language support enabled`);
        
        // Cleanup old conversations every hour
        setInterval(() => {
            this.cleanupOldConversations();
        }, 3600000); // 1 hour
    }
    
    async generateReply(message, fromNumber, context = {}) {
        try {
            console.log(`🤖 Generating reply for ${fromNumber}: ${message.substring(0, 50)}...`);
            
            // Rate limiting check
            if (!this.checkRateLimit(fromNumber)) {
                console.log(`⏱️ Rate limited: ${fromNumber}`);
                return null;
            }
            
            // Detect message language
            const language = this.detectLanguage(message);
            console.log(`🌍 Detected language: ${language}`);
            
            // Get conversation history
            const history = this.getConversationHistory(fromNumber);
            
            // Build prompt
            const prompt = this.buildPrompt(message, language, history, context);
            
            // Generate AI response
            const aiResponse = await this.callGeminiAPI(prompt);
            
            if (aiResponse) {
                // Save to conversation history
                this.updateConversationHistory(fromNumber, message, aiResponse, language);
                
                console.log(`✅ AI reply generated: ${aiResponse.substring(0, 50)}...`);
                return aiResponse;
            }
            
            return this.getFallbackReply(language);
            
        } catch (error) {
            console.error('❌ AI reply generation failed:', error);
            return this.getFallbackReply('hinglish');
        }
    }
    
    detectLanguage(text) {
        // Remove URLs, numbers, and special characters for better detection
        const cleanText = text.replace(/https?:\/\/[^\s]+/g, '').replace(/\d+/g, '').trim();
        
        if (this.languagePatterns.hinglish.test(cleanText)) {
            return 'hinglish';
        } else if (this.languagePatterns.hindi.test(cleanText)) {
            return 'hindi';
        } else if (this.languagePatterns.urdu.test(cleanText)) {
            return 'urdu';
        } else if (this.languagePatterns.bengali.test(cleanText)) {
            return 'bengali';
        } else if (this.languagePatterns.tamil.test(cleanText)) {
            return 'tamil';
        } else if (this.languagePatterns.gujarati.test(cleanText)) {
            return 'gujarati';
        } else if (this.languagePatterns.english.test(cleanText)) {
            return 'english';
        }
        
        return 'hinglish'; // Default to hinglish for mixed content
    }
    
    buildPrompt(message, language, history, context) {
        const systemPrompts = {
            hinglish: `You are a friendly WhatsApp assistant named ${this.botName}. Reply in natural Hinglish (Hindi + English mix) like a real Indian friend would. Be conversational, helpful, and use common Hindi words mixed with English. Keep replies short and casual, max 2-3 sentences. Use emojis naturally but don't overdo it.`,
            
            hindi: `आप ${this.botName} नाम के WhatsApp असिस्टेंट हैं। हिंदी में प्राकृतिक और मैत्रीपूर्ण तरीके से जवाब दें। संक्षिप्त और सहायक रहें।`,
            
            english: `You are ${this.botName}, a WhatsApp assistant. Reply in clear, friendly English. Be conversational and helpful. Keep responses brief and natural.`,
            
            urdu: `آپ ${this.botName} نامی WhatsApp اسسٹنٹ ہیں۔ اردو میں دوستانہ انداز میں جواب دیں۔ مختصر اور مددگار رہیں۔`,
            
            bengali: `আপনি ${this.botName} নামের WhatsApp সহায়ক। বাংলায় বন্ধুত্বপূর্ণ ভাবে উত্তর দিন। সংক্ষিপ্ত এবং সহায়ক থাকুন।`,
            
            tamil: `நீங்கள் ${this.botName} என்ற WhatsApp உதவியாளர். தமிழில் நட்பான முறையில் பதிலளிக்கவும். சுருக்கமாகவும் உதவிகரமாகவும் இருங்கள்।`,
            
            gujarati: `તમે ${this.botName} નામના WhatsApp સહાયક છો। ગુજરાતીમાં મિત્રતાપૂર્ણ રીતે જવાબ આપો। ટૂંકા અને મદદરૂપ રહો।`
        };
        
        const systemPrompt = systemPrompts[language] || systemPrompts.hinglish;
        
        let contextualPrompt = systemPrompt;
        
        // Add conversation history context
        if (history.length > 0) {
            contextualPrompt += '\n\nConversation history (last few messages):';
            history.slice(-3).forEach(entry => {
                contextualPrompt += `\nUser: ${entry.userMessage}`;
                contextualPrompt += `\nYou: ${entry.aiReply}`;
            });
        }
        
        // Add special context handling
        contextualPrompt += this.getContextualInstructions(message, language);
        
        contextualPrompt += `\n\nUser's current message: ${message}`;
        contextualPrompt += `\n\nRespond naturally in ${language} as a helpful friend:`;
        
        return contextualPrompt;
    }
    
    getContextualInstructions(message, language) {
        let instructions = '';
        
        // Check for common patterns and add appropriate instructions
        const lowerMessage = message.toLowerCase();
        
        if (lowerMessage.includes('help') || lowerMessage.includes('madad') || lowerMessage.includes('সাহায্য')) {
            instructions += '\nUser is asking for help. Be supportive and offer specific assistance.';
        }
        
        if (lowerMessage.includes('price') || lowerMessage.includes('cost') || lowerMessage.includes('paisa') || lowerMessage.includes('টাকা')) {
            instructions += '\nUser is asking about pricing. Be helpful but mention you need more context.';
        }
        
        if (lowerMessage.includes('time') || lowerMessage.includes('samay') || lowerMessage.includes('সময়')) {
            instructions += '\nUser is asking about time-related information. Be helpful with scheduling.';
        }
        
        if (lowerMessage.includes('thank') || lowerMessage.includes('dhanyawad') || lowerMessage.includes('ধন্যবাদ')) {
            instructions += '\nUser is thanking you. Respond warmly and ask if they need anything else.';
        }
        
        // Emotional support detection
        if (lowerMessage.includes('sad') || lowerMessage.includes('upset') || lowerMessage.includes('problem') || 
            lowerMessage.includes('pareshan') || lowerMessage.includes('दुखी')) {
            instructions += '\nUser seems upset or has problems. Be empathetic and supportive.';
        }
        
        return instructions;
    }
    
    async callGeminiAPI(prompt) {
        try {
            const requestBody = {
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }],
                generationConfig: {
                    temperature: 0.8,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 200,
                    candidateCount: 1
                },
                safetySettings: [
                    {
                        category: 'HARM_CATEGORY_HARASSMENT',
                        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
                    },
                    {
                        category: 'HARM_CATEGORY_HATE_SPEECH',
                        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
                    },
                    {
                        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
                    },
                    {
                        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                        threshold: 'BLOCK_MEDIUM_AND_ABOVE'
                    }
                ]
            };
            
            const response = await axios.post(this.apiUrl, requestBody, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': this.apiKey
                },
                timeout: 15000 // 15 seconds timeout
            });
            
            if (response.data && response.data.candidates && response.data.candidates[0]) {
                const aiReply = response.data.candidates[0].content.parts[0].text.trim();
                
                // Clean up the response
                return this.cleanAIResponse(aiReply);
            }
            
            console.log('⚠️ No valid response from Gemini API');
            return null;
            
        } catch (error) {
            if (error.response) {
                console.error('❌ Gemini API error:', error.response.status, error.response.data);
            } else if (error.request) {
                console.error('❌ Gemini API network error:', error.message);
            } else {
                console.error('❌ Gemini API setup error:', error.message);
            }
            return null;
        }
    }
    
    cleanAIResponse(response) {
        // Remove markdown formatting
        let cleaned = response.replace(/\*\*(.*?)\*\*/g, '$1'); // Remove bold
        cleaned = cleaned.replace(/\*(.*?)\*/g, '$1'); // Remove italic
        cleaned = cleaned.replace(/`(.*?)`/g, '$1'); // Remove code formatting
        
        // Remove excessive line breaks
        cleaned = cleaned.replace(/\n\s*\n\s*\n/g, '\n\n');
        
        // Trim and ensure reasonable length
        cleaned = cleaned.trim();
        
        // Limit response length (WhatsApp friendly)
        if (cleaned.length > 500) {
            cleaned = cleaned.substring(0, 497) + '...';
        }
        
        return cleaned;
    }
    
    getConversationHistory(fromNumber) {
        return this.conversationHistory.get(fromNumber) || [];
    }
    
    updateConversationHistory(fromNumber, userMessage, aiReply, language) {
        const history = this.getConversationHistory(fromNumber);
        
        history.push({
            userMessage,
            aiReply,
            language,
            timestamp: new Date().toISOString()
        });
        
        // Keep only last 10 messages to prevent memory issues
        if (history.length > 10) {
            history.shift();
        }
        
        this.conversationHistory.set(fromNumber, history);
    }
    
    checkRateLimit(fromNumber) {
        const now = Date.now();
        const userLimits = this.rateLimits.get(fromNumber) || { count: 0, resetTime: now };
        
        // Reset counter every minute
        if (now > userLimits.resetTime) {
            userLimits.count = 0;
            userLimits.resetTime = now + 60000; // 1 minute
        }
        
        // Check if limit exceeded (max 2 messages per minute)
        if (userLimits.count >= parseInt(process.env.MESSAGE_RATE_LIMIT) || 2) {
            return false;
        }
        
        userLimits.count++;
        this.rateLimits.set(fromNumber, userLimits);
        
        return true;
    }
    
    getFallbackReply(language) {
        const fallbacks = {
            hinglish: 'Sorry yaar, thoda issue ho gaya. Tum bolo kya chahiye? 😅',
            hindi: 'माफ करें, कुछ समस्या हो गई। आप बताएं क्या चाहिए? 😅',
            english: 'Sorry, I encountered an issue. What can I help you with? 😅',
            urdu: 'معاف کریں، کچھ مسئلہ ہو گیا۔ آپ بتائیں کیا چاہیے؟ 😅',
            bengali: 'দুঃখিত, কিছু সমস্যা হয়েছে। আপনি বলুন কী লাগবে? 😅',
            tamil: 'மன்னிக்கவும், சில பிரச்சனை ஏற்பட்டது. நீங்கள் என்ன வேண்டும் என்று சொல்லுங்கள்? 😅',
            gujarati: 'માફ કરશો, થોડી સમસ્યા થઈ. તમે કહો શું જોઈએ? 😅'
        };
        
        return fallbacks[language] || fallbacks.hinglish;
    }
    
    cleanupOldConversations() {
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours
        
        let cleanedCount = 0;
        
        for (const [fromNumber, history] of this.conversationHistory.entries()) {
            if (history.length === 0) {
                this.conversationHistory.delete(fromNumber);
                cleanedCount++;
                continue;
            }
            
            const lastMessage = history[history.length - 1];
            const messageAge = now - new Date(lastMessage.timestamp).getTime();
            
            if (messageAge > maxAge) {
                this.conversationHistory.delete(fromNumber);
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`🧹 Cleaned up ${cleanedCount} old conversations`);
        }
        
        // Also cleanup rate limits
        for (const [fromNumber, limits] of this.rateLimits.entries()) {
            if (now > limits.resetTime + 300000) { // 5 minutes old
                this.rateLimits.delete(fromNumber);
            }
        }
    }
    
    // Get conversation stats
    getStats() {
        return {
            activeConversations: this.conversationHistory.size,
            totalMessages: Array.from(this.conversationHistory.values())
                .reduce((sum, history) => sum + history.length, 0),
            rateLimitedUsers: this.rateLimits.size,
            languages: this.getLanguageStats()
        };
    }
    
    getLanguageStats() {
        const languageCounts = {};
        
        for (const history of this.conversationHistory.values()) {
            for (const entry of history) {
                languageCounts[entry.language] = (languageCounts[entry.language] || 0) + 1;
            }
        }
        
        return languageCounts;
    }
    
    // Handle special commands
    handleSpecialCommands(message, fromNumber) {
        const lowerMessage = message.toLowerCase().trim();
        
        // Help command
        if (lowerMessage === '/help' || lowerMessage === 'help' || lowerMessage === 'मदद') {
            return this.getHelpMessage(this.detectLanguage(message));
        }
        
        // Clear history command
        if (lowerMessage === '/clear' || lowerMessage === 'clear history') {
            this.conversationHistory.delete(fromNumber);
            return 'Conversation history cleared! 🧹';
        }
        
        // Status command
        if (lowerMessage === '/status') {
            const stats = this.getStats();
            return `Bot Status:\n✅ Active\n💬 ${stats.activeConversations} conversations\n📊 ${stats.totalMessages} total messages`;
        }
        
        return null; // No special command found
    }
    
    getHelpMessage(language) {
        const helpMessages = {
            hinglish: `🤖 ${this.botName} Help:\n\n📱 Main features:\n• Natural conversation in multiple languages\n• Smart replies with context\n• Remembers our chat history\n\n🔧 Commands:\n/help - Show this help\n/clear - Clear chat history\n/status - Bot status\n\n💬 Just chat normally, I'll understand! 😊`,
            
            hindi: `🤖 ${this.botName} सहायता:\n\n📱 मुख्य विशेषताएं:\n• कई भाषाओं में प्राकृतिक बातचीत\n• संदर्भ के साथ स्मार्ट उत्तर\n• चैट इतिहास याद रखता है\n\n🔧 कमांड:\n/help - यह सहायता दिखाएं\n/clear - चैट इतिहास साफ़ करें\n/status - बॉट स्थिति\n\n💬 बस सामान्य रूप से चैट करें, मैं समझ जाऊंगा! 😊`,
            
            english: `🤖 ${this.botName} Help:\n\n📱 Main features:\n• Natural conversation in multiple languages\n• Smart contextual replies\n• Remembers chat history\n\n🔧 Commands:\n/help - Show this help\n/clear - Clear chat history\n/status - Bot status\n\n💬 Just chat normally, I understand multiple languages! 😊`
        };
        
        return helpMessages[language] || helpMessages.hinglish;
    }
    
    // Advanced language processing
    async processAdvancedLanguage(message, language) {
        // Handle code-switching (language mixing within same message)
        if (language === 'hinglish') {
            // Identify dominant language in mixed content
            const hindiWords = (message.match(/[\u0900-\u097F]+/g) || []).length;
            const englishWords = (message.match(/[a-zA-Z]+/g) || []).length;
            
            return {
                dominantLanguage: hindiWords > englishWords ? 'hindi' : 'english',
                mixedContent: true,
                hindiRatio: hindiWords / (hindiWords + englishWords)
            };
        }
        
        return {
            dominantLanguage: language,
            mixedContent: false,
            hindiRatio: 0
        };
    }
    
    // Sentiment analysis (basic)
    analyzeSentiment(message) {
        const positiveWords = ['good', 'great', 'awesome', 'nice', 'love', 'happy', 'अच्छा', 'बढ़िया', 'खुश', 'প্রিয়', 'ভাল'];
        const negativeWords = ['bad', 'sad', 'angry', 'hate', 'problem', 'issue', 'बुरा', 'दुखी', 'समस्या', 'খারাপ', 'দুঃখ'];
        
        const lowerMessage = message.toLowerCase();
        let positiveCount = positiveWords.filter(word => lowerMessage.includes(word)).length;
        let negativeCount = negativeWords.filter(word => lowerMessage.includes(word)).length;
        
        if (positiveCount > negativeCount) return 'positive';
        if (negativeCount > positiveCount) return 'negative';
        return 'neutral';
    }
    
    // Context-aware reply generation
    async generateContextAwareReply(message, fromNumber, context = {}) {
        // Check for special commands first
        const specialCommand = this.handleSpecialCommands(message, fromNumber);
        if (specialCommand) {
            return specialCommand;
        }
        
        // Analyze sentiment
        const sentiment = this.analyzeSentiment(message);
        context.sentiment = sentiment;
        
        // Process language
        const language = this.detectLanguage(message);
        const advancedLang = await this.processAdvancedLanguage(message, language);
        context.languageAnalysis = advancedLang;
        
        return await this.generateReply(message, fromNumber, context);
    }
    
    // Health check
    healthCheck() {
        return {
            status: 'healthy',
            apiKey: !!this.apiKey,
            model: this.model,
            activeConversations: this.conversationHistory.size,
            rateLimitedUsers: this.rateLimits.size,
            lastCleanup: this.lastCleanup || null
        };
    }
    
    // Graceful shutdown
    shutdown() {
        console.log('🤖 AI Reply system shutting down...');
        this.conversationHistory.clear();
        this.rateLimits.clear();
        console.log('✅ AI Reply system shutdown complete');
    }
}

module.exports = AIReply;
