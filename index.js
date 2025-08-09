import dotenv from 'dotenv';
import express from 'express';
import bodyParser from 'body-parser';
import { readFileSync } from 'fs';
import axios from 'axios';
import PQueue from 'p-queue';
import Handlebars from 'handlebars';

dotenv.config();

const { SECRET, CONFIRMATION, PORT = 8080, VK_TOKEN: token, VK_GROUP_ID: groupId, ADMIN_IDS: adminIds } = process.env;
const adminList = (adminIds || '').split(',').map(Number).filter(id => !isNaN(id));

if (!token || !groupId || !adminList.length) process.exit(console.error('❌ Отсутствуют VK_TOKEN, VK_GROUP_ID, ADMIN_IDS'));

const VK_API_URL = 'https://api.vk.com/method';
const API_VERSION = '5.199';
const queue = new PQueue({ intervalCap: 30, interval: 1000 });

const keyboard = {
  one_time: false,
  buttons: [
    [
      { action: { type: "text", label: "🔍 Тест рассылки" }, color: "primary" },
      { action: { type: "text", label: "📡 Рассылка" }, color: "positive" }
    ],
    [
      { action: { type: "text", label: "📋 Чёрный список" }, color: "secondary" },
      { action: { type: "text", label: "📋 Белый список" }, color: "secondary" }
    ],
    [{ action: { type: "text", label: "❓ Помощь" }, color: "secondary" }]
  ]
};

// VK API helper function
const vkApi = async (method, params = {}) => {
  return queue.add(async () => {
    const formData = new URLSearchParams();
    formData.append('access_token', token);
    formData.append('v', API_VERSION);
    
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        formData.append(key, String(value));
      }
    }

    const response = await axios.post(`${VK_API_URL}/${method}`, formData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    if (response.data.error) {
      const error = new Error(response.data.error.error_msg);
      error.code = response.data.error.error_code;
      error.data = response.data.error;
      throw error;
    }
    return response.data.response;
  });
};

const isAdmin = userId => adminList.includes(userId);

const loadList = (file) => {
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
};

const filterUsers = users => {
  const allowlist = loadList('./allowlist.json');
  const blocklist = new Set(loadList('./blocklist.json'));
  const allowSet = new Set(allowlist);
  return users.filter(user => {
    const id = String(user.id);
    return (allowlist.length === 0 || allowSet.has(id)) && !blocklist.has(id);
  });
};

const sendMessage = async (peer_id, text, withKeyboard = true) => {
  await vkApi('messages.send', {
    peer_id, 
    message: text, 
    random_id: peer_id * 100000 + (Date.now() % 100000),
    ...(withKeyboard && { keyboard: JSON.stringify(keyboard) })
  });
  await queue.onIdle();
};

const sendBroadcastMessage = async (peer_id, text) => {
  await vkApi('messages.send', {
    peer_id, 
    message: text, 
    attachment: (process.env.ATTACHMENTS || '').trim() || undefined,
    random_id: peer_id * 100000 + (Date.now() % 100000)
  });
  await queue.onIdle();
};

const canSendMessage = async (userId) => {
  try {
    const response = await vkApi('messages.isMessagesFromGroupAllowed', {
      group_id: groupId, user_id: userId
    });
    await queue.onIdle();
    return response.is_allowed === 1;
  } catch (error) {
    console.warn(`Невозможно проверить разрешение на сообщения для пользователя ${userId}:`, error.message);
    return false;
  }
};

const resolveUserNames = async (userIds) => {
  if (userIds.length === 0) return {};
  
  try {
    const resolved = {};
    for (let i = 0; i < userIds.length; i += 1000) {
      const chunk = userIds.slice(i, i + 1000);
      const response = await vkApi('users.get', {
        user_ids: chunk.join(','),
        fields: 'first_name,last_name'
      });
      
      response.forEach(user => {
        resolved[user.id] = `${user.first_name} ${user.last_name}`;
      });
    }
    
    await queue.onIdle();
    return resolved;
  } catch (error) {
    console.warn('Не удалось получить имена пользователей:', error.message);
    return {};
  }
};

async function getUserIds(groupId) {
  console.log('📋 Загружаем участников сообщества...');
  const members = [];
  let offset = 0, total = null;

  while (true) {
    const data = await vkApi('groups.getMembers', {
      group_id: groupId, offset, count: 1000, fields: 'first_name,last_name'
    });

    if (total === null) total = data.count;
    members.push(...data.items);
    offset += 1000;
    console.log(`📊 Собрано ${members.length}/${total} участников...`);
    if (offset >= total) break;
  }

  await queue.onIdle();
  return members;
}

async function sendBroadcast(messageTemplate, userObjects, dryRun = false) {
  const template = Handlebars.compile(messageTemplate);
  const filteredUsers = filterUsers(userObjects);
  const filteredCount = userObjects.length - filteredUsers.length;
  
  if (filteredCount > 0) {
    const allowlist = loadList('./allowlist.json');
    const msg = allowlist.length > 0 
      ? `🎯 Белый список активен: ${filteredUsers.length} пользователей (${filteredCount} исключено)`
      : `🚫 Исключено ${filteredCount} заблокированных пользователей`;
    console.log(msg);
  }

  let processed = 0, skipped = 0;
  const total = filteredUsers.length;

  for (const user of filteredUsers) {
    const personalizedMessage = template({
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      id: user.id,
    });

    try {
      if (!dryRun) {
        const canSend = await canSendMessage(user.id);
        if (!canSend) {
          skipped++;
          console.log(`⚠️ Пропущен ${user.id}: пользователь не разрешил сообщения от сообщества`);
          processed++;
          if (processed % 10 === 0 || processed === total) {
            console.log(`📤 Прогресс: ${processed}/${total} обработано (${processed - skipped} отправлено, ${skipped} пропущено)`);
          }
          continue;
        }
      }

      if (dryRun) {
        const attachments = (process.env.ATTACHMENTS || '').trim();
        const attachmentInfo = attachments ? `\nВложения: ${attachments}` : '\nВложения: нет';
        console.log(`[DRY RUN] Отправка ${user.id}: "${personalizedMessage.slice(0, 30)}..."${attachmentInfo}\n${JSON.stringify(user, null, 2)}\n[DRY RUN]`);
      } else {
        await sendBroadcastMessage(user.id, personalizedMessage);
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
        try {
          await sendBroadcastMessage(user.id, personalizedMessage);
        } catch (retryErr) {
          console.error(`Повторная ошибка при отправке ${user.id}:`, retryErr);
        }
      }
    }
  }
  
  if (!dryRun && skipped > 0) {
    console.log(`📊 Итого: ${processed - skipped} отправлено, ${skipped} пропущено (не разрешили сообщения)`);
  }
}

const readTemplate = () => {
  try {
    return readFileSync('./broadcast_template.txt', 'utf-8').trim();
  } catch {
    throw new Error('❗ Не удалось прочитать файл broadcast_template.txt.');
  }
};

const commands = {
  async '🔍 Тест рассылки'(ctx) {
    await sendMessage(ctx.message.peer_id, '🔍 Запускаем тестовую рассылку (без отправки)...');
    try {
      const users = await getUserIds(groupId);
      const templateContent = readTemplate();
      if (!templateContent) throw new Error('❗ Файл шаблона пуст.');

      const filteredUsers = filterUsers(users);
      const blockedCount = users.length - filteredUsers.length;
      if (blockedCount > 0) {
        await sendMessage(ctx.message.peer_id, `🧪 Тестируем с ${filteredUsers.length} пользователями (${blockedCount} исключено)`);
      }

      await sendBroadcast(templateContent, users, true);
      await sendMessage(ctx.message.peer_id, '✅ Тестовая рассылка завершена (реальные сообщения не отправлялись).');
    } catch (err) {
      console.error(err);
      await sendMessage(ctx.message.peer_id, err.message || '❌ Тестовая рассылка не удалась: ' + err.message);
    }
  },

  async '📡 Рассылка'(ctx) {
    await sendMessage(ctx.message.peer_id, '📡 Загружаем список получателей…');
    try {
      const users = await getUserIds(groupId);
      const templateContent = readTemplate();
      if (!templateContent) throw new Error('❗ Файл шаблона пуст.');

      const filteredUsers = filterUsers(users);
      const blockedCount = users.length - filteredUsers.length;
      
      const statusMessage = blockedCount > 0 
        ? `📬 Отправляем ${filteredUsers.length} пользователям (${blockedCount} исключено)`
        : `📬 Отправляем ${filteredUsers.length} пользователям`;
      
      await sendMessage(ctx.message.peer_id, statusMessage);
      await sendBroadcast(templateContent, users);
      await sendMessage(ctx.message.peer_id, '✅ Рассылка завершена.');
    } catch (err) {
      console.error(err);
      await sendMessage(ctx.message.peer_id, err.message || '❌ Рассылка не удалась: ' + err.message);
    }
  },

  async '📋 Чёрный список'(ctx) { await this.showList(ctx, 'blocklist'); },
  async '📋 Белый список'(ctx) { await this.showList(ctx, 'allowlist'); },

  async showList(ctx, listType) {
    const list = loadList(listType === 'blocklist' ? './blocklist.json' : './allowlist.json');
    const listName = listType === 'blocklist' ? 'Чёрный' : 'Белый';
    const emptyMessage = listType === 'blocklist' 
      ? '📋 Чёрный список пуст.' 
      : '📋 Белый список пуст (все пользователи разрешены кроме заблокированных).';
    
    if (list.length === 0) {
      return sendMessage(ctx.message.peer_id, emptyMessage);
    }

    const userNames = await resolveUserNames(list);
    const listText = list.map((userId, index) => {
      const userName = userNames[userId];
      return userName ? `${index + 1}. ${userName} (${userId})` : `${index + 1}. ${userId}`;
    }).join('\n');
    
    await sendMessage(ctx.message.peer_id, `📋 ${listName} список (${list.length}):\n${listText}`);
  },

  async '❓ Помощь'(ctx) {
    const helpText = `🤖 Команды бота массовой рассылки для РО Челябинска партии "Рассвет":

🔍 Тест рассылки - Запустить тестовую рассылку (без отправки)
📡 Рассылка - Отправить рассылку всем пользователям
📋 Чёрный список - Показать заблокированных пользователей
📋 Белый список - Показать разрешённых пользователей

Переменные шаблона: {{first_name}}, {{last_name}}, {{id}}

ℹ️ Списки управляются через файлы blocklist.json и allowlist.json`;

    await sendMessage(ctx.message.peer_id, helpText);
  }
};

const handleMessage = async (message) => {
  try {
    const ctx = { message };
    const text = message.text?.trim();
    const userId = message.from_id;
    
    if (text === '/начать' || text === 'Начать') {
      if (!isAdmin(userId)) {
        return sendMessage(message.peer_id, `⚠️ Этот бот только для администраторов.\n\nОбратитесь к админам: ${adminList.map(id => `[id${id}|Админ]`).join(', ')}`, false);
      }
      return sendMessage(message.peer_id, '🤖 VK бот РО Челябинска партии "Рассвет"\n\nИспользуйте кнопки ниже для выполнения команд:');
    }
    
    if (isAdmin(userId)) {
      if (commands[text]) {
        await commands[text](ctx);
      }
    } else if (text && !text.startsWith('/')) {
      const senderInfo = `[id${userId}|Пользователь ${userId}]`;
      const forwardMessage = `📨 Сообщение от ${senderInfo}:\n\n"${text}"`;
      for (const adminId of adminList) {
        try { 
          await sendMessage(adminId, forwardMessage, false); 
        } catch (err) { 
          console.error(`Не удалось переслать сообщение администратору ${adminId}:`, err); 
        }
      }
      return sendMessage(message.peer_id, `✅ Ваше сообщение переслано администраторам: ${adminList.map(id => `[id${id}|Админ]`).join(', ')}`, false);
    }
  } catch (error) {
    console.error('Ошибка при обработке сообщения:', error);
  }
};

const handleWebhook = async (req, res) => {
  try {
    const { type, object, secret } = req.body;
    
    if (SECRET && secret !== SECRET) return res.status(401).send('Unauthorized');
    
    if (type === 'confirmation') return res.send(CONFIRMATION);
    if (type === 'message_new') await handleMessage(object.message);
    
    res.send('ok');
  } catch (error) {
    console.error('Ошибка webhook:', error);
    res.status(500).send('Internal Server Error');
  }
};

console.log('🔗 Бот запущен...');
const app = express();
app.use(bodyParser.json());
app.post('/', handleWebhook);
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту: ${PORT}`));