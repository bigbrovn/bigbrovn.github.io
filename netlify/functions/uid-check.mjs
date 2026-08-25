const MAX_BODY_BYTES = 10_000;

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

export default async (request) => {
  const origin = request.headers.get("origin") || "";
  const allowedOrigin = corsOrigin(request);

  if (request.method === "OPTIONS") {
    if (origin && !allowedOrigin) return reply(request, { ok: false }, 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        "vary": "Origin",
      },
    });
  }

  if (request.method === "GET") {
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

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    return reply(request, { ok: false, code: "telegram_not_configured" }, 503);
  }

  const requestId = crypto.randomUUID().slice(0, 8).toUpperCase();
  const submittedAt = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date());
  const text = [
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

  try {
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!telegramResponse.ok) {
      console.error("Telegram sendMessage failed", telegramResponse.status);
      return reply(request, { ok: false }, 502);
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
