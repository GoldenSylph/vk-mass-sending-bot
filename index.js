import dotenv from 'dotenv';
import express from 'express';
import bodyParser from 'body-parser';
import { statSync, readFileSync, writeFileSync, promises } from 'fs';
import axios from 'axios';
import PQueue from 'p-queue';
import Handlebars from 'handlebars';

dotenv.config();

const { SECRET, CONFIRMATION, PORT = 8080, VK_TOKEN: token, VK_GROUP_ID: groupId, ADMIN_IDS: adminIds } = process.env;
const adminList = (adminIds || '').split(',').map(Number).filter(id => !isNaN(id));

if (!token || !groupId || !adminList.length) process.exit(console.error('❌ Missing VK_TOKEN, VK_GROUP_ID, ADMIN_IDS'));

const VK_API_URL = 'https://api.vk.com/method';
const API_VERSION = '5.199';
const queue = new PQueue({ intervalCap: 30, interval: 1000 });
const cache = { blocklist: { data: null, lastModified: 0 }, allowlist: { data: null, lastModified: 0 } };

// VK API helper function
const vkApi = async (method, params = {}) => {
  try {
    // Use FormData for POST body instead of URL params to avoid 414 error
    const formData = new URLSearchParams();
    formData.append('access_token', token);
    formData.append('v', API_VERSION);
    
    // Add all other parameters to form data
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        formData.append(key, String(value));
      }
    }

    const response = await axios.post(`${VK_API_URL}/${method}`, formData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    if (response.data.error) {
      const error = new Error(response.data.error.error_msg);
      error.code = response.data.error.error_code;
      error.data = response.data.error;
      throw error;
    }
    
    return response.data.response;
  } catch (error) {
    if (error.response?.data?.error) {
      const vkError = new Error(error.response.data.error.error_msg);
      vkError.code = error.response.data.error.error_code;
      vkError.data = error.response.data.error;
      throw vkError;
    }
    throw error;
  }
};

const isAdmin = userId => adminList.includes(userId);

const loadList = (file, key) => {
  try {
    const stats = statSync(file);
    if (cache[key].data && cache[key].lastModified >= stats.mtime.getTime()) return cache[key].data;
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    cache[key].data = Array.isArray(data) ? data : [];
    cache[key].lastModified = stats.mtime.getTime();
    return cache[key].data;
  } catch (err) {
    cache[key].data = [];
    return cache[key].data;
  }
};

const saveList = (file, key, list) => {
  writeFileSync(file, JSON.stringify(list, null, 2));
  cache[key].data = list;
  cache[key].lastModified = Date.now();
};

const modifyList = (file, key, userId, action) => {
  const list = loadList(file, key);
  const id = String(userId);
  const idx = list.indexOf(id);
  if (action === 'add' && idx === -1) { list.push(id); saveList(file, key, list); return true; }
  if (action === 'remove' && idx > -1) { list.splice(idx, 1); saveList(file, key, list); return true; }
  return false;
};

const loadBlocklist = () => loadList('./blocklist.json', 'blocklist');
const loadAllowlist = () => loadList('./allowlist.json', 'allowlist');
const saveBlocklist = list => saveList('./blocklist.json', 'blocklist', list);
const saveAllowlist = list => saveList('./allowlist.json', 'allowlist', list);
const addToBlocklist = userId => modifyList('./blocklist.json', 'blocklist', userId, 'add');
const removeFromBlocklist = userId => modifyList('./blocklist.json', 'blocklist', userId, 'remove');
const addToAllowlist = userId => modifyList('./allowlist.json', 'allowlist', userId, 'add');
const removeFromAllowlist = userId => modifyList('./allowlist.json', 'allowlist', userId, 'remove');

const filterUsers = users => {
  const allowlist = loadAllowlist();
  const blocklist = new Set(loadBlocklist());
  const allowSet = new Set(allowlist);
  return users.filter(user => {
    const id = String(user.id);
    return (allowlist.length === 0 || allowSet.has(id)) && !blocklist.has(id);
  });
};

const sendMessage = async (peer_id, text, keyboard, includeAttachments = false) => vkApi('messages.send', {
  peer_id, 
  message: text, 
  attachment: (includeAttachments && (process.env.ATTACHMENTS || '').trim()) || undefined,
  random_id: peer_id * 100000 + (Date.now() % 100000),
  ...(keyboard && { keyboard: JSON.stringify(keyboard) })
});

// Check if user allows messages from community
const canSendMessage = async (userId) => {
  try {
    const response = await vkApi('messages.isMessagesFromGroupAllowed', {
      group_id: groupId,
      user_id: userId
    });
    return response.is_allowed === 1;
  } catch (error) {
    // If error occurs, assume we can't send (conservative approach)
    console.warn(`Can't check message permission for user ${userId}:`, error.message);
    return false;
  }
};

// Resolve user IDs to names
const resolveUserNames = async (userIds) => {
  if (userIds.length === 0) return {};
  
  try {
    // VK API allows up to 1000 IDs per request
    const chunks = [];
    for (let i = 0; i < userIds.length; i += 1000) {
      chunks.push(userIds.slice(i, i + 1000));
    }
    
    const resolved = {};
    for (const chunk of chunks) {
      const response = await vkApi('users.get', {
        user_ids: chunk.join(','),
        fields: 'first_name,last_name'
      });
      
      response.forEach(user => {
        resolved[user.id] = `${user.first_name} ${user.last_name}`;
      });
    }
    
    return resolved;
  } catch (error) {
    console.warn('Failed to resolve user names:', error.message);
    return {};
  }
};

async function getUserIds(groupId) {
  const members = [];
  let offset = 0;
  const count = 1000;
  let total = null;

  while (true) {
    const data = await queue.add(() => vkApi('groups.getMembers', {
      group_id: groupId, offset, count, fields: 'first_name,last_name'
    }));

    if (total === null) total = data.count;
    members.push(...data.items);
    offset += count;
    console.log(`📊 Собрано ${members.length}/${total} участников...`);
    if (offset >= total) break;
  }

  await promises.writeFile('./peer_list.json', JSON.stringify(members, null, 4));
  return members;
}

async function sendBroadcast(messageTemplate, userObjects, dryRun = false) {
  const template = Handlebars.compile(messageTemplate);
  const filteredUsers = filterUsers(userObjects);
  const filteredCount = userObjects.length - filteredUsers.length;
  
  if (filteredCount > 0) {
    const allowlist = loadAllowlist();
    if (allowlist.length > 0) {
      console.log(`🎯 Белый список активен: ${filteredUsers.length} пользователей (${filteredCount} исключено)`);
    } else {
      console.log(`🚫 Исключено ${filteredCount} заблокированных пользователей`);
    }
  }

  let processed = 0;
  let skipped = 0;
  const total = filteredUsers.length;

  for (const user of filteredUsers) {
    const personalizedMessage = template({
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      id: user.id,
    });

    queue.add(async () => {
      try {
        // Check if user allows messages from community (only for real sending)
        if (!dryRun) {
          const canSend = await canSendMessage(user.id);
          if (!canSend) {
            skipped++;
            console.log(`⚠️ Пропущен ${user.id}: пользователь не разрешил сообщения от сообщества`);
            processed++;
            if (processed % 10 === 0 || processed === total) {
              console.log(`📤 Прогресс: ${processed}/${total} обработано (${processed - skipped} отправлено, ${skipped} пропущено)`);
            }
            return;
          }
        }

        if (dryRun) {
          const attachments = (process.env.ATTACHMENTS || '').trim();
          const attachmentInfo = attachments ? `\nВложения: ${attachments}` : '\nВложения: нет';
          console.log(`[DRY RUN] Отправка ${user.id}: "${personalizedMessage.slice(0, 30)}..."${attachmentInfo}\n${JSON.stringify(user, null, 2)}\n[DRY RUN]`);
        } else {
          await sendMessage(user.id, personalizedMessage, null, dryRun);
        }
        processed++;
        if (processed % 10 === 0 || processed === total) {
          const statusText = dryRun 
            ? `📤 Прогресс: ${processed}/${total} сообщений симулируется`
            : `📤 Прогресс: ${processed}/${total} обработано (${processed - skipped} отправлено, ${skipped} пропущено)`;
          console.log(statusText);
        }
      } catch (err) {
        console.error(`Ошибка при отправке ${user.id}:`, err);
        processed++;
        if (err.code === 429 && err.data?.parameters?.retry_after && !dryRun) {
          await new Promise(r => setTimeout(r, err.data.parameters.retry_after * 1000));
          return sendMessage(user.id, personalizedMessage, null, dryRun);
        }
      }
    });
  }
  await queue.onIdle();
  
  if (!dryRun && skipped > 0) {
    console.log(`📊 Итого: ${processed - skipped} отправлено, ${skipped} пропущено (не разрешили сообщения)`);
  }
}

const createKeyboard = () => ({
  one_time: false,
  buttons: [
    [
      { action: { type: "text", label: "📊 Собрать ID" }, color: "primary" },
      { action: { type: "text", label: "🔍 Тест рассылки" }, color: "secondary" }
    ],
    [
      { action: { type: "text", label: "📡 Рассылка" }, color: "positive" },
      { action: { type: "text", label: "📋 Чёрный список" }, color: "secondary" }
    ],
    [
      { action: { type: "text", label: "📋 Белый список" }, color: "secondary" },
      { action: { type: "text", label: "❓ Помощь" }, color: "secondary" }
    ]
  ]
});

// Command handlers
const commands = {
  async collectIds(ctx) {
    const keyboard = createKeyboard();
    await sendMessage(ctx.message.peer_id, '⏳ Собираем ID участников сообщества…', keyboard);
    try {
      const members = await getUserIds(groupId);
      await sendMessage(ctx.message.peer_id, `✅ Собрано ${members.length} ID пользователей.`, keyboard);
    } catch (err) {
      console.error(err);
      await sendMessage(ctx.message.peer_id, '❌ Не удалось собрать ID участников.', keyboard);
    }
  },

  async testBroadcast(ctx) {
    const keyboard = createKeyboard();
    await sendMessage(ctx.message.peer_id, '🔍 Запускаем тестовую рассылку (без отправки)…', keyboard);

    try {
      const users = await getUserIds(groupId);
      
      let templateContent;
      try {
        templateContent = readFileSync('./broadcast_template.txt', 'utf-8').trim();
      } catch (err) {
        return sendMessage(ctx.message.peer_id, '❗ Не удалось прочитать файл broadcast_template.txt.', keyboard);
      }
      
      if (!templateContent) return sendMessage(ctx.message.peer_id, '❗ Файл шаблона пуст.', keyboard);

      const filteredUsers = filterUsers(users);
      const blockedCount = users.length - filteredUsers.length;
      if (blockedCount > 0) {
        await sendMessage(ctx.message.peer_id, `🧪 Тестируем с ${filteredUsers.length} пользователями (${blockedCount} исключено)`, keyboard);
      }

      await sendBroadcast(templateContent, users, true);
      await sendMessage(ctx.message.peer_id, '✅ Тестовая рассылка завершена (реальные сообщения не отправлялись).', keyboard);
    } catch (err) {
      console.error(err);
      await sendMessage(ctx.message.peer_id, '❌ Тестовая рассылка не удалась: ' + err.message, keyboard);
    }
  },

  async startBroadcast(ctx) {
    const keyboard = createKeyboard();
    await sendMessage(ctx.message.peer_id, '📡 Обновляем список получателей…', keyboard);

    try {
      const users = await getUserIds(groupId);
      
      let templateContent;
      try {
        templateContent = readFileSync('./broadcast_template.txt', 'utf-8').trim();
      } catch (err) {
        return sendMessage(ctx.message.peer_id, '❗ Не удалось прочитать файл broadcast_template.txt.', keyboard);
      }
      
      if (!templateContent) return sendMessage(ctx.message.peer_id, '❗ Файл шаблона пуст.', keyboard);

      const filteredUsers = filterUsers(users);
      const blockedCount = users.length - filteredUsers.length;
      
      const statusMessage = blockedCount > 0 
        ? `📬 Отправляем ${filteredUsers.length} пользователям (${blockedCount} исключено)`
        : `📬 Отправляем ${filteredUsers.length} пользователям`;
      
      await sendMessage(ctx.message.peer_id, statusMessage, keyboard);
      await sendBroadcast(templateContent, users);
      await sendMessage(ctx.message.peer_id, '✅ Рассылка завершена.', keyboard);
    } catch (err) {
      console.error(err);
      await sendMessage(ctx.message.peer_id, '❌ Рассылка не удалась: ' + err.message, keyboard);
    }
  },

  async showList(ctx, listType) {
    const keyboard = createKeyboard();
    const list = listType === 'blocklist' ? loadBlocklist() : loadAllowlist();
    const listName = listType === 'blocklist' ? 'Чёрный' : 'Белый';
    const emptyMessage = listType === 'blocklist' 
      ? '📋 Чёрный список пуст.' 
      : '📋 Белый список пуст (все пользователи разрешены кроме заблокированных).';
    
    if (list.length === 0) {
      return sendMessage(ctx.message.peer_id, emptyMessage, keyboard);
    }

    // Resolve user names for better readability
    const userNames = await resolveUserNames(list);
    const listText = list.map((userId, index) => {
      const userName = userNames[userId];
      return userName ? `${index + 1}. ${userName} (${userId})` : `${index + 1}. ${userId}`;
    }).join('\n');
    
    await sendMessage(ctx.message.peer_id, `📋 ${listName} список (${list.length}):\n${listText}`, keyboard);
  },

  async help(ctx) {
    const helpText = `🤖 Команды бота массовой рассылки для РО Челябинска партии "Рассвет":

📊 /collect_ids - Собрать ID участников сообщества
🔍 /test_broadcast - Запустить тестовую рассылку (без отправки)
📡 /start_broadcast - Отправить рассылку всем пользователям
📋 /show_blocklist - Показать заблокированных пользователей
📋 /show_allowlist - Показать разрешённых пользователей
🗑️ /clear_blocklist - Очистить чёрный список
🗑️ /clear_allowlist - Очистить белый список
🚫 /block <id> - Заблокировать пользователя
✅ /unblock <id> - Разблокировать пользователя
✅ /allow <id> - Добавить в белый список
❌ /disallow <id> - Убрать из белого списка

Переменные шаблона: {{first_name}}, {{last_name}}, {{id}}`;

    await sendMessage(ctx.message.peer_id, helpText, createKeyboard());
  }
};

// Webhook handler for VK callbacks
const handleWebhook = async (req, res) => {
  try {
    const { type, object, secret } = req.body;
    
    // Verify secret if provided
    if (SECRET && secret !== SECRET) {
      return res.status(401).send('Unauthorized');
    }
    
    switch (type) {
      case 'confirmation':
        return res.send(CONFIRMATION);
        
      case 'message_new':
        await handleMessage(object.message);
        break;
    }
    
    res.send('ok');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Internal Server Error');
  }
};

const handleMessage = async (message) => {
  try {
    const ctx = {
      message,
      reply: (text, keyboard) => sendMessage(message.peer_id, text, keyboard)
    };
    
    const text = message.text?.trim();
    const userId = message.from_id;
    
    // Handle start command
    if (text === '/начать' || text === 'Начать') {
      if (!isAdmin(userId)) {
        return ctx.reply(`⚠️ Этот бот только для администраторов.\n\nОбратитесь к админам: ${adminList.map(id => `[id${id}|Админ]`).join(', ')}`);
      }
      await sendMessage(message.peer_id, '🤖 VK Бот массовой рассылки\n\nИспользуйте кнопки ниже для выполнения команд:', createKeyboard());
      return;
    }
    
    // Handle admin commands
    if (isAdmin(userId)) {
      await handleAdminCommand(ctx, text);
    } else {
      // Forward non-admin messages to admins
      if (text && !text.startsWith('/')) {
        const senderInfo = `[id${userId}|Пользователь ${userId}]`;
        const forwardMessage = `📨 Сообщение от ${senderInfo}:\n\n"${text}"`;
        for (const adminId of adminList) {
          try { 
            await sendMessage(adminId, forwardMessage); 
          } catch (err) { 
            console.error(`Failed to forward to ${adminId}:`, err); 
          }
        }
        return ctx.reply(`✅ Ваше сообщение переслано администраторам: ${adminList.map(id => `[id${id}|Админ]`).join(', ')}`);
      }
    }
  } catch (error) {
    console.error('Error handling message:', error);
  }
};

const handleAdminCommand = async (ctx, text) => {
  const keyboard = createKeyboard();
  
  try {
    // Simple command mapping
    const commandHandlers = {
      '/help': () => commands.help(ctx),
      '/collect_ids': () => commands.collectIds(ctx),
      '/start_broadcast': () => commands.startBroadcast(ctx),
      '/test_broadcast': () => commands.testBroadcast(ctx),
      '/show_blocklist': () => commands.showList(ctx, 'blocklist'),
      '/show_allowlist': () => commands.showList(ctx, 'allowlist'),
      '📊 Собрать ID': () => commands.collectIds(ctx),
      '🔍 Тест рассылки': () => commands.testBroadcast(ctx),
      '📡 Рассылка': () => commands.startBroadcast(ctx),
      '📋 Чёрный список': () => commands.showList(ctx, 'blocklist'),
      '📋 Белый список': () => commands.showList(ctx, 'allowlist'),
      '❓ Помощь': () => commands.help(ctx)
    };
    
    // Handle list management commands
    if (text?.startsWith('/clear_blocklist')) {
      saveBlocklist([]);
      return sendMessage(ctx.message.peer_id, '🗑️ Чёрный список очищен.', keyboard);
    }
    if (text?.startsWith('/clear_allowlist')) {
      saveAllowlist([]);
      return sendMessage(ctx.message.peer_id, '🗑️ Белый список очищен.', keyboard);
    }
    
    // Handle user management commands
    const userCommands = {
      '/block': { action: addToBlocklist, success: '🚫 Добавлен в чёрный список.', exists: '⚠️ Уже в чёрном списке.' },
      '/unblock': { action: removeFromBlocklist, success: '✅ Убран из чёрного списка.', exists: '⚠️ Не найден в чёрном списке.' },
      '/allow': { action: addToAllowlist, success: '✅ Добавлен в белый список.', exists: '⚠️ Уже в белом списке.' },
      '/disallow': { action: removeFromAllowlist, success: '✅ Убран из белого списка.', exists: '⚠️ Не найден в белом списке.' }
    };
    
    for (const [cmd, config] of Object.entries(userCommands)) {
      if (text?.startsWith(cmd)) {
        const args = text.split(' ').slice(1);
        if (args.length < 1) {
          return sendMessage(ctx.message.peer_id, `❗ Использование: ${cmd} <id_пользователя>`, keyboard);
        }
        try {
          const result = config.action(args[0]);
          await sendMessage(ctx.message.peer_id, result ? config.success : config.exists, keyboard);
        } catch (err) {
          await sendMessage(ctx.message.peer_id, `❌ Ошибка: ${err.message}`, keyboard);
        }
        return;
      }
    }
    
    // Handle simple commands
    if (text && commandHandlers[text]) {
      await commandHandlers[text]();
    }
  } catch (error) {
    console.error('Command error:', error);
    await sendMessage(ctx.message.peer_id, '❌ Произошла ошибка при выполнении команды.', keyboard);
  }
};

console.log('🔗 Бот запущен...');
const app = express();
app.use(bodyParser.json());
app.post('/', handleWebhook);
app.listen(PORT, () => {
  console.log(`🚀 Сервер слушает порт: ${PORT}`);
});