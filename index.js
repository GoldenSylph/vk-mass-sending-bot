import dotenv from 'dotenv';
import express from 'express';
import bodyParser from 'body-parser';
dotenv.config();
import { statSync, readFileSync, writeFileSync, promises } from 'fs';
import VkBot from 'node-vk-bot-api';
import PQueue from 'p-queue';
import Handlebars from 'handlebars';

const SECRET = process.env.SECRET;
const CONFIRMATION = process.env.CONFIRMATION;
const PORT = process.env.PORT || 8080;
const TOKEN = process.env.VK_TOKEN;
const GROUP_ID = process.env.VK_GROUP_ID;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number);

// Validate required environment variables
if (!TOKEN) {
  console.error('❌ Переменная окружения VK_TOKEN обязательна');
  process.exit(1);
}

if (!GROUP_ID) {
  console.error('❌ Переменная окружения VK_GROUP_ID обязательна');
  process.exit(1);
}

if (ADMIN_IDS.length === 0 || ADMIN_IDS.every(id => isNaN(id))) {
  console.error('❌ Переменная окружения ADMIN_IDS должна содержать корректные ID пользователей');
  process.exit(1);
}

const bot = new VkBot({
  token: TOKEN,
  group_id: Number(GROUP_ID),
  api: { v: '5.199' },
  confirmation: CONFIRMATION,
  secret: SECRET, 
});

// Add global error handling middleware
bot.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error('Bot middleware error:', err);
  }
});

const queue = new PQueue({ intervalCap: 30, interval: 1000 });

// Cache for blocklist and allowlist to reduce file I/O
let blocklistCache = null;
let allowlistCache = null;
let blocklistLastModified = 0;
let allowlistLastModified = 0;

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function isValidUserId(userId) {
  const numericId = Number(userId);
  return !isNaN(numericId) && numericId > 0 && Number.isInteger(numericId);
}

function loadBlocklist() {
  try {
    const stats = statSync('./blocklist.json');
    const lastModified = stats.mtime.getTime();
    
    if (blocklistCache && blocklistLastModified >= lastModified) {
      return blocklistCache;
    }
    
    const data = readFileSync('./blocklist.json', 'utf-8');
    const parsed = JSON.parse(data);
    blocklistCache = Array.isArray(parsed) ? parsed : [];
    blocklistLastModified = lastModified;
    return blocklistCache;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error loading blocklist:', err.message);
    }
    blocklistCache = [];
    blocklistLastModified = 0;
    return blocklistCache;
  }
}

function saveBlocklist(blocklist) {
  try {
    writeFileSync('./blocklist.json', JSON.stringify(blocklist, null, 2));
    blocklistCache = blocklist;
    blocklistLastModified = Date.now();
  } catch (err) {
    console.error('Error saving blocklist:', err.message);
    throw new Error('Failed to save blocklist');
  }
}

function addToBlocklist(userId) {
  if (!isValidUserId(userId)) {
    throw new Error('Неверный формат ID пользователя');
  }
  
  const blocklist = loadBlocklist();
  const userIdStr = String(userId);
  
  if (!blocklist.includes(userIdStr)) {
    blocklist.push(userIdStr);
    saveBlocklist(blocklist);
    return true;
  }
  return false;
}

function removeFromBlocklist(userId) {
  const blocklist = loadBlocklist();
  const userIdStr = String(userId);
  const initialLength = blocklist.length;
  
  const filteredBlocklist = blocklist.filter(id => id !== userIdStr);
  
  if (filteredBlocklist.length < initialLength) {
    saveBlocklist(filteredBlocklist);
    return true;
  }
  return false;
}

function loadAllowlist() {
  try {
    const stats = statSync('./allowlist.json');
    const lastModified = stats.mtime.getTime();
    
    if (allowlistCache && allowlistLastModified >= lastModified) {
      return allowlistCache;
    }
    
    const data = readFileSync('./allowlist.json', 'utf-8');
    const parsed = JSON.parse(data);
    allowlistCache = Array.isArray(parsed) ? parsed : [];
    allowlistLastModified = lastModified;
    return allowlistCache;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error loading allowlist:', err.message);
    }
    allowlistCache = [];
    allowlistLastModified = 0;
    return allowlistCache;
  }
}

function saveAllowlist(allowlist) {
  try {
    writeFileSync('./allowlist.json', JSON.stringify(allowlist, null, 2));
    allowlistCache = allowlist;
    allowlistLastModified = Date.now();
  } catch (err) {
    console.error('Error saving allowlist:', err.message);
    throw new Error('Failed to save allowlist');
  }
}

function addToAllowlist(userId) {
  if (!isValidUserId(userId)) {
    throw new Error('Неверный формат ID пользователя');
  }
  
  const allowlist = loadAllowlist();
  const userIdStr = String(userId);
  
  if (!allowlist.includes(userIdStr)) {
    allowlist.push(userIdStr);
    saveAllowlist(allowlist);
    return true;
  }
  return false;
}

function removeFromAllowlist(userId) {
  const allowlist = loadAllowlist();
  const userIdStr = String(userId);
  const initialLength = allowlist.length;
  
  const filteredAllowlist = allowlist.filter(id => id !== userIdStr);
  
  if (filteredAllowlist.length < initialLength) {
    saveAllowlist(filteredAllowlist);
    return true;
  }
  return false;
}

function filterUsers(users) {
  const allowlist = loadAllowlist();
  const blocklist = loadBlocklist();
  const allowlistSet = new Set(allowlist);
  const blocklistSet = new Set(blocklist);
  
  return users.filter(user => {
    const userIdStr = String(user.id);
    
    // If allowlist has entries, only include users in allowlist
    if (allowlist.length > 0 && !allowlistSet.has(userIdStr)) {
      return false;
    }
    
    // Filter out blocked users
    return !blocklistSet.has(userIdStr);
  });
}

function generateRandomId(peer_id) {
  return peer_id * 100000 + (Date.now() % 100000);
}

async function sendMessage(peer_id, text, keyboard = null) {
  const attachmentIds = (process.env.ATTACHMENTS || '').trim();
  const params = {
    peer_id,
    message: text,
    attachment: attachmentIds || undefined,
    random_id: generateRandomId(peer_id),
  };
  
  if (keyboard) {
    params.keyboard = JSON.stringify(keyboard);
  }
  
  return bot.api('messages.send', params);
}

async function gatherUserIds(group_id) {
  const members = [];
  let offset = 0;
  const count = 1000;
  let total = null;

  try {
    while (true) {
      const data = await queue.add(() => bot.api('groups.getMembers', {
        group_id,
        offset,
        count,
        fields: 'first_name,last_name',
      }));

      if (total === null) total = data.count;

      members.push(...data.items);
      offset += count;

      console.log(`📊 Собрано ${members.length}/${total} участников...`);

      if (offset >= total) break;
    }

    await promises.writeFile('./peer_list.json', JSON.stringify(members, null, 4));
    return members;
  } catch (err) {
    console.error('Error gathering user IDs:', err);
    throw new Error(`Не удалось собрать ID пользователей: ${err.message}`);
  }
}

async function broadcast(messageTemplate, userObjects, dryRun = false) {
  try {
    const template = Handlebars.compile(messageTemplate);
    
    // Filter users based on allowlist and blocklist
    const originalCount = userObjects.length;
    const filteredUsers = filterUsers(userObjects);
    const filteredCount = originalCount - filteredUsers.length;
    
    if (filteredCount > 0) {
      const allowlist = loadAllowlist();
      const allowlistActive = allowlist.length > 0;
      
      if (allowlistActive) {
        const allowedUsers = userObjects.filter(user => {
          const allowlist = loadAllowlist();
          return allowlist.includes(String(user.id));
        });
        const notAllowedCount = originalCount - allowedUsers.length;
        const blockedFromAllowedCount = allowedUsers.length - filteredUsers.length;
        
        console.log(`🎯 Белый список активен: ${allowedUsers.length} пользователей разрешено (${notAllowedCount} не в белом списке)`);
        if (blockedFromAllowedCount > 0) {
          console.log(`🚫 Исключено ${blockedFromAllowedCount} заблокированных пользователей из разрешённых`);
        }
      } else {
        console.log(`🚫 Исключено ${filteredCount} заблокированных пользователей`);
      }
    }

    let processed = 0;
    const total = filteredUsers.length;

    for (const user of filteredUsers) {
      const personalizedMessage = template({
        first_name: user.first_name || '',
        last_name: user.last_name || '',
        id: user.id,
      });

      queue.add(async () => {
        try {
          if (dryRun) {
            console.log(`[DRY RUN] Отправка ${user.id}: "${personalizedMessage}"`);
          } else {
            await sendMessage(user.id, personalizedMessage);
          }
          processed++;
          if (processed % 10 === 0 || processed === total) {
            console.log(`📤 Прогресс: ${processed}/${total} сообщений ${dryRun ? 'симулируется' : 'отправлено'}`);
          }
        } catch (err) {
          console.error(`Ошибка при отправке ${user.id}:`, err);
          if (err.code === 429 && err.data?.parameters?.retry_after) {
            await new Promise(r => setTimeout(r, err.data.parameters.retry_after * 1000));
            if (!dryRun) {
              return sendMessage(user.id, personalizedMessage);
            }
          }
        }
      });
    }
    await queue.onIdle();
  } catch (err) {
    console.error('Error in broadcast:', err);
    throw err;
  }
}

function createAdminKeyboard() {
  return {
    one_time: false,
    buttons: [
      [
        {
          action: {
            type: "text",
            label: "📊 Собрать ID",
            payload: JSON.stringify({ command: "собрать_айди" })
          },
          color: "primary"
        },
        {
          action: {
            type: "text",
            label: "🔍 Тест рассылки",
            payload: JSON.stringify({ command: "тест_рассылки" })
          },
          color: "secondary"
        }
      ],
      [
        {
          action: {
            type: "text",
            label: "📡 Рассылка",
            payload: JSON.stringify({ command: "рассылка" })
          },
          color: "positive"
        },
        {
          action: {
            type: "text",
            label: "📋 Чёрный список",
            payload: JSON.stringify({ command: "показать_чёрный_список" })
          },
          color: "secondary"
        }
      ],
      [
        {
          action: {
            type: "text",
            label: "📋 Белый список",
            payload: JSON.stringify({ command: "показать_белый_список" })
          },
          color: "secondary"
        },
        {
          action: {
            type: "text",
            label: "❓ Помощь",
            payload: JSON.stringify({ command: "помощь" })
          },
          color: "secondary"
        }
      ]
    ]
  };
}

bot.command('/начать', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    const adminLinks = ADMIN_IDS.map(id => `[id${id}|Админ]`).join(', ');
    return ctx.reply(`⚠️ Этот бот только для администраторов.\n\nОбратитесь к админам: ${adminLinks}`);
  }
  
  const keyboard = createAdminKeyboard();
  await sendMessage(ctx.message.peer_id, '🤖 VK Бот массовой рассылки\n\nИспользуйте кнопки ниже для выполнения команд:', keyboard);
});

bot.command('/помощь', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    const adminLinks = ADMIN_IDS.map(id => `[id${id}|Админ]`).join(', ');
    return ctx.reply(`⚠️ Этот бот только для администраторов.\n\nОбратитесь к админам: ${adminLinks}`);
  }
  
  const helpText = `🤖 Команды VK бота массовой рассылки:

📊 /собрать_айди - Собрать ID участников сообщества
🔍 /тест_рассылки - Запустить тестовую рассылку (без отправки)
📡 /рассылка - Отправить рассылку всем пользователям
📋 /показать_чёрный_список - Показать заблокированных пользователей
📋 /показать_белый_список - Показать разрешённых пользователей
🗑️ /очистить_чёрный_список - Очистить чёрный список
🗑️ /очистить_белый_список - Очистить белый список (разрешить всех)
🚫 /заблокировать <id> - Заблокировать пользователя
✅ /разблокировать <id> - Разблокировать пользователя
✅ /разрешить <id> - Добавить пользователя в белый список
❌ /запретить <id> - Убрать пользователя из белого списка

Переменные шаблона: {{first_name}}, {{last_name}}, {{id}}`;

  const keyboard = createAdminKeyboard();
  await sendMessage(ctx.message.peer_id, helpText, keyboard);
});

// Handle button presses
bot.on('message', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    // Forward non-admin messages to all admins
    if (ctx.message.text && !ctx.message.text.startsWith('/')) {
      const senderInfo = `[id${ctx.message.from_id}|Пользователь ${ctx.message.from_id}]`;
      const forwardMessage = `📨 Сообщение от ${senderInfo}:\n\n"${ctx.message.text}"`;
      
      // Send to all admins
      for (const adminId of ADMIN_IDS) {
        try {
          await sendMessage(adminId, forwardMessage);
        } catch (err) {
          console.error(`Не удалось переслать сообщение админу ${adminId}:`, err);
        }
      }
      
      // Confirm to sender
      const adminLinks = ADMIN_IDS.map(id => `[id${id}|Админ]`).join(', ');
      return ctx.reply(`✅ Ваше сообщение переслано администраторам: ${adminLinks}\n\nОни ответят вам напрямую при первой возможности!`);
    }
    return;
  }
  
  // Check if message contains payload (button press)
  if (ctx.message.payload) {
    try {
      const payload = JSON.parse(ctx.message.payload);
      const command = payload.command;
      
      // Execute the corresponding command
      switch (command) {
        case 'собрать_айди':
          ctx.message.text = '/собрать_айди';
          break;
        case 'тест_рассылки':
          ctx.message.text = '/тест_рассылки';
          break;
        case 'рассылка':
          ctx.message.text = '/рассылка';
          break;
        case 'показать_чёрный_список':
          ctx.message.text = '/показать_чёрный_список';
          break;
        case 'показать_белый_список':
          ctx.message.text = '/показать_белый_список';
          break;
        case 'помощь':
          ctx.message.text = '/помощь';
          break;
        default:
          return;
      }
      
      // Re-trigger command processing
      return;
    } catch (err) {
      console.error('Error parsing button payload:', err);
    }
  }
  
  // Handle text button labels as commands
  const text = ctx.message.text?.trim();
  if (text) {
    switch (text) {
      case '📊 Собрать ID':
        ctx.message.text = '/собрать_айди';
        break;
      case '🔍 Тест рассылки':
        ctx.message.text = '/тест_рассылки';
        break;
      case '📡 Рассылка':
        ctx.message.text = '/рассылка';
        break;
      case '📋 Чёрный список':
        ctx.message.text = '/показать_чёрный_список';
        break;
      case '📋 Белый список':
        ctx.message.text = '/показать_белый_список';
        break;
      case '❓ Помощь':
        ctx.message.text = '/помощь';
        break;
    }
  }
});

bot.command('/собрать_айди', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  await sendMessage(ctx.message.peer_id, '⏳ Собираем ID участников сообщества…', keyboard);
  try {
    const members = await gatherUserIds(GROUP_ID);
    await sendMessage(ctx.message.peer_id, `✅ Собрано ${members.length} ID пользователей.`, keyboard);
  } catch (err) {
    console.error(err);
    await sendMessage(ctx.message.peer_id, '❌ Не удалось собрать ID участников.', keyboard);
  }
});

bot.command('/рассылка', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  await sendMessage(ctx.message.peer_id, '📡 Обновляем список получателей…', keyboard);

  try {
    const users = await gatherUserIds(GROUP_ID);
    const filteredUsers = filterUsers(users);
    const allowlist = loadAllowlist();
    const allowlistActive = allowlist.length > 0;
    
    let templateContent;
    try {
      templateContent = readFileSync('./broadcast_template.txt', 'utf-8').trim();
    } catch (err) {
      return sendMessage(ctx.message.peer_id, '❗ Не удалось прочитать файл broadcast_template.txt.', keyboard);
    }
    
    if (!templateContent) return sendMessage(ctx.message.peer_id, '❗ Файл шаблона пуст.', keyboard);

    let statusMessage = '';
    if (allowlistActive) {
      const allowedUsers = users.filter(user => {
        const allowlist = loadAllowlist();
        return allowlist.includes(String(user.id));
      });
      const notAllowedCount = users.length - allowedUsers.length;
      const blockedFromAllowedCount = allowedUsers.length - filteredUsers.length;
      
      statusMessage = `📬 Отправляем ${filteredUsers.length} пользователям (белый список: ${allowedUsers.length}, заблокировано: ${blockedFromAllowedCount})`;
    } else {
      const blockedCount = users.length - filteredUsers.length;
      if (blockedCount > 0) {
        statusMessage = `📬 Отправляем ${filteredUsers.length} пользователям (${blockedCount} заблокированных пользователей исключено)`;
      } else {
        statusMessage = `📬 Отправляем ${filteredUsers.length} пользователям`;
      }
    }
    
    await sendMessage(ctx.message.peer_id, statusMessage, keyboard);
    await broadcast(templateContent, users);
    await sendMessage(ctx.message.peer_id, '✅ Рассылка завершена.', keyboard);
  } catch (err) {
    console.error(err);
    await sendMessage(ctx.message.peer_id, '❌ Рассылка не удалась: ' + err.message, keyboard);
  }
});

bot.command('/тест_рассылки', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  await sendMessage(ctx.message.peer_id, '🔍 Запускаем тестовую рассылку (без отправки)…', keyboard);

  try {
    const users = await gatherUserIds(GROUP_ID);
    const filteredUsers = filterUsers(users);
    const allowlist = loadAllowlist();
    const allowlistActive = allowlist.length > 0;
    
    let templateContent;
    try {
      templateContent = readFileSync('./broadcast_template.txt', 'utf-8').trim();
    } catch (err) {
      return sendMessage(ctx.message.peer_id, '❗ Не удалось прочитать файл broadcast_template.txt.', keyboard);
    }
    
    if (!templateContent) return sendMessage(ctx.message.peer_id, '❗ Файл шаблона пуст.', keyboard);

    if (allowlistActive) {
      const allowedUsers = users.filter(user => {
        const allowlist = loadAllowlist();
        return allowlist.includes(String(user.id));
      });
      const blockedFromAllowedCount = allowedUsers.length - filteredUsers.length;
      await sendMessage(ctx.message.peer_id, `🔍 Тестируем с ${filteredUsers.length} пользователями (белый список: ${allowedUsers.length}, заблокировано: ${blockedFromAllowedCount})`, keyboard);
    } else {
      const blockedCount = users.length - filteredUsers.length;
      if (blockedCount > 0) {
        await sendMessage(ctx.message.peer_id, `🔍 Тестируем с ${filteredUsers.length} пользователями (${blockedCount} заблокированных пользователей исключено)`, keyboard);
      }
    }

    await broadcast(templateContent, users, true);
    await sendMessage(ctx.message.peer_id, '✅ Тестовая рассылка завершена (реальные сообщения не отправлялись).', keyboard);
  } catch (err) {
    console.error(err);
    await sendMessage(ctx.message.peer_id, '❌ Тестовая рассылка не удалась: ' + err.message, keyboard);
  }
});

bot.command('/заблокировать', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return sendMessage(ctx.message.peer_id, '❗ Использование: /заблокировать <id_пользователя>', keyboard);
  }

  const userId = args[0];

  try {
    if (addToBlocklist(userId)) {
      await sendMessage(ctx.message.peer_id, `🚫 Добавлен ID пользователя "${userId}" в чёрный список.`, keyboard);
    } else {
      await sendMessage(ctx.message.peer_id, `⚠️ ID пользователя "${userId}" уже в чёрном списке.`, keyboard);
    }
  } catch (err) {
    await sendMessage(ctx.message.peer_id, `❌ Ошибка: ${err.message}`, keyboard);
  }
});

bot.command('/разблокировать', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return sendMessage(ctx.message.peer_id, '❗ Использование: /разблокировать <id_пользователя>', keyboard);
  }

  const userId = args[0];

  try {
    if (removeFromBlocklist(userId)) {
      await sendMessage(ctx.message.peer_id, `✅ Убран ID пользователя "${userId}" из чёрного списка.`, keyboard);
    } else {
      await sendMessage(ctx.message.peer_id, `⚠️ ID пользователя "${userId}" не найден в чёрном списке.`, keyboard);
    }
  } catch (err) {
    await sendMessage(ctx.message.peer_id, `❌ Ошибка: ${err.message}`, keyboard);
  }
});

bot.command('/показать_чёрный_список', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  const blocklist = loadBlocklist();
  
  if (blocklist.length === 0) {
    return sendMessage(ctx.message.peer_id, '📋 Чёрный список пуст.', keyboard);
  }

  const blocklistText = blocklist
    .map((userId, index) => `${index + 1}. ${userId}`)
    .join('\n');

  await sendMessage(ctx.message.peer_id, `📋 Заблокированные пользователи (${blocklist.length}):\n${blocklistText}`, keyboard);
});

bot.command('/очистить_чёрный_список', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  saveBlocklist([]);
  await sendMessage(ctx.message.peer_id, '🗑️ Чёрный список очищен.', keyboard);
});

bot.command('/разрешить', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return sendMessage(ctx.message.peer_id, '❗ Использование: /разрешить <id_пользователя>', keyboard);
  }

  const userId = args[0];

  try {
    if (addToAllowlist(userId)) {
      await sendMessage(ctx.message.peer_id, `✅ Добавлен ID пользователя "${userId}" в белый список.`, keyboard);
    } else {
      await sendMessage(ctx.message.peer_id, `⚠️ ID пользователя "${userId}" уже в белом списке.`, keyboard);
    }
  } catch (err) {
    await sendMessage(ctx.message.peer_id, `❌ Ошибка: ${err.message}`, keyboard);
  }
});

bot.command('/запретить', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return sendMessage(ctx.message.peer_id, '❗ Использование: /запретить <id_пользователя>', keyboard);
  }

  const userId = args[0];

  try {
    if (removeFromAllowlist(userId)) {
      await sendMessage(ctx.message.peer_id, `✅ Убран ID пользователя "${userId}" из белого списка.`, keyboard);
    } else {
      await sendMessage(ctx.message.peer_id, `⚠️ ID пользователя "${userId}" не найден в белом списке.`, keyboard);
    }
  } catch (err) {
    await sendMessage(ctx.message.peer_id, `❌ Ошибка: ${err.message}`, keyboard);
  }
});

bot.command('/показать_белый_список', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  const allowlist = loadAllowlist();
  
  if (allowlist.length === 0) {
    return sendMessage(ctx.message.peer_id, '📋 Белый список пуст (все пользователи разрешены кроме заблокированных).', keyboard);
  }

  const allowlistText = allowlist
    .map((userId, index) => `${index + 1}. ${userId}`)
    .join('\n');

  await sendMessage(ctx.message.peer_id, `📋 Разрешённые пользователи (${allowlist.length}):\n${allowlistText}`, keyboard);
});

bot.command('/очистить_белый_список', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Доступ запрещён.');
  }

  const keyboard = createAdminKeyboard();
  saveAllowlist([]);
  await sendMessage(ctx.message.peer_id, '🗑️ Белый список очищен (теперь все пользователи разрешены кроме заблокированных).', keyboard);
});

// Keep English commands for backward compatibility
bot.command('/start', async ctx => {
  ctx.message.text = '/начать';
});

bot.command('/help', async ctx => {
  ctx.message.text = '/помощь';
});

bot.command('/gather_ids', async ctx => {
  ctx.message.text = '/собрать_айди';
});

bot.command('/broadcast', async ctx => {
  ctx.message.text = '/рассылка';
});

bot.command('/test_broadcast', async ctx => {
  ctx.message.text = '/тест_рассылки';
});

bot.command('/block_user', async ctx => {
  ctx.message.text = ctx.message.text.replace('/block_user', '/заблокировать');
});

bot.command('/unblock_user', async ctx => {
  ctx.message.text = ctx.message.text.replace('/unblock_user', '/разблокировать');
});

bot.command('/show_blocklist', async ctx => {
  ctx.message.text = '/показать_чёрный_список';
});

bot.command('/clear_blocklist', async ctx => {
  ctx.message.text = '/очистить_чёрный_список';
});

bot.command('/allow_user', async ctx => {
  ctx.message.text = ctx.message.text.replace('/allow_user', '/разрешить');
});

bot.command('/unallow_user', async ctx => {
  ctx.message.text = ctx.message.text.replace('/unallow_user', '/запретить');
});

bot.command('/show_allowlist', async ctx => {
  ctx.message.text = '/показать_белый_список';
});

bot.command('/clear_allowlist', async ctx => {
  ctx.message.text = '/очистить_белый_список';
});

console.log('🔗 Бот запущен...');
const app = express();
app.use(bodyParser.json());
app.post('/', bot.webhookCallback);
app.listen(PORT);