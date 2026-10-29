import { normalizeMessageContent } from '@whiskeysockets/baileys';
import prisma from '../config/prismaClient.js';
import ApiError from '../utils/ApiError.js';


const keyOf = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// Turn a Baileys message into { type, body, fileName }. Returns null for
// reactions, protocol messages, etc. (we ignore those).
const parse = (m) => {
  const c = normalizeMessageContent(m.message);
  if (!c) return null;
  if (c.conversation) return { type: 'text', body: c.conversation };
  if (c.extendedTextMessage) return { type: 'text', body: c.extendedTextMessage.text || '' };
  if (c.imageMessage) return { type: 'image', body: c.imageMessage.caption || '' };
  if (c.videoMessage) return { type: 'video', body: c.videoMessage.caption || '' };
  if (c.documentMessage)
    return { type: 'document', body: c.documentMessage.caption || '', fileName: c.documentMessage.fileName };
  if (c.audioMessage) return { type: 'audio', body: '' };
  if (c.stickerMessage) return { type: 'sticker', body: '' };
  if (c.locationMessage) return { type: 'location', body: c.locationMessage.name || c.locationMessage.address || '' };
  const poll = c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3;
  if (poll) return { type: 'poll', body: poll.name || '' };
  return null;
};

// Called from baileys.js on every messages.upsert
export const saveWhatsAppMessage = async (adminId, m, emit) => {
  // newer Baileys may give an @lid jid; the real number is then in remoteJidAlt
  const jid = m.key.remoteJidAlt?.endsWith('@s.whatsapp.net') ? m.key.remoteJidAlt : m.key.remoteJid;
  if (!jid?.endsWith('@s.whatsapp.net')) return; // skips groups, status, unresolved lids

  const parsed = parse(m);
  if (!parsed) return;

  const fromMe = !!m.key.fromMe;
  try {
    const row = await prisma.whatsAppMessage.create({
      data: {
        adminId,
        phoneKey: keyOf(jid.split('@')[0]),
        waId: m.key.id,
        fromMe,
        type: parsed.type,
        body: parsed.body,
        fileName: parsed.fileName || null,
        status: 'sent',
        isRead: fromMe,
        timestamp: new Date(Number(m.messageTimestamp || Date.now() / 1000) * 1000),
      },
    });
    emit(adminId, 'whatsapp:message', row);
  } catch (e) {
    if (e.code !== 'P2002') console.error('saveWhatsAppMessage:', e.message); // P2002 = duplicate, fine
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