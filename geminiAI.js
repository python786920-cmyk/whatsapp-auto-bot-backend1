const { GoogleGenerativeAI } = require('@google/generative-ai');

class GeminiAI {
    constructor() {
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model = this.genAI.getGenerativeModel({ 
            model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
            generationConfig: {
                temperature: parseFloat(process.env.AI_TEMPERATURE) || 0.7,
                maxOutputTokens: parseInt(process.env.AI_MAX_TOKENS) || 150,
            }
        });
        
        this.chatHistory = new Map(); // Store conversation history per contact
        this.lastReplyTime = new Map(); // Rate limiting per contact
        
        console.log('✅ Gemini AI initialized successfully');
    }

    // Generate AI response based on incoming message
    async generateReply(messageText, contactNumber, contactName = 'Friend') {
        try {
            // Rate limiting check
            if (!this.canReply(contactNumber)) {
                console.log(`⏳ Rate limited for ${contactNumber}`);
                return null;
            }

            // Detect language of incoming message
            const detectedLanguage = this.detectLanguage(messageText);
            
            // Get conversation history
            const history = this.getChatHistory(contactNumber);
            
            // Create context-aware prompt
            const prompt = this.createPrompt(messageText, contactName, detectedLanguage, history);
            
            // Generate AI response
            const result = await this.model.generateContent(prompt);
            const response = result.response;
            const reply = response.text().trim();
            
            // Update chat history
            this.updateChatHistory(contactNumber, messageText, reply);
            
            // Update last reply time for rate limiting
            this.lastReplyTime.set(contactNumber, Date.now());
            
            console.log(`🤖 AI Reply generated for ${contactName}: ${reply.substring(0, 50)}...`);
            return reply;
            
        } catch (error) {
            console.error('❌ Gemini AI Error:', error.message);
            return this.getFallbackReply(messageText);
        }
    }

    // Create smart prompt with context and personality
    createPrompt(message, contactName, language, history) {
        const historyContext = history.length > 0 
            ? `Previous conversation:\n${history.slice(-4).map(h => `${h.type}: ${h.message}`).join('\n')}\n\n`
            : '';

        const basePrompt = `
You are a friendly, helpful WhatsApp chat assistant. Reply naturally like a close friend.

IMPORTANT RULES:
- Keep replies SHORT (max 50 words)
- Match the language style: ${language}
- Be casual, warm, and friendly
- Use emojis naturally (2-3 max)
- Don't be overly formal or robotic
- If asked about previous conversations, refer to context
- For greetings, respond warmly
- For questions, give helpful short answers
- For casual chat, be engaging and fun

${historyContext}Current message from ${contactName}: "${message}"

Reply in ${language} style:`;

        return basePrompt;
    }

    // Detect message language
    detectLanguage(text) {
        const hindiWords = /[\u0900-\u097F]/.test(text);
        const englishWords = /[a-zA-Z]/.test(text);
        
        if (hindiWords && englishWords) return 'hinglish';
        if (hindiWords) return 'hindi';
        if (englishWords) return 'english';
        
        // Check for common Hinglish patterns
        const hinglishPatterns = [
            /\b(kya|hai|hain|mein|tum|aap|bhi|kar|kaise|kaha|kab)\b/i,
            /\b(yaar|bhai|dude|bro|buddy)\b/i,
            /\b(ok|okay|thanks|sorry|please)\b/i
        ];
        
        if (hinglishPatterns.some(pattern => pattern.test(text))) {
            return 'hinglish';
        }
        
        return 'hinglish'; // Default to hinglish
    }

    // Get chat history for context
    getChatHistory(contactNumber) {
        return this.chatHistory.get(contactNumber) || [];
    }

    // Update chat history
    updateChatHistory(contactNumber, userMessage, botReply) {
        let history = this.getChatHistory(contactNumber);
        
        // Add user message
        history.push({
            type: 'User',
            message: userMessage,
            timestamp: new Date()
        });
        
        // Add bot reply
        history.push({
            type: 'Bot',
            message: botReply,
            timestamp: new Date()
        });
        
        // Keep only last 10 messages to manage memory
        if (history.length > 10) {
            history = history.slice(-10);
        }
        
        this.chatHistory.set(contactNumber, history);
    }

    // Rate limiting check
    canReply(contactNumber) {
        const lastReply = this.lastReplyTime.get(contactNumber);
        const maxMessagesPerMinute = parseInt(process.env.MAX_MESSAGES_PER_MINUTE) || 2;
        const oneMinute = 60 * 1000;
        
        if (!lastReply) return true;
        
        return (Date.now() - lastReply) > (oneMinute / maxMessagesPerMinute);
    }

    // Fallback reply when AI fails
    getFallbackReply(originalMessage) {
        const fallbackReplies = [
            "Sorry yaar, thoda technical issue ho gaya 😅 Kya keh rahe the?",
            "Arre yaar, samjha nahi. Thoda aur detail mein batao na 🤔",
            "Oops! Kuch problem hai mere system mein. Dobara try karo 😊",
            "Sorry bro, connection issue hai. Thoda wait karo 🙏",
            "Arre, maine suna nahi properly. Phir se bolo na 👂"
        ];
        
        return fallbackReplies[Math.floor(Math.random() * fallbackReplies.length)];
    }

    // Clear chat history for a contact
    clearChatHistory(contactNumber) {
        this.chatHistory.delete(contactNumber);
        console.log(`🗑️ Chat history cleared for ${contactNumber}`);
    }

    // Get stats
    getStats() {
        return {
            totalChats: this.chatHistory.size,
            totalMessages: Array.from(this.chatHistory.values())
                .reduce((total, history) => total + history.length, 0),
            activeChats: Array.from(this.chatHistory.values())
                .filter(history => {
                    const lastMessage = history[history.length - 1];
                    const oneHour = 60 * 60 * 1000;
                    return lastMessage && (Date.now() - lastMessage.timestamp) < oneHour;
                }).length
        };
    }

    // Cleanup old conversations
    cleanup() {
        const oneDay = 24 * 60 * 60 * 1000;
        const now = Date.now();
        
        for (const [contactNumber, history] of this.chatHistory.entries()) {
            if (history.length === 0) continue;
            
            const lastMessage = history[history.length - 1];
            if (now - lastMessage.timestamp.getTime() > oneDay) {
                this.chatHistory.delete(contactNumber);
                console.log(`🧹 Cleaned up old chat history for ${contactNumber}`);
            }
        }
    }
}

module.exports = GeminiAI;
