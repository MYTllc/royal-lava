// src/Player.js
const EventEmitter = require('events');
// Assume Queue supports: add, poll, clear, removeAt, insertAt, shuffle, setLoop, get entries(), get history(), get current, get size, get isEmpty, get loop
const Queue = require('./Queue');
// Assume Constants includes: PLAYER_STATE, LOOP_MODE, DEFAULT_PLAYER_OPTIONS, CLIENT_EVENT_TYPES, LAVA_EVENT_TYPES, etc.
const Constants = require('./Constants');
// Assume you might have a Track utility or class for richer track objects
// const TrackUtils = require('./TrackUtils'); // Example

// Timeout for voice connection attempts
const VOICE_CONNECT_TIMEOUT_MS = 20000; // Increased to 20 seconds for robustness
const DEFAULT_FILTER_DATA = { // Define default filter values (all off)
    volume: 1.0, // Separate from player volume, part of Lavalink filter chain
    equalizer: null, // Array of { band: number, gain: number }
    karaoke: null, // { level?: number, monoLevel?: number, filterBand?: number, filterWidth?: number }
    timescale: null, // { speed?: number, pitch?: number, rate?: number }
    tremolo: null, // { frequency?: number, depth?: number }
    vibrato: null, // { frequency?: number, depth?: number }
    rotation: null, // { rotationHz?: number }
    distortion: null, // { sinOffset?: number, sinScale?: number, cosOffset?: number, cosScale?: number, tanOffset?: number, tanScale?: number, offset?: number, scale?: number }
    channelMix: null, // { leftToLeft?: number, leftToRight?: number, rightToLeft?: number, rightToRight?: number }
    lowPass: null, // { smoothing?: number }
    // pluginFilters: {} // For Lavalink v4 plugins if used
};

/**
 * Represents a Guild Player, managing voice connection, playback, queue, and filters.
 * Emits various events related to player state, track playback, and errors.
 * @extends EventEmitter
 */
class Player extends EventEmitter {
    /**
     * Creates a Player instance.
     * @param {Manager} manager - The Lavalink manager instance.
     * @param {Node} node - The Lavalink node this player is assigned to.
     * @param {string} guildId - The ID of the guild this player belongs to.
     * @param {object} [options={}] - Player options.
     * @param {boolean} [options.selfDeaf=true] - Whether the bot should join deafened.
     * @param {boolean} [options.selfMute=false] - Whether the bot should join muted.
     * @param {number} [options.initialVolume=100] - Initial volume (0-1000).
     * @param {Queue} [options.queue] - An existing Queue instance to use.
     */
    constructor(manager, node, guildId, options = {}) {
        super();
        if (!manager) throw new Error("Manager instance is required.");
        if (!node) throw new Error("Node instance is required.");
        if (!guildId) throw new Error("Guild ID is required.");

        this.manager = manager;
        this.node = node; // The Lavalink node this player is *currently* assigned to
        this.guildId = guildId;
        this.options = { ...Constants.DEFAULT_PLAYER_OPTIONS, ...options };
        // Use provided queue or create a new one
        this.queue = options.queue instanceof Queue ? options.queue : new Queue();
        this.state = Constants.PLAYER_STATE.INSTANTIATED; // Initial state

        // --- Voice Connection State ---
        this.connected = false; // Represents full Bot <-> Discord <-> Lavalink voice connection established
        this.voiceChannelId = null;
        this.voiceSessionId = null; // Discord session_id
        this.voiceToken = null;     // Discord voice token
        this.voiceEndpoint = null;  // Discord voice endpoint (hostname only)

        // --- Playback State ---
        this.playing = false; // Actively sending audio data (set by TRACK_START, unset by TRACK_END/STOP/etc)
        this.paused = false; // Playback paused state (set by pause(), unset by resume() or stop())
        this.timestamp = null;      // Lavalink server timestamp from last player update event (ms)
        this.position = 0;          // Last known track position from Lavalink (ms)
        this._lastPositionUpdateTimestamp = 0; // Local timestamp when 'position' was last updated
        this.volume = Math.max(0, Math.min(Math.round(this.options.initialVolume), 1000)); // Initial volume, clamped
        this.loop = this.queue.loop || Constants.LOOP_MODE.NONE; // Sync with queue's loop mode

        // --- Filters State ---
        this.filters = JSON.parse(JSON.stringify(DEFAULT_FILTER_DATA)); // Deep clone default filters

        // --- Internal State ---
        this.moving = false; // Flag to prevent conflicts during node transfers
        this.ping = -1;      // Latency from Lavalink to Discord voice server (ms), -1 if unknown
        this._connectionResolver = null; // Promise handlers for connect()
        this._connectionRejecter = null;
        this._connectionTimeout = null;
        this._disconnecting = false; // Flag to avoid redundant disconnect logic

        // --- Auto-Replay Feature (Optional) ---
        // this.autoReplay = options.autoReplay ?? false; // Replay track on certain errors (configurable)

        // --- Safety Checks ---
        this.setMaxListeners(50); // Increase max listeners to prevent warnings for many events

        // Register player with its initial node
        this.node._addPlayer(this);

        this._debugLog(`Player instantiated for Guild ${this.guildId} on Node ${this.node.identifier}`);
    }

    // --- Getters ---
    /** The currently playing track object, or null if nothing is playing. */
    get current() { return this.queue.current; }
    /** Alias for `current`. */
    get playingTrack() { return this.queue.current; }
    /** The current state of the player (e.g., PLAYING, PAUSED, CONNECTING). See `Constants.PLAYER_STATE`. */
    get currentState() { return this.state; }
    /** Whether the player is fully connected to voice and Lavalink. */
    get isConnected() { return this.connected && this.state !== 'DISCONNECTED' && this.state !== 'CONNECTION_FAILED' && this.state !== 'DISCONNECTED_LAVALINK'; }
    /** Whether the player is actively playing and not paused. */
    get isPlaying() { return this.state === Constants.PLAYER_STATE.PLAYING && this.playing && !this.paused; }
    /** Whether the player is currently paused. */
    get isPaused() { return this.paused && this.state !== Constants.PLAYER_STATE.STOPPED; }
    /** Estimated current playback position in milliseconds, accounting for elapsed time since last update. */
    get currentPosition() {
        if (!this.playing || this.state !== Constants.PLAYER_STATE.PLAYING) return this.position; // Return last known Lavalink position if not playing
        if (this.paused) return this.position; // Return exact position when paused
        if (!this.timestamp || this._lastPositionUpdateTimestamp === 0) return this.position; // Return Lavalink position if no update received yet

        const currentTrackDuration = this.current?.info?.length ?? Infinity;
        const elapsed = Date.now() - this._lastPositionUpdateTimestamp;
        const estimatedPosition = this.position + elapsed;

        // Ensure position doesn't exceed duration and isn't negative
        return Math.max(0, Math.min(estimatedPosition, currentTrackDuration));
    }
    /** The current volume level (0-1000). */
    get currentVolume() { return this.volume; }
    /** The current loop mode (NONE, TRACK, QUEUE). */
    get currentLoopMode() { return this.loop; }
    /** Check if the queue is empty (excluding the currently playing track). */
    get isQueueEmpty() { return this.queue.isEmpty; }
    /** Get the current size of the queue (excluding the currently playing track). */
    get queueSize() { return this.queue.size; }
    /** Get the full queue including the current track. */
    get fullQueue() {
        const q = this.queue.entries();
        if (this.current) {
            return [this.current, ...q];
        }
        return q;
    }

    /**
     * Connects to a voice channel.
     * @param {string} channelId The ID of the voice channel to connect to.
     * @returns {Promise<void>} Resolves when fully connected, rejects on error or timeout.
     * @throws {Error} If already connected/connecting, channel ID is missing, or manager has no userId.
     */
    connect(channelId) {
        this._debugLog(`Attempting connection to channel ${channelId}... Current state: ${this.state}`);

        // --- Robust State Checking ---
        if (this.state !== Constants.PLAYER_STATE.INSTANTIATED && this.state !== 'DISCONNECTED' && this.state !== 'CONNECTION_FAILED' && this.state !== 'DISCONNECTED_LAVALINK') {
             this._emitError(new Error(`Cannot connect while in state: ${this.state}. Must disconnect or destroy first.`));
            return Promise.reject(new Error(`Cannot connect while in state: ${this.state}. Must disconnect or destroy first.`));
        }
        if (!channelId) {
             this._emitError(new Error("Channel ID is required to connect."));
            return Promise.reject(new Error("Channel ID is required to connect."));
        }
        if (!this.manager.userId) {
            this._emitError(new Error("Manager userId is not set. Cannot send connect payload."));
            return Promise.reject(new Error("Manager userId is not set, cannot send connect payload."));
        }
        if (this._connectionResolver || this._connectionRejecter) {
            this._emitWarn("Connection attempt already in progress.");
            return Promise.reject(new Error("Connection attempt already in progress."));
        }
        // --- End State Checking ---

        return new Promise((resolve, reject) => {
            this._debugLog(`Initiating connection sequence to ${channelId}.`);
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
            this._clearConnectionTimeout(); // Clear any previous stray timeout
            this._connectionTimeout = setTimeout(() => {
                // Check state again inside timeout
                if (this.state === 'CONNECTING' || this.state === 'WAITING_FOR_SERVER') {
                     this._debugLog(`Voice connection attempt timed out after ${VOICE_CONNECT_TIMEOUT_MS / 1000}s.`);
                    this.state = 'CONNECTION_FAILED';
                    const timeoutError = new Error(`Voice connection timed out after ${VOICE_CONNECT_TIMEOUT_MS / 1000} seconds.`);
                     this._clearConnectionPromise(timeoutError); // Reject the promise
                    // Clean up attempt after timeout
                     this.disconnect(true).catch(e => this._debugLog(`Error during cleanup after connection timeout: ${e.message}`));
                }
            }, VOICE_CONNECT_TIMEOUT_MS);

            // --- Send OP 4 to Discord Gateway ---
            this._debugLog(`Sending OP4 (Voice State Update) to Discord Gateway.`);
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
                this._debugLog(`Error sending OP4 payload: ${error.message}`);
                this.state = 'CONNECTION_FAILED';
                 this._clearConnectionPromise(new Error(`Failed to send connect payload to Discord Gateway: ${error.message}`));
                // No need to call disconnect here as OP4 failed, state is cleaned implicitly
            }
        });
    }

    /** Clears connection timeout. @private */
    _clearConnectionTimeout() {
         clearTimeout(this._connectionTimeout);
         this._connectionTimeout = null;
     }

    /** Clears connection promise state and calls reject/resolve. @private */
    _clearConnectionPromise(error = null) {
        this._clearConnectionTimeout(); // Always clear timeout
        const resolver = this._connectionResolver;
        const rejecter = this._connectionRejecter;
        this._connectionResolver = null;
        this._connectionRejecter = null;

        if (error && rejecter) {
             this._emitError(error, "Connection Failed");
            rejecter(error);
        } else if (!error && resolver) {
            resolver(); // Resolve void promise
        }
    }

    /**
     * Disconnects from the current voice channel and optionally destroys the player.
     * @param {boolean} [destroy=false] Whether to destroy the player on Lavalink after disconnecting. Set to `true` for full cleanup.
     * @returns {Promise<void>}
     */
    async disconnect(destroy = false) {
        // Prevent disconnect loops or disconnecting invalid states
         if (this._disconnecting || this.state === Constants.PLAYER_STATE.DESTROYED || this.state === Constants.PLAYER_STATE.INSTANTIATED) {
             this._debugLog(`Disconnect called but already disconnecting, destroyed, or instantiated. State: ${this.state}. Ignoring.`);
            return;
         }

         this._disconnecting = true; // Set flag
         const wasConnectedToChannel = !!this.voiceChannelId;
         const oldState = this.state;
        this._debugLog(`Disconnecting from channel ${this.voiceChannelId}${destroy ? ' and destroying player' : ''}... Old state: ${oldState}`);

        // Stop local playback immediately if playing/paused
        if (this.isPlaying || this.isPaused) {
            await this.stop(false); // Stop playback but don't clear queue yet if not destroying
        }

        // Reset playback variables
        this.playing = false;
        this.paused = false;
        this.timestamp = null;
        this.position = 0;
        this._lastPositionUpdateTimestamp = 0;

        // If a connection attempt was in progress, reject it.
        if (oldState === 'CONNECTING' || oldState === 'WAITING_FOR_SERVER') {
            this._clearConnectionPromise(new Error("Player disconnected."));
        }

        // Set intermediate/final state unless destroying (destroy sets its own final state)
        if (!destroy) {
            this.state = 'DISCONNECTED';
        }

        // Send OP4 to Discord Gateway to leave the channel
        if (wasConnectedToChannel || oldState === 'CONNECTING' || oldState === 'WAITING_FOR_SERVER') {
             this._debugLog(`Sending OP4 (disconnect) to Discord Gateway.`);
            try {
                this.manager._sendGatewayPayload(this.guildId, {
                    op: 4,
                    d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false }
                });
            } catch (error) {
                // Log error, but continue cleanup as Discord state might be inconsistent
                this._emitWarn(`Error sending OP4 disconnect payload: ${error.message}`);
            }
        }

        // Clear local voice variables *after* potentially sending disconnect OP4
        this.connected = false;
        this.voiceChannelId = null;
        this.voiceSessionId = null;
        this.voiceToken = null;
        this.voiceEndpoint = null;

        // Stop Lavalink player explicitly if we were connected via Lavalink, unless destroying
         if (!destroy && this.node?.sessionId && (oldState === Constants.PLAYER_STATE.PLAYING || oldState === Constants.PLAYER_STATE.PAUSED || oldState === Constants.PLAYER_STATE.STOPPED || oldState === 'DISCONNECTED_LAVALINK') && this.node?.connected) {
            try {
                 this._debugLog(`Sending explicit stop command to Lavalink node ${this.node.identifier} during disconnect.`);
                 await this.node.updatePlayer(this.guildId, { encodedTrack: null });
             } catch (e) {
                 this._emitWarn(`Error stopping Lavalink player during disconnect: ${e.message}`);
             }
         }

        this._disconnecting = false; // Clear flag

        // Handle player destruction on Lavalink if requested
        if (destroy) {
            await this.destroy().catch(e => {
                 this._emitError(e, `Error during implicit destroy on disconnect`);
            });
        } else {
             this._debugLog(`Disconnected from voice. Player remains instantiated.`);
            this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_DISCONNECT, this, { destroyed: false });
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_DISCONNECT, this, { destroyed: false });
         }
    }

    /**
     * Destroys the player instance completely: disconnects, clears queue, removes from Lavalink, and cleans up resources.
     * @returns {Promise<void>}
     */
    async destroy() {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) {
             this._debugLog(`Destroy called but already destroyed. Ignoring.`);
             return;
         }
         this._debugLog(`Destroying player... Current state: ${this.state}`);

        const wasTryingToConnect = this.state === 'CONNECTING' || this.state === 'WAITING_FOR_SERVER';
        const wasInChannel = !!this.voiceChannelId;
        const oldState = this.state;
        this.state = Constants.PLAYER_STATE.DESTROYED; // Set final state immediately

        // Clear any pending connection attempt
        this._clearConnectionPromise(new Error("Player destroyed."));

        // Stop local playback state and clear queue entirely
        this.playing = false;
        this.paused = false;
        this.queue.clear(); // Also clears current track
        this.timestamp = null;
        this.position = 0;
        this._lastPositionUpdateTimestamp = 0;

        // Disconnect from voice if needed
        if (wasInChannel || wasTryingToConnect) {
             this._debugLog(`Sending OP4 (disconnect) during destroy.`);
             try {
                this.manager._sendGatewayPayload(this.guildId, {
                    op: 4,
                    d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false }
                });
            } catch (error) {
                 this._emitWarn(`Error sending OP4 disconnect during destroy: ${error.message}`);
            }
        }

        // Clear local voice variables
        this.connected = false;
        this.voiceChannelId = null;
        this.voiceSessionId = null;
        this.voiceToken = null;
        this.voiceEndpoint = null;

        // --- Destroy Player on Lavalink Node ---
        const currentNode = this.node; // Reference node before cleanup
        try {
            // Only attempt REST destroy if node had a session and is likely connected
             if (currentNode?.sessionId && currentNode?.connected) {
                this._debugLog(`Sending destroy command to Lavalink node ${currentNode.identifier}.`);
                await currentNode.destroyPlayer(this.guildId);
            } else {
                 this._debugLog(`Skipping Lavalink destroy command (Node ${currentNode?.identifier} no session ID or not connected).`);
            }
        } catch (error) {
            // Log error but continue cleanup, as player needs to be removed from manager regardless
            this._emitNodeError(currentNode, error, `Error sending destroy player command`);
        } finally {
            // --- Final Resource Cleanup ---
             this._debugLog(`Performing final cleanup.`);
            // Remove player from node's internal map
             currentNode?._removePlayer(this);
             // Detach from the node
             this.node = null; // Crucial to prevent further interaction attempts
            // Remove player from manager's map (MUST be last action involving manager)
            this.manager._destroyPlayer(this.guildId);
            // Remove all event listeners specific to this player instance
            this.removeAllListeners();
             this._debugLog(`Player destroyed successfully.`);
             // Emit destroy event AFTER cleanup
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_DESTROY, this); // Manager level event
         }
    }


    // --- Queue Management Commands ---

    /**
     * Adds a track or multiple tracks to the end of the queue.
     * If nothing is playing and the queue was empty, it will start playing the first added track.
     * @param {Track | string | Array<Track | string>} trackOrTracks - A single track object/encoded string, or an array of them.
     * @param {User} [requester=null] - The user who requested the track(s) (for storing metadata).
     * @returns {Promise<void>}
     * @throws {Error} If player is destroyed.
     */
    async add(trackOrTracks, requester = null) {
         if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");

         const tracks = Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks];
         if (tracks.length === 0) return;

         // Add requester info if available (assuming Track objects can store it)
         const tracksToAdd = tracks.map(t => {
             if (typeof t === 'object' && t.info && requester) {
                 t.requester = requester; // Add requester to track metadata
             } else if (typeof t === 'object' && !t.requester) {
                 t.requester = null; // Ensure property exists maybe
             }
            return t;
         });

        this.queue.add(...tracksToAdd);
         this._debugLog(`Added ${tracksToAdd.length} track(s) to the queue. New size: ${this.queueSize}`);
        this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_ADD, this, tracksToAdd);
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_ADD, this, tracksToAdd);

        // If not currently playing anything and connected, start playback.
        if (this.isConnected && !this.playing && !this.current) {
             this._debugLog(`Queue was empty and player idle, starting playback automatically.`);
            await this.play().catch(e => this._emitError(e, "Failed to auto-play after adding track(s)"));
        }
    }

    /**
     * Removes a track from the queue at the specified index.
     * @param {number} index - The 0-based index of the track to remove.
     * @returns {Track | null} The removed track object, or null if index was invalid.
     * @throws {Error} If player is destroyed.
     */
    remove(index) {
         if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
        if (typeof index !== 'number' || index < 0 || index >= this.queue.size) {
             this._emitWarn(`Invalid index ${index} for removal. Queue size: ${this.queue.size}`);
            return null;
        }

        const removedTrack = this.queue.removeAt(index);
        if (removedTrack) {
             this._debugLog(`Removed track at index ${index}: ${removedTrack?.info?.title}`);
             this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_REMOVE, this, removedTrack, index);
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_REMOVE, this, removedTrack, index);
             return removedTrack;
        }
        return null;
    }

     /**
      * Jumps to a specific track in the queue, clearing tracks before it. Starts playing it immediately.
      * @param {number} index - The 0-based index in the queue to jump to.
      * @returns {Promise<void>}
      * @throws {Error} If player is destroyed, not connected, index is invalid, or play fails.
      */
     async jump(index) {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
         if (!this.isConnected) throw new Error("Player is not connected.");
         if (typeof index !== 'number' || index < 0 || index >= this.queue.size) {
            throw new Error(`Invalid jump index: ${index}. Queue size is ${this.queue.size}.`);
        }

        const targetTrack = this.queue.tracks[index]; // Assumes direct access for inspection
         this._debugLog(`Jumping to track at index ${index}: ${targetTrack?.info?.title}`);

        // Remove tracks before the target index
        const removed = this.queue.removeRange(0, index); // remove range [0, index-1]
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_CLEAR, this, removed.length); // partial clear event

         // The target track is now at index 0. Poll it and play.
        await this.play() // Play will poll the (new) index 0 track
         .catch(err => {
             this._emitError(err, `Failed to play track after jumping to index ${index}`);
            throw err; // Re-throw after logging
         });
    }

    /**
     * Clears the entire queue, excluding the currently playing track.
     * @returns {number} The number of tracks removed from the queue.
     * @throws {Error} If player is destroyed.
     */
    clearQueue() {
         if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
         const removedCount = this.queue.size;
        if (removedCount > 0) {
            this.queue.clear(); // Keeps 'current' but clears upcoming tracks
            this._debugLog(`Queue cleared. Removed ${removedCount} track(s).`);
            this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_CLEAR, this, removedCount);
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_CLEAR, this, removedCount);
         }
         return removedCount;
    }

    /**
     * Shuffles the upcoming tracks in the queue.
     * @returns {boolean} True if shuffle was successful (queue had > 1 track), false otherwise.
     * @throws {Error} If player is destroyed.
     */
    shuffle() {
         if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
         if (this.queue.size < 2) {
             this._debugLog(`Shuffle skipped: Queue has less than 2 tracks.`);
             return false;
         }

        this.queue.shuffle();
        this._debugLog(`Queue shuffled.`);
        this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_SHUFFLE, this);
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_SHUFFLE, this);
        return true;
    }

     /**
      * Plays the previous track from the history if available.
      * Requires the Queue implementation to have a history feature.
      * @returns {Promise<void>}
      * @throws {Error} If player is destroyed, not connected, no previous track, or play fails.
      */
     async previous() {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
        if (!this.isConnected) throw new Error("Player is not connected.");

        // Assumes queue.previous() handles history logic and adds current back to front of queue
         const previousTrack = this.queue.previous(); // Method needs to exist in Queue class
         if (!previousTrack) {
            throw new Error("No previous track available in history.");
         }

        this._debugLog(`Playing previous track: ${previousTrack?.info?.title}`);
         await this.play(previousTrack, { noReplace: false }) // Force replace current track
          .catch(err => {
              this._emitError(err, `Failed to play previous track`);
              throw err; // Re-throw
          });
     }

    // --- Playback Control Commands ---

    /**
     * Plays a track, resumes playback, or starts the queue.
     * If a track is provided, it replaces the current track unless `noReplace` is true and playing.
     * If no track is provided, it polls the next track from the queue.
     * Handles Lavalink communication.
     * @param {Track | string} [track] The Lavalink track object or encoded string to play. If omitted, starts/resumes the queue.
     * @param {object} [options={}] Play options.
     * @param {number} [options.startTime] Start playback at this position (ms). Clamped to track duration.
     * @param {number} [options.endTime] Stop playback at this position (ms). Must be > startTime if provided.
     * @param {boolean} [options.noReplace=false] If true, ignores the play request if already playing. Ignored if nothing is playing or track differs.
     * @param {boolean} [options.pause=false] If true, starts the track paused.
     * @param {boolean} [options.replace=true] Deprecated alias for `!noReplace`. If `false` and already playing, this call is ignored.
     * @returns {Promise<void>} Resolves when the play command is sent. Actual playback starts with TRACK_START event.
     * @throws {Error} If player is not connected, node is unavailable, or player is destroyed.
     */
    async play(track, options = {}) {
        this._debugLog(`Play command received. Track provided: ${!!track}, Options: ${JSON.stringify(options)}`);
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
        if (!this.isConnected && this.state !== 'WAITING_FOR_SERVER') { // Allow play command queueing if just about to connect
            throw new Error(`Player not connected (State: ${this.state}). Cannot play.`);
        }
        if (!this.node?.connected || !this.node?.sessionId) {
             this._emitWarn("Cannot play: Lavalink node is not connected or ready.");
             // Optional: Try to find a new node? For now, just error.
            throw new Error("Cannot play: Lavalink node is not connected or ready.");
        }


        const {
             startTime,
             endTime,
             pause = false,
             // Handle both `noReplace` and `replace` for backward compatibility, prioritizing `noReplace`
             noReplace = (options.replace === undefined ? false : !options.replace)
        } = options;


        let trackToPlay;
        let isNewTrackExplicitlyProvided = false;

         if (track) { // Track provided
             // Basic validation (check for encoded or info.uri)
            if (typeof track !== 'string' && !(typeof track === 'object' && track.info?.uri)) {
                 throw new Error("Invalid track provided. Must be encoded string or track object with info.");
             }
             trackToPlay = track;
             isNewTrackExplicitlyProvided = true;
             this._debugLog(`Explicit track provided: ${typeof track === 'string' ? track.substring(0, 30) + '...' : track.info.title}`);
        } else { // No track provided, use queue
             this._debugLog(`No explicit track provided, polling queue.`);
             trackToPlay = this.queue.poll(); // Get next from queue, may return null
        }

        // --- Handle `noReplace` ---
        const isCurrentlyPlaying = this.isPlaying || (this.playing && this.paused); // Consider paused but loaded as 'playing' for noReplace
         if (noReplace && isCurrentlyPlaying && isNewTrackExplicitlyProvided && trackToPlay === this.current) {
             this._debugLog(`'noReplace' active, already playing the requested track. Ignoring play command.`);
             return; // Playing same track, ignore.
        }
         if (noReplace && isCurrentlyPlaying && isNewTrackExplicitlyProvided && trackToPlay !== this.current) {
            this._debugLog(`'noReplace' active, but requested track differs from current. Proceeding with replacement.`);
             // If `noReplace` is true but the *track itself* is different, replace should still happen.
            // Let the command proceed.
        }
        if(noReplace && isCurrentlyPlaying && !isNewTrackExplicitlyProvided) {
            this._debugLog(`'noReplace' active and polling queue while playing. Ignoring poll request.`);
             return; // Already playing and asked to poll queue with noReplace = true, so ignore.
        }


        // --- Handle End of Queue ---
        if (!trackToPlay && !this.current) { // Check if queue AND current track are empty
             this._debugLog(`Queue is empty and nothing playing.`);
             // Only emit queue end if we were previously in a playing/paused/stopped state
             if ([Constants.PLAYER_STATE.PLAYING, Constants.PLAYER_STATE.PAUSED, Constants.PLAYER_STATE.STOPPED].includes(this.state)) {
                 this._debugLog(`Emitting QUEUE_END.`);
                this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                 // Optionally ensure Lavalink is stopped if nothing else to play. Use stop(false).
                await this.stop(false).catch(e => this._emitWarn(`Error ensuring stop after queue end: ${e.message}`));
            }
            return; // Nothing to play
        }

        // --- Set Queue's Current Track ---
        // `queue.poll()` automatically sets `queue.current`
        // If an explicit track was given, set it as current
        if (isNewTrackExplicitlyProvided && trackToPlay) {
            this.queue.current = trackToPlay; // Set current immediately
         }


         // --- Prepare Lavalink Payload ---
         const encodedTrackString = typeof trackToPlay === 'string' ? trackToPlay : trackToPlay.encoded;
         if (!encodedTrackString) {
             // This should theoretically not happen if track validation passed, but safeguard anyway
             this._emitError(new Error("Cannot play: Resolved track is invalid or missing encoded string."));
             // Attempt to play next? Or just error out? For now, error.
             // await this._handleTrackEnd({ reason: 'loadFailed' }); // Could trigger next track
             return;
         }


        const payload = {
            encodedTrack: encodedTrackString,
            // volume: this.volume, // Don't send volume on play, use setVolume separately or filters.volume
            paused: pause, // Start paused if requested
        };

         // Add position controls only if valid numbers are provided
         if (typeof startTime === 'number' && startTime >= 0) {
            payload.position = Math.max(0, Math.round(startTime));
             // Ensure startTime doesn't exceed known duration if available
             const duration = this.queue.current?.info?.length;
             if (duration && payload.position > duration) payload.position = duration;
        }
         if (typeof endTime === 'number' && endTime > 0) {
             payload.endTime = Math.round(endTime);
            // Ensure endTime > position if both set
            if (payload.position !== undefined && payload.endTime <= payload.position) {
                delete payload.endTime; // Invalid endTime, ignore
                this._emitWarn("endTime <= startTime provided to play(), ignoring endTime.");
             }
        }


         // --- Send Update to Lavalink ---
        try {
             const isReplacing = isCurrentlyPlaying; // Simplification: Send noReplace flag if we think we are playing. Lavalink handles the rest.
            this._debugLog(`Sending play/replace request to node ${this.node.identifier}. Replacing: ${isReplacing}. Payload: ${JSON.stringify({...payload, encodedTrack: '...'})}`);

             await this.node.updatePlayer(this.guildId, payload, isReplacing);

            // Update local state partially for immediate feedback (position/pause).
            // Full playing state confirmation comes via TRACK_START event.
            this.paused = pause;
            this.position = payload.position ?? 0; // Optimistically set position
            this._lastPositionUpdateTimestamp = Date.now(); // Use local time as estimate until first player update
            this.state = pause ? Constants.PLAYER_STATE.PAUSED : (isReplacing ? this.state : Constants.PLAYER_STATE.PLAYING); // Tentative state


             // We *don't* set `this.playing = true` here. Wait for TRACK_START from Lavalink.

        } catch (error) {
            this._emitTrackException(this.queue.current ?? trackToPlay, error, "Lavalink Play/Replace Request Failed");
            // Simulate track end with loadFailed to trigger queue processing (or stop)
            // Pass the *original* requested track if current was updated prematurely
            const failedTrack = isNewTrackExplicitlyProvided ? track : this.queue.current;
             await this._handleTrackEnd({ reason: 'loadFailed' }, failedTrack);
        }
    }


    /**
     * Stops the current playback, clears the current track, and optionally clears the queue.
     * @param {boolean} [clearQueue=true] Whether to clear the upcoming tracks in the queue. Default true.
     * @returns {Promise<void>}
     */
    async stop(clearQueue = true) {
         if (this.state === Constants.PLAYER_STATE.DESTROYED) return;

        const wasPlayingOrPaused = this.isPlaying || this.isPaused || this.state === Constants.PLAYER_STATE.PLAYING || this.state === Constants.PLAYER_STATE.PAUSED;
         this._debugLog(`Stop command received. Clear queue: ${clearQueue}. Was playing/paused: ${wasPlayingOrPaused}`);

         const stoppedTrack = this.current; // Keep track of what was stopped

         // --- Reset Local Playback State Immediately ---
         this.playing = false;
         this.paused = false;
         this.timestamp = null;
         this.position = 0;
         this._lastPositionUpdateTimestamp = 0;
        this.queue.current = null; // Clear the current track immediately


         // Set final state only if not destroyed
         if (this.state !== Constants.PLAYER_STATE.DESTROYED) {
             this.state = Constants.PLAYER_STATE.STOPPED;
        }

         // --- Clear Queue if Requested ---
        if (clearQueue) {
            const clearedCount = this.clearQueue(); // Use the method to potentially emit event
             this._debugLog(`Queue cleared via stop(): ${clearedCount} tracks removed.`);
         }


        // --- Send Update to Lavalink Node ---
        try {
            // Only send if connected, node available, and potentially was playing something
            if (this.node && this.node.connected && this.node.sessionId && wasPlayingOrPaused) {
                this._debugLog(`Sending stop command (encodedTrack: null) to Lavalink node ${this.node.identifier}.`);
                await this.node.updatePlayer(this.guildId, { encodedTrack: null });
             } else if (wasPlayingOrPaused) {
                 this._debugLog(`Playback stopped locally, but Lavalink command skipped (Node ${this.node?.identifier} not ready or wasn't playing).`);
            }
        } catch (error) {
            // Log error but local state is already updated. Node might be out of sync.
            this._emitNodeError(this.node, error, `Failed to send stop command to Lavalink`);
         }

         // Emit stop event if something was actually playing/paused before stop
         if (wasPlayingOrPaused) {
            this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_STOP, this, stoppedTrack);
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_STOP, this, stoppedTrack);
         }
    }


    /**
     * Skips the current track and plays the next one in the queue, if any.
     * Returns the track that was skipped.
     * @returns {Promise<Track | null>} The track that was skipped, or null if nothing was playing.
     * @throws {Error} If player is destroyed or not connected.
     */
    async skip() {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
         if (!this.isConnected) throw new Error("Player is not connected.");

         const skippedTrack = this.current; // Get track before potential changes

         if (!skippedTrack && this.queue.isEmpty) {
             this._debugLog(`Skip called but nothing playing and queue empty.`);
             await this.stop(false); // Ensure player is fully stopped
            return null;
         }
        this._debugLog(`Skipping track: ${skippedTrack?.info?.title ?? 'None'}`);


        // Lavalink automatically sends TRACK_END when told to play null or a new track.
        // We rely on TRACK_END and _handleTrackEnd to advance the queue.
        // Sending an explicit 'stop' then 'play' can be slightly slower and cause more events.
        // Sending 'play' with the *next* track is cleaner. Lavalink handles the transition.

        // Poll the *next* track without modifying `this.current` yet.
         const nextTrack = this.queue.peek(); // Assumes peek() gets next without removing

         if (nextTrack) {
            this._debugLog(`Skipping to next track in queue: ${nextTrack.info.title}. Sending play command.`);
            // Play the next track directly. Lavalink will stop the current one and start the new one.
             await this.play(nextTrack, { noReplace: false }); // Force replacement
        } else {
            this._debugLog(`Skipping to end of queue. Sending stop command.`);
             // No next track, send a stop command (equivalent to playing null)
             await this.stop(false); // Don't clear queue (it's already empty), ensures Lavalink stops
             // _handleTrackEnd will be called eventually from Lavalink and emit QUEUE_END
        }

         return skippedTrack; // Return the track that was playing before skip initiated
    }

    /**
     * Pauses or resumes the current playback.
     * @param {boolean} [pause=true] Set to `true` to pause, `false` to resume. Default true.
     * @returns {Promise<void>}
     * @throws {Error} If player is destroyed, not connected, or trying to pause when nothing is loaded.
     */
    async pause(pause = true) {
         if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
         if (!this.isConnected) throw new Error("Player is not connected.");
         if (!this.node?.sessionId) throw new Error("Lavalink node has no active session.");


        // Don't send command if state already matches (unless explicitly resuming while technically stopped)
        if (pause === this.paused && this.state !== Constants.PLAYER_STATE.STOPPED) {
            this._debugLog(`Pause command ignored: Already ${this.paused ? 'paused' : 'resumed'}. State: ${this.state}`);
            return;
        }

        // Cannot pause if nothing is loaded/playing (check current track)
         if (pause && !this.current) {
             this._emitWarn(`Cannot pause: No track is currently loaded/playing.`);
             // Consider throwing error? return false? For now, just log and return.
             // throw new Error("Cannot pause: No track is currently loaded.");
             return;
        }
        // Cannot resume if nothing is loaded/playing
        if (!pause && !this.current) {
            this._emitWarn(`Cannot resume: No track is currently loaded/playing.`);
            // Maybe try starting queue? Depends on desired UX. For now, log and return.
            // throw new Error("Cannot resume: No track is currently loaded.");
            return;
        }

         this._debugLog(`Setting pause state to: ${pause}`);
        try {
             // --- Send Update to Lavalink ---
            await this.node.updatePlayer(this.guildId, { paused: pause });

            // --- Update Local State AFTER successful API call ---
            const previouslyPaused = this.paused;
            this.paused = pause;

             // Adjust player state based on pause state and whether track is loaded
             if (pause) {
                // If pausing while playing or already paused (edge case), set state to PAUSED
                 if (this.state === Constants.PLAYER_STATE.PLAYING || this.state === Constants.PLAYER_STATE.PAUSED) {
                    this.state = Constants.PLAYER_STATE.PAUSED;
                     // Cache current position accurately when pausing
                    this.position = this.currentPosition; // Use calculated position getter
                    this._lastPositionUpdateTimestamp = Date.now(); // Update timestamp too
                }
                // If trying to pause while STOPPED but a track is loaded (rare), keep as STOPPED but set paused=true? Or PAUSED? Let's keep STOPPED.
                // User might issue 'play({ pause: true })', state starts as PAUSED. Normal pause should move from PLAYING -> PAUSED.
            } else {
                // If resuming, set state back to PLAYING only if a track is actually loaded/current.
                // Otherwise, remain STOPPED (e.g., resuming after stop() call).
                if (this.current && (this.state === Constants.PLAYER_STATE.PAUSED || this.state === Constants.PLAYER_STATE.STOPPED)) {
                     this.state = Constants.PLAYER_STATE.PLAYING;
                     // Refresh position timestamp on resume
                     this._lastPositionUpdateTimestamp = Date.now();
                 } else if (!this.current) {
                     // Resuming with no track loaded? Should technically not happen due to earlier check. Keep state as STOPPED.
                    this.state = Constants.PLAYER_STATE.STOPPED;
                    this.paused = false; // Ensure paused is false if no track
                    this._emitWarn("Resume called with no current track. State remains STOPPED.");
                 }
             }

            this._debugLog(`Playback ${pause ? 'paused' : 'resumed'}. New state: ${this.state}`);

            // Emit event only if state meaningfully changed
            if (pause !== previouslyPaused || this.state === Constants.PLAYER_STATE.PLAYING || this.state === Constants.PLAYER_STATE.PAUSED) {
                 this.emit(pause ? Constants.CLIENT_EVENT_TYPES.PLAYER_PAUSE : Constants.CLIENT_EVENT_TYPES.PLAYER_RESUME, this);
                 this.manager.emit(pause ? Constants.CLIENT_EVENT_TYPES.PLAYER_PAUSE : Constants.CLIENT_EVENT_TYPES.PLAYER_RESUME, this);
             }

        } catch (error) {
            this._emitNodeError(this.node, error, `Failed to ${pause ? 'pause' : 'resume'} player`);
            throw error; // Re-throw error after logging
        }
    }

    /** Resumes the current playback. Shortcut for `pause(false)`. */
    resume() {
        return this.pause(false);
    }

    /** Toggles the pause state of the player. */
    togglePause() {
        return this.pause(!this.paused);
    }

    /**
     * Seeks to a specific position in the current track.
     * @param {number} position Position in milliseconds. Must be positive.
     * @returns {Promise<void>}
     * @throws {Error} If player is destroyed, not connected, nothing playing/loaded, track not seekable, or position invalid.
     */
    async seek(position) {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
        if (!this.isConnected) throw new Error("Player is not connected.");
        if (!this.current) throw new Error("Not playing anything or no track loaded to seek.");
         if (!this.current.info.isSeekable) {
            throw new Error("The current track is not seekable.");
        }
        if (typeof position !== 'number' || position < 0 || !isFinite(position)) {
            throw new Error("Invalid seek position. Must be a non-negative finite number (milliseconds).");
        }
        if (!this.node?.sessionId) throw new Error("Lavalink node has no active session.");

        const trackDuration = this.current.info.length;
        // Clamp position to track duration (allow seeking exactly to end)
         const targetPosition = Math.max(0, Math.min(Math.round(position), trackDuration ?? Infinity));

        this._debugLog(`Seeking to ${targetPosition}ms.`);
        try {
            // --- Send Update to Lavalink ---
            await this.node.updatePlayer(this.guildId, { position: targetPosition });

            // --- Update Local State Immediately for Feedback ---
            this.position = targetPosition;
            this._lastPositionUpdateTimestamp = Date.now(); // Reset timestamp relative to new position

            this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_SEEK, this, targetPosition);
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_SEEK, this, targetPosition);
            this._debugLog(`Seek successful.`);

        } catch (error) {
            this._emitNodeError(this.node, error, `Failed to seek player to ${targetPosition}`);
            throw error; // Re-throw
        }
    }

    /**
     * Restarts the currently playing track from the beginning.
     * @returns {Promise<void>}
     * @throws {Error} If player is destroyed, not connected, or nothing is playing/loaded.
     */
     async restart() {
         if (!this.current) {
             throw new Error("No track is currently loaded to restart.");
         }
         this._debugLog(`Restarting current track: ${this.current.info.title}`);
         await this.seek(0);
         // Ensure playback is resumed if it was paused before restart
         if(this.isPaused) {
             await this.resume();
         }
     }

    /**
     * Sets the player's master volume level.
     * This is independent of the filter volume.
     * @param {number} volume Volume level (0-1000). Values outside this range are clamped.
     * @returns {Promise<void>}
     * @throws {Error} If player is destroyed or node has no session.
     */
    async setVolume(volume) {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
         if (!this.node?.sessionId) throw new Error("Lavalink node has no active session."); // Cannot set volume if disconnected from lavalink
        if (typeof volume !== 'number' || !isFinite(volume)) {
            throw new Error("Invalid volume level. Must be a finite number.");
        }

         // Clamp volume between 0 and 1000
        const targetVolume = Math.max(0, Math.min(Math.round(volume), 1000));

        if (targetVolume === this.volume) return; // No change needed

        this._debugLog(`Setting volume to ${targetVolume}.`);
        try {
            // --- Send Update to Lavalink ---
            // Important: Send BOTH player volume AND filter volume if using filters extensively,
            // otherwise just player volume. Assuming filters.volume controls gain within the chain,
            // and this `volume` controls the master output post-filters.
            await this.node.updatePlayer(this.guildId, { volume: targetVolume });

            // --- Update Local State ---
            const oldVolume = this.volume;
            this.volume = targetVolume;

            this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_VOLUME_UPDATE, this, oldVolume, targetVolume);
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_VOLUME_UPDATE, this, oldVolume, targetVolume);
            this._debugLog(`Volume updated successfully.`);

        } catch (error) {
            this._emitNodeError(this.node, error, `Failed to set volume to ${targetVolume}`);
            throw error;
        }
    }

    /**
     * Sets the loop mode for the player/queue.
     * - NONE: No looping. Queue proceeds normally.
     * - TRACK: Repeats the current track indefinitely.
     * - QUEUE: Repeats the entire queue indefinitely.
     * @param {Constants.LOOP_MODE} mode Loop mode (NONE, TRACK, QUEUE). Use `Constants.LOOP_MODE`.
     * @throws {Error} If the mode is invalid or player is destroyed.
     */
    setLoop(mode) {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
         if (mode === undefined || !Object.values(Constants.LOOP_MODE).includes(mode)) {
            throw new Error(`Invalid loop mode: ${mode}. Use Constants.LOOP_MODE enum (0, 1, or 2).`);
        }

        const oldMode = this.loop;
        // Update the queue's loop mode, which drives the logic in _handleTrackEnd
        this.queue.setLoop(mode);
        // Update the player's loop property for direct access/state checking
        this.loop = mode;

        const modeName = Object.keys(Constants.LOOP_MODE).find(k => Constants.LOOP_MODE[k] === mode) ?? 'UNKNOWN';
        this._debugLog(`Loop mode set to ${modeName} (${mode}).`);

        if (oldMode !== mode) {
            this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_LOOP_CHANGE, this, oldMode, mode);
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_LOOP_CHANGE, this, oldMode, mode);
        }
    }


    // --- Filters / Audio Effects ---

     /**
      * Applies a full set of Lavalink filters. Replaces all existing filters.
      * For modifying specific filters, use methods like `setEqualizer`, `setTimescale`, etc., or get current filters, modify, and set again.
      * @param {object} filters - The Lavalink filter object. See Lavalink documentation for structure.
      * @returns {Promise<void>}
      * @throws {Error} If player is destroyed, not connected, or filter object is invalid.
      */
    async setFilters(filters) {
         if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Player is destroyed.");
         if (!this.isConnected) throw new Error("Player not connected. Cannot set filters.");
         if (!this.node?.sessionId) throw new Error("Lavalink node has no active session.");
         if (typeof filters !== 'object' || filters === null) {
            throw new Error("Invalid filters object provided.");
         }

         // Deep merge with defaults might be complex. Simplest is direct set.
         // User is responsible for providing the full filter object structure.
         // Alternatively, provide specific setter methods.

         this._debugLog(`Setting filters: ${JSON.stringify(filters)}`);

         // Apply a basic structure check? Depends on how strict you want to be.
         // Example: Ensure volume is a number if present.

         try {
             await this.node.updatePlayer(this.guildId, { filters: filters });

             // --- Update Local State AFTER success ---
             // Need a robust way to store this. Deep clone the incoming object?
             // Store *exactly* what was sent.
             this.filters = JSON.parse(JSON.stringify(filters)); // Store a copy

             this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_FILTERS_UPDATE, this, this.filters);
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_FILTERS_UPDATE, this, this.filters);
             this._debugLog(`Filters updated successfully.`);

         } catch (error) {
             this._emitNodeError(this.node, error, `Failed to set filters`);
             throw error;
         }
    }

     /**
      * Clears all applied filters, resetting them to Lavalink defaults.
      * @returns {Promise<void>}
      */
    async clearFilters() {
         // Reset local state to defaults FIRST (avoids race condition if API call fails)
        this.filters = JSON.parse(JSON.stringify(DEFAULT_FILTER_DATA)); // Reset to deep clone of defaults
         // Now send empty object to Lavalink to clear server-side
        this._debugLog(`Clearing all filters.`);
         // Note: We send an empty object `{}` which signals Lavalink to clear filters.
         // Setting individual filters to null/defaults requires sending the whole default structure.
         await this.setFilters({}); // Use setFilters to send the clearing payload
     }

     /**
      * Applies equalizer settings. Provide an array of bands to set.
      * Each band object: `{ band: number (0-14), gain: number (-0.25 to 1.0) }`
      * Setting `bands` to `null` or empty array `[]` clears the EQ.
      * @param {Array<{ band: number, gain: number }> | null} bands - Array of band settings or null to clear.
      * @returns {Promise<void>}
      */
    async setEqualizer(bands) {
        if (bands !== null && !Array.isArray(bands)) {
            throw new Error("Invalid equalizer bands provided. Must be an array of {band, gain} objects or null.");
        }
         // Basic validation of bands
        if (Array.isArray(bands)) {
             if (bands.some(b => typeof b.band !== 'number' || b.band < 0 || b.band > 14 || typeof b.gain !== 'number' || b.gain < -0.25 || b.gain > 1.0)) {
                 throw new Error("Invalid band settings in equalizer array. Ensure band is 0-14 and gain is -0.25 to 1.0.");
             }
         }

         const newFilters = JSON.parse(JSON.stringify(this.filters)); // Clone current filters
         newFilters.equalizer = (bands && bands.length > 0) ? bands : null; // Set or clear EQ

         // Keep other filters intact by merging
         // In this case, setFilters handles the full object update
        await this.setFilters(newFilters);
    }


    /**
     * Applies timescale filter settings (speed, pitch, rate).
     * Provide an object with the desired properties. Omitted properties remain unchanged from defaults (or current Lavalink state).
     * Set to `null` to clear/reset the timescale filter specifically.
     * @param {{ speed?: number, pitch?: number, rate?: number } | null} timescaleSettings - Timescale settings or null to reset.
     *        Constraints (apply >=0, recommended > 0): speed > 0, pitch > 0, rate > 0
     * @returns {Promise<void>}
     */
    async setTimescale(timescaleSettings) {
        if (timescaleSettings !== null && typeof timescaleSettings !== 'object') {
            throw new Error("Invalid timescaleSettings provided. Must be an object or null.");
         }

         // Validate properties if object provided
         if (timescaleSettings) {
             const props = ['speed', 'pitch', 'rate'];
             for (const prop of props) {
                 if (timescaleSettings[prop] !== undefined && (typeof timescaleSettings[prop] !== 'number' || timescaleSettings[prop] < 0)) {
                     throw new Error(`Invalid timescale setting for '${prop}'. Must be a number >= 0.`);
                 }
                 if (timescaleSettings[prop] === 0) {
                    this._emitWarn(`Timescale property '${prop}' set to 0, which might silence audio or behave unexpectedly. Recommended > 0.`);
                 }
             }
         }

         const newFilters = JSON.parse(JSON.stringify(this.filters)); // Clone current
         newFilters.timescale = timescaleSettings; // Set timescale object or null

         await this.setFilters(newFilters);
    }

    // --- Add more specific filter setters as needed (e.g., setKaraoke, setTremolo, etc.) ---
    // Example:
    // async setKaraoke(settings) { ... }
    // async setDistortion(settings) { ... }

    /** Helper for Bass Boost using EQ */
     async setBassBoost(level = 0.2) { // level 0 to ~0.5+
        if (typeof level !== 'number' || level < 0) level = 0;
        level = Math.min(level, 1.0); // Cap gain to 1.0 per band

        const bands = [
            { band: 0, gain: level * 0.8 }, // Emphasize lower bass slightly less than mid-bass
             { band: 1, gain: level },      // Strongest boost in mid-bass
            { band: 2, gain: level * 0.6 }, // Slight boost in upper bass/low mids
            // Bands 3-14 left at default gain (0) implicitly
        ];
        await this.setEqualizer(bands);
        this._debugLog(`Applied Bass Boost (EQ) with level ~${level}`);
     }

     /** Helper for a simple Nightcore effect (speed + pitch) */
    async setNightcore(speed = 1.1, pitch = 1.15) {
        if (typeof speed !== 'number' || speed <= 0) speed = 1.1;
        if (typeof pitch !== 'number' || pitch <= 0) pitch = 1.15;
        await this.setTimescale({ speed, pitch, rate: 1.0 }); // Ensure rate is normal if just setting speed/pitch
        this._debugLog(`Applied Nightcore effect (Timescale): Speed=${speed}, Pitch=${pitch}`);
     }

     /** Helper to reset common effects (Bass Boost EQ, Timescale) */
    async resetCommonEffects() {
        const newFilters = JSON.parse(JSON.stringify(this.filters)); // Clone current
        newFilters.equalizer = null; // Clear EQ
        newFilters.timescale = null; // Clear Timescale
        // Optionally clear others like Karaoke if you have helpers for them
        await this.setFilters(newFilters);
        this._debugLog(`Reset common effects (EQ, Timescale).`);
     }

    // --- Node Management ---

    /**
     * Moves the player to a different, ready Lavalink node. Handles state transfer.
     * @param {Node} targetNode The node instance to move to. Must be connected and ready.
     * @returns {Promise<void>}
     * @throws {Error} If the move is invalid (same node, node not ready, destroyed player, move in progress) or fails.
     */
    async moveToNode(targetNode) {
         if (this.moving) throw new Error("Player move already in progress.");
         if (this.state === Constants.PLAYER_STATE.DESTROYED) throw new Error("Cannot move a destroyed player.");
         if (!targetNode || targetNode.constructor.name !== 'Node') throw new Error("Invalid targetNode provided."); // Basic check
        if (targetNode === this.node) throw new Error("Target node is the same as the current node.");
         if (!targetNode.connected || !targetNode.sessionId) {
            throw new Error(`Target node "${targetNode.identifier}" is not connected or ready.`);
        }

         this.moving = true; // --- Set Move Flag ---
         const oldNode = this.node;
         const oldNodeIdentifier = oldNode?.identifier ?? 'Unknown';
         this._debugLog(`Moving player from Node ${oldNodeIdentifier} to Node ${targetNode.identifier}...`);

        // --- Store Current State (crucially, use calculated currentPosition) ---
         const currentTrack = this.current; // Store before potential changes
        const calculatedPosition = this.currentPosition; // Get best estimate NOW
        const stateToRestore = {
            encodedTrack: currentTrack?.encoded,
            position: calculatedPosition > 0 ? calculatedPosition : 0, // Ensure non-negative
            volume: this.volume, // Player volume
            paused: this.paused, // Current pause state
            filters: JSON.parse(JSON.stringify(this.filters)), // Deep clone current filters
             voice: { // Need voice state too!
                token: this.voiceToken,
                endpoint: this.voiceEndpoint,
                 sessionId: this.voiceSessionId
            }
         };

        // Remove undefined/null properties only if Lavalink version requires it
         Object.keys(stateToRestore).forEach(key => stateToRestore[key] === undefined && delete stateToRestore[key]);
         Object.keys(stateToRestore.filters).forEach(key => stateToRestore.filters[key] === null && delete stateToRestore.filters[key]);
         if(Object.keys(stateToRestore.filters).length === 0) delete stateToRestore.filters; // Remove empty filters object
         if(!stateToRestore.voice.token || !stateToRestore.voice.endpoint || !stateToRestore.voice.sessionId) delete stateToRestore.voice; // Don't send invalid voice state
         if(!stateToRestore.encodedTrack) delete stateToRestore.position; // Don't send position if no track

         this._debugLog(`State to restore on new node: ${JSON.stringify({...stateToRestore, encodedTrack: '...', filters: '...', voice: '...'})}`);

         try {
            // 1. Destroy player state ONLY on the old Lavalink node (if connected)
             this._debugLog(`Destroying player state on old node ${oldNodeIdentifier}.`);
             if (oldNode?.sessionId && oldNode?.connected) {
                await oldNode.destroyPlayer(this.guildId).catch(e => this._emitWarn(`Non-fatal error destroying player on old node ${oldNodeIdentifier} during move: ${e.message}`));
            } else {
                 this._debugLog(`Skipping destroy on old node ${oldNodeIdentifier} (not ready).`);
             }

            // 2. Update internal node reference and manage node player maps
            oldNode?._removePlayer(this); // Remove from old node's map (safe call)
            this.node = targetNode;
             this.node._addPlayer(this); // Add to new node's map

             // 3. Restore the complete player state on the NEW node using a single PATCH request
             this._debugLog(`Restoring player state on new node ${targetNode.identifier}.`);

             if (!stateToRestore.voice) {
                 this._emitWarn("Voice state incomplete during move. Playback might not resume automatically on new node.");
                 // Don't send stateToRestore if voice is missing, as it will fail without voice usually.
                 // Player effectively becomes 'disconnected' on the new node until voice state is manually updated.
                 // Set local state to reflect potential issue? Maybe DISCONNECTED_LAVALINK?
                 // For now, let it try and fail if voice was needed, node update will report error.
             }

             if (Object.keys(stateToRestore).length > 0) {
                // We use noReplace = false here because we are creating the player instance on the new node.
                await this.node.updatePlayer(this.guildId, stateToRestore, false);
            } else {
                 this._debugLog(`No state to restore (likely idle or disconnected voice).`);
                 // Still ensure basic connection exists? Maybe Lavalink needs an empty PATCH? Assume not for now.
             }

            // 4. Update Local State (partially, relies on playerUpdate from new node for position sync)
             if (stateToRestore.encodedTrack) {
                 this.playing = true; // Assume playing starts if track restored
                 this.paused = stateToRestore.paused ?? false; // Restore pause state
                this.state = this.paused ? Constants.PLAYER_STATE.PAUSED : Constants.PLAYER_STATE.PLAYING;
                 this._lastPositionUpdateTimestamp = Date.now(); // Reset local timestamp timer
                 // Note: this.position might be slightly off until the first playerUpdate from the new node arrives.
             } else {
                 // If no track was restored, player should be stopped on the new node
                 this.playing = false;
                 this.paused = false;
                this.state = Constants.PLAYER_STATE.STOPPED; // Should be stopped if no track/voice restored
            }

            this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_MOVE, this, oldNode, targetNode);
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_MOVE, this, oldNode, targetNode);
            this._debugLog(`Successfully moved to node ${targetNode.identifier}. New State: ${this.state}`);

        } catch (error) {
            this._emitError(error, `Failed to move player to node ${targetNode.identifier}`);
            // Critical failure. Attempt to revert or destroy? Reverting is complex.
            // Safest option is usually to destroy the player cleanly.
            this.node = oldNode; // Tentatively point back to old node for destroy attempt? Risky. Use targetNode ref in log.
             this._emitNodeError(targetNode, error, `Failed during move state restoration for player`);
            try {
                // Force destroy on the *target* node as well, in case state was partially created
                 if(targetNode?.sessionId && targetNode?.connected){
                     this._debugLog(`Attempting cleanup: Destroying player state on target node ${targetNode.identifier} after move failure.`);
                    await targetNode.destroyPlayer(this.guildId).catch(e => this._debugLog(`Ignoring error during post-move-failure cleanup on target node: ${e.message}`));
                 }
                 // Perform full player destruction
                await this.destroy();
             } catch (destroyError) {
                 this._emitError(destroyError, `Error during post-move-failure cleanup`);
             }
             // Re-throw the original error that caused the move failure
             throw error;
        } finally {
            this.moving = false; // --- Clear Move Flag ---
        }
    }

    // --- Internal Event Handlers ---

    /** Handles PLAYER_UPDATE event from Lavalink. @private */
    _updateState(state) {
        if (this.state === Constants.PLAYER_STATE.DESTROYED) return;

         // Update timings first
         this.timestamp = state.time ?? this.timestamp; // Lavalink server timestamp (use for accurate tracking if needed)
         // Update local position and timestamp ONLY IF Lavalink provides position
         // This prevents overwriting our calculated currentPosition with 0 if Lavalink omits it briefly.
         if (state.position !== undefined) {
             this.position = state.position;
            this._lastPositionUpdateTimestamp = Date.now(); // Track when we received this position update locally
         }

        // Update connection status (Lavalink <-> Discord voice WS)
        const wasInternallyConnected = this.connected;
        this.connected = state.connected; // Reflects Lavalink's view of the voice connection

        if (wasInternallyConnected && !this.connected) {
            // Lavalink reports voice WS closed!
             this._debugLog(`Lavalink reports Discord voice connection closed. State changed to DISCONNECTED_LAVALINK.`);
            if (this.state !== Constants.PLAYER_STATE.DESTROYED && this.state !== 'DISCONNECTING') {
                 // If state allows, mark as disconnected from Lavalink perspective
                 this.state = 'DISCONNECTED_LAVALINK';
                 // Might need manual intervention (reconnect)
                this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, this, { code: -1, reason: 'Reported disconnected by Lavalink player update', byRemote: true, guildId: this.guildId });
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, this, { code: -1, reason: 'Reported disconnected by Lavalink player update', byRemote: true, guildId: this.guildId });
             }
        } else if (!wasInternallyConnected && this.connected) {
            // Connection established / re-established according to Lavalink
             this._debugLog(`Lavalink reports Discord voice connection established.`);
             // If we were in a disconnected state, transition to STOPPED (assuming no track playing yet)
             if (this.state === 'DISCONNECTED_LAVALINK' || this.state === 'CONNECTING' || this.state === 'WAITING_FOR_SERVER') {
                this.state = Constants.PLAYER_STATE.STOPPED; // Recovered or finished connecting
                 // If connecting, clear promise here too as a fallback mechanism
                 if (this._connectionResolver) {
                    this._clearConnectionPromise(); // Resolve connection promise if player update confirms first
                 }
            }
        }


        // Update latency ping
         this.ping = typeof state.ping === 'number' && state.ping >= 0 ? state.ping : -1;


        // Emit general state update event
        this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_STATE_UPDATE, this, state);
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_STATE_UPDATE, this, state);
    }

    /** Handles VOICE_STATE_UPDATE from Discord Gateway. @private */
     _handleVoiceStateUpdate(data) {
         // We only care about updates for *our bot* in *this player's guild*
        if (data.user_id !== this.manager.userId || data.guild_id !== this.guildId) return;


        const oldVoiceChannelId = this.voiceChannelId;
        const oldSessionId = this.voiceSessionId;

        // Update local voice channel state based on the update
         this.voiceChannelId = data.channel_id; // Can be null if disconnected
         this.voiceSessionId = data.session_id;


         // --- Handle Disconnection/Channel NULL ---
        if (this.voiceChannelId === null) {
            // Bot was disconnected from voice (kicked, moved, left)
             if (oldState !== 'DISCONNECTING' && this.state !== Constants.PLAYER_STATE.DESTROYED) {
                 this._debugLog(`Voice state update indicates disconnection (channel_id is null). Cleaning up player.`);
                 // If we were trying to connect, fail the connection attempt
                 if (this.state === 'CONNECTING' || this.state === 'WAITING_FOR_SERVER') {
                     this._clearConnectionPromise(new Error("Disconnected via voice state update during connection."));
                 }
                 // Always clean up the player fully if externally disconnected
                 this.disconnect(true).catch(e => this._debugLog(`Error during cleanup after external disconnect: ${e.message}`));
             }
            return; // Stop processing further for this VSU
        }


         // --- Handle Connecting State ---
        if (this.state === 'CONNECTING') {
             if (this.voiceChannelId && this.voiceSessionId) { // Check if we got the session ID we needed
                 this._debugLog(`Received Voice State Update (Connecting). Session: ${this.voiceSessionId}. State -> WAITING_FOR_SERVER.`);
                this.state = 'WAITING_FOR_SERVER'; // Now waiting for the VOICE_SERVER_UPDATE
            } else {
                // Got a VSU while connecting, but session_id is missing? Discord issue?
                 this._emitWarn(`Received VSU while CONNECTING, but session ID was missing. Still waiting.`);
                 // Connection might timeout if session doesn't arrive.
            }
            // Still waiting for VOICE_SERVER_UPDATE, don't send Lavalink update yet.
            return;
        }


         // --- Handle Changes While Connected/Idle ---
        if (this.state !== 'CONNECTING' && this.state !== Constants.PLAYER_STATE.DESTROYED) {
            // Did the session ID change (e.g., Discord voice region change)?
            if (this.voiceSessionId && this.voiceSessionId !== oldSessionId) {
                this._debugLog(`Voice Session ID changed. Old: ${oldSessionId}, New: ${this.voiceSessionId}. Updating Lavalink...`);
                // Need to send the *new* session ID to Lavalink if token/endpoint are still valid
                if (this.voiceToken && this.voiceEndpoint) {
                    this._sendVoiceUpdate().catch(err => {
                         // If updating fails after session change, connection might break
                         this._emitError(err, `Failed crucial voice update to Lavalink after session change. Player may disconnect.`);
                         this.disconnect(true); // Best effort cleanup if Lavalink rejected update
                    });
                } else {
                    // Session changed, but we don't have full voice context? Odd state.
                     this._emitWarn("Voice session ID changed, but voice token/endpoint are missing. Cannot update Lavalink fully.");
                 }
            }

             // Did the voice channel change unexpectedly (e.g., bot moved by user)?
             // `connect()` method should be used for intentional channel changes by the bot.
             // External move needs handling.
            if (this.voiceChannelId && this.voiceChannelId !== oldVoiceChannelId && oldVoiceChannelId !== null) {
                 this._emitWarn(`Voice channel changed externally from ${oldVoiceChannelId} to ${this.voiceChannelId}. Player state may be inconsistent. Consider reconnecting.`);
                 // Consider disconnecting/destroying player? Or just update channel ID?
                 // For now, just log. User interaction likely needed.
                 this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_VOICE_CHANNEL_MOVE, this, oldVoiceChannelId, this.voiceChannelId);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_VOICE_CHANNEL_MOVE, this, oldVoiceChannelId, this.voiceChannelId);
             }
        }
    }


    /** Handles VOICE_SERVER_UPDATE from Discord Gateway. @private */
     async _handleVoiceServerUpdate(data) {
        // Ignore if destroyed, or not waiting for this, or not for this guild
        if (this.state !== 'WAITING_FOR_SERVER') {
             this._debugLog(`Ignoring Voice Server Update (State is ${this.state}, not WAITING_FOR_SERVER).`);
             return;
        }
        if (data.guild_id !== this.guildId) return; // Not for us


        // --- Validate Data ---
         if (!data.token || !data.endpoint) {
            const errorMsg = `Received invalid Voice Server Update (missing token or endpoint). Failing connection.`;
             this._debugLog(errorMsg);
            const connectionError = new Error("Received incomplete voice server update from Discord.");
             this._clearConnectionPromise(connectionError); // Reject the pending connection promise
            this.state = 'CONNECTION_FAILED'; // Mark as failed explicitly
            // Attempt cleanup - need to tell Discord we are leaving now
            this.disconnect(true).catch(e => this._debugLog(`Error during cleanup after invalid VSU: ${e.message}`)); // Disconnect fully
             return;
        }

        // Store validated data
        this.voiceToken = data.token;
        // Standardize endpoint: Remove port, remove protocol prefix
        this.voiceEndpoint = data.endpoint?.replace(/(:\d+)?$/, '')?.replace(/^wss?:\/\//, '') ?? null; // Robust parsing

         if (!this.voiceEndpoint) { // Check if endpoint parsing somehow failed
            const errorMsg = `Failed to parse voice server endpoint: ${data.endpoint}. Failing connection.`;
             this._debugLog(errorMsg);
             const connectionError = new Error("Failed to parse voice server endpoint from Discord.");
             this._clearConnectionPromise(connectionError);
            this.state = 'CONNECTION_FAILED';
            this.disconnect(true).catch(e => this._debugLog(`Error during cleanup after endpoint parse failure: ${e.message}`));
            return;
        }

        this._debugLog(`Received Voice Server Update. Endpoint: ${this.voiceEndpoint}, Token: [hidden]. Sending voice update to Lavalink.`);


         // --- Send Update to Lavalink ---
        try {
            await this._sendVoiceUpdate(); // Send { voice: { token, endpoint, sessionId } }
            this._debugLog(`Voice update sent successfully to Lavalink node ${this.node.identifier}.`);

            // --- Connection Fully Established ---
            this.connected = true; // Player considers itself connected
             this.state = Constants.PLAYER_STATE.STOPPED; // Player is connected and ready, but initially stopped
             this._debugLog(`Voice connection fully established. State -> STOPPED.`);
             this._clearConnectionPromise(); // Resolve the connection promise successfully

            this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_CONNECT, this);
            this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_CONNECT, this);


         } catch (err) {
             this._debugLog(`Error sending voice update to Lavalink during final connection step: ${err.message}. Failing connection.`);
             this.state = 'CONNECTION_FAILED'; // Mark as failed
             this._clearConnectionPromise(err); // Reject the connection promise with the Lavalink error
             // Attempt cleanup after Lavalink failure
            this.disconnect(true).catch(e => this._debugLog(`Error during cleanup after VSU Lavalink failure: ${e.message}`));
        }
    }


    /** Sends the current voice state (token, endpoint, session) to the assigned Lavalink node. @private */
    _sendVoiceUpdate() {
        // Pre-checks
        if (this.state === Constants.PLAYER_STATE.DESTROYED) return Promise.reject(new Error("Cannot send voice update: Player is destroyed."));
        if (this.moving) return Promise.reject(new Error("Cannot send voice update during node move.")); // Prevent sending to wrong node mid-move
        if (!this.node) return Promise.reject(new Error("Cannot send voice update: Player has no assigned node."));
        if (!this.node.connected || !this.node.sessionId) return Promise.reject(new Error("Cannot send voice update: Lavalink node is not ready."));
        if (!this.voiceSessionId || !this.voiceToken || !this.voiceEndpoint) {
            return Promise.reject(new Error("Cannot send voice update: Missing required voice components (session, token, or endpoint). State invalid."));
        }

        this._debugLog(`Sending voice state payload to Lavalink node ${this.node.identifier}: Session=${this.voiceSessionId}, Endpoint=${this.voiceEndpoint}, Token=[hidden]`);

        const payload = {
            voice: {
                token: this.voiceToken,
                endpoint: this.voiceEndpoint, // Already cleaned hostname
                sessionId: this.voiceSessionId
            }
        };

        // Send the update using PATCH (usually how voice updates are sent)
        return this.node.updatePlayer(this.guildId, payload)
            .catch(err => {
                // If Lavalink rejects the voice update, the player will not work.
                 this._emitNodeError(this.node, err, `Critical failure sending voice update payload. Player likely unusable.`);
                 // Consider immediate disconnect? Depends on expected recovery. For robustness, maybe disconnect.
                 this.disconnect(true).catch(e => this._debugLog(`Error during cleanup after voice update failure: ${e.message}`));
                 throw err; // Re-throw crucial error
            });
     }

     /** Handles events received from Lavalink for this player (TrackStart, TrackEnd, etc.). @private */
     async _handleEvent(payload) {
         // Ignore events if player is destroyed
         if (this.state === Constants.PLAYER_STATE.DESTROYED) {
             this._debugLog(`Ignoring Lavalink event (${payload?.type}) for destroyed player.`);
             return;
         }

         this._debugLog(`Handling Lavalink event: ${payload.type}`);

        const previousTrack = this.queue.current; // Get ref before potential changes

        switch (payload.type) {
            // --- Playback Lifecycle Events ---
            case Constants.LAVA_EVENT_TYPES.TRACK_START:
                 this.playing = true;
                 this.paused = false; // Explicitly set not paused
                this.state = Constants.PLAYER_STATE.PLAYING;
                // Position and timestamp should be updated via PLAYER_UPDATE, but reset estimates here
                this.position = 0; // Assume start is 0 until first update
                this._lastPositionUpdateTimestamp = Date.now(); // Use local time for now

                 // Verify track info matches if needed
                 // const startedTrack = TrackUtils.build(payload.track); // Assuming build decodes and adds structure
                const startedTrack = this.queue.current; // Should already be set by play() or poll()

                 this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_START, this, startedTrack);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_START, this, startedTrack);
                 this._debugLog(`Event: TrackStart (${startedTrack?.info?.title ?? 'Unknown Track'})`);
                break;


            case Constants.LAVA_EVENT_TYPES.TRACK_END:
                 // Get reason before potential async operations change state
                 const reason = payload.reason ?? 'UNKNOWN';
                this._debugLog(`Event: TrackEnd (${previousTrack?.info?.title ?? 'Unknown Track'}, Reason: ${reason})`);

                 // Store previous track in history *before* clearing current/polling next
                 if (previousTrack && reason !== 'replaced') { // Don't store if just replaced instantly
                    this.queue.addToHistory(previousTrack);
                }

                // Reset playback state IF the track ended naturally or stopped, but NOT if just replaced
                if (reason !== 'replaced') {
                    this.playing = false;
                    this.paused = false; // Ensure not marked as paused
                    this.timestamp = null;
                     this.position = 0; // Reset position as track ended
                     this._lastPositionUpdateTimestamp = 0;
                    this.queue.current = null; // Crucial: clear current track reference

                    // Update player state ONLY if not already being destroyed/disconnected
                    if (this.state !== Constants.PLAYER_STATE.DESTROYED && this.state !== 'DISCONNECTING') {
                         this.state = Constants.PLAYER_STATE.STOPPED;
                     }
                 } else {
                     // If 'replaced', current track should be updated by the new TRACK_START soon.
                     // Keep state as PLAYING (or PAUSED if new track starts paused). Position handled by TRACK_START.
                    this.queue.current = null; // Clear current reference, new one set by play/poll/start
                }


                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_END, this, previousTrack, payload);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_END, this, previousTrack, payload);


                // --- Trigger Queue Handling ---
                 // Avoid processing queue if player was destroyed *during* the event emission/handling
                if (this.state !== Constants.PLAYER_STATE.DESTROYED) {
                     try {
                        await this._handleTrackEnd(payload, previousTrack); // Pass previous track for context if needed
                     } catch (e) {
                        this._emitError(e, "Error during post-TrackEnd queue handling");
                    }
                }
                break;


            // --- Playback Problem Events ---
             case Constants.LAVA_EVENT_TYPES.TRACK_EXCEPTION:
                 const exception = payload.exception ?? { message: 'Unknown exception', severity: 'UNKNOWN' };
                 const exceptionTrack = previousTrack ?? this.queue.buildTrackFromEncoded(payload.encodedTrack); // Try to identify track
                this._debugLog(`Event: TrackException (${exceptionTrack?.info?.title ?? 'Unknown Track'}, Severity: ${exception.severity}, Message: ${exception.message})`);

                // Emit before potential state changes
                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, exceptionTrack, payload);
                this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, exceptionTrack, exception);


                 // Reset core playback state similar to a non-'replaced' TRACK_END
                this.playing = false;
                 this.paused = false;
                this.timestamp = null;
                this.position = 0;
                this._lastPositionUpdateTimestamp = 0;
                this.queue.current = null; // Ensure current is cleared
                if (this.state !== Constants.PLAYER_STATE.DESTROYED && this.state !== 'DISCONNECTING') {
                    this.state = Constants.PLAYER_STATE.STOPPED; // Mark as stopped due to error
                }

                // --- Fault Handling ---
                if (exception.severity?.toUpperCase() === "FAULT") {
                     this._emitNodeError(this.node, new Error(`Track Fault: ${exception.message} (Track: ${exceptionTrack?.info?.title})`), `Player ${this.guildId} experienced critical track fault.`);
                     // Critical playback failure - often unrecoverable. Best to destroy cleanly.
                     this.disconnect(true).catch(e => this._debugLog(`Error during cleanup after track fault: ${e.message}`));
                 }
                // --- Error Handling (Configurable Replay/Skip) ---
                 // else if (this.autoReplay && reasonCanBeReplayed(exception.message)) { // Example custom logic
                 //     this._debugLog(`Attempting auto-replay after exception...`);
                 //     await this.play(exceptionTrack).catch(...)
                 // }
                 else {
                     // For COMMON, SUSPICIOUS, or if no specific handling, treat as end and try next.
                     this._debugLog(`Attempting next track after non-fault exception.`);
                     if (this.state !== Constants.PLAYER_STATE.DESTROYED) {
                         // Trigger queue handling as if track ended, but with 'loadFailed' context maybe? Use exception payload.
                         await this._handleTrackEnd({ ...payload, reason: 'loadFailed' }, exceptionTrack).catch(e => this._emitError(e, "Error in post-exception queue handling"));
                     }
                 }
                break;

            case Constants.LAVA_EVENT_TYPES.TRACK_STUCK:
                 const stuckTrack = previousTrack ?? this.queue.buildTrackFromEncoded(payload.encodedTrack);
                this._debugLog(`Event: TrackStuck (${stuckTrack?.info?.title ?? 'Unknown Track'}, Threshold: ${payload.thresholdMs}ms)`);

                this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_STUCK, this, stuckTrack, payload);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_STUCK, this, stuckTrack, payload.thresholdMs);

                 // Similar state reset to Exception/End
                 this.playing = false;
                 this.paused = false;
                 this.timestamp = null;
                 this.position = 0;
                 this._lastPositionUpdateTimestamp = 0;
                 this.queue.current = null;
                 if (this.state !== Constants.PLAYER_STATE.DESTROYED && this.state !== 'DISCONNECTING') {
                     this.state = Constants.PLAYER_STATE.STOPPED;
                 }

                 // Treat stuck track as finished to process queue
                 this._debugLog(`Attempting next track after track stuck.`);
                 if (this.state !== Constants.PLAYER_STATE.DESTROYED) {
                    await this._handleTrackEnd(payload, stuckTrack).catch(e => this._emitError(e, "Error in post-stuck queue handling"));
                 }
                 break;


             // --- Voice Connection Event ---
             case Constants.LAVA_EVENT_TYPES.WEBSOCKET_CLOSED:
                this._debugLog(`Event: WebSocketClosed (Lavalink <-> Discord Voice). Code: ${payload.code}, Reason: ${payload.reason}, By Remote: ${payload.byRemote}`);
                 // This signifies the *voice* connection websocket closed, not the main node WS.

                 this.connected = false; // Mark internal voice state as disconnected
                this.ping = -1; // Reset ping

                 // Set player state to reflect disconnected voice link if not already destroyed/disconnecting
                 if (this.state !== Constants.PLAYER_STATE.DESTROYED && this.state !== 'DISCONNECTING') {
                     this.state = 'DISCONNECTED_LAVALINK'; // Specific state indicating voice link issue
                 }

                 this.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, this, payload);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.PLAYER_WEBSOCKET_CLOSED, this, payload);

                // Should we automatically try to reconnect? Usually requires bot intervention.
                // Log as a potential node error / player issue.
                 this._emitWarn(`Discord WebSocket closed for player. Code: ${payload.code}, Reason: ${payload.reason}. Player state: ${this.state}. Requires intervention if unexpected.`);

                // Consider cleanup for certain codes (e.g., 4004: Invalid token, 4006: Invalid session, 4014: Disconnected)
                const fatalCodes = [4004, 4006, 4014]; // Codes often indicating user action / unrecoverable state
                if (fatalCodes.includes(payload.code) && this.state !== Constants.PLAYER_STATE.DESTROYED) {
                    this._debugLog(`Destroying player due to fatal Discord WS close code: ${payload.code}`);
                     this.disconnect(true).catch(e => this._debugLog(`Error during cleanup after fatal WS close code: ${e.message}`));
                 } else if (payload.code === 4000) { // 4000 often means "Unknown Error" - can be transient or permanent
                    this._emitWarn("WebSocket closed with code 4000 (Unknown Error). Monitor connection stability.");
                 }
                break;


             // --- Unknown Event ---
             default:
                 this._emitWarn(`Received unknown player event type: ${payload.type}`);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.RAW, this.node, `player:${this.guildId}`, payload); // Emit raw event for debugging
         }
    }

    /** Logic executed after a track finishes (TrackEnd, TrackException, TrackStuck). Handles looping and queue progression. @private */
     async _handleTrackEnd(payload, previousTrack = null) {
         // Double-check: Stop processing if player got destroyed during event handling or is disconnecting
        if (this.state === Constants.PLAYER_STATE.DESTROYED || this.state === 'DISCONNECTING') {
             this._debugLog(`_handleTrackEnd: Aborting queue processing, player state is ${this.state}`);
            return;
        }

        const reason = payload.reason ?? 'UNKNOWN';
        this._debugLog(`_handleTrackEnd: Processing queue/looping. Reason: ${reason}, Loop Mode: ${this.loop}`);


        // --- 1. Handle Loop Mode: TRACK ---
         // Replay if TRACK loop is active AND the track didn't end due to stop/replace/loadfail (unless configured otherwise)
         if (this.loop === Constants.LOOP_MODE.TRACK && ['finished' /* Add 'stuck'/'exception' here if you want replay on those? */ ].includes(reason)) {
             const trackToReplay = previousTrack ?? this.queue.history.slice(-1)[0]; // Use ended track or last from history
            if (trackToReplay) {
                 this._debugLog(`_handleTrackEnd: Replaying track due to TRACK loop: ${trackToReplay?.info?.title}`);
                 // Ensure player is still connected before trying to play again
                 if (this.isConnected) {
                     await this.play(trackToReplay, { noReplace: false }) // Explicitly replace (self)
                         .catch(e => this._emitError(e, `Error replaying track in TRACK loop`));
                } else {
                     this._emitWarn(`_handleTrackEnd: Cannot replay track (loop), player disconnected.`);
                 }
                 return; // Don't process queue further if track loop is active and replaying
             } else {
                this._emitWarn(`_handleTrackEnd: TRACK loop active, but no previous track found to replay.`);
            }
        }

         // --- 2. Handle "MayInterruptIfSkipped" Reasons ---
         // Stop processing IF the reason indicates a user action that shouldn't trigger the next track implicitly.
         // 'stopped' = user called stop(). 'replaced' = user called play() with a new track.
         // 'cleanup' = node/manager initiated cleanup.
        if (['stopped', 'replaced', 'cleanup'].includes(reason)) {
            // Check if the queue is *now* totally empty (no current, no upcoming) and emit QUEUE_END if so.
             if (!this.current && this.queue.isEmpty) {
                 this._debugLog(`_handleTrackEnd: Track ended via ${reason} and queue is now empty. Emitting QUEUE_END.`);
                 this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
                 this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
             } else {
                this._debugLog(`_handleTrackEnd: Track ended via ${reason}. Queue progression stopped.`);
            }
             return; // Stop processing queue/looping
         }

        // --- 3. Handle Loop Mode: QUEUE ---
        // If QUEUE loop active, poll should handle adding previous track back to end.
         if (this.loop === Constants.LOOP_MODE.QUEUE) {
             // queue.poll() should internally handle moving `current` (or `previousTrack`) to the end
             // if loop mode is QUEUE, then returns the *new* first track.
            const nextTrack = this.queue.poll(); // IMPORTANT: Assumes queue.poll() handles QUEUE loop logic
             if (nextTrack) {
                 this._debugLog(`_handleTrackEnd: Playing next track due to QUEUE loop: ${nextTrack?.info?.title}`);
                 if (this.isConnected) {
                     await this.play(nextTrack) // Play the polled track (which might be the one just ended if queue was size 1)
                        .catch(e => this._emitError(e, `Error playing next looped (QUEUE) track`));
                 } else {
                     this._emitWarn(`_handleTrackEnd: Cannot play next track (QUEUE loop), player disconnected.`);
                 }
                 return; // Finished processing for QUEUE loop with tracks
             } else {
                 // Queue loop is on, but poll returned null. This implies the queue was emptied externally
                 // or the queue implementation has a bug.
                this._emitWarn(`_handleTrackEnd: QUEUE loop active but queue.poll() returned empty.`);
                 // Fallthrough to default handling (effectively ends playback)
            }
        }

        // --- 4. Default Behavior: Play Next (No Loop or Queue Loop returned empty) ---
         // This handles: finished, loadFailed, cleanup (if not returned above), stuck, exception
         const nextTrack = this.queue.poll(); // Poll next track (without loop considerations)
        if (nextTrack) {
            this._debugLog(`_handleTrackEnd: Playing next track from queue (default progression): ${nextTrack?.info?.title}`);
            if (this.isConnected) {
                 await this.play(nextTrack)
                    .catch(e => this._emitError(e, `Error playing next track from queue`));
            } else {
                this._emitWarn(`_handleTrackEnd: Cannot play next track (default), player disconnected.`);
             }
        } else {
            // --- 5. Queue Truly Empty ---
             this._debugLog(`_handleTrackEnd: Queue finished. No more tracks.`);
            // Ensure state is stopped (should be already from TRACK_END/Exception handler)
            if (this.state !== Constants.PLAYER_STATE.DESTROYED) {
                this.state = Constants.PLAYER_STATE.STOPPED;
            }
             this.playing = false;
             this.paused = false;
             this.current = null; // Make sure current is null

            // Emit QUEUE_END event
            this.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);
             this.manager.emit(Constants.CLIENT_EVENT_TYPES.QUEUE_END, this);

            // Explicitly tell Lavalink to stop *just in case* it wasn't fully stopped by the event that triggered this.
             if (this.isConnected && this.node && this.node.connected && this.node.sessionId) {
                 await this.node.updatePlayer(this.guildId, { encodedTrack: null })
                    .catch(e => this._emitWarn(`Ignoring non-critical error sending explicit stop after queue end: ${e.message}`));
             }
        }
    }


    // --- Utility / Logging ---

    /** Log debugging messages via the manager. @private */
    _debugLog(message) {
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.DEBUG, `[Player:${this.guildId}] ${message}`);
    }

     /** Log warning messages. @private */
     _emitWarn(message) {
         this.manager.emit(Constants.CLIENT_EVENT_TYPES.WARN, `[Player:${this.guildId}] ${message}`);
         // Optionally emit on the player itself too
         // this.emit('warn', message);
     }

    /** Log and emit error messages. @private */
    _emitError(error, context = "") {
        const errorMessage = context ? `${context}: ${error.message}` : error.message;
        this.manager.emit(Constants.CLIENT_EVENT_TYPES.ERROR, error, `[Player:${this.guildId}] ${errorMessage}`);
         // Optionally emit on the player itself too
         this.emit('error', error, context); // Player specific error event
     }

     /** Log and emit node-specific errors. @private */
     _emitNodeError(node, error, context = "") {
         this.manager.emit(Constants.CLIENT_EVENT_TYPES.NODE_ERROR, node ?? this.node, error, `[Player:${this.guildId}] ${context}`);
         this.emit('error', error, `NodeError: ${context}`); // Emit on player too
     }

    /** Emit track exception events. @private */
     _emitTrackException(track, error, context = "") {
        this._emitError(error, context); // Emit generic error too
         this.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, track, error);
         this.manager.emit(Constants.CLIENT_EVENT_TYPES.TRACK_EXCEPTION, this, track, error); // Pass full error object maybe? Adjust constants signature
    }
}

module.exports = Player;
