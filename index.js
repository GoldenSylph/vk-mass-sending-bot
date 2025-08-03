import dotenv from 'dotenv';
import express from 'express';
import bodyParser from 'body-parser';
import { statSync, readFileSync, writeFileSync, promises } from 'fs';
import VkBot from 'node-vk-bot-api';
import PQueue from 'p-queue';
import Handlebars from 'handlebars';

dotenv.config();

const { SECRET, CONFIRMATION, PORT = 8080, VK_TOKEN: TOKEN, VK_GROUP_ID: GROUP_ID, ADMIN_IDS } = process.env;
const ADMIN_LIST = (ADMIN_IDS || '').split(',').map(Number).filter(id => !isNaN(id));

if (!TOKEN || !GROUP_ID || !ADMIN_LIST.length) process.exit(console.error('❌ Missing VK_TOKEN, VK_GROUP_ID, ADMIN_IDS'));

const bot = new VkBot({ token: TOKEN, group_id: Number(GROUP_ID), api: { v: '5.199' }, confirmation: CONFIRMATION, secret: SECRET });
const queue = new PQueue({ intervalCap: 30, interval: 1000 });
const cache = { blocklist: { data: null, lastModified: 0 }, allowlist: { data: null, lastModified: 0 } };

const isAdmin = userId => ADMIN_LIST.includes(userId);
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

const sendMessage = async (peer_id, text, keyboard) => bot.api('messages.send', {
  peer_id, message: text, 
  attachment: (process.env.ATTACHMENTS || '').trim() || undefined,
  random_id: peer_id * 100000 + (Date.now() % 100000),
  ...(keyboard && { keyboard: JSON.stringify(keyboard) })
});

async function gatherUserIds(group_id) {
  const members = [];
  let offset = 0;
  const count = 1000;
  let total = null;

  while (true) {
    const data = await queue.add(() => bot.api('groups.getMembers', {
      group_id, offset, count, fields: 'first_name,last_name'
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

async function broadcast(messageTemplate, userObjects, dryRun = false) {
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
        if (err.code === 429 && err.data?.parameters?.retry_after && !dryRun) {
          await new Promise(r => setTimeout(r, err.data.parameters.retry_after * 1000));
          return sendMessage(user.id, personalizedMessage);
        }
      }
    });
  }
  await queue.onIdle();
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
      { action: { type: "text", label: "� Чёрный список" }, color: "secondary" }
    ],
    [
      { action: { type: "text", label: "📋 Белый список" }, color: "secondary" },
      { action: { type: "text", label: "❓ Помощь" }, color: "secondary" }
    ]
  ]
});

// Command handlers
const commands = {
  async gatherIds(ctx) {
    const keyboard = createKeyboard();
    await sendMessage(ctx.message.peer_id, '⏳ Собираем ID участников сообщества…', keyboard);
    try {
      const members = await gatherUserIds(GROUP_ID);
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
      const users = await gatherUserIds(GROUP_ID);
      
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
        await sendMessage(ctx.message.peer_id, `� Тестируем с ${filteredUsers.length} пользователями (${blockedCount} исключено)`, keyboard);
      }

      await broadcast(templateContent, users, true);
      await sendMessage(ctx.message.peer_id, '✅ Тестовая рассылка завершена (реальные сообщения не отправлялись).', keyboard);
    } catch (err) {
      console.error(err);
      await sendMessage(ctx.message.peer_id, '❌ Тестовая рассылка не удалась: ' + err.message, keyboard);
    }
  },

  async broadcast(ctx) {
    const keyboard = createKeyboard();
    await sendMessage(ctx.message.peer_id, '📡 Обновляем список получателей…', keyboard);

    try {
      const users = await gatherUserIds(GROUP_ID);
      
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
      await broadcast(templateContent, users);
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

    const listText = list.map((userId, index) => `${index + 1}. ${userId}`).join('\n');
    await sendMessage(ctx.message.peer_id, `📋 ${listName} список (${list.length}):\n${listText}`, keyboard);
  },

  async help(ctx) {
    const helpText = `🤖 Команды VK бота массовой рассылки:

📊 /собрать_айди - Собрать ID участников сообщества
🔍 /тест_рассылки - Запустить тестовую рассылку (без отправки)
📡 /рассылка - Отправить рассылку всем пользователям
📋 /показать_чёрный_список - Показать заблокированных пользователей
📋 /показать_белый_список - Показать разрешённых пользователей
🗑️ /очистить_чёрный_список - Очистить чёрный список
🗑️ /очистить_белый_список - Очистить белый список
🚫 /заблокировать <id> - Заблокировать пользователя
✅ /разблокировать <id> - Разблокировать пользователя
✅ /разрешить <id> - Добавить в белый список
❌ /запретить <id> - Убрать из белого списка

Переменные шаблона: {{first_name}}, {{last_name}}, {{id}}`;

    await sendMessage(ctx.message.peer_id, helpText, createKeyboard());
  }
};

// Bot handlers  
bot.use(async (ctx, next) => { try { await next(); } catch (err) { console.error('Bot error:', err); } });

bot.command('/начать', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply(`⚠️ Этот бот только для администраторов.\n\nОбратитесь к админам: ${ADMIN_LIST.map(id => `[id${id}|Админ]`).join(', ')}`);
  }
  await sendMessage(ctx.message.peer_id, '🤖 VK Бот массовой рассылки\n\nИспользуйте кнопки ниже для выполнения команд:', createKeyboard());
});

// Command mapping
const commandMap = {
  '/помощь': () => commands.help, '/собрать_айди': () => commands.gatherIds, '/рассылка': () => commands.broadcast,
  '/тест_рассылки': () => commands.testBroadcast, '/показать_чёрный_список': () => commands.showList,
  '/показать_белый_список': () => commands.showList, '📊 Собрать ID': () => commands.gatherIds,
  '🔍 Тест рассылки': () => commands.testBroadcast, '📡 Рассылка': () => commands.broadcast,
  '📋 Чёрный список': () => commands.showList, '📋 Белый список': () => commands.showList, '❓ Помощь': () => commands.help
};

Object.keys(commandMap).forEach(cmd => {
  if (cmd.startsWith('/')) {
    bot.command(cmd, async ctx => {
      if (!isAdmin(ctx.message.from_id)) return ctx.reply('⚠️ Доступ запрещён.');
      const handler = commandMap[cmd]();
      if (cmd.includes('белый')) await handler(ctx, 'allowlist');
      else if (cmd.includes('чёрный')) await handler(ctx, 'blocklist');
      else await handler(ctx);
    });
  }
});

// List management
[
  { cmd: '/очистить_чёрный_список', action: () => saveBlocklist([]), msg: '🗑️ Чёрный список очищен.' },
  { cmd: '/очистить_белый_список', action: () => saveAllowlist([]), msg: '🗑️ Белый список очищен.' },
  { cmd: '/заблокировать', action: addToBlocklist, success: '🚫 Добавлен в чёрный список.', exists: '⚠️ Уже в чёрном списке.' },
  { cmd: '/разблокировать', action: removeFromBlocklist, success: '✅ Убран из чёрного списка.', exists: '⚠️ Не найден в чёрном списке.' },
  { cmd: '/разрешить', action: addToAllowlist, success: '✅ Добавлен в белый список.', exists: '⚠️ Уже в белом списке.' },
  { cmd: '/запретить', action: removeFromAllowlist, success: '✅ Убран из белого списка.', exists: '⚠️ Не найден в белом списке.' }
].forEach(({ cmd, action, msg, success, exists }) => {
  bot.command(cmd, async ctx => {
    if (!isAdmin(ctx.message.from_id)) return ctx.reply('⚠️ Доступ запрещён.');
    const keyboard = createKeyboard();
    if (msg) { action(); return sendMessage(ctx.message.peer_id, msg, keyboard); }
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) return sendMessage(ctx.message.peer_id, `❗ Использование: ${cmd} <id_пользователя>`, keyboard);
    try {
      const result = action(args[0]);
      await sendMessage(ctx.message.peer_id, result ? success : exists, keyboard);
    } catch (err) {
      await sendMessage(ctx.message.peer_id, `❌ Ошибка: ${err.message}`, keyboard);
    }
  });
});

bot.on('message', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    if (ctx.message.text && !ctx.message.text.startsWith('/')) {
      const senderInfo = `[id${ctx.message.from_id}|Пользователь ${ctx.message.from_id}]`;
      const forwardMessage = `📨 Сообщение от ${senderInfo}:\n\n"${ctx.message.text}"`;
      for (const adminId of ADMIN_LIST) {
        try { await sendMessage(adminId, forwardMessage); } catch (err) { console.error(`Failed to forward to ${adminId}:`, err); }
      }
      return ctx.reply(`✅ Ваше сообщение переслано администраторам: ${ADMIN_LIST.map(id => `[id${id}|Админ]`).join(', ')}`);
    }
    return;
  }
  const text = ctx.message.text?.trim();
  if (text && commandMap[text]) {
    const handler = commandMap[text]();
    if (text.includes('Белый')) await handler(ctx, 'allowlist');
    else if (text.includes('Чёрный')) await handler(ctx, 'blocklist');
    else await handler(ctx);
  }
});

console.log('🔗 Бот запущен...');
const app = express();
app.use(bodyParser.json());
app.post('/', bot.webhookCallback);
app.listen(PORT);