// src/Player.js
const EventEmitter = require('events');
const Queue = require('./Queue');
const Constants = require('./Constants');

// NEW: Timeout for voice connection attempts
const VOICE_CONNECT_TIMEOUT_MS = 15000; // 15 seconds

class Player extends EventEmitter {
    constructor(manager, node, guildId, options = {}) {
        super();
        this.manager = manager;
        this.node = node; // The Lavalink node this player is currently assigned to
        this.guildId = guildId;
        this.options = { ...Constants.DEFAULT_PLAYER_OPTIONS, ...options };
        this.queue = new Queue();
        this.state = Constants.PLAYER_STATE.INSTANTIATED; // Initial state

        // Voice connection state (Managed by connect/disconnect)
        this.connected = false; // Represents full Bot <-> Discord <-> Lavalink voice connection
        this.voiceChannelId = null;
        this.voiceSessionId = null; // Discord session_id
        this.voiceToken = null;     // Discord voice token
        this.voiceEndpoint = null;  // Discord voice endpoint (hostname only)

        // Playback state (Managed by Lavalink events and commands)
        this.playing = false;
        this.paused = false;
        this.timestamp = null;      // Lavalink timestamp from player update
        this.position = 0;          // Track position in ms from player update
        this._lastPositionUpdate = 0; // Local cache for position getter
        this.volume = this.options.initialVolume; // Initial volume
        this.loop = Constants.LOOP_MODE.NONE;    // Current loop mode

        // Internal state
        this.moving = false; // Flag for node transfers
        this.ping = null;    // Latency from Lavalink to Discord voice server

        // --- NEW Properties for connection promise ---
        this._connectionResolver = null;
        this._connectionRejecter = null;
        this._connectionTimeout = null;
        // --- END NEW ---

        // Register player with its initial node
        this.node._addPlayer(this);

        // Listener to update local position cache more frequently (optional)
        // this.on(Constants.CLIENT_EVENT_TYPES.PLAYER_STATE_UPDATE, this._calculatePosition.bind(this));
    }

    // --- Getters ---
    /** The currently playing track */
    get current() { return this.queue.current; }
    /** Alias for current */
    get playingTrack() { return this.queue.current; }
    /** Whether the player is actively playing audio */
    get isPlaying() { return this.state === Constants.PLAYER_STATE.PLAYING; }
    /** Whether the player is paused */
    get isPaused() { return this.paused; }
    /** Whether the player is connected to Lavalink and Discord voice */
    get isConnected() { return this.connected; }
    /** Estimated current playback position in milliseconds */
    get currentPosition() {
        if (!this.isPlaying || this.paused) return this.position; // Return last known position if not actively playing
        if (!this.timestamp) return 0; // No timestamp yet

        const duration = this.current?.info?.length ?? Infinity;
        // Calculate elapsed time since last Lavalink update + last known position
        const elapsed = Date.now() - this.timestamp;
        const estimatedPosition = this._lastPositionUpdate + elapsed;

        // Ensure position doesn't exceed duration (handles potential drift)
        return Math.min(estimatedPosition, duration);
    }

    /**
     * Connects to a voice channel. Returns a Promise that resolves when
     * the connection is fully established, or rejects on error/timeout.
     * @param {string} channelId The ID of the voice channel to connect to.
     * @returns {Promise<void>}
     * @throws {Error} If already connecting/connected or channel ID is missing.
     */
    connect(channelId) {
        // --- MODIFIED: More robust state checking ---
        if (this.state !== Constants.PLAYER_STATE.INSTANTIATED && this.state !== 'DISCONNECTED' && this.state !== 'CONNECTION_FAILED') {
            return Promise.reject(new Error(`Cannot connect while in state: ${this.state}. Must disconnect or destroy first.`));
        }
         if (!channelId) return Promise.reject(new Error("Channel ID is required to connect."));
         if (!this.manager.userId) return Promise.reject(new Error("Manager userId is not set, cannot send connect payload."));
         // --- END MODIFIED ---


        return new Promise((resolve, reject) => {
             // Prevent simultaneous connection attempts if called rapidly
            if (this._connectionResolver || this._connectionRejecter) {
                return reject(new Error("Connection attempt already in progress."));
            }

            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Initiating connection to channel ${channelId}`);
             this.state = 'CONNECTING'; // --- NEW internal state ---
             this.voiceChannelId = channelId;
             this.voiceSessionId = null; // Clear old state
             this.voiceToken = null;
             this.voiceEndpoint = null;
             this.connected = false; // Not fully connected yet


            // --- Store promise handlers ---
            this._connectionResolver = resolve;
            this._connectionRejecter = reject;

            // --- Set connection timeout ---
            clearTimeout(this._connectionTimeout); // Clear any previous stray timeout
             this._connectionTimeout = setTimeout(() => {
                // Check state again inside timeout in case it resolved/rejected already
                 if (this.state === 'CONNECTING' || this.state === 'WAITING_FOR_SERVER') {
                    this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Voice connection attempt timed out.`);
                     this.state = 'CONNECTION_FAILED'; // Mark as failed
                     this._clearConnectionPromise(new Error(`Voice connection timed out after ${VOICE_CONNECT_TIMEOUT_MS / 1000} seconds.`));
                    // Don't call disconnect here, let the rejection handler in bot code decide
                 }
             }, VOICE_CONNECT_TIMEOUT_MS);

            // --- Send OP 4 ---
             try {
                 this.manager._sendGatewayPayload(this.guildId, {
                    op: 4,
                     d: {
                        guild_id: this.guildId,
                        channel_id: channelId,
                         self_mute: this.options.selfMute,
                         self_deaf: this.options.selfDeaf
                    }
                 });
            } catch (error) {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error sending OP4 payload: ${error.message}`);
                this.state = 'CONNECTION_FAILED';
                 this._clearConnectionPromise(new Error(`Failed to send connect payload to Discord Gateway: ${error.message}`));
             }
         });
    }

    /** Clears connection promise state and calls reject/resolve. @private */
    _clearConnectionPromise(error = null) {
        clearTimeout(this._connectionTimeout);
        this._connectionTimeout = null;
         const resolver = this._connectionResolver;
         const rejecter = this._connectionRejecter;
         this._connectionResolver = null;
         this._connectionRejecter = null;

        if (error && rejecter) {
             rejecter(error);
        } else if (!error && resolver) {
            resolver(); // Resolve void promise
        }
    }

    /**
     * Disconnects from the current voice channel.
     * @param {boolean} [destroy=true] Whether to destroy the player on Lavalink after disconnecting.
     */
    disconnect(destroy = true) {
        // Prevent disconnect loops or disconnecting invalid states
        if (this.state === Constants.PLAYER_STATE.DESTROYED || this.state === Constants.PLAYER_STATE.INSTANTIATED) return;
        if(this.state === 'DISCONNECTING' && !destroy) return; // Already non-destroy disconnect called

        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Disconnecting from channel ${this.voiceChannelId}${destroy ? ' and destroying' : ''}...`);

        // Store states needed before clearing
         const wasConnectedToChannel = !!this.voiceChannelId;
         const oldState = this.state;

        // Reject any pending connection attempt immediately
        if(oldState === 'CONNECTING' || oldState === 'WAITING_FOR_SERVER'){
            this._clearConnectionPromise(new Error("Player disconnected."));
         }

        // Stop playback locally first to prevent further Lavalink events potentially
         // Set playing=false but keep state until after potential destroy call
        this.playing = false;
         this.paused = false;
         // Don't necessarily call full stop() unless destroying, just clear local playback vars
         this.timestamp = null;
         this.position = 0;
        this._lastPositionUpdate = 0;


         // Set final intended state unless destroying (destroy sets its own state)
        if (!destroy) {
            this.state = 'DISCONNECTED';
         }

        // Send OP4 to Discord Gateway to leave the channel only if we were in one or attempting to join
        if (wasConnectedToChannel || oldState === 'CONNECTING' || oldState === 'WAITING_FOR_SERVER') {
             try {
                 this.manager._sendGatewayPayload(this.guildId, {
                     op: 4,
                    d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false }
                 });
             } catch (error) {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error sending OP4 disconnect payload: ${error.message}`);
             }
        }

         // Clear local voice variables AFTER potentially sending disconnect OP4
         this.connected = false; // Reset full connection status
         this.voiceChannelId = null;
         this.voiceSessionId = null;
         this.voiceToken = null;
        this.voiceEndpoint = null;


        // Handle player destruction on Lavalink if requested
        if (destroy) {
             this.destroy().catch(e => {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error during implicit destroy on disconnect: ${e.message}`);
            });
         } else {
             // If just disconnecting, ensure Lavalink is told to stop playback IF it was ever playing/paused
            if (this.node?.sessionId && (oldState === Constants.PLAYER_STATE.PLAYING || oldState === Constants.PLAYER_STATE.PAUSED)) {
                this.node.updatePlayer(this.guildId, { encodedTrack: null })
                 .catch(e => this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error stopping Lavalink player during disconnect: ${e.message}`));
             }
         }
    }

    /**
     * Destroys the player instance and connection on Lavalink. Cleans up all resources.
     * @returns {Promise<void>}
     */
     async destroy() {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) return;
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Destroying player...`);

         const wasTryingToConnect = this.state === 'CONNECTING' || this.state === 'WAITING_FOR_SERVER';
         const wasInChannel = !!this.voiceChannelId;
         this.state = Constants.PLAYER_STATE.DESTROYED; // Set final state immediately

        // Clear any pending connection attempt
        this._clearConnectionPromise(new Error("Player destroyed."));

        // Stop local playback state and clear queue
         this.playing = false;
         this.paused = false;
         this.queue.clear(); // Also clears current track
         this.timestamp = null;
        this.position = 0;


         // Attempt to leave voice channel via OP4 if necessary
        if (wasInChannel || wasTryingToConnect) {
            try {
                this.manager._sendGatewayPayload(this.guildId, {
                     op: 4,
                    d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false }
                 });
             } catch(error){
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error sending OP4 disconnect during destroy: ${error.message}`);
            }
        }

        // Clear local voice variables AFTER potential OP4 send
         this.connected = false;
         this.voiceChannelId = null;
        this.voiceSessionId = null;
         this.voiceToken = null;
         this.voiceEndpoint = null;

         // --- Destroy Player on Lavalink ---
         const currentNode = this.node; // Reference node before cleanup
         try {
             // Only attempt REST destroy if node had a session (i.e., was potentially ready)
            if (currentNode?.sessionId && currentNode?.connected) {
                 await currentNode.destroyPlayer(this.guildId);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Destroy command sent to node ${currentNode.identifier}.`);
             } else {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Skipping Lavalink destroy command (no session ID or node not connected).`);
             }
         } catch (error) {
            // Log error but continue cleanup
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, currentNode, error, `Error sending destroy player command for ${this.guildId}`);
         } finally {
             // --- Final Cleanup ---
             // Remove player from node's map
             currentNode?._removePlayer(this); // Use optional chaining
             // Remove player from manager's map (MUST be last action involving manager)
             this.manager._destroyPlayer(this.guildId);
             // Remove all event listeners specific to this player instance
             this.removeAllListeners();
        }
    }

    /**
     * Plays a track or starts the queue. Auto-plays if queue isn't empty.
     * @param {object | string} [track] The Lavalink track object or encoded string to play. If omitted, starts the queue.
     * @param {object} [options] Play options.
     * @param {number} [options.startTime] Start playback at this position (milliseconds).
     * @param {number} [options.endTime] Stop playback at this position (milliseconds).
     * @param {boolean} [options.noReplace=false] If true, doesn't replace the current track if one is playing. Ignored if nothing is playing.
     * @param {boolean} [options.pause=false] If true, starts the track paused.
     * @returns {Promise<void>}
     * @throws {Error} If player is not connected or node is unavailable.
     */
    async play(track, options = {}) {
         if (!this.connected || this.state === 'DISCONNECTED' || this.state === 'DISCONNECTED_LAVALINK' ) {
            throw new Error(`Player not connected (State: ${this.state}). Cannot play.`);
        }
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
        // Check if node connection is alive
         if (!this.node?.connected || !this.node?.sessionId) {
            throw new Error("Cannot play: Lavalink node is not connected or ready.");
        }


        const { startTime, endTime, noReplace = false, pause = false } = options;

        // Determine the track to play
         let trackToPlay = track;
         if (trackToPlay && typeof trackToPlay === 'object') {
            this.queue.current = trackToPlay; // Explicit track given, set as current immediately
         } else if (!trackToPlay) {
            trackToPlay = this.queue.poll(); // No track given, try to get next from queue
         }

         // Handle empty queue / nothing to play
         if (!trackToPlay) {
             // Only emit queue end if we were previously in a playing/paused/stopped state
             // (not connecting or instantiated)
             if ([Constants.PLAYER_STATE.PLAYING, Constants.PLAYER_STATE.PAUSED, Constants.PLAYER_STATE.STOPPED].includes(this.state)) {
                this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                 // Optionally stop Lavalink player if nothing else to play
                 await this.stop(false); // Stop without clearing queue (it's already empty)
            }
             return; // Nothing to play
        }


         // Prepare payload for Lavalink
        const payload = {
            encodedTrack: typeof trackToPlay === 'string' ? trackToPlay : trackToPlay.encoded,
            volume: this.volume,
            // Only include position/endTime if they are valid numbers
             position: (typeof startTime === 'number' && startTime >= 0) ? startTime : undefined,
            endTime: (typeof endTime === 'number' && endTime > 0) ? endTime : undefined, // endTime must be > 0
             paused: pause,
         };
        // Clean undefined properties Lavalink might reject
         Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);

         // Send the update command to Lavalink via REST
         try {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Sending play request to node ${this.node.identifier}`);
             await this.node.updatePlayer(this.guildId, payload, noReplace && this.playing); // Only apply noReplace if actually playing

             // Update local state partially - rely on TRACK_START for full state update
             this.paused = pause;
             // Do NOT set playing = true or state = PLAYING here. Wait for TRACK_START event.
             // Update timestamp to give an initial guess for currentPosition getter before first update
             this.timestamp = Date.now();
             this._lastPositionUpdate = payload.position ?? 0;

         } catch (error) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, this.queue.current ?? trackToPlay, error);
             // If playing fails, simulate track end to potentially play next
             await this._handleTrackEnd({ reason: 'loadFailed' });
        }
    }

     /**
      * Stops the current playback and optionally clears the queue.
      * @param {boolean} [clearQueue=true] Whether to clear the queue after stopping. Default true.
      * @returns {Promise<void>}
      */
     async stop(clearQueue = true) {
         // Check if already effectively stopped
         if (this.state === Constants.PLAYER_STATE.STOPPED && !this.playing) {
            // If user explicitly wants to clear queue even if stopped, allow it
            if (clearQueue && !this.queue.isEmpty) {
                 this.queue.clear();
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Queue cleared via stop() command.`);
             }
             return;
        }
         if (this.state === Constants.PLAYER_STATE.DESTROYED) return; // Can't stop destroyed player


         // --- Reset local playback state immediately ---
         const previousState = this.state;
         this.playing = false;
         this.paused = false;
         this.timestamp = null;
         this.position = 0;
        this._lastPositionUpdate = 0;
        this.queue.current = null; // Clear the current track pointer


        // --- Set the new state ---
        // Avoid setting state if it's currently DESTROYED
         if (previousState !== Constants.PLAYER_STATE.DESTROYED) {
            this.state = Constants.PLAYER_STATE.STOPPED;
        }

        // --- Clear queue if requested ---
         if (clearQueue) {
             this.queue.clear();
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Queue cleared via stop().`);
         }

        // --- Send update to Lavalink if possible ---
        try {
             // Only send if connected and node has session
            if (this.node && this.node.connected && this.node.sessionId) {
                 // Check if we were actually playing something according to Lavalink before stopping locally
                 // (This check is tricky, safer to just send stop regardless if state wasn't already STOPPED)
                // if (previousState === Constants.PLAYER_STATE.PLAYING || previousState === Constants.PLAYER_STATE.PAUSED) {
                     await this.node.updatePlayer(this.guildId, { encodedTrack: null });
                     this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Stop command sent to Lavalink node.`);
                // }
            } else {
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Playback stopped locally (node not available or no session).`);
            }
        } catch (error) {
             // Log error but local state is already updated
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, error, `Failed to send stop command for player ${this.guildId}`);
         }
    }

    /**
     * Skips the current track and plays the next one in the queue, if any.
     * @returns {Promise<void>}
     */
    async skip() {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
         if (!this.queue.current && this.queue.isEmpty) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Skip called but nothing to skip.`);
             await this.stop(false); // Ensure Lavalink is stopped if queue is empty
            return;
        }
         // Simply call play without a track argument. This will:
         // 1. Trigger queue.poll()
         // 2. Send the 'play' command with the next track (or null if queue becomes empty)
         // 3. Lavalink server will stop the current track and start the new one (generating TrackEnd/TrackStart events)
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Skipping track.`);
        await this.play(); // Let play() handle queue logic and Lavalink interaction
    }

    /**
     * Pauses or resumes the current playback.
     * @param {boolean} [pause=true] Set to true to pause, false to resume. Default true.
     * @returns {Promise<void>}
     * @throws {Error} If player is destroyed, not connected, or not playing (when pausing).
     */
    async pause(pause = true) {
         if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
        if (!this.connected) throw new Error("Player is not connected.");
        if (!this.node?.sessionId) throw new Error("Lavalink node has no active session.");


        // Don't pause if already paused, don't resume if already playing
        if (pause === this.paused) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Already ${this.paused ? 'paused' : 'playing'}. Pause command ignored.`);
             return;
        }

        // Can only pause if actually playing something
         if (pause && !this.playing && this.state !== Constants.PLAYER_STATE.PLAYING) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Cannot pause: not currently playing.`);
             // Optional: throw new Error("Not currently playing.");
             return;
        }

        try {
             // Update Lavalink first
            await this.node.updatePlayer(this.guildId, { paused: pause });
             // Update local state AFTER successful API call
             this.paused = pause;
             // Update state (allow setting PAUSED even if momentarily not PLAYING, e.g. track just ended)
             this.state = pause ? Constants.PLAYER_STATE.PAUSED : (this.playing ? Constants.PLAYER_STATE.PLAYING : Constants.PLAYER_STATE.STOPPED);

            // Refresh local position estimate when pausing/resuming
             this._lastPositionUpdate = this.currentPosition;
             this.timestamp = Date.now();

             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Playback ${pause ? 'paused' : 'resumed'}.`);
        } catch (error) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, error, `Failed to ${pause ? 'pause' : 'resume'} player ${this.guildId}`);
            throw error; // Re-throw error after logging
        }
    }

    /**
     * Resumes the current playback. Shortcut for `pause(false)`.
     * @returns {Promise<void>}
     */
    resume() {
        return this.pause(false);
    }

    /**
     * Seeks to a specific position in the current track.
     * @param {number} position Position in milliseconds.
     * @returns {Promise<void>}
     * @throws {Error} If player is destroyed, not connected, nothing playing, or track not seekable.
     */
    async seek(position) {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
        if (!this.connected) throw new Error("Player is not connected.");
        if (!this.playingTrack || this.state !== Constants.PLAYER_STATE.PLAYING) {
            throw new Error("Not playing anything to seek.");
        }
         if (!this.playingTrack.info.isSeekable) {
             throw new Error("The current track is not seekable.");
        }
         if (typeof position !== 'number' || position < 0) {
             throw new Error("Invalid seek position. Must be a positive number (milliseconds).");
         }
        if (!this.node?.sessionId) throw new Error("Lavalink node has no active session.");


         // Clamp position to track duration
        const targetPosition = Math.min(position, this.playingTrack.info.length || Infinity);

        try {
             // Update Lavalink first
            await this.node.updatePlayer(this.guildId, { position: targetPosition });

            // Update local state AFTER successful API call for immediate feedback
             this.position = targetPosition;
             this._lastPositionUpdate = targetPosition;
            this.timestamp = Date.now(); // Reset timestamp relative to new position

             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Seeked to ${targetPosition}ms.`);
        } catch (error) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, error, `Failed to seek player ${this.guildId} to ${targetPosition}`);
             throw error; // Re-throw
        }
    }

    /**
     * Sets the playback volume.
     * @param {number} volume Volume level (0-1000). Lavalink default is 100. Recommended range often 0-150.
     * @returns {Promise<void>}
     * @throws {Error} If player is destroyed, node has no session, or volume is invalid.
     */
    async setVolume(volume) {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
        if (typeof volume !== 'number' || volume < 0 || volume > 1000) {
            throw new Error("Invalid volume level. Must be between 0 and 1000.");
         }
         if (!this.node?.sessionId) throw new Error("Lavalink node has no active session.");


         // Clamp volume just in case, though validation above should catch it
        const targetVolume = Math.max(0, Math.min(Math.round(volume), 1000));

         if (targetVolume === this.volume) return; // No change needed

        try {
             // Update Lavalink first
            await this.node.updatePlayer(this.guildId, { volume: targetVolume });
             // Update local state AFTER success
            this.volume = targetVolume;
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Volume set to ${targetVolume}.`);
        } catch (error) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, error, `Failed to set volume for player ${this.guildId} to ${targetVolume}`);
            throw error;
         }
    }

    /**
     * Sets the loop mode for the player/queue.
     * @param {Constants.LOOP_MODE} mode Loop mode (NONE, TRACK, QUEUE). Use `Constants.LOOP_MODE`.
     * @throws {Error} If the mode is invalid.
     */
    setLoop(mode) {
         if (mode === undefined || mode < Constants.LOOP_MODE.NONE || mode > Constants.LOOP_MODE.QUEUE) {
             throw new Error(`Invalid loop mode: ${mode}. Use Constants.LOOP_MODE enum (0, 1, or 2).`);
        }
         // Update the queue's loop mode, which controls track polling
        this.queue.setLoop(mode);
        // Update the player's loop property for easy access/state checking
         this.loop = mode;
        const modeName = Object.keys(Constants.LOOP_MODE).find(k => Constants.LOOP_MODE[k] === mode);
         this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Loop mode set to ${modeName} (${mode}).`);
    }

    /**
     * Moves the player to a different Lavalink node. Handles state transfer.
     * @param {Node} targetNode The node to move to. Must be connected and ready.
     * @returns {Promise<void>}
     * @throws {Error} If the move is invalid or fails.
     */
    async moveToNode(targetNode) {
        if (this.moving) throw new Error("Player move already in progress.");
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Cannot move a destroyed player.");
         if (!targetNode || !(targetNode instanceof Node)) throw new Error("Invalid targetNode provided.");
         if (targetNode === this.node) throw new Error("Target node is the same as the current node.");
         if (!targetNode.connected || !targetNode.sessionId) {
            throw new Error(`Target node "${targetNode.identifier}" is not connected or ready.`);
        }

        this.moving = true;
        const oldNode = this.node;
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Moving from Node ${oldNode.identifier} to Node ${targetNode.identifier}...`);

         // Store current state (crucially, use calculated currentPosition)
        const currentTrack = this.playingTrack;
        const stateToRestore = {
             encodedTrack: currentTrack?.encoded,
            position: this.currentPosition, // Use getter for accurate position
             volume: this.volume,
            pause: this.paused, // Restore pause state if applicable
         };
        const currentFilters = this.filters; // If filters were implemented

         try {
            // 1. Destroy player state ONLY on the old Lavalink node
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Destroying player state on old node ${oldNode.identifier}.`);
             // Only destroy on old node if it had a session
             if (oldNode?.sessionId && oldNode?.connected) {
                await oldNode.destroyPlayer(this.guildId);
             } else {
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Skipping destroy on old node (not connected/no session).`);
             }


            // 2. Update internal node reference and register player with new node
            oldNode?._removePlayer(this); // Remove from old node's map
            this.node = targetNode;
             this.node._addPlayer(this); // Add to new node's map


             // 3. Send current voice state to the NEW Lavalink node
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Sending voice state to new node ${targetNode.identifier}.`);
             if (this.voiceSessionId && this.voiceToken && this.voiceEndpoint) {
                 await this._sendVoiceUpdate(); // Resends voice state to the *new* this.node
            } else {
                // If voice state is missing (e.g., after manager restart without full session restore), move might partially fail
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Voice state incomplete during move. Playback might not resume automatically.`);
                 // Consider how to handle this - maybe just warn and continue?
             }

             // 4. Restore playback state on the new node using a PATCH request
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Restoring playback state on new node ${targetNode.identifier}.`);
             // Prepare restore payload, including filters if implemented
             const restorePayload = { ...stateToRestore };
             // if (currentFilters) restorePayload.filters = currentFilters;

            // Clean undefined before sending
            Object.keys(restorePayload).forEach(key => restorePayload[key] === undefined && delete restorePayload[key]);


             if (Object.keys(restorePayload).length > 0) { // Only send patch if there's something to restore
                 await this.node.updatePlayer(this.guildId, restorePayload, false); // Use noReplace=false as it's a fresh state on new node
            }

            // Restore local playing state based on restored state (paused status)
            if(stateToRestore.encodedTrack) {
                 // Only set to playing/paused if a track was actually restored
                 this.playing = true; // Assume playing unless pause was set
                 this.paused = stateToRestore.pause;
                this.state = this.paused ? Constants.PLAYER_STATE.PAUSED : Constants.PLAYER_STATE.PLAYING;
            } else {
                 this.playing = false;
                 this.paused = false;
                this.state = Constants.PLAYER_STATE.STOPPED;
             }
            // Local position/timestamp will sync via PLAYER_UPDATE event from the new node.

             this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_MOVE, this, oldNode, targetNode);
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Successfully moved to node ${targetNode.identifier}.`);

         } catch (error) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, targetNode, error, `Failed to move player ${this.guildId} from ${oldNode?.identifier} to ${targetNode.identifier}`);
            // If move fails, the player state is uncertain. Best practice is to destroy it cleanly.
            try {
                await this.destroy();
             } catch (destroyError) {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error during post-move-failure cleanup: ${destroyError.message}`);
             }
             // Re-throw the original error that caused the move failure
             throw error;
        } finally {
             this.moving = false;
        }
    }


    // --- Internal Handlers (_updateState, _calculatePosition, _handleVoiceStateUpdate, _handleVoiceServerUpdate, _sendVoiceUpdate, _handleEvent, _handleTrackEnd) ---
    // (Implementations from the previous corrected version, ensuring state checks and promise logic)
     _updateState(state) {
         if (this.state === Constants.PLAYER_STATE.DESTROYED) return;

         this.timestamp = state.time ?? this.timestamp; // Use known time from Lavalink
         const oldPosition = this.position;
         this.position = state.position ?? 0; // Use known position from Lavalink
         this._lastPositionUpdate = this.position; // Cache the actual last known position

         const wasConnected = this.connected;
         this.connected = state.connected;

         if (wasConnected && !this.connected) {
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Lavalink reports Discord voice connection closed.`);
             // If Lavalink says we are disconnected, update internal state
             if(this.state !== Constants.PLAYER_STATE.DESTROYED && this.state !== 'DISCONNECTING'){
                 this.state = 'DISCONNECTED_LAVALINK'; // Specific state
             }
         } else if (!wasConnected && this.connected && this.state === 'WAITING_FOR_SERVER') {
             // Sometimes the first playerUpdate confirms full connection before voice state CB resolves?
             this.state = Constants.PLAYER_STATE.STOPPED;
             this._clearConnectionPromise(); // Ensure promise is resolved if player update comes first
         }


         this.ping = state.ping ?? this.ping;

         // Emit event for consumers
         this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_STATE_UPDATE, this, state);
         this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_STATE_UPDATE, this, state);
     }

     _calculatePosition(state = null){ // Keep simple unless needed later
        if(state?.position !== undefined) this.position = state.position;
        if(state?.time !== undefined) this.timestamp = state.time;
     }

    async _handleVoiceStateUpdate(data) {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) return;
         // We only care about updates for our bot in our target guild
        if (data.user_id !== this.manager.userId || data.guild_id !== this.guildId) return;

        // Bot disconnected externally or manually
        if (data.channel_id === null) {
            if (this.state !== 'DISCONNECTING' && this.state !== Constants.PLAYER_STATE.DESTROYED) {
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Voice state indicates external disconnection. Cleaning up.`);
                this._clearConnectionPromise(new Error("Disconnected externally during connection.")); // Reject if connecting
                 this.disconnect(true); // Destroy the player instance
             }
            return;
        }

        // If we are in the process of connecting...
        if (this.state === 'CONNECTING') {
            // Check if this VSU matches the channel we are trying to connect to
            if (data.channel_id === this.voiceChannelId) {
                 this.voiceSessionId = data.session_id;
                 this.state = 'WAITING_FOR_SERVER'; // Now wait for the server update
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Received Voice State Update (Session: ${this.voiceSessionId}). State -> WAITING_FOR_SERVER.`);
            } else {
                 // VSU received for a *different* channel while trying to connect? Error condition.
                 this._clearConnectionPromise(new Error(`Received voice state for unexpected channel ${data.channel_id} while connecting to ${this.voiceChannelId}.`));
                this.disconnect(true); // Cleanup
            }
        } else {
            // If we are already connected or in another state, update session ID if it changes
             // (e.g., Discord region change might cause this)
             if (data.session_id && data.session_id !== this.voiceSessionId && this.connected) {
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Voice Session ID changed. Updating...`);
                 this.voiceSessionId = data.session_id;
                 // Send updated voice state to Lavalink immediately if endpoint/token are still known
                 if(this.voiceToken && this.voiceEndpoint) {
                    this._sendVoiceUpdate().catch(err => {
                         this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Failed to send voice update after session change: ${err.message}. May disconnect.`);
                        this.disconnect(true); // Disconnect if update fails
                    });
                 }
            }
        }
    }


     async _handleVoiceServerUpdate(data) {
        // Ignore if destroyed or not waiting for this specific update
        if (this.state !== 'WAITING_FOR_SERVER') return;
        if (data.guild_id !== this.guildId) return;

        // Ensure token and endpoint are present
         if (!data.token || !data.endpoint) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Received invalid Voice Server Update (missing token/endpoint). Failing connection.`);
             this._clearConnectionPromise(new Error("Received incomplete voice server update from Discord."));
             // Attempt cleanup - important as OP4 was likely sent
            this.disconnect(true);
             return;
        }


        this.voiceToken = data.token;
         // Standardize endpoint (remove port, protocol)
        this.voiceEndpoint = data.endpoint.replace(/(:\d+)?$/, '').replace(/^wss?:\/\//, '');


        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Received Voice Server Update (Endpoint: ${this.voiceEndpoint}). Sending voice update to Lavalink.`);

        try {
             // --- Send the validated voice details to Lavalink ---
             await this._sendVoiceUpdate();
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Voice update sent successfully to Lavalink.`);

             // --- Connection is now fully established ---
             this.connected = true;
             // Set initial state AFTER connection success
             this.state = Constants.PLAYER_STATE.STOPPED;
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Connection successful. State -> STOPPED.`);
             this._clearConnectionPromise(); // Resolve the connection promise

         } catch (err) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error sending voice update to Lavalink during connection: ${err.message}. Failing connection.`);
            this.state = 'CONNECTION_FAILED';
             this._clearConnectionPromise(err); // Reject the promise with the error
             // Attempt cleanup
             this.disconnect(true);
         }
    }

     _sendVoiceUpdate() {
        // Add more rigorous checks here
        if (this.state === Constants.PLAYER_STATE.DESTROYED) {
             return Promise.reject(new Error("Cannot send voice update: Player is destroyed."));
        }
        if (!this.voiceSessionId || !this.voiceToken || !this.voiceEndpoint) {
            return Promise.reject(new Error("Cannot send voice update: Missing required voice state components (session, token, or endpoint)."));
        }
        if (!this.node || !this.node.connected || !this.node.sessionId) {
            return Promise.reject(new Error("Cannot send voice update: Lavalink node is not ready."));
        }


        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Sending voice payload (token/endpoint/session) to Lavalink node ${this.node.identifier}.`);
        return this.node.updatePlayer(this.guildId, {
             voice: {
                token: this.voiceToken,
                endpoint: this.voiceEndpoint, // Lavalink usually wants hostname only
                sessionId: this.voiceSessionId
            }
        }).catch(err => {
            // Catch errors sending the voice update specifically
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, err, `Failed crucial voice update for player ${this.guildId}. Player may disconnect or malfunction.`);
             // Depending on the error, consider disconnecting the player
             // If Lavalink rejects the voice update, the player won't work
             // Example: Check for 4xx errors if possible, or just disconnect on any error here
             // this.disconnect(true);
             throw err; // Re-throw after logging
         });
     }

    async _handleEvent(payload) {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) return;

        const previousTrack = this.queue.current; // Get before potentially changing

        switch (payload.type) {
            case Constants.LAVA_EVENT_TYPES.TRACK_START:
                this.playing = true;
                this.paused = false;
                this.state = Constants.PLAYER_STATE.PLAYING;
                this.timestamp = Date.now(); // Set timestamp relative to event receive time
                this._lastPositionUpdate = 0; // Position starts at 0

                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_START, this, this.queue.current);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_START, this, this.queue.current);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Event: TrackStart (${this.queue.current?.info?.title})`);
                break;

            case Constants.LAVA_EVENT_TYPES.TRACK_END:
                 this.playing = false;
                // Don't reset timestamp/position if replaced, as a new track is starting immediately
                 if (payload.reason !== 'replaced') {
                     this.timestamp = null;
                    this.position = 0;
                     this._lastPositionUpdate = 0;
                     // Only set state to stopped if not already being destroyed or disconnected
                     if (this.state !== Constants.PLAYER_STATE.DESTROYED && this.state !== 'DISCONNECTING' && this.state !== 'DISCONNECTED_LAVALINK') {
                        this.state = Constants.PLAYER_STATE.STOPPED;
                     }
                 }

                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_END, this, previousTrack, payload);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_END, this, previousTrack, payload);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Event: TrackEnd (${previousTrack?.info?.title || 'Unknown Track'}, Reason: ${payload.reason})`);

                // Process queue/looping logic only if the player hasn't been destroyed in the meantime
                 if (this.state !== Constants.PLAYER_STATE.DESTROYED) {
                     this._handleTrackEnd(payload);
                }
                break;

             case Constants.LAVA_EVENT_TYPES.TRACK_EXCEPTION:
                // Consider playback stopped on exception
                 this.playing = false;
                 this.paused = false; // Ensure not paused
                this.timestamp = null;
                this.position = 0;
                 this._lastPositionUpdate = 0;
                 if (this.state !== Constants.PLAYER_STATE.DESTROYED) { // Avoid setting state on destroyed player
                    this.state = Constants.PLAYER_STATE.STOPPED;
                }


                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, previousTrack, payload);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, previousTrack, payload.exception);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Event: TrackException (${previousTrack?.info?.title}, Message: ${payload.exception.message}, Severity: ${payload.exception?.severity})`);

                // --- Refined Fault Handling ---
                 if (payload.exception?.severity?.toLowerCase() === "fault") {
                    this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, new Error(`Track Fault: ${payload.exception.message}`), `Player ${this.guildId}`);
                     // Critical playback failure - Likely unrecoverable for this player state. Destroy.
                     this.disconnect(true); // Destroy and cleanup
                } else {
                     // For COMMON or SUSPICIOUS, attempt to play the next track
                     this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Attempting next track after non-fault exception.`);
                     if (this.state !== Constants.PLAYER_STATE.DESTROYED) {
                         this._handleTrackEnd(payload); // Treat as end to process queue
                    }
                 }
                break;

             case Constants.LAVA_EVENT_TYPES.TRACK_STUCK:
                this.playing = false; // Considered stalled
                 if (this.state !== Constants.PLAYER_STATE.DESTROYED) { // Avoid setting state on destroyed player
                     this.state = Constants.PLAYER_STATE.STOPPED;
                 }

                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_STUCK, this, previousTrack, payload);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_STUCK, this, previousTrack, payload.thresholdMs);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Event: TrackStuck (${previousTrack?.info?.title}, Threshold: ${payload.thresholdMs}ms)`);

                 // Treat stuck track as end for queue processing if not destroyed
                 if (this.state !== Constants.PLAYER_STATE.DESTROYED) {
                     this._handleTrackEnd(payload);
                 }
                 break;

             case Constants.LAVA_EVENT_TYPES.WEBSOCKET_CLOSED:
                // This is the Lavalink <-> Discord voice websocket
                this.connected = false; // Mark internal state as disconnected from voice
                 if (this.state !== Constants.PLAYER_STATE.DESTROYED) { // Avoid setting state on destroyed player
                     this.state = 'DISCONNECTED_LAVALINK'; // Specific state
                 }

                this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, this, payload);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, this, payload);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, this.node, new Error(`Discord WebSocket closed for player ${this.guildId}. Code: ${payload.code}, Reason: ${payload.reason}, By Remote: ${payload.byRemote}`));

                // Often needs intervention (reconnect bot to VC). Disconnecting player might be safest.
                 // Avoid trying to automatically reconnect here, as bot state in Discord needs checking.
                 // If the close code indicates a fatal issue or unexpected closure, destroy the player.
                 const recoverableCodes = [1000, 1001, 1006, 4006, 4014]; // Normal close, Going away, Abnormal close, Session timeout, Disconnected (by user/kick?)
                 if (!recoverableCodes.includes(payload.code) && this.state !== Constants.PLAYER_STATE.DESTROYED) {
                     this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Destroying player due to unrecoverable Discord WS close code: ${payload.code}`);
                    this.disconnect(true); // Destroy fully
                 }
                break;

             default:
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Received unknown event type: ${payload.type}`);
         }
    }

     _handleTrackEnd(payload) {
        // Stop processing if player got destroyed during event handling
        if (this.state === Constants.PLAYER_STATE.DESTROYED) return;

         // Handle looping FIRST
         if (this.loop === Constants.LOOP_MODE.TRACK && payload.reason !== 'replaced' && payload.reason !== 'stopped' && payload.reason !== 'loadFailed') {
            const trackToReplay = this.queue.current ?? this.queue.history[0]; // Use current if available (robust queue adds to history)
             if (trackToReplay) {
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Replaying track due to TRACK loop.`);
                // Check if still connected before replaying
                 if (this.connected) {
                    this.play(trackToReplay) // No options needed usually for replay
                        .catch(e => this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error replaying track: ${e.message}`));
                 }
                return; // Don't process queue further
             }
         }

         // Don't automatically play next if stopped by user or replaced by new play command
        if (payload.reason === 'stopped' || payload.reason === 'replaced') {
            // If stopped/replaced AND the queue is now empty, signal queue end for logic handlers
             if (!this.queue.current && this.queue.isEmpty) {
                this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
             }
            return; // Stop processing
         }

         // Handle queue looping (applies to finished, loadFailed, exception, stuck)
         if (this.loop === Constants.LOOP_MODE.QUEUE) {
             const nextTrack = this.queue.poll(); // Queue handles re-adding current track to end
            if (nextTrack) {
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Playing next track due to QUEUE loop.`);
                 if (this.connected) {
                     this.play(nextTrack)
                         .catch(e => this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error playing next looped track: ${e.message}`));
                }
             } else {
                 // Queue is empty even with loop (should only happen if queue was initially empty and never added to)
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Queue loop active but queue is empty.`);
                 this.queue.current = null; // Ensure current is null
                this.playing = false;
                this.state = Constants.PLAYER_STATE.STOPPED; // Should already be stopped
                 this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                 // Ensure Lavalink is told to stop explicitly
                 if (this.connected) {
                    this.stop(false).catch(() => {}); // Stop without clearing (it's empty), ignore errors here
                 }
             }
             return; // Stop processing
        }


         // Default behavior: Play next track from queue if no looping applies
         const nextTrack = this.queue.poll();
         if (nextTrack) {
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Playing next track from queue.`);
             if (this.connected) {
                this.play(nextTrack)
                     .catch(e => this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Error playing next track: ${e.message}`));
            }
         } else {
             // Queue is now genuinely empty
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player ${this.guildId}] Queue finished.`);
             this.queue.current = null;
             this.playing = false;
             // State should already be STOPPED from TRACK_END handler
            this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
             // Ensure Lavalink is told to stop explicitly if we ended up here
             if (this.connected && this.state !== Constants.PLAYER_STATE.PLAYING) {
                this.stop(false).catch(() => {}); // Stop without clearing, ignore errors here
            }
         }
    }


}

module.exports = Player;
