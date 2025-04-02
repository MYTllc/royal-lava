const EventEmitter = require('events');
const Node = require('./Node');
const Player = require('./Player');
const Constants = require('./Constants');

class Manager extends EventEmitter {
    /**
     * The Manager constructor.
     * @param {object} options Manager options.
     * @param {string} [options.userId=null] The user ID of the bot. **Recommended to set later via `manager.userId = client.user.id` in your bot's ready event.**
     * @param {Function} options.send A function required to send voice gateway payloads to Discord. `(guildId, payload) => void`
     * @param {Array<object>} [options.nodes=[]] An array of node options to automatically add upon creation.
     * @param {object} [options.playerOptions={}] Default options for players created by this manager.
     */
    constructor(options = {}) {
        super();

        // --- MODIFICATION START ---
        // REMOVED the strict check for userId here.
        // We still absolutely NEED the 'send' function.
        if (typeof options.send !== 'function') {
            throw new Error("Manager requires 'send' option (function to send Discord gateway payloads).");
        }

        // Allow userId to be null initially. It MUST be set later by the user
        // before nodes can successfully connect to Lavalink v4.
        this.userId = options.userId ?? null;
        // --- MODIFICATION END ---

        this._sendGatewayPayload = options.send;
        this.playerOptions = options.playerOptions ?? Constants.DEFAULT_PLAYER_OPTIONS;

        this.nodes = new Map(); // identifier -> Node instance
        this.players = new Map(); // guildId -> Player instance
        this.pendingGuilds = new Map(); // guildId -> { requests: [{ resolve, reject }], timeout: Timer }
        this.explicitDisconnect = null; // Track which node was explicitly disconnected by user

        // If nodes are passed directly in constructor options, attempt to add them now.
        // The Node's connection logic will use `this.userId` when it tries to connect.
        if (Array.isArray(options.nodes)) {
            options.nodes.forEach(nodeOpts => {
                try {
                    this.addNode(nodeOpts);
                } catch (err) {
                    // Emit an error or log if adding nodes fails during construction
                    console.error(`[Manager Constructor] Failed to add node (${nodeOpts.identifier || nodeOpts.host}): ${err.message}`);
                    // Optionally emit an error event: this.emit('error', new Error(`Failed adding node: ${err.message}`));
                }
            });
        }
    }

    /**
     * Adds a Lavalink node connection. Node tries to connect automatically.
     * Connection requires `manager.userId` to be set for Lavalink v4 authentication.
     * @param {object} options Node connection options (host, port, password, etc.)
     * @returns {Node} The newly created Node instance.
     * @throws {Error} If node options are invalid.
     */
    addNode(options) {
        // Add basic validation for node options if desired
        if (!options || !options.host || !options.port || !options.password) {
            throw new Error("Invalid node options: host, port, and password are required.");
        }

        const node = new Node(this, options); // Node constructor initiates connection attempt
        this.nodes.set(node.identifier, node);

        node.on(Constants.CLIENT_EVENT_TYPES.NODE_CONNECT, () => this.emit(Constants.CLIENT_EVENT_TYPES.NODE_CONNECT, node));
        node.on(Constants.CLIENT_EVENT_TYPES.NODE_READY, () => this.emit(Constants.CLIENT_EVENT_TYPES.NODE_READY, node));
        node.on(Constants.CLIENT_EVENT_TYPES.NODE_DISCONNECT, (code, reason) => {
            this.emit(Constants.CLIENT_EVENT_TYPES.NODE_DISCONNECT, node, code, reason);
            // Node's internal handler (_handleClose) manages reconnection and potentially triggers player migration
        });
        node.on(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, (err, context) => this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node, err, context));
        node.on(Constants.CLIENT_EVENT_TYPES.NODE_STATS, (stats) => this.emit(Constants.CLIENT_EVENT_TYPES.NODE_STATS, node, stats));

        this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Added node ${node.identifier} at ${node.options.host}:${node.options.port}. Will connect when userId is set.`);
        return node;
    }

    /**
     * Removes a Lavalink node connection. Will attempt to move players first.
     * @param {string} identifier The identifier of the node to remove.
     * @returns {Promise<boolean>} True if the node was removed, false otherwise.
     */
    async removeNode(identifier) {
        const node = this.nodes.get(identifier);
        if (!node) return false;

        this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Removing node ${identifier}...`);
        node.disconnect(1000, "Manager removed node"); // Disconnect gracefully

        await this._handleNodeDisconnection(node, false); // Force move players now if not already handled

        this.nodes.delete(identifier);
        node.destroy(); // Ensure internal cleanup (removes listeners etc)
        this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Node ${identifier} removed.`);
        return true;
    }

    /**
     * Creates or retrieves a Player instance for a guild.
     * Requires at least one ready Node to be available.
     * @param {string} guildId The guild ID to create the player for.
     * @param {object} [playerOpts={}] Additional options for the Player instance.
     * @returns {Player} The created or existing Player instance.
     * @throws {Error} If no nodes are available/ready or if userId is not set.
     */
    createPlayer(guildId, playerOpts = {}) {
        if (!this.userId) {
            throw new Error("Cannot create player: Manager's userId is not set. Set it in your bot's ready event.");
        }

        let player = this.players.get(guildId);
        if (player && player.state !== Constants.PLAYER_STATE.DESTROYED) {
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Reusing existing player for guild ${guildId}`);
            return player;
        }

        const idealNode = this.getIdealNode();
        if (!idealNode) {
            const totalNodes = this.nodes.size;
            const connectedNodes = [...this.nodes.values()].filter(n => n.connected).length;
            throw new Error(`No available/ready Lavalink nodes to create a player. (Total: ${totalNodes}, Connected: ${connectedNodes}) Ensure nodes are running and manager.userId is set.`);
        }

        player = new Player(this, idealNode, guildId, { ...this.playerOptions, ...playerOpts });
        this.players.set(guildId, player);

        this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_CREATE, player);
        this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Created player for guild ${guildId} on node ${idealNode.identifier}`);
        return player;
    }

    /**
     * Retrieves an existing Player instance (that hasn't been destroyed).
     * @param {string} guildId The guild ID of the player to retrieve.
     * @returns {Player | undefined} The Player instance or undefined if not found or destroyed.
     */
    getPlayer(guildId) {
        const player = this.players.get(guildId);
        if (player && player.state === Constants.PLAYER_STATE.DESTROYED) {
             // If user tries to get a player that was explicitly destroyed, return undefined
             return undefined;
         }
        return player;
    }

    /**
     * Destroys a Player instance and disconnects if necessary.
     * @param {string} guildId The guild ID of the player to destroy.
     * @returns {Promise<void>}
     */
    async destroyPlayer(guildId) {
        const player = this.players.get(guildId);
        if (player && player.state !== Constants.PLAYER_STATE.DESTROYED) {
            // Player.destroy() handles node communication and cleanup
            await player.destroy();
            // _destroyPlayer callback below handles manager map cleanup
        } else {
            // If player doesn't exist or already destroyed, just ensure it's not in the map
             this._destroyPlayer(guildId); // Clean up map just in case
        }
    }

    /**
     * Internal method called by Player.destroy() to remove player reference from manager.
     * @param {string} guildId
     * @private
     */
    _destroyPlayer(guildId) {
        const player = this.players.get(guildId); // Get it again, might have been destroyed between call and now
        if (player) { // Check if it still exists in the map
            this.players.delete(guildId);
            this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_DESTROY, player); // Emit even if destroying again, signals cleanup intent
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Player reference removed for guild ${guildId}.`);
        }
    }


    /**
     * Finds the most suitable connected and ready node based on penalty scoring.
     * @returns {Node | undefined} The ideal node or undefined if none available/ready.
     */
    getIdealNode() {
        const availableNodes = [...this.nodes.values()]
            .filter(node => node.connected && node.sessionId); // Must be connected AND have received READY (has sessionId)

        if (availableNodes.length === 0) return undefined;

        // Sort nodes by penalty score (lower is better)
        availableNodes.sort((a, b) => a.Penalties - b.Penalties);

        return availableNodes[0]; // Return the node with the lowest penalty score
    }

    /**
     * Handles voice state updates from the Discord gateway.
     * Needs `manager.userId` to be set to identify the bot's own state changes.
     * @param {object} data The raw voice state update payload (`d` property from Discord raw event).
     * @returns {Promise<void>}
     */
    async handleVoiceStateUpdate(data) {
        if (!this.userId) {
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, '[Manager] Ignoring VOICE_STATE_UPDATE: userId not set.');
            return; // Cannot process voice updates without knowing the bot's ID
        }
        if (!data || !data.guild_id) return;

        const player = this.players.get(data.guild_id);

        // --- Route update TO the player IF it's for THIS bot ---
        if (data.user_id === this.userId) {
            // If the update is for the bot itself
            if (player && player.state !== Constants.PLAYER_STATE.DESTROYED) {
                 try {
                     await player._handleVoiceStateUpdate(data);
                } catch (e) {
                    this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Error handling Voice State for Player ${data.guild_id}: ${e.message}`);
                 }
            } else if (!player && data.channel_id) {
                // Bot connected to a voice channel externally (or maybe during startup race condition?)
                 // where manager doesn't have a player instance. Log this unusual state.
                this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Received bot's own voice state for guild ${data.guild_id} (channel ${data.channel_id}) but no player instance exists.`);
                // Consider trying to force Lavalink player cleanup if this state persists, though tricky.
             } else if (data.channel_id === null) {
                // Bot disconnected externally, ensure player is cleaned up if one existed momentarily
                 if (player) await this.destroyPlayer(data.guild_id); // Should trigger full cleanup
             }
             return; // Only process bot's own updates further within the player context
         }

        // --- Optional: Handle updates for OTHER users ---
        // Example: Check if the voice channel the bot is in becomes empty
        // if (player && player.connected && player.voiceChannelId) {
        //     if (data.channel_id === null && data.old_channel_id === player.voiceChannelId) {
        //         // User left the bot's channel, check if empty
        //         const channel = client.channels.cache.get(player.voiceChannelId); // Need access to discord client state
        //         if (channel && channel.members.filter(m => !m.user.bot).size === 0) {
        //             this.emit('channelEmpty', player, channel);
        //             // Start inactivity timer etc.
        //         }
        //     }
        // }
    }


    /**
     * Handles voice server updates from the Discord gateway.
     * Routes the update to the relevant Player instance.
     * @param {object} data The raw voice server update payload (`d` property from Discord raw event).
     * @returns {Promise<void>}
     */
    async handleVoiceServerUpdate(data) {
        if (!this.userId) {
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, '[Manager] Ignoring VOICE_SERVER_UPDATE: userId not set.');
            return; // Cannot process updates without knowing which guild it's for in relation to a player
        }
        if (!data || !data.guild_id) return;

        const player = this.players.get(data.guild_id);

        if (player && player.state !== Constants.PLAYER_STATE.DESTROYED) {
            try {
                await player._handleVoiceServerUpdate(data);
            } catch (e) {
                this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Error handling Voice Server for Player ${data.guild_id}: ${e.message}`);
            }
        } else {
            // Received voice server update for a guild where no active player exists. Usually safe to ignore.
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Received voice server update for guild ${data.guild_id} where no active player exists.`);
        }
    }


    /**
     * Handles moving players off a disconnected or removed node.
     * @param {Node} disconnectedNode The node that disconnected.
     * @param {boolean} [failedPermanently=false] If true, the node is considered unusable.
     * @private Internal Use
     */
    async _handleNodeDisconnection(disconnectedNode, failedPermanently = false) {
        // Get players currently associated ONLY with the disconnected node
        const playersToMove = [...this.players.values()].filter(p =>
             p.node === disconnectedNode && p.state !== Constants.PLAYER_STATE.DESTROYED
        );

        if (playersToMove.length === 0) {
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Node ${disconnectedNode.identifier} disconnected. No players needed moving from it.`);
            return;
        }

        this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Node ${disconnectedNode.identifier} disconnected/removed. Attempting to move ${playersToMove.length} players.`);

        // Find a new suitable node (excluding the disconnected one)
        let targetNode = this.getIdealNode(); // getIdealNode already filters disconnected

        if (!targetNode && !failedPermanently) {
            // Optionally wait briefly if the disconnect might be temporary & might self-recover
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] No immediate target node. Waiting briefly for potential reconnect of ${disconnectedNode.identifier}...`);
             await new Promise(r => setTimeout(r, (disconnectedNode.options?.reconnect?.initialDelay || 1000) + 500)); // Wait slightly longer than initial reconnect delay
             targetNode = this.getIdealNode(); // Check again after waiting
        }

        if (targetNode) {
            // Attempt to move players to the target node
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Found target node ${targetNode.identifier} for migrating players from ${disconnectedNode.identifier}.`);
            let movedCount = 0;
            let failedCount = 0;
            for (const player of playersToMove) {
                 if (player.state === Constants.PLAYER_STATE.DESTROYED) continue; // Double-check state

                this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Moving player ${player.guildId} to ${targetNode.identifier}...`);
                try {
                    await player.moveToNode(targetNode);
                    movedCount++;
                    this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Player ${player.guildId} successfully moved.`);
                 } catch (moveError) {
                    failedCount++;
                     this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, targetNode, moveError, `Move Failure: Player ${player.guildId} from ${disconnectedNode.identifier} -> ${targetNode.identifier}`);
                    // If move fails, the player state is likely inconsistent. Destroy it.
                    await this.destroyPlayer(player.guildId); // Use manager's destroy to ensure map cleanup
                 }
            }
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Player migration from ${disconnectedNode.identifier} complete. Moved: ${movedCount}, Failed/Destroyed: ${failedCount}.`);

        } else {
            // No target node found (either none exist, none are ready, or node failed permanently)
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] No suitable target node found to move players from ${disconnectedNode.identifier}. Destroying affected players (${playersToMove.length}).`);
            let destroyedCount = 0;
            for (const player of playersToMove) {
                 if (player.state !== Constants.PLAYER_STATE.DESTROYED) {
                    await this.destroyPlayer(player.guildId); // Destroy the player cleanly
                     destroyedCount++;
                 }
            }
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Destroyed ${destroyedCount} players due to node ${disconnectedNode.identifier} unavailability.`);
        }
    }

    /**
     * Load tracks using the best available *ready* node.
     * @param {string} identifier Track URL or search query.
     * @param {Player} [requesterPlayer=null] Optionally specify player to hint node preference (uses player's current node if ready).
     * @returns {Promise<import('./Rest').LavalinkTrackLoadResult>} Lavalink /loadtracks response object.
     * @throws {Error} If no nodes are available/ready.
     */
    async loadTracks(identifier, requesterPlayer = null) {
        if (typeof identifier !== 'string' || !identifier) {
            throw new Error("Invalid identifier provided to loadTracks.");
        }
         // Prefer player's current node if it's connected and ready
         const preferredNode = requesterPlayer?.node?.connected && requesterPlayer?.node?.sessionId ? requesterPlayer.node : null;
         const node = preferredNode ?? this.getIdealNode();

        if (!node) {
            throw new Error("No available/ready Lavalink nodes to load tracks.");
        }
        try {
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Loading tracks for "${identifier.substring(0, 50)}..." using node ${node.identifier}`);
            const result = await node.rest.loadTracks(identifier);
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Loaded tracks result: ${result.loadType}`);
            return result;
        } catch (e) {
            this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node, e, `Failed REST loadTracks: ${identifier}`);
            throw e; // Re-throw error after logging
        }
    }

    /**
     * Decode a single track string using the best available *ready* node.
     * @param {string} encodedTrack The Base64 encoded track string.
     * @param {Player} [requesterPlayer=null] Optionally specify player to hint node preference.
     * @returns {Promise<import('./Rest').LavalinkTrackInfo>} The decoded track info object.
     * @throws {Error} If no nodes are available/ready or decoding fails.
     */
    async decodeTrack(encodedTrack, requesterPlayer = null) {
         const preferredNode = requesterPlayer?.node?.connected && requesterPlayer?.node?.sessionId ? requesterPlayer.node : null;
         const node = preferredNode ?? this.getIdealNode();
        if (!node) {
            throw new Error("No available/ready Lavalink nodes to decode track.");
        }
        try {
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Decoding track ${encodedTrack.substring(0,20)}... using node ${node.identifier}`);
             return await node.rest.decodeTrack(encodedTrack);
        } catch (e) {
            this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node, e, `Failed REST decodeTrack`);
            throw e;
        }
    }

    /**
     * Decode multiple track strings using the best available *ready* node.
     * @param {string[]} encodedTracks Array of Base64 encoded track strings.
     * @param {Player} [requesterPlayer=null] Optionally specify player to hint node preference.
     * @returns {Promise<Array<import('./Rest').LavalinkDecodedTrack>>} Array of decoded track objects (containing encoded string and info).
     * @throws {Error} If no nodes are available/ready or decoding fails.
     */
    async decodeTracks(encodedTracks, requesterPlayer = null) {
         const preferredNode = requesterPlayer?.node?.connected && requesterPlayer?.node?.sessionId ? requesterPlayer.node : null;
         const node = preferredNode ?? this.getIdealNode();
        if (!node) {
            throw new Error("No available/ready Lavalink nodes to decode tracks.");
        }
        if (!Array.isArray(encodedTracks) || encodedTracks.length === 0) {
            return []; // Return empty if no tracks provided
         }
        try {
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Decoding ${encodedTracks.length} tracks using node ${node.identifier}`);
             return await node.rest.decodeTracks(encodedTracks);
        } catch (e) {
            this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node, e, `Failed REST decodeTracks`);
            throw e;
        }
    }
}

module.exports = Manager;
