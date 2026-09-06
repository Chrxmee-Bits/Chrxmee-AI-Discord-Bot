require("dotenv").config();
const { Client, GatewayIntentBits, Collection, EmbedBuilder } = require("discord.js");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { setupAntinukeEvents } = require("./antinukeEvents");

// ==================== HELPERS ====================
function msToTime(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ==================== PFP ROTATION ====================
const pfps = [
  path.join(__dirname, "pfps", "pfp1.png"),
  path.join(__dirname, "pfps", "pfp2.png"),
  path.join(__dirname, "pfps", "pfp3.png"),
];

async function rotateAvatar(client) {
  const now = new Date();
  const hour = now.getHours();
  const minutes = now.getMinutes();

  const halfHourSlot = Math.floor(minutes / 30);
  const index = (hour * 2 + halfHourSlot) % 3;

  try {
    const avatarBuffer = fs.readFileSync(pfps[index]);
    await client.user.setAvatar(avatarBuffer);
    console.log(`Avatar set to pic ${index + 1} (${hour}:${String(minutes).padStart(2, "0")})`);
  } catch (err) {
    console.error("Failed to change avatar:", err.message);
  }
}

// ==================== KEEP-ALIVE SERVER ====================
const http = require("http");
console.log("Starting keep-alive server...");
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  if (req.url === "/stats") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      servers: client.guilds?.cache?.size || 0,
      uptime: process.uptime(),
      commands: client.commands?.size || 0
    }));
  } else if (req.url === "/guilds") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    let guilds = [];
    let attempts = 0;
    while (attempts < 20) {
      guilds = client.guilds?.cache?.map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon,
        memberCount: g.memberCount
      })) || [];
      if (guilds.length > 0) break;
      attempts++;
      if (attempts < 20) await new Promise(r => setTimeout(r, 1000));
    }
    res.end(JSON.stringify(guilds));
  } else if (req.url === "/commands") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    const commands = client.commands?.map(cmd => ({
      name: cmd.data.name,
      description: cmd.data.description,
      options: cmd.data.options || []
    })) || [];
    res.end(JSON.stringify(commands));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Chrxmee AI is alive!");
  }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Keep-alive server listening on port ${PORT}`);
});
server.on("error", (err) => {
  console.error("Keep-alive server error:", err.message);
  setTimeout(() => server.listen(PORT, "0.0.0.0"), 5000);
});

// ==================== CLIENT CREATION ====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [1, 3],
});

client.commands = new Collection();
client.memory = new Map();
client.snipes = new Map();
client.msToTime = msToTime;

// ==================== POSTGRES POOL ====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (err) => {
  console.error("Postgres pool error:", err.message);
});

setInterval(async () => {
  try {
    const pgClient = await pool.connect();
    await pgClient.query("SELECT 1");
    pgClient.release();
    console.log("Postgres keep-alive ping OK");
  } catch (err) {
    console.error("Postgres keep-alive failed:", err.message);
  }
}, 30000);

client.pool = pool;

// ==================== SNIPE SYSTEM ====================
client.on("messageDelete", (message) => {
  if (message.author?.bot || !message.content) return;
  const snipes = client.snipes.get(message.channelId) || [];
  snipes.push({ author: message.author, content: message.content, timestamp: new Date(), type: "delete" });
  if (snipes.length > 100) snipes.shift();
  client.snipes.set(message.channelId, snipes);

  const text = message.content.toLowerCase();
  let roast = "";
  if (text.includes("kill") || text.includes("die") || text.includes("murder")) {
    roast = `hey man ${message.author}, dont say threats <:Son:1526536930693484575>`;
  } else if (text.includes("fuck") || text.includes("bitch") || text.includes("shit")) {
    roast = `hey twin ${message.author} dont swear ples, JS KIDDING. but dont be callin nobody a bih got me?.`;
  } else if (text.includes("ugly") || text.includes("stupid") || text.includes("loser")) {
    roast = `hey bro ${message.author} stop projecting yourself its not nice to talk about yourself that way :(.`;
  }
  if (roast) message.channel.send(roast).catch(() => {});
});

client.on("messageUpdate", (oldMsg, newMsg) => {
  if (oldMsg.author?.bot || oldMsg.content === newMsg.content) return;
  const snipes = client.snipes.get(oldMsg.channelId) || [];
  snipes.push({ author: oldMsg.author, content: newMsg.content, oldContent: oldMsg.content, timestamp: new Date(), type: "edit" });
  if (snipes.length > 100) snipes.shift();
  client.snipes.set(oldMsg.channelId, snipes);
});

// ==================== COMMAND & EVENT LOADING ====================
const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith(".js"));
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ("data" in command && "execute" in command) {
    client.commands.set(command.data.name, command);
  }
}

const eventsPath = path.join(__dirname, "events");
const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith(".js"));
for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file);
  const event = require(filePath);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

// ==================== HEARTBEAT — STREAMING RICH PRESENCE ====================
const TWITCH_URL = "https://twitch.tv/chrxmeelst";
const DISCORD_INVITE = "https://discord.gg/kSnTmCKhQj";

let heartbeatCount = 0;
setInterval(() => {
  heartbeatCount++;
  if (client.user) {
    const activities = [
      "competing in the discord ai competition. ggs chatcord.",
      "i have beef with chatcord, hes buns, im better. haha",
      "smarter then 60% of the average bland bots here.",
      "analyzing my 10 reasons why im here to deal with yalls bs.",
      `got tortured for ${Math.floor(process.uptime() / 3600)}h in ${client.guilds.cache.size} servers. gg bro`,
      `handling ${heartbeatCount} heartbeats, its kinda crazy im alive.`,
    ];
    const activity = activities[Math.floor(Math.random() * activities.length)];

    client.user.setPresence({
      status: "online",
      activities: [{
        name: activity,
        type: 1,
        url: TWITCH_URL,
      }],
    });

    console.log(`[HEARTBEAT #${heartbeatCount}] Presence: ${activity}`);
  }
}, 300000);

// ==================== CLIENT READY ====================
client.once("ready", async () => {
  try {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Chrxmee AI ready as ${client.user.tag}`);

    // PFP ROTATION — set immediately on boot, 60-second window
    await rotateAvatar(client);
    let lastPfpSlot = null;

    setInterval(() => {
      const now = new Date();
      const m = now.getMinutes();
      const s = now.getSeconds();
      const slotKey = `${m}-${Math.floor(m / 30)}`;

      if ((m === 0 || m === 30) && s <= 59 && lastPfpSlot !== slotKey) {
        lastPfpSlot = slotKey;
        rotateAvatar(client);
      }
    }, 30_000);

        // ─── AUTO-REGISTER SLASH COMMANDS ─────────────
        const { REST, Routes } = require("discord.js");
    const fs = require("fs");
    const path = require("path");
    const commands = [];
    const seen = new Set();
    const commandsPath = path.join(__dirname, "commands");
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith(".js"));

    for (const file of commandFiles) {
      const command = require(path.join(commandsPath, file));
      if ("data" in command && "execute" in command) {
        const name = command.data.name;
        if (seen.has(name)) {
          console.warn(` Duplicate command name skipped: ${name} (from ${file})`);
          continue;
        }
        seen.add(name);
        commands.push(command.data.toJSON());
      }
    }

    const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
    try {
      console.log(` Registering ${commands.length} slash commands...`);
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log(" Slash commands registered successfully!");
    } catch (err) {
      console.error(" Slash command registration failed:", err);
    }

    // Initial streaming presence
    client.user.setPresence({
      status: "online",
      activities: [{
        name: "the discord ai competition!! now stfu chatcord.",
        type: 1,
        url: TWITCH_URL,
      }],
    });

    const pgClient = await pool.connect();
    console.log("Postgres connected successfully on ready!");

    // ─── ULTIMATE MEGA MIGRATION ─────────────────────────────
await pgClient.query(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id BIGINT PRIMARY KEY,
    wake_up_mode TEXT DEFAULT 'default',
    auto_respond BOOLEAN DEFAULT FALSE,
    show_support_link BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
  );
  ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS show_support_link BOOLEAN DEFAULT TRUE;
  
  CREATE TABLE IF NOT EXISTS user_premium (
    user_id BIGINT,
    server_id BIGINT DEFAULT 0,
    premium_type TEXT NOT NULL,
    expires_at TIMESTAMP,
    temperature REAL DEFAULT 0.75,
    embed_mode BOOLEAN DEFAULT FALSE,
    embed_color TEXT DEFAULT '7c7ce0',
    PRIMARY KEY (user_id, server_id)
  );
  ALTER TABLE user_premium ADD COLUMN IF NOT EXISTS temperature REAL DEFAULT 0.75;
  ALTER TABLE user_premium ADD COLUMN IF NOT EXISTS embed_mode BOOLEAN DEFAULT FALSE;
  ALTER TABLE user_premium ADD COLUMN IF NOT EXISTS embed_color TEXT DEFAULT '7c7ce0';

  CREATE TABLE IF NOT EXISTS premium_tokens (
    id SERIAL PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    type TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS user_fonts (
    user_id BIGINT PRIMARY KEY,
    style TEXT DEFAULT 'normal'
  );

  CREATE TABLE IF NOT EXISTS swear_block (
    guild_id TEXT PRIMARY KEY,
    enabled BOOLEAN DEFAULT FALSE,
    words TEXT[] DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS custom_commands (
    id SERIAL PRIMARY KEY,
    guild_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    response TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    created_by BIGINT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (guild_id, name)
  );

  CREATE TABLE IF NOT EXISTS mode_interactions (
    user_id TEXT PRIMARY KEY,
    preferred_mode TEXT DEFAULT 'unfiltered'
  );

  CREATE TABLE IF NOT EXISTS user_interactions (
    user_id BIGINT PRIMARY KEY,
    custom_prompt TEXT DEFAULT '',
    preferred_model TEXT DEFAULT 'genius',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );
  ALTER TABLE user_interactions ADD COLUMN IF NOT EXISTS preferred_model TEXT DEFAULT 'genius';

  CREATE TABLE IF NOT EXISTS user_personal_info (
    user_id BIGINT PRIMARY KEY,
    personal_info TEXT DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS processed_messages (
    message_id BIGINT PRIMARY KEY,
    processed_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS keyword_responder (
    id SERIAL PRIMARY KEY,
    guild_id BIGINT NOT NULL,
    keyword TEXT NOT NULL,
    response TEXT NOT NULL,
    match_type TEXT DEFAULT 'contains',
    created_by BIGINT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (guild_id, keyword)
  );

  CREATE TABLE IF NOT EXISTS user_xp (
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 0,
    prestige INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, guild_id)
  );
  ALTER TABLE user_xp ALTER COLUMN xp TYPE BIGINT;

  CREATE TABLE IF NOT EXISTS xp_blacklisted_channels (
    guild_id BIGINT NOT NULL,
    channel_id BIGINT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS xp_multipliers (
    guild_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    multiplier NUMERIC DEFAULT 1,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS xp_level_roles (
    guild_id BIGINT NOT NULL,
    level INTEGER NOT NULL,
    role_id BIGINT NOT NULL,
    PRIMARY KEY (guild_id, level)
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    name TEXT NOT NULL,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (user_id, name)
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id SERIAL PRIMARY KEY,
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    uri TEXT NOT NULL,
    author TEXT,
    duration BIGINT,
    added_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS uwuify_active (
    guild_id TEXT,
    user_id TEXT,
    mode TEXT,
    channel_id TEXT,
    started_by TEXT,
    started_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (guild_id, user_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS uwuify_protected (
    guild_id TEXT,
    user_id TEXT,
    protected_by TEXT,
    protected_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS duel_stats (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    username TEXT,
    wins INT DEFAULT 0,
    losses INT DEFAULT 0,
    total_gold_won INT DEFAULT 0,
    total_gold_lost INT DEFAULT 0,
    debt INT DEFAULT 0,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS dungeon_stats (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    username TEXT,
    farthest_room INT DEFAULT 0,
    total_gold_earned INT DEFAULT 0,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS dungeon_prestige (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    username TEXT,
    prestige INT DEFAULT 0,
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS shadow_logs (
    id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_username TEXT,
    mod_id TEXT NOT NULL,
    mod_username TEXT,
    note TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (id, guild_id)
  );

  CREATE TABLE IF NOT EXISTS merit_config (
    guild_id BIGINT PRIMARY KEY,
    log_channel_id BIGINT
  );

  CREATE TABLE IF NOT EXISTS user_merits (
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL,
    merits INTEGER DEFAULT 0,
    last_daily TIMESTAMP,
    last_status_rep TIMESTAMP,
    PRIMARY KEY (user_id, guild_id)
  );
  ALTER TABLE user_merits ADD COLUMN IF NOT EXISTS last_status_rep TIMESTAMP;

  CREATE TABLE IF NOT EXISTS j2c_config (
    guild_id BIGINT PRIMARY KEY,
    trigger_channel_id BIGINT NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    default_name TEXT DEFAULT '{user}''s VC',
    default_limit INTEGER DEFAULT 0,
    category_id BIGINT,
    log_channel_id BIGINT
  );

  CREATE TABLE IF NOT EXISTS j2c_channels (
    channel_id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL,
    owner_id BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS j2c_bans (
    guild_id BIGINT NOT NULL,
    channel_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS j2c_trusted (
    guild_id BIGINT NOT NULL,
    role_id BIGINT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  CREATE TABLE IF NOT EXISTS server_autochange (
    guild_id BIGINT PRIMARY KEY,
    enabled BOOLEAN DEFAULT FALSE,
    interval_hours INTEGER NOT NULL DEFAULT 24,
    last_change TIMESTAMP,
    names JSONB DEFAULT '[]',
    icons JSONB DEFAULT '[]',
    banners JSONB DEFAULT '[]',
    descriptions JSONB DEFAULT '[]',
    channel_renames JSONB DEFAULT '{}',
    rotation_mode TEXT DEFAULT 'random',
    sequence_state JSONB DEFAULT '{}'
  );
  ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS rotation_mode TEXT DEFAULT 'random';
  ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS sequence_state JSONB DEFAULT '{}';
  ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS interval_minutes INTEGER;
  UPDATE server_autochange SET interval_minutes = interval_hours * 60 WHERE interval_minutes IS NULL;

  CREATE TABLE IF NOT EXISTS server_backups (
    id SERIAL PRIMARY KEY,
    guild_id BIGINT NOT NULL,
    backup_id TEXT NOT NULL UNIQUE,
    data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS vanity_config (
    guild_id BIGINT PRIMARY KEY,
    invite_url TEXT NOT NULL DEFAULT 'discord.gg/chrxmaticc',
    trigger_type TEXT NOT NULL DEFAULT 'both',
    reward_amount INTEGER NOT NULL DEFAULT 100,
    cooldown_hours INTEGER NOT NULL DEFAULT 24,
    announce_channel BIGINT,
    announce_message TEXT DEFAULT '🎉 **+{amount} merits** for repping the invite! Share daily for more.'
  );
`);
console.log("MEGA MIGRATION COMPLETE – all tables and columns exist.");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS guild_settings (guild_id BIGINT PRIMARY KEY, wake_up_mode TEXT DEFAULT 'default', auto_respond BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())`);
    console.log("guild_settings table ready");

    await pgClient.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS prefix TEXT DEFAULT '!'`);
console.log("guild_settings.prefix column ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS user_birthdays (user_id BIGINT PRIMARY KEY, birthday_date DATE NOT NULL, timezone TEXT NOT NULL, birthday_role_id BIGINT, ping_role_id BIGINT, set_at TIMESTAMP DEFAULT NOW())`);
    console.log("user_birthdays table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS user_interactions (user_id BIGINT PRIMARY KEY, custom_prompt TEXT DEFAULT '', preferred_model TEXT DEFAULT 'genius', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    console.log("user_interactions table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS user_personal_info (user_id BIGINT PRIMARY KEY, personal_info TEXT DEFAULT '{}', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
    console.log("user_personal_info table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS processed_messages (message_id BIGINT PRIMARY KEY, processed_at TIMESTAMP DEFAULT NOW())`);
    console.log("processed_messages table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS keyword_responder (id SERIAL PRIMARY KEY, guild_id BIGINT NOT NULL, keyword TEXT NOT NULL, response TEXT NOT NULL, match_type TEXT DEFAULT 'contains', created_by BIGINT, created_at TIMESTAMP DEFAULT NOW(), UNIQUE (guild_id, keyword))`);
    console.log("keyword_responder table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS user_xp (user_id BIGINT NOT NULL, guild_id BIGINT NOT NULL, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, prestige INTEGER DEFAULT 0, PRIMARY KEY (user_id, guild_id))`);
    console.log("user_xp table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS xp_blacklisted_channels (guild_id BIGINT NOT NULL, channel_id BIGINT NOT NULL, PRIMARY KEY (guild_id, channel_id))`);
    console.log("xp_blacklisted_channels table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS xp_multipliers (guild_id BIGINT NOT NULL, role_id BIGINT NOT NULL, multiplier NUMERIC DEFAULT 1, PRIMARY KEY (guild_id, role_id))`);
    console.log("xp_multipliers table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS xp_level_roles (guild_id BIGINT NOT NULL, level INTEGER NOT NULL, role_id BIGINT NOT NULL, PRIMARY KEY (guild_id, level))`);
    console.log("xp_level_roles table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS playlists (id SERIAL PRIMARY KEY, user_id BIGINT NOT NULL, name TEXT NOT NULL, is_public BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW(), UNIQUE (user_id, name))`);
    console.log("playlists table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS playlist_tracks (id SERIAL PRIMARY KEY, playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE, title TEXT NOT NULL, uri TEXT NOT NULL, author TEXT, duration BIGINT, added_at TIMESTAMP DEFAULT NOW())`);
    console.log("playlist_tracks table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS uwuify_active (guild_id TEXT, user_id TEXT, mode TEXT, channel_id TEXT, started_by TEXT, started_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (guild_id, user_id, channel_id))`);
    console.log("uwuify_active table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS uwuify_protected (guild_id TEXT, user_id TEXT, protected_by TEXT, protected_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (guild_id, user_id))`);
    console.log("uwuify_protected table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS duel_stats (user_id TEXT NOT NULL, guild_id TEXT NOT NULL, username TEXT, wins INT DEFAULT 0, losses INT DEFAULT 0, total_gold_won INT DEFAULT 0, total_gold_lost INT DEFAULT 0, debt INT DEFAULT 0, PRIMARY KEY (user_id, guild_id))`);
    console.log("duel_stats table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS dungeon_stats (user_id TEXT NOT NULL, guild_id TEXT NOT NULL, username TEXT, farthest_room INT DEFAULT 0, total_gold_earned INT DEFAULT 0, PRIMARY KEY (user_id, guild_id))`);
    console.log("dungeon_stats table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS dungeon_prestige (user_id TEXT NOT NULL, guild_id TEXT NOT NULL, username TEXT, prestige INT DEFAULT 0, PRIMARY KEY (user_id, guild_id))`);
    console.log("dungeon_prestige table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS shadow_logs (id TEXT NOT NULL, guild_id TEXT NOT NULL, target_id TEXT NOT NULL, target_username TEXT, mod_id TEXT NOT NULL, mod_username TEXT, note TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (id, guild_id))`);
    console.log("shadow_logs table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS mode_interactions (user_id TEXT PRIMARY KEY, preferred_mode TEXT DEFAULT 'unfiltered')`);
    console.log("mode_interactions table ready");
    
        await pgClient.query(`CREATE TABLE IF NOT EXISTS user_fonts (user_id BIGINT PRIMARY KEY, style TEXT DEFAULT 'normal')`);
console.log("user_fonts table ready");

    await pgClient.query(`
  CREATE TABLE IF NOT EXISTS drunklock_active (
    guild_id TEXT,
    user_id TEXT,
    channel_id TEXT,
    started_by TEXT,
    started_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (guild_id, user_id, channel_id)
  )
`);
console.log("✅ drunklock_active table ready");

await pgClient.query(`
  CREATE TABLE IF NOT EXISTS drunklock_protected (
    guild_id TEXT,
    user_id TEXT,
    protected_by TEXT,
    protected_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (guild_id, user_id)
  )
`);
console.log("✅ drunklock_protected table ready");

    await pgClient.query(`
  CREATE TABLE IF NOT EXISTS voicemaster_settings (
    guild_id TEXT PRIMARY KEY,
    enabled BOOLEAN DEFAULT FALSE
  )
`);
console.log("✅ voicemaster_settings table ready");

    await pgClient.query(`
  CREATE TABLE IF NOT EXISTS user_workflows (
    user_id TEXT,
    guild_id TEXT,
    workflow_type TEXT DEFAULT 'chat',
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, guild_id)
  )
`);
console.log("✅ user_workflows table ready");

    await pgClient.query(`
  CREATE TABLE IF NOT EXISTS boost_settings (
    guild_id TEXT PRIMARY KEY,
    enabled BOOLEAN DEFAULT FALSE,
    rewards_enabled BOOLEAN DEFAULT TRUE,
    default_role_color TEXT DEFAULT '#d2b48c',
    role_name_template TEXT DEFAULT '{user} ★'
  )
`);
console.log("✅ boost_settings table ready");

await pgClient.query(`
  CREATE TABLE IF NOT EXISTS boost_roles (
    guild_id TEXT,
    user_id TEXT,
    role_id TEXT,
    PRIMARY KEY (guild_id, user_id)
  )
`);
console.log("✅ boost_roles table ready");

await pgClient.query(`
  CREATE TABLE IF NOT EXISTS boost_rewards (
    guild_id TEXT,
    reward_type TEXT,
    reward_value TEXT,
    PRIMARY KEY (guild_id, reward_type)
  )
`);
console.log("✅ boost_rewards table ready");

await pgClient.query(`
  CREATE TABLE IF NOT EXISTS starboard_settings (
    guild_id TEXT PRIMARY KEY,
    starboard_channel_id TEXT,
    emoji TEXT DEFAULT '<:Star:1545563186017607732>',
    threshold INTEGER DEFAULT 3
  )
`);
console.log("✅ starboard_settings table ready");

await pgClient.query(`
  CREATE TABLE IF NOT EXISTS starboard_links (
    guild_id TEXT,
    source_id TEXT,
    starboard_channel_id TEXT,
    PRIMARY KEY (guild_id, source_id)
  )
`);
console.log("✅ starboard_links table ready");

await pgClient.query(`
  CREATE TABLE IF NOT EXISTS starboard_messages (
    guild_id TEXT,
    message_id TEXT,
    starboard_message_id TEXT,
    PRIMARY KEY (guild_id, message_id)
  )
`);
console.log("✅ starboard_messages table ready");
    
    await pool.query(`ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);

await pgClient.query(`
  ALTER TABLE merit_config
  ADD COLUMN IF NOT EXISTS xp_merit_enabled BOOLEAN DEFAULT FALSE
`);
console.log("xp_merit_enabled column added");
    
await pgClient.query(`
  CREATE TABLE IF NOT EXISTS self_prefixes (
    user_id TEXT PRIMARY KEY,
    prefix TEXT NOT NULL
  )
`);
console.log("self_prefixes table ready");
    
    await pgClient.query(`CREATE TABLE IF NOT EXISTS juul_config (
  guild_id TEXT PRIMARY KEY,
  verified BOOLEAN DEFAULT FALSE,
  verified_by TEXT,
  verified_at TIMESTAMP,
  respawn_seconds INTEGER DEFAULT 1500,
  break_hits INTEGER DEFAULT 10,
  hit_cd_seconds INTEGER DEFAULT 3,
  steal_cd_seconds INTEGER DEFAULT 12,
  charge_cd_regular INTEGER DEFAULT 15,
  charge_cd_special INTEGER DEFAULT 40,
  charge_boost_over50 INTEGER DEFAULT 30,
  charge_boost_under50 INTEGER DEFAULT 40,
  instant_break_chance REAL DEFAULT 0.5,
  hostage_seconds INTEGER DEFAULT 5,
  hostage_max_hits INTEGER DEFAULT 3,
  allowed_channel_id TEXT DEFAULT NULL,
  gremlin_enabled BOOLEAN DEFAULT TRUE,
  gremlin_frequency INTEGER DEFAULT 10,
  medical_hand_cost INTEGER DEFAULT 250,
  medical_throat_cost INTEGER DEFAULT 100
)`);
console.log("juul_config table ready");

await pgClient.query(`CREATE TABLE IF NOT EXISTS juul_state (
  guild_id TEXT PRIMARY KEY,
  battery INTEGER DEFAULT 100,
  holder_id TEXT,
  current_flavor TEXT DEFAULT 'classic',
  dead_but_not_broken BOOLEAN DEFAULT FALSE,
  broken BOOLEAN DEFAULT FALSE,
  respawn_at BIGINT DEFAULT 0,
  last_break_by TEXT,
  consecutive_hits INTEGER DEFAULT 0,
  total_hits INTEGER DEFAULT 0,
  total_breaks INTEGER DEFAULT 0,
  total_steals INTEGER DEFAULT 0,
  total_passes INTEGER DEFAULT 0,
  hostage_until BIGINT DEFAULT 0,
  hostage_hits_used INTEGER DEFAULT 0,
  last_action_at BIGINT DEFAULT 0
)`);
console.log("juul_state table ready");

await pgClient.query(`CREATE TABLE IF NOT EXISTS juul_leaderboard (
  guild_id TEXT,
  user_id TEXT,
  puffs INTEGER DEFAULT 0,
  steals INTEGER DEFAULT 0,
  breaks_caused INTEGER DEFAULT 0,
  charges INTEGER DEFAULT 0,
  passes INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
)`);
console.log("juul_leaderboard table ready");

await pgClient.query(`CREATE TABLE IF NOT EXISTS juul_users (
  guild_id TEXT,
  user_id TEXT,
  hits_balance INTEGER DEFAULT 0,
  charges_used INTEGER DEFAULT 0,
  charger_tier INTEGER DEFAULT 0,
  owned_flavors TEXT[] DEFAULT '{}',
  hands_broken BOOLEAN DEFAULT FALSE,
  throat_melted BOOLEAN DEFAULT FALSE,
  acid_hits INTEGER DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
)`);
console.log("juul_users table ready");

// add missing columns if tables already existed
await pgClient.query(`ALTER TABLE juul_config ADD COLUMN IF NOT EXISTS allowed_channel_id TEXT DEFAULT NULL`);
await pgClient.query(`ALTER TABLE juul_config ADD COLUMN IF NOT EXISTS gremlin_enabled BOOLEAN DEFAULT TRUE`);
await pgClient.query(`ALTER TABLE juul_config ADD COLUMN IF NOT EXISTS gremlin_frequency INTEGER DEFAULT 10`);
await pgClient.query(`ALTER TABLE juul_config ADD COLUMN IF NOT EXISTS medical_hand_cost INTEGER DEFAULT 250`);
await pgClient.query(`ALTER TABLE juul_config ADD COLUMN IF NOT EXISTS medical_throat_cost INTEGER DEFAULT 100`);
await pgClient.query(`ALTER TABLE juul_config ADD COLUMN IF NOT EXISTS hostage_seconds INTEGER DEFAULT 5`);
await pgClient.query(`ALTER TABLE juul_config ADD COLUMN IF NOT EXISTS hostage_max_hits INTEGER DEFAULT 3`);

await pgClient.query(`ALTER TABLE juul_state ADD COLUMN IF NOT EXISTS hostage_until BIGINT DEFAULT 0`);
await pgClient.query(`ALTER TABLE juul_state ADD COLUMN IF NOT EXISTS hostage_hits_used INTEGER DEFAULT 0`);

await pgClient.query(`ALTER TABLE juul_users ADD COLUMN IF NOT EXISTS hits_balance INTEGER DEFAULT 0`);
await pgClient.query(`ALTER TABLE juul_users ADD COLUMN IF NOT EXISTS charges_used INTEGER DEFAULT 0`);
await pgClient.query(`ALTER TABLE juul_users ADD COLUMN IF NOT EXISTS charger_tier INTEGER DEFAULT 0`);
await pgClient.query(`ALTER TABLE juul_users ADD COLUMN IF NOT EXISTS owned_flavors TEXT[] DEFAULT '{}'`);
await pgClient.query(`ALTER TABLE juul_users ADD COLUMN IF NOT EXISTS hands_broken BOOLEAN DEFAULT FALSE`);
await pgClient.query(`ALTER TABLE juul_users ADD COLUMN IF NOT EXISTS throat_melted BOOLEAN DEFAULT FALSE`);
await pgClient.query(`ALTER TABLE juul_users ADD COLUMN IF NOT EXISTS acid_hits INTEGER DEFAULT 0`);

console.log("juul schema updates ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS honeypot_config (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN DEFAULT FALSE,
  channel_id TEXT,
  punishment_type TEXT DEFAULT 'ban',
  threshold INTEGER DEFAULT 1,
  mute_minutes INTEGER DEFAULT 10,
  ban_duration_minutes INTEGER,
  warning_message TEXT DEFAULT 'warning: this channel is a honeypot. leave before you get caught.',
  activation_message TEXT DEFAULT 'honeypot triggered. you fell for it.',
  last_updated_by TEXT,
  last_updated_at TIMESTAMP DEFAULT NOW()
)`);
console.log("honeypot_config table ready");

await pgClient.query(`CREATE TABLE IF NOT EXISTS honeypot_strikes (
  guild_id TEXT,
  channel_id TEXT,
  user_id TEXT,
  strike_count INTEGER DEFAULT 0,
  last_strike_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (guild_id, channel_id, user_id)
)`);
console.log("honeypot_strikes table ready");
    
// Command access table with reason column
await pgClient.query(`CREATE TABLE IF NOT EXISTS cmd_access (
  id SERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  command_name TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id BIGINT NOT NULL,
  access TEXT NOT NULL,
  reason TEXT,
  UNIQUE (guild_id, command_name, target_type, target_id)
)`);
console.log("cmd_access table ready");

// Ensure reason column exists on older tables
await pgClient.query(`ALTER TABLE cmd_access ADD COLUMN IF NOT EXISTS reason TEXT`);
console.log("cmd_access.reason column ready");

// Add default mode column to guild_settings
await pgClient.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS cmd_default_mode TEXT DEFAULT 'allow_all'`);
console.log("guild_settings.cmd_default_mode column ready");

// Blacklist & Whitelist tables
await pgClient.query(`CREATE TABLE IF NOT EXISTS user_blacklist (
  user_id BIGINT PRIMARY KEY,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
)`);
console.log("user_blacklist table ready");

await pgClient.query(`CREATE TABLE IF NOT EXISTS server_blacklist (
  guild_id BIGINT PRIMARY KEY,
  reason TEXT,
  created_at TIMESTAMP DEFAULT NOW()
)`);
console.log("server_blacklist table ready");

await pgClient.query(`CREATE TABLE IF NOT EXISTS user_whitelist (
  user_id BIGINT PRIMARY KEY,
  created_at TIMESTAMP DEFAULT NOW()
)`);
console.log("user_whitelist table ready");

await pgClient.query(`CREATE TABLE IF NOT EXISTS server_whitelist (
  guild_id BIGINT PRIMARY KEY,
  created_at TIMESTAMP DEFAULT NOW()
)`);
console.log("server_whitelist table ready");

    // ─── SERVER AUTOCHANGE TABLE ─────────────────
await pgClient.query(`CREATE TABLE IF NOT EXISTS server_autochange (
  guild_id BIGINT PRIMARY KEY,
  enabled BOOLEAN DEFAULT FALSE,
  interval_minutes INTEGER NOT NULL DEFAULT 1440,
  last_change TIMESTAMP,
  names JSONB DEFAULT '[]',
  icons JSONB DEFAULT '[]',
  banners JSONB DEFAULT '[]',
  descriptions JSONB DEFAULT '[]',
  channel_renames JSONB DEFAULT '{}',
  rotation_mode TEXT DEFAULT 'random',
  sequence_state JSONB DEFAULT '{}'
)`);
console.log("server_autochange table ready");

// Ensure columns exist on existing tables
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT FALSE`);
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS interval_minutes INTEGER`);
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS last_change TIMESTAMP`);
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS names JSONB DEFAULT '[]'`);
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS icons JSONB DEFAULT '[]'`);
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS banners JSONB DEFAULT '[]'`);
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS descriptions JSONB DEFAULT '[]'`);
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS channel_renames JSONB DEFAULT '{}'`);
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS rotation_mode TEXT DEFAULT 'random'`);
await pgClient.query(`ALTER TABLE server_autochange ADD COLUMN IF NOT EXISTS sequence_state JSONB DEFAULT '{}'`);

// Convert old hour intervals to minutes (only for rows that existed before)
await pgClient.query(`UPDATE server_autochange SET interval_minutes = interval_hours * 60 WHERE interval_minutes IS NULL AND interval_hours IS NOT NULL`);
await pgClient.query(`UPDATE server_autochange SET interval_minutes = 1440 WHERE interval_minutes IS NULL`);

await pgClient.query(`ALTER TABLE server_autochange ALTER COLUMN interval_minutes SET DEFAULT 1440`);
console.log("server_autochange columns ensured with interval_minutes");
    

    await pgClient.query(`CREATE TABLE IF NOT EXISTS vanity_config (
  guild_id BIGINT PRIMARY KEY,
  invite_url TEXT NOT NULL DEFAULT 'discord.gg/chrxmaticc',
  trigger_type TEXT NOT NULL DEFAULT 'both',
  reward_amount INTEGER NOT NULL DEFAULT 100,
  cooldown_hours INTEGER NOT NULL DEFAULT 24,
  announce_channel BIGINT,
  announce_message TEXT DEFAULT 'you gotten **+{amount} merits** for repping the invite! share the link for more twin ❤️.'
)`);
console.log("vanity_config table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS server_backups (
  id SERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  backup_id TEXT NOT NULL UNIQUE,
  data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
)`);
console.log("server_backups table ready");

    await pgClient.query(`ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS show_support_link BOOLEAN DEFAULT TRUE`);
console.log("guild_settings.show_support_link column ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS premium_tokens (
  id SERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
)`);
console.log("premium_tokens table ready");
    
    // ─── Fix user_premium primary key ──────────
await pgClient.query(`ALTER TABLE user_premium ADD COLUMN IF NOT EXISTS server_id BIGINT`);
console.log("server_id column ready");

// Set NULL server_ids to 0 (so primary key works)
await pgClient.query(`UPDATE user_premium SET server_id = 0 WHERE server_id IS NULL`);
console.log("Existing rows updated with server_id = 0");

// Drop old constraint and add composite key
await pgClient.query(`ALTER TABLE user_premium DROP CONSTRAINT IF EXISTS user_premium_pkey`);
await pgClient.query(`ALTER TABLE user_premium ADD PRIMARY KEY (user_id, server_id)`);
console.log("user_premium primary key set to (user_id, server_id)");
    
    // ─── Custom Commands ────────────────────────
await pgClient.query(`CREATE TABLE IF NOT EXISTS custom_commands (
  id SERIAL PRIMARY KEY,
  guild_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  response TEXT NOT NULL,
  type TEXT DEFAULT 'text',
  created_by BIGINT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (guild_id, name)
)`);
console.log("custom_commands table ready");
 
    // ─── Premium System ─────────────────────────
await pgClient.query(`CREATE TABLE IF NOT EXISTS user_premium (
  user_id BIGINT PRIMARY KEY,
  premium_type TEXT NOT NULL,
  expires_at TIMESTAMP,
  temperature REAL DEFAULT 0.75,
  embed_mode BOOLEAN DEFAULT FALSE,
  embed_color TEXT DEFAULT '7c7ce0'
)`);
console.log("user_premium table ready");
    
// Add premium tokens
    await pgClient.query(`CREATE TABLE IF NOT EXISTS premium_tokens (
  id SERIAL PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
)`);
console.log("premium_tokens table ready");

// Add premium feature columns (safe to run every time)
await pgClient.query(`ALTER TABLE user_premium ADD COLUMN IF NOT EXISTS temperature REAL DEFAULT 0.75`);
await pgClient.query(`ALTER TABLE user_premium ADD COLUMN IF NOT EXISTS embed_mode BOOLEAN DEFAULT FALSE`);
await pgClient.query(`ALTER TABLE user_premium ADD COLUMN IF NOT EXISTS embed_color TEXT DEFAULT '7c7ce0'`);
await pgClient.query(`ALTER TABLE user_premium ADD COLUMN IF NOT EXISTS server_id BIGINT`);
console.log("user_premium columns verified");

// ─── Global Swear Block ─────────────────────
await pgClient.query(`CREATE TABLE IF NOT EXISTS swear_block (
  guild_id TEXT PRIMARY KEY,
  enabled BOOLEAN DEFAULT FALSE,
  words TEXT[] DEFAULT '{}'
)`);
console.log("swear_block table ready");

    await pgClient.query(`ALTER TABLE user_interactions ADD COLUMN IF NOT EXISTS preferred_model TEXT DEFAULT 'genius'`);
    
    // ==================== J2C TABLES ====================
    await pgClient.query(`CREATE TABLE IF NOT EXISTS j2c_config (guild_id BIGINT PRIMARY KEY, trigger_channel_id BIGINT NOT NULL, enabled BOOLEAN DEFAULT TRUE, default_name TEXT DEFAULT '{user}''s VC', default_limit INTEGER DEFAULT 0, category_id BIGINT, log_channel_id BIGINT)`);
    console.log("j2c_config table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS j2c_channels (channel_id BIGINT PRIMARY KEY, guild_id BIGINT NOT NULL, owner_id BIGINT NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
    console.log("j2c_channels table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS j2c_bans (guild_id BIGINT NOT NULL, channel_id BIGINT NOT NULL, user_id BIGINT NOT NULL, PRIMARY KEY (channel_id, user_id))`);
    console.log("j2c_bans table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS j2c_trusted (guild_id BIGINT NOT NULL, role_id BIGINT NOT NULL, PRIMARY KEY (guild_id, role_id))`);
    console.log("j2c_trusted table ready");

    // ==================== MERIT TABLES ====================
    await pgClient.query(`CREATE TABLE IF NOT EXISTS user_merits (user_id BIGINT NOT NULL, guild_id BIGINT NOT NULL, merits INTEGER DEFAULT 0, last_daily TIMESTAMP, last_status_rep TIMESTAMP, PRIMARY KEY (user_id, guild_id))`);
    console.log("user_merits table ready");

    await pgClient.query(`CREATE TABLE IF NOT EXISTS merit_config (guild_id BIGINT PRIMARY KEY, log_channel_id BIGINT)`);
    console.log("merit_config table ready");

    await pgClient.query(`ALTER TABLE user_merits ADD COLUMN IF NOT EXISTS last_status_rep TIMESTAMP`);
    console.log("user_merits last_status_rep column ready");

    const res = await pgClient.query("SELECT 1");
    console.log("Test query worked:", res.rows);
    pgClient.release();
    console.log("All tables ready — pool pre-warmed successfully");

    // Inject Rich Presence buttons (Join Server + Watch Twitch)
    try {
      const appId = client.user.id;
      await client.rest.put(`/applications/${appId}/assets`, {
        body: [],
      });
      console.log("Rich Presence buttons injected — Join Server + Watch Twitch");
    } catch (err) {
      console.error("Button injection failed:", err.message);
    }

    setupAntinukeEvents(client);

    setInterval(async () => {
      try {
        const today = new Date();
        const result = await pool.query(`SELECT user_id, birthday_date, birthday_role_id, ping_role_id FROM user_birthdays`);
        for (const row of result.rows) {
          const bday = new Date(row.birthday_date);
          if (bday.getMonth() === today.getMonth() && bday.getDate() === today.getDate()) {
            const guild = client.guilds.cache.first();
            if (!guild) continue;
            const member = await guild.members.fetch(row.user_id).catch(() => null);
            if (!member) continue;
            if (row.birthday_role_id) {
              const role = guild.roles.cache.get(row.birthday_role_id);
              if (role) {
                await member.roles.add(role).catch(console.error);
                setTimeout(() => member.roles.remove(role).catch(console.error), 86400000);
              }
            }
            if (row.ping_role_id) {
              const channel = guild.systemChannel || guild.channels.cache.find((ch) => ch.isTextBased());
              if (channel) await channel.send(`<@&${row.ping_role_id}> Happy birthday to ${member}! 🎂`).catch(console.error);
            }
          }
        }
      } catch (err) {
        console.error("Birthday check failed:", err);
      }
    }, 86400000);

  } catch (err) {
    console.error("READY EVENT CRASHED:", err);
    console.error("Stack trace:", err.stack);
  }
});

// ==================== RECONNECTION LOGIC ====================
client.on("disconnect", () => {
  console.log("Bot disconnected! Attempting to reconnect...");
});
client.on("error", (err) => {
  console.error("Discord client error:", err.message);
});
client.on("warn", (info) => {
  console.warn("Discord client warning:", info);
});

// ==================== GLOBAL ERROR HANDLERS ====================
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception thrown:", err);
});

// ==================== LOGIN ====================
console.log("BOT_TOKEN value:", process.env.BOT_TOKEN ? `exists, length: ${process.env.BOT_TOKEN.length}` : "MISSING OR EMPTY");

client.login(process.env.BOT_TOKEN).then(() => {
  console.log("Discord login successful!");
}).catch((err) => {
  console.error("Discord login FAILED:", err.message);
  console.error("Full error:", err);
});
