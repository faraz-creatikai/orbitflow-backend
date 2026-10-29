import { normalizeMessageContent, downloadMediaMessage } from '@whiskeysockets/baileys';
import prisma from '../config/prismaClient.js';
import ApiError from '../utils/ApiError.js';
import pino from 'pino';


const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // skip downloading anything bigger

const keyOf = (v) => String(v || '').replace(/\D/g, '').slice(-10);

const parse = (m) => {
    const c = normalizeMessageContent(m.message);
    if (!c) return null;
    if (c.conversation) return { type: 'text', body: c.conversation };
    if (c.extendedTextMessage) return { type: 'text', body: c.extendedTextMessage.text || '' };
    if (c.imageMessage) return { type: 'image', body: c.imageMessage.caption || '', media: c.imageMessage };
    if (c.videoMessage) return { type: 'video', body: c.videoMessage.caption || '', media: c.videoMessage };
    if (c.documentMessage)
        return { type: 'document', body: c.documentMessage.caption || '', fileName: c.documentMessage.fileName, media: c.documentMessage };
    if (c.audioMessage) return { type: 'audio', body: '', media: c.audioMessage };
    if (c.stickerMessage) return { type: 'sticker', body: '', media: c.stickerMessage };
    if (c.locationMessage) {
        const l = c.locationMessage;
        return { type: 'location', body: l.name || l.address || '', lat: l.degreesLatitude, lng: l.degreesLongitude };
    }
    const poll = c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3;
    if (poll)
        return { type: 'poll', body: poll.name || '', pollOptions: (poll.options || []).map((o) => o.optionName) };
    return null;
};

const uploadMedia = async (m, parsed, sock) => {
  try {
    if (Number(String(parsed.media.fileLength)) > MAX_MEDIA_BYTES) return null;

    const buffer = await downloadMediaMessage(m, 'buffer', {}, {
      logger: pino({ level: 'silent' }),
      reuploadRequest: sock.updateMediaMessage,
    });

    // documents go up as "raw" so the file keeps its real name/extension in the URL
    const opts =
      parsed.type === 'document'
        ? { resource_type: 'raw', public_id: `whatsapp-inbox/${Date.now()}-${(parsed.fileName || 'file').replace(/[^\w.\-]/g, '_')}` }
        : { resource_type: 'auto', folder: 'whatsapp-inbox' };

    return await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(opts, (err, r) => (err ? reject(err) : resolve(r.secure_url))).end(buffer);
    });
  } catch (e) {
    console.error('WhatsApp media upload failed:', e.message);
    return null;
  }
};

// Called from baileys.js on every messages.upsert
export const saveWhatsAppMessage = async (adminId, m, emit, sock) => {
  const jid = m.key.remoteJidAlt?.endsWith('@s.whatsapp.net') ? m.key.remoteJidAlt : m.key.remoteJid;
  if (!jid?.endsWith('@s.whatsapp.net')) return;

  const parsed = parse(m);
  if (!parsed) return;

  const waId = m.key.id;
  const fromMe = !!m.key.fromMe;

  let mediaUrl = null;
  if (parsed.media) {
    // don't download the same file twice if Baileys delivers the message again
    const exists = await prisma.whatsAppMessage.findUnique({
      where: { adminId_waId: { adminId, waId } },
      select: { id: true },
    });
    if (exists) return;
    mediaUrl = await uploadMedia(m, parsed, sock);
  }

  try {
    const row = await prisma.whatsAppMessage.create({
      data: {
        adminId,
        phoneKey: keyOf(jid.split('@')[0]),
        waId,
        fromMe,
        type: parsed.type,
        body: parsed.body,
        fileName: parsed.fileName || null,
        mediaUrl,
        lat: parsed.lat ?? null,
        lng: parsed.lng ?? null,
        pollOptions: parsed.pollOptions ?? undefined,
        status: 'sent',
        isRead: fromMe,
        timestamp: new Date(Number(m.messageTimestamp || Date.now() / 1000) * 1000),
      },
    });
    emit(adminId, 'whatsapp:message', row);
  } catch (e) {
    if (e.code !== 'P2002') console.error('saveWhatsAppMessage:', e.message);
  }
};

// Called from baileys.js on messages.update (✓ delivered / ✓✓ read ticks)
export const updateWhatsAppStatus = async (adminId, updates, emit) => {
    for (const u of updates) {
        const st = u.update?.status;
        if (!st || !u.key?.fromMe) continue;
        const status = st >= 4 ? 'read' : st === 3 ? 'delivered' : 'sent';
        const r = await prisma.whatsAppMessage.updateMany({ where: { adminId, waId: u.key.id }, data: { status } });
        if (r.count) emit(adminId, 'whatsapp:message_status', { waId: u.key.id, status });
    }
};

// GET /whatsapp/inbox/summary → last message + unread count per chat
export const getInboxSummary = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const [last, unread] = await Promise.all([
            prisma.whatsAppMessage.findMany({
                where: { adminId },
                orderBy: { timestamp: 'desc' },
                distinct: ['phoneKey'],
                select: { phoneKey: true, body: true, type: true, fromMe: true, timestamp: true },
            }),
            prisma.whatsAppMessage.groupBy({
                by: ['phoneKey'],
                where: { adminId, fromMe: false, isRead: false },
                _count: { _all: true },
            }),
        ]);
        const unreadMap = Object.fromEntries(unread.map((u) => [u.phoneKey, u._count._all]));
        res.json({ success: true, chats: last.map((l) => ({ ...l, unread: unreadMap[l.phoneKey] || 0 })) });
    } catch (err) {
        next(new ApiError(500, err.message));
    }
};

// GET /whatsapp/inbox/chat/:phoneKey?before=<ISO>  → 50 messages per page, oldest first
export const getChatMessages = async (req, res, next) => {
    try {
        const adminId = req.admin.id;
        const phoneKey = keyOf(req.params.phoneKey);
        const limit = 50;
        const { before } = req.query;

        const rows = await prisma.whatsAppMessage.findMany({
            where: { adminId, phoneKey, ...(before ? { timestamp: { lt: new Date(before) } } : {}) },
            orderBy: { timestamp: 'desc' },
            take: limit,
        });

        if (!before) {
            await prisma.whatsAppMessage.updateMany({
                where: { adminId, phoneKey, fromMe: false, isRead: false },
                data: { isRead: true },
            });
        }
        res.json({ success: true, messages: rows.reverse(), hasMore: rows.length === limit });
    } catch (err) {
        next(new ApiError(500, err.message));
    }
};

// POST /whatsapp/inbox/chat/:phoneKey/read
export const markChatRead = async (req, res, next) => {
    try {
        await prisma.whatsAppMessage.updateMany({
            where: { adminId: req.admin.id, phoneKey: keyOf(req.params.phoneKey), fromMe: false, isRead: false },
            data: { isRead: true },
        });
        res.json({ success: true });
    } catch (err) {
        next(new ApiError(500, err.message));
    }
};