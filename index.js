// vk_mass_messaging_bot.js
require('dotenv').config();
const fs = require('fs');
const VkBot = require('node-vk-bot-api');
const PQueue = require('p-queue');

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

async function sendMessage(peer_id, text) {
  return bot.api('messages.send', {
    peer_id,
    message: text,
    random_id: Math.floor(Math.random() * 1e9),
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
    }));

    if (total === null) total = data.count;

    members.push(...data.items.map(u => u.id || u));
    offset += count;

    if (offset >= total) break;
  }

  fs.writeFileSync('./peer_list.json', JSON.stringify(members, null, 2));
  return members;
}

async function broadcast(messageText, peerIds, dryRun = false) {
  for (const peer_id of peerIds) {
    queue.add(() => {
      if (dryRun) {
        console.log(`[DRY RUN] Would send to ${peer_id}: "${messageText}"`);
        return Promise.resolve();
      }
      return sendMessage(peer_id, messageText).catch(async err => {
        console.error(`Error sending to ${peer_id}:`, err);
        if (err.code === 429 && err.data?.parameters?.retry_after) {
          await new Promise(r => setTimeout(r, err.data.parameters.retry_after * 1000));
          return sendMessage(peer_id, messageText);
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

  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('❗ Please provide message text.');

  ctx.reply('📡 Updating recipient list…');

  try {
    const peerIds = await gatherUserIds(GROUP_ID);
    ctx.reply(`📬 Sending to ${peerIds.length} users…`);
    await broadcast(text, peerIds);
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

  const text = ctx.message.text.replace('/test_broadcast', '').trim();
  if (!text) return ctx.reply('❗ Please provide message text.');

  ctx.reply('🔍 Running test broadcast (dry run)…');

  try {
    const peerIds = await gatherUserIds(GROUP_ID);
    await broadcast(text, peerIds, true);
    ctx.reply('✅ Dry run completed (no real messages sent).');
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Dry run failed: ' + err.message);
  }
});

bot.startPolling();