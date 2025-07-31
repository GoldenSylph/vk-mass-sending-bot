# vk-mass-sending-bot
It's a VK bot for sending messages to a community.

## Available Commands

### Admin Commands
- `/gather_ids` - Gather community member IDs
- `/broadcast` - Send messages to community members (respects allowlist and blocklist)
- `/test_broadcast` - Dry run of broadcast (no actual messages sent)

### Blocklist Management
- `/block_user <user_id>` - Add a user ID to the blocklist
- `/unblock_user <user_id>` - Remove a user ID from the blocklist
- `/show_blocklist` - Display all blocked user IDs
- `/clear_blocklist` - Clear the entire blocklist

### Allowlist Management
- `/allow_user <user_id>` - Add a user ID to the allowlist
- `/unallow_user <user_id>` - Remove a user ID from the allowlist
- `/show_allowlist` - Display all allowed user IDs
- `/clear_allowlist` - Clear the entire allowlist

## Features
- **Dual Filtering System**: 
  - **Allowlist**: When it contains >0 entries, only users on the allowlist can receive messages
  - **Blocklist**: Users on the blocklist are always excluded from messages
- **Priority**: Allowlist is checked first, then blocklist is applied to the allowed users
- **Dry Run Testing**: Test your broadcasts without sending actual messages
- **Rate Limiting**: Built-in queue system to respect VK API limits
- **Template Support**: Use Handlebars templates with user data (first_name, last_name, id)

## How Filtering Works
1. If allowlist has entries: Only users in the allowlist are considered
2. If allowlist is empty: All users are considered
3. Blocked users are then filtered out from the allowed/considered users
4. Final list receives the broadcast messages
