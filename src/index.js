import { Hono } from 'hono';

const app = new Hono();

// --- Configuration & Constants ---
const DEFAULT_LANG = 'en';
const SUPPORTED_LANGS = {
  'zh': 'Chinese',
  'en': 'English',
  'ja': 'Japanese',
  'ru': 'Russian'
};

// --- Helper Functions ---

async function callTelegram(method, payload, env) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return await response.json();
}

async function translateText(text, targetLang, env) {
  if (!env.SILICONFLOW_API_KEY) return text;
  
  try {
    const response = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SILICONFLOW_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-ai/DeepSeek-V3", // Or any other available model
        messages: [
          { role: "system", content: `Translate the following text to ${targetLang}. Only return the translated text.` },
          { role: "user", content: text }
        ]
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || text;
  } catch (e) {
    console.error("Translation failed:", e);
    return text;
  }
}

// --- Database Helpers ---

async function getUser(db, userId) {
  return await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(userId).first();
}

async function upsertUser(db, user) {
  const existing = await getUser(db, user.id);
  if (!existing) {
    await db.prepare('INSERT INTO users (user_id, username, first_name, created_at) VALUES (?, ?, ?, ?)')
      .bind(user.id, user.username, user.first_name, Date.now()).run();
    return { is_new: true };
  } else {
    // Update info if changed
    if (existing.username !== user.username || existing.first_name !== user.first_name) {
      await db.prepare('UPDATE users SET username = ?, first_name = ? WHERE user_id = ?')
        .bind(user.username, user.first_name, user.id).run();
    }
    return existing;
  }
}

async function saveMessageMapping(db, adminMsgId, userId, guestMsgId) {
  await db.prepare('INSERT INTO messages (admin_message_id, user_id, guest_message_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(adminMsgId, userId, guestMsgId, Date.now()).run();
}

async function getOriginalSender(db, adminMsgId) {
  return await db.prepare('SELECT user_id, guest_message_id FROM messages WHERE admin_message_id = ?').bind(adminMsgId).first();
}

// --- Business Logic ---

async function handleStart(ctx, message, env) {
  const user = message.from;
  const dbUser = await upsertUser(env.DB, user);
  
  // If not verified, send captcha
  const userData = await getUser(env.DB, user.id);
  if (!userData.is_verified) {
    await callTelegram('sendMessage', {
      chat_id: user.id,
      text: "Please verify you are human by clicking the button below.",
      reply_markup: {
        inline_keyboard: [[{ text: "✅ I am Human", callback_data: "verify_human" }]]
      }
    }, env);
    return;
  }
  
  // If verified but no language
  if (!userData.language) {
    await sendLanguageSelection(user.id, env);
    return;
  }
  
  await callTelegram('sendMessage', {
    chat_id: user.id,
    text: "Welcome! You can send me messages and I will forward them to the admin."
  }, env);
}

async function sendLanguageSelection(chatId, env) {
  const buttons = [];
  for (const [code, name] of Object.entries(SUPPORTED_LANGS)) {
    buttons.push({ text: name, callback_data: `lang_${code}` });
  }
  // Group buttons in rows of 2
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }
  
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text: "Please select your language / 请选择语言:",
    reply_markup: { inline_keyboard: keyboard }
  }, env);
}

async function handleCallback(ctx, callback, env) {
  const data = callback.data;
  const user = callback.from;
  const db = env.DB;
  
  if (data === 'verify_human') {
    await db.prepare('UPDATE users SET is_verified = 1 WHERE user_id = ?').bind(user.id).run();
    await callTelegram('answerCallbackQuery', { callback_query_id: callback.id, text: "Verified!" }, env);
    await callTelegram('editMessageText', {
      chat_id: user.id,
      message_id: callback.message.message_id,
      text: "✅ Verified successfully. Now please select your language."
    }, env);
    await sendLanguageSelection(user.id, env);
  } else if (data.startsWith('lang_')) {
    const langCode = data.split('_')[1];
    await db.prepare('UPDATE users SET language = ? WHERE user_id = ?').bind(langCode, user.id).run();
    await callTelegram('answerCallbackQuery', { callback_query_id: callback.id, text: `Language set to ${langCode}` }, env);
    await callTelegram('editMessageText', {
      chat_id: user.id,
      message_id: callback.message.message_id,
      text: `✅ Language set to ${SUPPORTED_LANGS[langCode] || langCode}. You can now send messages.`
    }, env);
  }
}

async function handlePrivateMessage(ctx, message, env) {
  const user = message.from;
  const db = env.DB;
  const adminId = parseInt(env.ADMIN_USER_ID);
  
  // 1. If Admin sent a message
  if (user.id === adminId) {
    // Check if it's a reply
    if (message.reply_to_message) {
      const original = await getOriginalSender(db, message.reply_to_message.message_id);
      if (original) {
        // Forward back to user using copyMessage (Zero Bandwidth)
        try {
            await callTelegram('copyMessage', {
                chat_id: original.user_id,
                from_chat_id: message.chat.id,
                message_id: message.message_id
            }, env);
            await callTelegram('sendMessage', {
                chat_id: adminId,
                text: "✅ Reply sent.",
                reply_to_message_id: message.message_id
            }, env);
        } catch (e) {
            await callTelegram('sendMessage', {
                chat_id: adminId,
                text: `❌ Failed to send: ${e.message}`,
                reply_to_message_id: message.message_id
            }, env);
        }
      } else {
        await callTelegram('sendMessage', {
            chat_id: adminId,
            text: "⚠️ Could not find original sender for this message (maybe too old).",
            reply_to_message_id: message.message_id
        }, env);
      }
    }
    return;
  }
  
  // 2. If Guest sent a message
  const dbUser = await upsertUser(db, user);
  
  if (dbUser.is_blocked) return;
  
  if (!dbUser.is_verified) {
    await callTelegram('sendMessage', {
      chat_id: user.id,
      text: "Please verify you are human first.",
      reply_markup: { inline_keyboard: [[{ text: "✅ Verify", callback_data: "verify_human" }]] }
    }, env);
    return;
  }
  
  if (!dbUser.language) {
    await sendLanguageSelection(user.id, env);
    return;
  }
  
  // Forward to Admin
  // Logic: Send Header -> Send Media/Text -> Translate if Text
  const header = `📩 <b>New Message</b>\nFrom: <a href="tg://user?id=${user.id}">${user.first_name}</a> (${user.id})\nLang: ${dbUser.language}`;
  
  // Use copyMessage for everything to save bandwidth, but we need to attach header.
  // copyMessage supports caption for media.
  
  let sentMsg;
  
  // Check media type
  const isMedia = message.photo || message.video || message.document || message.voice || message.audio || message.animation;
  const hasCaption = message.caption !== undefined;
  
  if (message.text) {
    // Text message
    const originalText = message.text;
    let finalText = `${header}\n\n${originalText}`;
    
    // Translate?
    // Assume Admin is 'zh' or 'en', simple logic: if user lang != 'zh', translate to 'zh' (example)
    // Or translate to Admin's preferred language. For now, let's just translate to Chinese if not Chinese.
    // Or better: Translate to English if not English.
    // Let's assume Admin wants Chinese.
    
    if (dbUser.language !== 'zh') {
        const translated = await translateText(originalText, 'Chinese', env);
        finalText += `\n\n<b>Translation:</b>\n${translated}`;
    }

    const res = await callTelegram('sendMessage', {
        chat_id: adminId,
        text: finalText,
        parse_mode: 'HTML'
    }, env);
    sentMsg = res.result;
    
  } else if (isMedia) {
    // Media message
    // If it supports caption, prepend header
    // Telegram caption limit 1024
    let newCaption = `${header}\n\n${message.caption || ''}`;
    if (newCaption.length > 1024) newCaption = newCaption.substring(0, 1021) + '...';
    
    const res = await callTelegram('copyMessage', {
        chat_id: adminId,
        from_chat_id: user.id,
        message_id: message.message_id,
        caption: newCaption,
        parse_mode: 'HTML'
    }, env);
    sentMsg = res.result;
    
  } else {
    // Sticker, Dice, etc. (No caption support)
    // Send header first
    await callTelegram('sendMessage', {
        chat_id: adminId,
        text: header,
        parse_mode: 'HTML'
    }, env);
    
    // Then copy message
    const res = await callTelegram('copyMessage', {
        chat_id: adminId,
        from_chat_id: user.id,
        message_id: message.message_id
    }, env);
    sentMsg = res.result;
  }
  
  if (sentMsg) {
    await saveMessageMapping(db, sentMsg.message_id, user.id, message.message_id);
  }
}

// --- Routes ---

app.post('/webhook', async (c) => {
  const env = c.env;
  
  // Security check
  const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
  if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text('Unauthorized', 403);
  }
  
  const update = await c.req.json();
  
  // Async processing (using ctx.executionCtx.waitUntil if needed, but here we just await)
  // Cloudflare Workers has CPU time limits, but awaiting fetch is IO.
  
  try {
      if (update.message) {
        if (update.message.text && update.message.text.startsWith('/start')) {
            await handleStart(c, update.message, env);
        } else {
            await handlePrivateMessage(c, update.message, env);
        }
      } else if (update.callback_query) {
        await handleCallback(c, update.callback_query, env);
      }
  } catch (e) {
      console.error("Error processing update:", e);
  }
  
  return c.text('OK');
});

app.get('/', (c) => c.text('Telegram Bot Worker is Running!'));

export default app;
