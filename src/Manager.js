const EventEmitter = require('events');
const Node = require('./Node');
const Player = require('./Player');
const Constants = require('./Constants');

class Manager extends EventEmitter {
    constructor(options = {}) {
        super();
        if (!options.userId) throw new Error("Manager requires 'userId' option (your bot's ID).");
        if (!options.send) throw new Error("Manager requires 'send' option (function to send Discord gateway payloads).");

        this.userId = options.userId;
        this._sendGatewayPayload = options.send; // (guildId, payload) => void
         this.playerOptions = options.playerOptions ?? Constants.DEFAULT_PLAYER_OPTIONS;

        this.nodes = new Map(); // identifier -> Node instance
        this.players = new Map(); // guildId -> Player instance
        this.pendingGuilds = new Map(); // guildId -> { requests: [{ resolve, reject }], timeout: Timer }
        this.explicitDisconnect = null; // Track which node was explicitly disconnected by user
    }

    /**
     * Adds a Lavalink node connection.
     * @param {object} options Node connection options (host, port, password, etc.)
     * @returns {Node} The newly created Node instance.
     */
    addNode(options) {
        const node = new Node(this, options);
         this.nodes.set(node.identifier, node);

         node.on(Constants.CLIENT_EVENT_TYPES.NODE_CONNECT, () => this.emit(Constants.CLIENT_EVENT_TYPES.NODE_CONNECT, node));
        node.on(Constants.CLIENT_EVENT_TYPES.NODE_READY, () => this.emit(Constants.CLIENT_EVENT_TYPES.NODE_READY, node));
        node.on(Constants.CLIENT_EVENT_TYPES.NODE_DISCONNECT, (code, reason) => {
            this.emit(Constants.CLIENT_EVENT_TYPES.NODE_DISCONNECT, node, code, reason);
            // Node's internal handler (_handleClose) manages reconnection and player migration triggers
        });
         node.on(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, (err, context) => this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node, err, context));
         node.on(Constants.CLIENT_EVENT_TYPES.NODE_STATS, (stats) => this.emit(Constants.CLIENT_EVENT_TYPES.NODE_STATS, node, stats));

         this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Added node ${node.identifier} at ${node.options.host}:${node.options.port}`);
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
        node.destroy(); // Ensure internal cleanup
        this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Node ${identifier} removed.`);
        return true;
    }

     /**
      * Creates or retrieves a Player instance for a guild.
      * @param {string} guildId The guild ID to create the player for.
      * @param {object} [playerOpts={}] Additional options for the Player instance.
      * @returns {Player} The created or existing Player instance.
      */
     createPlayer(guildId, playerOpts = {}) {
         let player = this.players.get(guildId);
         if (player && player.state !== Constants.PLAYER_STATE.DESTROYED) {
             // Player exists, maybe check if node needs changing? For now, return existing.
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Reusing existing player for guild ${guildId}`);
            return player;
         }

        const idealNode = this.getIdealNode();
         if (!idealNode) {
            throw new Error("No available Lavalink nodes to create a player.");
         }

         player = new Player(this, idealNode, guildId, { ...this.playerOptions, ...playerOpts });
        this.players.set(guildId, player);

        this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_CREATE, player);
        this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Created player for guild ${guildId} on node ${idealNode.identifier}`);
        return player;
     }

     /**
      * Retrieves an existing Player instance.
      * @param {string} guildId The guild ID of the player to retrieve.
      * @returns {Player | undefined} The Player instance or undefined if not found.
      */
    getPlayer(guildId) {
         const player = this.players.get(guildId);
         if (player && player.state === Constants.PLAYER_STATE.DESTROYED) return undefined;
         return player;
    }

    /**
     * Destroys a Player instance and disconnects if necessary.
     * @param {string} guildId The guild ID of the player to destroy.
     * @returns {Promise<void>}
     */
     async destroyPlayer(guildId) {
         const player = this.players.get(guildId);
         if (player) {
             // Player.destroy() handles node communication and cleanup
             await player.destroy();
             // The manager cleanup (_destroyPlayer) is called internally by player.destroy()
         }
    }


    /**
     * Internal method to remove player reference from manager. Called by Player.destroy()
     * @param {string} guildId
     * @private
     */
     _destroyPlayer(guildId) {
         const player = this.players.get(guildId);
         if(player) {
             this.players.delete(guildId);
             this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_DESTROY, player);
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Player reference removed for guild ${guildId}.`);
         }
    }


     /**
      * Finds the most suitable node based on penalty scoring.
      * @returns {Node | undefined} The ideal node or undefined if none available.
      */
    getIdealNode() {
         const availableNodes = [...this.nodes.values()].filter(node => node.connected && node.sessionId);
         if (availableNodes.length === 0) return undefined;

        return availableNodes.reduce((best, node) => {
            if (!best) return node;
            return node.Penalties < best.Penalties ? node : best;
         }, null);
    }

     /**
      * Handles voice state updates from the Discord gateway.
      * @param {object} data The raw voice state update payload.
      * @returns {Promise<void>}
      */
     async handleVoiceStateUpdate(data) {
         // Ignore updates from users other than the bot itself if they don't affect the bot's state directly
        // Or if the update is for a guild we don't have a player for (unless it's a connect event)
        if (!data || !data.guild_id) return; // Basic validation

        const player = this.players.get(data.guild_id);

         // If update is for the bot user, route to player
         if (data.user_id === this.userId) {
             if (player && player.state !== Constants.PLAYER_STATE.DESTROYED) {
                 try {
                     await player._handleVoiceStateUpdate(data);
                 } catch (e) {
                    this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Error handling Voice State for Player ${data.guild_id}: ${e.message}`);
                 }
             } else if(data.channel_id && this.pendingGuilds.has(data.guild_id)){ // Handle case where connect was initiated, player created, but VS came first
                 const pending = this.pendingGuilds.get(data.guild_id);
                 pending?.requests?.forEach(p => p.reject(new Error('Voice state updated before player connection finalized likely via external means.'))); // Reject pending connections? Or just let the player handle? Let player handle for now.
                 this.pendingGuilds.delete(data.guild_id);
                 clearTimeout(pending.timeout);
                  this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Voice State received for pending guild ${data.guild_id} but player instance wasn't ready? Might indicate external state change.`);
            } else {
                // Bot state update for a guild where we have no active player or intent. Could be external disconnect.
                 this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Received voice state update for bot in guild ${data.guild_id} where no active player exists.`);
                 // Potentially ensure Lavalink is cleaned up if voice state shows connected but no player exists? Rare case.
            }
             return;
        }

         // Optional: Handle other users disconnecting from the bot's channel? (e.g., for inactivity checks)
        // if (player && data.channel_id === null && data.guild_id === player.guildId && player.voiceChannelId) {
         //    Check if channel is empty now
        // }
     }


     /**
      * Handles voice server updates from the Discord gateway.
      * @param {object} data The raw voice server update payload.
      * @returns {Promise<void>}
      */
     async handleVoiceServerUpdate(data) {
        if (!data || !data.guild_id) return;

        const player = this.players.get(data.guild_id);
         if (player && player.state !== Constants.PLAYER_STATE.DESTROYED) {
            try {
                await player._handleVoiceServerUpdate(data);
             } catch(e) {
                 this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Error handling Voice Server for Player ${data.guild_id}: ${e.message}`);
             }
         } else if(this.pendingGuilds.has(data.guild_id)){
              const pending = this.pendingGuilds.get(data.guild_id);
              pending?.requests?.forEach(p => p.reject(new Error('Voice server updated before player connection finalized likely via external means.'))); // Reject pending connections?
              this.pendingGuilds.delete(data.guild_id);
              clearTimeout(pending.timeout);
              this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Voice Server received for pending guild ${data.guild_id} but player instance wasn't ready? Might indicate external state change.`);
         }
          else {
              this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Received voice server update for guild ${data.guild_id} where no active player exists.`);
         }
     }


     /**
      * Handles moving players off a disconnected or removed node.
      * @param {Node} disconnectedNode The node that disconnected.
      * @param {boolean} [failedPermanently=false] If true, the node is considered unusable.
      * @private
      */
     async _handleNodeDisconnection(disconnectedNode, failedPermanently = false) {
         const playersToMove = [...this.players.values()].filter(p => p.node === disconnectedNode && p.state !== Constants.PLAYER_STATE.DESTROYED);
        if (playersToMove.length === 0) return;

         this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Node ${disconnectedNode.identifier} disconnected/removed. Attempting to move ${playersToMove.length} players.`);

         let targetNode = !failedPermanently ? this.getIdealNode() : undefined;

        if (!targetNode && !failedPermanently) {
            // Maybe wait a moment for the node to potentially reconnect?
            await new Promise(r => setTimeout(r, disconnectedNode.options.reconnect.initialDelay + 1000));
            targetNode = this.getIdealNode(); // Check again
         }


         if (targetNode) {
             this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Found target node ${targetNode.identifier} for migrating players.`);
             for (const player of playersToMove) {
                if (player.state === Constants.PLAYER_STATE.DESTROYED) continue; // Check again in case player was destroyed during wait
                this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Moving player ${player.guildId}...`);
                try {
                    await player.moveToNode(targetNode);
                    this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Player ${player.guildId} successfully moved.`);
                } catch (moveError) {
                    this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, targetNode, moveError, `Failed during player move for ${player.guildId} after node ${disconnectedNode.identifier} disconnect`);
                     // Player state is likely inconsistent, destroy it
                     try {
                         await player.destroy();
                     } catch(e) {/* Ignore secondary error */}
                }
             }
         } else {
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] No suitable node found to move players from ${disconnectedNode.identifier}. Destroying affected players.`);
            for (const player of playersToMove) {
                 if (player.state === Constants.PLAYER_STATE.DESTROYED) continue;
                 this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Destroying player ${player.guildId} due to node unavailability.`);
                try {
                    // Destroy player, Lavalink state is gone anyway
                     await player.destroy();
                } catch (destroyError) {
                    // Ignore errors during destroy in this cleanup phase
                 }
            }
        }
    }

     /**
      * Load tracks using the best available node.
      * @param {string} identifier Track URL or search query.
      * @param {Player} [requesterPlayer] Optionally specify player to force node choice
      * @returns {Promise<object>} Lavalink /loadtracks response object.
      */
     async loadTracks(identifier, requesterPlayer = null) {
         const node = requesterPlayer?.node?.connected ? requesterPlayer.node : this.getIdealNode();
         if (!node) {
             throw new Error("No available Lavalink nodes to load tracks.");
        }
         try {
             const result = await node.rest.loadTracks(identifier);
            this.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Manager] Loaded tracks for "${identifier.substring(0,50)}..." from node ${node.identifier} (Result: ${result.loadType})`);
             return result;
        } catch(e) {
            this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node, e, `Failed to load tracks: ${identifier}`);
             throw e; // Re-throw error after logging
         }
    }

     /**
      * Decode a single track string.
      * @param {string} encodedTrack The Base64 encoded track string.
      * @param {Player} [requesterPlayer] Optionally specify player to force node choice
      * @returns {Promise<object>} The decoded track info object.
      */
    async decodeTrack(encodedTrack, requesterPlayer = null) {
         const node = requesterPlayer?.node?.connected ? requesterPlayer.node : this.getIdealNode();
         if (!node) {
             throw new Error("No available Lavalink nodes to decode tracks.");
        }
        try {
             return await node.rest.decodeTrack(encodedTrack);
         } catch(e) {
             this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node, e, `Failed to decode track: ${encodedTrack?.substring(0,20)}...`);
            throw e;
         }
    }

    /**
     * Decode multiple track strings.
     * @param {string[]} encodedTracks Array of Base64 encoded track strings.
     * @param {Player} [requesterPlayer] Optionally specify player to force node choice
     * @returns {Promise<object[]>} Array of decoded track info objects.
     */
     async decodeTracks(encodedTracks, requesterPlayer = null) {
         const node = requesterPlayer?.node?.connected ? requesterPlayer.node : this.getIdealNode();
         if (!node) {
            throw new Error("No available Lavalink nodes to decode tracks.");
         }
         try {
             return await node.rest.decodeTracks(encodedTracks);
        } catch(e) {
            this.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node, e, `Failed to decode ${encodedTracks.length} tracks`);
             throw e;
        }
     }
}

module.exports = Manager;
