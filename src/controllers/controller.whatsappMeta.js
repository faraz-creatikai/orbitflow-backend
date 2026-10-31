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




