import { getStore } from "@netlify/blobs";

const MAX_BODY_BYTES = 10_000;
const STORE_NAME = "bigbrovn-uid-requests";
const STATUS_BY_CODE = {
  r: "received",
  c: "checking",
  e: "eligible",
  n: "needs_info",
  d: "completed",
};
const CODE_BY_STATUS = Object.fromEntries(
  Object.entries(STATUS_BY_CODE).map(([code, status]) => [status, code]),
);
const STATUS_LABEL = {
  received: "✅ Đã tiếp nhận",
  checking: "🔎 Đang kiểm tra UID",
  eligible: "✅ Đủ điều kiện",
  needs_info: "⚠️ Cần bổ sung",
  completed: "🎉 Hoàn tất",
};

function corsOrigin(request) {
  const origin = request.headers.get("origin") || "";
  const configured = (process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set([
    "https://bigbrovn.github.io",
    process.env.URL,
    ...configured,
  ].filter(Boolean));
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return allowed.has(origin) || local ? origin : "";
}

function reply(request, body, status = 200) {
  const origin = corsOrigin(request);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "vary": "Origin",
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  return Response.json(body, { status, headers });
}

function oneLine(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function multiLine(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function requestStore() {
  return getStore(STORE_NAME);
}

function requestKey(requestId) {
  return `request-${String(requestId || "").trim().toUpperCase()}`;
}

async function saveRequest(record) {
  await requestStore().setJSON(requestKey(record.requestId), record);
}

async function getRequest(requestId) {
  const id = String(requestId || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,24}$/.test(id)) return null;
  return requestStore().get(requestKey(id), { type: "json", consistency: "strong" });
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function callbackSignature(requestId, code, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${requestId}:${code}`),
  );
  return base64Url(new Uint8Array(signature)).slice(0, 14);
}

async function callbackData(requestId, status, secret) {
  const code = CODE_BY_STATUS[status];
  const signature = await callbackSignature(requestId, code, secret);
  return `bb:${requestId}:${code}:${signature}`;
}

async function statusKeyboard(requestId, secret) {
  return {
    inline_keyboard: [
      [{ text: "🔎 Đang kiểm tra UID", callback_data: await callbackData(requestId, "checking", secret) }],
      [
        { text: "✅ Đủ điều kiện", callback_data: await callbackData(requestId, "eligible", secret) },
        { text: "⚠️ Cần bổ sung", callback_data: await callbackData(requestId, "needs_info", secret) },
      ],
      [{ text: "🎉 Hoàn tất", callback_data: await callbackData(requestId, "completed", secret) }],
    ],
  };
}

async function telegramCall(botToken, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${response.status}`);
  }
  return data;
}

async function ensureTelegramWebhook(request, botToken) {
  try {
    const webhookUrl = new URL(request.url);
    webhookUrl.search = "";
    webhookUrl.hash = "";
    const body = {
      url: webhookUrl.toString(),
      allowed_updates: ["callback_query"],
    };
    if (process.env.TELEGRAM_WEBHOOK_SECRET) {
      body.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
    }
    await telegramCall(botToken, "setWebhook", body);
  } catch (error) {
    console.error("Telegram webhook setup failed", error instanceof Error ? error.message : "unknown");
  }
}

async function handleTelegramCallback(request, payload, botToken, chatId) {
  const callback = payload?.callback_query;
  if (!callback) return null;

  if (
    process.env.TELEGRAM_WEBHOOK_SECRET &&
    request.headers.get("x-telegram-bot-api-secret-token") !== process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return reply(request, { ok: false }, 403);
  }

  const data = String(callback.data || "");
  const match = /^bb:([A-Z0-9-]{6,24}):([rcend]):([A-Za-z0-9_-]{8,24})$/.exec(data);
  if (!match) return reply(request, { ok: true });

  const [, requestId, code, receivedSignature] = match;
  const expectedChat = String(chatId);
  const callbackChat = String(callback?.message?.chat?.id ?? "");
  const secret = process.env.TELEGRAM_CALLBACK_SECRET || botToken;
  const expectedSignature = await callbackSignature(requestId, code, secret);

  if (callbackChat !== expectedChat || receivedSignature !== expectedSignature) {
    try {
      await telegramCall(botToken, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Nút không hợp lệ hoặc đã hết hiệu lực.",
        show_alert: true,
      });
    } catch {}
    return reply(request, { ok: true });
  }

  const status = STATUS_BY_CODE[code];
  const record = await getRequest(requestId);
  if (!record) {
    try {
      await telegramCall(botToken, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Không tìm thấy yêu cầu này.",
        show_alert: true,
      });
    } catch {}
    return reply(request, { ok: true });
  }

  const updated = {
    ...record,
    status,
    updatedAt: new Date().toISOString(),
    updatedBy: oneLine(callback?.from?.username || callback?.from?.first_name || "telegram", 80),
  };
  await saveRequest(updated);

  const keyboard = await statusKeyboard(requestId, secret);
  const messageText = `${record.baseText}\n\nTrạng thái: ${STATUS_LABEL[status]}`;

  try {
    await telegramCall(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: callback.message.message_id,
      text: messageText,
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error("Telegram editMessageText failed", error instanceof Error ? error.message : "unknown");
  }

  try {
    await telegramCall(botToken, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: STATUS_LABEL[status],
    });
  } catch {}

  return reply(request, { ok: true });
}

export default async (request) => {
  const origin = request.headers.get("origin") || "";
  const allowedOrigin = corsOrigin(request);

  if (request.method === "OPTIONS") {
    if (origin && !allowedOrigin) return reply(request, { ok: false }, 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "vary": "Origin",
      },
    });
  }

  if (request.method === "GET") {
    if (origin && !allowedOrigin) return reply(request, { ok: false }, 403);
    const url = new URL(request.url);
    const requestId = oneLine(url.searchParams.get("requestId"), 24).toUpperCase();
    if (requestId) {
      try {
        const record = await getRequest(requestId);
        if (!record) return reply(request, { ok: false, code: "not_found" }, 404);
        return reply(request, {
          ok: true,
          requestId: record.requestId,
          status: record.status || "received",
          updatedAt: record.updatedAt || record.sentAt || null,
        });
      } catch (error) {
        console.error("Status lookup failed", error instanceof Error ? error.message : "unknown");
        return reply(request, { ok: false }, 503);
      }
    }

    const configured = Boolean(
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID,
    );
    return reply(
      request,
      { ok: configured, configured },
      configured ? 200 : 503,
    );
  }

  if (request.method !== "POST") return reply(request, { ok: false }, 405);
  if (origin && !allowedOrigin) return reply(request, { ok: false }, 403);

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY_BYTES) return reply(request, { ok: false }, 413);

  let payload;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return reply(request, { ok: false }, 413);
    payload = JSON.parse(raw);
  } catch {
    return reply(request, { ok: false }, 400);
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return reply(request, { ok: false, code: "telegram_not_configured" }, 503);
  }

  const callbackResponse = await handleTelegramCallback(request, payload, botToken, chatId);
  if (callbackResponse) return callbackResponse;

  // Honeypot submissions receive a neutral response without reaching Telegram.
  if (oneLine(payload.website, 100)) return reply(request, { ok: true });

  const startedAt = Number(payload.startedAt || 0);
  const elapsed = Date.now() - startedAt;
  if (!Number.isFinite(startedAt) || elapsed < 1_200 || elapsed > 86_400_000) {
    return reply(request, { ok: false }, 400);
  }

  const partner = oneLine(payload.partner, 80);
  const category = oneLine(payload.category, 40) || "Không xác định";
  const uid = oneLine(payload.uid, 80);
  const accountType = payload.accountType === "existing" ? "Đã có tài khoản" : "Tài khoản mới";
  const contactChannel = payload.contactChannel === "zalo" ? "Zalo" : "Telegram";
  const contact = oneLine(payload.contact, 100);
  const note = multiLine(payload.note, 500) || "Không có";
  const page = oneLine(payload.page, 240) || "Không xác định";

  if (
    partner.length < 2 ||
    contact.length < 3 ||
    !/^[A-Za-z0-9._:@-]{3,80}$/.test(uid)
  ) {
    return reply(request, { ok: false }, 422);
  }

  const requestId = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  const sentAt = new Date().toISOString();
  const submittedAt = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date());
  const baseText = [
    "🔔 YÊU CẦU KIỂM TRA UID",
    `Mã yêu cầu: #${requestId}`,
    "",
    `Nhóm: ${category}`,
    `Đối tác: ${partner}`,
    `UID: ${uid}`,
    `Tài khoản: ${accountType}`,
    `Liên hệ: ${contactChannel} · ${contact}`,
    `Ghi chú: ${note}`,
    "",
    `Thời gian: ${submittedAt}`,
    `Nguồn: ${page}`,
  ].join("\n");

  const record = {
    requestId,
    partner,
    category,
    uid,
    accountType: payload.accountType === "existing" ? "existing" : "new",
    contactChannel,
    contact,
    note,
    page,
    status: "received",
    sentAt,
    updatedAt: sentAt,
    baseText,
  };

  try {
    await saveRequest(record);
  } catch (error) {
    console.error("UID request storage failed", error instanceof Error ? error.message : "unknown");
    return reply(request, { ok: false, code: "storage_failed" }, 503);
  }

  const secret = process.env.TELEGRAM_CALLBACK_SECRET || botToken;
  const keyboard = await statusKeyboard(requestId, secret);

  // Makes the inline buttons work without a separate manual webhook setup step.
  await ensureTelegramWebhook(request, botToken);

  try {
    const telegramResponse = await telegramCall(botToken, "sendMessage", {
      chat_id: chatId,
      text: `${baseText}\n\nTrạng thái: ${STATUS_LABEL.received}`,
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });

    const messageId = telegramResponse?.result?.message_id;
    if (messageId) {
      await saveRequest({ ...record, telegramMessageId: messageId });
    }

    return reply(request, { ok: true, requestId });
  } catch (error) {
    console.error("UID notification failed", error instanceof Error ? error.message : "unknown");
    return reply(request, { ok: false }, 502);
  }
};

export const config = {
  path: "/api/uid-check",
};
