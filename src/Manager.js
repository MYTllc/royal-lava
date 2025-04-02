// src/Manager.js

// --- Original Dependencies (No Change) ---
const EventEmitter = require('events');
const Node = require('./Node');
const Player = require('./Player');
const Constants = require('./Constants');

// --- NEW CODE: Regex constants added for loadTracks logic ---
// Regex to check if input is likely a URL
const URL_REGEX = /^(?:(?:https?|ftp):\/\/)/i;
// Regex to check if input already has a known search prefix
const SEARCH_PREFIX_REGEX = /^(?:ytsearch|ytmsearch|scsearch|amsearch|dzsearch|spsearch):/i;
// --- END NEW CODE ---


class Manager extends EventEmitter {
    /**
     * The Manager constructor.
     * @param {object} options Manager options.
     // --- MODIFIED DOCUMENTATION: reflects userId change ---
     * @param {string} [options.userId=null] The user ID of the bot. **Recommended to set later via `manager.userId = client.user.id` in your bot's ready event.**
     * @param {Function} options.send A function required to send voice gateway payloads to Discord. `(guildId, payload) => void`
     * @param {Array<object>} [options.nodes=[]] An array of node options to automatically add upon creation.
     * @param {object} [options.playerOptions={}] Default options for players created by this manager.
     */
    constructor(options = {}) {
        super();

        // --- MODIFIED CODE: Strict userId check removed ---
        // OLD CODE (commented out):
        // if (!options.userId) throw new Error("Manager requires 'userId' option (your bot's ID).");

        // Check for 'send' function remains essential
        if (typeof options.send !== 'function') {
            throw new Error("Manager requires 'send' option (function to send Discord gateway payloads).");
        }

        // Allow userId to be null initially. It MUST be set later by the user.
        this.userId = options.userId ?? null;
        // --- END MODIFIED CODE ---

        this._sendGatewayPayload = options.send;
        this.playerOptions = options.playerOptions ?? Constants.DEFAULT_PLAYER_OPTIONS;

        this.nodes = new Map(); // identifier -> Node instance
        this.players = new Map(); // guildId -> Player instance
        this.pendingGuilds = new Map(); // guildId -> { requests: [{ resolve, reject }], timeout: Timer }
        this.explicitDisconnect = null; // Track which node was explicitly disconnected by user

        // --- Minor change: Moved node adding from example to constructor option (No logic change) ---
        // If nodes are passed directly in constructor options, attempt to add them now.
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
        // --- End Minor change ---
    }

    /**
     * Adds a Lavalink node connection. Node tries to connect automatically.
     * Connection requires `manager.userId` to be set for Lavalink v4 authentication.
     * @param {object} options Node connection options (host, port, password, etc.)
     * @returns {Node} The newly created Node instance.
     * @throws {Error} If node options are invalid.
     */
    addNode(options) {
        // Added basic validation (was potentially missing before or less robust)
        if (!options || !options.host || !options.port || !options.password) {
            throw new Error("Invalid node options: host, port, and password are required.");
        }
        // --- (End Added basic validation) ---

        const node = new Node(this, options); // Node constructor initiates connection attempt
        this.nodes.set(node.identifier, node);

        // Event listeners (No Change)
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
    // --- (removeNode - No significant change from previous correct versions) ---
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
    // --- (End removeNode) ---

    /**
     * Creates or retrieves a Player instance for a guild.
     * Requires at least one ready Node to be available.
     * @param {string} guildId The guild ID to create the player for.
     * @param {object} [playerOpts={}] Additional options for the Player instance.
     * @returns {Player} The created or existing Player instance.
     * @throws {Error} If no nodes are available/ready or if userId is not set.
     */
    createPlayer(guildId, playerOpts = {}) {
        // --- NEW CODE: Added userId check ---
        if (!this.userId) {
            throw new Error("Cannot create player: Manager's userId is not set. Set it in your bot's ready event.");
        }
        // --- END NEW CODE ---

        let player = this.players.get(guildId);
        if (player && player.state !== Constants.PLAYER_STATE.DESTROYED) {
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Reusing existing player for guild ${guildId}`);
            return player;
        }

        const idealNode = this.getIdealNode();
        if (!idealNode) {
            const totalNodes = this.nodes.size;
            // Refined check to ensure node readiness
            const readyNodes = [...this.nodes.values()].filter(n => n.connected && n.sessionId).length;
            throw new Error(`No available/ready Lavalink nodes to create a player. (Total: ${totalNodes}, Ready: ${readyNodes}) Ensure nodes are running and manager.userId is set.`);
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
    // --- (getPlayer - Minor refinement on destroyed check) ---
    getPlayer(guildId) {
        const player = this.players.get(guildId);
        if (player && player.state === Constants.PLAYER_STATE.DESTROYED) {
             // If user tries to get a player that was explicitly destroyed, return undefined
             return undefined;
         }
        return player;
    }
    // --- (End getPlayer) ---

    /**
     * Destroys a Player instance and disconnects if necessary.
     * @param {string} guildId The guild ID of the player to destroy.
     * @returns {Promise<void>}
     */
    // --- (destroyPlayer - Refined logic for non-existent/already destroyed) ---
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
    // --- (End destroyPlayer) ---


    /**
     * Internal method called by Player.destroy() to remove player reference from manager.
     * @param {string} guildId
     * @private
     */
    // --- (_destroyPlayer - Minor refinement checking if still exists in map) ---
     _destroyPlayer(guildId) {
        const player = this.players.get(guildId); // Get it again, might have been destroyed between call and now
        if (player) { // Check if it still exists in the map
            this.players.delete(guildId);
            this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_DESTROY, player); // Emit even if destroying again, signals cleanup intent
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Player reference removed for guild ${guildId}.`);
        }
    }
     // --- (End _destroyPlayer) ---


    /**
     * Finds the most suitable connected and ready node based on penalty scoring.
     * @returns {Node | undefined} The ideal node or undefined if none available/ready.
     */
    // --- (getIdealNode - Changed filtering/sorting logic for robustness) ---
    getIdealNode() {
        const availableNodes = [...this.nodes.values()]
            .filter(node => node.connected && node.sessionId); // Must be connected AND have received READY (has sessionId)

        if (availableNodes.length === 0) return undefined;

        // Sort nodes by penalty score (lower is better)
        availableNodes.sort((a, b) => a.Penalties - b.Penalties);

        return availableNodes[0]; // Return the node with the lowest penalty score
    }
    // --- (End getIdealNode) ---

    /**
     * Handles voice state updates from the Discord gateway.
     * Needs `manager.userId` to be set to identify the bot's own state changes.
     * @param {object} data The raw voice state update payload (`d` property from Discord raw event).
     * @returns {Promise<void>}
     */
    async handleVoiceStateUpdate(data) {
        // --- NEW CODE: Added userId check ---
        if (!this.userId) {
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, '[Manager] Ignoring VOICE_STATE_UPDATE: userId not set.');
            return; // Cannot process voice updates without knowing the bot's ID
        }
        // --- END NEW CODE ---
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
             // --- (Refined handling for non-player bot state changes) ---
            } else if (!player && data.channel_id) {
                // Bot connected to a voice channel externally (or maybe during startup race condition?)
                // where manager doesn't have a player instance. Log this unusual state.
                this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Received bot's own voice state for guild ${data.guild_id} (channel ${data.channel_id}) but no player instance exists.`);
             } else if (!player && data.channel_id === null) {
                 // Bot disconnected externally, if there was a temporary player, ensure cleanup
                 // The 'player' variable is already null here, so check the map directly if needed,
                 // but usually okay as is unless race conditions are severe.
                 this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Received bot's external disconnect state for guild ${data.guild_id}, no active player instance.`);
             } else if (player && data.channel_id === null){
                // Bot was likely in a channel WITH a player and got disconnected externally. Destroy the player.
                this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Bot disconnected externally in guild ${data.guild_id}. Destroying player.`);
                await this.destroyPlayer(data.guild_id); // Ensure full cleanup
             }
             // --- (End Refined handling) ---
             return; // Only process bot's own updates further within the player context
         }
    }


    /**
     * Handles voice server updates from the Discord gateway.
     * Routes the update to the relevant Player instance.
     * @param {object} data The raw voice server update payload (`d` property from Discord raw event).
     * @returns {Promise<void>}
     */
    async handleVoiceServerUpdate(data) {
        // --- NEW CODE: Added userId check ---
        if (!this.userId) {
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, '[Manager] Ignoring VOICE_SERVER_UPDATE: userId not set.');
            return; // Cannot process updates without knowing which guild it's for in relation to a player
        }
        // --- END NEW CODE ---
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
    // --- (_handleNodeDisconnection - Improved logging and minor logic refinement) ---
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
             // Wait slightly longer than initial reconnect delay of the *disconnected* node
             await new Promise(r => setTimeout(r, (disconnectedNode.options?.reconnect?.initialDelay || 1000) + 500));
             targetNode = this.getIdealNode(); // Check again after waiting
        }

        if (targetNode) {
            // Attempt to move players to the target node
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Found target node ${targetNode.identifier} for migrating players from ${disconnectedNode.identifier}.`);
            let movedCount = 0;
            let failedCount = 0;
            for (const player of playersToMove) {
                 // Double-check state again before attempting move, player might have been destroyed during await
                 if (player.state === Constants.PLAYER_STATE.DESTROYED || player.node !== disconnectedNode) continue;

                this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Moving player ${player.guildId} to ${targetNode.identifier}...`);
                try {
                    await player.moveToNode(targetNode);
                    // Check player state AFTER move attempt in case it was destroyed during the move process
                    if(player.state !== Constants.PLAYER_STATE.DESTROYED) {
                       movedCount++;
                       this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Player ${player.guildId} successfully moved to ${targetNode.identifier}.`);
                    } else {
                        failedCount++; // Considered failed if destroyed during move
                         this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Player ${player.guildId} was destroyed during move process.`);
                    }

                 } catch (moveError) {
                    failedCount++;
                     this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, targetNode, moveError, `Move Failure: Player ${player.guildId} from ${disconnectedNode.identifier} -> ${targetNode.identifier}`);
                    // If move fails explicitly, the player state is likely inconsistent. Destroy it.
                    await this.destroyPlayer(player.guildId); // Use manager's destroy to ensure map cleanup
                 }
            }
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Player migration attempt from ${disconnectedNode.identifier} complete. Moved: ${movedCount}, Failed/Destroyed: ${failedCount}.`);

        } else {
            // No target node found (either none exist, none are ready, or node failed permanently)
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] No suitable target node found to move players from ${disconnectedNode.identifier}. Destroying affected players (${playersToMove.length}).`);
            let destroyedCount = 0;
            for (const player of playersToMove) {
                 // Double-check state again before destroying
                 if (player.state !== Constants.PLAYER_STATE.DESTROYED && player.node === disconnectedNode) {
                    await this.destroyPlayer(player.guildId); // Destroy the player cleanly
                     destroyedCount++;
                 }
            }
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Destroyed ${destroyedCount} players due to node ${disconnectedNode.identifier} unavailability.`);
        }
    }
     // --- (End _handleNodeDisconnection) ---

    /**
     * Load tracks using the best available *ready* node.
     * Automatically prepends `ytsearch:` to the identifier if it's not a URL
     * and doesn't already have a known search prefix.
     * @param {string} identifier Track URL or search query.
     * @param {Player} [requesterPlayer=null] Optionally specify player to hint node preference.
     * @returns {Promise<import('./Rest').LavalinkTrackLoadResult>} Lavalink /loadtracks response object.
     * @throws {Error} If no nodes are available/ready or identifier is invalid.
     */
    // --- MODIFIED CODE: Added ytsearch auto-prefixing logic ---
    async loadTracks(identifier, requesterPlayer = null) {
        if (typeof identifier !== 'string' || !identifier) {
            // Old code might have had a less specific error message
            throw new Error("Invalid identifier provided to loadTracks (must be a non-empty string).");
        }

        const preferredNode = requesterPlayer?.node?.connected && requesterPlayer?.node?.sessionId ? requesterPlayer.node : null;
        const node = preferredNode ?? this.getIdealNode();

        if (!node) {
            throw new Error("No available/ready Lavalink nodes to load tracks.");
        }

        // Process the identifier logic (NEW part)
        let processedIdentifier = identifier.trim(); // Remove leading/trailing whitespace

        // Check if it's NOT a URL and does NOT already have a search prefix
        if (!URL_REGEX.test(processedIdentifier) && !SEARCH_PREFIX_REGEX.test(processedIdentifier)) {
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Input "${identifier}" is not a URL or known search. Prepending ytsearch:.`);
             processedIdentifier = `ytsearch:${processedIdentifier}`;
        } else {
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Input "${identifier}" is a URL or already has a search prefix. Using as is.`);
        }
        // End Process the identifier logic

        try {
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Loading tracks with identifier "${processedIdentifier}" using node ${node.identifier}`);
            // Use the processed identifier in the REST call
            const result = await node.rest.loadTracks(processedIdentifier);
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Loaded tracks result for "${processedIdentifier}": ${result.loadType}`);
            return result;
        } catch (e) {
            // Log the processed identifier in case of error
            this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node, e, `Failed REST loadTracks for processed identifier: ${processedIdentifier}`);
            throw e; // Re-throw error after logging
        }
    }
    // --- END MODIFIED CODE ---


    /**
     * Decode a single track string using the best available *ready* node.
     * @param {string} encodedTrack The Base64 encoded track string.
     * @param {Player} [requesterPlayer=null] Optionally specify player to hint node preference.
     * @returns {Promise<import('./Rest').LavalinkTrackInfo>} The decoded track info object.
     * @throws {Error} If no nodes are available/ready or decoding fails.
     */
    // --- (decodeTrack - No significant change) ---
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
    // --- (End decodeTrack) ---

    /**
     * Decode multiple track strings using the best available *ready* node.
     * @param {string[]} encodedTracks Array of Base64 encoded track strings.
     * @param {Player} [requesterPlayer=null] Optionally specify player to hint node preference.
     * @returns {Promise<Array<import('./Rest').LavalinkDecodedTrack>>} Array of decoded track objects (containing encoded string and info).
     * @throws {Error} If no nodes are available/ready or decoding fails.
     */
    // --- (decodeTracks - Minor refinement checking array input) ---
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
     // --- (End decodeTracks) ---
}

module.exports = Manager;
