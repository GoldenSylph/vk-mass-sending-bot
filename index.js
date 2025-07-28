import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import VkBot from 'node-vk-bot-api';
import PQueue from 'p-queue';
import Handlebars from 'handlebars';

const TOKEN = process.env.VK_TOKEN;
const GROUP_ID = process.env.VK_GROUP_ID;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number);

const bot = new VkBot({
  token: TOKEN,
  group_id: Number(GROUP_ID),
  api: { v: '5.131' },
});

const queue = new PQueue({ intervalCap: 30, interval: 1000 });

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function generateRandomId(peer_id) {
  return peer_id * 100000 + (Date.now() % 100000);
}

async function sendMessage(peer_id, text) {
  return bot.api('messages.send', {
    peer_id,
    message: text,
    random_id: generateRandomId(peer_id),
  });
}

async function gatherUserIds(group_id) {
  const members = [];
  let offset = 0;
  const count = 1000;
  let total = null;

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

    if (offset >= total) break;
  }

  fs.writeFileSync('./peer_list.json', JSON.stringify(members, null, 4));
  return members;
}

async function broadcast(messageTemplate, userObjects, dryRun = false) {
  const template = Handlebars.compile(messageTemplate);

  for (const user of userObjects) {
    const personalizedMessage = template({
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      id: user.id,
    });

    queue.add(() => {
      if (dryRun) {
        console.log(`[DRY RUN] Would send to ${user.id}: "${personalizedMessage}"`);
        return Promise.resolve();
      }
      return sendMessage(user.id, personalizedMessage).catch(async err => {
        console.error(`Error sending to ${user.id}:`, err);
        if (err.code === 429 && err.data?.parameters?.retry_after) {
          await new Promise(r => setTimeout(r, err.data.parameters.retry_after * 1000));
          return sendMessage(user.id, personalizedMessage);
        }
      });
    });
  }
  await queue.onIdle();
}

bot.command('/gather_ids', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  ctx.reply('⏳ Gathering community member IDs…');
  try {
    const members = await gatherUserIds(GROUP_ID);
    ctx.reply(`✅ Gathered ${members.length} user IDs.`);
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Failed to gather member IDs.');
  }
});

bot.command('/broadcast', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  ctx.reply('📡 Updating recipient list…');

  try {
    const users = await gatherUserIds(GROUP_ID);
    const templateContent = fs.readFileSync('./broadcast_template.txt', 'utf-8').trim();
    if (!templateContent) return ctx.reply('❗ Template file is empty.');

    ctx.reply(`📬 Sending to ${users.length} users…`);
    await broadcast(templateContent, users);
    ctx.reply('✅ Broadcast complete.');
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Broadcast failed: ' + err.message);
  }
});

bot.command('/test_broadcast', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  ctx.reply('🔍 Running test broadcast (dry run)…');

  try {
    const users = await gatherUserIds(GROUP_ID);
    const templateContent = fs.readFileSync('./broadcast_template.txt', 'utf-8').trim();
    if (!templateContent) return ctx.reply('❗ Template file is empty.');

    await broadcast(templateContent, users, true);
    ctx.reply('✅ Dry run completed (no real messages sent).');
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Dry run failed: ' + err.message);
  }
});

bot.startPolling();
