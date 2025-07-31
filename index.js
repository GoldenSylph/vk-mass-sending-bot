import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import VkBot from 'node-vk-bot-api';
import PQueue from 'p-queue';
import Handlebars from 'handlebars';

const TOKEN = process.env.VK_TOKEN;
const GROUP_ID = process.env.VK_GROUP_ID;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(Number);

// Validate required environment variables
if (!TOKEN) {
  console.error('❌ VK_TOKEN environment variable is required');
  process.exit(1);
}

if (!GROUP_ID) {
  console.error('❌ VK_GROUP_ID environment variable is required');
  process.exit(1);
}

if (ADMIN_IDS.length === 0 || ADMIN_IDS.every(id => isNaN(id))) {
  console.error('❌ ADMIN_IDS environment variable must contain valid user IDs');
  process.exit(1);
}

const bot = new VkBot({
  token: TOKEN,
  group_id: Number(GROUP_ID),
  api: { v: '5.131' },
});

const queue = new PQueue({ intervalCap: 30, interval: 1000 });

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function isValidUserId(userId) {
  const numericId = Number(userId);
  return !isNaN(numericId) && numericId > 0 && Number.isInteger(numericId);
}

function loadBlocklist() {
  try {
    const data = fs.readFileSync('./blocklist.json', 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error loading blocklist:', err.message);
    }
    return [];
  }
}

function saveBlocklist(blocklist) {
  try {
    fs.writeFileSync('./blocklist.json', JSON.stringify(blocklist, null, 2));
  } catch (err) {
    console.error('Error saving blocklist:', err.message);
    throw new Error('Failed to save blocklist');
  }
}

function addToBlocklist(userId) {
  if (!isValidUserId(userId)) {
    throw new Error('Invalid user ID format');
  }
  
  const blocklist = loadBlocklist();
  const userIdStr = String(userId);
  
  // Check if already exists
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

function isBlocked(userId) {
  const blocklist = loadBlocklist();
  return blocklist.includes(String(userId));
}

function filterBlockedUsers(users) {
  return users.filter(user => !isBlocked(user.id));
}

function loadAllowlist() {
  try {
    const data = fs.readFileSync('./allowlist.json', 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error loading allowlist:', err.message);
    }
    return [];
  }
}

function saveAllowlist(allowlist) {
  try {
    fs.writeFileSync('./allowlist.json', JSON.stringify(allowlist, null, 2));
  } catch (err) {
    console.error('Error saving allowlist:', err.message);
    throw new Error('Failed to save allowlist');
  }
}

function addToAllowlist(userId) {
  if (!isValidUserId(userId)) {
    throw new Error('Invalid user ID format');
  }
  
  const allowlist = loadAllowlist();
  const userIdStr = String(userId);
  
  // Check if already exists
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

function isAllowed(userId) {
  const allowlist = loadAllowlist();
  return allowlist.includes(String(userId));
}

function filterUsers(users) {
  const allowlist = loadAllowlist();
  
  // If allowlist has entries, only include users in allowlist
  if (allowlist.length > 0) {
    users = users.filter(user => isAllowed(user.id));
  }
  
  // Then filter out blocked users
  return users.filter(user => !isBlocked(user.id));
}

function generateRandomId(peer_id) {
  return peer_id * 100000 + (Date.now() % 100000);
}

async function sendMessage(peer_id, text) {
  const attachmentIds = (process.env.ATTACHMENTS || '').trim();
  return bot.api('messages.send', {
    peer_id,
    message: text,
    attachment: attachmentIds || undefined,
    random_id: generateRandomId(peer_id),
  });
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

      if (offset >= total) break;
    }

    fs.writeFileSync('./peer_list.json', JSON.stringify(members, null, 4));
    return members;
  } catch (err) {
    console.error('Error gathering user IDs:', err);
    throw new Error(`Failed to gather user IDs: ${err.message}`);
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
        const allowedUsers = userObjects.filter(user => isAllowed(user.id));
        const notAllowedCount = originalCount - allowedUsers.length;
        const blockedFromAllowedCount = allowedUsers.length - filteredUsers.length;
        
        console.log(`🎯 Allowlist active: ${allowedUsers.length} users allowed (${notAllowedCount} not on allowlist)`);
        if (blockedFromAllowedCount > 0) {
          console.log(`🚫 Filtered out ${blockedFromAllowedCount} blocked users from allowed list`);
        }
      } else {
        console.log(`🚫 Filtered out ${filteredCount} blocked users`);
      }
    }

    for (const user of filteredUsers) {
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
  } catch (err) {
    console.error('Error in broadcast:', err);
    throw err;
  }
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
    const filteredUsers = filterUsers(users);
    const allowlist = loadAllowlist();
    const allowlistActive = allowlist.length > 0;
    
    let templateContent;
    try {
      templateContent = fs.readFileSync('./broadcast_template.txt', 'utf-8').trim();
    } catch (err) {
      return ctx.reply('❗ Could not read broadcast_template.txt file.');
    }
    
    if (!templateContent) return ctx.reply('❗ Template file is empty.');

    let statusMessage = '';
    if (allowlistActive) {
      const allowedUsers = users.filter(user => isAllowed(user.id));
      const notAllowedCount = users.length - allowedUsers.length;
      const blockedFromAllowedCount = allowedUsers.length - filteredUsers.length;
      
      statusMessage = `📬 Sending to ${filteredUsers.length} users (allowlist: ${allowedUsers.length}, blocked: ${blockedFromAllowedCount})`;
    } else {
      const blockedCount = users.length - filteredUsers.length;
      if (blockedCount > 0) {
        statusMessage = `📬 Sending to ${filteredUsers.length} users (${blockedCount} blocked users filtered out)`;
      } else {
        statusMessage = `📬 Sending to ${filteredUsers.length} users`;
      }
    }
    
    ctx.reply(statusMessage);
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
    const filteredUsers = filterUsers(users);
    const allowlist = loadAllowlist();
    const allowlistActive = allowlist.length > 0;
    
    let templateContent;
    try {
      templateContent = fs.readFileSync('./broadcast_template.txt', 'utf-8').trim();
    } catch (err) {
      return ctx.reply('❗ Could not read broadcast_template.txt file.');
    }
    
    if (!templateContent) return ctx.reply('❗ Template file is empty.');

    if (allowlistActive) {
      const allowedUsers = users.filter(user => isAllowed(user.id));
      const blockedFromAllowedCount = allowedUsers.length - filteredUsers.length;
      ctx.reply(`🔍 Testing with ${filteredUsers.length} users (allowlist: ${allowedUsers.length}, blocked: ${blockedFromAllowedCount})`);
    } else {
      const blockedCount = users.length - filteredUsers.length;
      if (blockedCount > 0) {
        ctx.reply(`🔍 Testing with ${filteredUsers.length} users (${blockedCount} blocked users filtered out)`);
      }
    }

    await broadcast(templateContent, users, true);
    ctx.reply('✅ Dry run completed (no real messages sent).');
  } catch (err) {
    console.error(err);
    ctx.reply('❌ Dry run failed: ' + err.message);
  }
});

bot.command('/block_user', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('❗ Usage: /block_user <user_id>');
  }

  const userId = args[0];

  try {
    if (addToBlocklist(userId)) {
      ctx.reply(`🚫 Added user ID "${userId}" to blocklist.`);
    } else {
      ctx.reply(`⚠️ User ID "${userId}" is already in the blocklist.`);
    }
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.command('/unblock_user', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('❗ Usage: /unblock_user <user_id>');
  }

  const userId = args[0];

  try {
    if (removeFromBlocklist(userId)) {
      ctx.reply(`✅ Removed user ID "${userId}" from blocklist.`);
    } else {
      ctx.reply(`⚠️ User ID "${userId}" was not found in the blocklist.`);
    }
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.command('/show_blocklist', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  const blocklist = loadBlocklist();
  
  if (blocklist.length === 0) {
    return ctx.reply('📋 Blocklist is empty.');
  }

  const blocklistText = blocklist
    .map((userId, index) => `${index + 1}. ${userId}`)
    .join('\n');

  ctx.reply(`📋 Blocked users (${blocklist.length}):\n${blocklistText}`);
});

bot.command('/clear_blocklist', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  saveBlocklist([]);
  ctx.reply('🗑️ Blocklist cleared.');
});

bot.command('/allow_user', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('❗ Usage: /allow_user <user_id>');
  }

  const userId = args[0];

  try {
    if (addToAllowlist(userId)) {
      ctx.reply(`✅ Added user ID "${userId}" to allowlist.`);
    } else {
      ctx.reply(`⚠️ User ID "${userId}" is already in the allowlist.`);
    }
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.command('/unallow_user', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('❗ Usage: /unallow_user <user_id>');
  }

  const userId = args[0];

  try {
    if (removeFromAllowlist(userId)) {
      ctx.reply(`✅ Removed user ID "${userId}" from allowlist.`);
    } else {
      ctx.reply(`⚠️ User ID "${userId}" was not found in the allowlist.`);
    }
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.command('/show_allowlist', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  const allowlist = loadAllowlist();
  
  if (allowlist.length === 0) {
    return ctx.reply('📋 Allowlist is empty (all users allowed except blocked ones).');
  }

  const allowlistText = allowlist
    .map((userId, index) => `${index + 1}. ${userId}`)
    .join('\n');

  ctx.reply(`📋 Allowed users (${allowlist.length}):\n${allowlistText}`);
});

bot.command('/clear_allowlist', async ctx => {
  if (!isAdmin(ctx.message.from_id)) {
    return ctx.reply('⚠️ Access denied.');
  }

  saveAllowlist([]);
  ctx.reply('🗑️ Allowlist cleared (all users now allowed except blocked ones).');
});

bot.startPolling();
