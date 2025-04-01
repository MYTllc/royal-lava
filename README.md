# royal-lava <img src="https://cdn.discordapp.com/avatars/1348283470371094619/6fa8ec5e19ce5fbcc65b690a3a42e24d.webp?size=4096" height="40" align="right" alt="Lavalink Logo"/>

[![NPM Version](https://img.shields.io/npm/v/royal-lava?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/royal-lava)
[![NPM Downloads](https://img.shields.io/npm/dt/royal-lava?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/royal-lava)
[![Discord Support](https://cdn.discordapp.com/avatars/1348283470371094619/6fa8ec5e19ce5fbcc65b690a3a42e24d.webp?size=4096)](https://discord.gg/royal0)

**royal-lava** is an advanced, feature-rich, and reliable [Lavalink](https://github.com/lavalink-devs/Lavalink) v4 client for Node.js, designed for building sophisticated Discord music bots. It focuses on stability, multi-node management, session resumption, and a powerful queue system.

---

## ✨ Features

*   **🚀 Lavalink v4 Compatibility:** Fully supports Lavalink v4 REST and WebSocket APIs.
*   **🌐 Multi-Node Management:**
    *   Connect to and manage multiple Lavalink nodes simultaneously.
    *   Automatic "best node" selection based on calculated penalties (CPU, memory, players, frames).
    *   Add and remove nodes dynamically during runtime.
*   **🔁 Robust Reconnection:**
    *   Automatic reconnection attempts on unexpected WebSocket closure.
    *   Configurable exponential backoff strategy to avoid spamming the server.
    *   Customizable maximum reconnection tries.
*   **🔄 Session Resumption:**
    *   Leverages Lavalink v4's session resumption for quick state recovery after brief disconnects.
    *   Configurable `resumeKey` and `resumeTimeout`.
*   **🎶 Advanced Player Control:**
    *   `play()`: Play tracks (encoded or start queue), with options for start/end time, pause, noReplace.
    *   `stop()`: Halt playback and optionally clear the queue.
    *   `pause()` / `resume()`: Toggle playback pause state.
    *   `skip()`: Advance to the next track in the queue.
    *   `seek()`: Jump to a specific position in the current track (if seekable).
    *   `setVolume()`: Adjust playback volume (0-1000).
    *   `setLoop()`: Control looping behaviour (None, Track, Queue).
*   **🇶 Sophisticated Queue System:**
    *   Add single or multiple tracks.
    *   Add tracks at specific positions.
    *   Retrieve next track (`poll()`), automatically handling looping logic.
    *   Remove tracks by index or track object.
    *   Clear the entire queue (`clear()`).
    *   Shuffle the queue randomly (`shuffle()`).
    *   Access `current` track, `upcoming` tracks, `size`, `duration`, `isEmpty`.
    *   Keeps track `previousTracks` (history).
*   **🔗 Seamless Discord Integration:**
    *   Easy integration with Discord libraries (`discord.js`, `eris`, etc.).
    *   Requires user-provided function to send voice gateway payloads (Op 4).
    *   Handles incoming `VOICE_STATE_UPDATE` and `VOICE_SERVER_UPDATE` events.
    *   Manages player voice connection state.
*   **✈️ Player Node Transfer:**
    *   `player.moveToNode(newNode)`: Seamlessly move an active player (including its state and queue) from one Lavalink node to another, ideal for node maintenance or removal.
*   **🔥 Event-Driven:**
    *   Emits a wide range of events for monitoring and custom logic (node connections, track events, queue events, etc.). See [Events](#events) section.
*   **📡 REST API Abstraction:**
    *   Provides clean methods for interacting with the Lavalink v4 REST API (`loadTracks`, `decodeTrack(s)`, session management, node info/stats, player updates/destruction).
    *   Includes basic REST retry logic for timeouts.

*(Note: Audio filters like equalizer, bass boost, etc., are currently **not** implemented in this version as per design requirements.)*

---

##📋 Prerequisites

*   **Node.js:** v18.0.0 or higher (uses native `fetch`)
*   **NPM** or **Yarn**
*   **Lavalink:** A running Lavalink v4 server instance. [Find setup instructions here](https://github.com/lavalink-devs/Lavalink).

---

## 🔧 Installation

```bash
npm install royal-lava
# or
yarn add royal-lava
```

You will also need a Discord library (like discord.js) and the ws package (though royal-lava lists ws as a dependency).
```bash
npm install discord.js ws
# or
yarn add discord.js ws
```

🚀 Basic Usage Example (discord.js)
```javascript 
const { Manager, Constants } = require('royal-lava');
const { Client, GatewayIntentBits, Partials, Events } = require('discord.js'); // Use discord.js v14+

// --- Discord Client Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages, // Add if needed for commands
        GatewayIntentBits.MessageContent, // Add if needed for prefix commands
    ],
    partials: [Partials.Channel], // Required for DM interaction? Check your needs
});

// --- Lavalink Node Configuration ---
const nodes = [
    {
        host: 'localhost',         // Your Lavalink host
        port: 2333,                // Your Lavalink WebSocket port
        password: 'youshallnotpass', // Your Lavalink password
        identifier: 'Main Node',   // Optional identifier
        secure: false,             // Set to true for WSS connections
        resumeKey: `royal-lava-example-${process.pid}`, // Example unique resume key
        resumeTimeout: 60,        // In seconds
        // Optional: Retry configuration for REST requests (different from WS reconnect)
        retryAmount: 3,
        retryDelay: 500, // Initial delay in ms for REST retries
    },
    // Add more nodes here if you run multiple Lavalink instances
];

// --- Create Royal-Lava Manager ---
client.lavalink = new Manager({
    nodes: nodes, // Pass node options here (Note: `addNode` is now preferred way after Manager init)
    userId: null, // Will be set in client 'ready' event
    send: (guildId, payload) => {
        // Your function to send raw payloads to Discord gateway
        const guild = client.guilds.cache.get(guildId);
        // Use 'ws' property for discord.js v14+ internal sharding or adjust as needed
        if (guild?.shard?.ws?.readyState === 1 /* WebSocket.OPEN */ ) {
             guild.shard.send(payload);
         } else if (client.ws?.shards?.get(guild?.shardId)?.ws?.readyState === 1) {
            // Fallback if single shard or different setup
            client.ws.shards.get(guild.shardId).send(payload);
         } else {
             console.warn(`[Lavalink SEND] Could not find active shard WS for guild ${guildId}`);
         }
    },
    playerOptions: {
        // Default options for players created by this manager
        initialVolume: 80,
        selfDeaf: true,
    },
});

// Initialize nodes AFTER manager instance is created
// Nodes automatically connect once manager has userId set
// client.on('ready', () => { nodes.forEach(nodeConfig => client.lavalink.addNode(nodeConfig)); }) // Not needed if passed in constructor + userId is set later

// --- Royal-Lava Event Listeners ---
client.lavalink.on(Constants.CLIENT_EVENT_TYPES.NODE_CONNECT, node => {
    console.log(`[Lava Node Connect] "${node.identifier}" connected.`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.NODE_READY, node => {
    console.log(`[Lava Node Ready] "${node.identifier}" ready. Session: ${node.sessionId}`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, (node, error, context) => {
    console.error(`[Lava Node Error] "${node.identifier}" error: ${error.message}`, context || '');
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.NODE_DISCONNECT, (node, code, reason) => {
    console.warn(`[Lava Node Disconnect] "${node.identifier}" disconnected. Code: ${code}, Reason: ${reason || 'No reason'}`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.TRACK_START, (player, track) => {
    console.log(`[Lava Player ${player.guildId}] Track Start: ${track.info.title}`);
    // Example: Send message to Discord channel
    // const channel = client.channels.cache.get('YOUR_TEXT_CHANNEL_ID');
    // channel?.send(`Now playing: **${track.info.title}** by ${track.info.author}`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.TRACK_END, (player, track, payload) => {
    console.log(`[Lava Player ${player.guildId}] Track End. Reason: ${payload.reason}`);
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.QUEUE_END, (player) => {
    console.log(`[Lava Player ${player.guildId}] Queue End.`);
    // Example: Leave voice channel after inactivity
    // setTimeout(() => {
    //     if (!player.playing && player.connected && player.queue.isEmpty) {
    //         player.disconnect();
    //         // Send message like "Left the channel due to inactivity."
    //     }
    // }, 60 * 1000); // 60 seconds
});

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, (player, payload) => {
     console.error(`[Lava Player ${player.guildId}] Discord WebSocket closed! Code: ${payload.code}`);
     // Handle specific close codes if necessary, e.g., prompt for reconnect
 });

client.lavalink.on(Constants.CLIENT_EVENT_TYPES.DEBUG, (message) => {
    // console.debug("[Lava Debug]", message); // Enable for verbose logs
});


// --- Discord Client Event Listeners ---
client.once(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user.tag}!`);
    // IMPORTANT: Set the Manager's User ID AFTER the client is ready
    client.lavalink.userId = client.user.id;
    console.log(`Lavalink Manager initialized for User ID: ${client.lavalink.userId}`);
});

// Forward VOICE_STATE_UPDATE and VOICE_SERVER_UPDATE to royal-lava
client.on(Events.Raw, (d) => {
    // Check if the Manager is initialized before processing events
     if (client.lavalink?.userId && ['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE'].includes(d.t)) {
        // Need to pass d.d (the data payload) to the handler
        if (d.t === 'VOICE_STATE_UPDATE') {
            client.lavalink.handleVoiceStateUpdate(d.d).catch(e => console.error("[Lava Raw Handle] VSU Error:", e));
        } else if (d.t === 'VOICE_SERVER_UPDATE') {
             client.lavalink.handleVoiceServerUpdate(d.d).catch(e => console.error("[Lava Raw Handle] VServerU Error:", e));
         }
     }
 });


// --- Example /play Command (using Discord.js Interactions) ---
client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;

    const { commandName } = interaction;

    if (commandName === 'play') {
        await interaction.deferReply(); // Defer reply as searching can take time
        const query = interaction.options.getString('query', true);
        const memberChannel = interaction.member?.voice?.channel;

        if (!memberChannel) {
            return interaction.editReply({ content: 'You must be in a voice channel to play music!' });
        }
        if (!client.lavalink.userId) {
             return interaction.editReply({ content: 'Lavalink manager is not ready yet.' });
         }

        // Create or get player
         let player = client.lavalink.getPlayer(interaction.guildId);
         const botVoiceChannel = interaction.guild.members.me?.voice?.channel;

         if (!player || player.state === Constants.PLAYER_STATE.DESTROYED) {
             // If bot is already in another channel, don't allow connection attempt
             if (botVoiceChannel && botVoiceChannel.id !== memberChannel.id) {
                return interaction.editReply({ content: `I'm already playing music in ${botVoiceChannel.name}!` });
            }
             // Create player and connect
            player = client.lavalink.createPlayer(interaction.guildId);
            player.connect(memberChannel.id); // Let Royal-Lava handle sending OP 4
             // Wait for potential connection errors? Typically safe to proceed.
        } else if(player.voiceChannelId !== memberChannel.id) {
             // Check if user is trying to command from a different channel
            return interaction.editReply({ content: `You need to be in my current voice channel (${botVoiceChannel?.name ?? 'Unknown'}) to use commands!` });
         }

        try {
            const searchResult = await client.lavalink.loadTracks(query);

             if (searchResult.loadType === 'error') {
                 throw new Error(`Track load failed: ${searchResult.data?.message || 'Unknown error'}`);
            }
             if (searchResult.loadType === 'empty') {
                 return interaction.editReply({ content: 'Could not find any results for your query.' });
            }

             const track = searchResult.data?.[0] ?? searchResult.data; // Handle single track/search result

             if (!track) {
                return interaction.editReply({ content: 'No valid track found in the results.' });
             }

            player.queue.add(track);

             await interaction.editReply({ content: `Added **${track.info.title}** to the queue.` });

            // Start playing if not already playing/paused
            if (player.state !== Constants.PLAYER_STATE.PLAYING && player.state !== Constants.PLAYER_STATE.PAUSED) {
                await player.play();
            }

        } catch (error) {
             console.error('[Play Command Error]', error);
             // Use editReply safely even if an error occurs after deferral
            await interaction.editReply({ content: `An error occurred: ${error.message}` }).catch(()=>{});
             // Optionally destroy the player if connection/initial play fails critically
            // if (player && !player.connected && !player.playing) player.destroy().catch(()=>{});
         }
    }
    // Add other commands (skip, pause, stop, queue, volume, loop etc.) here
});

// --- Login ---
client.login('YOUR_BOT_TOKEN'); // Replace with your Discord Bot Token
```

# 🎉 Events
```javascript
royal-lava emits various events via the Manager instance. Use Constants.CLIENT_EVENT_TYPES for event names:

Node Events:

NODE_CONNECT (node): Emitted when a node's WebSocket connection is established.

NODE_READY (node): Emitted when a node reports ready (receives session ID, confirms connection/resumption).

NODE_DISCONNECT (node, code, reason): Emitted when a node's WebSocket connection closes.

NODE_ERROR (node, error, context): Emitted on WebSocket or REST errors related to a node. context might provide more details (e.g., failed operation).

NODE_STATS (node, stats): Emitted periodically when node stats are received.

Player Events:

PLAYER_CREATE (player): Emitted when a new player instance is created.

PLAYER_DESTROY (player): Emitted when a player instance is destroyed (locally).

PLAYER_MOVE (player, oldNode, newNode): Emitted when a player is successfully moved to a different node.

PLAYER_STATE_UPDATE (player, state): Emitted when Lavalink sends a player state update (position, ping, connected status).

PLAYER_WEBSOCKET_CLOSED (player, payload): Emitted when the Discord voice WebSocket for a player closes (as reported by Lavalink).

Track & Queue Events:

TRACK_START (player, track): Emitted when a track begins playing.

TRACK_END (player, track, payload): Emitted when a track finishes, is stopped, or replaced. payload contains the reason. track might be null if unavailable.

TRACK_EXCEPTION (player, track, error): Emitted when an error occurs during track playback (e.g., decoding error). track might be null.

TRACK_STUCK (player, track, thresholdMs): Emitted if a track gets stuck and doesn't progress for the configured threshold. track might be null.

QUEUE_END (player): Emitted when the queue finishes playing and no loop mode is active that would continue playback.

Other Events:

DEBUG (message, ...optionalArgs): Emitted for internal debugging information.
```
# 🤝 Support

- Found a Bug? Please report issues on GitHub.

- Need Help? Join our Discord Support Server.
  - https://discord.gg/royal0
<p align="center">
<a href="https://discord.gg/royal0">
<img src="https://cdn.discordapp.com/icons/1306308516713074828/f59eaa8b3660fa73db995041bc73d187.webp?size=512" alt="Discord Support Server"/>
</a>
</p>
🧑‍💻 Contributing
Contributions are welcome! Please follow these general guidelines:

Fork the repository.

Create a new branch for your feature or bug fix.

Make your changes.

Test your changes thoroughly.

Commit your changes with descriptive messages.

Push your branch to your fork.

Create a Pull Request to the main repository.

Please ensure your code adheres to the existing style and structure.
