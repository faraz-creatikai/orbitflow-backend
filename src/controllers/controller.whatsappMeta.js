import prisma from "../config/prismaClient.js";
import { getSocket } from "../socket/socket.js";
import ApiError from "../utils/ApiError.js";


// Helper to emit events to a specific admin's socket room
const emitToAdmin = (adminId, event, payload) => {
    const io = getSocket();
    if (io) io.to(`admin:${adminId}`).emit(event, payload);
};

// ==========================================
// 1. AUTHENTICATION (Embedded Signup)
// ==========================================
export const connectMetaWhatsapp = async (req, res, next) => {
    try {
        const { code, waba_id, phone_number_id } = req.body;
        const adminId = req.admin.id;

        // 🛑 FIX 1: Relaxed validation. Meta sometimes omits phone_number_id during the coexistence flow.
        if (!code || !waba_id) {
            return next(new ApiError(400, "Missing required Meta OAuth parameters: code or waba_id"));
        }

        console.log(`🔄 [${adminId}] Exchanging WhatsApp OAuth code for token...`);

        // 🛑 FIX 2: Added `&redirect_uri=` at the end. Meta rejects JS SDK codes without this empty parameter.
        const tokenRes = await fetch(
            `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${process.env.FB_APP_ID}&client_secret=${process.env.FB_APP_SECRET}&code=${code}&redirect_uri=`
        );
        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.error("Short token error:", tokenData);
            return next(new ApiError(400, "Failed to exchange OAuth code for access token"));
        }

        const longRes = await fetch(
            `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.FB_APP_ID}&client_secret=${process.env.FB_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`
        );
        const longData = await longRes.json();

        if (!longData.access_token) {
            console.error("Long token error:", longData);
            return next(new ApiError(400, "Failed to get long-lived access token"));
        }

        const accessToken = longData.access_token;
        console.log(`✅ [${adminId}] Long-lived WhatsApp Token received`);

        const config = await prisma.whatsAppMetaConfig.upsert({
            where: { adminId },
            update: {
                wabaId: waba_id,
                phoneNumberId: phone_number_id || null, // Allow null if Meta omitted it
                accessToken: accessToken,
                activeProvider: "meta"
            },
            create: {
                adminId,
                wabaId: waba_id,
                phoneNumberId: phone_number_id || null,
                accessToken: accessToken,
                activeProvider: "meta"
            }
        });

        res.status(200).json({
            success: true,
            message: "Official WhatsApp Business connected successfully!",
            config
        });
    } catch (err) {
        console.error("❌ Meta WhatsApp Auth Error:", err.message);
        next(new ApiError(500, "Failed to authenticate WhatsApp account"));
    }
};

// ==========================================
// 2. WEBHOOK VERIFICATION (GET)
// ==========================================
/* export const verifyWhatsAppWebhook = (req, res) => {
    // This token is created by YOU. It must match what you paste in the Meta Developer Dashboard.
    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "my_secure_whatsapp_token_123";

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token) {
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("✅ WhatsApp Webhook verified by Meta");
            return res.status(200).send(challenge);
        } else {
            console.error("❌ WhatsApp Webhook verification failed (Token mismatch)");
            return res.sendStatus(403);
        }
    }
    
    return res.sendStatus(400);
}; */



// GET method to verify the webhook
export const verifyWhatsAppWebhook = (req, res) => {
    // Use a secure string here or load it from your .env file
    const verify_token = "my_secure_verify_token_123";

    // Parse parameters from the webhook verification request
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    // Check if a token and mode were sent
    if (mode && token) {
        if (mode === "subscribe" && token === verify_token) {
            console.log("WhatsApp Webhook Verified successfully!");
            // Respond with 200 OK and challenge token from the request
            return res.status(200).send(challenge);
        } else {
            // Responds with '403 Forbidden' if verify tokens do not match
            return res.sendStatus(403);
        }
    } else {
        return res.sendStatus(400);
    }
};

// ==========================================
// 3. INCOMING MESSAGES & STATUS UPDATES (POST)
// ==========================================
export const receiveWhatsAppMessage = async (req, res) => {
    // 1. ALWAYS return 200 OK immediately so Meta doesn't retry the payload
    res.sendStatus(200);

    try {
        const body = req.body;

        // Check if this is a WhatsApp Business Account event
        if (body.object !== "whatsapp_business_account") return;

        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0]?.value;

        if (!changes) return;

        const phoneNumberId = changes.metadata?.phone_number_id;

        // Find which Admin owns this phone number
        const config = await prisma.whatsAppMetaConfig.findFirst({
            where: { phoneNumberId }
        });

        if (!config) {
            console.log(`⚠️ Received WhatsApp webhook for unknown Phone Number ID: ${phoneNumberId}`);
            return;
        }

        const adminId = config.adminId;

        // ------------------------------------------------
        // A. Handle Status Updates (Sent, Delivered, Read)
        // ------------------------------------------------
        if (changes.statuses?.length > 0) {
            for (const statusObj of changes.statuses) {
                const waId = statusObj.id;
                const status = statusObj.status; // "sent", "delivered", "read", "failed"

                // Update the status in the database
                const updatedMsg = await prisma.whatsAppMessage.updateMany({
                    where: { adminId, waId },
                    data: { status }
                });

                if (updatedMsg.count > 0) {
                    emitToAdmin(adminId, "whatsapp:message_status", { waId, status });
                }
            }
        }

        // ------------------------------------------------
        // B. Handle Incoming Messages (Text, Image, etc.)
        // ------------------------------------------------
        if (changes.messages?.length > 0) {
            for (const msg of changes.messages) {
                const waId = msg.id;
                const fromPhone = msg.from; // e.g., "919876543210"
                const phoneKey = fromPhone.slice(-10); // Extract last 10 digits to match your DB logic
                const type = msg.type; // "text", "image", "document", etc.

                let messageBody = "";
                let mediaUrl = null;

                // Extract content based on message type
                if (type === "text") {
                    messageBody = msg.text?.body || "";
                } else if (type === "image") {
                    messageBody = msg.image?.caption || "";
                    // Meta Media ID. You will need a separate function to download this if you want it locally.
                    // mediaUrl = msg.image.id; 
                } else if (type === "document") {
                    messageBody = msg.document?.caption || msg.document?.filename || "";
                } else if (type === "button") { // If they clicked a quick reply template button
                    messageBody = msg.button?.text || "";
                }

                // Check if message already exists to prevent duplicates
                const exists = await prisma.whatsAppMessage.findUnique({
                    where: { adminId_waId: { adminId, waId } }
                });

                if (exists) continue;

                // Save to database
                const savedMsg = await prisma.whatsAppMessage.create({
                    data: {
                        adminId,
                        phoneKey,
                        waId,
                        fromMe: false, // It's an incoming message
                        type: type === "button" ? "text" : type,
                        body: messageBody,
                        status: "delivered", // Mark as delivered since it reached your server
                        isRead: false,
                        source: "meta", // 👈 Mark that it came from official API, not Baileys
                        mediaUrl,
                        timestamp: new Date(Number(msg.timestamp) * 1000),
                    }
                });

                // Emit to frontend CRM in real-time
                emitToAdmin(adminId, "whatsapp:message", savedMsg);
            }
        }
    } catch (error) {
        console.error("❌ Error processing WhatsApp Webhook:", error.message);
    }
};


// ==========================================
// 4. CHECK CONNECTION STATUS (GET)
// ==========================================
export const checkWhatsAppConnection = async (req, res, next) => {
    try {
        const adminId = req.admin.id;

        const config = await prisma.whatsAppMetaConfig.findUnique({
            where: { adminId }
        });

        if (config && config.activeProvider === "meta") {
            // 1. Fetch phone number details (verified name, display number, quality rating)
            const phoneRes = await fetch(
                `https://graph.facebook.com/v21.0/${config.phoneNumberId}?fields=verified_name,display_phone_number,quality_rating&access_token=${config.accessToken}`
            );
            const phoneData = await phoneRes.json();

            if (phoneData.error) {
                console.error("Meta Phone API Error:", phoneData.error.message);
                return res.status(200).json({ connected: false });
            }

            // 2. Fetch business profile details (profile picture, about) from the correct sub-endpoint
            const profileRes = await fetch(
                `https://graph.facebook.com/v21.0/${config.phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url,about&access_token=${config.accessToken}`
            );
            const profileData = await profileRes.json();

            // Extract profile picture safely (profileData.data[0] contains the profile object)
            const profilePictureUrl = profileData.data?.[0]?.profile_picture_url || null;

            return res.status(200).json({
                connected: true,
                config,
                accountDetails: {
                    name: phoneData.verified_name || "WhatsApp Business Account",
                    phone: phoneData.display_phone_number || "Unknown Number",
                    profilePicture: profilePictureUrl,
                    qualityRating: phoneData.quality_rating || "UNKNOWN"
                }
            });
        }

        return res.status(200).json({ connected: false });
    } catch (err) {
        console.error("❌ Check Connection Error:", err.message);
        next(new ApiError(500, "Failed to check WhatsApp connection status"));
    }
};


// ==========================================
// 5. DISCONNECT WHATSAPP (DELETE)
// ==========================================
export const disconnectMetaWhatsapp = async (req, res, next) => {
    try {
        const adminId = req.admin.id;

        // Check if config exists before deleting to avoid Prisma throw
        const existingConfig = await prisma.whatsAppMetaConfig.findUnique({
            where: { adminId }
        });

        if (!existingConfig) {
            return res.status(404).json({ success: false, message: "No WhatsApp connection found." });
        }

        await prisma.whatsAppMetaConfig.delete({
            where: { adminId }
        });

        console.log(`🔌 [${adminId}] WhatsApp configuration deleted.`);
        res.status(200).json({ success: true, message: "WhatsApp disconnected successfully." });
    } catch (err) {
        console.error("❌ Disconnect Error:", err.message);
        next(new ApiError(500, "Failed to disconnect WhatsApp account"));
    }
};



// ==========================================
// 6. SEND MESSAGE (POST)
// ==========================================
export const sendMetaWhatsAppMessage = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { toPhone, messageBody } = req.body;

        // 1. Verify Meta config exists
        const config = await prisma.whatsAppMetaConfig.findUnique({
            where: { adminId }
        });

        if (!config || config.activeProvider !== "meta" || !config.accessToken || !config.phoneNumberId) {
            return next(new ApiError(400, "Official WhatsApp is not configured or active."));
        }

        // 2. Format phone number (Meta requires country code without '+' or spaces)
        // e.g., "+91 98765-43210" -> "919876543210"
        const cleanPhone = toPhone.replace(/\D/g, "");

        // 3. Send to Meta Graph API
        const metaRes = await fetch(
            `https://graph.facebook.com/v21.0/${config.phoneNumberId}/messages`,
            {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${config.accessToken}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: cleanPhone,
                    type: "text",
                    text: { preview_url: false, body: messageBody }
                })
            }
        );

        const metaData = await metaRes.json();

        if (metaData.error) {
            console.error("Meta Send API Error:", metaData.error);
            return next(new ApiError(400, metaData.error.message || "Failed to send message via Meta"));
        }

        // 4. Save outgoing message to database
        const savedMsg = await prisma.whatsAppMessage.create({
            data: {
                adminId,
                phoneKey: cleanPhone.slice(-10), // Keep consistent with incoming webhook logic
                waId: metaData.messages[0].id,   // Meta's unique message ID
                fromMe: true,
                type: "text",
                body: messageBody,
                status: "sent",
                isRead: true,
                source: "meta",
                timestamp: new Date()
            }
        });

        // 5. Emit to Socket (keeps other admin tabs in sync)
        emitToAdmin(adminId, "whatsapp:message", savedMsg);

        res.status(200).json({
            success: true,
            message: "Message sent successfully",
            data: savedMsg
        });
    } catch (error) {
        console.error("❌ Send Meta Message Error:", error.message);
        next(new ApiError(500, "Internal server error while sending WhatsApp message"));
    }
};




// ==========================================
// 7. GET META INBOX SUMMARY (GET)
// ==========================================
export const getMetaInboxSummary = async (req, res, next) => {
    try {
        const adminId = req.admin.id;

        // Fetch all Meta messages for this admin, ordered by newest first
        const messages = await prisma.whatsAppMessage.findMany({
            where: { adminId, source: "meta" },
            orderBy: { timestamp: "desc" }
        });

        // Group by phoneKey to get the latest message and unread count per contact
        const chatMap = new Map();

        for (const msg of messages) {
            if (!chatMap.has(msg.phoneKey)) {
                chatMap.set(msg.phoneKey, {
                    phoneKey: msg.phoneKey,
                    body: msg.body,
                    type: msg.type,
                    fromMe: msg.fromMe,
                    timestamp: msg.timestamp,
                    unread: 0
                });
            }
            // Increment unread count if it's an incoming, unread message
            if (!msg.fromMe && !msg.isRead) {
                chatMap.get(msg.phoneKey).unread += 1;
            }
        }

        res.status(200).json({ success: true, chats: Array.from(chatMap.values()) });
    } catch (err) {
        console.error("❌ Get Meta Inbox Summary Error:", err.message);
        next(new ApiError(500, "Failed to load inbox summary"));
    }
};

// ==========================================
// 8. GET META CHAT HISTORY (GET)
// ==========================================
export const getMetaChatHistory = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { phoneKey } = req.params;

        const messages = await prisma.whatsAppMessage.findMany({
            where: { adminId, phoneKey, source: "meta" },
            orderBy: { timestamp: "asc" }
        });

        res.status(200).json({ success: true, messages });
    } catch (err) {
        console.error("❌ Get Meta Chat History Error:", err.message);
        next(new ApiError(500, "Failed to load chat history"));
    }
};

// ==========================================
// 9. MARK META CHAT AS READ (POST)
// ==========================================
export const markMetaChatRead = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { phoneKey } = req.params;

        await prisma.whatsAppMessage.updateMany({
            where: { adminId, phoneKey, source: "meta", fromMe: false, isRead: false },
            data: { isRead: true }
        });

        res.status(200).json({ success: true });
    } catch (err) {
        console.error("❌ Mark Meta Chat Read Error:", err.message);
        next(new ApiError(500, "Failed to mark messages as read"));
    }
};



// templates

// ==========================================
// 11. GET META TEMPLATES STATUS (GET)
// ==========================================
export const getMetaTemplates = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const config = await prisma.whatsAppMetaConfig.findUnique({ where: { adminId } });
        
        if (!config || config.activeProvider !== "meta" || !config.wabaId) {
            return res.status(200).json({ success: true, metaTemplates: [] });
        }

        // Fetch all templates associated with this WhatsApp Business Account
        const metaRes = await fetch(
            `https://graph.facebook.com/v21.0/${config.wabaId}/message_templates?access_token=${config.accessToken}`
        );
        const data = await metaRes.json();

        if (data.error) throw new Error(data.error.message);

        res.status(200).json({ success: true, metaTemplates: data.data || [] });
    } catch (err) {
        console.error("❌ Get Meta Templates Error:", err.message);
        next(new ApiError(500, "Failed to fetch templates from Meta"));
    }
};



// ==========================================
// 12. SUBMIT CRM TEMPLATES TO META (POST) - BULK CAPABLE
// ==========================================
export const verifyMetaTemplate = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const { templateId, templateIds } = req.body;

        const idsToVerify = templateIds || (templateId ? [templateId] : []);

        if (idsToVerify.length === 0) {
            return next(new ApiError(400, "Please provide at least one template ID."));
        }

        const config = await prisma.whatsAppMetaConfig.findUnique({ where: { adminId } });
        if (!config || !config.wabaId) {
            return next(new ApiError(400, "Meta WhatsApp is not configured."));
        }

        const results = [];

        for (const id of idsToVerify) {
            const crmTemplate = await prisma.template.findUnique({ where: { id } });
            if (!crmTemplate) continue;

            const metaName = crmTemplate.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
            
            // 1. Sanitize Variables: Convert {{Name}} or {{anything}} to {{1}}, {{2}}
            let metaBodyText = crmTemplate.body;
            let exampleData = [];
            
            // Match anything inside double curly braces
            const varMatches = metaBodyText.match(/\{\{(.+?)\}\}/g);
            if (varMatches) {
                varMatches.forEach((match, index) => {
                    // Replace {{Name}} with {{1}}, {{2}}, etc.
                    metaBodyText = metaBodyText.replace(match, `{{${index + 1}}}`);
                    exampleData.push("Example" + (index + 1));
                });
            }

            const components = [{ 
                type: "BODY", 
                text: metaBodyText 
            }];

            // Meta requires an array inside an array for body_text examples
            if (exampleData.length > 0) {
                components[0].example = { body_text: [exampleData] };
            }

            // 2. Handle Media Headers (Images/Documents)
            if (crmTemplate.whatsappMediaType === "image") {
                components.push({
                    type: "HEADER",
                    format: "IMAGE",
                    example: { header_url: ["https://www.facebook.com/images/fb_icon_325x325.png"] } 
                });
            } else if (crmTemplate.whatsappMediaType === "document") {
                components.push({
                    type: "HEADER",
                    format: "DOCUMENT",
                    example: { header_url: ["https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"] }
                });
            }

            // 3. Send to Meta
            const metaRes = await fetch(
                `https://graph.facebook.com/v21.0/${config.wabaId}/message_templates`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${config.accessToken}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        name: metaName,
                        category: "MARKETING",
                        language: "en_US",
                        components
                    })
                }
            );

            const data = await metaRes.json();
            
            results.push({ 
                id, 
                name: crmTemplate.name, 
                success: !data.error, 
                error: data.error?.message || null 
            });
        }

        res.status(200).json({ 
            success: true, 
            message: `Processed ${idsToVerify.length} template(s) for verification.`,
            results 
        });
    } catch (err) {
        console.error("❌ Verify Template Error:", err.message);
        next(new ApiError(500, "Internal server error while submitting templates"));
    }
};